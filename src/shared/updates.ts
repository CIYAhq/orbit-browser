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
 *
 * A release can also carry the file that updates Orbit on each system (UP-01, UP-05): in Orbit's
 * feed, `"files": { "linux-x64": { "url": "https://…/orbit-1.2.0-linux-x64.tar.gz", "sha256": "…",
 * "size": 123 } }`; in a GitHub release, an asset named `…-linux-x64.tar.gz` with its SHA-256
 * digest. Linux takes a .tar.gz of the app's folder, macOS a .zip of Orbit.app and Windows the
 * installer (.exe). Without one for this system, a newer version opens its page instead (UP-10).
 */

/** The file that updates this copy of Orbit to a release, on this system (UP-01, UP-05). */
export interface UpdatePackage {
  url: string
  /** Its SHA-256, in hex: a download that doesn't match is thrown away. */
  sha256: string
  /** Its size in bytes. */
  size: number
}

/** The largest update file Orbit downloads. */
export const MAX_PACKAGE_BYTES = 1024 ** 3

/** The key a release lists a system's file under: "linux-x64", "darwin-arm64", "win32-x64"… */
export const systemKey = (platform: string, arch: string): string => `${platform}-${arch}`

/** The kind of file each system updates from. */
const PACKAGE_EXT: Record<string, string> = { linux: '.tar.gz', darwin: '.zip', win32: '.exe' }

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
  /** The file that updates Orbit to it on this system, when the feed has one. */
  package?: UpdatePackage
}

/**
 * What the last check found, or that one is running. `idle`: none yet, or checks are off.
 * `downloading`: the newer version's file is coming in the background; `ready`: it has come, matches
 * its SHA-256 and waits for a relaunch (UP-02, UP-05).
 */
export type UpdateCheckState = 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'failed'

/** Update status (`state.updates`): runtime only, never saved (src/main/persist.ts). */
export interface UpdateStatus {
  state: UpdateCheckState
  /** The newest release found that is newer than this build; kept when a later check fails. */
  latest?: ReleaseInfo
  /**
   * Whether Orbit installs `latest` itself: it has a file for this system, and this copy can replace
   * itself (an installed build). Otherwise a click opens the release's page (UP-10).
   */
  installable?: boolean
  /** While downloading: how much has come, from 0 to 1. */
  progress?: number
  /**
   * Why the last download of `latest` failed, in words (UP-01): Settings shows it with Download to
   * try again; the next check tries again by itself. Nothing else shows it.
   */
  downloadError?: string
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
  /** The release's one line, when Orbit updated itself to it. */
  summary?: string
  /** Its page, when Orbit updated itself to it. */
  url?: string
}

/** The update a relaunch installs (UP-05): the next start shows its What's new (UP-06). */
export interface PendingUpdate {
  version: string
  summary?: string
  url?: string
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

/** A system's update file, if it is one Orbit can take: https (or this computer), its kind, a SHA-256 and a size. */
function updatePackage(url: unknown, sha256: unknown, size: unknown, system: string): UpdatePackage | undefined {
  const href = pageUrl(url)
  const ext = PACKAGE_EXT[system.split('-')[0] ?? '']
  if (!href || !ext || !new URL(href).pathname.toLowerCase().endsWith(ext)) return undefined
  const hash = typeof sha256 === 'string' ? sha256.trim().toLowerCase() : ''
  if (!/^[0-9a-f]{64}$/.test(hash)) return undefined
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > MAX_PACKAGE_BYTES) return undefined
  return { url: href, sha256: hash, size }
}

/** A GitHub release's asset for this system: named `…-<system><ext>`, with GitHub's SHA-256 digest. */
function githubPackage(assets: unknown, system: string): UpdatePackage | undefined {
  if (!Array.isArray(assets)) return undefined
  const ending = `-${system}${PACKAGE_EXT[system.split('-')[0] ?? ''] ?? ''}`.toLowerCase()
  for (const asset of assets.slice(0, 100)) {
    if (!isRecord(asset) || typeof asset.name !== 'string' || !asset.name.toLowerCase().endsWith(ending)) continue
    const digest = typeof asset.digest === 'string' ? asset.digest.replace(/^sha256:/i, '') : undefined
    const found = updatePackage(asset.browser_download_url, digest, asset.size, system)
    if (found) return found
  }
  return undefined
}

function githubRelease(r: Record<string, unknown>, system?: string): ReleaseInfo | undefined {
  if (r.draft === true || r.prerelease === true) return undefined
  const version = cleanVersion(r.tag_name)
  const url = pageUrl(r.html_url)
  if (!version || !url) return undefined
  const name = typeof r.name === 'string' ? r.name : ''
  const body = typeof r.body === 'string' ? r.body.slice(0, 20_000) : ''
  const titled = name.replace(SECURITY_MARK, '').trim()
  const summary = titled && cleanVersion(titled) !== version ? clip(titled) : firstLine(body, version)
  const pkg = system ? githubPackage(r.assets, system) : undefined
  return {
    version,
    url,
    ...(summary ? { summary } : {}),
    security: SECURITY_MARK.test(name) || SECURITY_MARK.test(body),
    ...(pkg ? { package: pkg } : {}),
  }
}

function ownRelease(r: Record<string, unknown>, system?: string): ReleaseInfo | undefined {
  const version = cleanVersion(r.version)
  const url = pageUrl(r.url)
  if (!version || !url) return undefined
  const summary = typeof r.summary === 'string' && r.summary.trim() ? clip(r.summary) : undefined
  const file = system && isRecord(r.files) ? r.files[system] : undefined
  const pkg = isRecord(file) ? updatePackage(file.url, file.sha256, file.size, system as string) : undefined
  return {
    version,
    url,
    ...(summary ? { summary } : {}),
    security: r.security === true,
    ...(pkg ? { package: pkg } : {}),
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Reads a feed's JSON: the newest release in it, `null` when it lists none (a project with no
 * releases yet), or undefined when it isn't a feed Orbit can read. With `system` (systemKey), a
 * release carries its update file for that system, if it has one.
 */
export function parseFeed(json: unknown, system?: string): ReleaseInfo | null | undefined {
  if (Array.isArray(json)) {
    let best: ReleaseInfo | null = null
    for (const item of json.slice(0, 100)) {
      const release = isRecord(item) ? githubRelease(item, system) : undefined
      if (release && (!best || isNewer(release.version, best.version))) best = release
    }
    return best
  }
  if (!isRecord(json)) return undefined
  if ('tag_name' in json) {
    // GitHub's "latest" is never a draft or pre-release; a single one that is offers nothing.
    if (json.draft === true || json.prerelease === true) return null
    return githubRelease(json, system)
  }
  if ('version' in json) return ownRelease(json, system)
  return undefined
}
