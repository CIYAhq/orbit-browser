import type { BookmarkNode, ParsedFile } from '../../shared/commands/import'
import { parseLinkList } from '../../shared/commands/import'
import { fallbackTitle } from '../../shared/url'
import { bookmark, countBookmarks, NO_BOOKMARKS, parseBookmarksHtml } from './netscape'

/** Files larger than this aren't bookmark files. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024
/** A tree from a renderer is cut off beyond these. */
const MAX_NODES = 200_000
const MAX_DEPTH = 64

/** IM-13: the folder a bookmarks file goes into. */
export const FILE_FOLDER_NAME = 'Imported bookmarks'

/** Reads a dropped or chosen file: a bookmarks HTML file, or a plain list of links (IM-13). */
export function parseFile(name: string, text: string): ParsedFile {
  const looksHtml = /<(!doctype|dl|dt|a)[\s>]/i.test(text)
  if (/\.txt$/i.test(name) || !looksHtml) {
    const { links } = parseLinkList(text)
    if (links.length > 0) return { kind: 'links', name, text, count: links.length }
    return { kind: 'error', name, message: NO_BOOKMARKS }
  }
  const tree = parseBookmarksHtml(text)
  if (!tree) return { kind: 'error', name, message: NO_BOOKMARKS }
  return { kind: 'bookmarks', name, tree, count: countBookmarks(tree) }
}

/** A bookmark tree sent back by the import window, checked again (addresses, size, depth). */
export function cleanTree(nodes: unknown): BookmarkNode[] {
  let budget = MAX_NODES
  let seq = 0
  const walk = (list: unknown, depth: number): BookmarkNode[] => {
    if (!Array.isArray(list) || depth > MAX_DEPTH) return []
    const out: BookmarkNode[] = []
    for (const raw of list) {
      if (budget-- <= 0) break
      const n = raw as Partial<BookmarkNode>
      const title = typeof n?.title === 'string' ? n.title : ''
      if (Array.isArray(n?.children)) out.push({ id: `c${seq++}`, title, children: walk(n.children, depth + 1) })
      else if (typeof n?.url === 'string' && n.url)
        out.push(bookmark(`c${seq++}`, title || fallbackTitle(n.url), n.url))
    }
    return out
  }
  return walk(nodes, 0)
}
