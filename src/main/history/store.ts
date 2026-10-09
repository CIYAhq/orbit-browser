/**
 * Browsing history for one profile: an append-only JSONL log plus an in-memory
 * index. Pure Node (no Electron), so it is unit-tested directly.
 *
 * File format: one JSON record per line.
 *   {"t":"v","u":url,"at":ms,"ty":1?}          a visit (ty: typed/chosen in the command bar)
 *   {"t":"m","u":url,"ti":title,"fi":icon?}     title/favicon of a URL (coalesced, at most every few seconds)
 *   {"t":"d","u":url}                           delete every visit to a URL
 *   {"t":"c","from":ms,"to":ms}                 delete visits in [from, to)
 *   {"t":"e","u","ti","fi","vc","tc","fv","v"}  compacted entry
 *   {"t":"h","merged":[token]}                  snapshot header: side files already merged into it
 * ("ti"/"fi" records from earlier builds are still read.)
 *
 * Safety:
 * - The log is read as a stream, so its size never hits the string limit.
 * - Only a missing file counts as "no history". Any other read error leaves the
 *   main log untouched: the store keeps working in memory and appends to a side
 *   file (`<file>.side`) that the next good load merges. Before a snapshot merges
 *   it, the side file is renamed to `<file>.side.<token>` and the snapshot names
 *   that token, so a crash between the rename and the cleanup never counts it twice.
 * - Compaction (snapshot to a temp file, fsync, rename, fsync the directory) runs
 *   at load when the log isn't compact yet, and in the background once appended
 *   bytes pass max(compactBytes, last snapshot size). Records that arrive during a
 *   compaction are written after it; a quit in the middle writes them to the side file.
 * - Title and favicon changes stay in memory and are written as one coalesced
 *   record per URL; `data:` favicons are never written.
 */
import { appendFileSync, createReadStream, mkdirSync, renameSync, rmSync } from 'node:fs'
import { appendFile, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { HistoryEntry, HistoryVisit } from '../../shared/commands/history'

/** Visit timestamps kept per URL (the count keeps growing; older times are dropped). */
export const MAX_VISITS_PER_ENTRY = 20
/** Entries kept (most recently visited first). */
export const MAX_ENTRIES = 50_000
const MAX_TITLE = 400
/** Favicons written to disk: http(s) URLs up to this length (data: icons stay in memory). */
const MAX_SAVED_FAVICON = 512
/** Favicons kept in memory. */
const MAX_FAVICON = 2048
const FLUSH_DELAY_MS = 250
const DAY = 86_400_000

/** A history entry plus search fields, kept in sync by the store. Treat as read-only. */
export interface IndexedEntry extends HistoryEntry {
  /** Visit times, oldest first (at most MAX_VISITS_PER_ENTRY). */
  visits: number[]
  titleLower: string
  /** Lowercased URL without scheme and leading "www." (e.g. "github.com/orbit"). */
  urlKey: string
  /** Lowercased host with port, without "www." (e.g. "github.com", "localhost:3000"). */
  host: string
  /** Scheme and host as visited, e.g. "https://www.github.com" ('' when the URL has no host). */
  origin: string
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

export interface HistoryStoreOptions {
  now?: () => number
  /** Background compaction once appended bytes pass max(this, last snapshot size). Default 1 MiB. */
  compactBytes?: number
  /** Title/favicon changes are written at most this often per store. Default 5 s. */
  metaDelayMs?: number
}

type LogRecord =
  | { t: 'v'; u: string; at: number; ty?: 1 }
  | { t: 'm'; u: string; ti?: string; fi?: string }
  | { t: 'ti'; u: string; ti: string }
  | { t: 'fi'; u: string; fi: string }
  | { t: 'd'; u: string }
  | { t: 'c'; from: number; to: number }
  | { t: 'e'; u: string; ti: string; fi?: string; vc: number; tc: number; fv: number; v: number[] }
  | { t: 'h'; merged: string[] }

type Phase = 'unloaded' | 'loading' | 'ready' | 'side-only'

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

/** True when two URLs differ at most in their fragment. */
export function sameDocument(a: string | undefined, b: string): boolean {
  if (!a) return false
  const strip = (u: string) => {
    const i = u.indexOf('#')
    return i >= 0 ? u.slice(0, i) : u
  }
  return strip(a) === strip(b)
}

/** Lowercase, whitespace-separated query terms. */
export function queryTerms(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean)
}

function savedFavicon(icon: string | undefined): string | undefined {
  return icon && icon.length <= MAX_SAVED_FAVICON && /^https?:/i.test(icon) ? icon : undefined
}

export class HistoryStore {
  private map = new Map<string, IndexedEntry>()
  private hosts = new Map<string, HostInfo>()
  private listCache: IndexedEntry[] | null = null
  private hostCache: HostInfo[] | null = null
  private visitCache: { e: IndexedEntry; at: number }[] | null = null
  private pending: string[] = []
  private dirtyMeta = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private metaTimer: ReturnType<typeof setTimeout> | undefined
  private writing: Promise<void> | undefined
  private loadPromise: Promise<void> | undefined
  private phase: Phase = 'unloaded'
  private compacting = false
  /** The profile was deleted: nothing is written any more. */
  private dropped = false
  /** Side files (`<file>.side.<token>`) replayed at load and not yet in a snapshot. */
  private sideTokens: string[] = []
  /** The plain side file had records at load (it is renamed into a token at the next snapshot). */
  private sidePending = false
  private bytesSinceSnapshot = 0
  private snapshotBytes = 0
  private readonly now: () => number
  private readonly compactBytes: number
  private readonly metaDelayMs: number
  /** Increments on every change; lets callers cache derived data. */
  version = 0

  constructor(
    readonly file: string,
    opts: HistoryStoreOptions = {},
  ) {
    this.now = opts.now ?? Date.now
    this.compactBytes = opts.compactBytes ?? 1024 * 1024
    this.metaDelayMs = opts.metaDelayMs ?? 5000
  }

  /** Where records go when the main log can't be read or is being replaced. */
  get sideFile(): string {
    return `${this.file}.side`
  }

  get isLoaded(): boolean {
    return this.phase === 'ready' || this.phase === 'side-only'
  }

  /** True when the main log could not be read: history works in memory and writes go to the side file. */
  get readOnlyLog(): boolean {
    return this.phase === 'side-only'
  }

  get size(): number {
    return this.map.size
  }

  /** Reads (and if needed compacts) the log once. Safe to call repeatedly. */
  load(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.doLoad()
    return this.loadPromise
  }

  /** Records a visit. `typed` marks a URL typed or chosen in the command bar. */
  record(url: string, opts: { title?: string; typed?: boolean; at?: number } = {}): void {
    if (!isRecordable(url)) return
    const at = opts.at ?? this.now()
    const rec: LogRecord = opts.typed ? { t: 'v', u: url, at, ty: 1 } : { t: 'v', u: url, at }
    this.applyTo(this.map, rec, true)
    this.changed()
    this.write(rec)
    if (opts.title) this.setTitle(url, opts.title)
  }

  setTitle(url: string, title: string): void {
    const e = this.map.get(url)
    const ti = title.trim().slice(0, MAX_TITLE)
    if (!e || !ti || e.title === ti) return
    e.title = ti
    e.titleLower = ti.toLowerCase()
    this.changed()
    this.markMeta(url)
  }

  setFavicon(url: string, favicon: string): void {
    const e = this.map.get(url)
    if (!e || e.favicon === favicon || favicon.length > MAX_FAVICON) return
    const before = savedFavicon(e.favicon)
    e.favicon = favicon
    this.changed()
    // Only icons that are written need a record.
    if (savedFavicon(favicon) !== before) this.markMeta(url)
  }

  /** Deletes every visit to a URL. */
  async delete(url: string): Promise<void> {
    await this.load()
    if (!this.map.has(url)) return
    const rec: LogRecord = { t: 'd', u: url }
    this.applyTo(this.map, rec, true)
    this.dirtyMeta.delete(url)
    this.rebuildHosts()
    this.changed()
    this.write(rec)
  }

  /** Deletes visits in [from, to). */
  async clear(from = 0, to = Number.MAX_SAFE_INTEGER): Promise<void> {
    await this.load()
    const rec: LogRecord = { t: 'c', from, to }
    this.applyTo(this.map, rec, true)
    for (const url of this.dirtyMeta) if (!this.map.has(url)) this.dirtyMeta.delete(url)
    this.rebuildHosts()
    this.changed()
    this.write(rec)
  }

  /** Forgets everything and removes the files (the profile was deleted). */
  async drop(): Promise<void> {
    this.dropped = true
    await this.load().catch(() => undefined)
    while (this.writing) await this.writing
    clearTimeout(this.timer)
    clearTimeout(this.metaTimer)
    this.pending = []
    this.dirtyMeta.clear()
    this.map = new Map()
    this.rebuildHosts()
    this.changed()
    await rm(this.file, { force: true })
    for (const name of await this.sideFiles()) await rm(join(dirname(this.file), name), { force: true })
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

  /** Writes coalesced title/favicon changes and waits for queued appends (tests, orderly shutdown). */
  async flush(): Promise<void> {
    this.flushMeta()
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    while (this.writing) await this.writing
    if (this.canAppend() && this.pending.length) {
      this.writing = this.writeBatch()
      await this.writing
    }
  }

  /** Waits for a running compaction (tests). */
  async idle(): Promise<void> {
    while (this.compacting || this.writing) await new Promise((r) => setTimeout(r, 5))
  }

  /** Writes everything queued synchronously (app quit). Never touches a log that is being read or replaced. */
  flushSync(): void {
    this.flushMeta()
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (!this.pending.length || this.dropped) return
    const target = this.phase === 'ready' && !this.compacting ? this.file : this.sideFile
    try {
      mkdirSync(dirname(target), { recursive: true })
      appendFileSync(target, `${this.pending.join('\n')}\n`)
      this.pending = []
    } catch (err) {
      console.error('[history] could not save history:', err)
    }
  }

  // ---- loading ----

  private async doLoad(): Promise<void> {
    this.phase = 'loading'
    const replay = new Map<string, IndexedEntry>()
    let compact = true
    let mainBytes = 0
    let merged: string[] = []
    try {
      const r = await this.replayFile(this.file, replay)
      mainBytes = r.bytes
      compact = r.compact
      merged = r.merged
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Never treat an unreadable log as empty: leave it alone and keep history in memory.
        console.error(`[history] cannot read ${this.file}; keeping it untouched:`, err)
        this.phase = 'side-only'
        this.scheduleFlush()
        return
      }
    }
    // Side files: tokens the snapshot already contains are leftovers to delete; the rest are replayed.
    let sideLines = 0
    for (const name of await this.sideFiles()) {
      const token = name.slice(basename(this.sideFile).length + 1)
      const path = join(dirname(this.file), name)
      if (token && merged.includes(token)) {
        await rm(path, { force: true })
        continue
      }
      try {
        sideLines += (await this.replayFile(path, replay)).lines
        if (token) this.sideTokens.push(token)
        else this.sidePending = true
      } catch (err) {
        console.error(`[history] cannot read ${path}; keeping it:`, err)
      }
    }
    // Merge what was recorded while the log was read (it is newer).
    const live = this.map
    for (const e of live.values()) mergeLive(replay, e)
    this.map = replay
    const trimmed = this.trim()
    this.rebuildHosts()
    this.changed()
    this.snapshotBytes = mainBytes
    this.phase = 'ready'
    if (!compact || sideLines > 0 || live.size > 0 || trimmed) {
      await this.compact()
    } else if (this.pending.length) {
      this.scheduleFlush()
    }
  }

  /** Names of this store's side files in its directory (`<name>.side` and `<name>.side.<token>`). */
  private async sideFiles(): Promise<string[]> {
    const side = basename(this.sideFile)
    try {
      return (await readdir(dirname(this.file))).filter((n) => n === side || n.startsWith(`${side}.`))
    } catch {
      return []
    }
  }

  /** Replays one log file into `into`, line by line. Rejects with the read error (ENOENT for a missing file). */
  private replayFile(
    path: string,
    into: Map<string, IndexedEntry>,
  ): Promise<{ bytes: number; lines: number; compact: boolean; merged: string[] }> {
    return new Promise((resolve, reject) => {
      const stream = createReadStream(path, { encoding: 'utf8' })
      let bytes = 0
      let lines = 0
      let compact = true
      let failed = false
      const merged: string[] = []
      const fail = (err: Error) => {
        if (failed) return
        failed = true
        reject(err)
      }
      stream.on('error', fail)
      stream.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk as string)
      })
      const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })
      rl.on('error', fail)
      rl.on('line', (line) => {
        if (!line) return
        lines++
        let rec: LogRecord
        try {
          rec = JSON.parse(line) as LogRecord
        } catch {
          compact = false
          return
        }
        if (rec?.t === 'h') {
          if (Array.isArray(rec.merged)) merged.push(...rec.merged.filter((t) => typeof t === 'string'))
          return
        }
        if (rec?.t !== 'e') compact = false
        this.applyTo(into, rec, false)
      })
      rl.on('close', () => {
        if (!failed) resolve({ bytes, lines, compact, merged })
      })
    })
  }

  // ---- writing ----

  private canAppend(): boolean {
    return (this.phase === 'ready' || this.phase === 'side-only') && !this.compacting && !this.dropped
  }

  private write(rec: LogRecord): void {
    if (this.dropped) return
    this.pending.push(JSON.stringify(rec))
    this.scheduleFlush()
  }

  private markMeta(url: string): void {
    if (this.dropped) return
    this.dirtyMeta.add(url)
    if (!this.metaTimer) {
      this.metaTimer = setTimeout(() => {
        this.metaTimer = undefined
        this.flushMeta()
        this.scheduleFlush()
      }, this.metaDelayMs)
    }
  }

  /** One record per URL whose title or saved favicon changed since the last write. */
  private flushMeta(): void {
    clearTimeout(this.metaTimer)
    this.metaTimer = undefined
    for (const url of this.dirtyMeta) {
      const e = this.map.get(url)
      if (!e) continue
      const fi = savedFavicon(e.favicon)
      this.pending.push(JSON.stringify({ t: 'm', u: url, ti: e.title, ...(fi ? { fi } : {}) }))
    }
    this.dirtyMeta.clear()
  }

  private scheduleFlush(): void {
    if (!this.canAppend() || this.timer || !this.pending.length) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, FLUSH_DELAY_MS)
  }

  private async writeBatch(): Promise<void> {
    const lines = this.pending
    this.pending = []
    const data = `${lines.join('\n')}\n`
    const target = this.phase === 'ready' ? this.file : this.sideFile
    try {
      await mkdir(dirname(target), { recursive: true })
      await appendFile(target, data)
      if (target === this.file) this.bytesSinceSnapshot += Buffer.byteLength(data)
    } catch (err) {
      console.error('[history] could not append to history:', err)
      this.pending = [...lines, ...this.pending]
    } finally {
      this.writing = undefined
    }
    if (this.phase === 'ready' && this.bytesSinceSnapshot > Math.max(this.compactBytes, this.snapshotBytes)) {
      setTimeout(() => void this.compact(), 0)
    }
  }

  /**
   * Rewrites the log as one record per URL (temp file, fsync, rename, fsync the directory).
   * The snapshot is taken synchronously; records arriving meanwhile are appended afterwards
   * (or, on quit, to a fresh side file). Side files merged at load are named in the snapshot's
   * header and removed once it is in place.
   */
  private async compact(): Promise<void> {
    if (this.compacting || this.phase !== 'ready') return
    this.compacting = true
    clearTimeout(this.timer)
    this.timer = undefined
    while (this.writing) await this.writing
    // Everything in memory, titles included, is in the snapshot.
    this.trim()
    this.dirtyMeta.clear()
    clearTimeout(this.metaTimer)
    this.metaTimer = undefined
    if (this.sidePending) {
      // New quit-time writes must not land in a side file this snapshot already contains.
      const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
      try {
        renameSync(this.sideFile, `${this.sideFile}.${token}`)
        this.sideTokens.push(token)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[history] side file:', err)
      }
      this.sidePending = false
    }
    const tokens = [...this.sideTokens]
    const rows = [...this.map.values()].map((e) => compactRecord(e))
    const carried = this.pending
    this.pending = []
    const tmp = `${this.file}.tmp`
    let written = 0
    try {
      await mkdir(dirname(this.file), { recursive: true })
      const handle = await open(tmp, 'w')
      try {
        const header = tokens.length ? `${JSON.stringify({ t: 'h', merged: tokens })}\n` : ''
        if (header) await handle.write(header)
        written += Buffer.byteLength(header)
        for (let i = 0; i < rows.length; i += 2000) {
          const chunk = `${rows
            .slice(i, i + 2000)
            .map((r) => JSON.stringify(r))
            .join('\n')}\n`
          await handle.write(chunk)
          written += Buffer.byteLength(chunk)
        }
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(tmp, this.file)
      await syncDir(dirname(this.file))
      for (const token of tokens) await rm(`${this.sideFile}.${token}`, { force: true })
      this.sideTokens = this.sideTokens.filter((t) => !tokens.includes(t))
      this.snapshotBytes = written
      this.bytesSinceSnapshot = 0
    } catch (err) {
      console.error('[history] compaction failed:', err)
      this.pending = [...carried, ...this.pending]
      await rm(tmp, { force: true }).catch(() => undefined)
    } finally {
      this.compacting = false
    }
    this.scheduleFlush()
  }

  // ---- index ----

  private changed(): void {
    this.version++
    this.listCache = null
    this.hostCache = null
    this.visitCache = null
  }

  private entry(map: Map<string, IndexedEntry>, url: string, at: number): IndexedEntry {
    let e = map.get(url)
    if (!e) {
      const info = hostOf(url)
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
        host: info?.host ?? '',
        origin: info?.origin ?? '',
      }
      map.set(url, e)
    }
    return e
  }

  /** Applies one record. `live` keeps the host index current (replays rebuild it at the end). */
  private applyTo(map: Map<string, IndexedEntry>, rec: LogRecord, live: boolean): void {
    if (!rec || typeof rec !== 'object') return
    switch (rec.t) {
      case 'v': {
        if (typeof rec.u !== 'string' || typeof rec.at !== 'number') return
        const e = this.entry(map, rec.u, rec.at)
        e.visitCount++
        if (rec.ty) e.typedCount++
        e.firstVisit = Math.min(e.firstVisit, rec.at)
        e.lastVisit = Math.max(e.lastVisit, rec.at)
        pushVisit(e.visits, rec.at)
        if (live) this.countHost(e, 1, rec.ty ? 1 : 0, rec.at)
        return
      }
      case 'm':
      case 'ti':
      case 'fi': {
        const e = map.get(rec.u)
        if (!e) return
        if ('ti' in rec && typeof rec.ti === 'string') {
          e.title = rec.ti
          e.titleLower = rec.ti.toLowerCase()
        }
        if ('fi' in rec && typeof rec.fi === 'string') e.favicon = rec.fi
        return
      }
      case 'd':
        map.delete(rec.u)
        return
      case 'c':
        clearRange(map, rec.from, rec.to)
        return
      case 'e': {
        if (typeof rec.u !== 'string' || !Array.isArray(rec.v)) return
        const visits = rec.v.filter((n) => typeof n === 'number').sort((a, b) => a - b)
        const e = this.entry(map, rec.u, rec.fv ?? visits[0] ?? 0)
        // Additive, so an entry seen before (or recorded live) keeps its counts.
        e.title = rec.ti ?? e.title
        e.titleLower = e.title.toLowerCase()
        if (rec.fi) e.favicon = rec.fi
        e.visitCount += Math.max(rec.vc ?? 0, visits.length)
        e.typedCount += rec.tc ?? 0
        e.firstVisit = Math.min(e.firstVisit, rec.fv ?? visits[0] ?? e.firstVisit)
        e.lastVisit = Math.max(e.lastVisit, visits[visits.length - 1] ?? rec.fv ?? 0)
        for (const at of visits) pushVisit(e.visits, at)
        return
      }
      default:
        return
    }
  }

  /** Keeps the MAX_ENTRIES most recently visited entries. Returns whether anything was dropped. */
  private trim(): boolean {
    if (this.map.size <= MAX_ENTRIES) return false
    const keep = [...this.map.values()].sort((a, b) => b.lastVisit - a.lastVisit).slice(0, MAX_ENTRIES)
    this.map = new Map(keep.map((e) => [e.url, e]))
    this.rebuildHosts()
    this.changed()
    return true
  }

  private countHost(e: IndexedEntry, visits: number, typed: number, at: number): void {
    if (!e.host) return
    const h = this.hosts.get(e.host)
    if (!h) {
      this.hosts.set(e.host, { host: e.host, origin: e.origin, visitCount: visits, typedCount: typed, lastVisit: at })
      return
    }
    h.visitCount += visits
    h.typedCount += typed
    if (at >= h.lastVisit) {
      h.lastVisit = at
      h.origin = e.origin
    }
  }

  private rebuildHosts(): void {
    this.hosts = new Map()
    for (const e of this.map.values()) this.countHost(e, e.visitCount, e.typedCount, e.lastVisit)
  }
}

/** Merges an entry recorded while the log was being read (it is newer than the log). */
function mergeLive(into: Map<string, IndexedEntry>, live: IndexedEntry): void {
  const e = into.get(live.url)
  if (!e) {
    into.set(live.url, live)
    return
  }
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

/**
 * Removes visits in [from, to). Only the last MAX_VISITS_PER_ENTRY visit times are known; older
 * visits (before the oldest known one) survive when the entry was first visited before `from`.
 */
function clearRange(map: Map<string, IndexedEntry>, from: number, to: number): void {
  for (const [url, e] of map) {
    if (e.lastVisit < from || e.firstVisit >= to) continue
    const kept = e.visits.filter((at) => at < from || at >= to)
    const untracked = Math.max(0, e.visitCount - e.visits.length)
    const olderSurvive = untracked > 0 && e.firstVisit < from
    if (kept.length === 0 && !olderSurvive) {
      map.delete(url)
      continue
    }
    e.visits = kept
    e.visitCount = kept.length + (olderSurvive ? untracked : 0)
    e.lastVisit = kept.length ? (kept[kept.length - 1] as number) : e.firstVisit
    if (!olderSurvive) e.firstVisit = kept[0] as number
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
  const fi = savedFavicon(e.favicon)
  return {
    t: 'e',
    u: e.url,
    ti: e.title,
    ...(fi ? { fi } : {}),
    vc: e.visitCount,
    tc: e.typedCount,
    fv: e.firstVisit,
    v: e.visits,
  }
}

/** Makes a rename durable (no-op where directories can't be opened, e.g. Windows). */
async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // not supported here
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

/** Removes a store's files synchronously (tests). */
export function removeHistoryFiles(file: string): void {
  rmSync(file, { force: true })
  rmSync(`${file}.side`, { force: true })
}
