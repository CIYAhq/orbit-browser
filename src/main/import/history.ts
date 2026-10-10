import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { BrowserKind, ImportProgressItem, StarterSuggestion } from '../../shared/commands/import'
import type { ProfileId } from '../../shared/state'
import type { HistoryService } from '../history'
import { hostOf, type ImportedPage, isRecordable, MAX_ENTRIES, MAX_VISITS_PER_ENTRY } from '../history/store'
import type { FoundProfile, FoundSource } from './browsers'
import { LockedError, type Scratch, withDatabase, withScratch } from './copy'
import type { ImportJobs, Job, Task } from './jobs'

/**
 * Other browsers' history (IM-07): Chromium's `History`, Firefox's `places.sqlite` and Safari's
 * `History.db`, read from copies a chunk of pages at a time with a turn of the event loop between,
 * so a large history never holds up the main process. Each page brings its title, its visit and
 * typed counts, and its newest visit times. It goes into the target profile's history (never tabs).
 */

/** Rows per read and pages per addition: a few milliseconds of work each. */
export const HISTORY_CHUNK = 1000
/** Rows per step of a count. */
const COUNT_CHUNK = 10_000

/**
 * How a browser's history tables are read. Every query covers one window of rows by id, so none
 * takes long however large the file. Times come out of SQL in Unix ms (Chromium's don't fit a double).
 */
export interface HistorySql {
  /** The file in a profile's folder. */
  file: string
  /** The table of pages, and which of its rows are pages Orbit can import. */
  table: string
  where: string
  /** A page's id, url, title, vc (visits), tc (typed) and last (ms). */
  columns: string
  /** Visits to the pages whose ids are in (?, ?]: id, at (ms), typed (1 or 0), title. */
  visits: string
}

/** Web pages only: a browser's own pages and scripts aren't history Orbit can open. */
const WEB = (col: string) => `(${col} LIKE 'http:%' OR ${col} LIKE 'https:%' OR ${col} LIKE 'file:%')`

/** Chromium's clock: microseconds since 1601. */
const CHROMIUM_MS = (col: string) => `(${col} / 1000 - 11644473600000)`

const CHROMIUM: HistorySql = {
  file: 'History',
  table: 'urls',
  where: `hidden = 0 AND last_visit_time > 0 AND ${WEB('url')}`,
  columns: `id, url, title, visit_count AS vc, typed_count AS tc, ${CHROMIUM_MS('last_visit_time')} AS last`,
  // A frame's load (a subframe transition) isn't a page the user visited.
  visits: `SELECT url AS id, ${CHROMIUM_MS('visit_time')} AS at, (transition & 255) = 1 AS typed, NULL AS title
    FROM visits WHERE url > ? AND url <= ? AND (transition & 255) NOT IN (3, 4)`,
}

const FIREFOX: HistorySql = {
  file: 'places.sqlite',
  table: 'moz_places',
  where: `hidden = 0 AND visit_count > 0 AND ${WEB('url')}`,
  columns: 'id, url, title, visit_count AS vc, typed AS tc, last_visit_date / 1000 AS last',
  // Embedded and framed loads and downloads aren't pages the user visited; type 2 is typed.
  visits: `SELECT place_id AS id, visit_date / 1000 AS at, visit_type = 2 AS typed, NULL AS title
    FROM moz_historyvisits WHERE place_id > ? AND place_id <= ? AND visit_type NOT IN (4, 7, 8)`,
}

const SAFARI: HistorySql = {
  file: 'History.db',
  table: 'history_items',
  where: WEB('url'),
  columns: 'id, url, NULL AS title, visit_count AS vc, 0 AS tc, NULL AS last',
  // Safari's clock: seconds since 2001. It keeps titles per visit.
  visits: `SELECT history_item AS id, CAST(ROUND((visit_time + 978307200) * 1000) AS INTEGER) AS at, 0 AS typed, title
    FROM history_visits WHERE history_item > ? AND history_item <= ?`,
}

export function historySql(browser: BrowserKind): HistorySql {
  return browser === 'firefox' ? FIREFOX : browser === 'safari' ? SAFARI : CHROMIUM
}

/** The table's rows by id, `size` at a time, as (after, last] windows, with a turn of the event loop after each. */
async function* windows(db: DatabaseSync, sql: HistorySql, size: number): AsyncGenerator<[number, number]> {
  const next = db.prepare(`SELECT MAX(id) AS last FROM (SELECT id FROM ${sql.table} WHERE id > ? ORDER BY id LIMIT ?)`)
  let after = Number.MIN_SAFE_INTEGER
  for (;;) {
    const last = (next.get(after, size) as { last?: unknown } | undefined)?.last
    if (typeof last !== 'number') return
    yield [after, last]
    after = last
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/** How many pages a history holds that Orbit can import (IM-03's count), counted a window at a time. */
export async function countHistory(db: DatabaseSync, sql: HistorySql): Promise<number> {
  const count = db.prepare(`SELECT COUNT(*) AS n FROM ${sql.table} WHERE id > ? AND id <= ? AND ${sql.where}`)
  let n = 0
  for await (const [after, last] of windows(db, sql, COUNT_CHUNK)) {
    n += Number((count.get(after, last) as { n?: unknown } | undefined)?.n) || 0
  }
  return n
}

interface PageRow {
  id: number
  url: unknown
  title: unknown
  vc: unknown
  tc: unknown
  last: unknown
}

interface VisitRow {
  id: number
  at: unknown
  typed: unknown
  title: unknown
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'bigint' ? Number(v) : 0)
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** A page and its visits as the history store takes them; undefined for one Orbit can't keep. */
function toPage(row: PageRow, visits: readonly VisitRow[]): ImportedPage | undefined {
  const url = text(row.url)
  if (!isRecordable(url)) return undefined
  const times: number[] = []
  let typed = 0
  const own = text(row.title)
  let title = own
  let titleAt = Number.NEGATIVE_INFINITY
  for (const v of visits) {
    const at = Math.round(num(v.at))
    if (at <= 0) continue
    times.push(at)
    if (num(v.typed)) typed++
    // Safari keeps a title per visit: the newest one names the page.
    const t = own ? '' : text(v.title)
    if (t && at > titleAt) {
      title = t
      titleAt = at
    }
  }
  times.sort((a, b) => b - a)
  // The page's last visit, should the browser have let go of that visit's row.
  const last = Math.round(num(row.last))
  if (last > (times[0] ?? 0)) times.unshift(last)
  if (times.length === 0) return undefined
  const visitCount = Math.max(num(row.vc), times.length)
  return {
    url,
    title,
    visitCount,
    typedCount: Math.min(Math.max(num(row.tc), typed), visitCount),
    visits: times.slice(0, MAX_VISITS_PER_ENTRY),
  }
}

/** Reads a history a window of rows at a time, with a turn of the event loop after each. */
export async function* historyChunks(
  db: DatabaseSync,
  sql: HistorySql,
  size = HISTORY_CHUNK,
): AsyncGenerator<ImportedPage[]> {
  const pages = db.prepare(`SELECT ${sql.columns} FROM ${sql.table} WHERE id > ? AND id <= ? AND ${sql.where}`)
  const visits = db.prepare(sql.visits)
  for await (const [after, last] of windows(db, sql, size)) {
    const byId = new Map<number, VisitRow[]>()
    for (const v of visits.all(after, last) as unknown as VisitRow[]) {
      const list = byId.get(v.id)
      if (list) list.push(v)
      else byId.set(v.id, [v])
    }
    const out: ImportedPage[] = []
    for (const r of pages.all(after, last) as unknown as PageRow[]) {
      const page = toPage(r, byId.get(r.id) ?? [])
      if (page) out.push(page)
    }
    yield out
  }
}

/**
 * The pages visited most recently, as many as a profile's history keeps (MAX_ENTRIES): a larger
 * history is trimmed as it is read, so it never sits in memory whole.
 */
export class NewestPages {
  private list: ImportedPage[] = []
  /** Each page's last visit, beside it (trimming reads numbers, not pages). */
  private lastVisits: number[] = []
  /** Pages left out for being older than the ones kept. */
  older = 0

  constructor(private readonly max = MAX_ENTRIES) {}

  add(pages: readonly ImportedPage[]): void {
    for (const p of pages) {
      this.list.push(p)
      this.lastVisits.push(p.visits[0] ?? 0)
    }
    if (this.list.length >= 2 * this.max) this.trim()
  }

  get size(): number {
    return Math.min(this.list.length, this.max)
  }

  take(): ImportedPage[] {
    this.trim()
    return this.list
  }

  private trim(): void {
    const n = this.list.length
    if (n <= this.max) return
    const sorted = Float64Array.from(this.lastVisits).sort()
    const from = n - this.max
    const cutoff = sorted[from] as number
    // As many pages visited at the cutoff time as fit.
    let ties = 0
    while (from + ties < n && sorted[from + ties] === cutoff) ties++
    const list: ImportedPage[] = []
    const lastVisits: number[] = []
    for (let i = 0; i < n; i++) {
      const at = this.lastVisits[i] as number
      if (at < cutoff || (at === cutoff && ties-- <= 0)) continue
      list.push(this.list[i] as ImportedPage)
      lastVisits.push(at)
    }
    this.list = list
    this.lastVisits = lastVisits
    this.older += n - list.length
  }
}

/**
 * Reads a profile's history (IM-07), handing each chunk of pages to `each`; false when it has none.
 * Stops early when `stop` says so. A file the browser holds throws LockedError (IM-14).
 */
export async function readProfileHistory(
  source: FoundSource,
  profile: FoundProfile,
  scratch: Scratch,
  each: (pages: ImportedPage[]) => void,
  stop: () => boolean = () => false,
): Promise<boolean> {
  const sql = historySql(source.browser)
  const read = await withDatabase(scratch, join(profile.dir, sql.file), async (db) => {
    for await (const pages of historyChunks(db, sql)) {
      each(pages)
      if (stop()) break
    }
    return true
  })
  return read ?? false
}

/**
 * Starter suggestions (IM-16): the sites visited most, each as its most-visited page (its home
 * page when that is a search or other query). The first half are offered as Favorites, the rest
 * as pinned tabs; none is added until accepted.
 */
export function starterSuggestions(pages: readonly ImportedPage[], count = 6): StarterSuggestion[] {
  const sites = new Map<string, { visits: number; top: ImportedPage }>()
  for (const p of pages) {
    const host = /^https?:/i.test(p.url) ? hostOf(p.url)?.host : undefined
    if (!host) continue
    const site = sites.get(host)
    if (!site) sites.set(host, { visits: p.visitCount, top: p })
    else {
      site.visits += p.visitCount
      if (p.visitCount > site.top.visitCount) site.top = p
    }
  }
  return [...sites.entries()]
    .sort(([, a], [, b]) => b.visits - a.visits || (b.top.visits[0] ?? 0) - (a.top.visits[0] ?? 0))
    .slice(0, count)
    .map(([host, { top }], i) => {
      const home = top.url.includes('?') ? `${hostOf(top.url)?.origin}/` : undefined
      return {
        url: home ?? top.url,
        title: (!home && top.title) || host,
        kind: i < Math.ceil(count / 2) ? 'favorite' : 'pinned',
        accepted: false,
      }
    })
}

/** Where history may go: a profile that keeps it (private ones never do). */
export type HistoryTarget = (profileId: ProfileId) => boolean

/**
 * The import's history line (IM-07, IM-14): reads the chosen profiles' history first (Cancel
 * imports nothing), then adds it to each destination profile's history a chunk at a time, and
 * writes it once. Pages already there gain only the visits they lacked (IM-15).
 */
export function historyTask(
  jobs: Pick<ImportJobs, 'changed' | 'addSkips'>,
  service: Pick<HistoryService, 'store'>,
  source: FoundSource,
  profiles: readonly FoundProfile[],
  keeps: HistoryTarget,
): Task {
  const item: ImportProgressItem = { type: 'history', state: 'waiting', done: 0 }
  const read = new Map<string, NewestPages>()
  return {
    item,
    read: async (job: Job) => {
      let locked = false
      let failed = false
      await withScratch(async (scratch) => {
        for (const profile of profiles) {
          if (job.cancelled) return
          const kept = new NewestPages()
          try {
            const found = await readProfileHistory(
              source,
              profile,
              scratch,
              (pages) => {
                kept.add(pages)
                item.done += pages.length
                jobs.changed(job)
              },
              () => job.cancelled,
            )
            if (found && kept.size > 0) read.set(profile.id, kept)
          } catch (err) {
            // Orbit is quitting: the copy was closed and removed (D58).
            if (job.cancelled) return
            // A file the browser holds asks for it to be quit (IM-14); a broken one is left out.
            if (err instanceof LockedError) locked = true
            else {
              failed = true
              console.warn(`[import] couldn’t read ${source.name}’s history:`, (err as Error).message)
            }
          }
        }
      })
      if (locked) {
        const types = job.status.locked?.types ?? []
        job.status.locked = { browser: source.name, types: [...new Set([...types, 'history' as const])] }
      }
      item.total = [...read.values()].reduce((n, kept) => n + kept.size, 0)
      item.done = 0
      // Onboarding's import proposes a few of the sites visited most (IM-16).
      if (job.plan.hold && item.total > 0) {
        job.status.suggestions = starterSuggestions([...read.values()].flatMap((kept) => kept.take()))
      }
      if (item.total === 0) {
        item.state = failed ? 'failed' : 'skipped'
        item.note = locked ? `${source.name} is using it` : failed ? 'It couldn’t be read' : 'Nothing to import'
      }
    },
    add: async (job: Job) => {
      // Each destination profile's pages, from every source profile sent to it.
      const byProfile = new Map<ProfileId, ImportedPage[][]>()
      let older = 0
      let unkept = 0
      for (const [key, kept] of read) {
        const dest = job.destinations.get(key)
        if (!dest) continue
        if (!keeps(dest.profileId)) {
          unkept += kept.size
          continue
        }
        const lists = byProfile.get(dest.profileId) ?? []
        lists.push(kept.take())
        older += kept.older
        byProfile.set(dest.profileId, lists)
      }
      read.clear()
      for (const [profileId, lists] of byProfile) {
        const store = service.store(profileId)
        await store.load()
        for (const pages of lists) {
          for (let from = 0; from < pages.length; from += HISTORY_CHUNK) {
            await new Promise((resolve) => setImmediate(resolve))
            store.importPages(pages.slice(from, from + HISTORY_CHUNK))
            item.done += Math.min(HISTORY_CHUNK, pages.length - from)
            jobs.changed(job)
          }
        }
        await store.finishImport()
      }
      jobs.addSkips(job, [
        {
          what: older === 1 ? 'older page' : 'older pages',
          count: older,
          reason: `History keeps the ${MAX_ENTRIES.toLocaleString('en-US')} most recent pages`,
        },
        { what: unkept === 1 ? 'page' : 'pages', count: unkept, reason: 'A private window keeps no history' },
      ])
    },
  }
}
