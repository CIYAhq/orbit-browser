/**
 * Update checks (UP-01, UP-10, UP-12): the release feed format, version order and the rules for a
 * feed address. The main process checks (src/main/updates/); Settings and the sidebar show the result.
 *
 * Orbit has no update server of its own and no release feed is set up yet, so checks only run once a
 * feed address is set in Settings → General. It is empty by default: Orbit never checks, and test
 * and development runs never contact a server. A feed answers with JSON, either
 * - Orbit's own: `{ "version": "1.2.0", "url": "https://…", "summary": "…", "security": false }`, or
 * - a GitHub release as GitHub's REST API returns it (…/releases/latest), or a list of them
 *   (…/releases): `tag_name` is the version and `html_url` the page a click opens. Drafts and
 *   pre-releases are skipped, and "[security]" in a release's name or notes marks a security release.
 */

/** A release newer than this build, as the banner and Settings show it. */
export interface ReleaseInfo {
  /** "1.2.0" (no leading "v"). */
  version: string
  /** The release's page or download, opened in a tab (UP-10). */
  url: string
  /** One line about it (UP-06). */
  summary?: string
  /** It fixes a critical security issue: the banner says "Important security update" (UP-12). */
  security: boolean
}

/** What the last check found, or that one is running. `idle`: none yet, or checks are off. */
export type UpdateCheckState = 'idle' | 'checking' | 'current' | 'available' | 'failed'

/** Update status (`state.updates`): runtime only, never saved (src/main/persist.ts). */
export interface UpdateStatus {
  state: UpdateCheckState
  /** The newest release found that is newer than this build; kept when a later check fails. */
  latest?: ReleaseInfo
  /** When the last check finished. */
  checkedAt?: number
  /** Why the last check failed, in words. Background failures are silent: only Settings shows it. */
  error?: string
  /** The banner's ✕ (UP-02): hidden for that version until about 24 h later, or the next launch. */
  dismissed?: { version: string; until: number }
}

/** The What's new banner after an update (UP-06), until opened, dismissed or a few days old. */
export interface WhatsNew {
  version: string
  /** When this version first ran. */
  since: number
}

const VERSION_RE =
  /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/

interface Version {
  core: [number, number, number]
  pre: string[]
}

function parseVersion(text: unknown): Version | undefined {
  if (typeof text !== 'string' || text.length > 64) return undefined
  const m = VERSION_RE.exec(text.trim())
  if (!m) return undefined
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

/** "v1.2.0" → "1.2.0"; undefined for anything that isn't a version (semver, as Orbit's are). */
export function cleanVersion(text: unknown): string | undefined {
  if (!parseVersion(text)) return undefined
  return (text as string).trim().replace(/^v/, '').replace(/\+.*$/, '')
}

const NUMERIC = /^\d+$/

function comparePre(a: string[], b: string[]): number {
  // A release outranks its own pre-releases (1.0.0 > 1.0.0-beta.2).
  if (a.length === 0 || b.length === 0) return b.length - a.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xn = NUMERIC.test(x)
    const yn = NUMERIC.test(y)
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1
    if (xn !== yn) return xn ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

/** Version order (semver precedence): negative when a is older than b. NaN if either isn't a version. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return Number.NaN
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] as number) - (y.core[i] as number)
    if (d !== 0) return Math.sign(d)
  }
  return comparePre(x.pre, y.pre)
}

/** Whether `candidate` is a newer version than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'localhost' || host === '[::1]' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

export const MAX_FEED_URL = 2048

/**
 * Why a feed address can't be used, or '' when it can (an empty address too: it turns checks off).
 * Only https, or plain http to this computer; no user name or password in it. `loopbackOnly` (test
 * runs and unpackaged development builds) also refuses every other computer.
 */
export function feedUrlProblem(text: string, opts: { loopbackOnly?: boolean } = {}): string {
  const value = text.trim()
  if (value === '') return ''
  if (value.length > MAX_FEED_URL) return 'That address is too long.'
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'Enter a web address, like https://example.com/orbit/latest.json.'
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Use an https:// address.'
  if (url.username || url.password) return 'Leave the user name and password out of the address.'
  const local = isLoopbackHost(url.hostname)
  if (url.protocol === 'http:' && !local) return 'Use https:// (http:// only works for this computer).'
  if (opts.loopbackOnly && !local) return 'Test and development builds only check this computer.'
  return ''
}

/** A release page address a feed may send: https, or http to this computer. */
function pageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_FEED_URL) return undefined
  try {
    const url = new URL(value)
    if (url.username || url.password) return undefined
    if (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname))) return url.href
  } catch {}
  return undefined
}

const MAX_SUMMARY = 140

function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > MAX_SUMMARY ? `${one.slice(0, MAX_SUMMARY - 1).trimEnd()}…` : one
}

/** The first line of release notes that says something (Markdown marks and the version itself left out). */
function firstLine(notes: string, version: string): string | undefined {
  for (const raw of notes.split(/\r?\n/).slice(0, 40)) {
    const line = raw
      .replace(/^\s*(?:#+|[-*+>]|\d+\.)\s*/, '')
      .replace(/[*_`]/g, '')
      .replace(/\[security\]/gi, '')
      .trim()
    if (!line || line.replace(/^v/i, '') === version || /^(what'?s (new|changed)|changes|changelog)\b:?$/i.test(line))
      continue
    return clip(line)
  }
  return undefined
}

const SECURITY_MARK = /\[security\]/i

function githubRelease(r: Record<string, unknown>): ReleaseInfo | undefined {
  if (r.draft === true || r.prerelease === true) return undefined
  const version = cleanVersion(r.tag_name)
  const url = pageUrl(r.html_url)
  if (!version || !url) return undefined
  const name = typeof r.name === 'string' ? r.name : ''
  const body = typeof r.body === 'string' ? r.body.slice(0, 20_000) : ''
  const titled = name.replace(SECURITY_MARK, '').trim()
  const summary = titled && cleanVersion(titled) !== version ? clip(titled) : firstLine(body, version)
  return {
    version,
    url,
    ...(summary ? { summary } : {}),
    security: SECURITY_MARK.test(name) || SECURITY_MARK.test(body),
  }
}

function ownRelease(r: Record<string, unknown>): ReleaseInfo | undefined {
  const version = cleanVersion(r.version)
  const url = pageUrl(r.url)
  if (!version || !url) return undefined
  const summary = typeof r.summary === 'string' && r.summary.trim() ? clip(r.summary) : undefined
  return { version, url, ...(summary ? { summary } : {}), security: r.security === true }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Reads a feed's JSON: the newest release in it, `null` when it lists none (a project with no
 * releases yet), or undefined when it isn't a feed Orbit can read.
 */
export function parseFeed(json: unknown): ReleaseInfo | null | undefined {
  if (Array.isArray(json)) {
    let best: ReleaseInfo | null = null
    for (const item of json.slice(0, 100)) {
      const release = isRecord(item) ? githubRelease(item) : undefined
      if (release && (!best || isNewer(release.version, best.version))) best = release
    }
    return best
  }
  if (!isRecord(json)) return undefined
  if ('tag_name' in json) {
    // GitHub's "latest" is never a draft or pre-release; a single one that is offers nothing.
    if (json.draft === true || json.prerelease === true) return null
    return githubRelease(json)
  }
  if ('version' in json) return ownRelease(json)
  return undefined
}
