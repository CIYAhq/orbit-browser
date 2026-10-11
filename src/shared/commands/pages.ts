import type { PageDialogAnswer, PageDialogContent, PageScreenAction, PageScreenContent } from '../pages'

/** Owned by the pages lane: what a page asks of the user (NV-24), and what shows when it fails (NV-13, NV-14). */
export interface PagesCommands {
  /** A page dialog view's content: the dialog it shows now, or null (the view asks when it loads). */
  'pages.dialogContent': { args: Record<string, never>; result: PageDialogContent | null }
  /** The user's answer to the dialog a page dialog view shows; ignored from any other view. */
  'pages.dialogAnswer': { args: PageDialogAnswer; result: void }
  /** A screen view's content: the error or crash screen it shows now, or null. */
  'pages.screenContent': { args: Record<string, never>; result: PageScreenContent | null }
  /** A screen's button (or the network coming back) for the screen a view shows; ignored from any other view. */
  'pages.screenAction': { args: { id: number; action: PageScreenAction }; result: void }
}
