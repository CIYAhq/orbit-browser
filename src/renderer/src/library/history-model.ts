import type { LibraryHistoryQuery } from '../../../shared/commands/archive'
import type { HistoryVisit } from '../../../shared/commands/history'

/** Visits fetched per request. */
export const HISTORY_PAGE = 150
/** The next page is fetched when the rows shown come this close to the end of those here. */
export const HISTORY_AHEAD = 60

export interface HistoryRow extends HistoryVisit {
  /** Unique in the list: the visit's time and page. */
  key: string
}

export interface HistoryListData {
  /** The profile and search these rows answer. */
  key: string
  /** Visits fetched so far, newest first. */
  rows: readonly HistoryRow[]
  /** [start of the local day, visits that day among the rows], newest day first. */
  days: [number, number][]
  /** Every matching visit is here. */
  done: boolean
  /** Nothing has answered this search yet (the rows are the previous search's). */
  loading: boolean
}

const EMPTY: HistoryListData = { key: '', rows: [], days: [], done: false, loading: true }

export const historyKey = (profileId: string, text: string): string =>
  JSON.stringify([profileId, text.trim().toLowerCase()])

/** Start of the local day of a time. */
export function dayStartOf(at: number): number {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Rows (newest first) counted by local day. */
export function groupDays(rows: readonly { at: number }[]): [number, number][] {
  const days: [number, number][] = []
  for (const row of rows) {
    const day = dayStartOf(row.at)
    const last = days[days.length - 1]
    if (last && last[0] === day) last[1]++
    else days.push([day, 1])
  }
  return days
}

type Fetch = (q: LibraryHistoryQuery) => Promise<HistoryVisit[]>

/** Where the next page starts: the oldest visit fetched, and the visits fetched at that millisecond. */
interface Cursor {
  at: number
  keys: Set<string>
  /** A whole page brought nothing new at `at`: the next one starts before that millisecond. */
  skip: boolean
}

const keyOf = (v: HistoryVisit): string => `${v.at}|${v.url}`

/**
 * The rows of the Library's History section (AR-10): visits newest first from `library.history`
 * (the history store's own query), fetched a page at a time as the list scrolls.
 *
 * - A new search (each keystroke) fetches its first page; the old rows stay until it answers, and
 *   answers to older searches are dropped.
 * - Pages follow on with `before`, from just after the oldest visit fetched, leaving out the ones
 *   fetched already: visits that share a millisecond across two pages are neither lost nor listed
 *   twice.
 * - Removing a page drops its rows at once, and its visits up to then from pages still to come
 *   (one fetched before main deleted them); a later visit to it shows again.
 */
export class HistoryListModel {
  data: HistoryListData = EMPTY
  private listeners = new Set<() => void>()
  private search = { profileId: '', text: '' }
  /** Bumped by each new search or reload: answers carrying an older token are ignored. */
  private token = 0
  private fetching = false
  private cursor: Cursor | undefined
  /** Pages removed from history, with when. */
  private removed = new Map<string, number>()

  /** `fetch` is `library.history` (a parameter so the model runs without a window, in unit tests). */
  constructor(
    private fetch: Fetch,
    private pageSize = HISTORY_PAGE,
  ) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = (): HistoryListData => this.data

  /** Shows the visits whose title or address has every word of `text` (all visits when empty). */
  setSearch(profileId: string, text: string): void {
    const key = historyKey(profileId, text)
    if (key === historyKey(this.search.profileId, this.search.text) && this.data.key === key) return
    this.search = { profileId, text: text.trim() }
    void this.reload()
  }

  /** Fetches the first page again (each open of the Library: pages were visited since). */
  async reload(): Promise<void> {
    const token = ++this.token
    const key = historyKey(this.search.profileId, this.search.text)
    if (this.data.key !== key) this.set({ ...this.data, loading: true })
    this.fetching = true
    const visits = await this.fetch(this.query()).catch(() => undefined)
    if (token !== this.token) return
    this.fetching = false
    this.cursor = undefined
    const rows = this.take(visits ?? [])
    this.set({ key, rows, days: groupDays(rows), done: (visits?.length ?? 0) < this.pageSize, loading: false })
  }

  /** The last row on screen (its offset): the next page comes when it nears the end of the rows. */
  shown(lastOffset: number): void {
    if (this.data.done || this.data.loading || this.fetching) return
    if (lastOffset < this.data.rows.length - HISTORY_AHEAD) return
    void this.more()
  }

  /** Every visit to `url` left history (at `at`): its rows go. */
  remove(url: string, at = Date.now()): void {
    this.removed.set(url, Math.max(at, this.removed.get(url) ?? 0))
    if (!this.data.rows.some((r) => r.url === url)) return
    const rows = this.data.rows.filter((r) => r.url !== url)
    this.set({ ...this.data, rows, days: groupDays(rows) })
    if (!this.data.done && !this.data.loading && rows.length < HISTORY_AHEAD) void this.more()
  }

  private async more(): Promise<void> {
    const cursor = this.cursor
    if (!cursor || this.fetching) return
    const token = this.token
    this.fetching = true
    const before = cursor.skip ? cursor.at : cursor.at + 1
    const visits = await this.fetch({ ...this.query(), before }).catch(() => undefined)
    if (token !== this.token) return
    this.fetching = false
    if (!visits) return
    const fresh = this.take(visits)
    const rows = fresh.length ? [...this.data.rows, ...fresh] : this.data.rows
    const done = visits.length < this.pageSize
    this.set({ ...this.data, rows, days: fresh.length ? groupDays(rows) : this.data.days, done })
    // A page of removed pages only adds no rows (so none scroll into view): go on while few show.
    if (!done && rows.length < HISTORY_AHEAD) void this.more()
  }

  /** Rows from a page (newest first), moving the cursor: none fetched before, none of a removed page. */
  private take(visits: readonly HistoryVisit[]): HistoryRow[] {
    const prev = this.cursor
    const out: HistoryRow[] = []
    const seen = new Set<string>()
    let progressed = false
    for (const v of visits) {
      const key = keyOf(v)
      if (seen.has(key) || (prev && v.at === prev.at && prev.keys.has(key))) continue
      seen.add(key)
      progressed = true
      if (!this.cursor || v.at < this.cursor.at) this.cursor = { at: v.at, keys: new Set([key]), skip: false }
      else if (v.at === this.cursor.at) this.cursor.keys.add(key)
      const gone = this.removed.get(v.url)
      if (gone !== undefined && v.at <= gone) continue
      out.push({ ...v, key })
    }
    if (prev && !progressed && visits.length >= this.pageSize) prev.skip = true
    return out
  }

  private query(): LibraryHistoryQuery {
    const { profileId, text } = this.search
    return { ...(profileId ? { profileId } : {}), ...(text ? { text } : {}), limit: this.pageSize }
  }

  private set(data: HistoryListData): void {
    this.data = data
    for (const fn of this.listeners) fn()
  }
}
