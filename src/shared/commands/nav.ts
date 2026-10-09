import type { FindState, ZoomIndicator } from '../nav'
import type { TabId } from '../state'

/** One entry of a tab's back/forward history, as the history menu lists it (NV-01). */
export interface HistoryEntryInfo {
  /** Position in the tab's navigation history (what `nav.goToIndex` takes). */
  index: number
  url: string
  title: string
  /** Small data URL from the favicon store, when one is known for the entry's origin. */
  favicon?: string
}

export type NavDirection = 'back' | 'forward'

/** A button of the sidebar's top row (SB-03). */
export type NavButton = NavDirection | 'reload' | 'stop'

/** Owned by the chrome lane: page navigation, the sidebar's top row and page tools. */
export interface NavCommands {
  /**
   * A press on Back, Forward, Reload or Stop in the top row: acts on the active tab (the focused
   * pane in split view) and gives the page keyboard focus. With `newTab` (⌘-click or middle-click)
   * Back/Forward open that history entry in a new background tab and Reload duplicates the tab,
   * leaving the current tab as it is; `foreground` selects the new tab (SB-03, NV-01, NV-03).
   * Returns the new tab, if one was made.
   */
  'nav.press': { args: { button: NavButton; newTab?: boolean; foreground?: boolean }; result: TabId | null }
  /**
   * Entries behind (`back`) or ahead of (`forward`) a tab's current page (default: the active
   * tab), nearest the button first, as the history menu lists them (NV-01).
   */
  'nav.history': { args: { tabId?: TabId; direction: NavDirection }; result: HistoryEntryInfo[] }
  /**
   * Shows the history menu of Back or Forward under the button, at a point in window coordinates
   * (long-press or right-click, NV-01). It closes when the window's tab changes. `icons` holds PNG
   * renderings of SVG favicons keyed by the SVG data URL: native menus can't draw SVG.
   */
  'nav.historyMenu': {
    args: { direction: NavDirection; x: number; y: number; icons?: Record<string, string> }
    result: void
  }
  /** Goes to a history entry of a tab (default: the active tab); `newTab` opens it in a new background tab. */
  'nav.goToIndex': { args: { tabId?: TabId; index: number; newTab?: boolean }; result: TabId | null }
  /** The page address was copied the long way (from the command bar): a one-time ⌘⇧C tip (NV-17). */
  'nav.copyHint': { args: Record<string, never>; result: void }
  /**
   * The pointer reached the left edge of a window whose sidebar is hidden: the sidebar slides in
   * over the page as a floating card (SB-12, FL-03). Ignored while something else floats over the
   * window (command bar, a panel) or a page is in full screen.
   */
  'sidebar.reveal': { args: Record<string, never>; result: void }
  /**
   * From the floating sidebar: whether the pointer is over it (`over`) and whether a text field in it
   * has focus (`editing`). It slides away shortly after neither holds and nothing it opened is up.
   */
  'sidebar.peekState': { args: { over?: boolean; editing?: boolean }; result: void }
  /** A click beside the floating sidebar's card: the card hides at once and the click goes on to the page. */
  'sidebar.peekDismiss': { args: { x: number; y: number; button: 'left' | 'middle' | 'right' }; result: void }
  /** What the page tools view shows for its window: the find bar and the zoom indicator (NV-05, NV-06). */
  'pageTools.state': { args: Record<string, never>; result: { find: FindState; zoom: ZoomIndicator | null } }
  /** The pointer is over the page tools (the zoom indicator stays while it is). */
  'pageTools.hover': { args: { over: boolean }; result: void }
  /** The find bar's text changed: highlight its matches in the active tab's page (NV-05). */
  'find.update': { args: { query: string }; result: void }
  /** Next (`forward`) or previous match (Enter, ⇧Enter, ⌘G, ⇧⌘G). */
  'find.step': { args: { forward: boolean }; result: void }
  /** Closes the find bar: highlights go, the page keeps the last match selected and gets focus. */
  'find.close': { args: Record<string, never>; result: void }
  /** The active tab's page zoom as a percentage, and whether it differs from the default (NV-06, NV-16). */
  'zoom.get': { args: { tabId?: TabId }; result: { percent: number } }
}
