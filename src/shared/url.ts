import type { SearchEngineId } from './state'

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
}

export function searchUrl(engine: SearchEngineId, query: string): string {
  return fillSearchTemplate(SEARCH_ENGINES[engine].search, query)
}

/**
 * URL that jumps straight to an engine's first result (CB-16), or undefined when
 * the engine has no reliable way to do it: only DuckDuckGo's "\" prefix qualifies
 * (Google's lucky parameter often stops at a redirect notice).
 */
export function topResultUrl(engine: SearchEngineId, query: string): string | undefined {
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
export function parseInput(raw: string, engine: SearchEngineId = 'google'): ParsedInput {
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

/** How much of an address without a host the address pill shows. */
const HOSTLESS_MAX = 40

/**
 * Short, human display of a URL for the sidebar address pill: host without www. Addresses without
 * a host say what they are (review A-F2): a page's source as the page's host, a blob as the host of
 * the page that made it, a data: page by its type, never its content.
 */
export function displayHost(url: string): string {
  try {
    const u = new URL(url)
    if (u.protocol === 'about:') return url
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname.split('/').pop() || 'file')
    if (u.protocol === 'view-source:') return `view-source:${displayHost(url.slice(u.protocol.length))}`
    if (u.protocol === 'blob:') return u.origin === 'null' ? 'blob:' : displayHost(u.origin)
    if (u.protocol === 'data:') return `data:${u.pathname.split(/[;,]/)[0]?.trim().toLowerCase() || 'text/plain'}`
    if (u.host) return u.host.replace(/^www\./, '')
    return url.length > HOSTLESS_MAX ? `${url.slice(0, HOSTLESS_MAX - 1)}…` : url
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
