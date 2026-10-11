/**
 * What a page asks of the user, shown in Orbit's own dialogs over that page (pages lane, NV-24):
 * the page's `alert`, `confirm` and `prompt`, "Leave site?" before a page that asks for it goes,
 * HTTP sign-in, "Page unresponsive" (NV-14) and "Open Mail?" for a link to another app (NV-19).
 * And what the page's area shows when the page couldn't load or crashed (NV-13, NV-14).
 */
import { siteLabel } from './site'

/**
 * The kinds of page dialog. `leave` and `reload` are the leave-page warning (`beforeunload`),
 * `hang` the page that stopped responding, `app` a link that opens another app.
 */
export type PageDialogKind = 'alert' | 'confirm' | 'prompt' | 'leave' | 'reload' | 'auth' | 'hang' | 'app'

/** What a dialog view shows. */
export interface PageDialogContent {
  id: number
  kind: PageDialogKind
  /** "localhost:3000 says", "Leave site?", "Sign in". */
  title: string
  /** The page's own text (alert, confirm, prompt) or Orbit's. Never HTML. */
  message: string
  /** A second, quieter line (sign-in: the connection isn't private). */
  note?: string
  /** prompt: the text the field starts with. */
  value?: string
  /** The accepting button: "OK", "Leave", "Reload", "Sign in", "Wait". */
  okLabel: string
  /** The other button, when it isn't "Cancel": "Close page". */
  cancelLabel?: string
  /** alert: one button only. */
  noCancel?: boolean
  /** Esc answers with the accepting button (the safe answer), not the other one. */
  escapeAccepts?: boolean
  /** Cancel is the safe answer: the keyboard starts on it, and Enter anywhere but on the accepting button gives it. */
  defaultCancel?: boolean
  /** An app's icon, as the OS gives it (a `data:` URL). */
  icon?: string
  /** A checkbox under the message, unchecked at first: "Always allow …". */
  check?: string
}

/** The user's answer; `ok: false` is Cancel (or Esc, or the dialog going away). */
export interface PageDialogAnswer {
  id: number
  ok: boolean
  /** prompt: the field's text. */
  value?: string
  /** auth: what the user typed. */
  user?: string
  password?: string
  /** The checkbox, for a dialog with one: checked or not. */
  checked?: boolean
}

/** A dialog shows at most this much of a page's text (the rest is cut, with an ellipsis). */
export const DIALOG_TEXT_MAX = 10_000

/** A page's text for a dialog: cut to DIALOG_TEXT_MAX characters. */
export function dialogText(text: string): string {
  return text.length > DIALOG_TEXT_MAX ? `${text.slice(0, DIALOG_TEXT_MAX)}…` : text
}

/**
 * Who a dialog says asks (Chromium's wording): "<host> says" for a web page, its host with the
 * port; "This page says" for anything else (a local file, `data:`, `about:blank`).
 */
export function dialogTitle(pageUrl: string | undefined): string {
  try {
    const url = new URL(pageUrl ?? '')
    // A blob: URL's own origin is the page's.
    const inner = url.protocol === 'blob:' ? new URL(url.pathname) : url
    if ((inner.protocol === 'http:' || inner.protocol === 'https:') && inner.host) return `${inner.host} says`
  } catch {
    // Not a URL Orbit can name.
  }
  return 'This page says'
}

/** The dialog a page's `alert`, `confirm` or `prompt` shows. */
export function scriptDialog(
  kind: 'alert' | 'confirm' | 'prompt',
  pageUrl: string | undefined,
  message: string,
  value: string,
): Omit<PageDialogContent, 'id'> {
  return {
    kind,
    title: dialogTitle(pageUrl),
    message: dialogText(message),
    ...(kind === 'prompt' ? { value: dialogText(value) } : {}),
    okLabel: 'OK',
    ...(kind === 'alert' ? { noCancel: true } : {}),
  }
}

/** "Leave site?" (or "Reload site?" for a reload): Chromium's leave-page warning. */
export function leaveDialog(reload: boolean): Omit<PageDialogContent, 'id'> {
  return {
    kind: reload ? 'reload' : 'leave',
    title: reload ? 'Reload site?' : 'Leave site?',
    message: 'Changes you made may not be saved.',
    okLabel: reload ? 'Reload' : 'Leave',
  }
}

/** What Electron says about a sign-in request (`login` event's authInfo). */
export interface AuthRequest {
  isProxy: boolean
  scheme: string
  host: string
  port: number
  realm?: string
}

/**
 * HTTP sign-in (Basic or Digest): names the server (or the proxy) asking, and says so when the
 * connection the password would go over isn't private. `requestUrl` is the address that asked.
 */
export function authDialog(request: AuthRequest, requestUrl: string | undefined): Omit<PageDialogContent, 'id'> {
  let secure = false
  try {
    secure = new URL(requestUrl ?? '').protocol === 'https:'
  } catch {
    // Unknown: say it isn't private.
  }
  const server = request.port && ![80, 443].includes(request.port) ? `${request.host}:${request.port}` : request.host
  const who = request.isProxy ? `The proxy ${server}` : secure ? `https://${server}` : `http://${server}`
  return {
    kind: 'auth',
    title: 'Sign in',
    message: `${who} requires a username and password.`,
    ...(!request.isProxy && !secure ? { note: 'Your connection to this site is not private.' } : {}),
    okLabel: 'Sign in',
  }
}

/** What a page's `alert`, `confirm` or `prompt` returns for an answer (or none: the dialog went away). */
export function scriptAnswer(kind: 'alert' | 'confirm' | 'prompt', answer: PageDialogAnswer | null): unknown {
  if (kind === 'alert') return undefined
  if (kind === 'confirm') return answer?.ok === true
  return answer?.ok ? (answer.value ?? '') : null
}

/**
 * "Page unresponsive" (NV-14, Chromium's hung-page dialog): Wait is the safe answer (Enter and Esc
 * give it); Close page stops the page.
 */
export function hangDialog(pageUrl: string | undefined): Omit<PageDialogContent, 'id'> {
  const site = screenSite(pageUrl)
  return {
    kind: 'hang',
    title: 'Page unresponsive',
    message: `${site || 'This page'} isn’t responding. You can wait for it, or close the page.`,
    okLabel: 'Wait',
    cancelLabel: 'Close page',
    escapeAccepts: true,
  }
}

// ---- Links that open other apps (NV-19) ----

/** The app the OS opens a link in: its name, and its icon where the OS gives one (a `data:` URL). */
export interface OtherApp {
  name: string
  icon?: string
}

/**
 * Schemes that never go to another app: the ones the engine or Orbit loads itself, and the ones
 * Chromium refuses to hand to the OS (they run programs or reach local files).
 */
const NOT_APP_LINKS = new Set([
  'http',
  'https',
  'file',
  'about',
  'data',
  'blob',
  'filesystem',
  'javascript',
  'view-source',
  'orbit',
  'chrome',
  'chrome-extension',
  'chrome-untrusted',
  'devtools',
  'ws',
  'wss',
  // Chromium's blocked list: these reach programs or files on some systems.
  'afp',
  'disk',
  'disks',
  'hcp',
  'ie.http',
  'ms-help',
  'nntp',
  'res',
  'shell',
  'vbscript',
  'vnd.ms.radio',
  'ms-msdt',
  'search-ms',
])

/**
 * The scheme of a link that opens another app ("mailto", "zoommtg"), lower case, or "" for any
 * other address (a web page, a local file, a scheme that never leaves the browser).
 */
export function appScheme(url: string | undefined): string {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(url?.trim() ?? '')
  const scheme = match?.[1]?.toLowerCase() ?? ''
  return scheme && !NOT_APP_LINKS.has(scheme) ? scheme : ''
}

/**
 * An app's name as the OS gives it, for a dialog. Linux names the app's desktop entry
 * ("thunderbird.desktop", "org.gnome.Evolution.desktop"): its last part, in words, capitalised.
 */
export function appName(raw: string, platform: string): string {
  const name = raw.trim()
  if (platform !== 'linux') return name
  let entry = name.replace(/\.desktop$/i, '')
  // A reverse-DNS entry ("org.gnome.Evolution"): the app is its last part.
  if (/^[a-z0-9-]+(\.[a-z0-9_-]+){2,}$/i.test(entry)) entry = entry.split('.').pop() ?? entry
  entry = entry.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  return entry === entry.toLowerCase()
    ? entry.replace(/(^|\s)(\p{L})/gu, (_m, gap: string, c: string) => gap + c.toUpperCase())
    : entry
}

/** Printable characters Chromium escapes in a link it hands to another app. */
const ESCAPED_FOR_APPS = new Set('"<>\\^`{|}')

/**
 * A link as Orbit hands it to the OS: characters an app's handler could take for more than one
 * argument are escaped, as Chromium does (spaces and other controls, quotes, angle brackets…).
 */
export function launchableUrl(url: string): string {
  let out = ''
  for (const c of url) {
    const code = c.charCodeAt(0)
    const unsafe = code <= 0x20 || code === 0x7f || ESCAPED_FOR_APPS.has(c)
    out += unsafe ? `%${code.toString(16).toUpperCase().padStart(2, '0')}` : c
  }
  return out
}

/**
 * "Open Mail?" (NV-19, Chromium's external-protocol dialog): the app a link opens, with its icon,
 * and the site asking (`origin`, the frame that followed the link). Cancel is the default; Open
 * launches the app. Only a web site (http or https) may be always allowed to open links of that kind.
 */
export function appDialog(app: OtherApp | undefined, origin: string | null): Omit<PageDialogContent, 'id'> {
  const who = origin ? siteLabel(origin) : 'A website'
  const web = !!origin && /^https?:\/\//i.test(origin)
  return {
    kind: 'app',
    title: app ? `Open ${app.name}?` : 'Open this link in another app?',
    message: app ? `${who} wants to open this application.` : `${who} wants to open a link in another app.`,
    ...(app?.icon ? { icon: app.icon } : {}),
    ...(web ? { check: `Always allow ${who} to open links of this type in the associated app` } : {}),
    okLabel: app ? `Open ${app.name}` : 'Open link',
    defaultCancel: true,
  }
}

/** Said instead of asking when the OS has no app for a link's kind. */
export function noAppMessage(scheme: string): string {
  return `No app on this device opens ${scheme}: links`
}

// ---- Error and crash screens (NV-13, NV-14) ----

/**
 * What a page's area shows instead of its page: it couldn't load (`error`), the device is offline
 * (`offline`), the site's certificate isn't trusted (`cert`), or the page crashed (`crash`).
 */
export type PageScreenKind = 'error' | 'offline' | 'cert' | 'crash'

/** What a screen view shows. */
export interface PageScreenContent {
  id: number
  kind: PageScreenKind
  /** "This site can’t be reached". */
  title: string
  /** One plain sentence. */
  message: string
  /** The site the page is for: its host with the port, or a file's name. */
  site: string
  /** Chromium's name for what went wrong, shown small: "ERR_NAME_NOT_RESOLVED". */
  code?: string
  /** The main button: load the address again, reload a crashed page, or leave a site that isn't safe. */
  action: 'retry' | 'reload' | 'back'
  actionLabel: string
  /** A certificate error: what Advanced says, and, where the user may go on anyway, its button. */
  advanced?: { text: string; proceedLabel?: string }
}

/** What a screen view asks main to do; `online` is the network coming back while it shows. */
export type PageScreenAction = 'retry' | 'reload' | 'back' | 'proceed' | 'online'

/** The site a screen names: the host with its port, a file's name, or "" when there is none. */
export function screenSite(pageUrl: string | undefined): string {
  try {
    let url = new URL(pageUrl ?? '')
    // A page's source is for the page.
    if (url.protocol === 'view-source:') url = new URL(url.href.slice('view-source:'.length))
    if (url.protocol === 'file:') {
      const name = url.pathname.split('/').filter(Boolean).pop() ?? ''
      try {
        return decodeURIComponent(name)
      } catch {
        return name
      }
    }
    return url.host
  } catch {
    return ''
  }
}

/** Chromium's name for a load error, as Electron gives it ("ERR_NAME_NOT_RESOLVED"). */
function errorName(code: number, description: string): string {
  const name = description.replace(/^net::/, '').trim()
  return /^ERR_[A-Z0-9_]+$/.test(name) ? name : `ERR_${Math.abs(code)}`
}

/** A certificate error (Chromium's -200 to -299). */
export function isCertError(code: number): boolean {
  return code <= -200 && code > -300
}

/** Certificate errors nobody may go past: a revoked certificate, a known interception. */
const CERT_FATAL = new Set([-206, -217])

const UNREACHABLE = 'This site can’t be reached'
const NOT_WORKING = 'This page isn’t working'

/** The screen for a page that couldn't load, by Chromium's error code (`did-fail-provisional-load`). */
export function errorScreen(
  code: number,
  description: string,
  pageUrl: string | undefined,
): Omit<PageScreenContent, 'id'> {
  const site = screenSite(pageUrl)
  const name = errorName(code, description)
  const retry = { site, code: name, action: 'retry' as const, actionLabel: 'Try again' }
  if (isCertError(code)) return certScreen(code, name, site)
  const say = (title: string, message: string, kind: PageScreenKind = 'error') => ({ kind, title, message, ...retry })
  switch (code) {
    case -106: // ERR_INTERNET_DISCONNECTED
      return say('No internet', 'Your device isn’t connected to the internet.', 'offline')
    case -105: // ERR_NAME_NOT_RESOLVED
    case -137: // ERR_NAME_RESOLUTION_FAILED
      return say(UNREACHABLE, 'Orbit couldn’t find the server at this address.')
    case -102: // ERR_CONNECTION_REFUSED
      return say(UNREACHABLE, 'The server refused to connect.')
    case -7: // ERR_TIMED_OUT
    case -118: // ERR_CONNECTION_TIMED_OUT
      return say(UNREACHABLE, 'The server took too long to respond.')
    case -101: // ERR_CONNECTION_RESET
      return say(UNREACHABLE, 'The connection was reset.')
    case -100: // ERR_CONNECTION_CLOSED
    case -324: // ERR_EMPTY_RESPONSE
      return say(NOT_WORKING, 'The server closed the connection without sending anything.')
    case -21: // ERR_NETWORK_CHANGED
      return say(UNREACHABLE, 'Your connection was interrupted.')
    case -109: // ERR_ADDRESS_UNREACHABLE
      return say(UNREACHABLE, 'The server’s address can’t be reached from this network.')
    case -130: // ERR_PROXY_CONNECTION_FAILED
    case -111: // ERR_TUNNEL_CONNECTION_FAILED
      return say(UNREACHABLE, 'Orbit couldn’t connect through the proxy server.')
    case -310: // ERR_TOO_MANY_REDIRECTS
      return say(NOT_WORKING, 'The site redirected too many times.')
    case -320: // ERR_INVALID_RESPONSE
    case -337: // ERR_INVALID_HTTP_RESPONSE
      return say(NOT_WORKING, 'The site sent a response Orbit can’t read.')
    case -107: // ERR_SSL_PROTOCOL_ERROR
    case -113: // ERR_SSL_VERSION_OR_CIPHER_MISMATCH
      return say('This site can’t provide a secure connection', 'The site sent a response Orbit can’t trust.')
    case -20: // ERR_BLOCKED_BY_CLIENT
    case -22: // ERR_BLOCKED_BY_ADMINISTRATOR
      return say('This page has been blocked', 'Something in Orbit, such as an extension, blocked it.')
    case -27: // ERR_BLOCKED_BY_RESPONSE
      return say('This page has been blocked', 'The site doesn’t allow it to be shown here.')
    case -6: // ERR_FILE_NOT_FOUND
      return say('This file can’t be opened', 'It may have been moved, renamed or deleted.')
    case -10: // ERR_ACCESS_DENIED
      return say('This file can’t be opened', 'Orbit isn’t allowed to read it.')
    case -312: // ERR_UNSAFE_PORT
      return say(UNREACHABLE, 'The address uses a port that browsers block for safety.')
    default:
      return say(UNREACHABLE, 'Something went wrong while loading it.')
  }
}

/** The screen for a navigation that got no answer within Orbit's own time limit. */
export function timeoutScreen(pageUrl: string | undefined): Omit<PageScreenContent, 'id'> {
  return errorScreen(-7, 'ERR_TIMED_OUT', pageUrl)
}

/**
 * "Your connection is not private" (Chromium's certificate interstitial): Back to safety is the
 * main button, and going on needs Advanced, then Proceed.
 */
function certScreen(code: number, name: string, site: string): Omit<PageScreenContent, 'id'> {
  const who = site || 'this site'
  const why =
    code === -201 // ERR_CERT_DATE_INVALID
      ? 'its security certificate has expired or isn’t valid yet'
      : code === -200 // ERR_CERT_COMMON_NAME_INVALID
        ? 'its security certificate is for another site'
        : code === -202 // ERR_CERT_AUTHORITY_INVALID
          ? 'its security certificate isn’t trusted by your device'
          : code === -206 // ERR_CERT_REVOKED
            ? 'its security certificate has been revoked'
            : 'its security certificate has a problem'
  return {
    kind: 'cert',
    title: 'Your connection is not private',
    message:
      'Someone might be trying to steal your information from this site, such as passwords, messages or card numbers.',
    site,
    code: name,
    action: 'back',
    actionLabel: 'Back to safety',
    advanced: {
      text: `The server couldn’t prove that it’s ${who}: ${why}.`,
      ...(CERT_FATAL.has(code) ? {} : { proceedLabel: `Proceed to ${who} (unsafe)` }),
    },
  }
}

/**
 * The screen for a crashed page (Chromium's "sad tab"): Reload loads it again. `reason` is
 * `render-process-gone`'s, or `hung` for a page the user closed from "Page unresponsive".
 */
export function crashScreen(reason: string, pageUrl: string | undefined): Omit<PageScreenContent, 'id'> {
  const site = screenSite(pageUrl)
  const say = (title: string, message: string) => ({
    kind: 'crash' as const,
    title,
    message,
    site,
    code: reason.toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
    action: 'reload' as const,
    actionLabel: 'Reload',
  })
  switch (reason) {
    case 'hung':
      return say('This page was closed', 'It stopped responding, so Orbit closed it.')
    case 'oom':
      return say('This page crashed', 'It ran out of memory.')
    case 'memory-eviction':
      return say('This page crashed', 'It was closed to free up memory.')
    case 'killed':
      return say('This page crashed', 'Its process was ended.')
    default:
      return say('This page crashed', 'Something went wrong while showing it.')
  }
}
