import { parseInput, type SearchWith } from './url'

/**
 * A link dragged out of a page onto the page (or another pane) opens in a new pane there (SV-08).
 * Shared by main, which hears it from the page, and the shell, which draws the drop indicator.
 * Dropped on the sidebar, what it may open is `sidebarDropUrl`'s to say (D87).
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

/** Where on the sidebar a drag from a page is dropped (D87): the tab list (or a Space's icon), a folder, the Favorites. */
export type SidebarDropPlace = 'list' | 'folder' | 'favorites'

/** Text that is an address of another scheme than the web's, spaces and all: a page's data, script or own address. */
const OTHER_ADDRESS = /^(about|blob|chrome|data|devtools|file|filesystem|javascript|orbit|vbscript|view-source):/i

/**
 * What a drag from a page opens where it is dropped on the sidebar (D87; NV-08, TB-02), or null for
 * nothing. One check for every place there, since where the drag came from isn't known and a page
 * may have offered it:
 * - a web address (`http:` or `https:`), its link or its text: as a tab, or a Favorite on the Favorites;
 * - text that is no address: a search for it, as typed in the command bar, on the tab list or in a
 *   folder; on the Favorites, nothing;
 * - any other address (`data:`, `view-source:`, `chrome:`, `javascript:` and every other scheme the
 *   command bar takes, `file:` and `orbit:` too, D49, D53): nothing.
 */
export function sidebarDropUrl(
  uriList: string,
  text: string,
  engine: SearchWith,
  place: SidebarDropPlace,
): string | null {
  if (uriList.split(/\r?\n/).some((l) => l.trim() && !l.trim().startsWith('#'))) return droppedLink(uriList)
  const plain = text.trim()
  if (!plain) return null
  const parsed = parseInput(plain, engine)
  if (parsed.kind === 'url') return /^https?:/i.test(parsed.url) ? parsed.url : null
  return place === 'favorites' || OTHER_ADDRESS.test(plain) ? null : parsed.url
}

/** Whether a drag carries a link (not files, whose list names local paths). */
export function carriesLink(types: readonly string[]): boolean {
  return types.includes('text/uri-list') && !types.includes('Files')
}
