/**
 * A link dragged out of a page onto the page (or another pane) opens in a new pane there (SV-08).
 * Shared by main, which hears it from the page, and the shell, which draws the drop indicator.
 */

/** The drop preview's id for a dragged link: never a tab's id. */
export const LINK_DROP_ID = 'link-drop'

/** Main → shell (`split:linkDrag`): a link dragged over a pane's page, in window coordinates (DIP). */
export interface LinkDragMessage {
  phase: 'over' | 'leave' | 'drop'
  x: number
  y: number
  /** The dropped link, already checked with `droppedLink`. */
  url?: string
}

/**
 * The address a dropped link opens in a new pane: the first address of the drag's URI list, when
 * it is a web address. Where it was dragged from isn't known, so nothing else opens: a local file
 * or an internal page never does from a drop (D49, D53), nor a script address.
 */
export function droppedLink(uriList: string): string | null {
  const line = uriList
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'))
  if (!line) return null
  try {
    const url = new URL(line)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/** Whether a drag carries a link (not files, whose list names local paths). */
export function carriesLink(types: readonly string[]): boolean {
  return types.includes('text/uri-list') && !types.includes('Files')
}
