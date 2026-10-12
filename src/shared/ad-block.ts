/**
 * Ad and tracker blocking (OB-06): which requests Orbit stops. Shared by main's blocker
 * (src/main/settings/ad-block.ts) and the tests; the list of servers is src/main/settings/ad-hosts.ts.
 */

/** What the site controls panel shows about blocking on a tab's site (OB-06). */
export interface AdBlockSite {
  /** "Block ads and trackers" is on in Settings. */
  on: boolean
  /** The user turned blocking off for this site. */
  allowed: boolean
  /** Requests stopped for the page shown, since it started loading. */
  blocked: number
}

/** A host name as the list keeps it: lowercase, without a trailing dot. */
export function normalHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '')
}

/** The host of a web address (http, https, ws, wss), or null for anything else. */
function hostOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return /^(?:https?|wss?):$/.test(u.protocol) && u.hostname ? normalHost(u.hostname) : null
  } catch {
    return null
  }
}

/**
 * The site a choice to allow ads is kept for: the page's host name (no port), for web pages only.
 * Blocking can be turned off for it in the site controls panel.
 */
export function adSiteOf(url: string | undefined): string | null {
  if (!url || !/^https?:/i.test(url)) return null
  return hostOf(url)
}

/** The entry of the list that a host is, or is a subdomain of; null when it is on none. */
export function listedEntry(host: string, list: ReadonlySet<string>): string | null {
  let h = normalHost(host)
  for (;;) {
    if (list.has(h)) return h
    const dot = h.indexOf('.')
    if (dot < 0) return null
    h = h.slice(dot + 1)
  }
}

/**
 * Whether a request is stopped: it goes to a server on the list, for a page of another site. The
 * tab's own navigation never is (the user chose to go there), nor is a listed site's own page
 * loading from its own servers.
 */
export function shouldBlock(
  request: { url: string; mainFrame: boolean; page?: string },
  list: ReadonlySet<string>,
): boolean {
  if (request.mainFrame) return false
  const host = hostOf(request.url)
  const entry = host ? listedEntry(host, list) : null
  if (!entry) return false
  const page = hostOf(request.page)
  return !page || listedEntry(page, list) !== entry
}

/**
 * The URL patterns for the session's request filter: only requests to a listed server (or one of
 * its subdomains) reach the blocker, and every other request goes by without waiting for it.
 */
export function blockPatterns(list: Iterable<string>): string[] {
  return [...list].map((host) => `*://*.${host}/*`)
}
