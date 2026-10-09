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

/** Chromium's page zoom steps (NV-06), as zoom factors. */
export const ZOOM_STEPS: readonly number[] = [
  0.25,
  1 / 3,
  0.5,
  2 / 3,
  0.75,
  0.8,
  0.9,
  1,
  1.1,
  1.25,
  1.5,
  1.75,
  2,
  2.5,
  3,
  4,
  5,
]

const ZOOM_EPSILON = 0.001

/** The next zoom step in (`+1`) or out (`-1`) from a factor; stays put at either end. */
export function zoomStep(factor: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((s) => s > factor + ZOOM_EPSILON) ?? factor
  return [...ZOOM_STEPS].reverse().find((s) => s < factor - ZOOM_EPSILON) ?? factor
}

/** A zoom factor as the whole percentage the indicator shows (1/3 → 33). */
export function zoomPercent(factor: number): number {
  return Math.round(factor * 100)
}

export function sameZoom(a: number, b: number): boolean {
  return Math.abs(a - b) < ZOOM_EPSILON
}

/** What the find bar shows for the window's active tab (NV-05). */
export interface FindState {
  tabId: string | null
  open: boolean
  query: string
  /** 1-based position of the current match; 0 when there is none. */
  active: number
  matches: number
  /** The count belongs to `query` on this page (false while typing starts, or after the page changed). */
  searched: boolean
  /** Changes each time the field should take focus with its text selected (⌘F). */
  focus: number
}

/** The transient zoom indicator (NV-06); `null` when hidden. */
export interface ZoomIndicator {
  percent: number
  /** Changes on every zoom change, so the indicator can pulse. */
  nonce: number
}

/**
 * The page tools view: a small transparent view over the top-right corner of the active page that
 * holds the find bar and the zoom indicator. Sizes in px; `margin` leaves room for the shadow.
 */
export const PAGE_TOOLS = {
  margin: 8,
  /** The bar's distance from the page's top and right edges. */
  inset: 10,
  gap: 6,
  findWidth: 380,
  findHeight: 44,
  zoomWidth: 184,
  zoomHeight: 36,
} as const

/** The text ⌘F starts from when the page has a selection: its first non-empty line, trimmed and capped. */
export function findTextFromSelection(selection: string, max = 200): string {
  const line = selection.split(/\r?\n/).find((l) => l.trim() !== '') ?? ''
  return line.trim().slice(0, max)
}
