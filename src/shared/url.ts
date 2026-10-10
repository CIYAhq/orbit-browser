import { DEFAULT_PROFILE_ID } from './defaults'
import type { OrbitState, ProfileId, SearchEngineId, SpaceId, WindowId } from './state'

export interface SearchEngine {
  id: SearchEngineId
  name: string
  /** %s is replaced by the URI-encoded query. */
  search: string
  /** Suggestion endpoint returning OpenSearch JSON ([query, [suggestions...]]). */
  suggest?: string
}

export const SEARCH_ENGINES: Record<SearchEngineId, SearchEngine> = {
  google: {
    id: 'google',
    name: 'Google',
    search: 'https://www.google.com/search?q=%s',
    suggest: 'https://suggestqueries.google.com/complete/search?client=firefox&q=%s',
  },
  duckduckgo: {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    search: 'https://duckduckgo.com/?q=%s',
    suggest: 'https://duckduckgo.com/ac/?type=list&q=%s',
  },
  bing: {
    id: 'bing',
    name: 'Bing',
    search: 'https://www.bing.com/search?q=%s',
    suggest: 'https://api.bing.com/osjson.aspx?query=%s',
  },
  brave: {
    id: 'brave',
    name: 'Brave Search',
    search: 'https://search.brave.com/search?q=%s',
    suggest: 'https://search.brave.com/api/suggest?q=%s',
  },
  ecosia: {
    id: 'ecosia',
    name: 'Ecosia',
    search: 'https://www.ecosia.org/search?q=%s',
    suggest: 'https://ac.ecosia.org/autocomplete?type=list&q=%s',
  },
  kagi: {
    id: 'kagi',
    name: 'Kagi',
    search: 'https://kagi.com/search?q=%s',
  },
  startpage: {
    id: 'startpage',
    name: 'Startpage',
    search: 'https://www.startpage.com/sp/search?query=%s',
  },
  perplexity: {
    id: 'perplexity',
    name: 'Perplexity',
    search: 'https://www.perplexity.ai/search?q=%s',
  },
}

// ---- Default search engines (ST-06) ----
//
// Each profile has one: a built-in engine or one of the site searches (custom engines). A profile
// without its own choice uses the Default profile's, then `settings.searchEngine`. Everywhere a typed
// query becomes a search resolves the engine here, for the profile of the Space it was typed in.

/** An engine a query can go to. */
export interface EngineChoice {
  /** A built-in engine id ("google"), or "site:<id>" for a site search. */
  id: string
  name: string
  /** Results URL; %s is the query. */
  search: string
  /** Suggestion endpoint (built-in engines only, CB-15). */
  suggest?: string
}

type EngineState = Pick<OrbitState, 'settings' | 'profiles'>

const SITE_ENGINE = 'site:'

/** The engine id that makes a site search a profile's default engine. */
export function siteEngineId(siteSearchId: string): string {
  return `${SITE_ENGINE}${siteSearchId}`
}

export function isBuiltInEngine(id: unknown): id is SearchEngineId {
  return typeof id === 'string' && Object.hasOwn(SEARCH_ENGINES, id)
}

/** The engine an id names, if it still exists. */
export function engineById(state: Pick<OrbitState, 'settings'>, id: string | undefined): EngineChoice | undefined {
  if (!id) return undefined
  if (id.startsWith(SITE_ENGINE)) {
    const siteId = id.slice(SITE_ENGINE.length)
    const site = (state.settings.siteSearch ?? []).find((s) => s.id === siteId)
    return site ? { id, name: site.name, search: site.url } : undefined
  }
  return isBuiltInEngine(id) ? SEARCH_ENGINES[id] : undefined
}

/** A profile's default search engine (ST-06). */
export function engineFor(state: EngineState, profileId: ProfileId | undefined): EngineChoice {
  return (
    engineById(state, profileId ? state.profiles[profileId]?.searchEngine : undefined) ??
    engineById(state, state.profiles[DEFAULT_PROFILE_ID]?.searchEngine) ??
    SEARCH_ENGINES[state.settings.searchEngine] ??
    SEARCH_ENGINES.google
  )
}

/** The engine for queries typed in a Space: its profile's. */
export function engineForSpace(
  state: EngineState & Pick<OrbitState, 'spaces'>,
  spaceId: SpaceId | undefined,
): EngineChoice {
  return engineFor(state, spaceId ? state.spaces[spaceId]?.profileId : undefined)
}

/** The engine for queries typed in a window: the profile of the Space it shows. */
export function engineForWindow(
  state: EngineState & Pick<OrbitState, 'spaces' | 'windows'>,
  windowId: WindowId | undefined,
): EngineChoice {
  return engineForSpace(state, windowId ? state.windows[windowId]?.spaceId : undefined)
}

/** A search engine for a typed query: a built-in engine's id, or any engine's results URL (%s = query). */
export type SearchWith = SearchEngineId | { search: string }

export function searchUrl(engine: SearchWith, query: string): string {
  const template = typeof engine === 'string' ? (SEARCH_ENGINES[engine] ?? SEARCH_ENGINES.google).search : engine.search
  return fillSearchTemplate(template, query)
}

/**
 * URL that jumps straight to an engine's first result (CB-16), or undefined when
 * the engine has no reliable way to do it: only DuckDuckGo's "\" prefix qualifies
 * (Google's lucky parameter often stops at a redirect notice).
 */
export function topResultUrl(engine: string, query: string): string | undefined {
  const q = encodeURIComponent(query).replace(/%20/g, '+')
  if (engine === 'duckduckgo') return `https://duckduckgo.com/?q=%5C${q}`
  return undefined
}

/**
 * Puts a query into a search URL template (%s). In the query string spaces
 * become "+" (form encoding, e.g. `?q=orbit+test`); in a path they are %20.
 */
export function fillSearchTemplate(template: string, query: string): string {
  const at = template.indexOf('%s')
  const q =
    template.lastIndexOf('?', at) >= 0 ? encodeURIComponent(query).replace(/%20/g, '+') : encodeURIComponent(query)
  return template.replace('%s', q)
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/
const HOST_RE = /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,63}|\[[0-9a-f:]+\])(:\d{1,5})?([/?#].*)?$/i
const LOCAL_RE = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?([/?#].*)?$/i
const ALLOWED_SCHEMES = new Set([
  'http:',
  'https:',
  'file:',
  'about:',
  'data:',
  'view-source:',
  'chrome:',
  'devtools:',
  'orbit:',
])

export type ParsedInput = { kind: 'url'; url: string } | { kind: 'search'; query: string; url: string }

/**
 * Turns what the user typed into the command bar into a URL to load:
 * full URLs pass through, bare hosts get a scheme, everything else is a search.
 */
export function parseInput(raw: string, engine: SearchWith = 'google'): ParsedInput {
  const text = raw.trim()
  if (!text) return { kind: 'search', query: '', url: searchUrl(engine, '') }
  const hasSpace = /\s/.test(text)
  if (!hasSpace && SCHEME_RE.test(text)) {
    try {
      const u = new URL(text)
      if (ALLOWED_SCHEMES.has(u.protocol)) return { kind: 'url', url: u.href }
      // "localhost:3000" parses with scheme "localhost:"; fall through to host check.
    } catch {
      // not a URL, fall through
    }
  }
  if (!hasSpace && (HOST_RE.test(text) || IPV4_RE.test(text))) {
    const scheme = LOCAL_RE.test(text) || IPV4_RE.test(text) ? 'http://' : 'https://'
    try {
      return { kind: 'url', url: new URL(scheme + text).href }
    } catch {
      // fall through to search
    }
  }
  return { kind: 'search', query: text, url: searchUrl(engine, text) }
}

/** Short, human display of a URL for the sidebar address pill: host without www. */
export function displayHost(url: string): string {
  try {
    const u = new URL(url)
    if (u.protocol === 'about:') return url
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname.split('/').pop() || 'file')
    return u.host.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

/** Registrable-ish domain used to decide whether a link is "external" to a pinned tab. */
export function siteOf(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    const parts = host.split('.')
    if (parts.length <= 2 || /^\d+$/.test(parts[parts.length - 1] ?? '')) return host
    const sld = parts[parts.length - 2] ?? ''
    // co.uk, com.au style second-level public suffixes
    if (sld.length <= 3 && (parts[parts.length - 1]?.length ?? 0) === 2) return parts.slice(-3).join('.')
    return parts.slice(-2).join('.')
  } catch {
    return url
  }
}

export function fallbackTitle(url: string): string {
  if (!url || url === 'about:blank') return 'New Tab'
  return displayHost(url) || url
}
