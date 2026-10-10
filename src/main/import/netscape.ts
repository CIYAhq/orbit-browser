/**
 * The Netscape bookmark file (IM-13, IM-17): the HTML every browser exports and imports.
 * Pure (no Electron), so it is unit-tested directly.
 *
 * Reading keeps folders (H3 + DL), their order, and each link's title and address; it ignores
 * everything else (icons, dates, descriptions, tags). Writing produces the same format.
 */
import type { BookmarkNode } from '../../shared/commands/import'

export const NO_BOOKMARKS = 'No bookmarks found in this file'

/**
 * Where a title ends: at its close tag or, when the file leaves that out (HTML lets it), at the next item or list. The
 * search never goes past those, so each part of the file is read once (D58).
 */
const TEXT_END = /<\/?(?:a|h3|dt|dd|dl)\b/gi
/** A title is cut to this many characters (a pinned tab keeps 400). */
export const MAX_TITLE = 1000
/** Folders deeper than this are flattened: their items go in the deepest folder kept (F1). */
export const MAX_DEPTH = 64
/** Bookmarks past this many in one import are left out, and counted (IM-14). Folders don't count toward it (N7). */
export const MAX_BOOKMARKS = 200_000
/** Folders past this many aren't made: their items go in the folder that holds them, as a folder too deep does (F1). */
export const MAX_FOLDERS = 20_000

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1] === 'x' || code[1] === 'X' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole
    }
    return ENTITIES[code.toLowerCase()] ?? whole
  })
}

/** A title's text: tags dropped, entities decoded, spaces collapsed, cut to `MAX_TITLE`. */
export function cleanText(html: string): string {
  // `[^<>]` keeps each "<" a tag can start at to one scan (D58).
  const text = decodeEntities(html.replace(/<[^<>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
  return cutTitle(text)
}

/** `text` cut to `MAX_TITLE` characters, never in the middle of a character. */
export function cutTitle(text: string): string {
  if (text.length <= MAX_TITLE) return text
  const code = text.charCodeAt(MAX_TITLE - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? MAX_TITLE - 1 : MAX_TITLE)
}

function attribute(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs)
  if (!m) return undefined
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim()
}

/**
 * Why a bookmark's address can't be a pinned tab, or undefined when it can. Web pages and local
 * files are kept; a browser's own pages, bookmarklets and saved searches are not.
 */
export function skipReason(url: string): string | undefined {
  if (url.length > 4096) return 'Address too long'
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase()
  if (!scheme) return 'Not a web address'
  if (scheme === 'http' || scheme === 'https') {
    try {
      return new URL(url).host ? undefined : 'Not a web address'
    } catch {
      return 'Not a web address'
    }
  }
  if (scheme === 'file') return undefined
  if (scheme === 'javascript') return 'Bookmarklet (a script, not a page)'
  if (scheme === 'place') return 'Saved search, not a page'
  if (/^(chrome|edge|brave|vivaldi|opera|about|chrome-extension|moz-extension|extension|safari-resource)$/.test(scheme))
    return 'A page only that browser can open'
  return 'Not a web address'
}

/** A bookmark node for `url`, marked when it can't be imported. */
export function bookmark(id: string, title: string, url: string): BookmarkNode {
  const reason = skipReason(url)
  return reason ? { id, title, url, skip: reason } : { id, title, url }
}

/** One item of another browser's bookmarks, as `buildTree` reads it: a folder and what it holds, or a bookmark. */
export type SourceItem<T> = { title: string; children: readonly T[] } | { title: string; url: string } | undefined

/**
 * Another browser's bookmarks as a tree, in their order. Iterative, so no source is too deep for it: folders deeper
 * than `MAX_DEPTH` are flattened in place, their items going in the deepest folder kept (F1). `depth` is how many
 * folders deep `items` already is. A list of items is read once, even when a damaged source holds it twice.
 */
export function buildTree<T>(
  items: readonly T[],
  depth: number,
  id: () => string,
  read: (item: T) => SourceItem<T>,
): BookmarkNode[] {
  const root: BookmarkNode[] = []
  const seen = new Set<readonly T[]>([items])
  const stack: { items: readonly T[]; at: number; out: BookmarkNode[]; depth: number }[] = [
    { items, at: 0, out: root, depth },
  ]
  for (let top = stack.at(-1); top; top = stack.at(-1)) {
    if (top.at >= top.items.length) {
      stack.pop()
      continue
    }
    const item = read(top.items[top.at++] as T)
    if (!item) continue
    if ('url' in item) {
      top.out.push(bookmark(id(), cutTitle(item.title) || cutTitle(item.url), item.url))
      continue
    }
    if (seen.has(item.children)) continue
    seen.add(item.children)
    if (top.depth >= MAX_DEPTH) {
      stack.push({ items: item.children, at: 0, out: top.out, depth: top.depth })
      continue
    }
    const folder: BookmarkNode = { id: id(), title: cutTitle(item.title) || 'Untitled folder', children: [] }
    top.out.push(folder)
    stack.push({ items: item.children, at: 0, out: folder.children as BookmarkNode[], depth: top.depth + 1 })
  }
  return root
}

/** Calls `visit` for every node under `nodes`. Iterative: a tree from a file can be deeper than the stack (F1). */
export function eachNode(nodes: readonly BookmarkNode[], visit: (node: BookmarkNode) => void): void {
  const lists: (readonly BookmarkNode[])[] = [nodes]
  for (let list = lists.pop(); list; list = lists.pop()) {
    for (const node of list) {
      visit(node)
      if (node.children) lists.push(node.children)
    }
  }
}

/** Bookmarks that will become pinned tabs (not counting skipped ones). */
export function countBookmarks(nodes: readonly BookmarkNode[]): number {
  let n = 0
  eachNode(nodes, (node) => {
    if (!node.children && node.url && !node.skip) n++
  })
  return n
}

/** Every bookmark, skipped ones included. */
export function countAll(nodes: readonly BookmarkNode[]): number {
  let n = 0
  eachNode(nodes, (node) => {
    if (!node.children && node.url) n++
  })
  return n
}

/** A bookmarks file read: its top-level items, and the bookmarks left out past `MAX_BOOKMARKS`. */
export interface BookmarksFile {
  tree: BookmarkNode[]
  cut: number
}

/**
 * Reads a bookmarks HTML file. Returns the top-level items (the file's root list), or undefined
 * when it holds no bookmarks: not this format, empty, or too broken to read.
 */
export function parseBookmarksHtml(html: string): BookmarkNode[] | undefined {
  return readBookmarksHtml(html)?.tree
}

/**
 * Reads a bookmarks HTML file in one pass, in time linear in its size (D58): each tag and each title is read once.
 * Folders deeper than `MAX_DEPTH`, or past `MAX_FOLDERS`, are flattened into the one that holds them, and bookmarks
 * past `MAX_BOOKMARKS` are counted, not kept (F1, F3, N7).
 */
export function readBookmarksHtml(html: string): BookmarksFile | undefined {
  if (!/<!doctype\s+netscape-bookmark-file/i.test(html) && !(/<dl[\s>]/i.test(html) && /<dt[\s>]/i.test(html))) {
    return undefined
  }
  const root: BookmarkNode[] = []
  /** The open lists, innermost last, and how many folders deep each is. */
  const stack: BookmarkNode[][] = [root]
  const depths: number[] = [0]
  /** A folder whose H3 was just read: the next DL holds its children. */
  let opened: BookmarkNode | undefined
  let seq = 0
  let folders = 0
  let bookmarks = 0
  let cut = 0
  // `[^<>]` ends a tag's attributes at the next "<" too, so a "<a" with no ">" is read once (D58).
  const tag = /<(\/?)(dl|h3|a)\b([^<>]*)>/gi
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    const closing = m[1] === '/'
    const name = (m[2] as string).toLowerCase()
    const attrs = m[3] ?? ''
    const level = stack[stack.length - 1] as BookmarkNode[]
    const depth = depths[depths.length - 1] as number
    if (name === 'dl') {
      if (closing) {
        if (stack.length > 1) {
          stack.pop()
          depths.pop()
        }
      } else {
        // A DL right after a folder's title is that folder's list; any other DL is the file's own.
        stack.push(opened?.children ?? level)
        depths.push(opened ? depth + 1 : depth)
      }
      opened = undefined
      continue
    }
    if (closing) continue
    TEXT_END.lastIndex = tag.lastIndex
    const end = TEXT_END.exec(html)?.index ?? html.length
    const inner = html.slice(tag.lastIndex, end)
    tag.lastIndex = end
    opened = undefined
    if (name === 'h3') {
      // Too deep, past the folders' limit or the bookmarks': no folder, so the next DL's items go in this one's list (F1).
      if (depth >= MAX_DEPTH || folders >= MAX_FOLDERS || bookmarks >= MAX_BOOKMARKS) continue
      folders++
      const folder: BookmarkNode = { id: `n${seq++}`, title: cleanText(inner) || 'Untitled folder', children: [] }
      level.push(folder)
      opened = folder
    } else {
      const href = attribute(attrs, 'href')
      if (!href) continue
      if (bookmarks >= MAX_BOOKMARKS) cut++
      else {
        bookmarks++
        level.push(bookmark(`n${seq++}`, cleanText(inner) || cutTitle(href), href))
      }
    }
  }
  return countAll(root) > 0 ? { tree: root, cut } : undefined
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** One folder or link of an export (IM-17). */
export interface ExportNode {
  title: string
  url?: string
  children?: ExportNode[]
  addDate?: number
}

/** Writes a bookmarks HTML file that other browsers import (IM-17). */
export function writeBookmarksHtml(nodes: readonly ExportNode[]): string {
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file.',
    '     It will be read and overwritten.',
    '     DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ]
  const walk = (list: readonly ExportNode[], depth: number) => {
    const pad = '    '.repeat(depth)
    for (const node of list) {
      const date = node.addDate ? ` ADD_DATE="${Math.floor(node.addDate / 1000)}"` : ''
      if (node.children) {
        lines.push(`${pad}<DT><H3${date}>${escapeHtml(node.title)}</H3>`, `${pad}<DL><p>`)
        walk(node.children, depth + 1)
        lines.push(`${pad}</DL><p>`)
      } else if (node.url) {
        lines.push(`${pad}<DT><A HREF="${escapeHtml(node.url)}"${date}>${escapeHtml(node.title)}</A>`)
      }
    }
  }
  walk(nodes, 1)
  lines.push('</DL><p>', '')
  return lines.join('\n')
}
