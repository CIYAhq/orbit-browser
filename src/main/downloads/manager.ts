import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { DownloadItem, Session, WebContents } from 'electron'
import { DEFAULT_PROFILE_ID } from '../../shared/defaults'
import { newId } from '../../shared/ids'
import type { Download, ProfileId, TabId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import { freePath, PARTIAL_SUFFIX, safeFilename } from './names'
import type { DownloadRecord, DownloadStore, ResumeInfo } from './store'

/** How long a finished download stays on the sidebar's indicator (DL-03: about 3–5 s). */
export const DONE_LINGER_MS = 4000
/** Progress reaches OrbitState at most this often per download. */
const PROGRESS_INTERVAL_MS = 250

/** A download the engine is running (or holding, paused or interrupted) in this session. */
interface Live {
  id: string
  item: DownloadItem
  profileId: ProfileId
  /** Where the file goes once complete. */
  finalPath: string
  /** Where it is written until then (`<final>.crdownload`). */
  tempPath: string
  private: boolean
  /** The window it was started from (feedback goes there). */
  windowId?: WindowId
  lastPush: number
  pushTimer?: NodeJS.Timeout
}

export interface DownloadManagerOptions {
  /** The folder a profile's downloads are saved to (DL-07). */
  folder: (profileId: ProfileId) => string
  /** Says something brief on screen (start, finish, failure). */
  notify: (windowId: WindowId | undefined, message: string) => void
  /** A tab that was opened only to download a file and never showed a page: close it (DL-01). */
  closeBlankTab: (tabId: TabId) => void
  /** A profile's list changed. */
  changed: (profileId: ProfileId) => void
}

/**
 * The downloads flow (DL-01): every profile session's `will-download`. A download is saved straight
 * to its profile's folder under a free name, written as `<name>.crdownload` until complete, and
 * tracked in OrbitState (what the sidebar shows) and the downloads list (DownloadStore).
 */
export class DownloadManager {
  private live = new Map<string, Live>()
  private sessions = new WeakSet<Session>()
  private profileOf = new WeakMap<Session, ProfileId>()
  /** Final paths of downloads still running, lowercased: two at once never get the same name. */
  private reserved = new Set<string>()
  private lingers = new Map<string, NodeJS.Timeout>()

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

  /** The record of a download (the list's, or the sidebar's for a private one). */
  get(id: string): Download | undefined {
    return this.ctx.store.state.downloads[id] ?? this.list.get(id)
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
    const tempPath = this.list.get(id)?.resume?.tempPath ?? `${record.savePath}${PARTIAL_SUFFIX}`
    removeFile(tempPath)
    this.finish(id, record.profileId, { state: 'cancelled', endedAt: Date.now(), canResume: undefined })
  }

  /** Takes a download off the sidebar's indicator (it stays in the list). */
  dismiss(id: string): void {
    const timer = this.lingers.get(id)
    if (timer) clearTimeout(timer)
    this.lingers.delete(id)
    if (this.ctx.store.state.downloads[id]) this.ctx.store.update((d) => void delete d.downloads[id])
  }

  /** Writes the list now (quit). */
  flush(): void {
    this.list.flushSync()
  }

  private start(ses: Session, item: DownloadItem, contents: WebContents | undefined): void {
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
    const live: Live = {
      id,
      item,
      profileId,
      finalPath,
      tempPath,
      private: !ses.isPersistent(),
      windowId,
      lastPush: 0,
    }
    this.live.set(id, live)
    const record: DownloadRecord = {
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
    }
    if (live.private) record.private = true
    store.update((d) => {
      d.downloads[id] = stripUndefined({ ...record })
    })
    if (!live.private) {
      this.list.put({ ...stripUndefined(record), resume: resumeInfo(item, tempPath) })
      this.opts.changed(profileId)
    }

    item.on('updated', (_event, state) => this.progress(live, state))
    item.once('done', (_event, state) => this.done(live, state))
    this.opts.notify(windowId, `Downloading ${record.filename}`)
    // A tab opened just for this download (a link to a file in a new tab) closes itself.
    if (blank && tabId) setImmediate(() => this.opts.closeBlankTab(tabId))
  }

  /** A name is taken by a file on disk or by a download still running. */
  private taken(path: string): boolean {
    return this.reserved.has(path.toLowerCase()) || existsSync(path)
  }

  private progress(live: Live, state: 'progressing' | 'interrupted'): void {
    const { item } = live
    if (state === 'interrupted') {
      // The engine keeps it: it can be resumed (DL-15).
      this.push(live)
      this.changeState(live, {
        state: 'interrupted',
        canResume: item.canResume(),
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
      })
      this.opts.notify(live.windowId, `Couldn't finish downloading ${basename(live.finalPath)}`)
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
    const speed = item.isPaused() ? 0 : item.getCurrentBytesPerSecond()
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
    if (live.private) return
    this.list.update(live.id, fields)
    this.opts.changed(live.profileId)
  }

  private done(live: Live, state: 'completed' | 'cancelled' | 'interrupted'): void {
    if (live.pushTimer) clearTimeout(live.pushTimer)
    live.pushTimer = undefined
    this.live.delete(live.id)
    this.reserved.delete(live.finalPath.toLowerCase())
    const { item } = live
    const endedAt = Date.now()
    const name = basename(live.finalPath)
    if (state === 'cancelled') {
      removeFile(live.tempPath)
      this.finish(live.id, live.profileId, { state, endedAt, canResume: undefined }, live.private)
      return
    }
    if (state === 'interrupted') {
      // Not resumable (the engine gave up on it): Retry starts it again (DL-15).
      removeFile(live.tempPath)
      this.finish(
        live.id,
        live.profileId,
        { state, endedAt, canResume: false, receivedBytes: item.getReceivedBytes(), resume: undefined },
        live.private,
      )
      this.opts.notify(live.windowId, `Couldn't download ${name}`)
      return
    }
    // Complete: the file gets its real name, a free one if something took it meanwhile.
    let savePath = live.finalPath
    try {
      if (existsSync(savePath)) savePath = freePath(dirname(live.finalPath), name, (p) => this.taken(p))
      renameSync(live.tempPath, savePath)
    } catch (err) {
      console.error('[downloads] cannot move the finished download into place:', err)
      savePath = live.tempPath
    }
    const fields: Partial<DownloadRecord> = {
      state,
      endedAt,
      savePath,
      filename: basename(savePath),
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes() || item.getReceivedBytes(),
      canResume: undefined,
      resume: undefined,
    }
    this.finish(live.id, live.profileId, fields, live.private)
    this.opts.notify(live.windowId, `Downloaded ${basename(savePath)}`)
  }

  /**
   * Final state: written to the list; the sidebar shows a finished download for a few seconds
   * (DL-03), a failed one until it is retried or dismissed, a cancelled one no more.
   */
  private finish(id: string, profileId: ProfileId, fields: Partial<DownloadRecord>, isPrivate = false): void {
    const { resume: _resume, ...shown } = fields
    this.ctx.store.update((d) => {
      const entry = d.downloads[id]
      if (!entry) return
      if (fields.state === 'cancelled') delete d.downloads[id]
      else {
        assign(entry, shown)
        delete entry.speed
      }
    })
    if (!isPrivate) {
      this.list.update(id, fields)
      this.opts.changed(profileId)
    }
    if (fields.state === 'completed') {
      const timer = setTimeout(() => {
        this.lingers.delete(id)
        if (this.ctx.store.state.downloads[id]?.state === 'completed') this.dismiss(id)
      }, DONE_LINGER_MS)
      timer.unref?.()
      this.lingers.set(id, timer)
    }
  }
}

/** A page that never showed anything: a new tab whose only navigation became this download. */
function isBlank(contents: WebContents): boolean {
  const url = contents.getURL()
  return (url === '' || url === 'about:blank') && !contents.navigationHistory.canGoBack()
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

/** Sets fields on a draft; an undefined value removes the field. */
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
