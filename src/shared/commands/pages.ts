import type { PageDialogAnswer, PageDialogContent, PageScreenAction, PageScreenContent } from '../pages'
import type { PrintContent, PrintSettings } from '../print'
import type { SwipeArrow } from '../swipe'
import type { LibraryHistoryQuery } from './archive'
import type { HistoryVisit } from './history'

/**
 * Owned by the pages lane: what a page asks of the user (NV-24), what shows when it fails (NV-13, NV-14), print (NV-07),
 * the swipe's arrow (NV-02), and History in a tab (AR-10).
 */
export interface PagesCommands {
  /** A page dialog view's content: the dialog it shows now, or null (the view asks when it loads). */
  'pages.dialogContent': { args: Record<string, never>; result: PageDialogContent | null }
  /** The user's answer to the dialog a page dialog view shows; ignored from any other view. */
  'pages.dialogAnswer': { args: PageDialogAnswer; result: void }
  /** A screen view's content: the error or crash screen it shows now, or null. */
  'pages.screenContent': { args: Record<string, never>; result: PageScreenContent | null }
  /** A screen's button (or the network coming back) for the screen a view shows; ignored from any other view. */
  'pages.screenAction': { args: { id: number; action: PageScreenAction }; result: void }
  /** A print dialog view's content (NV-07): the dialog it shows now, or null. */
  'pages.printContent': { args: Record<string, never>; result: PrintContent | null }
  /** The user changed the print dialog's settings; ignored from any view but the one showing `dialog`. */
  'pages.printChange': { args: { dialog: number; settings: Partial<PrintSettings> }; result: void }
  /** Print (or Save) with the dialog's settings, or close it (`ok: false`). */
  'pages.printAnswer': { args: { dialog: number; ok: boolean }; result: void }
  /** A swipe arrow view's arrow (NV-02): the swipe over its window's page now, or null. */
  'pages.swipeArrow': { args: Record<string, never>; result: SwipeArrow | null }
  // History in a tab (AR-10, `orbit://history/`). Each command is about the profile of the calling
  // page's own tab, never one the page names, and opens only a page that page listed (D53).
  /** A page of the tab's profile's visits, newest first. */
  'pages.history': { args: Omit<LibraryHistoryQuery, 'profileId'>; result: HistoryVisit[] }
  /** Opens a listed page in a new tab: shown, or behind the History page. */
  'pages.historyOpen': { args: { url: string; background?: boolean }; result: void }
  /** Removes every visit to a page from the profile's history. */
  'pages.historyDelete': { args: { url: string }; result: void }
  /** A listed page's menu: open it, copy its address, remove it from history. */
  'pages.historyMenu': { args: { url: string; x?: number; y?: number }; result: void }
  /** Tests only: the last History page menu's labels, or a click on one of them. */
  'pages.testHistoryMenu': { args: { click?: string }; result: string[] }
}
