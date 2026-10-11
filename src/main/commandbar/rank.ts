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
import type { CommandBarMode, FolderId, SiteSearchEngine, SpaceId, SplitId, TabId } from '../../shared/state'
import { fillSearchTemplate, parseInput, SEARCH_ENGINES } from '../../shared/url'
import { frecency, type HostInfo, type IndexedEntry, urlKeyOf } from '../history/store'
import { type DocMatch, initials, matchDoc, matchName, PREFIX, terms as splitTerms } from './match'

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
  /** The split view the tab is a pane of: the split is one result, for its best-matching pane (SV-21). */
  splitId?: SplitId
  /** The split's name, or its panes' titles in reading order. */
  splitTitle?: string
  /** A named split also matches on its name. */
  splitNameLower?: string
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
  /** Target Space of a "Move to / Pin to [Space]" action (TB-11, PN-02, SP-22). */
  spaceId?: SpaceId
  /** Opens a Settings section or setting (CB-05, ST-02): its row says Settings, not Action. */
  settings?: boolean
}

/** Bar-only actions with a Space parameter; search.open carries them out. */
export const SPACE_ACTIONS = [
  { id: 'tab.moveToSpace', verb: 'Move to' },
  { id: 'tab.pinToSpace', verb: 'Pin to' },
] as const

/** "Move to [Space]" / "Pin to [Space]" for every other Space, when there is a current tab. */
function spaceActions(input: RankInput): ActionDoc[] {
  if (!input.activeTabId) return []
  const out: ActionDoc[] = []
  for (const s of input.spaces) {
    if (s.id === input.currentSpaceId) continue
    for (const { id, verb } of SPACE_ACTIONS) {
      const title = `${verb} ${s.name}`
      const titleLower = title.toLowerCase()
      out.push({
        id,
        title,
        titleLower,
        keywords: ['tab', 'space'],
        initials: initials(titleLower),
        needsTab: true,
        spaceId: s.id,
      })
    }
  }
  return out
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
  /** Keeps the score of the row it replaces when that is higher (a page closed a moment ago). */
  lift?: boolean
}

/** A page closed this recently ranks where its history row would (AR-09, TB-07), not after history. */
const RECENT_CLOSE_MS = 10 * 60_000

/** URL identity for dedupe: no scheme, no "www.", no fragment, no trailing slash. */
export function normKey(url: string): string {
  const key = urlKeyOf(url)
  const hash = key.indexOf('#')
  const noHash = hash >= 0 ? key.slice(0, hash) : key
  return noHash.endsWith('/') ? noHash.slice(0, -1) : noHash
}

/** Decoded text that stays escaped in row text: separators that change a URL's meaning, controls and bidi overrides. */
function unsafeDecoded(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x200e || c === 0x200f) return true
    if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return true
  }
  return /[/?#&=%+]/.test(text)
}

/** Compact, readable URL for row text: no scheme, no "www.", no trailing slash, safe %-escapes decoded (F9). */
export function displayUrl(url: string): string {
  if (/^(about|data|chrome|devtools|view-source|orbit):/i.test(url)) return url.slice(0, 300)
  let s = url.replace(/^https?:\/\//i, '').replace(/^www\./i, '')
  if (s.endsWith('/')) s = s.slice(0, -1)
  return s.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      const decoded = decodeURIComponent(run)
      return unsafeDecoded(decoded) ? run : decoded
    } catch {
      return run
    }
  })
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
    // F5: a host visited once by following a link (redirectors, newsletters…) is not completed.
    if (h.typedCount < 1 && h.visitCount < 2) continue
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

/**
 * An open tab's row. A split pane's row is the split's (SV-21): its name or its panes' titles, every
 * pane's favicon, "Switch to split"; choosing it shows the split with this pane focused.
 */
function tabRow(t: TabDoc, input: RankInput, score: number): SearchResult {
  const inSpace = t.spaceId === input.currentSpaceId || t.section === 'favorite'
  const spaceName = input.spaceNames[t.spaceId]
  const split = t.splitId
  return {
    id: split ? `split:${split}` : `tab:${t.id}`,
    kind: 'tab',
    title: (split ? t.splitTitle : t.title) || t.title || displayUrl(t.url),
    subtitle: inSpace || !spaceName ? displayUrl(t.url) : `${spaceName} · ${displayUrl(t.url)}`,
    label: sectionLabel(t),
    hint: split ? 'Switch to split' : 'Switch to tab',
    url: t.url,
    favicon: t.favicon,
    ...(t.splitFavicons ? { splitFavicons: t.splitFavicons } : {}),
    ...(split ? { splitId: split } : {}),
    tabId: t.id,
    spaceId: t.spaceId,
    score,
  }
}

/** The split the current tab is a pane of: like the current tab, it isn't offered (SV-21). */
function activeSplitOf(input: RankInput): SplitId | undefined {
  if (!input.activeTabId) return undefined
  return input.tabs.find((t) => t.id === input.activeTabId)?.splitId
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
    id: a.spaceId ? `action:${a.id}:${a.spaceId}` : `action:${a.id}`,
    kind: 'action',
    title: a.title,
    label: a.settings ? 'Settings' : 'Action',
    actionId: a.id,
    ...(a.spaceId ? { spaceId: a.spaceId } : {}),
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

// ---- Incremental narrowing ----

/**
 * The history entries that matched the previous query. When the next query only extends it (typing
 * forward), its matches are a subset, so only these are re-scored. Not when the previous last term
 * was a single letter: one letter only matches at word starts, two letters anywhere.
 */
let narrowing: { history: readonly IndexedEntry[]; lower: string; matched: IndexedEntry[] } | undefined

function historyPool(history: readonly IndexedEntry[], lower: string): readonly IndexedEntry[] {
  const n = narrowing
  // A typed scheme ("http" → "https://…", e.g. a paste) changes how the terms are read: start over.
  return n && n.history === history && lower.startsWith(n.lower) && !lower.includes('://') ? n.matched : history
}

function rememberMatches(history: readonly IndexedEntry[], lower: string, ts: string[], matched: IndexedEntry[]) {
  const last = ts[ts.length - 1] ?? ''
  narrowing = last.length >= 2 && !lower.includes('://') ? { history, lower, matched } : undefined
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
  const activeSplit = activeSplitOf(input)
  const tabs = new TopN(6)
  // A split is one row: its best-matching pane's (SV-21).
  const panes = new Map<SplitId, { t: TabDoc; score: number; strong: boolean }>()
  const paneKeys = new Map<SplitId, string[]>()
  for (const t of input.tabs) {
    if (t.splitId) paneKeys.set(t.splitId, [...(paneKeys.get(t.splitId) ?? []), keyOf(t)])
    if (t.id === input.activeTabId || (t.splitId && t.splitId === activeSplit)) continue
    let m = matchDoc(ts, t.titleLower, t.urlKey, t.pinnedKey)
    if (t.splitNameLower) {
      const named = matchName(ts, t.splitNameLower)
      if (named.score > m.score) m = named
    }
    if (m.score === 0) continue
    const score =
      600 +
      m.score +
      (m.hostPrefix ? 100 : 0) +
      (t.spaceId === input.currentSpaceId ? 20 : 0) +
      recencyBonus(t.lastActiveAt, now)
    if (t.splitId) {
      const best = panes.get(t.splitId)
      if (!best || score > best.score || (score === best.score && t.lastActiveAt > best.t.lastActiveAt))
        panes.set(t.splitId, { t, score, strong: m.strong })
      continue
    }
    if (!tabs.accepts(score)) continue
    tabs.add({ r: tabRow(t, input, score), key: keyOf(t), strong: m.strong, prio: 4 })
  }
  for (const { t, score, strong } of panes.values()) {
    if (tabs.accepts(score)) tabs.add({ r: tabRow(t, input, score), key: keyOf(t), strong, prio: 4 })
  }
  // The pages of a split listed as one row, or on screen in the current one, aren't offered again
  // from history or the Archive (as a listed tab's page isn't).
  const splitKeys = (id: SplitId | undefined) => (id && paneKeys.get(id)) || []
  const shown = new Set<string>(splitKeys(activeSplit))
  for (const c of tabs.items) for (const k of splitKeys(c.r.splitId)) shown.add(k)

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

    // "Open Recipes" opens the folder Recipes, as its name alone does (FD-09).
    const folderTerms = ts.length > 1 && ts[0] === 'open' ? ts.slice(1) : ts
    for (const f of input.folders ?? []) {
      const m = matchName(folderTerms, f.nameLower)
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
    const matched: IndexedEntry[] = []
    for (const e of historyPool(input.history, lower)) {
      const m = matchDoc(ts, e.titleLower, e.urlKey)
      if (m.score === 0) continue
      matched.push(e)
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
      if (key === activeKey || shown.has(key)) continue
      history.add({ r: historyRow(e, score), key, strong: m.strong, prio: 1 })
    }
    rememberMatches(input.history, lower, ts, matched)

    for (const a of input.archive) {
      const m = matchDoc(ts, a.titleLower, a.urlKey)
      if (m.score === 0) continue
      const score = 250 + m.score + recencyBonus(a.archivedAt, now)
      if (!archived.accepts(score)) continue
      const key = keyOf(a)
      if (key === activeKey || shown.has(key)) continue
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
        lift: now - a.archivedAt < RECENT_CLOSE_MS,
      })
    }

    for (const list of [input.actions, spaceActions(input)]) {
      for (const a of list) {
        if (a.needsTab && !input.activeTabId) continue
        const m = actionMatch(ts, lower, a)
        if (m.score === 0) continue
        // Its whole title typed beats a longer title that starts with it (Close Split, Close Split Pane).
        const exact = a.titleLower === ts.join(' ') ? 1 : 0
        actions.add({ r: actionRow(a, 150 + m.score + exact), strong: m.strong, prio: 0 })
      }
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
    const tab = input.tabs.find(
      (t) => t.id !== input.activeTabId && !(t.splitId && t.splitId === activeSplit) && keyOf(t) === topKey,
    )
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

  // The top row's split isn't listed again, for another of its panes or their pages.
  const topSplit = top?.splitId
  const topPages = new Set(splitKeys(topSplit))
  const rest = pool.filter(
    (c) =>
      c.r !== top &&
      (!topKey || c.key !== topKey) &&
      (!topSplit || (c.r.splitId !== topSplit && !(c.key && c.r.kind !== 'tab' && topPages.has(c.key)))),
  )
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
  // The words typed starting the title, in order ("clear archive" → Clear Archive…), beat the same
  // words matched one by one (Clear Today Tabs has the keyword "archive").
  if (ts.length > 1 && a.titleLower.startsWith(ts.join(' '))) return { score: PREFIX, strong: true, hostPrefix: false }
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

/**
 * Keeps one row per URL, preferring open tab > archived > history. The kept row takes its own
 * place in the order, not the dropped row's: rows that score the same stay in their kind's order
 * (the most recently archived tab first, review N3). A page closed a moment ago keeps its history
 * row's score (recently closed pages rank highly, AR-09).
 */
function dedupe(cands: Cand[]): Cand[] {
  const byKey = new Map<string, Cand>()
  const out: (Cand | undefined)[] = []
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
      const lifted = c.lift && seen.r.score > c.r.score ? { r: { ...c.r, score: seen.r.score } } : {}
      const kept = { ...c, strong: c.strong || seen.strong, ...lifted }
      out[out.indexOf(seen)] = undefined
      out.push(kept)
      byKey.set(c.key, kept)
    }
  }
  return out.filter((c): c is Cand => c !== undefined)
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
  for (const a of [...input.actions, ...spaceActions(input)]) {
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
  const activeSplit = activeSplitOf(input)
  // A split once, for its pane used last (SV-21).
  const splits = new Set<SplitId>()
  const out: TabDoc[] = []
  const recent = input.tabs
    .filter((t) => t.id !== input.activeTabId && t.url && t.url !== 'about:blank')
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  for (const t of recent) {
    if (out.length >= n) break
    if (t.splitId) {
      if (t.splitId === activeSplit || splits.has(t.splitId)) continue
      splits.add(t.splitId)
    }
    out.push(t)
  }
  return out.map((t, i) => tabRow(t, input, 100 - i))
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
