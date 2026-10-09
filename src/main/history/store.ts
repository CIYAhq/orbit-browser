/**
 * Browsing history for one profile: an append-only JSONL log plus an in-memory
 * index. Pure Node (no Electron), so it is unit-tested directly.
 *
 * File format: one JSON record per line.
 *   {"t":"v","u":url,"at":ms,"ty":1?}          a visit (ty: typed/chosen in the command bar)
 *   {"t":"ti","u":url,"ti":title}              title update for a URL
 *   {"t":"fi","u":url,"fi":favicon}            favicon update for a URL
 *   {"t":"d","u":url}                           delete every visit to a URL
 *   {"t":"c","from":ms,"to":ms}                 delete visits in [from, to)
 *   {"t":"e","u","ti","fi","vc","tc","fv","v"}  compacted entry (written on load)
 *
 * `load()` replays the log, merges anything recorded meanwhile, and rewrites the
 * file compacted (one "e" line per URL; tmp file + rename). New records are
 * appended in small batches; `flushSync()` writes the rest on quit. Nothing here
 * blocks the main thread except `flushSync`.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { HistoryEntry, HistoryVisit } from '../../shared/commands/history'

/** Visit timestamps kept per URL (the count keeps growing; older times are dropped). */
export const MAX_VISITS_PER_ENTRY = 20
/** Entries kept after compaction (most recently visited first). */
export const MAX_ENTRIES = 50_000
const MAX_TITLE = 400
const MAX_FAVICON = 2048
const FLUSH_DELAY_MS = 250
const DAY = 86_400_000

/** A history entry plus lowercase search fields, kept in sync by the store. Treat as read-only. */
export interface IndexedEntry extends HistoryEntry {
  /** Visit times, oldest first (at most MAX_VISITS_PER_ENTRY). */
  visits: number[]
  titleLower: string
  /** Lowercased URL without scheme and leading "www." (e.g. "github.com/orbit"). */
  urlKey: string
  /** Lowercased host with port, without "www." (e.g. "github.com", "localhost:3000"). */
  host: string
}

/** Visits aggregated per host, for inline domain completion. */
export interface HostInfo {
  host: string
  /** Scheme + host of the latest visit, e.g. "https://github.com". */
  origin: string
  visitCount: number
  typedCount: number
  lastVisit: number
}

type LogRecord =
  | { t: 'v'; u: string; at: number; ty?: 1 }
  | { t: 'ti'; u: string; ti: string }
  | { t: 'fi'; u: string; fi: string }
  | { t: 'd'; u: string }
  | { t: 'c'; from: number; to: number }
  | { t: 'e'; u: string; ti: string; fi?: string; vc: number; tc: number; fv: number; v: number[] }

/** Frequency × recency weight (≈1 for one old visit, up to ≈10 for daily typed sites). */
export function frecency(e: Pick<HistoryEntry, 'visitCount' | 'typedCount' | 'lastVisit'>, now: number): number {
  const age = (now - e.lastVisit) / DAY
  const recency = age < 1 ? 1 : age < 4 ? 0.85 : age < 14 ? 0.7 : age < 31 ? 0.5 : age < 90 ? 0.3 : 0.15
  return Math.log2(2 + e.visitCount + 2 * e.typedCount) * recency
}

export function urlKeyOf(url: string): string {
  return url
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^www\./i, '')
    .toLowerCase()
}

export function hostOf(url: string): { host: string; origin: string } | undefined {
  try {
    const u = new URL(url)
    if (!u.host) return undefined
    return { host: u.host.toLowerCase().replace(/^www\./, ''), origin: `${u.protocol}//${u.host.toLowerCase()}` }
  } catch {
    return undefined
  }
}

/** Only real pages are recorded. */
export function isRecordable(url: string): boolean {
  return /^(https?|file):/i.test(url) && url.length <= 4096
}

/** Lowercase, whitespace-separated query terms. */
export function queryTerms(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean)
}

export class HistoryStore {
  private map = new Map<string, IndexedEntry>()
  private hosts = new Map<string, HostInfo>()
  private listCache: IndexedEntry[] | null = null
  private hostCache: HostInfo[] | null = null
  private visitCache: { e: IndexedEntry; at: number }[] | null = null
  private pending: string[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private writing: Promise<void> | undefined
  private loadPromise: Promise<void> | undefined
  private loaded = false
  /** Increments on every change; lets callers cache derived data. */
  version = 0

  constructor(
    readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  get isLoaded(): boolean {
    return this.loaded
  }

  get size(): number {
    return this.map.size
  }

  /** Reads and compacts the log (once). Safe to call repeatedly. */
  load(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.doLoad()
    return this.loadPromise
  }

  /** Records a visit. `typed` marks a URL typed or chosen in the command bar. */
  record(url: string, opts: { title?: string; typed?: boolean; at?: number } = {}): void {
    if (!isRecordable(url)) return
    const at = opts.at ?? this.now()
    const rec: LogRecord = opts.typed ? { t: 'v', u: url, at, ty: 1 } : { t: 'v', u: url, at }
    this.apply(rec)
    this.write(rec)
    if (opts.title) this.setTitle(url, opts.title)
  }

  setTitle(url: string, title: string): void {
    const e = this.map.get(url)
    const ti = title.trim().slice(0, MAX_TITLE)
    if (!e || !ti || e.title === ti) return
    const rec: LogRecord = { t: 'ti', u: url, ti }
    this.apply(rec)
    this.write(rec)
  }

  setFavicon(url: string, favicon: string): void {
    const e = this.map.get(url)
    if (!e || e.favicon === favicon || favicon.length > MAX_FAVICON) return
    const rec: LogRecord = { t: 'fi', u: url, fi: favicon }
    this.apply(rec)
    this.write(rec)
  }

  /** Deletes every visit to a URL. */
  async delete(url: string): Promise<void> {
    await this.load()
    if (!this.map.has(url)) return
    const rec: LogRecord = { t: 'd', u: url }
    this.apply(rec)
    this.write(rec)
  }

  /** Deletes visits in [from, to). */
  async clear(from = 0, to = Number.MAX_SAFE_INTEGER): Promise<void> {
    await this.load()
    const rec: LogRecord = { t: 'c', from, to }
    this.apply(rec)
    this.write(rec)
  }

  get(url: string): IndexedEntry | undefined {
    return this.map.get(url)
  }

  /** Every entry (stable array until the next change). */
  entries(): readonly IndexedEntry[] {
    if (!this.listCache) this.listCache = [...this.map.values()]
    return this.listCache
  }

  /** Visits aggregated by host (stable array until the next change). */
  hostList(): readonly HostInfo[] {
    if (!this.hostCache) this.hostCache = [...this.hosts.values()]
    return this.hostCache
  }

  /** Entries whose title or URL contain every term, by frecency. */
  search(text: string, limit = 50): HistoryEntry[] {
    const terms = queryTerms(text)
    const now = this.now()
    const matches = this.entries().filter((e) => terms.every((t) => e.titleLower.includes(t) || e.urlKey.includes(t)))
    return matches
      .map((e) => ({ e, f: frecency(e, now) }))
      .sort((a, b) => b.f - a.f || b.e.lastVisit - a.e.lastVisit)
      .slice(0, limit)
      .map(({ e }) => toEntry(e))
  }

  /** Visits newest first, optionally filtered, before a time (exclusive), for the History view. */
  visits(opts: { text?: string; before?: number; limit?: number } = {}): HistoryVisit[] {
    if (!this.visitCache) {
      const all: { e: IndexedEntry; at: number }[] = []
      for (const e of this.map.values()) for (const at of e.visits) all.push({ e, at })
      all.sort((a, b) => b.at - a.at)
      this.visitCache = all
    }
    const terms = queryTerms(opts.text ?? '')
    const before = opts.before ?? Number.POSITIVE_INFINITY
    const limit = opts.limit ?? 100
    const out: HistoryVisit[] = []
    for (const { e, at } of this.visitCache) {
      if (at >= before) continue
      if (terms.length && !terms.every((t) => e.titleLower.includes(t) || e.urlKey.includes(t))) continue
      out.push({ url: e.url, title: e.title, favicon: e.favicon, at })
      if (out.length >= limit) break
    }
    return out
  }

  /** Waits for queued appends (tests and orderly shutdown). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    while (this.writing) await this.writing
    if (this.loaded && this.pending.length) {
      this.writing = this.writeBatch()
      await this.writing
    }
  }

  /** Writes queued records synchronously (app quit). */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (!this.pending.length) return
    // Before load finished, the log still holds only older data: appending is safe.
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      appendFileSync(this.file, `${this.pending.join('\n')}\n`)
      this.pending = []
    } catch (err) {
      console.error('[history] could not save history:', err)
    }
  }

  // ---- internals ----

  private async doLoad(): Promise<void> {
    let text = ''
    try {
      text = await readFile(this.file, 'utf8')
    } catch {
      // No history yet.
    }
    // Replay the log under whatever was recorded while it was being read.
    const live = this.map
    this.map = new Map()
    this.hosts = new Map()
    for (const line of text.split('\n')) {
      if (!line) continue
      let rec: LogRecord
      try {
        rec = JSON.parse(line) as LogRecord
      } catch {
        continue
      }
      this.apply(rec)
    }
    for (const e of live.values()) this.mergeLive(e)
    this.trim()
    this.rebuildHosts()
    this.changed()
    // Compact: the snapshot includes every pending record, so they are not appended again.
    const snapshot = [...this.map.values()].map((e) => JSON.stringify(compactRecord(e))).join('\n')
    const carried = this.pending
    this.pending = []
    try {
      await mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      await writeFile(tmp, snapshot ? `${snapshot}\n` : '')
      await rename(tmp, this.file)
    } catch (err) {
      console.error('[history] compaction failed:', err)
      this.pending = [...carried, ...this.pending]
    }
    this.loaded = true
    if (this.pending.length) this.scheduleFlush()
  }

  private write(rec: LogRecord): void {
    this.pending.push(JSON.stringify(rec))
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (!this.loaded || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, FLUSH_DELAY_MS)
  }

  private async writeBatch(): Promise<void> {
    const lines = this.pending
    this.pending = []
    try {
      await mkdir(dirname(this.file), { recursive: true })
      await appendFile(this.file, `${lines.join('\n')}\n`)
    } catch (err) {
      console.error('[history] could not append to history:', err)
      this.pending = [...lines, ...this.pending]
    } finally {
      this.writing = undefined
    }
  }

  private changed(): void {
    this.version++
    this.listCache = null
    this.hostCache = null
    this.visitCache = null
  }

  private entry(url: string, at: number): IndexedEntry {
    let e = this.map.get(url)
    if (!e) {
      e = {
        url,
        title: '',
        visitCount: 0,
        typedCount: 0,
        firstVisit: at,
        lastVisit: at,
        visits: [],
        titleLower: '',
        urlKey: urlKeyOf(url),
        host: hostOf(url)?.host ?? '',
      }
      this.map.set(url, e)
    }
    return e
  }

  private apply(rec: LogRecord): void {
    switch (rec.t) {
      case 'v': {
        if (typeof rec.u !== 'string' || typeof rec.at !== 'number') return
        const e = this.entry(rec.u, rec.at)
        e.visitCount++
        if (rec.ty) e.typedCount++
        e.firstVisit = Math.min(e.firstVisit, rec.at)
        e.lastVisit = Math.max(e.lastVisit, rec.at)
        pushVisit(e.visits, rec.at)
        this.countHost(e, 1, rec.ty ? 1 : 0, rec.at)
        break
      }
      case 'ti': {
        const e = this.map.get(rec.u)
        if (!e || typeof rec.ti !== 'string') return
        e.title = rec.ti
        e.titleLower = rec.ti.toLowerCase()
        break
      }
      case 'fi': {
        const e = this.map.get(rec.u)
        if (!e || typeof rec.fi !== 'string') return
        e.favicon = rec.fi
        break
      }
      case 'd':
        if (!this.map.delete(rec.u)) return
        this.rebuildHosts()
        break
      case 'c':
        this.clearRange(rec.from, rec.to)
        this.rebuildHosts()
        break
      case 'e': {
        if (typeof rec.u !== 'string' || !Array.isArray(rec.v)) return
        const visits = rec.v.filter((n) => typeof n === 'number').sort((a, b) => a - b)
        const e = this.entry(rec.u, rec.fv)
        e.title = rec.ti ?? ''
        e.titleLower = e.title.toLowerCase()
        e.favicon = rec.fi
        e.visitCount = Math.max(rec.vc, visits.length)
        e.typedCount = rec.tc ?? 0
        e.firstVisit = rec.fv ?? visits[0] ?? 0
        e.lastVisit = visits[visits.length - 1] ?? rec.fv ?? 0
        e.visits = visits.slice(-MAX_VISITS_PER_ENTRY)
        this.countHost(e, e.visitCount, e.typedCount, e.lastVisit)
        break
      }
      default:
        return
    }
    this.changed()
  }

  /** Merges an entry recorded before the log finished loading (it is newer than the log). */
  private mergeLive(live: IndexedEntry): void {
    const e = this.entry(live.url, live.firstVisit)
    e.visitCount += live.visitCount
    e.typedCount += live.typedCount
    e.firstVisit = Math.min(e.firstVisit, live.firstVisit)
    e.lastVisit = Math.max(e.lastVisit, live.lastVisit)
    for (const at of live.visits) pushVisit(e.visits, at)
    if (live.title) {
      e.title = live.title
      e.titleLower = live.titleLower
    }
    if (live.favicon) e.favicon = live.favicon
  }

  private clearRange(from: number, to: number): void {
    for (const [url, e] of this.map) {
      if (e.lastVisit < from || e.firstVisit >= to) continue
      if (from <= e.firstVisit && to > e.lastVisit) {
        this.map.delete(url)
        continue
      }
      const kept = e.visits.filter((at) => at < from || at >= to)
      const removed = e.visits.length - kept.length
      if (kept.length === 0) {
        this.map.delete(url)
        continue
      }
      e.visits = kept
      e.visitCount = Math.max(kept.length, e.visitCount - removed)
      e.firstVisit = Math.min(...kept, e.firstVisit < from ? e.firstVisit : Number.POSITIVE_INFINITY)
      e.lastVisit = kept[kept.length - 1] as number
    }
  }

  private trim(): void {
    if (this.map.size <= MAX_ENTRIES) return
    const keep = [...this.map.values()].sort((a, b) => b.lastVisit - a.lastVisit).slice(0, MAX_ENTRIES)
    this.map = new Map(keep.map((e) => [e.url, e]))
  }

  private countHost(e: IndexedEntry, visits: number, typed: number, at: number): void {
    const info = hostOf(e.url)
    if (!info) return
    const h = this.hosts.get(info.host)
    if (!h) {
      this.hosts.set(info.host, {
        host: info.host,
        origin: info.origin,
        visitCount: visits,
        typedCount: typed,
        lastVisit: at,
      })
      return
    }
    h.visitCount += visits
    h.typedCount += typed
    if (at >= h.lastVisit) {
      h.lastVisit = at
      h.origin = info.origin
    }
  }

  private rebuildHosts(): void {
    this.hosts = new Map()
    for (const e of this.map.values()) this.countHost(e, e.visitCount, e.typedCount, e.lastVisit)
  }
}

function pushVisit(visits: number[], at: number): void {
  if (visits.length === 0 || at >= (visits[visits.length - 1] as number)) visits.push(at)
  else {
    let i = visits.length - 1
    while (i > 0 && (visits[i - 1] as number) > at) i--
    visits.splice(i, 0, at)
  }
  if (visits.length > MAX_VISITS_PER_ENTRY) visits.splice(0, visits.length - MAX_VISITS_PER_ENTRY)
}

function compactRecord(e: IndexedEntry): LogRecord {
  return {
    t: 'e',
    u: e.url,
    ti: e.title,
    ...(e.favicon ? { fi: e.favicon } : {}),
    vc: e.visitCount,
    tc: e.typedCount,
    fv: e.firstVisit,
    v: e.visits,
  }
}

export function toEntry(e: IndexedEntry): HistoryEntry {
  return {
    url: e.url,
    title: e.title,
    favicon: e.favicon,
    visitCount: e.visitCount,
    typedCount: e.typedCount,
    firstVisit: e.firstVisit,
    lastVisit: e.lastVisit,
  }
}
