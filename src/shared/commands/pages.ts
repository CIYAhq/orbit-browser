import type { PageDialogAnswer, PageDialogContent } from '../pages'

/** Owned by the pages lane: what a page asks of the user (NV-24). */
export interface PagesCommands {
  /** A page dialog view's content: the dialog it shows now, or null (the view asks when it loads). */
  'pages.dialogContent': { args: Record<string, never>; result: PageDialogContent | null }
  /** The user's answer to the dialog a page dialog view shows; ignored from any other view. */
  'pages.dialogAnswer': { args: PageDialogAnswer; result: void }
}
