import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fieldMatch, INSIDE, initials, PREFIX, WORD } from '../../src/main/commandbar/match'
import {
  type ActionDoc,
  type ArchiveDoc,
  complete,
  displayUrl,
  normKey,
  type RankInput,
  rank,
  type TabDoc,
  tabTarget,
} from '../../src/main/commandbar/rank'
import { actionNeedsTab, SourceCache } from '../../src/main/commandbar/sources'
import { parseSuggestions } from '../../src/main/commandbar/suggest'
import { HistoryStore, hostOf, urlKeyOf } from '../../src/main/history/store'
import { hideImportTabs, releaseImportTabs } from '../../src/main/import/unplaced'
import { makeTab } from '../../src/main/tabs/model'
import { mergeSuggestions, type SearchResult } from '../../src/shared/commands/commandbar'
import { SETTINGS_ACTIONS } from '../../src/shared/commands/settings'
import { createInitialState, DEFAULT_SITE_SEARCH } from '../../src/shared/defaults'
import { fillSearchTemplate, parseInput, topResultUrl } from '../../src/shared/url'

const NOW = 1_800_000_000_000

function tab(id: string, title: string, url: string, extra: Partial<TabDoc> = {}): TabDoc {
  return {
    id,
    title,
    url,
    spaceId: 's-a',
    lastActiveAt: NOW - 60_000,
    section: 'today',
    titleLower: title.toLowerCase(),
    urlKey: urlKeyOf(url),
    host: hostOf(url)?.host ?? '',
    ...extra,
  }
}

function action(id: string, title: string, extra: Partial<ActionDoc> = {}): ActionDoc {
  const titleLower = title.toLowerCase()
  return { id, title, titleLower, keywords: [], initials: initials(titleLower), needsTab: false, ...extra }
}

const ACTIONS: ActionDoc[] = [
  action('tab.togglePin', 'Pin / Unpin Tab', { shortcut: '⌘D', needsTab: true }),
  action('split.add', 'Add Split View', { keywords: ['side by side'], needsTab: true }),
  action('space.new', 'New Space'),
  action('app.settings', 'Settings', { keywords: ['preferences'] }),
  action('devtools.toggle', 'Developer Tools', { needsTab: true }),
]

function input(query: string, extra: Partial<RankInput> = {}): RankInput {
  return {
    query,
    mode: 'new-tab',
    now: NOW,
    engine: { name: 'Google', search: 'https://www.google.com/search?q=%s' },
    tabs: [],
    activeTabId: null,
    currentSpaceId: 's-a',
    spaceNames: { 's-a': 'Home', 's-b': 'Work' },
    history: [],
    hosts: [],
    archive: [],
    spaces: [
      { id: 's-a', name: 'Home', icon: '', nameLower: 'home' },
      { id: 's-b', name: 'Work', icon: '💼', nameLower: 'work' },
    ],
    actions: ACTIONS,
    siteSearches: DEFAULT_SITE_SEARCH,
    ...extra,
  }
}

function historyOf(visits: [string, string, number?][]): HistoryStore {
  const store = new HistoryStore('/nonexistent/never-written.jsonl', { now: () => NOW })
  for (const [url, title, n = 1] of visits) for (let i = 0; i < n; i++) store.record(url, { title, at: NOW - 3600_000 })
  return store
}

describe('matching', () => {
  it('scores prefix > word start > inside', () => {
    expect(fieldMatch('git', 'github.com')).toBe(PREFIX)
    expect(fieldMatch('hub', 'git hub')).toBe(WORD)
    expect(fieldMatch('hub', 'github')).toBe(INSIDE)
    expect(fieldMatch('xyz', 'github')).toBe(0)
    expect(initials('developer tools')).toBe('dt')
  })
})

describe('URL and search parsing', () => {
  it('[CB-08][CB-15] adds https to bare domains and keeps plain words as searches', () => {
    expect(parseInput('example.com')).toEqual({ kind: 'url', url: 'https://example.com/' })
    expect(parseInput('localhost:3000').kind).toBe('url')
    expect(parseInput('orbit').kind).toBe('search')
    expect(parseInput('how to tie').kind).toBe('search')
    expect(parseInput('orbit test', 'duckduckgo').url).toBe('https://duckduckgo.com/?q=orbit+test')
  })

  it('[CB-11] fills site search templates (query string vs path)', () => {
    expect(fillSearchTemplate('https://www.youtube.com/results?search_query=%s', 'cats & dogs')).toBe(
      'https://www.youtube.com/results?search_query=cats+%26+dogs',
    )
    expect(fillSearchTemplate('https://open.spotify.com/search/%s', 'lo fi')).toBe(
      'https://open.spotify.com/search/lo%20fi',
    )
  })

  it('[CB-16] builds first-result URLs only for engines that support it', () => {
    expect(topResultUrl('duckduckgo', 'wikipedia cats')).toBe('https://duckduckgo.com/?q=%5Cwikipedia+cats')
    expect(topResultUrl('google', 'cats')).toBeUndefined()
    expect(topResultUrl('bing', 'cats')).toBeUndefined()
  })

  it('normalizes URLs for dedupe and display', () => {
    expect(normKey('https://www.GitHub.com/')).toBe('github.com')
    expect(normKey('http://github.com/#top')).toBe('github.com')
    expect(displayUrl('https://www.example.com/a/')).toBe('example.com/a')
    expect(displayUrl('http://localhost:3300/page/Docs%3A%20Orbit')).toBe('localhost:3300/page/Docs: Orbit')
    expect(displayUrl('https://x.example/%E0%A4%A')).toBe('x.example/%E0%A4%A')
    // F9: separators, controls and bidi overrides stay escaped (no spoofed row text).
    expect(displayUrl('https://x.example/a%2Fb%3Fc%23d')).toBe('x.example/a%2Fb%3Fc%23d')
    expect(displayUrl('https://x.example/%E2%80%AEtxt.exe')).toBe('x.example/%E2%80%AEtxt.exe')
    expect(displayUrl('https://x.example/caf%C3%A9')).toBe('x.example/café')
  })
})

describe('ranking', () => {
  it('[CB-07][CB-15] puts a web search on top for plain text, naming the engine', () => {
    const r = rank(input('how to tie', { engine: { name: 'DuckDuckGo', search: 'https://duckduckgo.com/?q=%s' } }))
    expect(r.results[0]).toMatchObject({
      kind: 'search',
      subtitle: 'Search DuckDuckGo',
      url: 'https://duckduckgo.com/?q=how+to+tie',
    })
    expect(r.engineName).toBe('DuckDuckGo')
  })

  it('[CB-07][CB-09] puts an open tab on top when its domain starts with the text', () => {
    const tabs = [tab('t-1', 'GitHub', 'https://github.com/'), tab('t-2', 'Digital news', 'https://news.example/')]
    const r = rank(input('git', { tabs }))
    expect(r.results[0]).toMatchObject({ kind: 'tab', tabId: 't-1', hint: 'Switch to tab', label: 'Tab' })
    expect(r.results[1]?.kind).toBe('search')
  })

  it('[CB-09] typing the exact URL of an open tab offers switching to it first', () => {
    const tabs = [tab('t-1', 'Alpha', 'http://localhost:3300/page/Alpha')]
    const r = rank(input('http://localhost:3300/page/Alpha', { tabs }))
    expect(r.results[0]).toMatchObject({ kind: 'tab', tabId: 't-1' })
  })

  it('[CB-09] shows the Space of tabs in other Spaces and split favicons (CB-06)', () => {
    const tabs = [
      tab('t-1', 'Docs', 'https://docs.example/', {
        spaceId: 's-b',
        splitFavicons: ['https://docs.example/f.ico', null],
      }),
    ]
    const r = rank(input('docs', { tabs }))
    expect(r.results[0]).toMatchObject({ kind: 'tab', hint: 'Switch to tab', label: 'Split' })
    expect(r.results[0]?.subtitle).toBe('Work · docs.example')
    expect(r.results[0]?.splitFavicons).toHaveLength(2)
  })

  it("[SV-21][CB-06] an open split is one result with every pane's favicon, for its best-matching pane", () => {
    const split = {
      splitId: 'v-1',
      splitTitle: 'Mail | Docs',
      splitFavicons: ['https://mail.example/f.ico', 'https://docs.example/f.ico'],
    }
    const tabs = [
      tab('t-1', 'Mail', 'https://mail.example/', { ...split, lastActiveAt: NOW - 1_000 }),
      tab('t-2', 'Docs', 'https://docs.example/', { ...split, lastActiveAt: NOW - 2_000 }),
      tab('t-3', 'Docs elsewhere', 'https://docs.example/other'),
    ]
    // Both panes match: one row, labelled as a split, that shows the pane that matched best.
    const docs = rank(input('docs', { tabs })).results.filter((r) => r.kind === 'tab')
    expect(docs.map((r) => r.id)).toEqual(['split:v-1', 'tab:t-3'])
    expect(docs[0]).toMatchObject({ title: 'Mail | Docs', hint: 'Switch to split', label: 'Split', tabId: 't-2' })
    expect(docs[0]?.splitFavicons).toHaveLength(2)
    // A title both panes share: the pane used last.
    const both = rank(input('example', { tabs })).results.filter((r) => r.splitId === 'v-1')
    expect(both).toHaveLength(1)
    expect(both[0]?.tabId).toBe('t-1')
    // The empty state lists it once too.
    const recent = rank(input('', { tabs, mode: 'search-tabs' })).results
    expect(recent.map((r) => r.id)).toEqual(['split:v-1', 'tab:t-3'])
    // While one of its panes is the current tab, the split isn't offered, like the current tab.
    const inSplit = rank(input('docs', { tabs, activeTabId: 't-1' })).results.filter((r) => r.kind === 'tab')
    expect(inSplit.map((r) => r.id)).toEqual(['tab:t-3'])
    // Its pane's exact URL as the top row: still the split, and only once.
    const typed = rank(input('https://docs.example/', { tabs })).results
    expect(typed[0]).toMatchObject({ id: 'split:v-1', tabId: 't-2' })
    expect(typed.filter((r) => r.splitId === 'v-1')).toHaveLength(1)
  })

  it("[SV-21] a split's pages aren't offered again from history or the Archive", () => {
    const split = { splitId: 'v-1', splitTitle: 'Mail | Docs', splitFavicons: [null, null] }
    const tabs = [
      tab('t-1', 'Mail', 'https://mail.example/', split),
      tab('t-2', 'Docs', 'https://docs.example/', split),
      tab('t-3', 'Elsewhere', 'https://else.example/'),
    ]
    const h = historyOf([
      ['https://mail.example/', 'Mail inbox'],
      ['https://docs.example/', 'Docs'],
    ])
    const archive: ArchiveDoc[] = [
      {
        id: 'a-1',
        title: 'Mail',
        url: 'https://mail.example/',
        spaceId: 's-a',
        archivedAt: NOW - 1000,
        titleLower: 'mail',
        urlKey: 'mail.example/',
      },
    ]
    const rows = (q: string, activeTabId?: string) =>
      rank(input(q, { tabs, archive, history: h.entries(), hosts: h.hostList(), activeTabId })).results
    const pages = (q: string, activeTabId?: string) =>
      rows(q, activeTabId).filter((r) => r.kind === 'history' || r.kind === 'archived')
    // Listed as one row: neither pane's page is listed again.
    expect(rows('example').filter((r) => r.splitId === 'v-1')).toHaveLength(1)
    expect(pages('example')).toEqual([])
    // On screen as the current split: neither is offered.
    expect(pages('example', 't-1')).toEqual([])
    // A split that isn't listed (no pane matches "inbox") hides nothing.
    expect(pages('inbox').map((r) => r.url)).toEqual(['https://mail.example/'])
  })

  it('[SV-21][SV-22] a named split shows and matches its name', () => {
    const split = { splitId: 'v-2', splitTitle: 'Research', splitNameLower: 'research', splitFavicons: [null, null] }
    const tabs = [
      tab('t-1', 'Paper', 'https://papers.example/', split),
      tab('t-2', 'Notes', 'https://notes.example/', split),
    ]
    const r = rank(input('resea', { tabs })).results.filter((x) => x.kind === 'tab')
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ id: 'split:v-2', title: 'Research', hint: 'Switch to split' })
  })

  it('[CB-13] runs actions by name with their shortcut; "pin" puts Pin Tab on top', () => {
    const r = rank(input('pin', { activeTabId: 't-1', tabs: [tab('t-1', 'Current', 'https://cur.example/')] }))
    expect(r.results[0]).toMatchObject({ kind: 'action', actionId: 'tab.togglePin', shortcut: '⌘D' })
    expect(rank(input('side by', { activeTabId: 't-1' })).results.some((x) => x.actionId === 'split.add')).toBe(true)
    expect(rank(input('dt', { activeTabId: 't-1' })).results.some((x) => x.actionId === 'devtools.toggle')).toBe(true)
  })

  it('[CB-07] a single letter only matches at the start of a word', () => {
    const tabs = [tab('t-1', 'Reopen closed', 'https://x.example/'), tab('t-2', 'Design', 'https://y.example/')]
    const ids = rank(input('d', { tabs })).results.map((r) => r.id)
    expect(ids).toContain('tab:t-2')
    expect(ids).not.toContain('tab:t-1')
  })

  it('[CB-13][SP-22] offers "Move to" and "Pin to" every other Space for the current tab', () => {
    const r = rank(input('move to', { activeTabId: 't-1', tabs: [tab('t-1', 'Current', 'https://cur.example/')] }))
    expect(r.results.find((x) => x.title === 'Move to Work')).toMatchObject({
      kind: 'action',
      actionId: 'tab.moveToSpace',
      spaceId: 's-b',
      id: 'action:tab.moveToSpace:s-b',
    })
    expect(r.results.some((x) => x.title === 'Move to Home')).toBe(false) // the current Space
    expect(rank(input('pin to work', { activeTabId: 't-1' })).results[0]?.actionId).toBe('tab.pinToSpace')
    expect(rank(input('move to')).results.some((x) => x.actionId === 'tab.moveToSpace')).toBe(false)
  })

  it('[CB-13] hides actions that need a tab when the Space is empty', () => {
    const r = rank(input('pin'))
    expect(r.results.some((x) => x.actionId === 'tab.togglePin')).toBe(false)
  })

  it('[CB-05][CB-06] shows an open tab, an archived tab and a history page, each with its label', () => {
    const tabs = [tab('t-1', 'Budget', 'https://sheets.example/budget')]
    const archive: ArchiveDoc[] = [
      {
        id: 'a-1',
        title: 'Budget 2025',
        url: 'https://old.example/b25',
        spaceId: 's-a',
        archivedAt: NOW - 1000,
        titleLower: 'budget 2025',
        urlKey: 'old.example/b25',
      },
    ]
    const h = historyOf([['https://budget.example/', 'Budget tips']])
    const r = rank(input('budg', { tabs, archive, history: h.entries(), hosts: h.hostList() }))
    const labels = r.results.map((x) => x.label)
    expect(labels).toContain('Tab')
    expect(labels).toContain('Archived')
    expect(labels).toContain('History')
  })

  it('[CB-08] completes a visited domain inline and opens it on Enter', () => {
    const h = historyOf([['https://github.com/', 'GitHub', 3]])
    const r = rank(input('gi', { history: h.entries(), hosts: h.hostList() }))
    expect(r.autocomplete).toEqual({ text: 'github.com', url: 'https://github.com/' })
    expect(r.results[0]).toMatchObject({ kind: 'history', url: 'https://github.com/' })
    // Backspace removed the completion: no completion, search stays available.
    const r2 = rank(input('gi', { history: h.entries(), hosts: h.hostList(), noAutocomplete: true }))
    expect(r2.autocomplete).toBeUndefined()
    // Text with spaces never completes.
    expect(complete('gi t', h.hostList(), h.entries(), [], NOW)).toBeUndefined()
    // Path completion.
    const h2 = historyOf([['http://localhost:3300/page/Alpha', 'Alpha']])
    expect(complete('localhost:3300/page/al', h2.hostList(), h2.entries(), [], NOW)?.url).toBe(
      'http://localhost:3300/page/Alpha',
    )
  })

  it('[CB-08] does not complete a host seen once through a link (review F5)', () => {
    const once = historyOf([['https://newsletter.example/', 'Newsletter']])
    expect(complete('news', once.hostList(), once.entries(), [], NOW)).toBeUndefined()
    const twice = historyOf([['https://newsletter.example/', 'Newsletter', 2]])
    expect(complete('news', twice.hostList(), twice.entries(), [], NOW)?.text).toBe('newsletter.example')
    const typed = new HistoryStore('/nonexistent/typed.jsonl', { now: () => NOW })
    typed.record('https://typed.example/', { typed: true, at: NOW })
    expect(complete('ty', typed.hostList(), typed.entries(), [], NOW)?.text).toBe('typed.example')
    // An open tab still completes.
    expect(complete('news', [], [], [tab('t-9', 'News', 'https://newsletter.example/x')], NOW)?.url).toBe(
      'https://newsletter.example/',
    )
  })

  it('[CB-07] typing forward narrows to earlier matches without changing results', () => {
    const h = historyOf([
      ['https://organ.example/', 'Organ music'],
      ['https://garden.example/', 'Garden tips'],
      ['https://gallery.example/', 'Gallery'],
    ])
    const base = { history: h.entries(), hosts: h.hostList(), noAutocomplete: true }
    const ids = (q: string) =>
      rank(input(q, base))
        .results.filter((r) => r.kind === 'history')
        .map((r) => r.id)
        .sort()
    // "g" only matches word starts; "ga" matches inside words too ("organ"): no narrowing from one letter.
    expect(ids('g')).toEqual(['history:https://gallery.example/', 'history:https://garden.example/'])
    expect(ids('ga')).toEqual([
      'history:https://gallery.example/',
      'history:https://garden.example/',
      'history:https://organ.example/',
    ])
    expect(ids('gar')).toEqual(['history:https://garden.example/'])
    expect(ids('garden t')).toEqual(['history:https://garden.example/'])
    // A new query (not an extension) searches everything again.
    expect(ids('gal')).toEqual(['history:https://gallery.example/'])
  })

  it('[CB-07] a pasted URL after a scheme prefix still finds its history rows (review N2)', () => {
    const h = historyOf([
      ['https://github.com/orbit', 'Orbit repo'],
      ['https://github.com/orbit/issues', 'Issues'],
      ['https://github.com/orbit/pulls', 'Pull requests'],
    ])
    const base = { history: h.entries(), hosts: h.hostList(), noAutocomplete: true }
    const count = (q: string) => rank(input(q, base)).results.filter((r) => r.kind === 'history').length
    count('ht')
    count('http')
    expect(count('https://github.com/orbit')).toBe(3)
  })

  it('[CB-07] dedupes the same URL, preferring the open tab', () => {
    const tabs = [tab('t-1', 'Wiki page', 'https://wiki.example/x')]
    const h = historyOf([['https://wiki.example/x', 'Wiki page']])
    const r = rank(input('wiki page', { tabs, history: h.entries(), hosts: h.hostList(), noAutocomplete: true }))
    expect(r.results.filter((x) => x.url === 'https://wiki.example/x')).toHaveLength(1)
    expect(r.results.find((x) => x.url === 'https://wiki.example/x')?.kind).toBe('tab')
  })

  it('[CB-05] turns past searches into suggestion rows', () => {
    const h = historyOf([['https://www.google.com/search?q=orbit+browser+review', 'orbit browser review - Google']])
    const r = rank(input('orbit br', { history: h.entries(), hosts: h.hostList() }))
    expect(r.results.find((x) => x.kind === 'suggestion')).toMatchObject({
      title: 'orbit browser review',
      removable: true,
    })
    expect(r.results.some((x) => x.kind === 'history')).toBe(false)
  })

  it('[CB-11] offers Tab to search a site by keyword or name, then searches it', () => {
    expect(tabTarget(DEFAULT_SITE_SEARCH, 'yt')?.name).toBe('YouTube')
    expect(tabTarget(DEFAULT_SITE_SEARCH, 'wiki')?.name).toBe('Wikipedia')
    expect(tabTarget(DEFAULT_SITE_SEARCH, 'zzz')).toBeUndefined()
    expect(rank(input('yt')).results.some((x) => x.kind === 'sitesearch')).toBe(true)
    const scope = DEFAULT_SITE_SEARCH.find((s) => s.id === 'youtube')
    const r = rank(input('cats', { scope }))
    expect(r.results).toHaveLength(1)
    expect(r.results[0]?.url).toBe('https://www.youtube.com/results?search_query=cats')
  })

  it('[CB-14] lists only actions in actions mode', () => {
    const r = rank(input('split', { actionsOnly: true, activeTabId: 't-1' }))
    expect(r.results.map((x) => x.actionId)).toEqual(['split.add'])
  })

  it('[CB-18] shows recent tabs and frequent sites before typing, starter rows in a fresh profile', () => {
    const fresh = rank(input(''))
    expect(fresh.results.length).toBeGreaterThan(0)
    expect(fresh.results.length).toBeLessThanOrEqual(6)
    const tabs = [
      tab('t-1', 'Current', 'https://cur.example/', { lastActiveAt: NOW }),
      tab('t-2', 'Older', 'https://old.example/', { lastActiveAt: NOW - 5000 }),
    ]
    const h = historyOf([['https://freq.example/', 'Frequent', 5]])
    const r = rank(input('', { tabs, activeTabId: 't-1', history: h.entries(), hosts: h.hostList() }))
    expect(r.results.map((x) => x.id)).toEqual(['tab:t-2', 'history:https://freq.example/'])
    const withClip = rank(input('', { clipboardUrl: 'https://clip.example/' }))
    expect(withClip.results[0]).toMatchObject({ kind: 'paste', url: 'https://clip.example/' })
  })

  it('[CB-03] in edit-URL mode the untouched URL row reloads the current page', () => {
    const r = rank(
      input('https://example.com/a?b=1', {
        mode: 'edit-url',
        activeTabId: 't-1',
        current: { url: 'https://example.com/a?b=1', title: 'Example' },
      }),
    )
    expect(r.results[0]).toMatchObject({ kind: 'current', hint: 'Reload' })
  })

  it('[CB-19] offers other Spaces by name', () => {
    const r = rank(input('work'))
    expect(r.results[0]).toMatchObject({ kind: 'space', spaceId: 's-b' })
  })

  it('[CB-07][CB-22] ranks 500 tabs and 10,000 history entries in ≤ 30 ms per keystroke', () => {
    const words = ['alpha', 'budget', 'cloud', 'design', 'engine', 'forest', 'garden', 'harbor', 'island', 'jungle']
    const tabs = Array.from({ length: 500 }, (_, i) =>
      tab(`t-${i}`, `${words[i % 10]} tab ${i}`, `https://site${i % 97}.example/${words[(i * 7) % 10]}/${i}`, {
        lastActiveAt: NOW - i * 1000,
      }),
    )
    const store = new HistoryStore('/nonexistent/bench.jsonl', { now: () => NOW })
    for (let i = 0; i < 10_000; i++) {
      store.record(`https://host${i % 800}.example/${words[i % 10]}/page-${i}?ref=${i % 13}`, {
        title: `${words[(i * 3) % 10]} article number ${i} about ${words[(i * 7) % 10]}`,
        at: NOW - i * 60_000,
      })
    }
    const base = input('', {
      tabs,
      activeTabId: 't-0',
      history: store.entries(),
      hosts: store.hostList(),
    })
    const typed = 'garden article 42'
    // Round 0 warms the JIT and per-entry caches, as the app does in idle time after history loads. Each keystroke is
    // timed in this thread's CPU time: ranking never waits, so that is its whole cost, while wall time on a shared
    // machine also counts the turns other processes get. A run that misses the budget is measured again, up to three
    // runs (D46, D51).
    // CPU time can't see a blocking wait or work moved to another thread, and on Linux it moves in steps of one
    // scheduler tick (1 ms here). The e2e test times the same ranking in the app in wall time, which sees both.
    // Thread CPU time needs Node 23.9 or later; on an older Node the process's CPU time stands in.
    const cpuUsage = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage : process.cpuUsage
    const cpuMs = () => {
      const { user, system } = cpuUsage.call(process)
      return (user + system) / 1000
    }
    const at = (sorted: number[], q: number) => sorted[Math.floor(sorted.length * q)] as number
    let p95 = Number.POSITIVE_INFINITY
    for (let run = 1; run <= 3 && p95 > 30; run++) {
      const cpu: number[] = []
      const wall: number[] = []
      for (let round = run === 1 ? 0 : 1; round < 4; round++) {
        for (let n = 0; n <= typed.length; n++) {
          const c0 = cpuMs()
          const t0 = performance.now()
          const r = rank({ ...base, query: typed.slice(0, n) })
          const t1 = performance.now()
          const c1 = cpuMs()
          if (round > 0) {
            cpu.push(c1 - c0)
            wall.push(t1 - t0)
          }
          expect(r.results.length).toBeGreaterThan(0)
        }
      }
      cpu.sort((a, b) => a - b)
      wall.sort((a, b) => a - b)
      p95 = at(cpu, 0.95)
      console.info(
        `[commandbar bench] run ${run}: per keystroke CPU p50 ${at(cpu, 0.5).toFixed(2)} ms, p95 ${p95.toFixed(2)} ms; wall p95 ${at(wall, 0.95).toFixed(2)} ms`,
      )
    }
    expect(p95).toBeLessThanOrEqual(30)
  })
})

describe('sources', () => {
  it('[CB-13] knows which actions need a current tab', () => {
    expect(actionNeedsTab('tab.togglePin', 'Tabs')).toBe(true)
    expect(actionNeedsTab('tab.reopenClosed', 'Tabs')).toBe(false)
    expect(actionNeedsTab('space.new', 'Spaces')).toBe(false)
    const docs = new SourceCache().actions((id) => id !== 'window.newMini', 'darwin')
    expect(docs.find((a) => a.id === 'tab.togglePin')?.shortcut).toBe('⌘D')
    expect(docs.some((a) => a.id === 'tab.new')).toBe(false)
    expect(docs.some((a) => a.id === 'window.newMini')).toBe(false)
  })

  it('[CB-05][IM-14] lists every open tab, a Peek’s floating one too, but not an import’s that no section shows yet (D65 (1))', () => {
    const state = createInitialState(0)
    const spaceId = state.spaceOrder[0] as string
    const space = state.spaces[spaceId] as (typeof state.spaces)[string]
    const add = (url: string) => {
      const tab = makeTab({ spaceId, profileId: space.profileId, url }, NOW)
      state.tabs[tab.id] = tab
      return tab.id
    }
    const pinned = add('https://example.org/pinned')
    space.pinned.push(pinned)
    // In no section: a Peek's tab.
    const floating = add('https://example.org/peek')
    // Two of an import's, made out of sight: one the user reached anyway and put in Today (D65 (2)).
    const unshown = add('https://example.com/page/1')
    const reached = add('https://example.com/page/2')
    space.today.push(reached)
    hideImportTabs([unshown, reached])
    try {
      const cache = new SourceCache()
      const listed = () =>
        cache
          .tabs(state)
          .map((d) => d.id)
          .sort()
      expect(listed()).toEqual([pinned, floating, reached].sort())
      // Shown whole, they're the user's: listed like any tab.
      releaseImportTabs([unshown, reached])
      expect(listed()).toEqual([pinned, floating, unshown, reached].sort())
    } finally {
      releaseImportTabs([unshown, reached])
    }
  })
})

describe('the action catalogue (CB-13)', () => {
  /**
   * Each name the spec's catalogue gives an action whose feature Orbit has, and the action it finds
   * first. The rest wait for the lanes that own them (FEATURES.md, CB-13's note).
   */
  const CATALOGUE: [string, string][] = [
    // Tabs
    ['Pin Tab', 'tab.togglePin'],
    ['Unpin Tab', 'tab.togglePin'],
    ['Pin to Work', 'tab.pinToSpace'],
    ['Duplicate Tab', 'tab.duplicate'],
    ['Close Tab', 'tab.close'],
    ['Reopen Closed Tab', 'tab.reopenClosed'],
    ['Rename Tab', 'tab.rename'],
    ['Reset Tab', 'tab.resetToPinned'],
    ['Move to Work', 'tab.moveToSpace'],
    ['Favorite this tab', 'tab.favorite'],
    ['Unfavorite Tab', 'tab.favorite'],
    ['Copy URL', 'tab.copyUrl'],
    ['Copy URL as Markdown', 'tab.copyUrlMarkdown'],
    ['Copy URLs', 'tab.copyUrl'],
    ['Paste URL as New Tab', 'tab.pasteAsNewTab'],
    ['Archive Tabs Below', 'tab.archiveBelow'],
    ['Clear Today tabs', 'tabs.clearToday'],
    // Sidebar and window
    ['Toggle Sidebar', 'sidebar.toggle'],
    ['New Window', 'window.new'],
    ['New Blank Window', 'window.newBlank'],
    ['New Private Window', 'window.newPrivate'],
    ['New Mini Window', 'window.newMini'],
    ['Collapse Pinned', 'pinned.toggleCollapsed'],
    ['Expand Pinned', 'pinned.toggleCollapsed'],
    // Spaces and folders
    ['New Space', 'space.new'],
    ['Rename Space', 'space.rename'],
    ['Change Theme', 'space.theme'],
    ['New Folder', 'folder.new'],
    // Split view
    ['Add Split View', 'split.add'],
    ['Add Right Split', 'split.addRight'],
    ['Add Left Split', 'split.addLeft'],
    ['Add Top Split', 'split.addAbove'],
    ['Add Bottom Split', 'split.addBelow'],
    ['Close Split', 'split.closeSplit'],
    // Library and archive
    ['Open Library', 'app.library'],
    ['View Archive', 'app.archive'],
    ['Clear Archive', 'archive.clear'],
    ['View History', 'app.history'],
    ['Downloads', 'app.downloads'],
    // Page
    ['Reload', 'nav.reload'],
    ['Hard Reload', 'nav.hardReload'],
    ['Find in Page', 'page.find'],
    ['Zoom In', 'page.zoomIn'],
    ['Zoom Out', 'page.zoomOut'],
    ['Zoom Reset', 'page.zoomReset'],
    ['Print', 'page.print'],
    ['View Source', 'page.viewSource'],
    ['Developer Tools', 'devtools.toggle'],
    ['Site controls', 'site.controls'],
    // Settings and help
    ['Settings', 'app.settings'],
    ['Shortcuts', 'settings.shortcuts'],
    ['Keyboard Shortcuts', 'help.shortcuts'],
    ['Link settings', 'settings.links'],
    ['Site search settings', 'settings.siteSearch'],
    ['Clear browsing data', 'settings.clearBrowsingData'],
    ['Import', 'app.import'],
    ['Set as default browser', 'settings.defaultBrowser'],
    ['Check for updates', 'app.checkForUpdates'],
    ["What's new", 'help.releaseNotes'],
    ['Help', 'help.open'],
  ]

  it.each(CATALOGUE)('"%s" finds %s first, with its live shortcut', (name, id) => {
    const docs = new SourceCache().actions(() => true, 'darwin')
    const tabs = [tab('t-1', 'Current', 'https://cur.example/')]
    const rows = rank(input(name, { actions: docs, activeTabId: 't-1', tabs })).results
    const first = rows.find((r) => r.kind === 'action')
    expect(first?.actionId).toBe(id)
    const doc = docs.find((d) => d.id === id)
    if (doc) expect(first?.shortcut).toBe(doc.shortcut)
  })
})

describe('sources: Settings sections (CB-05)', () => {
  /** The section ids the Settings window's registry finds (every `*.settings.tsx` default export). */
  function registeredSections(): string[] {
    const root = join(__dirname, '../../src/renderer/src')
    return (readdirSync(root, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.settings.tsx'))
      .map((f) => /export default \{\s*id: '([^']+)'/.exec(readFileSync(join(root, f), 'utf8'))?.[1] ?? f)
      .sort()
  }

  it('every section in the Settings registry is a row of its own, labelled Settings', () => {
    const sections = registeredSections()
    expect(sections).toEqual(expect.arrayContaining(['advanced', 'general', 'links', 'privacy', 'shortcuts']))
    const docs = new SourceCache().actions(() => true, 'darwin')
    for (const section of sections) {
      const def = SETTINGS_ACTIONS.find((a) => a.settings.section === section && !a.settings.item)
      expect(def, `an action for the "${section}" section`).toBeDefined()
      const r = rank(input((def as (typeof SETTINGS_ACTIONS)[number]).title, { actions: docs })).results
      expect(r.find((x) => x.actionId === def?.id)).toMatchObject({ kind: 'action', label: 'Settings' })
    }
    // Other actions keep their own label.
    const other = rank(input('new space', { actions: docs })).results.find((x) => x.actionId === 'space.new')
    expect(other?.label).toBe('Action')
  })
})

describe('sources: splits (SV-21)', () => {
  it('each pane carries its split, its name or pane titles in reading order, and every favicon', () => {
    const state = createInitialState(0)
    const spaceId = state.spaceOrder[0] as string
    const space = state.spaces[spaceId] as (typeof state.spaces)[string]
    const add = (url: string, title: string) => {
      const tab = makeTab({ spaceId, profileId: space.profileId, url }, NOW)
      tab.title = title
      tab.favicon = `${url}favicon.ico`
      state.tabs[tab.id] = tab
      return tab.id
    }
    const a = add('https://a.example/', 'Alpha')
    const b = add('https://b.example/', 'Bravo')
    // Bravo is the left pane: titles follow the panes on screen, not the order the tabs were opened.
    state.splits['v-x'] = {
      id: 'v-x',
      layout: {
        type: 'row',
        sizes: [0.5, 0.5],
        children: [
          { type: 'leaf', tabId: b },
          { type: 'leaf', tabId: a },
        ],
      },
      createdAt: NOW,
    }
    space.today.push('v-x')
    const cache = new SourceCache()
    const doc = (id: string) => cache.tabs(state).find((d) => d.id === id)
    expect(doc(a)).toMatchObject({
      splitId: 'v-x',
      splitTitle: 'Bravo | Alpha',
      splitFavicons: ['https://b.example/favicon.ico', 'https://a.example/favicon.ico'],
    })
    expect(doc(a)?.splitNameLower).toBeUndefined()
    // Renamed: the name, which it also matches on.
    state.splits = {
      ...state.splits,
      'v-x': { ...(state.splits['v-x'] as (typeof state.splits)[string]), name: 'Pair' },
    }
    expect(doc(b)).toMatchObject({ splitTitle: 'Pair', splitNameLower: 'pair' })
  })
})

describe('engine suggestions', () => {
  it('[CB-15] parses OpenSearch suggestion responses', () => {
    expect(parseSuggestions(['orbit', ['orbit browser', 'Orbit', 'orbit browser', 42, 'orbital']], 'orbit')).toEqual([
      'orbit browser',
      'orbital',
    ])
    expect(parseSuggestions({ nope: true }, 'x')).toEqual([])
    expect(parseSuggestions(['x'], 'x')).toEqual([])
  })

  it('[CB-15][FL-17] fills free rows below without touching existing rows', () => {
    const row = (id: string, query?: string): SearchResult => ({
      id,
      kind: 'search',
      title: id,
      label: '',
      query,
      score: 0,
    })
    const local = [row('tab:1'), row('search', 'orbit')]
    const merged = mergeSuggestions(
      local,
      [row('engine:orbit', 'orbit'), row('engine:a', 'a'), row('engine:b', 'b')],
      3,
    )
    expect(merged.map((r) => r.id)).toEqual(['tab:1', 'search', 'engine:a'])
    expect(merged[0]).toBe(local[0])
    expect(mergeSuggestions(local, [], 9)).toBe(local)
  })
})

describe('folders', () => {
  it('[CB-05][CB-13] finds folders by name as "Open folder" rows', () => {
    const r = rank(
      input('recipes', {
        folders: [{ id: 'f-1', name: 'Recipes', nameLower: 'recipes', spaceId: 's-b' }],
      }),
    )
    expect(r.results[0]).toMatchObject({ kind: 'folder', folderId: 'f-1', label: 'Folder', subtitle: 'Work' })
  })

  it('[FD-09] "Open [Folder]": the folder’s name after "open" finds it too', () => {
    const folders = [{ id: 'f-1', name: 'Recipes', nameLower: 'recipes', spaceId: 's-b' }]
    expect(rank(input('open recip', { folders })).results.find((x) => x.kind === 'folder')).toMatchObject({
      folderId: 'f-1',
    })
    // "open" alone is not a folder's name.
    expect(rank(input('open', { folders })).results.some((x) => x.kind === 'folder')).toBe(false)
  })
})
