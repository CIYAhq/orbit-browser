import type { FindState, LinkPillContent, ZoomIndicator } from '../nav'
import type { PermissionKind, PromptChoice, SiteControlsInfo } from '../site'
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
   * `over: null`: the pointer left the card for where the card can't tell (main reads it then).
   */
  'sidebar.peekState': { args: { over?: boolean | null; editing?: boolean }; result: void }
  /** A click beside the floating sidebar's card: the card hides at once and the click goes on to the page. */
  'sidebar.peekDismiss': { args: { x: number; y: number; button: 'left' | 'middle' | 'right' }; result: void }
  /** What the page tools view shows for its window: the find bar and the zoom indicator (NV-05, NV-06). */
  'pageTools.state': { args: Record<string, never>; result: { find: FindState; zoom: ZoomIndicator | null } }
  /** The pointer is over the page tools (the zoom indicator stays while it is). */
  'pageTools.hover': { args: { over: boolean }; result: void }
  /** The page tools have drawn themselves empty for `away`: their view can leave the window (NV-06). */
  'pageTools.drawn': { args: { away: number }; result: void }
  /** The find bar's text changed: highlight its matches in the active tab's page (NV-05). */
  'find.update': { args: { query: string }; result: void }
  /** Next (`forward`) or previous match (Enter, ⇧Enter, ⌘G, ⇧⌘G). */
  'find.step': { args: { forward: boolean }; result: void }
  /** Closes the find bar: highlights go, the page keeps the last match selected and gets focus. */
  'find.close': { args: Record<string, never>; result: void }
  /**
   * The find bar's field took the keyboard for focus request `focus` (FindState.focus): keys typed
   * for it before then are typed into it now.
   */
  'find.focused': { args: { focus: number }; result: void }
  /**
   * The address display's blocked pop-ups button: a menu at a point in window coordinates to open
   * the active tab's blocked pop-ups or always allow them on its site (NV-09).
   */
  'nav.blockedPopupsMenu': { args: { x: number; y: number }; result: void }
  /** The active tab's page zoom as a percentage, and whether it differs from the default (NV-06, NV-16). */
  'zoom.get': { args: { tabId?: TabId }; result: { percent: number } }
  /** Answers a permission prompt (NV-15); `pick` is the device or screen chosen in a chooser. */
  'permissions.answer': { args: { id: number; choice: PromptChoice; pick?: string }; result: void }
  /** A screen picker's previews: data URLs by source id. */
  'permissions.thumbnails': { args: { id: number }; result: Record<string, string> }
  /**
   * Whether the prompt view is on screen now (it asks when it loads; after that main says each
   * time): placed while the sidebar is hidden, and not under a page cover such as the Library.
   */
  'permissions.promptPlaced': { args: Record<string, never>; result: boolean }
  /** The prompt view's card height, so its view fits it (sidebar hidden). */
  'permissions.promptSize': { args: { height: number }; result: void }
  /** Opens the site controls panel for the active tab, under a point in window coordinates (NV-16). */
  'site.openControls': { args: { x?: number; y?: number }; result: void }
  /** What the site controls panel shows for a tab (default: the active one). */
  'site.info': { args: { tabId?: TabId }; result: SiteControlsInfo | null }
  /** A switch in the site controls panel: allow or block a permission, or pop-ups, on the tab's site. */
  'site.setPermission': { args: { tabId: TabId; kind: PermissionKind; allowed: boolean }; result: void }
  /** Forgets every permission choice of the tab's site. */
  'site.resetPermissions': { args: { tabId: TabId }; result: void }
  /** Stops letting the tab's site use a device it was given. */
  'site.revokeDevice': { args: { tabId: TabId; key: string }; result: void }
  /** Deletes the tab's site's cookies and stored data. */
  'site.clearData': { args: { tabId: TabId }; result: void }
  /** What the link status pill's view shows now (it asks when it loads), or null (SB-27). */
  'nav.linkPill': { args: Record<string, never>; result: LinkPillContent | null }
  /** How wide the link pill came out for the content numbered `key`, so its view fits it. */
  'nav.linkPillSize': { args: { key: number; width: number }; result: void }
}
