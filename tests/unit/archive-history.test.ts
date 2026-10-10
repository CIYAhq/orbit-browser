import { describe, expect, it } from 'vitest'
import { historyMenuItems, historyQuery, historyRows } from '../../src/main/archive/history-view'
import type { MainContext } from '../../src/main/context'
import { HistoryStore } from '../../src/main/history/store'
import { menuLabels } from '../../src/main/tabs/menus'
import { dayStartOf, groupDays, HISTORY_AHEAD, HistoryListModel } from '../../src/renderer/src/library/history-model'
import type { LibraryHistoryQuery } from '../../src/shared/commands/archive'
import type { HistoryVisit } from '../../src/shared/commands/history'

const NOW = new Date(2026, 9, 9, 15, 0, 0).getTime()
const HOUR = 3600_000

/** A real history store (in memory) answering the model the way `library.history` does. */
function historyOf(visits: [url: string, title: string, at: number][]) {
  const store = new HistoryStore('/nonexistent/never-written.jsonl', { now: () => NOW })
  for (const [url, title, at] of visits) store.record(url, { title, at })
  const asked: LibraryHistoryQuery[] = []
  const fetch = async (q: LibraryHistoryQuery): Promise<HistoryVisit[]> => {
    asked.push(q)
    const { text, before, limit } = historyQuery(q, 'p-default')
    return store.visits({ text, before, limit })
  }
  return { store, fetch, asked }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('History in the Library (AR-10)', () => {
  it('[AR-10] lists every visit newest first, by local day, a page at a time as the list scrolls', async () => {
    // 30 visits an hour apart: two or three local days.
    const visits: [string, string, number][] = []
    for (let i = 0; i < 30; i++) visits.push([`https://site${i % 7}.test/p${i}`, `Page ${i}`, NOW - i * HOUR])
    const { fetch, asked } = historyOf(visits)
    const model = new HistoryListModel(fetch, 10)
    model.setSearch('p-default', '')
    await settle()
    expect(model.data.rows.map((r) => r.title)).toEqual(Array.from({ length: 10 }, (_, i) => `Page ${i}`))
    expect(model.data.done).toBe(false)
    // Rows near the end come into view: the next page follows on, older visits only.
    model.shown(9)
    await settle()
    model.shown(19)
    await settle()
    model.shown(29)
    await settle()
    expect(model.data.rows.map((r) => r.title)).toEqual(Array.from({ length: 30 }, (_, i) => `Page ${i}`))
    expect(model.data.done).toBe(true)
    expect(asked.every((q) => q.limit === 10)).toBe(true)
    // Day counts add up and follow the local calendar.
    expect(model.data.days.reduce((n, [, c]) => n + c, 0)).toBe(30)
    expect(model.data.days[0]?.[0]).toBe(dayStartOf(NOW))
    expect(new Set(model.data.days.map(([d]) => d)).size).toBe(model.data.days.length)
  })

  it('[AR-10] visits sharing a millisecond across two pages are neither lost nor listed twice', async () => {
    const same = NOW - HOUR
    const visits: [string, string, number][] = []
    for (let i = 0; i < 4; i++) visits.push([`https://new${i}.test/`, `New ${i}`, NOW - i * 1000])
    for (let i = 0; i < 5; i++) visits.push([`https://same${i}.test/`, `Same ${i}`, same])
    visits.push(['https://old.test/', 'Old', same - HOUR])
    const { fetch } = historyOf(visits)
    const model = new HistoryListModel(fetch, 6)
    model.setSearch('p-default', '')
    await settle()
    expect(model.data.rows).toHaveLength(6)
    model.shown(5)
    await settle()
    model.shown(model.data.rows.length - 1)
    await settle()
    const titles = model.data.rows.map((r) => r.title)
    expect(titles).toHaveLength(10)
    expect(new Set(titles).size).toBe(10)
    expect(titles.at(-1)).toBe('Old')
    expect(model.data.done).toBe(true)
  })

  it('[AR-10] search narrows to visits whose title or address has every word; an older answer never wins', async () => {
    const { fetch } = historyOf([
      ['https://news.test/today', 'Morning news', NOW - HOUR],
      ['https://recipes.test/soup', 'Tomato soup', NOW - 2 * HOUR],
      ['https://news.test/sport', 'Sport results', NOW - 3 * HOUR],
    ])
    let release: () => void = () => {}
    const slow = new Promise<void>((r) => {
      release = r
    })
    const model = new HistoryListModel(async (q) => {
      // The first search answers last.
      if (q.text === 'soup') await slow
      return fetch(q)
    })
    model.setSearch('p-default', 'soup')
    model.setSearch('p-default', 'news.test')
    await settle()
    release()
    await settle()
    expect(model.data.rows.map((r) => r.title)).toEqual(['Morning news', 'Sport results'])
    model.setSearch('p-default', 'SPORT results')
    await settle()
    expect(model.data.rows.map((r) => r.title)).toEqual(['Sport results'])
  })

  it('[AR-10] removing a page drops all its visits from the list, also from pages still to come', async () => {
    // 100 visits a minute apart; every fifth is the same page (history keeps its last 20 visits).
    const visits: [string, string, number][] = []
    for (let i = 0; i < 100; i++) {
      visits.push([i % 5 ? `https://once${i}.test/` : 'https://often.test/', `Visit ${i}`, NOW - i * 60_000])
    }
    const { fetch } = historyOf(visits)
    const model = new HistoryListModel(fetch, HISTORY_AHEAD + 5)
    model.setSearch('p-default', '')
    await settle()
    expect(model.data.rows).toHaveLength(HISTORY_AHEAD + 5)
    const often = model.data.rows.filter((r) => r.url === 'https://often.test/').length
    expect(often).toBe(13)
    // The store still has them (main deletes in its own time): the model keeps them out.
    model.remove('https://often.test/')
    expect(model.data.rows.some((r) => r.url === 'https://often.test/')).toBe(false)
    expect(groupDays(model.data.rows)).toEqual(model.data.days)
    // Fewer rows than the look-ahead: the next page came on its own, without the removed page.
    await settle()
    expect(model.data.rows).toHaveLength(80)
    expect(model.data.rows.some((r) => r.url === 'https://often.test/')).toBe(false)
    expect(model.data.done).toBe(true)
    // A visit after the removal shows again.
    const { fetch: later } = historyOf([['https://often.test/', 'Back again', Date.now() + 60_000]])
    const again = new HistoryListModel(later)
    again.remove('https://often.test/')
    again.setSearch('p-default', '')
    await settle()
    expect(again.data.rows.map((r) => r.title)).toEqual(['Back again'])
  })

  it('[AR-10] the request is bounded, icons are the remembered data URLs only, and the row menu removes a page', async () => {
    expect(historyQuery({ limit: 10_000, text: '  ', before: Number.NaN }, 'p-1')).toEqual({
      profileId: 'p-1',
      limit: 500,
    })
    expect(historyQuery({ limit: 0, text: ' cat ' }, 'p-1')).toEqual({ profileId: 'p-1', text: 'cat', limit: 1 })
    const rows = historyRows(
      [
        { url: 'https://a.test/', title: 'A', at: 1, favicon: 'https://a.test/favicon.ico' },
        { url: 'https://b.test/', title: 'B', at: 2, favicon: 'data:image/png;base64,AAAA' },
        { url: 'https://c.test/', title: 'C', at: 3 },
      ],
      (url) => (url.startsWith('https://c.test') ? 'data:image/png;base64,CCCC' : undefined),
    )
    expect(rows.map((r) => r.favicon)).toEqual([undefined, 'data:image/png;base64,AAAA', 'data:image/png;base64,CCCC'])
    const ran: [string, unknown][] = []
    const sent: [string, unknown][] = []
    const ctx = {
      commands: {
        run: async (name: string, args: unknown) => {
          ran.push([name, args])
          return 't-1'
        },
      },
    } as unknown as Pick<MainContext, 'commands'>
    const copied: string[] = []
    const items = historyMenuItems(ctx, {
      url: 'https://a.test/',
      profileId: 'p-1',
      windowId: 'w-1',
      send: (channel, payload) => sent.push([channel, payload]),
      copy: (text) => copied.push(text),
    })
    expect(menuLabels(items)).toEqual(['Open in New Tab', 'Open in Background', 'Copy Link', 'Remove from History'])
    const click = (label: string) => {
      const run = items.find((i) => i.label === label)?.click as (() => void) | undefined
      if (!run) throw new Error(`no item ${label}`)
      run()
    }
    click('Remove from History')
    click('Copy Link')
    click('Open in Background')
    await settle()
    expect(ran).toEqual([
      ['history.delete', { profileId: 'p-1', url: 'https://a.test/' }],
      ['tabs.create', { url: 'https://a.test/', activate: false }],
    ])
    expect(copied).toEqual(['https://a.test/'])
    expect(sent).toEqual([
      ['library:toast', { message: 'Copied link' }],
      ['library:history.removed', { url: 'https://a.test/' }],
      ['library:toast', { message: 'Opened in a new tab' }],
    ])
  })
})
