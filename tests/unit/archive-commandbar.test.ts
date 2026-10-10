import { describe, expect, it } from 'vitest'
import { type ArchiveDoc, type RankInput, rank } from '../../src/main/commandbar/rank'
import { HistoryStore, urlKeyOf } from '../../src/main/history/store'
import { DEFAULT_SITE_SEARCH } from '../../src/shared/defaults'

const NOW = 1_800_000_000_000
const DAY = 24 * 3600_000

function input(query: string, extra: Partial<RankInput> = {}): RankInput {
  return {
    query,
    mode: 'new-tab',
    now: NOW,
    engine: { name: 'Google', search: 'https://www.google.com/search?q=%s' },
    tabs: [],
    activeTabId: null,
    currentSpaceId: 's-a',
    spaceNames: { 's-a': 'Home' },
    history: [],
    hosts: [],
    archive: [],
    spaces: [{ id: 's-a', name: 'Home', icon: '', nameLower: 'home' }],
    actions: [],
    siteSearches: DEFAULT_SITE_SEARCH,
    ...extra,
  }
}

const doc = (id: string, title: string, url: string, archivedAt: number): ArchiveDoc => ({
  id,
  title,
  url,
  spaceId: 's-a',
  archivedAt,
  titleLower: title.toLowerCase(),
  urlKey: urlKeyOf(url),
})

describe('Archived tabs in the command bar (AR-04, review N3)', () => {
  it('[AR-04] two equally matching archived tabs list the most recently archived first, also when both have history', () => {
    const older = doc('a-old', 'Team report', 'https://a.example/report-x', NOW - 3 * DAY)
    const newer = doc('a-new', 'Team report', 'https://b.example/report-x', NOW - 2 * DAY)
    // The command bar's archive list is newest first.
    const archive = [newer, older]
    const archivedIds = (history: HistoryStore | undefined) =>
      rank(
        input('team report', {
          archive,
          ...(history ? { history: history.entries(), hosts: history.hostList() } : {}),
        }),
      )
        .results.filter((r) => r.kind === 'archived')
        .map((r) => [r.archiveId, r.score])
    // Without history rows.
    const plain = archivedIds(undefined)
    expect(plain.map(([id]) => id)).toEqual(['a-new', 'a-old'])
    expect(plain[0]?.[1]).toBe(plain[1]?.[1])
    // Both pages are in history too, the older one visited more: its history row ranks higher, and
    // the archived rows (preferred over history for the same URL) must not take that order.
    const history = new HistoryStore('/nonexistent/never-written.jsonl', { now: () => NOW })
    for (let i = 0; i < 5; i++) history.record(older.url, { title: older.title, at: NOW - 4 * DAY })
    history.record(newer.url, { title: newer.title, at: NOW - 4 * DAY })
    const withHistory = archivedIds(history)
    expect(withHistory.map(([id]) => id)).toEqual(['a-new', 'a-old'])
    // One row per page: no history row left for either.
    const all = rank(input('team report', { archive, history: history.entries(), hosts: history.hostList() })).results
    expect(all.filter((r) => r.kind === 'history' && (r.url === older.url || r.url === newer.url))).toEqual([])
  })
})
