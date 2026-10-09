/**
 * Command bar ranking (CB-05…CB-08, CB-11, CB-13, CB-15, CB-18). Pure: it takes
 * prepared candidate lists and returns one ranked list, so it is unit-tested and
 * benchmarked directly (budget: ≤ 30 ms per keystroke with 500 tabs and 10,000
 * history entries).
 *
 * Order (CB-07, a tunable scoring function):
 * 1. The top row is the best guess: the typed or autocompleted URL (an open tab
 *    on that URL wins), else a strong title/host match, else the web search.
 * 2. The web search row comes right after a non-search top row.
 * 3. The rest by score: open tabs (current Space first) > Spaces > history
 *    (frecency) > archived tabs > past searches > actions.
 * The same URL appears once (open tab > archived > history).
 */
import { findSiteSearch, type SearchResponse, type SearchResult } from '../../shared/commands/commandbar'
import type { CommandBarMode, FolderId, SiteSearchEngine, SpaceId, TabId } from '../../shared/state'
import { fillSearchTemplate, parseInput, SEARCH_ENGINES } from '../../shared/url'
import { frecency, type HostInfo, type IndexedEntry, urlKeyOf } from '../history/store'
import { type DocMatch, matchDoc, matchName, terms as splitTerms } from './match'

export const MAX_RESULTS = 9
const EMPTY_STATE_ROWS = 6

export interface TabDoc {
  id: TabId
  title: string
  url: string
  favicon?: string
  spaceId: SpaceId
  lastActiveAt: number
  section?: 'favorite' | 'pinned' | 'today'
  /** Favicons of every pane when the tab is part of a split view. */
  splitFavicons?: (string | null)[]
  titleLower: string
  urlKey: string
  /** URL key of a pinned tab's or Favorite's home URL when it differs from the current one. */
  pinnedKey?: string
  host: string
}

export interface ArchiveDoc {
  id: string
  title: string
  url: string
  favicon?: string
  spaceId: SpaceId
  archivedAt: number
  titleLower: string
  urlKey: string
}

export interface SpaceDoc {
  id: SpaceId
  name: string
  icon: string
  nameLower: string
}

export interface FolderDoc {
  id: FolderId
  name: string
  nameLower: string
  /** Space whose sidebar shows the folder. */
  spaceId?: SpaceId
}

export interface ActionDoc {
  id: string
  title: string
  shortcut?: string
  titleLower: string
  keywords: string[]
  initials: string
  /** Hidden when there is no current tab (CB-13). */
  needsTab: boolean
}

export type SiteSearch = SiteSearchEngine

export interface RankInput {
  query: string
  mode: CommandBarMode
  now: number
  engine: { name: string; search: string }
  tabs: readonly TabDoc[]
  activeTabId: TabId | null
  currentSpaceId: SpaceId
  spaceNames: Readonly<Record<SpaceId, string>>
  current?: { url: string; title: string; favicon?: string }
  history: readonly IndexedEntry[]
  hosts: readonly HostInfo[]
  archive: readonly ArchiveDoc[]
  spaces: readonly SpaceDoc[]
  folders?: readonly FolderDoc[]
  actions: readonly ActionDoc[]
  siteSearches: readonly SiteSearch[]
  /** Active site-search chip (CB-11). */
  scope?: SiteSearch
  actionsOnly?: boolean
  noAutocomplete?: boolean
  /** URL on the clipboard, offered first in the empty state (CB-12). */
  clipboardUrl?: string
  maxResults?: number
}

interface Cand {
  r: SearchResult
  /** Dedupe key (normalized URL). */
  key?: string
  strong: boolean
  /** Dedupe preference: higher wins for the same URL. */
  prio: number
}

/** URL identity for dedupe: no scheme, no "www.", no fragment, no trailing slash. */
export function normKey(url: string): string {
  const key = urlKeyOf(url)
  const hash = key.indexOf('#')
  const noHash = hash >= 0 ? key.slice(0, hash) : key
  return noHash.endsWith('/') ? noHash.slice(0, -1) : noHash
}

/** Compact, readable URL for row text: no scheme, no "www.", no trailing slash, %-escapes decoded. */
export function displayUrl(url: string): string {
  if (/^(about|data|chrome|devtools|view-source|orbit):/i.test(url)) return url.slice(0, 300)
  let s = url.replace(/^https?:\/\//i, '').replace(/^www\./i, '')
  if (s.endsWith('/')) s = s.slice(0, -1)
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

const keyCache = new WeakMap<object, string>()
/** normKey of a history or archive entry, computed once per entry. */
function keyOf(e: { url: string }): string {
  let key = keyCache.get(e)
  if (key === undefined) {
    key = normKey(e.url)
    keyCache.set(e, key)
  }
  return key
}

// ---- Past searches (local search suggestions) ----

const SERPS = Object.values(SEARCH_ENGINES).flatMap((e) => {
  try {
    const u = new URL(e.search.replace('%s', 'ORBITQ'))
    const param = [...u.searchParams].find(([, v]) => v === 'ORBITQ')?.[0]
    if (!param) return []
    return [{ prefix: `${u.hostname.replace(/^www\./, '')}${u.pathname}`, param }]
  } catch {
    return []
  }
})
const pastSearchCache = new WeakMap<IndexedEntry, string | null>()

/** The query of a search-engine results page in history, e.g. google.com/search?q=cats → "cats". */
export function pastSearchOf(e: IndexedEntry): string | undefined {
  let q = pastSearchCache.get(e)
  if (q === undefined) {
    q = null
    for (const s of SERPS) {
      if (!e.urlKey.startsWith(s.prefix)) continue
      const next = e.urlKey.charAt(s.prefix.length)
      if (next !== '?' && next !== '') continue
      try {
        q = new URL(e.url).searchParams.get(s.param)?.trim() || null
      } catch {
        q = null
      }
      break
    }
    pastSearchCache.set(e, q)
  }
  return q ?? undefined
}

// ---- Inline autocompletion (CB-08) ----

export interface Completion {
  text: string
  url: string
}

/** Completes a typed domain (or URL prefix) from history and open tabs. */
export function complete(
  query: string,
  hosts: readonly HostInfo[],
  history: readonly IndexedEntry[],
  tabs: readonly TabDoc[],
  now: number,
): Completion | undefined {
  if (!query || /\s/.test(query) || query.includes('://')) return undefined
  const lower = query.toLowerCase()
  const bare = lower.startsWith('www.') ? lower.slice(4) : lower
  if (!bare || !/^[a-z0-9]/.test(bare)) return undefined
  if (bare.includes('/')) {
    // URL completion: the most frecent page whose URL starts with the text.
    let best: IndexedEntry | undefined
    let bestF = -1
    for (const e of history) {
      if (e.urlKey.length > bare.length && e.urlKey.startsWith(bare)) {
        const f = frecency(e, now)
        if (f > bestF) {
          best = e
          bestF = f
        }
      }
    }
    return best ? { text: query + best.urlKey.slice(bare.length), url: best.url } : undefined
  }
  if (!/^[a-z0-9.:-]+$/.test(bare)) return undefined
  let best: { host: string; origin: string } | undefined
  let bestF = -1
  for (const h of hosts) {
    if (h.host.length > bare.length && h.host.startsWith(bare)) {
      const f = frecency(h, now) + (h.typedCount > 0 ? 2 : 0) - h.host.length * 0.001
      if (f > bestF) {
        best = h
        bestF = f
      }
    }
  }
  if (!best) {
    // Open tabs complete too (e.g. pages opened before history existed).
    let bestAt = -1
    for (const t of tabs) {
      if (t.host.length > bare.length && t.host.startsWith(bare) && t.lastActiveAt > bestAt) {
        try {
          const u = new URL(t.url)
          best = { host: t.host, origin: `${u.protocol}//${u.host}` }
          bestAt = t.lastActiveAt
        } catch {
          // skip
        }
      }
    }
  }
  return best ? { text: query + best.host.slice(bare.length), url: `${best.origin}/` } : undefined
}

// ---- Rows ----

function sectionLabel(t: TabDoc): string {
  if (t.splitFavicons) return 'Split'
  if (t.section === 'favorite') return 'Favorite'
  if (t.section === 'pinned') return 'Pinned'
  return 'Tab'
}

function tabRow(t: TabDoc, input: RankInput, score: number): SearchResult {
  const inSpace = t.spaceId === input.currentSpaceId || t.section === 'favorite'
  const spaceName = input.spaceNames[t.spaceId]
  return {
    id: `tab:${t.id}`,
    kind: 'tab',
    title: t.title || displayUrl(t.url),
    subtitle: inSpace || !spaceName ? displayUrl(t.url) : `${spaceName} · ${displayUrl(t.url)}`,
    label: sectionLabel(t),
    hint: 'Switch to tab',
    url: t.url,
    favicon: t.favicon,
    ...(t.splitFavicons ? { splitFavicons: t.splitFavicons } : {}),
    tabId: t.id,
    spaceId: t.spaceId,
    score,
  }
}

function historyRow(e: IndexedEntry, score: number): SearchResult {
  return {
    id: `history:${e.url}`,
    kind: 'history',
    title: e.title || displayUrl(e.url),
    subtitle: displayUrl(e.url),
    label: 'History',
    url: e.url,
    favicon: e.favicon,
    removable: true,
    score,
  }
}

function searchRow(input: RankInput, q: string): SearchResult {
  return {
    id: 'search',
    kind: 'search',
    title: q,
    subtitle: `Search ${input.engine.name}`,
    label: 'Search',
    url: fillSearchTemplate(input.engine.search, q),
    query: q,
    score: 0,
  }
}

function urlRow(url: string, score = 0): SearchResult {
  return { id: 'url', kind: 'url', title: displayUrl(url), subtitle: 'Open address', label: 'URL', url, score }
}

function actionRow(a: ActionDoc, score: number): SearchResult {
  return {
    id: `action:${a.id}`,
    kind: 'action',
    title: a.title,
    label: 'Action',
    actionId: a.id,
    ...(a.shortcut ? { shortcut: a.shortcut } : {}),
    score,
  }
}

function recencyBonus(at: number, now: number): number {
  const age = now - at
  return age < 600_000 ? 15 : age < 3_600_000 ? 10 : age < 86_400_000 ? 5 : 0
}

/** Bounded "top N by score" collector (avoids sorting thousands of matches). */
class TopN {
  readonly items: Cand[] = []
  constructor(private n: number) {}
  /** Whether a candidate with this score would be kept (check before building it). */
  accepts(score: number): boolean {
    return this.items.length < this.n || (this.items[this.items.length - 1] as Cand).r.score < score
  }
  add(c: Cand): void {
    const items = this.items
    if (items.length === this.n && (items[items.length - 1] as Cand).r.score >= c.r.score) return
    let i = items.length
    while (i > 0 && (items[i - 1] as Cand).r.score < c.r.score) i--
    items.splice(i, 0, c)
    if (items.length > this.n) items.pop()
  }
}

// ---- Main entry ----

export function rank(input: RankInput): SearchResponse {
  const max = input.maxResults ?? MAX_RESULTS
  const engineName = input.engine.name
  const q = input.query.trim()
  if (input.scope) return { results: [siteSearchRow(input.scope, q)], engineName }
  if (input.actionsOnly) return { results: actionResults(input, q, max), engineName }
  if (input.mode === 'edit-url' && input.current && q === input.current.url.trim()) {
    return { results: editUrlState(input), engineName }
  }
  if (!q) return { results: input.mode === 'search-tabs' ? recentTabs(input, max) : emptyState(input), engineName }

  const lower = q.toLowerCase()
  // A typed scheme is not part of the URL keys we match against.
  const ts = splitTerms(/^[a-z][a-z0-9+.-]*:\/\//i.test(q) ? urlKeyOf(q) : q)
  const now = input.now
  const tabsOnly = input.mode === 'search-tabs'

  // The current page never shows up as a history or archive row.
  const activeKey = input.current ? normKey(input.current.url) : undefined
  const tabs = new TopN(6)
  for (const t of input.tabs) {
    if (t.id === input.activeTabId) continue
    const m = matchDoc(ts, t.titleLower, t.urlKey, t.pinnedKey)
    if (m.score === 0) continue
    const score =
      600 +
      m.score +
      (m.hostPrefix ? 100 : 0) +
      (t.spaceId === input.currentSpaceId ? 20 : 0) +
      recencyBonus(t.lastActiveAt, now)
    if (!tabs.accepts(score)) continue
    tabs.add({ r: tabRow(t, input, score), key: keyOf(t), strong: m.strong, prio: 4 })
  }

  const spaces = new TopN(3)
  const folders = new TopN(2)
  const history = new TopN(6)
  const suggestions = new TopN(3)
  const archived = new TopN(3)
  const actions = new TopN(4)
  if (!tabsOnly) {
    for (const s of input.spaces) {
      if (s.id === input.currentSpaceId) continue
      const m = matchName(ts, s.nameLower)
      if (m.score === 0) continue
      const score = 500 + m.score + (s.nameLower === lower ? 60 : 0)
      spaces.add({
        r: {
          id: `space:${s.id}`,
          kind: 'space',
          title: s.name,
          label: 'Space',
          hint: 'Switch to Space',
          spaceId: s.id,
          spaceIcon: s.icon,
          score,
        },
        strong: m.strong,
        prio: 0,
      })
    }

    for (const f of input.folders ?? []) {
      const m = matchName(ts, f.nameLower)
      if (m.score === 0) continue
      const other = f.spaceId && f.spaceId !== input.currentSpaceId ? input.spaceNames[f.spaceId] : undefined
      folders.add({
        r: {
          id: `folder:${f.id}`,
          kind: 'folder',
          title: f.name,
          ...(other ? { subtitle: other } : {}),
          label: 'Folder',
          hint: 'Open folder',
          folderId: f.id,
          spaceId: f.spaceId,
          score: 450 + m.score,
        },
        strong: m.strong,
        prio: 0,
      })
    }

    const seenQueries = new Set<string>([lower])
    for (const e of input.history) {
      const m = matchDoc(ts, e.titleLower, e.urlKey)
      if (m.score === 0) continue
      const f = frecency(e, now)
      const past = pastSearchOf(e)
      if (past !== undefined) {
        // Search results pages become "past search" suggestions (CB-05 item 5, local).
        const pastLower = past.toLowerCase()
        if (seenQueries.has(pastLower)) continue
        const pm = matchName(ts, pastLower)
        if (pm.score === 0) continue
        const pastScore = 200 + pm.score + 3 * f
        if (!suggestions.accepts(pastScore)) continue
        seenQueries.add(pastLower)
        suggestions.add({
          r: {
            id: `suggestion:${pastLower}`,
            kind: 'suggestion',
            title: past,
            subtitle: `Search ${engineName}`,
            label: 'Past search',
            url: fillSearchTemplate(input.engine.search, past),
            query: past,
            removable: true,
            score: pastScore,
          },
          strong: false,
          prio: 0,
        })
        continue
      }
      const score = 400 + m.score + 6 * f + (m.hostPrefix ? 40 : 0)
      if (!history.accepts(score)) continue
      const key = keyOf(e)
      if (key === activeKey) continue
      history.add({ r: historyRow(e, score), key, strong: m.strong, prio: 1 })
    }

    for (const a of input.archive) {
      const m = matchDoc(ts, a.titleLower, a.urlKey)
      if (m.score === 0) continue
      const score = 250 + m.score + recencyBonus(a.archivedAt, now)
      if (!archived.accepts(score)) continue
      const key = keyOf(a)
      if (key === activeKey) continue
      archived.add({
        r: {
          id: `archived:${a.id}`,
          kind: 'archived',
          title: a.title || displayUrl(a.url),
          subtitle: displayUrl(a.url),
          label: 'Archived',
          hint: 'Restore',
          url: a.url,
          favicon: a.favicon,
          archiveId: a.id,
          spaceId: a.spaceId,
          score,
        },
        key,
        strong: m.strong,
        prio: 2,
      })
    }

    for (const a of input.actions) {
      if (a.needsTab && !input.activeTabId) continue
      const m = actionMatch(ts, lower, a)
      if (m.score === 0) continue
      actions.add({ r: actionRow(a, 150 + m.score), strong: m.strong, prio: 0 })
    }
  }

  // Best guess for the top row.
  const parsed = parseInput(q)
  const completion =
    input.noAutocomplete || tabsOnly ? undefined : complete(q, input.hosts, input.history, input.tabs, now)
  const target = completion?.url ?? (parsed.kind === 'url' ? parsed.url : undefined)

  // One row per URL before picking the top row, so the kept row is the preferred kind.
  const pool = dedupe([
    ...tabs.items,
    ...spaces.items,
    ...folders.items,
    ...history.items,
    ...archived.items,
    ...suggestions.items,
    ...actions.items,
  ])
  let top: SearchResult | undefined
  let topKey: string | undefined
  if (target && !tabsOnly) {
    topKey = normKey(target)
    const tab = input.tabs.find((t) => t.id !== input.activeTabId && keyOf(t) === topKey)
    if (tab) {
      top = tabRow(tab, input, 10_000)
    } else {
      const entry = findHistory(input.history, topKey)
      top = entry && pastSearchOf(entry) === undefined ? historyRow(entry, 10_000) : urlRow(target, 10_000)
    }
  } else if (q.length >= 2) {
    // Open tabs, Spaces and history pages first, then actions (they sink below web results).
    const strong = pool.filter((c) => c.strong)
    const web = strong.filter((c) => c.r.kind !== 'action')
    const best = (web.length ? web : strong).reduce<Cand | undefined>(
      (a, c) => (!a || c.r.score > a.r.score ? c : a),
      undefined,
    )
    if (best) {
      top = best.r
      topKey = best.key
    }
  }

  const rest = pool.filter((c) => c.r !== top && (!topKey || c.key !== topKey))
  rest.sort((a, b) => b.r.score - a.r.score)

  const results: SearchResult[] = []
  if (top) results.push(top)
  if (!tabsOnly) results.push(searchRow(input, q))
  const site = tabTarget(input.siteSearches, q)
  if (site && !tabsOnly) {
    results.push({
      id: `sitesearch:${site.id}`,
      kind: 'sitesearch',
      title: `Search ${site.name}`,
      subtitle: `Type “${site.keyword}” then Tab`,
      label: 'Site search',
      hint: 'Tab',
      siteSearchId: site.id,
      score: 0,
    })
  }
  for (const c of rest) {
    if (results.length >= max) break
    results.push(c.r)
  }
  return {
    results: results.slice(0, max),
    ...(completion ? { autocomplete: completion } : {}),
    ...(site ? { tabTarget: { id: site.id, name: site.name, keyword: site.keyword } } : {}),
    engineName,
  }
}

function actionMatch(ts: string[], lower: string, a: ActionDoc): DocMatch {
  const m = matchName(ts, a.titleLower, a.keywords)
  if (m.score > 0) return m
  // Initials: "dt" → Developer Tools, "ns" → New Space.
  if (ts.length === 1 && lower.length >= 2 && a.initials.startsWith(lower)) {
    return { score: 50, strong: a.initials === lower, hostPrefix: false }
  }
  return m
}

function findHistory(history: readonly IndexedEntry[], key: string): IndexedEntry | undefined {
  let best: IndexedEntry | undefined
  for (const e of history) {
    if (e.urlKey.length < key.length || !e.urlKey.startsWith(key)) continue
    if (keyOf(e) !== key) continue
    if (!best || e.lastVisit > best.lastVisit) best = e
  }
  return best
}

/** Keeps one row per URL, preferring open tab > archived > history. */
function dedupe(cands: Cand[]): Cand[] {
  const byKey = new Map<string, Cand>()
  const out: Cand[] = []
  for (const c of cands) {
    if (!c.key) {
      out.push(c)
      continue
    }
    const seen = byKey.get(c.key)
    if (!seen) {
      byKey.set(c.key, c)
      out.push(c)
    } else if (c.prio > seen.prio) {
      // Keep the better kind, and its chance to be the top row.
      const kept = { ...c, strong: c.strong || seen.strong }
      out[out.indexOf(seen)] = kept
      byKey.set(c.key, kept)
    }
  }
  return out
}

export const tabTarget = findSiteSearch

function siteSearchRow(site: SiteSearch, q: string): SearchResult {
  if (!q) {
    return { id: `site:${site.id}`, kind: 'search', title: `Search ${site.name}`, label: site.name, score: 0 }
  }
  return {
    id: `site:${site.id}`,
    kind: 'search',
    title: q,
    subtitle: `Search ${site.name}`,
    label: site.name,
    url: fillSearchTemplate(site.url, q),
    query: q,
    siteSearchId: site.id,
    score: 0,
  }
}

function actionResults(input: RankInput, q: string, max: number): SearchResult[] {
  const ts = splitTerms(q)
  const lower = q.toLowerCase()
  const out: SearchResult[] = []
  for (const a of input.actions) {
    if (a.needsTab && !input.activeTabId) continue
    if (!q) {
      out.push(actionRow(a, 0))
      continue
    }
    const m = actionMatch(ts, lower, a)
    if (m.score > 0) out.push(actionRow(a, m.score))
  }
  if (q) out.sort((a, b) => b.score - a.score)
  return out.slice(0, max)
}

function recentTabs(input: RankInput, n: number): SearchResult[] {
  return input.tabs
    .filter((t) => t.id !== input.activeTabId && t.url && t.url !== 'about:blank')
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, n)
    .map((t, i) => tabRow(t, input, 100 - i))
}

function editUrlState(input: RankInput): SearchResult[] {
  const cur = input.current
  if (!cur) return []
  return [
    {
      id: 'current',
      kind: 'current',
      title: cur.title || displayUrl(cur.url),
      subtitle: displayUrl(cur.url),
      label: 'Current page',
      hint: 'Reload',
      url: cur.url,
      favicon: cur.favicon,
      tabId: input.activeTabId ?? undefined,
      score: 0,
    },
    ...recentTabs(input, 3),
  ]
}

/** Popular sites for a profile without history (CB-18). */
const STARTER_SITES = ['https://www.wikipedia.org/', 'https://github.com/', 'https://www.youtube.com/']
const STARTER_ACTIONS = ['space.new', 'app.settings', 'window.new']

function emptyState(input: RankInput): SearchResult[] {
  const out: SearchResult[] = []
  if (input.clipboardUrl) {
    out.push({
      id: 'paste',
      kind: 'paste',
      title: 'Paste and go',
      subtitle: displayUrl(input.clipboardUrl),
      label: 'Clipboard',
      url: input.clipboardUrl,
      score: 0,
    })
  }
  const recent = recentTabs(input, 4)
  out.push(...recent)
  const open = new Set(input.tabs.map((t) => normKey(t.url)))
  const frequent = new TopN(EMPTY_STATE_ROWS)
  for (const e of input.history) {
    const f = frecency(e, input.now)
    if (!frequent.accepts(f) || pastSearchOf(e) !== undefined) continue
    frequent.add({ r: historyRow(e, f), key: keyOf(e), strong: false, prio: 1 })
  }
  for (const c of frequent.items) {
    if (out.length >= EMPTY_STATE_ROWS) break
    if (c.key && open.has(c.key)) continue
    open.add(c.key as string)
    out.push(c.r)
  }
  if (out.length > 0) return out.slice(0, EMPTY_STATE_ROWS)
  // Fresh profile: a few useful actions and popular sites.
  for (const id of STARTER_ACTIONS) {
    const a = input.actions.find((x) => x.id === id)
    if (a) out.push(actionRow(a, 0))
  }
  for (const url of STARTER_SITES) {
    out.push({
      id: `starter:${url}`,
      kind: 'url',
      title: displayUrl(url),
      subtitle: 'Popular site',
      label: 'Suggested',
      url,
      score: 0,
    })
  }
  return out.slice(0, EMPTY_STATE_ROWS)
}
