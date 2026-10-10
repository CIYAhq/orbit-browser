import type { BookmarkNode, ParsedFile } from '../../shared/commands/import'
import { MAX_FILE_BYTES, parseLinkList, TOO_LARGE } from '../../shared/commands/import'
import { fallbackTitle } from '../../shared/url'
import { bookmark, countBookmarks, cutTitle, MAX_DEPTH, MAX_NODES, NO_BOOKMARKS, readBookmarksHtml } from './netscape'

/** Why a bookmark (or link) past `MAX_NODES` was left out (IM-14). */
export const OVER_LIMIT = 'More than 200,000 in one import'

/** IM-13: the folder a bookmarks file goes into. */
export const FILE_FOLDER_NAME = 'Imported bookmarks'

/** A dropped or chosen file, read (IM-13): its bookmarks, its links, or why it can't be read. */
export type FileContents =
  | { kind: 'bookmarks'; name: string; tree: BookmarkNode[]; count: number; cut: number }
  | Exclude<ParsedFile, { kind: 'bookmarks' }>

/** Reads a dropped or chosen file: a bookmarks HTML file, or a plain list of links (IM-13). */
export function parseFile(name: string, text: string): FileContents {
  if (text.length > MAX_FILE_BYTES) return { kind: 'error', name, message: TOO_LARGE }
  const looksHtml = /<(!doctype|dl|dt|a)[\s>]/i.test(text)
  if (/\.txt$/i.test(name) || !looksHtml) {
    const { links } = parseLinkList(text)
    if (links.length > 0) return { kind: 'links', name, text, count: links.length }
    return { kind: 'error', name, message: NO_BOOKMARKS }
  }
  const read = readBookmarksHtml(text)
  if (!read) return { kind: 'error', name, message: NO_BOOKMARKS }
  return { kind: 'bookmarks', name, tree: read.tree, count: countBookmarks(read.tree), cut: read.cut }
}

/** IM-12: the folder a list of links goes into when the import window sends no name. */
export const LINKS_FOLDER_NAME = 'Imported links'

/**
 * A list of links (IM-12), pasted or from a .txt file, as bookmarks in their order. Lines that
 * aren't links are only counted (`lines`), and so are links past `MAX_NODES` (`cut`).
 */
export function linkNodes(text: string): { nodes: BookmarkNode[]; lines: number; cut: number } {
  const { links, skipped } = parseLinkList(text.slice(0, MAX_FILE_BYTES))
  const nodes = links.slice(0, MAX_NODES).map((l, i) => bookmark(`l${i}`, cutTitle(l.title ?? ''), l.url))
  return { nodes, lines: skipped, cut: Math.max(0, links.length - MAX_NODES) }
}

/** What the reader worker is asked (D58): a file's text or path, or a list of links. */
export type ReadRequest =
  | { op: 'file'; name: string; text: string }
  | { op: 'path'; name: string; path: string }
  | { op: 'links'; text: string }

/** A list of links, read: its bookmarks as JSON text in parts, which main reads one at a time (D58). */
export interface LinksRead {
  parts: string[]
  lines: number
  cut: number
}

/** Bookmarks per part of a `LinksRead`: reading one part takes main a few milliseconds. */
export const PART_SIZE = 5000

/** A bookmark tree sent back by the import window, checked again (addresses, size, depth). */
export function cleanTree(nodes: unknown): { nodes: BookmarkNode[]; cut: number } {
  // Iterative, so no tree is too deep for it. Folders deeper than `MAX_DEPTH` are flattened, as a file's are, and
  // items past `MAX_NODES` are counted, not kept (F1, F3). Every value is visited at most once.
  const out: BookmarkNode[] = []
  let budget = MAX_NODES
  let seq = 0
  let cut = 0
  const lists: { list: unknown[]; out: BookmarkNode[]; depth: number }[] = []
  const seen = new Set<unknown>()
  const enter = (list: unknown, into: BookmarkNode[], depth: number) => {
    if (Array.isArray(list) && !seen.has(list)) {
      seen.add(list)
      lists.push({ list, out: into, depth })
    }
  }
  enter(nodes, out, 0)
  // Each list is read to its end before the lists it holds, in reverse so that the first is read first.
  for (let at = lists.pop(); at; at = lists.pop()) {
    const held: { list: unknown; out: BookmarkNode[]; depth: number }[] = []
    for (const raw of at.list) {
      const n = raw as Partial<BookmarkNode> | null
      const title = typeof n?.title === 'string' ? cutTitle(n.title) : ''
      if (Array.isArray(n?.children)) {
        if (budget <= 0 || at.depth >= MAX_DEPTH) {
          held.push({ list: n.children, out: at.out, depth: at.depth })
          continue
        }
        budget--
        const folder: BookmarkNode = { id: `c${seq++}`, title, children: [] }
        at.out.push(folder)
        held.push({ list: n.children, out: folder.children as BookmarkNode[], depth: at.depth + 1 })
      } else if (typeof n?.url === 'string' && n.url) {
        if (budget <= 0) {
          cut++
          continue
        }
        budget--
        at.out.push(bookmark(`c${seq++}`, title || fallbackTitle(n.url), n.url))
      }
    }
    for (let i = held.length - 1; i >= 0; i--) {
      const h = held[i] as (typeof held)[number]
      enter(h.list, h.out, h.depth)
    }
  }
  return { nodes: out, cut }
}
