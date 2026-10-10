/**
 * Where a clicked link opens: the Peek rules (PK-02, PK-03, PK-04, PK-12, PK-16), Mini Window
 * clicks (MW-07) and link routing rules (ST-09). Pure, so it is unit-tested; the main process
 * describes the click (how, from where) and acts on the answer.
 */
import type { LinkRule, SpaceId, TabSection } from './state'
import { siteOf } from './url'

/**
 * How the page asked to open the link:
 * - `navigate`: a plain click that would load in the same tab;
 * - `new-tab`: target=_blank or window.open() (a foreground tab);
 * - `background-tab`: ⌘/Ctrl-click or middle-click;
 * - `shift`: Shift-click (the engine's "new window");
 * - `mini`: ⌘⌥-click (Ctrl+Alt-click elsewhere);
 * - `popup`: window.open() with window features (sign-in pop-ups and the like).
 */
export type LinkHow = 'navigate' | 'new-tab' | 'background-tab' | 'shift' | 'mini' | 'popup'

/** The page the link was clicked in. */
export type LinkSource =
  | { kind: 'tab'; section: TabSection | undefined; url: string }
  | { kind: 'peek'; url: string }
  | { kind: 'mini'; url: string }

export type LinkDecision =
  /** Show it in the window's Peek card (opening one). */
  | { to: 'peek' }
  /** Load it in the page it was clicked in (a Peek or Mini Window keeps its links). */
  | { to: 'self' }
  /** A new Mini Window. */
  | { to: 'mini' }
  /** A new selected tab, in a Space a routing rule names or else the window's Space. */
  | { to: 'tab'; spaceId?: SpaceId }
  /** Nothing special: the tab navigates, or the usual new-tab handling applies. */
  | { to: 'default' }

export interface LinkSettings {
  peekExternalLinks: boolean
  peekShiftClick: boolean
  linkRules: readonly LinkRule[]
}

export function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/** A local file's address: `file:`, or the source view of one. */
export function isLocalFileUrl(url: string): boolean {
  return /^(view-source:)?file:/i.test(url.trim())
}

/**
 * Whether Orbit may itself load or save `url` for the page at `from`: a local file only for a page
 * that is a local file too, as the engine allows a plain click (D49). `from` is empty when the page
 * isn't known. Other addresses are left to each route's own rules. The one check on every route where
 * Orbit loads what a page chose, whatever the engine allows: the page menu, ⌥-click and its frame's
 * download, a dropped link, and through `framesMayOpen` the windows, tabs and pop-ups a page asks
 * for, its blocked pop-ups and Save Page As… (round 2 fix check F1).
 */
export function pageMayOpen(from: string | undefined, url: string): boolean {
  return !isLocalFileUrl(url) || /^file:/i.test(from?.trim() ?? '')
}

/** A page as the main process sees it: every frame in it, the top one too, each with its origin. */
export interface PageFrames {
  readonly mainFrame: { readonly framesInSubtree: readonly { readonly origin: string }[] }
}

/**
 * `pageMayOpen` for a page that asked for `url` from a frame Orbit can't name: a new window, tab or
 * pop-up it requested (a modified click, a `target=_blank` link, `window.open`), a pop-up blocked on
 * it, or a save of it (D49; round 2 fix check M1, F1). A local file only when every frame may open
 * it, by each frame's origin: any frame whose origin isn't a local file's counts as a web page, a web
 * page's (F2) or an opaque one (a sandboxed or `data:` frame), even one the page made itself; an
 * about:blank or srcdoc frame a local page made has the page's origin and counts as local. A page
 * that went away opens no local file.
 */
export function framesMayOpen(page: PageFrames, url: string): boolean {
  if (pageMayOpen(undefined, url)) return true
  try {
    return page.mainFrame.framesInSubtree.every((frame) => pageMayOpen(frame.origin, url))
  } catch {
    return false
  }
}

/**
 * The toast for a local file Orbit refused to open for a page (D49): it names the file, so a click
 * that opens nothing says why (round 3 fix check F1).
 */
export function localFileBlockedMessage(url: string): string {
  return `Local file blocked: ${fileNameOf(url)}`
}

/** A local file's name, from its address (the last part of its path, decoded). */
function fileNameOf(url: string): string {
  let path: string
  try {
    path = new URL(url.trim().replace(/^view-source:/i, '')).pathname
  } catch {
    return url
  }
  const name = path.split('/').filter(Boolean).at(-1)
  if (!name) return url
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

/** Same registrable domain (eTLD+1): `mail.example.com` and `docs.example.com` are one site (PK-02). */
export function sameSite(a: string, b: string): boolean {
  if (!isWebUrl(a) || !isWebUrl(b)) return false
  return siteOf(a).toLowerCase() === siteOf(b).toLowerCase()
}

/** Video meeting join links, which never open in Peek so a call can't be lost to a stray click (PK-04). */
export function isMeetingLink(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (!/^https?:$/.test(u.protocol)) return false
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const path = u.pathname.toLowerCase()
  const under = (domain: string) => host === domain || host.endsWith(`.${domain}`)
  if (host === 'meet.google.com') return path.length > 1 && !path.startsWith('/_')
  if (under('zoom.us') || under('zoomgov.com')) return /^\/(j|s|w|my|wc)\//.test(path)
  if (host === 'teams.microsoft.com' || host === 'teams.live.com') {
    return path.startsWith('/l/meetup-join') || path.startsWith('/meet') || path.startsWith('/v2/')
  }
  if (under('webex.com')) return /\/(meet|join|j\.php|wbxmjs)/.test(path)
  if (host === 'meet.jit.si') return path.length > 1
  if (host === 'whereby.com') return path.length > 1 && !path.startsWith('/information')
  if (host === 'chime.aws' || host === 'app.chime.aws') return path.length > 1
  if (host === 'facetime.apple.com') return path.startsWith('/join')
  if (host === 'app.slack.com') return path.startsWith('/huddle')
  if (under('gotomeeting.com') || host === 'meet.goto.com') return path.length > 1
  return false
}

/** The Space a routing rule sends a URL to, if any rule matches (first rule wins). */
export function routeFor(rules: readonly LinkRule[], url: string): SpaceId | undefined {
  const lower = url.toLowerCase()
  for (const rule of rules) {
    const value = rule.value.trim().toLowerCase()
    if (!value) continue
    if (rule.match === 'exact' ? sameUrl(lower, value) : lower.includes(value)) return rule.spaceId
  }
  return undefined
}

function sameUrl(a: string, b: string): boolean {
  const strip = (u: string) => u.replace(/^https?:\/\//, '').replace(/\/$/, '')
  return strip(a) === strip(b)
}

const isPinnedLike = (section: TabSection | undefined) => section === 'pinned' || section === 'favorite'

/** Decides where a link clicked in a page opens. */
export function decideLink(how: LinkHow, source: LinkSource, url: string, settings: LinkSettings): LinkDecision {
  if (!isWebUrl(url)) return { to: 'default' }
  if (how === 'mini') return { to: 'mini' }
  if (how === 'popup') return { to: 'default' }
  const meeting = isMeetingLink(url)
  if (source.kind === 'mini') {
    // A Mini Window already is the light view: no Peek in it (PK-16). Links that would open a tab
    // stay in it; Shift-click keeps the engine's "new window" (another Mini Window).
    if (how === 'new-tab') return { to: 'self' }
    if (how === 'shift') return { to: 'mini' }
    return { to: 'default' }
  }
  if (source.kind === 'peek') {
    // Another Peek-eligible link inside the Peek navigates the Peek (PK-01); calls leave it (PK-04).
    if (meeting && how !== 'background-tab') return { to: 'tab' }
    if (how === 'new-tab' || how === 'shift') return { to: 'self' }
    return { to: 'default' }
  }
  if (how === 'background-tab') return { to: 'default' }
  const otherSite = !sameSite(source.url, url)
  const fromPinned = isPinnedLike(source.section) && otherSite && (how === 'navigate' || how === 'new-tab')
  const wantsPeek = (how === 'shift' && settings.peekShiftClick) || (fromPinned && settings.peekExternalLinks)
  if (!wantsPeek) {
    // With Peek off, a pinned tab or Favorite still doesn't wander off to another site: new Today tab (PK-12).
    if (fromPinned) return { to: 'tab' }
    return { to: 'default' }
  }
  const routed = routeFor(settings.linkRules, url)
  if (routed) return { to: 'tab', spaceId: routed }
  if (meeting) return { to: 'tab' }
  return { to: 'peek' }
}
