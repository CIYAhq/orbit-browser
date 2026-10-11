/**
 * What a page asks of the user, shown in Orbit's own dialogs over that page (pages lane, NV-24):
 * the page's `alert`, `confirm` and `prompt`, "Leave site?" before a page that asks for it goes,
 * and HTTP sign-in.
 */

/** The kinds of page dialog. `leave` and `reload` are the leave-page warning (`beforeunload`). */
export type PageDialogKind = 'alert' | 'confirm' | 'prompt' | 'leave' | 'reload' | 'auth'

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
  /** The accepting button: "OK", "Leave", "Reload", "Sign in". */
  okLabel: string
  /** alert: one button only. */
  noCancel?: boolean
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
