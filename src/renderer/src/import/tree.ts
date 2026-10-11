import type { BookmarkNode } from '../../../shared/commands/import'

/** Choosing bookmarks (IM-04): which leaves are chosen, and the tree that results. Pure. */

/** One source profile's bookmarks (`key` keeps leaf keys apart across profiles). */
export interface TreeRoot {
  key: string
  title?: string
  nodes: BookmarkNode[]
}

export const leafKey = (root: string, node: BookmarkNode) => `${root}:${node.id}`

/** Keys of the bookmarks that can be imported under `nodes`. */
export function leafKeys(root: string, nodes: readonly BookmarkNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.children) leafKeys(root, n.children, out)
    else if (n.url && !n.skip) out.push(leafKey(root, n))
  }
  return out
}

/**
 * The tree as chosen: unselected bookmarks and folders left empty go. Skipped bookmarks can't be
 * chosen, so they always stay, with their folders, to be counted in the summary (IM-14, F3); main adds
 * no folder that holds nothing but them.
 */
export function filterTree(
  nodes: readonly BookmarkNode[],
  root: string,
  selected: ReadonlySet<string>,
): BookmarkNode[] {
  const out: BookmarkNode[] = []
  for (const n of nodes) {
    if (n.children) {
      const kids = filterTree(n.children, root, selected)
      if (kids.length > 0) out.push({ ...n, children: kids })
    } else if (n.skip || selected.has(leafKey(root, n))) {
      out.push(n)
    }
  }
  return out
}
