import type { CommandBarMode, FolderId, SiteSearchEngine, SpaceId, TabId } from '../state'

/**
 * What a command bar row does when chosen (CB-06):
 * - `tab`: switch to an open tab (also pinned items and Favorites, awake or not)
 * - `history` / `url`: open a page (new tab, or the current tab in edit-URL mode)
 * - `archived`: restore an archived tab into Today of its Space
 * - `search`: search the default engine for the typed text
 * - `suggestion`: search for a suggested query (a past search, or the engine's suggestion)
 * - `sitesearch`: enter site-search mode for a site (same as pressing Tab, CB-11)
 * - `action`: run a browser action (CB-13)
 * - `space`: switch to a Space
 * - `folder`: open (expand) a folder and show its Space (FD-09)
 * - `current`: the current page in edit-URL mode (Enter reloads it, CB-03)
 * - `paste`: open the URL on the clipboard (CB-12)
 */
export type SearchResultKind =
  | 'tab'
  | 'history'
  | 'url'
  | 'archived'
  | 'search'
  | 'suggestion'
  | 'sitesearch'
  | 'action'
  | 'space'
  | 'folder'
  | 'current'
  | 'paste'

export interface SearchResult {
  /** Stable identity across keystrokes (React key); rows that stay keep their DOM node. */
  id: string
  kind: SearchResultKind
  title: string
  /** Secondary text: URL, engine name, Space name… */
  subtitle?: string
  /** Short kind label shown on the row ("Tab", "History", "Action"…). */
  label: string
  /** Trailing hint, e.g. "Switch to tab" or "Reload". */
  hint?: string
  url?: string
  favicon?: string
  /** Favicons of every pane when the tab is part of a split view (CB-06). */
  splitFavicons?: (string | null)[]
  tabId?: TabId
  spaceId?: SpaceId
  folderId?: FolderId
  /** Emoji/icon of a Space row. */
  spaceIcon?: string
  actionId?: string
  /** Display form of the action's shortcut (CB-13). */
  shortcut?: string
  archiveId?: string
  siteSearchId?: string
  /** Text searched by `search`/`suggestion` rows. */
  query?: string
  /** History and past-search rows can be removed from history (CB-17). */
  removable?: boolean
  /** Higher is better (debug/tuning only; the list order is what counts). */
  score: number
}

/** Site search target (CB-11): a keyword plus a results URL template with %s. */
export interface SiteSearchInfo {
  id: string
  name: string
  keyword: string
}

export interface SearchQueryArgs {
  /** What the user typed (without the inline completion). */
  query: string
  mode: CommandBarMode
  /** Scoped site search chip (CB-11). */
  siteSearchId?: string
  /** Actions-only mode (CB-14). */
  actionsOnly?: boolean
  /** The last edit removed text, so don't add an inline completion again (CB-08). */
  noAutocomplete?: boolean
}

export interface SearchResponse {
  results: SearchResult[]
  /** Inline completion (CB-08): `text` starts with the typed query (case-insensitive). */
  autocomplete?: { text: string; url: string }
  /** The site search Tab would enter for this text (CB-11). */
  tabTarget?: SiteSearchInfo
  /** Search engine used for plain text, for the input placeholder and search row. */
  engineName: string
}

export type OpenDisposition = 'current' | 'new-tab' | 'split'

/** Owned by the command bar lane. */
export interface CommandBarCommands {
  'search.query': { args: SearchQueryArgs; result: SearchResponse }
  'search.open': {
    args: {
      result: SearchResult
      mode: CommandBarMode
      /** `new-tab` forces a new tab (⌘/Ctrl+Enter; ⌥/Alt+Enter on a tab row opens a fresh copy). */
      disposition?: OpenDisposition
      /** ⇧Enter on a search: open the first result directly if enabled and supported (CB-16). */
      topResult?: boolean
    }
    result: void
  }
  /** Deletes a history or past-search row from history (CB-17). */
  'search.remove': { args: { result: SearchResult }; result: void }
  /** Search-engine suggestions for the text (CB-15); [] unless settings.searchSuggestions is on. */
  'search.suggest': { args: { query: string }; result: SearchResult[] }
  /** CB-20: a click on the backdrop over the sidebar closes the bar and reaches the sidebar. */
  'search.forwardClick': { args: { x: number; y: number }; result: void }
  /** Site searches available for the Tab chip (CB-11). */
  'search.siteSearches': { args: Record<string, never>; result: SiteSearchInfo[] }
}

/** The site search that Tab enters for this text: its keyword, or the start of its name (CB-11). */
export function findSiteSearch(sites: readonly SiteSearchEngine[], text: string): SiteSearchInfo | undefined {
  const lower = text.trim().toLowerCase()
  if (!lower || /\s/.test(lower)) return undefined
  const site =
    sites.find((s) => s.keyword.toLowerCase() === lower) ??
    (lower.length >= 2 ? sites.find((s) => s.name.toLowerCase().startsWith(lower)) : undefined)
  return site ? { id: site.id, name: site.name, keyword: site.keyword } : undefined
}

/**
 * Adds engine suggestions to the local results without moving the highlighted
 * row (FL-17): they only fill free slots below, never replace a row, and skip
 * texts already shown.
 */
export function mergeSuggestions(rows: SearchResult[], suggestions: SearchResult[], max: number): SearchResult[] {
  if (rows.length >= max || suggestions.length === 0) return rows
  const seen = new Set(rows.map((r) => (r.query ?? '').toLowerCase()).filter(Boolean))
  const ids = new Set(rows.map((r) => r.id))
  const out = [...rows]
  for (const s of suggestions) {
    if (out.length >= max) break
    const key = (s.query ?? s.title).toLowerCase()
    if (seen.has(key) || ids.has(s.id)) continue
    seen.add(key)
    ids.add(s.id)
    out.push(s)
  }
  return out.length === rows.length ? rows : out
}
