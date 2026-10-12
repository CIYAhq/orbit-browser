import { type IpcMainInvokeEvent, ipcMain, type Session } from 'electron'
import type { InstallResult, StoreListing } from '../../shared/commands/extensions'
import {
  isStoreFrame,
  STORE_ORIGIN,
  type StoreConfig,
  type StoreResult,
  storeDownloadUrl,
  storeListingId,
} from '../../shared/extension-store'
import { EXTENSION_ID } from '../../shared/extensions'
import { isPrivateProfileId } from '../../shared/private'
import { PAGE_CHANNEL } from '../../shared/site'
import type { ProfileId, TabId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import type { ActionContext } from '../registry'
import type { ExtensionDialogs } from './dialogs'
import type { ExtensionService } from './service'

/** A download larger than this is refused, as a picked file is (EX-09). */
export const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024
/** A download that takes longer than this is given up. */
const DOWNLOAD_TIMEOUT_MS = 120_000

/** Downloads an extension's file through its profile's session, without the profile's cookies. */
export async function downloadCrx(ses: Session, url: string): Promise<Uint8Array> {
  let response: Response
  try {
    response = await ses.fetch(url, {
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    })
  } catch {
    throw new Error('The store couldn’t be reached.')
  }
  if (!response.ok) throw new Error(`The store didn’t send it (${response.status}).`)
  if (Number(response.headers.get('content-length') ?? 0) > MAX_DOWNLOAD_BYTES) throw new Error('It is too large.')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('The store sent nothing.')
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_DOWNLOAD_BYTES) {
      await reader.cancel().catch(() => {})
      throw new Error('It is too large.')
    }
    parts.push(value)
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    bytes.set(part, at)
    at += part.byteLength
  }
  return bytes
}

export interface StoreDeps {
  service: ExtensionService
  dialogs: ExtensionDialogs
  /** Tells the window how an install went ("<name> added", with Pin), or why it failed. */
  report(windowId: WindowId | undefined, profileId: ProfileId, result: InstallResult): void
  /** Says that a private window adds no extension. */
  privateRefusal(windowId: WindowId | undefined): InstallResult
  /** A main window to open a page in (not a Mini Window or a private one). */
  mainWindowFor(c: ActionContext): WindowId | undefined
}

type StoreInstall = InstallResult & { code?: StoreResult }

/**
 * The extension store (EX-01). `config` is null when Orbit makes no store request (e2e and
 * development builds, unless a test names a fixture store: src/shared/extension-store.ts).
 *
 * - The store page's own install button (D40 (3)): the page preload gives the store's main frames
 *   `chrome.webstorePrivate`'s two install calls (src/preload/store-install.ts), and only an
 *   extension ID reaches main, on `PAGE_CHANNEL.storeInstall`. Main checks on every call that the
 *   calling frame is a tab's main frame showing a page of exactly the store's origin, and takes
 *   the profile from the tab.
 * - Orbit's own "Add to Orbit" in the site controls panel of a store listing page, for when the
 *   store's button doesn't offer to install in Orbit (the spec's open question): the ID comes from
 *   the tab's address, read here.
 * Either way Orbit downloads the file itself, checks its CRX3 signature and that its ID is the
 * one asked for, and asks in its own dialog (EX-02) before anything is added.
 */
export function registerStore(ctx: MainContext, config: StoreConfig | null, deps: StoreDeps): void {
  const { actions, commands, store, tabs, windows } = ctx
  const { service, dialogs } = deps
  /** Tabs with a store install going on: one at a time each. */
  const busy = new Set<TabId>()

  const windowOf = (tabId: TabId) => windows.windowOfTab(tabId) ?? windows.focusedWindowId()

  /** Adds extension `id` from the store to a tab's profile, once the user says yes over that tab. */
  const install = async (tabId: TabId, id: string): Promise<StoreInstall> => {
    const windowId = windowOf(tabId)
    const profileId = store.state.tabs[tabId]?.profileId
    const ses = profileId ? service.session(profileId) : undefined
    if (!config || !profileId) return { ok: false, code: 'unknown_error' }
    if (isPrivateProfileId(profileId) || !ses) return { ...deps.privateRefusal(windowId), code: 'blocked_by_policy' }
    if (service.get(profileId, id)) return { ok: false, code: 'already_installed' }
    if (busy.has(tabId)) return { ok: false, code: 'unknown_error' }
    busy.add(tabId)
    try {
      let bytes: Uint8Array
      try {
        bytes = await downloadCrx(ses, storeDownloadUrl(config.downloadUrl, id, process.versions.chrome ?? ''))
      } catch (err) {
        const result: InstallResult = { ok: false, error: err instanceof Error ? err.message : String(err) }
        deps.report(windowId, profileId, result)
        return { ...result, code: 'unknown_error' }
      }
      const result = await service.installCrx(
        profileId,
        bytes,
        (preview) =>
          dialogs.ask(windowId, { kind: 'install', name: preview.name, icon: preview.icon, lines: preview.lines }),
        'store',
        id,
      )
      deps.report(windowId, profileId, result)
      return { ...result, code: result.ok ? '' : result.cancelled ? 'user_cancelled' : 'unknown_error' }
    } finally {
      busy.delete(tabId)
    }
  }

  // The store page's button (D40 (3)). Only the ID crosses; the frame is checked on every call.
  ipcMain.handle(PAGE_CHANNEL.storeInstall, async (event: IpcMainInvokeEvent, id: unknown): Promise<StoreResult> => {
    try {
      const contents = event.sender
      const frame = event.senderFrame
      const main = contents.mainFrame
      const isMain =
        !!frame && !frame.detached && frame.processId === main.processId && frame.routingId === main.routingId
      const tabId = tabs.tabIdFor(contents)
      if (!tabId) return 'unknown_error'
      if (!config) {
        // A development build: the store's page has the API, but Orbit makes no store request.
        if (isStoreFrame(frame?.url, isMain, STORE_ORIGIN)) {
          ctx.toast(windowOf(tabId), 'This build of Orbit doesn’t add extensions from the store.')
        }
        return 'unknown_error'
      }
      if (!isStoreFrame(frame?.url, isMain, config.origin)) return 'unknown_error'
      if (typeof id !== 'string' || !EXTENSION_ID.test(id)) return 'invalid_id'
      return (await install(tabId, id)).code ?? 'unknown_error'
    } catch (err) {
      console.error('[extensions] store install', err)
      return 'unknown_error'
    }
  })

  /** The listing a tab shows, from its own address. */
  const listingOf = (tabId: TabId | undefined): string | null => {
    const tab = tabId ? store.state.tabs[tabId] : undefined
    if (!tabId || !tab || !config) return null
    const contents = tabs.contents(tabId)
    const url = (contents && !contents.isDestroyed() ? contents.getURL() : '') || tab.url
    return storeListingId(url, config.origin)
  }

  commands.register('extensions.storeListing', ({ tabId }): StoreListing | null => {
    const id = listingOf(tabId)
    const profileId = store.state.tabs[tabId]?.profileId
    if (!id || !profileId) return null
    return { id, private: isPrivateProfileId(profileId) }
  })

  commands.register('extensions.installFromStore', async ({ tabId }): Promise<InstallResult> => {
    const id = listingOf(tabId)
    if (!id) return { ok: false }
    const { code: _code, ...result } = await install(tabId, id)
    return result
  })

  // Add Extension (EX-01): the store, in a new tab of a main window.
  actions.register('extension.add', async (c) => {
    if (!config) {
      ctx.toast(c.windowId ?? windows.focusedWindowId(), 'This build of Orbit doesn’t open the extension store.')
      return
    }
    const windowId = deps.mainWindowFor(c)
    if (!windowId) return
    await commands.run('library.close', {}, { windowId })
    await commands.run('tabs.create', { url: `${config.origin}/`, activate: true }, { windowId })
  })
}
