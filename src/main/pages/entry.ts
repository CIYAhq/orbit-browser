import type { WebContents } from 'electron'

/**
 * The pages lane's ways in for code outside it: the actions for a tab's, a Peek's or a Mini
 * Window's page, and the page menu. The lane sets them when it starts; until then they do nothing.
 * Kept apart from the lane's modules, so these callers load nothing more.
 */
const entries = {
  print: (_page: WebContents): void => {},
  viewSource: (_page: WebContents): void => {},
  savePage: (_page: WebContents): void => {},
}

/** Opens the print dialog over `page`, or brings back the one it has (NV-07). */
export function printPage(page: WebContents): void {
  entries.print(page)
}

/** Opens `page`'s source in a new tab (DT-04). */
export function viewSource(page: WebContents): void {
  entries.viewSource(page)
}

/** Asks where to save `page`, in the OS save dialog, and saves it there (NV-21). */
export function savePage(page: WebContents): void {
  entries.savePage(page)
}

export function setPageEntries(next: Partial<typeof entries>): void {
  Object.assign(entries, next)
}
