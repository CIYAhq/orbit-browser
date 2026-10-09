/**
 * The whole Archive, outside OrbitState (ARCHITECTURE §2: the archive beyond a recent window must
 * not live in state). Pure Node, no Electron, so it is unit-tested directly.
 *
 * - Every entry, oldest first, with the tab's back/forward history (AR-01), in memory and in an
 *   append-only JSONL log:
 *     {"t":"a","e":{…entry},"h":{history}}   added (history optional)
 *     {"t":"h","id":"…","h":{history}}        the history arrived after the entry
 *     {"t":"d","ids":["…"]}                   deleted: restored, removed, purged
 *     {"t":"c","p":"<profileId>","at":ms}     cleared: the profile's entries archived at or before `at`
 *   Every record is idempotent, so replaying one twice changes nothing.
 * - Records are appended synchronously in small batches (a short debounce), so they never land out
 *   of order; `flushSync()` writes what is queued (quit).
 * - The log is rewritten (snapshot to a temp file, then rename) at load when more than half of it is
 *   dead, and later once dead records outnumber live ones. The snapshot is built in chunks between
 *   other work; records logged meanwhile are appended to it before the rename.
 * - Pages' saved scroll and form state (`pageState`) stay in memory only: on disk an entry keeps
 *   the URLs and titles of its history, which is enough to rebuild back/forward.
 *
 * Search reuses the history store's matching (`queryTerms`, `urlKeyOf`): every word must appear in
 * the title or the URL (AR-04). The last match is cached, so paging through it is cheap.
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ArchivePage, ArchiveQuery, ArchiveRow } from '../../shared/commands/archive'
import type { ArchivedTab, ProfileId } from '../../shared/state'
import { queryTerms, urlKeyOf } from '../history/store'

/** One back/forward entry (the shape Chromium's navigation history restores). */
export interface HistoryItem {
  url: string
  title: string
  pageState?: string
}

export interface ArchiveHistory {
  entries: HistoryItem[]
  index: number
}

/** An entry as the store keeps it: the state fields plus its history. */
export interface StoredEntry extends ArchivedTab {
  history?: ArchiveHistory
}

interface Item {
  e: StoredEntry
  titleLower: string
  urlKey: string
  /** Start of the local day it was archived (ms). */
  day: number
}

type LogRecord =
  | { t: 'a'; e: ArchivedTab; h?: DiskHistory }
  | { t: 'h'; id: string; h: DiskHistory }
  | { t: 'd'; ids: string[] }
  | { t: 'c'; p: ProfileId; at: number }

/** History on disk: [url, title] pairs and the current index. */
interface DiskHistory {
  e: [string, string][]
  i: number
}

/** History entries kept per archived tab, around the current one. */
export const MAX_HISTORY_ENTRIES = 50
const MAX_TITLE = 400
const MAX_URL = 8192
const WRITE_DELAY_MS = 150
const SNAPSHOT_CHUNK = 1000
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

export function dayStart(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Keeps at most `MAX_HISTORY_ENTRIES` entries, the current one and mostly those before it. */
export function trimHistory(h: ArchiveHistory | undefined): ArchiveHistory | undefined {
  if (!h || !Array.isArray(h.entries) || h.entries.length === 0) return undefined
  const entries = h.entries.filter((x) => x && typeof x.url === 'string' && x.url.length <= MAX_URL)
  if (entries.length === 0) return undefined
  let index = Math.min(Math.max(0, Math.trunc(Number(h.index) || 0)), entries.length - 1)
  if (entries.length <= MAX_HISTORY_ENTRIES) return { entries, index }
  const start = Math.max(0, Math.min(index - (MAX_HISTORY_ENTRIES - 10), entries.length - MAX_HISTORY_ENTRIES))
  index -= start
  return { entries: entries.slice(start, start + MAX_HISTORY_ENTRIES), index }
}

function toDisk(h: ArchiveHistory): DiskHistory {
  return { e: h.entries.map((x) => [x.url, (x.title ?? '').slice(0, MAX_TITLE)]), i: h.index }
}

function fromDisk(h: unknown): ArchiveHistory | undefined {
  const d = h as DiskHistory | undefined
  if (!d || !Array.isArray(d.e)) return undefined
  const entries = d.e
    .filter((x) => Array.isArray(x) && typeof x[0] === 'string')
    .map(([url, title]) => ({ url, title: typeof title === 'string' ? title : '' }))
  return trimHistory({ entries, index: d.i })
}

const REASONS = new Set<ArchivedTab['reason']>(['auto', 'closed', 'cleared'])

/** A well-formed entry from anything (a log line, old state), or undefined. */
export function cleanEntry(input: unknown): ArchivedTab | undefined {
  const e = input as Partial<ArchivedTab> | undefined
  if (!e || typeof e !== 'object') return undefined
  if (typeof e.id !== 'string' || !e.id || typeof e.url !== 'string' || !e.url || e.url.length > MAX_URL)
    return undefined
  if (typeof e.profileId !== 'string' || typeof e.spaceId !== 'string') return undefined
  const out: ArchivedTab = {
    id: e.id,
    url: e.url,
    title: typeof e.title === 'string' ? e.title.slice(0, MAX_TITLE) : '',
    spaceId: e.spaceId,
    profileId: e.profileId,
    archivedAt: Number.isFinite(e.archivedAt) ? (e.archivedAt as number) : 0,
    reason: REASONS.has(e.reason as ArchivedTab['reason']) ? (e.reason as ArchivedTab['reason']) : 'closed',
  }
  if (typeof e.tabId === 'string') out.tabId = e.tabId
  if (typeof e.spaceName === 'string') out.spaceName = e.spaceName
  if (e.section === 'today' || e.section === 'pinned') out.section = e.section
  if (e.from === 'mini' || e.from === 'peek') out.from = e.from
  return out
}

function toRow(e: StoredEntry, favicon?: (url: string) => string | undefined): ArchiveRow {
  const row: ArchiveRow = {
    id: e.id,
    url: e.url,
    title: e.title,
    spaceId: e.spaceId,
    archivedAt: e.archivedAt,
    reason: e.reason,
  }
  if (e.spaceName) row.spaceName = e.spaceName
  if (e.section) row.section = e.section
  if (e.from) row.from = e.from
  if (e.history) row.hasHistory = true
  const icon = favicon?.(e.url)
  if (icon) row.favicon = icon
  return row
}

interface Match {
  key: string
  items: Item[]
  days: [number, number][]
}

export class ArchiveStore {
  /** Oldest first (by archive time). */
  private items: Item[] = []
  private byId = new Map<string, Item>()
  /** Entry ids per tab id (entries written by the tabs code carry the tab's id). */
  private byTab = new Map<string, Set<string>>()
  private pending: string[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private match: Match | undefined
  /** Lines logged while a snapshot is being built; appended to it before it replaces the log. */
  private tail: string[] | undefined
  private deadRecords = 0
  private phase: 'new' | 'loading' | 'ready' | 'closed' = 'new'
  private queued: (() => void)[] = []
  private loaded: Promise<void> | undefined
  /** Bumped on every change. */
  version = 0
  /** Called after every change (the service tells the Library to refresh). */
  onChange: (() => void) | undefined

  /** `file` null keeps everything in memory (tests): it is ready at once. */
  constructor(
    readonly file: string | null,
    private opts: { writeDelayMs?: number } = {},
  ) {
    if (!file) this.phase = 'ready'
  }

  get size(): number {
    return this.items.length
  }

  get ready(): boolean {
    return this.phase === 'ready' || this.phase === 'closed'
  }

  /** Reads the log once; changes made before it finishes apply after it. Safe to call repeatedly. */
  load(): Promise<void> {
    if (this.loaded) return this.loaded
    if (!this.file || this.phase !== 'new') {
      this.loaded = Promise.resolve()
      return this.loaded
    }
    this.phase = 'loading'
    this.loaded = this.readLog().then(() => {
      if (this.phase === 'loading') this.phase = 'ready'
      for (const run of this.queued.splice(0)) run()
      this.flushSync()
    })
    return this.loaded
  }

  // ---- Reads ----

  has(id: string): boolean {
    return this.byId.has(id)
  }

  get(id: string): StoredEntry | undefined {
    return this.byId.get(id)?.e
  }

  /** Every entry, oldest first (do not mutate). */
  all(): readonly StoredEntry[] {
    return this.items.map((i) => i.e)
  }

  /** Entries of one profile, newest first, with their precomputed search keys. */
  *newestFirst(profileId?: ProfileId): Generator<{ e: StoredEntry; titleLower: string; urlKey: string }> {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i] as Item
      if (profileId === undefined || item.e.profileId === profileId) yield item
    }
  }

  /** Entries for a tab id (a tab that came back by other means leaves the Archive). */
  idsOfTab(tabId: string): string[] {
    return [...(this.byTab.get(tabId) ?? [])]
  }

  /**
   * Matching entries, newest first, one page at a time (AR-03, AR-04). `favicon` looks up each
   * returned row's icon.
   */
  query(q: ArchiveQuery & { profileId: ProfileId }, favicon?: (url: string) => string | undefined): ArchivePage {
    const terms = queryTerms(q.text ?? '')
    const source = q.source ?? 'all'
    const key = JSON.stringify([this.version, q.profileId, terms, q.spaceId ?? '', source])
    let match = this.match
    if (match?.key !== key) {
      const items: Item[] = []
      const days: [number, number][] = []
      for (let i = this.items.length - 1; i >= 0; i--) {
        const item = this.items[i] as Item
        const e = item.e
        if (e.profileId !== q.profileId) continue
        if (q.spaceId && e.spaceId !== q.spaceId) continue
        if (source === 'mini' && e.from !== 'mini') continue
        if (source === 'sidebar' && e.from) continue
        if (terms.length && !terms.every((t) => item.titleLower.includes(t) || item.urlKey.includes(t))) continue
        items.push(item)
        const last = days[days.length - 1]
        if (last && last[0] === item.day) last[1]++
        else days.push([item.day, 1])
      }
      match = { key, items, days }
      this.match = match
    }
    const limit = Math.min(MAX_LIMIT, Math.max(0, Math.trunc(q.limit ?? DEFAULT_LIMIT)))
    const offset = Math.min(match.items.length, Math.max(0, Math.trunc(q.offset ?? 0)))
    return {
      profileId: q.profileId,
      version: this.version,
      total: match.items.length,
      days: match.days,
      offset,
      rows: match.items.slice(offset, offset + limit).map((i) => toRow(i.e, favicon)),
    }
  }

  // ---- Changes ----

  /**
   * Adds entries not already there (idempotent). Returns the ids added. Before the log is read,
   * changes wait and apply right after it (and return nothing).
   */
  add(entries: readonly ArchivedTab[], histories?: ReadonlyMap<string, ArchiveHistory>): string[] {
    if (!this.ready) {
      this.queued.push(() => this.add(entries, histories))
      return []
    }
    const added: string[] = []
    for (const raw of entries) {
      const clean = cleanEntry(raw)
      if (!clean || this.byId.has(clean.id)) continue
      const stored: StoredEntry = clean
      const history = trimHistory(histories?.get(clean.id))
      if (history) stored.history = history
      this.insert(stored)
      added.push(clean.id)
      this.log({ t: 'a', e: clean, ...(history ? { h: toDisk(history) } : {}) })
    }
    if (added.length) this.changed()
    return added
  }

  /** Attaches a tab's history to its entry (it may arrive after the entry). */
  setHistory(id: string, history: ArchiveHistory): void {
    if (!this.ready) {
      this.queued.push(() => this.setHistory(id, history))
      return
    }
    const item = this.byId.get(id)
    const h = trimHistory(history)
    if (!item || !h) return
    if (item.e.history) this.deadRecords++
    item.e.history = h
    this.log({ t: 'h', id, h: toDisk(h) })
    this.changed()
  }

  /** Removes entries (restored, deleted, purged). Returns the ids removed. */
  delete(ids: Iterable<string>): string[] {
    if (!this.ready) {
      const list = [...ids]
      this.queued.push(() => this.delete(list))
      return []
    }
    const gone = new Set<string>()
    for (const id of ids) if (this.byId.has(id)) gone.add(id)
    if (gone.size === 0) return []
    this.items = this.items.filter((i) => !gone.has(i.e.id))
    for (const id of gone) this.forget(id)
    this.deadRecords += gone.size + 1
    this.log({ t: 'd', ids: [...gone] })
    this.changed()
    return [...gone]
  }

  /** Removes a profile's entries archived at or before `at` (default: all of them). */
  clear(profileId: ProfileId, at = Number.MAX_SAFE_INTEGER): string[] {
    if (!this.ready) {
      this.queued.push(() => this.clear(profileId, at))
      return []
    }
    const gone = this.items.filter((i) => i.e.profileId === profileId && i.e.archivedAt <= at).map((i) => i.e.id)
    if (gone.length === 0) return []
    const set = new Set(gone)
    this.items = this.items.filter((i) => !set.has(i.e.id))
    for (const id of gone) this.forget(id)
    this.deadRecords += gone.length + 1
    this.log({ t: 'c', p: profileId, at })
    this.changed()
    return gone
  }

  /** Ids of entries archived before `time` (retention, AR-08). */
  olderThan(time: number): string[] {
    const out: string[] = []
    for (const item of this.items) {
      if (item.e.archivedAt >= time) break
      out.push(item.e.id)
    }
    return out
  }

  private insert(e: StoredEntry): void {
    const item: Item = {
      e,
      titleLower: e.title.toLowerCase(),
      urlKey: urlKeyOf(e.url),
      day: dayStart(e.archivedAt),
    }
    this.byId.set(e.id, item)
    if (e.tabId) {
      let set = this.byTab.get(e.tabId)
      if (!set) {
        set = new Set()
        this.byTab.set(e.tabId, set)
      }
      set.add(e.id)
    }
    const items = this.items
    // Nearly always the newest: append. Otherwise keep the list ordered by time (stable).
    if (items.length === 0 || (items[items.length - 1] as Item).e.archivedAt <= e.archivedAt) {
      items.push(item)
      return
    }
    let lo = 0
    let hi = items.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((items[mid] as Item).e.archivedAt <= e.archivedAt) lo = mid + 1
      else hi = mid
    }
    items.splice(lo, 0, item)
  }

  /** Drops an id from the lookup maps (the caller removes it from `items`). */
  private forget(id: string): void {
    const tabId = this.byId.get(id)?.e.tabId
    this.byId.delete(id)
    if (!tabId) return
    const set = this.byTab.get(tabId)
    set?.delete(id)
    if (set?.size === 0) this.byTab.delete(tabId)
  }

  private changed(): void {
    this.version++
    this.match = undefined
    this.onChange?.()
  }

  // ---- Disk ----

  private log(record: LogRecord): void {
    if (!this.file || this.phase === 'closed') return
    const line = JSON.stringify(record)
    this.pending.push(line)
    this.tail?.push(line)
    if (this.phase !== 'ready') return
    if (!this.timer) this.timer = setTimeout(() => this.flushSync(), this.opts.writeDelayMs ?? WRITE_DELAY_MS)
    this.maybeCompact()
  }

  /** Appends what is queued. Called on a short timer and at quit. */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (!this.file || this.pending.length === 0 || (this.phase !== 'ready' && this.phase !== 'closed')) return
    const lines = this.pending.splice(0)
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      appendFileSync(this.file, `${lines.join('\n')}\n`)
    } catch (err) {
      console.error('[archive] could not write the archive log', err)
    }
  }

  private isClosed(): boolean {
    return this.phase === 'closed'
  }

  /** Writes what is queued and stops writing (app quit). */
  close(): void {
    this.flushSync()
    this.phase = 'closed'
  }

  private async readLog(): Promise<void> {
    if (!this.file) return
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch {
      return
    }
    let lines = 0
    for (const line of text.split('\n')) {
      if (!line) continue
      lines++
      let rec: LogRecord
      try {
        rec = JSON.parse(line) as LogRecord
      } catch {
        continue
      }
      this.replay(rec)
    }
    this.deadRecords = Math.max(0, lines - this.items.length)
    this.changed()
    if (this.deadRecords > this.items.length) this.compactSoon()
  }

  private replay(rec: LogRecord): void {
    if (rec.t === 'a') {
      const clean = cleanEntry(rec.e)
      if (!clean || this.byId.has(clean.id)) return
      const stored: StoredEntry = clean
      const h = fromDisk(rec.h)
      if (h) stored.history = h
      this.insert(stored)
    } else if (rec.t === 'h') {
      const item = this.byId.get(rec.id)
      const h = fromDisk(rec.h)
      if (item && h) item.e.history = h
    } else if (rec.t === 'd' && Array.isArray(rec.ids)) {
      const gone = new Set(rec.ids.filter((id) => this.byId.has(id)))
      if (gone.size === 0) return
      this.items = this.items.filter((i) => !gone.has(i.e.id))
      for (const id of gone) this.forget(id)
    } else if (rec.t === 'c' && typeof rec.p === 'string') {
      const at = Number.isFinite(rec.at) ? rec.at : Number.MAX_SAFE_INTEGER
      const keep: Item[] = []
      for (const i of this.items) {
        if (i.e.profileId === rec.p && i.e.archivedAt <= at) this.forget(i.e.id)
        else keep.push(i)
      }
      this.items = keep
    }
  }

  private compacting: Promise<void> | undefined
  private compactTimer: ReturnType<typeof setTimeout> | undefined

  private maybeCompact(): void {
    if (this.deadRecords > Math.max(500, this.items.length)) this.compactSoon()
  }

  private compactSoon(): void {
    if (this.compacting || this.compactTimer || !this.file) return
    this.compactTimer = setTimeout(() => {
      this.compactTimer = undefined
      void this.compact()
    }, 0)
  }

  /** Rewrites the log as one record per live entry (temp file, then rename). One at a time. */
  compact(): Promise<void> {
    if (!this.compacting) {
      this.compacting = this.rewrite().finally(() => {
        this.compacting = undefined
      })
    }
    return this.compacting
  }

  private async rewrite(): Promise<void> {
    const file = this.file
    if (!file || this.phase === 'closed') return
    this.tail = []
    const lines: string[] = []
    const snapshot = [...this.items]
    for (let i = 0; i < snapshot.length; i += SNAPSHOT_CHUNK) {
      for (const item of snapshot.slice(i, i + SNAPSHOT_CHUNK)) {
        const { history, ...entry } = item.e
        lines.push(JSON.stringify({ t: 'a', e: entry, ...(history ? { h: toDisk(history) } : {}) }))
      }
      // Let other work run between chunks.
      await new Promise((r) => setImmediate(r))
      if (this.isClosed()) {
        this.tail = undefined
        return
      }
    }
    // Records logged meanwhile go after the snapshot; pending ones not yet on disk are in the tail too.
    const tail = this.tail
    this.tail = undefined
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.pending = []
    const tmp = `${file}.tmp`
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(tmp, `${[...lines, ...tail].join('\n')}\n`)
      renameSync(tmp, file)
      this.deadRecords = tail.length
    } catch (err) {
      console.error('[archive] could not compact the archive log', err)
      try {
        rmSync(tmp, { force: true })
      } catch {
        // ignore
      }
      // Nothing was lost: the old log is still there; write the tail to it.
      this.pending = tail
      this.flushSync()
    }
  }

  /** Runs `fn` once the log has been read (commands that need the whole Archive). */
  async whenLoaded<T>(fn: () => T): Promise<T> {
    if (!this.ready) await this.load()
    return fn()
  }

  /** Runs `run` now when loaded, else right after loading (callers that must not wait). */
  afterLoad(run: () => void): void {
    if (this.ready) run()
    else this.queued.push(run)
  }
}
