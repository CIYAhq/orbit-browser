import { existsSync, linkSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DownloadItem, Session, WebContents } from 'electron'
import type { DownloadEntry } from '../../shared/commands/downloads'
import { DEFAULT_PROFILE_ID } from '../../shared/defaults'
import { newId } from '../../shared/ids'
import type { Download, ProfileId, TabId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import { showsInline } from './file-kinds'
import type { FileActions } from './files'
import { freePath, PARTIAL_SUFFIX, safeFilename } from './names'
import { isDangerous, markFromInternet } from './safety'
import type { DownloadRecord, DownloadStore, ResumeInfo } from './store'

/** How long a finished download stays on the sidebar's row (DL-03: about 3–5 s). */
export const DONE_LINGER_MS = 4000
/** Progress reaches OrbitState at most this often per download. */
const PROGRESS_INTERVAL_MS = 250
/** An interruption the engine doesn't get over by itself within this long is reported (DL-02, DL-03). */
const FAILURE_GRACE_MS = 1000

/** A download the engine is running (or holding, paused or interrupted) in this session. */
interface Live {
  id: string
  item: DownloadItem
  profileId: ProfileId
  /** Where the file goes once complete. */
  finalPath: string
  /** Where it is written until then (`<final>.crdownload`). */
  tempPath: string
  /** The window it was started from (feedback goes there). */
  windowId?: WindowId
  lastPush: number
  pushTimer?: NodeJS.Timeout
  /** Taken off the list while it ran (Remove, Retry, Clear all): nothing of it is kept when it ends. */
  removed?: boolean
}

/** A private window's download (DL-16): listed in memory only, while its session has pages. */
interface PrivateEntry {
  record: DownloadRecord
  session: Session
}

/** What the window a download started from is told (DL-02, DL-03, DL-12). */
export type DownloadFeedback = 'started' | 'done' | 'failed' | 'held'

export interface DownloadManagerOptions {
  /** The folder a profile's downloads are saved to (DL-07). */
  folder: (profileId: ProfileId) => string
  /** The sidebar's start animation and row, or a toast where no sidebar shows them. */
  feedback: (
    windowId: WindowId | undefined,
    event: DownloadFeedback,
    download: { id: string; filename: string },
  ) => void
  /** Says something brief on screen (a file that couldn't be opened or moved to the Trash). */
  notify: (windowId: WindowId | undefined, message: string) => void
  /** A tab that was opened only to download a file and never showed a page: close it (DL-01). */
  closeBlankTab: (tabId: TabId) => void
  /** A profile's list changed. */
  changed: (profileId: ProfileId) => void
  /** The session a profile downloads in (retry, resume after a restart). */
  session: (profileId: ProfileId) => Session
  /** Opening files, showing them in their folder, the Trash. */
  files: FileActions
  /** Opens a URL in a new selected tab of a window (files Orbit shows itself, DL-04). */
  openInTab: (url: string, windowId: WindowId | undefined) => void
}

/**
 * The downloads flow (DL-01): every profile session's `will-download`. A download is saved straight
 * to its profile's folder under a free name, written as `<name>.crdownload` until complete, and
 * tracked in OrbitState (what the sidebar shows) and the downloads list (DownloadStore). What can be
 * done with one: pause, resume (also after a restart) and retry (DL-15); open, show, remove and
 * delete (DL-04, DL-08). A private session's downloads are in no list on disk (DL-16).
 */
export class DownloadManager {
  private live = new Map<string, Live>()
  private sessions = new WeakSet<Session>()
  private profileOf = new WeakMap<Session, ProfileId>()
  /** Final paths of downloads still running, lowercased: two at once never get the same name. */
  private reserved = new Set<string>()
  private lingers = new Map<string, NodeJS.Timeout>()
  /** Downloads asked to continue after a restart, by partial file: the engine's item comes back through `will-download`. */
  private resuming = new Map<string, { id: string; url: string }>()
  private privates = new Map<string, PrivateEntry>()
  /** Private sessions whose pages have all closed (DL-16). */
  private closedSessions = new WeakSet<Session>()
  private quitting = false

  constructor(
    private ctx: MainContext,
    readonly list: DownloadStore,
    private opts: DownloadManagerOptions,
  ) {}

  /** Starts handling a session's downloads (once per session). */
  attach(ses: Session, profileId?: ProfileId): void {
    if (profileId) this.profileOf.set(ses, profileId)
    if (this.sessions.has(ses)) return
    this.sessions.add(ses)
    ses.on('will-download', (_event, item, contents) => this.start(ses, item, contents))
  }

  /** Downloads running or paused now. */
  activeCount(): number {
    let n = 0
    for (const live of this.live.values()) if (live.item.getState() === 'progressing') n++
    return n
  }

  /** The record of a download: the list's, a private one's, or only the sidebar's. */
  get(id: string): DownloadRecord | undefined {
    return this.list.get(id) ?? this.privates.get(id)?.record ?? this.ctx.store.state.downloads[id]
  }

  /** A profile's downloads, newest first: its list and its private windows' (DL-10, DL-16). */
  records(profileId: ProfileId, limit?: number): DownloadRecord[] {
    const privates = [...this.privates.values()].map((p) => p.record).filter((r) => r.profileId === profileId)
    const all = [...privates, ...this.list.list(profileId)].sort((a, b) => b.startedAt - a.startedAt)
    return typeof limit === 'number' ? all.slice(0, Math.max(0, limit)) : all
  }

  /**
   * A profile's downloads as the UI shows them (DL-10), newest first. Whether finished files are
   * still there is checked off the main thread, all at once.
   */
  async entries(profileId: ProfileId, limit?: number): Promise<DownloadEntry[]> {
    const records = this.records(profileId, limit)
    const there = await Promise.all(
      records.map((r) =>
        r.state === 'completed'
          ? access(fileOf(r)).then(
              () => true,
              () => false,
            )
          : true,
      ),
    )
    return records.map((r, i) => this.entry(r, there[i]))
  }

  /**
   * A download as the UI shows it: the sidebar's live fields, whether its file is gone, whether it can
   * continue. `exists`: whether its file is there, when already known.
   */
  entry(record: DownloadRecord, exists?: boolean): DownloadEntry {
    const { resume: _resume, ...stored } = record
    const out: DownloadEntry = { ...stored, ...this.ctx.store.state.downloads[record.id] }
    if (out.state === 'completed') {
      if (!(exists ?? existsSync(fileOf(out)))) out.missing = true
      else if (!out.danger) out.fileUrl = pathToFileURL(out.savePath).href
    }
    if (out.state === 'interrupted' && !this.live.has(record.id)) out.canResume = this.resumable(record)
    return out
  }

  /**
   * After a restart: a download cut off by quitting shows Resume when its partial file can continue,
   * else Retry (DL-15).
   */
  restore(): void {
    const stopped = Object.values(this.ctx.store.state.downloads).filter(
      (d) => d.state === 'interrupted' && !this.live.has(d.id),
    )
    if (stopped.length === 0) return
    const can = stopped.map((d) => {
      const record = this.list.get(d.id)
      return [d.id, !!record && this.resumable(record)] as const
    })
    this.ctx.store.update((draft) => {
      for (const [id, value] of can) {
        const entry = draft.downloads[id]
        if (entry && entry.canResume !== value) entry.canResume = value
      }
    })
  }

  /** Cancels a download and deletes its partial file (DL-03 ✕). */
  cancel(id: string): void {
    const live = this.live.get(id)
    if (live && live.item.getState() !== 'completed' && live.item.getState() !== 'cancelled') {
      live.item.cancel()
      return
    }
    // Interrupted in an earlier run: only its partial file is left.
    const record = this.get(id)
    if (!record || record.state === 'completed' || record.state === 'cancelled') return
    removePartial(record)
    this.finish(id, record.profileId, {
      state: 'cancelled',
      endedAt: Date.now(),
      canResume: undefined,
      resume: undefined,
    })
  }

  /** Takes a download off the sidebar's row (it stays in the list). */
  dismiss(id: string): void {
    const timer = this.lingers.get(id)
    if (timer) clearTimeout(timer)
    this.lingers.delete(id)
    if (this.ctx.store.state.downloads[id]) this.ctx.store.update((d) => void delete d.downloads[id])
  }

  /** Pauses a running download (DL-15). */
  pause(id: string): void {
    const live = this.live.get(id)
    if (live?.item.getState() !== 'progressing' || live.item.isPaused()) return
    live.item.pause()
    this.push(live)
    this.changeState(live, { state: 'paused' })
  }

  /**
   * Continues a paused or interrupted download where it stopped (DL-15). One cut off by quitting
   * continues from its partial file, when the server named a version of the file (an ETag or a
   * modification date) to check it against. False when it can't continue (retry it).
   */
  resume(id: string): boolean {
    const live = this.live.get(id)
    if (live) {
      const { item } = live
      const state = item.getState()
      if (state === 'progressing' && item.isPaused()) {
        item.resume()
      } else if (state === 'interrupted' && canContinue(item)) {
        item.resume()
      } else {
        return state === 'progressing'
      }
      this.push(live)
      this.changeState(live, { state: 'progressing', canResume: undefined, error: undefined })
      return true
    }
    const record = this.list.get(id)
    if (record?.state !== 'interrupted' || !record.resume || !this.resumable(record)) return false
    const r = record.resume
    this.resuming.set(r.tempPath, { id, url: r.urlChain[r.urlChain.length - 1] ?? record.url })
    try {
      // The bytes kept at quit go back under the partial file's name.
      const kept = keptPath(record)
      if (existsSync(r.tempPath)) removeFile(kept)
      else renameSync(kept, r.tempPath)
      this.opts.session(record.profileId).createInterruptedDownload({
        path: r.tempPath,
        urlChain: r.urlChain,
        offset: statSync(r.tempPath).size,
        length: record.totalBytes,
        ...(r.mimeType ? { mimeType: r.mimeType } : {}),
        ...(r.etag ? { eTag: r.etag } : {}),
        ...(r.lastModified ? { lastModified: r.lastModified } : {}),
        ...(r.startTime ? { startTime: r.startTime } : {}),
      })
    } catch (err) {
      this.resuming.delete(r.tempPath)
      console.error('[downloads] cannot continue an interrupted download:', err)
      return false
    }
    return true
  }

  /**
   * Downloads the file again (DL-15 Retry, DL-04 a missing file). One the engine still holds starts
   * again from the beginning; any other is downloaded anew from its address, as a new download, and
   * this one leaves the list.
   */
  retry(id: string): void {
    const live = this.live.get(id)
    if (live && live.item.getState() === 'interrupted' && live.item.canResume()) {
      // The engine still holds it: it starts again from the beginning, under the same name.
      live.item.resume()
      this.push(live)
      this.changeState(live, { state: 'progressing', receivedBytes: 0, canResume: undefined, error: undefined })
      return
    }
    const record = this.get(id)
    if (!record) return
    const ses = this.privates.get(id)?.session ?? this.opts.session(record.profileId)
    this.remove(id)
    ses.downloadURL(record.url)
  }

  /**
   * Keeps a download held back as possibly harmful (DL-12): it goes into place under its name (a free
   * one if something took it meanwhile), marked as from the internet. False when it couldn't.
   */
  keep(id: string, windowId?: WindowId): boolean {
    const record = this.get(id)
    if (record?.state !== 'completed' || !record.danger) return false
    const partial = partialPath(record)
    let savePath = record.savePath
    try {
      if (this.taken(savePath)) savePath = freePath(dirname(savePath), basename(savePath), (p) => this.taken(p))
      renameSync(partial, savePath)
    } catch (err) {
      console.error('[downloads] cannot keep a download:', err)
      this.opts.notify(windowId, `Couldn't keep ${record.filename}`)
      return false
    }
    void markFromInternet(savePath, record)
    this.finish(id, record.profileId, {
      danger: undefined,
      savePath,
      filename: basename(savePath),
      endedAt: Date.now(),
    })
    return true
  }

  /** Discards a download held back as possibly harmful (DL-12): its file is deleted, its entry goes. */
  discard(id: string): void {
    const record = this.get(id)
    if (record?.state !== 'completed' || !record.danger) return
    removePartial(record)
    this.forget(id, record.profileId)
  }

  /** Takes a download off the list and the sidebar; a finished file stays, a partial one goes (DL-08). */
  remove(id: string): void {
    const record = this.get(id)
    if (!record) return
    const live = this.live.get(id)
    if (live) {
      // Running or held by the engine: stopping it deletes its partial file.
      live.removed = true
      live.item.cancel()
    } else if (record.state !== 'completed' || record.danger) {
      removePartial(record)
    }
    this.forget(id, record.profileId)
  }

  /**
   * Moves a finished download's file to the Trash (never a permanent delete) and takes it off the
   * list (DL-08). A download not finished is removed as Remove from List does. False when the file
   * couldn't be moved: it stays listed.
   */
  async trash(id: string, windowId?: WindowId): Promise<boolean> {
    const record = this.get(id)
    if (!record) return false
    if (record.state === 'completed' && !record.danger && !this.live.has(id) && existsSync(record.savePath)) {
      try {
        await this.opts.files.trashItem(record.savePath)
      } catch (err) {
        console.error('[downloads] cannot move a download to the Trash:', err)
        const bin = process.platform === 'win32' ? 'the Recycle Bin' : 'the Trash'
        this.opts.notify(windowId, `Couldn't move ${record.filename} to ${bin}`)
        return false
      }
    }
    this.remove(id)
    return true
  }

  /**
   * Clears a profile's list of its finished downloads ("Clear all", DL-08; clearing "Download
   * history"): complete, cancelled, and failed ones that can't continue. Running, paused, held
   * (DL-12) and resumable ones stay. Files stay, partial ones of failed downloads go. Returns how
   * many entries went.
   */
  clear(profileId: ProfileId): number {
    const stays = (r: Download) => {
      if (this.live.get(r.id)?.item.getState() === 'progressing') return true
      if (r.state === 'progressing' || r.state === 'paused' || r.danger) return true
      if (r.state !== 'interrupted') return false
      const live = this.live.get(r.id)
      if (live) return canContinue(live.item)
      const record = this.list.get(r.id)
      return !!record && this.resumable(record)
    }
    const ids = new Set<string>()
    for (const r of this.list.list(profileId)) if (!stays(r)) ids.add(r.id)
    for (const [id, p] of this.privates) if (p.record.profileId === profileId && !stays(p.record)) ids.add(id)
    for (const d of Object.values(this.ctx.store.state.downloads)) {
      if (d.profileId === profileId && !stays(d)) ids.add(d.id)
    }
    for (const id of ids) {
      const record = this.get(id)
      const live = this.live.get(id)
      if (live) {
        live.removed = true
        live.item.cancel()
      } else if (record && record.state !== 'completed') {
        removePartial(record)
      }
      const timer = this.lingers.get(id)
      if (timer) clearTimeout(timer)
      this.lingers.delete(id)
      this.privates.delete(id)
    }
    this.list.removeWhere((r) => ids.has(r.id))
    const shown = Object.keys(this.ctx.store.state.downloads).filter((id) => ids.has(id))
    if (shown.length > 0) {
      this.ctx.store.update((d) => {
        for (const id of shown) delete d.downloads[id]
      })
    }
    if (ids.size > 0) this.opts.changed(profileId)
    return ids.size
  }

  /**
   * Opens a finished download (DL-04): in a new tab when Orbit can show it (PDF, image, text, audio,
   * video), else with the system's app. False when its file is gone or couldn't be opened.
   */
  async open(id: string, windowId?: WindowId): Promise<boolean> {
    const path = this.finishedFile(id)
    if (!path) return false
    if (showsInline(path)) {
      this.opts.openInTab(pathToFileURL(path).href, windowId)
      return true
    }
    const error = await this.opts.files.openPath(path)
    if (!error) return true
    console.error('[downloads] cannot open a download:', error)
    this.opts.notify(windowId, `Couldn't open ${basename(path)}`)
    return false
  }

  /** A finished download's file, when it is still there. */
  finishedFile(id: string): string | undefined {
    const record = this.get(id)
    if (record?.state !== 'completed' || record.danger || this.live.has(id)) return undefined
    return existsSync(record.savePath) ? record.savePath : undefined
  }

  /** Shows the file in its folder (DL-04): the finished file, or the partial one while it downloads. */
  showInFolder(id: string): boolean {
    const live = this.live.get(id)
    const record = live ? undefined : this.get(id)
    const path = live ? live.tempPath : record?.danger ? partialPath(record) : this.finishedFile(id)
    if (!path || !existsSync(path)) return false
    this.opts.files.showItemInFolder(path)
    return true
  }

  /**
   * Quitting: running downloads are recorded as they are (bytes so far), and what the engine does
   * to them while it shuts down is ignored, so they come back interrupted, ready to resume (DL-15).
   */
  quit(): void {
    if (this.quitting) return
    this.quitting = true
    for (const live of this.live.values()) {
      if (live.removed || this.privates.has(live.id)) continue
      const record = this.list.update(live.id, {
        receivedBytes: live.item.getReceivedBytes(),
        totalBytes: live.item.getTotalBytes(),
      })
      // The engine deletes partial files as it shuts down: a second name for the file keeps its bytes.
      if (record && canContinueLater(live.item)) {
        const kept = keptPath(record)
        try {
          rmSync(kept, { force: true })
          linkSync(live.tempPath, kept)
        } catch (err) {
          console.error('[downloads] cannot keep a partial download for later:', err)
        }
      }
    }
    this.list.flushSync()
  }

  /** A private session has pages again (DL-16). */
  privateSessionOpened(ses: Session): void {
    this.closedSessions.delete(ses)
  }

  /**
   * A private session's last page closed (its window closed, DL-16): its downloads leave every list,
   * at once when they have ended, when they end otherwise.
   */
  privateSessionClosed(ses: Session): void {
    this.closedSessions.add(ses)
    const ended = [...this.privates].filter(([id, p]) => p.session === ses && !this.live.has(id)).map(([id]) => id)
    if (ended.length === 0) return
    const profiles = new Set<ProfileId>()
    for (const id of ended) {
      const p = this.privates.get(id)
      if (p) profiles.add(p.record.profileId)
      this.privates.delete(id)
      const timer = this.lingers.get(id)
      if (timer) clearTimeout(timer)
      this.lingers.delete(id)
    }
    const shown = ended.filter((id) => this.ctx.store.state.downloads[id])
    if (shown.length > 0) {
      this.ctx.store.update((d) => {
        for (const id of shown) delete d.downloads[id]
      })
    }
    for (const profileId of profiles) this.opts.changed(profileId)
  }

  /** Can continue from its partial file in a new session (after a restart). */
  private resumable(record: DownloadRecord): boolean {
    const r = record.resume
    if (!r || r.urlChain.length === 0 || !(r.etag || r.lastModified) || record.totalBytes <= 0) return false
    for (const path of [r.tempPath, keptPath(record)]) {
      try {
        return statSync(path).size < record.totalBytes
      } catch {
        // not there: the next one
      }
    }
    return false
  }

  private start(ses: Session, item: DownloadItem, contents: WebContents | undefined): void {
    // An interrupted download asked to continue (createInterruptedDownload) comes back here.
    const resumed = item.getState() === 'interrupted' ? this.takeResuming(item) : undefined
    if (resumed) {
      this.adopt(resumed, item)
      return
    }
    const { store, tabs, windows } = this.ctx
    const page = contents && !contents.isDestroyed() ? contents : undefined
    const tabId = page ? tabs.tabIdFor(page) : undefined
    const tab = tabId ? store.state.tabs[tabId] : undefined
    const profileId = tab?.profileId ?? this.profileOf.get(ses) ?? DEFAULT_PROFILE_ID
    const folder = this.opts.folder(profileId)
    try {
      mkdirSync(folder, { recursive: true })
    } catch (err) {
      console.error('[downloads] cannot create the download folder:', err)
    }
    const finalPath = freePath(folder, safeFilename(item.getFilename()), (p) => this.taken(p))
    const tempPath = `${finalPath}${PARTIAL_SUFFIX}`
    // Set now, inside the event: without a path the engine would ask where to save.
    item.setSavePath(tempPath)
    this.reserved.add(finalPath.toLowerCase())

    const blank = !!page && isBlank(page)
    const opener = tab?.openerTabId ? store.state.tabs[tab.openerTabId] : undefined
    const pageUrl = (!blank && page ? page.getURL() : opener?.url) || item.getInitiatorOrigin() || undefined
    const windowId = (tabId ? windows.windowOfTab(tabId) : undefined) ?? windows.focusedWindowId()
    const id = newId('d')
    const live: Live = { id, item, profileId, finalPath, tempPath, windowId, lastPush: 0 }
    this.live.set(id, live)
    const record: DownloadRecord = stripUndefined({
      id,
      url: item.getURL(),
      filename: basename(finalPath),
      savePath: finalPath,
      state: 'progressing',
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      startedAt: Date.now(),
      profileId,
      mimeType: item.getMimeType() || undefined,
      pageUrl,
    })
    if (ses.isPersistent()) {
      this.list.put({ ...record, resume: resumeInfo(item, tempPath) })
    } else {
      record.private = true
      this.privates.set(id, { record, session: ses })
    }
    store.update((d) => {
      d.downloads[id] = { ...record }
    })
    this.opts.changed(profileId)

    this.listen(live)
    this.opts.feedback(windowId, 'started', { id, filename: record.filename })
    // A tab opened just for this download (a link to a file in a new tab) closes itself.
    if (blank && tabId) setImmediate(() => this.opts.closeBlankTab(tabId))
  }

  /** The download asked to continue that this item is (by its partial file, else its address). */
  private takeResuming(item: DownloadItem): string | undefined {
    const path = item.getSavePath()
    let key = path && this.resuming.has(path) ? path : undefined
    if (!key) {
      const url = item.getURL()
      key = [...this.resuming].find(([, r]) => r.url === url)?.[0]
    }
    if (!key) return undefined
    const id = this.resuming.get(key)?.id
    this.resuming.delete(key)
    return id
  }

  /** Takes over the engine's item for a download continuing after a restart, and resumes it (DL-15). */
  private adopt(id: string, item: DownloadItem): void {
    const record = this.list.get(id)
    if (!record) {
      item.cancel()
      return
    }
    const live: Live = {
      id,
      item,
      profileId: record.profileId,
      finalPath: record.savePath,
      tempPath: item.getSavePath() || partialPath(record),
      windowId: this.ctx.windows.focusedWindowId(),
      lastPush: 0,
    }
    this.live.set(id, live)
    this.reserved.add(record.savePath.toLowerCase())
    const { resume: _resume, endedAt: _ended, error: _error, canResume: _canResume, ...shown } = record
    this.ctx.store.update((d) => {
      d.downloads[id] = {
        ...shown,
        state: 'progressing',
        receivedBytes: item.getReceivedBytes() || record.receivedBytes,
        totalBytes: item.getTotalBytes() || record.totalBytes,
      }
    })
    this.list.update(id, { state: 'progressing', endedAt: undefined, error: undefined, canResume: undefined })
    this.opts.changed(record.profileId)
    this.listen(live)
    item.resume()
  }

  private listen(live: Live): void {
    live.item.on('updated', (_event, state) => this.progress(live, state))
    live.item.once('done', (_event, state) => this.done(live, state))
  }

  /** A name is taken by a file on disk or by a download still running. */
  /**
   * A name in use: a file there, one a running download will get, or one a download waiting to
   * continue (DL-15) will get when it does.
   */
  private taken(path: string): boolean {
    const key = path.toLowerCase()
    if (this.reserved.has(key) || existsSync(path)) return true
    return this.list
      .list()
      .some((r) => r.state !== 'completed' && r.state !== 'cancelled' && r.savePath.toLowerCase() === key)
  }

  private progress(live: Live, state: 'progressing' | 'interrupted'): void {
    if (this.quitting || live.removed) return
    const { item } = live
    if (state === 'interrupted') {
      // The engine keeps it: it may get over it by itself, else it can be resumed or retried (DL-15).
      this.push(live)
      this.changeState(live, {
        state: 'interrupted',
        canResume: canContinue(item),
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
      })
      const timer = setTimeout(() => {
        if (this.live.get(live.id) === live && this.ctx.store.state.downloads[live.id]?.state === 'interrupted') {
          this.opts.feedback(live.windowId, 'failed', { id: live.id, filename: basename(live.finalPath) })
        }
      }, FAILURE_GRACE_MS)
      timer.unref?.()
      return
    }
    const next: Download['state'] = item.isPaused() ? 'paused' : 'progressing'
    const current = this.ctx.store.state.downloads[live.id]?.state
    if (current !== next) {
      this.push(live)
      this.changeState(live, { state: next, canResume: undefined })
      return
    }
    // Bytes are coalesced: at most one patch per interval.
    const wait = live.lastPush + PROGRESS_INTERVAL_MS - Date.now()
    if (wait <= 0) this.push(live)
    else live.pushTimer ??= setTimeout(() => this.push(live), wait)
  }

  /** Copies the bytes received so far into OrbitState. */
  private push(live: Live): void {
    if (live.pushTimer) clearTimeout(live.pushTimer)
    live.pushTimer = undefined
    live.lastPush = Date.now()
    const { item } = live
    const received = item.getReceivedBytes()
    const total = item.getTotalBytes()
    const speed = item.isPaused() || item.getState() !== 'progressing' ? 0 : item.getCurrentBytesPerSecond()
    this.ctx.store.update((d) => {
      const entry = d.downloads[live.id]
      if (!entry) return
      if (entry.receivedBytes !== received) entry.receivedBytes = received
      if (entry.totalBytes !== total) entry.totalBytes = total
      if (entry.speed !== speed) entry.speed = speed
    })
  }

  /** A change of state (not just bytes): the sidebar and the list both hear of it. */
  private changeState(live: Live, fields: Partial<DownloadRecord>): void {
    this.ctx.store.update((d) => {
      const entry = d.downloads[live.id]
      if (entry) assign(entry, fields)
    })
    this.save(live.id, live.profileId, fields)
  }

  /** Writes fields of a download's record: the list's, or a private one's. */
  private save(id: string, profileId: ProfileId, fields: Partial<DownloadRecord>): void {
    const p = this.privates.get(id)
    if (p) {
      const { resume: _resume, ...rest } = fields
      const next = { ...p.record }
      assign(next, rest)
      p.record = next
    } else if (!this.list.update(id, fields)) {
      return
    }
    this.opts.changed(profileId)
  }

  private done(live: Live, state: 'completed' | 'cancelled' | 'interrupted'): void {
    if (live.pushTimer) clearTimeout(live.pushTimer)
    live.pushTimer = undefined
    // Quitting: the list keeps it as it was (DL-15); the engine keeps or deletes the partial file.
    if (this.quitting) return
    this.live.delete(live.id)
    this.reserved.delete(live.finalPath.toLowerCase())
    const { item } = live
    const endedAt = Date.now()
    if (live.removed) {
      if (state === 'completed') this.place(live)
      else removeFile(live.tempPath)
      return
    }
    if (state === 'cancelled') {
      removeFile(live.tempPath)
      this.finish(live.id, live.profileId, { state, endedAt, canResume: undefined, resume: undefined })
      return
    }
    if (state === 'interrupted') {
      // The engine gave up on it: Retry starts it again (DL-15).
      removeFile(live.tempPath)
      this.finish(live.id, live.profileId, {
        state,
        endedAt,
        canResume: false,
        receivedBytes: item.getReceivedBytes(),
        resume: undefined,
      })
      this.opts.feedback(live.windowId, 'failed', { id: live.id, filename: basename(live.finalPath) })
      return
    }
    const received = item.getReceivedBytes()
    const total = item.getTotalBytes() || received
    if (isDangerous(live.finalPath)) {
      // Held back (DL-12): complete, but under its partial name until the user keeps or discards it.
      this.finish(live.id, live.profileId, {
        state,
        endedAt,
        danger: 'file-type',
        receivedBytes: received,
        totalBytes: total,
        canResume: undefined,
        resume: undefined,
      })
      this.opts.feedback(live.windowId, 'held', { id: live.id, filename: basename(live.finalPath) })
      return
    }
    const savePath = this.place(live)
    const record = this.get(live.id)
    if (record) void markFromInternet(savePath, record)
    this.finish(live.id, live.profileId, {
      state,
      endedAt,
      savePath,
      filename: basename(savePath),
      receivedBytes: received,
      totalBytes: total,
      canResume: undefined,
      resume: undefined,
    })
    this.opts.feedback(live.windowId, 'done', { id: live.id, filename: basename(savePath) })
  }

  /** A complete file gets its real name, a free one if something took it meanwhile. */
  private place(live: Live): string {
    let savePath = live.finalPath
    try {
      if (existsSync(savePath)) savePath = freePath(dirname(live.finalPath), basename(savePath), (p) => this.taken(p))
      renameSync(live.tempPath, savePath)
    } catch (err) {
      console.error('[downloads] cannot move the finished download into place:', err)
      savePath = live.tempPath
    }
    return savePath
  }

  /**
   * Final state: written to the list; the sidebar shows a finished download for a few seconds
   * (DL-03), a failed one until it is retried or dismissed, a cancelled one no more. A private
   * download whose window has closed leaves every list (DL-16).
   */
  private finish(id: string, profileId: ProfileId, fields: Partial<DownloadRecord>): void {
    const { resume: _resume, ...shown } = fields
    const p = this.privates.get(id)
    const closed = !!p && this.closedSessions.has(p.session)
    const hide = fields.state === 'cancelled' || closed
    this.ctx.store.update((d) => {
      const entry = d.downloads[id]
      if (!entry) return
      if (hide) delete d.downloads[id]
      else {
        assign(entry, shown)
        delete entry.speed
      }
    })
    if (closed) {
      this.privates.delete(id)
      this.opts.changed(profileId)
      return
    }
    this.save(id, profileId, fields)
    const record = this.get(id)
    if (record?.state === 'completed' && !record.danger) {
      const timer = setTimeout(() => {
        this.lingers.delete(id)
        if (this.ctx.store.state.downloads[id]?.state === 'completed') this.dismiss(id)
      }, DONE_LINGER_MS)
      timer.unref?.()
      this.lingers.set(id, timer)
    }
  }

  /** Off the list and the sidebar. */
  private forget(id: string, profileId: ProfileId): void {
    const timer = this.lingers.get(id)
    if (timer) clearTimeout(timer)
    this.lingers.delete(id)
    const wasPrivate = this.privates.delete(id)
    if (this.ctx.store.state.downloads[id]) this.ctx.store.update((d) => void delete d.downloads[id])
    if (this.list.remove(id) || wasPrivate) this.opts.changed(profileId)
  }
}

/**
 * An interrupted download the engine can continue where it stopped: the server named a version of
 * the file to check the rest against (DL-15 Resume; otherwise Retry).
 */
function canContinue(item: DownloadItem): boolean {
  return item.canResume() && !!(item.getETag() || item.getLastModifiedTime()) && item.getReceivedBytes() > 0
}

/** A page that never showed anything: a new tab whose only navigation became this download. */
function isBlank(contents: WebContents): boolean {
  const url = contents.getURL()
  return (url === '' || url === 'about:blank') && !contents.navigationHistory.canGoBack()
}

/** Where a download not running here left its partial file (or a held one, DL-12, its file). */
function partialPath(record: DownloadRecord): string {
  return record.resume?.tempPath ?? `${record.savePath}${PARTIAL_SUFFIX}`
}

/** Where a finished download's file is: in place, or under its partial name while held (DL-12). */
function fileOf(record: DownloadRecord): string {
  return record.danger ? partialPath(record) : record.savePath
}

/**
 * The second name a partial file gets at quit, to outlive the engine's shutdown (DL-15): hidden,
 * beside it, and unique to the download.
 */
function keptPath(record: DownloadRecord): string {
  return join(dirname(record.savePath), `.${basename(record.savePath)}.${record.id}${PARTIAL_SUFFIX}`)
}

/** Deletes what is left of a download that will never continue. */
function removePartial(record: DownloadRecord): void {
  removeFile(partialPath(record))
  removeFile(keptPath(record))
}

/** An unfinished download that can continue after a restart: the server named a version of the file. */
function canContinueLater(item: DownloadItem): boolean {
  const state = item.getState()
  if (state !== 'progressing' && !(state === 'interrupted' && item.canResume())) return false
  return !!(item.getETag() || item.getLastModifiedTime()) && item.getReceivedBytes() > 0
}

function resumeInfo(item: DownloadItem, tempPath: string): ResumeInfo {
  return {
    urlChain: item.getURLChain(),
    mimeType: item.getMimeType(),
    etag: item.getETag(),
    lastModified: item.getLastModifiedTime(),
    tempPath,
    startTime: item.getStartTime(),
  }
}

function removeFile(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch (err) {
    console.error('[downloads] cannot delete a partial download:', err)
  }
}

/** Sets fields on an entry (or an Immer draft of one); an undefined value removes the field. */
function assign(target: Download, fields: Partial<Download>): void {
  const t = target as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) delete t[key]
    else if (t[key] !== value) t[key] = value
  }
}

function stripUndefined<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) if (value[key] === undefined) delete value[key]
  return value
}
