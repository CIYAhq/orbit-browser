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
}
