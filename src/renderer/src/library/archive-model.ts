import type { ArchivePage, ArchiveQuery, ArchiveRow } from '../../../shared/commands/archive'

/** Entries fetched per request. */
export const PAGE_SIZE = 100

export type ArchiveFilters = Required<Pick<ArchiveQuery, 'text' | 'source' | 'profileId'>> &
  Pick<ArchiveQuery, 'spaceId' | 'closedBy'>

export interface ArchiveListData {
  /** The filters these rows answer. */
  key: string
  /** Archive version the pages come from (they all line up). */
  version: number
  total: number
  days: [number, number][]
  /** Fetched pages of rows, by page index. */
  pages: ReadonlyMap<number, ArchiveRow[]>
  /** Nothing has answered these filters yet. */
  loading: boolean
}

const EMPTY: ArchiveListData = { key: '', version: -1, total: 0, days: [], pages: new Map(), loading: true }

export const filtersKey = (f: ArchiveFilters): string =>
  JSON.stringify([f.profileId, f.text.trim().toLowerCase(), f.spaceId ?? '', f.source, f.closedBy ?? 'any'])

type Query = (q: ArchiveQuery) => Promise<ArchivePage>

/**
 * The rows the Archive list shows (AR-03, AR-04), fetched a page at a time from `archive.query`.
 *
 * - New filters (each keystroke) fetch the first page (the list goes back to its top); the old
 *   rows stay on screen until the answer arrives, and answers to older filters are dropped.
 * - Scrolling fetches the pages that come into view.
 * - When the Archive changes (`archive.changed`), the pages in view are fetched again and swapped
 *   in together, so the list never mixes two versions.
 */
export class ArchiveListModel {
  data: ArchiveListData = EMPTY
  private filters: ArchiveFilters | undefined
  private listeners = new Set<() => void>()
  /** Bumped by every reload: answers carrying an older token are ignored. */
  private token = 0
  private inflight = new Set<number>()
  private range: [number, number] = [0, PAGE_SIZE - 1]

  /** `query` is `archive.query` (a parameter so the model runs without a window, in unit tests). */
  constructor(private query: Query) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = (): ArchiveListData => this.data

  /** Row at an offset, if its page is here. */
  row(offset: number): ArchiveRow | undefined {
    return this.data.pages.get(Math.floor(offset / PAGE_SIZE))?.[offset % PAGE_SIZE]
  }

  setFilters(filters: ArchiveFilters): void {
    const key = filtersKey(filters)
    const same = this.filters && filtersKey(this.filters) === key
    this.filters = filters
    if (same) return
    // New filters show their list from the top: only the first page is wanted.
    const [first, last] = this.range
    this.range = [0, last - first]
    void this.reload()
  }

  /** The entries on screen changed (offsets, inclusive). */
  setRange(first: number, last: number): void {
    this.range = [first, last]
    this.fetchMissing()
  }

  /** The Archive changed: fetch what is shown again (unless it is that version already). */
  changed(version: number): void {
    if (version !== this.data.version) void this.reload()
  }

  /** Fetches the first page and the pages in view, then shows them together. */
  async reload(): Promise<void> {
    const filters = this.filters
    if (!filters) return
    const token = ++this.token
    this.inflight.clear()
    const wanted = [...new Set([0, ...this.pagesInView()])]
    try {
      const pages = await Promise.all(
        wanted.map((p) => this.query({ ...filters, offset: p * PAGE_SIZE, limit: PAGE_SIZE })),
      )
      if (token !== this.token) return
      const first = pages[0] as ArchivePage
      // A change landed between the requests: ask again (each answer is a consistent version).
      if (pages.some((p) => p.version !== first.version)) {
        void this.reload()
        return
      }
      const map = new Map<number, ArchiveRow[]>()
      for (const [i, p] of wanted.entries()) map.set(p, (pages[i] as ArchivePage).rows)
      this.set({
        key: filtersKey(filters),
        version: first.version,
        total: first.total,
        days: first.days,
        pages: map,
        loading: false,
      })
      this.fetchMissing()
    } catch (err) {
      if (token === this.token) console.error('[library] archive query failed', err)
    }
  }

  private pagesInView(): number[] {
    const [first, last] = this.range
    const out: number[] = []
    const lastPage = Math.max(0, Math.ceil(this.data.total / PAGE_SIZE) - 1)
    for (let p = Math.floor(first / PAGE_SIZE); p <= Math.floor(last / PAGE_SIZE) && p <= lastPage; p++) out.push(p)
    return out
  }

  private fetchMissing(): void {
    const filters = this.filters
    if (!filters || this.data.key !== filtersKey(filters)) return
    const token = this.token
    for (const p of this.pagesInView()) {
      if (this.data.pages.has(p) || this.inflight.has(p)) continue
      this.inflight.add(p)
      this.query({ ...filters, offset: p * PAGE_SIZE, limit: PAGE_SIZE })
        .then((page) => {
          if (token !== this.token) return
          this.inflight.delete(p)
          if (page.version !== this.data.version) {
            void this.reload()
            return
          }
          const pages = new Map(this.data.pages)
          pages.set(p, page.rows)
          this.set({ ...this.data, pages })
        })
        .catch((err) => {
          if (token === this.token) this.inflight.delete(p)
          console.error('[library] archive page failed', err)
        })
    }
  }

  private set(data: ArchiveListData): void {
    this.data = data
    for (const fn of this.listeners) fn()
  }
}
