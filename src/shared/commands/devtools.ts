import type { TabId } from '../state'

/**
 * Owned by the downloads lane: the engine's DevTools for a page (DT-01 to DT-03).
 *
 * DevTools open docked inside the page's own view (a tab, a split pane, a Peek, a Mini Window), on
 * the side last chosen in DevTools' dock menu, or undocked in a window of their own. The engine
 * remembers the dock side and the docked size per profile.
 *
 * Without `tabId`, a command acts on the calling window's selected tab (the focused pane in a split).
 * The keys and menus go through actions instead: `devtools.toggle`, `devtools.console` and
 * `devtools.inspect` (the element picker).
 */
export interface DevtoolsCommands {
  /**
   * Opens DevTools for a tab, or brings open ones forward, and shows a panel if one is named.
   * False when the tab has no live page.
   */
  'devtools.open': { args: { tabId?: TabId; panel?: DevtoolsPanel }; result: boolean }
  /** Closes a tab's DevTools. */
  'devtools.close': { args: { tabId?: TabId }; result: void }
  /** Whether a tab's DevTools are open, where, and whether they have the keyboard. */
  'devtools.state': { args: { tabId?: TabId }; result: DevtoolsState }
  /** What Orbit runs on, for `orbit://version/` (DT-13). */
  'devtools.version': { args: Record<string, never>; result: VersionInfo }
}

/**
 * The scheme of Orbit's internal pages (DT-13): `orbit://<page>/` opens as a normal tab. How they
 * work and how to add one: `src/main/devtools/internal-pages.ts`.
 */
export const INTERNAL_SCHEME = 'orbit'

/** The internal page listing every internal page. */
export const INTERNAL_INDEX = 'orbit://pages/'

export interface VersionInfo {
  orbit: string
  electron: string
  chromium: string
  node: string
  v8: string
  /** The OS's name and version, e.g. "Linux 6.8.0" or "Darwin 24.1.0". */
  os: string
  arch: string
}

/** DevTools panels by the engine's names: Elements, Console, Sources, Network, Performance, Application. */
export type DevtoolsPanel = 'elements' | 'console' | 'sources' | 'network' | 'timeline' | 'resources'

/** Docked inside the page's view on one side, or undocked in a window of its own. */
export type DockSide = 'right' | 'left' | 'bottom' | 'undocked'

export interface DevtoolsState {
  open: boolean
  /** Undefined while closed, or if DevTools didn't answer. */
  dock?: DockSide
  focused: boolean
}
