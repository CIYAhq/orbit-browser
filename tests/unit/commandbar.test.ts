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
import { mergeSuggestions, type SearchResult } from '../../src/shared/commands/commandbar'
import { DEFAULT_SITE_SEARCH } from '../../src/shared/defaults'
import { fillSearchTemplate, parseInput } from '../../src/shared/url'

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
  const store = new HistoryStore('/nonexistent/never-written.jsonl', () => NOW)
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

  it('normalizes URLs for dedupe and display', () => {
    expect(normKey('https://www.GitHub.com/')).toBe('github.com')
    expect(normKey('http://github.com/#top')).toBe('github.com')
    expect(displayUrl('https://www.example.com/a/')).toBe('example.com/a')
    expect(displayUrl('http://localhost:3300/page/Docs%3A%20Orbit')).toBe('localhost:3300/page/Docs: Orbit')
    expect(displayUrl('https://x.example/%E0%A4%A')).toBe('x.example/%E0%A4%A')
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
    const store = new HistoryStore('/nonexistent/bench.jsonl', () => NOW)
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
    const times: number[] = []
    for (let round = 0; round < 3; round++) {
      for (let n = 0; n <= typed.length; n++) {
        const t0 = performance.now()
        const r = rank({ ...base, query: typed.slice(0, n) })
        times.push(performance.now() - t0)
        expect(r.results.length).toBeGreaterThan(0)
      }
    }
    times.sort((a, b) => a - b)
    const p95 = times[Math.floor(times.length * 0.95)] as number
    const p50 = times[Math.floor(times.length / 2)] as number
    console.info(`[commandbar bench] per keystroke p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms`)
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
})
