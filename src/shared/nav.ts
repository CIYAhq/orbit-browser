/**
 * Small pure helpers for page navigation and the sidebar's top row (chrome lane). Shared by the
 * main process, the shell renderer and unit tests.
 */

/** How the address display describes a page's connection (SB-04). */
export type Connection =
  /** https: no icon (Orbit shows no padlock for secure sites). */
  | 'secure'
  /** Plain http to another machine: a clear warning icon. */
  | 'insecure'
  /** http to this machine (localhost, 127.0.0.0/8, ::1): a secure context, no warning. */
  | 'local'
  | 'file'
  /** about:, data:, view-source of an internal page, Chromium pages… */
  | 'internal'
  | 'none'

const LOOPBACK_HOST = /^(?:localhost|[^.]+(?:\.[^.]+)*\.localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i

export function connectionOf(url: string | undefined): Connection {
  if (!url) return 'none'
  if (url.startsWith('view-source:')) return connectionOf(url.slice('view-source:'.length))
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'none'
  }
  switch (parsed.protocol) {
    case 'https:':
    case 'wss:':
      return 'secure'
    case 'http:':
    case 'ws:':
      return LOOPBACK_HOST.test(parsed.hostname) ? 'local' : 'insecure'
    case 'file:':
      return 'file'
    default:
      return 'internal'
  }
}

/** How many history entries the Back/Forward menu lists (the nearest ones). */
export const HISTORY_MENU_MAX = 15

/**
 * Indexes of the entries the Back or Forward history menu lists, nearest the button first: for
 * Back the page just before the current one comes first (NV-01).
 */
export function historyMenuIndexes(
  length: number,
  current: number,
  direction: 'back' | 'forward',
  max = HISTORY_MENU_MAX,
): number[] {
  const out: number[] = []
  if (direction === 'back') {
    for (let i = Math.min(current, length) - 1; i >= 0 && out.length < max; i--) out.push(i)
  } else {
    for (let i = Math.max(current, -1) + 1; i < length && out.length < max; i++) out.push(i)
  }
  return out
}

/** A history entry's menu label: its title, or its address without the scheme when it has none. */
export function historyEntryLabel(title: string, url: string, max = 60): string {
  const text = title.trim() || url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/$/, '') || url
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}
