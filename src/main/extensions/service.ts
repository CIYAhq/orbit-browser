import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type Session, session, WebContentsView, webContents } from 'electron'
import type { InstallResult } from '../../shared/commands/extensions'
import { ExtensionError, extensionKey, permissionLines } from '../../shared/extensions'
import { isPrivateProfileId } from '../../shared/private'
import type { InstalledExtension, ProfileId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import { verifyCrx } from './crx'
import type { ExtensionDialogs } from './dialogs'
import { type FolderInfo, readFolder } from './folder'
import { extractZip } from './zip'

/** A .crx larger than this isn't read: real ones are well under it. */
const MAX_CRX_BYTES = 256 * 1024 * 1024
/** How long removal waits for an extension's own storage to clear (EX-08). */
const CLEAR_TIMEOUT_MS = 3000
/** The engine's folders of `chrome.storage`, under the profile's session folder. */
const STORAGE_DIRS = ['Local Extension Settings', 'Sync Extension Settings', 'Managed Extension Settings']

/** What to ask before an install (EX-02). */
export interface InstallPreview {
  id: string
  name: string
  icon: string
  lines: string[]
}

const reason = (err: unknown): string => {
  if (err instanceof ExtensionError) return err.message
  const text = err instanceof Error ? err.message : String(err)
  // The engine's own message starts with the folder's path: keep what it says about the extension.
  return text.replace(/^Loading extension at .* failed with: /s, '').trim() || 'It couldn’t be loaded.'
}

/**
 * Installed extensions, per profile (EX-09): each profile's session runs that profile's enabled
 * extensions, loaded when the session is made (at launch, before any of its tabs loads). Private
 * windows run none (EX-10). Turning one off or on, and removing it, act at once (EX-07, EX-08).
 *
 * Files: a .crx (or a store install) is unpacked into `<userData>/Extensions/<profile>/<id>/<version>_<n>`;
 * a folder loaded in Developer mode runs where it is, and removing it never touches it.
 */
export class ExtensionService {
  readonly root: string
  /** Extensions that ran this launch: their storage may be open in the engine still (removal). */
  private ran = new Set<string>()
  /** One change at a time per extension. */
  private queues = new Map<string, Promise<unknown>>()

  constructor(
    private readonly ctx: MainContext,
    private readonly dialogs: ExtensionDialogs,
  ) {
    this.root = join(ctx.paths.userData, 'Extensions')
  }

  /** Starts loading each profile's enabled extensions, as its session is made. */
  start(): void {
    const { sessions, store } = this.ctx
    sessions.onSessionCreated((ses, profileId) => this.attach(ses, profileId))
    // Sessions of profiles with extensions are made now, so loading starts before any tab loads.
    const profiles = new Set(
      Object.values(store.state.extensions)
        .filter((e) => e.enabled)
        .map((e) => e.profileId),
    )
    for (const profileId of profiles) if (store.state.profiles[profileId]) sessions.get(profileId)
    // A profile deleted: its extensions go with it, stopped in its session, and their files.
    store.subscribe((next, prev) => {
      if (next.profiles === prev.profiles) return
      const gone = Object.values(next.extensions).filter((e) => !next.profiles[e.profileId])
      if (gone.length === 0) return
      store.update((d) => {
        for (const e of gone) delete d.extensions[extensionKey(e.profileId, e.id)]
      })
      for (const e of gone) {
        const partition = prev.profiles[e.profileId]?.partition
        const ses = partition ? session.fromPartition(partition) : undefined
        if (ses?.extensions.getExtension(e.id)) ses.extensions.removeExtension(e.id)
        this.ran.delete(extensionKey(e.profileId, e.id))
      }
      for (const profileId of new Set(gone.map((e) => e.profileId))) {
        void rm(join(this.root, profileId), { recursive: true, force: true }).catch(() => {})
      }
    })
  }

  get(profileId: ProfileId, id: string): InstalledExtension | undefined {
    return this.ctx.store.state.extensions[extensionKey(profileId, id)]
  }

  /** The profile's session, or undefined for a private one (EX-10) or a profile that is gone. */
  session(profileId: ProfileId): Session | undefined {
    if (isPrivateProfileId(profileId) || !this.ctx.store.state.profiles[profileId]) return undefined
    const ses = this.ctx.sessions.get(profileId)
    return ses.isPersistent() ? ses : undefined
  }

  /** Whether it runs now in its profile's session. */
  isLoaded(profileId: ProfileId, id: string): boolean {
    const ses = this.session(profileId)
    return !!ses?.extensions.getExtension(id)
  }

  private attach(ses: Session, profileId: ProfileId): void {
    if (isPrivateProfileId(profileId) || !ses.isPersistent()) return
    const list = Object.values(this.ctx.store.state.extensions)
      .filter((e) => e.profileId === profileId && e.enabled)
      .sort((a, b) => a.installedAt - b.installedAt)
    for (const ext of list) void this.queue(ext.profileId, ext.id, () => this.load(ses, ext))
  }

  /** Runs `task` after the extension's earlier changes. */
  private queue<T>(profileId: ProfileId, id: string, task: () => Promise<T>): Promise<T> {
    const key = extensionKey(profileId, id)
    const before = this.queues.get(key) ?? Promise.resolve()
    const run = before.then(task, task)
    const tail = run.catch(() => {})
    this.queues.set(key, tail)
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key)
    })
    return run
  }

  private patch(profileId: ProfileId, id: string, fields: Partial<InstalledExtension>): void {
    const key = extensionKey(profileId, id)
    this.ctx.store.update((d) => {
      const ext = d.extensions[key]
      if (!ext) return
      for (const [field, value] of Object.entries(fields)) {
        if (value === undefined) delete (ext as unknown as Record<string, unknown>)[field]
        else (ext as unknown as Record<string, unknown>)[field] = value
      }
    })
  }

  /** Loads it into the session; on failure it stays installed, with the reason shown (EX-07). */
  private async load(ses: Session, ext: InstalledExtension): Promise<boolean> {
    try {
      const loaded = await ses.extensions.loadExtension(ext.path, { allowFileAccess: ext.allowFileAccess })
      this.ran.add(extensionKey(ext.profileId, ext.id))
      if (loaded.id !== ext.id) {
        // Its folder now holds another extension (a developer's folder whose key changed).
        ses.extensions.removeExtension(loaded.id)
        this.patch(ext.profileId, ext.id, { error: 'Its folder now holds another extension.' })
        return false
      }
      const fields: Partial<InstalledExtension> = { error: undefined }
      // A developer's folder may have changed since: show what runs now.
      if (ext.source === 'folder') Object.assign(fields, await this.describe(ext.path).catch(() => ({})))
      this.patch(ext.profileId, ext.id, fields)
      return true
    } catch (err) {
      this.patch(ext.profileId, ext.id, { error: reason(err) })
      return false
    }
  }

  /** The fields its folder gives it. */
  private async describe(path: string): Promise<Partial<InstalledExtension>> {
    const info = await readFolder(path)
    return fieldsFrom(info)
  }

  /** Stops it in its session at once, and closes its pages (EX-07, EX-08). */
  private unload(profileId: ProfileId, id: string): void {
    const ses = this.session(profileId)
    if (ses?.extensions.getExtension(id)) ses.extensions.removeExtension(id)
    this.closePages(profileId, id)
  }

  /** Closes the tabs that show one of its pages, as the engine would. */
  private closePages(profileId: ProfileId, id: string): void {
    const prefix = `chrome-extension://${id}/`
    const tabIds = Object.values(this.ctx.store.state.tabs)
      .filter((t) => t.profileId === profileId && t.url.startsWith(prefix))
      .map((t) => t.id)
    if (tabIds.length > 0) void this.ctx.commands.run('tabs.close', { tabIds }).catch(() => {})
  }

  // ---- Switches (EX-07) ----

  setEnabled(profileId: ProfileId, id: string, enabled: boolean): Promise<boolean> {
    return this.queue(profileId, id, async () => {
      const ext = this.get(profileId, id)
      if (!ext) return false
      if (ext.enabled === enabled && (enabled ? this.isLoaded(profileId, id) : true)) return true
      this.patch(profileId, id, { enabled, error: undefined })
      if (!enabled) {
        this.unload(profileId, id)
        return true
      }
      const ses = this.session(profileId)
      const now = this.get(profileId, id)
      if (ses && now) await this.load(ses, now)
      return true
    })
  }

  setAllowed(profileId: ProfileId, id: string, what: 'private' | 'files', allowed: boolean): Promise<boolean> {
    return this.queue(profileId, id, async () => {
      const ext = this.get(profileId, id)
      if (!ext) return false
      if (what === 'private') {
        this.patch(profileId, id, { allowPrivate: allowed })
        return true
      }
      if (ext.allowFileAccess === allowed) return true
      this.patch(profileId, id, { allowFileAccess: allowed })
      // The engine reads it as it loads the extension: load it again.
      const ses = this.session(profileId)
      const now = this.get(profileId, id)
      if (ses && now?.enabled && ses.extensions.getExtension(id)) {
        ses.extensions.removeExtension(id)
        await this.load(ses, now)
      }
      return true
    })
  }

  pin(profileId: ProfileId, id: string, pinned: boolean): boolean {
    if (!this.get(profileId, id)) return false
    this.patch(profileId, id, { pinnedAt: pinned ? (this.get(profileId, id)?.pinnedAt ?? Date.now()) : undefined })
    return true
  }

  /** Loads a developer's folder again (Developer mode), with what it says now. */
  reload(profileId: ProfileId, id: string): Promise<boolean> {
    return this.queue(profileId, id, async () => {
      const ext = this.get(profileId, id)
      const ses = this.session(profileId)
      if (!ext || !ses) return false
      if (ses.extensions.getExtension(id)) ses.extensions.removeExtension(id)
      if (!ext.enabled) return true
      return this.load(ses, ext)
    })
  }

  // ---- Removal (EX-08) ----

  /** Asks in the window, then removes it with its data. True if it was removed. */
  async confirmRemove(profileId: ProfileId, id: string, windowId: WindowId | undefined): Promise<boolean> {
    const ext = this.get(profileId, id)
    if (!ext) return false
    const yes = await this.dialogs.ask(windowId, { kind: 'remove', name: ext.name, icon: ext.icon, lines: [] })
    if (!yes) return false
    return this.remove(profileId, id)
  }

  /** Removes it from its profile with its data: its storage, its site data and Orbit's copy of its files. */
  remove(profileId: ProfileId, id: string): Promise<boolean> {
    return this.queue(profileId, id, async () => {
      const ext = this.get(profileId, id)
      if (!ext) return false
      const key = extensionKey(profileId, id)
      this.ctx.store.update((d) => {
        delete d.extensions[key]
      })
      const ses = this.session(profileId)
      if (ses) {
        // Its chrome.storage lives in the engine, which keeps it open once the extension ran: clear it
        // from one of its own pages while it runs (loaded again for a moment if it was turned off).
        let loaded = !!ses.extensions.getExtension(id)
        if (!loaded && this.ran.has(key)) {
          loaded = await ses.extensions.loadExtension(ext.path, { allowFileAccess: false }).then(
            () => true,
            () => false,
          )
        }
        if (loaded) await clearStorage(ses, id)
        if (ses.extensions.getExtension(id)) ses.extensions.removeExtension(id)
        this.closePages(profileId, id)
        await ses.clearStorageData({ origin: `chrome-extension://${id}` }).catch(() => {})
        const base = ses.getStoragePath()
        if (base) {
          for (const dir of STORAGE_DIRS)
            await rm(join(base, dir, id), { recursive: true, force: true }).catch(() => {})
        }
      }
      this.ran.delete(key)
      if (ext.source !== 'folder')
        await rm(join(this.root, profileId, id), { recursive: true, force: true }).catch(() => {})
      return true
    })
  }

  // ---- Installing (EX-09, EX-02) ----

  /**
   * Installs a .crx file into a profile: verified (CRX3 signature, and the ID its own key gives),
   * unpacked into Orbit's folder, confirmed in Orbit's dialog (EX-02), then loaded. A file already
   * installed is replaced by it, keeping the extension's switches and pin.
   */
  async installCrx(
    profileId: ProfileId,
    bytes: Uint8Array,
    confirm: (preview: InstallPreview) => Promise<boolean>,
    source: 'crx' | 'store' = 'crx',
    expectedId?: string,
  ): Promise<InstallResult> {
    const ses = this.session(profileId)
    if (!ses) return { ok: false, error: 'Extensions can’t be added in a private window.' }
    const staging = join(this.root, profileId, `.adding-${randomUUID()}`)
    try {
      if (bytes.length > MAX_CRX_BYTES) throw new ExtensionError('The file is too large.')
      const crx = await verifyCrx(bytes, expectedId)
      await extractZip(crx.archive, staging)
      // The engine gives an unpacked extension the ID of its manifest's key: its own key, as signed.
      const manifestPath = join(staging, 'manifest.json')
      const raw = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^﻿/, '')) as Record<string, unknown>
      raw.key = Buffer.from(crx.publicKey).toString('base64')
      await writeFile(manifestPath, JSON.stringify(raw, null, 2))
      const info = await readFolder(staging)
      const preview: InstallPreview = {
        id: crx.id,
        name: info.manifest.name,
        icon: info.icon,
        lines: permissionLines(info.permissions, info.hosts),
      }
      if (!(await confirm(preview))) return { ok: false, cancelled: true }
      return await this.queue(profileId, crx.id, async () => {
        const dir = await freeDir(join(this.root, profileId, crx.id), info.manifest.version)
        await rename(staging, dir)
        return this.add(ses, profileId, crx.id, dir, info, source)
      })
    } catch (err) {
      return { ok: false, error: reason(err) }
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** Loads a developer's folder where it is (Developer mode, EX-07). */
  async installFolder(profileId: ProfileId, dir: string): Promise<InstallResult> {
    const ses = this.session(profileId)
    if (!ses) return { ok: false, error: 'Extensions can’t be added in a private window.' }
    try {
      const info = await readFolder(dir)
      const loaded = await ses.extensions.loadExtension(dir, { allowFileAccess: false })
      ses.extensions.removeExtension(loaded.id)
      return await this.queue(profileId, loaded.id, () => this.add(ses, profileId, loaded.id, dir, info, 'folder'))
    } catch (err) {
      return { ok: false, error: reason(err) }
    }
  }

  /** Puts a new copy in place of any earlier one, and runs it. */
  private async add(
    ses: Session,
    profileId: ProfileId,
    id: string,
    path: string,
    info: FolderInfo,
    source: InstalledExtension['source'],
  ): Promise<InstallResult> {
    const key = extensionKey(profileId, id)
    const before = this.ctx.store.state.extensions[key]
    if (ses.extensions.getExtension(id)) ses.extensions.removeExtension(id)
    const ext: InstalledExtension = {
      id,
      profileId,
      ...fieldsFrom(info),
      source,
      path,
      enabled: before?.enabled ?? true,
      allowPrivate: before?.allowPrivate ?? false,
      allowFileAccess: before?.allowFileAccess ?? false,
      installedAt: before?.installedAt ?? Date.now(),
      ...(before?.pinnedAt !== undefined ? { pinnedAt: before.pinnedAt } : {}),
    } as InstalledExtension
    if (!ext.enabled) {
      this.ctx.store.update((d) => {
        d.extensions[key] = ext
      })
      await this.dropOldCopy(before, path)
      return { ok: true, id, name: ext.name }
    }
    try {
      const loaded = await ses.extensions.loadExtension(path, { allowFileAccess: ext.allowFileAccess })
      if (loaded.id !== id) {
        ses.extensions.removeExtension(loaded.id)
        throw new ExtensionError('Its ID doesn’t match its key.')
      }
    } catch (err) {
      // It doesn't run here: leave everything as it was.
      if (source !== 'folder') await rm(path, { recursive: true, force: true }).catch(() => {})
      if (before?.enabled) await this.load(ses, before)
      return { ok: false, error: reason(err) }
    }
    this.ran.add(key)
    this.ctx.store.update((d) => {
      d.extensions[key] = ext
    })
    await this.dropOldCopy(before, path)
    return { ok: true, id, name: ext.name }
  }

  /** Deletes the files of the copy a new one replaced (never a developer's own folder). */
  private async dropOldCopy(before: InstalledExtension | undefined, path: string): Promise<void> {
    if (before && before.source !== 'folder' && before.path !== path) {
      await rm(before.path, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/** The fields an extension's folder gives its entry. */
function fieldsFrom(info: FolderInfo) {
  return {
    name: info.manifest.name,
    version: info.manifest.version,
    description: typeof info.manifest.description === 'string' ? info.manifest.description : '',
    permissions: info.permissions,
    hosts: info.hosts,
    icon: info.icon,
    popup: info.popup,
    options: info.options,
    ...(typeof info.manifest.update_url === 'string' && /^https?:\/\//i.test(info.manifest.update_url)
      ? { updateUrl: info.manifest.update_url }
      : {}),
  }
}

/** `<dir>/<version>_<n>`, the first that doesn't exist yet; `dir` is made. */
async function freeDir(dir: string, version: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  for (let n = 0; ; n++) {
    const path = join(dir, `${version}_${n}`)
    const exists = await stat(path).then(
      () => true,
      () => false,
    )
    if (!exists) return path
  }
}

/** Clears an extension's chrome.storage from a page of its own, out of sight. */
async function clearStorage(ses: Session, id: string): Promise<void> {
  const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true } })
  const contents = view.webContents
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, CLEAR_TIMEOUT_MS))
  const clear = (async () => {
    await contents.loadURL(`chrome-extension://${id}/manifest.json`)
    await contents.executeJavaScript(
      `Promise.all([chrome.storage?.local?.clear(), chrome.storage?.sync?.clear(), chrome.storage?.session?.clear()]).then(() => true, () => false)`,
    )
  })().catch(() => {})
  try {
    await Promise.race([clear, timeout])
  } finally {
    if (!contents.isDestroyed()) contents.close()
  }
}

/** Every web contents showing one of an extension's pages (popups, options pages). */
export function extensionContents(ses: Session, id: string): Electron.WebContents[] {
  const prefix = `chrome-extension://${id}/`
  return webContents
    .getAllWebContents()
    .filter((c) => !c.isDestroyed() && c.session === ses && c.getURL().startsWith(prefix))
}
