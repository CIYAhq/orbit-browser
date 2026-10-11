import type { BookmarkNode, ParsedFile } from '../../shared/commands/import'
import { isLongList, MAX_FILE_BYTES, parseLinkList, TOO_LARGE } from '../../shared/commands/import'
import { fallbackTitle } from '../../shared/url'
import {
  bookmark,
  countBookmarks,
  cutTitle,
  MAX_BOOKMARKS,
  MAX_DEPTH,
  MAX_FOLDERS,
  NO_BOOKMARKS,
  readBookmarksHtml,
} from './netscape'

/** Why a bookmark (or link) past `MAX_BOOKMARKS` was left out (IM-14): folders don't count toward it (N7). */
export const OVER_LIMIT = 'More than 200,000 in one import'

/** IM-13: the folder a bookmarks file goes into. */
export const FILE_FOLDER_NAME = 'Imported bookmarks'

/** A list of links, read once (D58): how many links it holds, its first lines, and whether it's too long to edit. */
export interface LinksInfo {
  count: number
  preview: string[]
  /** Too long to edit (D62 (5)): the import window shows only the count and the preview. */
  long: boolean
}

/** Lines of a long list the import window shows, and how much of each. */
const PREVIEW_LINES = 8
const PREVIEW_CHARS = 200

/** Counts a list's links and takes its first lines (IM-12, D62 (5)). Linear in the text's size. */
export function linksInfo(text: string): LinksInfo {
  const preview: string[] = []
  for (let at = 0; at < text.length && preview.length < PREVIEW_LINES; ) {
    const end = text.indexOf('\n', at)
    const line = text.slice(at, Math.min(end < 0 ? text.length : end, at + PREVIEW_CHARS))
    preview.push(line.endsWith('\r') ? line.slice(0, -1) : line)
    if (end < 0) break
    at = end + 1
  }
  return { count: parseLinkList(text).links.length, preview, long: isLongList(text) }
}

/** A dropped or chosen file, read (IM-13): its bookmarks, its links, or why it can't be read. */
export type FileContents =
  | { kind: 'bookmarks'; name: string; tree: BookmarkNode[]; count: number; cut: number }
  | { kind: 'links'; name: string; info: LinksInfo }
  | Extract<ParsedFile, { kind: 'error' }>

/** Reads a dropped or chosen file: a bookmarks HTML file, or a plain list of links (IM-13). */
export function parseFile(name: string, text: string): FileContents {
  if (text.length > MAX_FILE_BYTES) return { kind: 'error', name, message: TOO_LARGE }
  const looksHtml = /<(!doctype|dl|dt|a)[\s>]/i.test(text)
  if (/\.txt$/i.test(name) || !looksHtml) {
    const info = linksInfo(text)
    if (info.count > 0) return { kind: 'links', name, info }
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
 * aren't links are only counted (`lines`), and so are links past `MAX_BOOKMARKS` (`cut`).
 */
export function linkNodes(text: string): { nodes: BookmarkNode[]; lines: number; cut: number } {
  const { links, skipped } = parseLinkList(text.slice(0, MAX_FILE_BYTES))
  const nodes = links.slice(0, MAX_BOOKMARKS).map((l, i) => bookmark(`l${i}`, cutTitle(l.title ?? ''), l.url))
  return { nodes, lines: skipped, cut: Math.max(0, links.length - MAX_BOOKMARKS) }
}

/**
 * What the reader worker is asked (D58): a dropped file's bytes, a chosen file's path, a pasted list's bytes, or a list
 * of links to make bookmarks of (its text, or the bytes main holds). Bytes are UTF-8 and are moved to the worker, not
 * copied: main's thread never turns them into text (D62 (5)).
 */
export type ReadRequest =
  | { op: 'file'; name: string; bytes: Uint8Array }
  | { op: 'path'; name: string; path: string }
  | { op: 'list'; name: string; bytes: Uint8Array }
  | { op: 'links'; list: string | Uint8Array }

/**
 * The worker's answer for a file or a pasted list: a bookmarks file's tree as JSON text; a list's count and first lines,
 * with its text when it edits well, or else its bytes, moved back for main to hold (D62 (5)); or why it can't be read.
 */
export type FileRead =
  | Extract<ParsedFile, { kind: 'bookmarks' | 'error' }>
  | { kind: 'links'; name: string; info: LinksInfo; text?: string; bytes?: Uint8Array }

/** UTF-8 bytes as text, as a dropped file's `text()` reads them (a byte-order mark dropped, bad bytes replaced). */
export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

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
  // Iterative, so no tree is too deep for it. Folders deeper than `MAX_DEPTH`, or past `MAX_FOLDERS`, are flattened, as
  // a file's are, and bookmarks past `MAX_BOOKMARKS` are counted, not kept (F1, F3, N7). Every value is visited once.
  const out: BookmarkNode[] = []
  let folders = MAX_FOLDERS
  let bookmarks = MAX_BOOKMARKS
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
        if (folders <= 0 || bookmarks <= 0 || at.depth >= MAX_DEPTH) {
          held.push({ list: n.children, out: at.out, depth: at.depth })
          continue
        }
        folders--
        const folder: BookmarkNode = { id: `c${seq++}`, title, children: [] }
        at.out.push(folder)
        held.push({ list: n.children, out: folder.children as BookmarkNode[], depth: at.depth + 1 })
      } else if (typeof n?.url === 'string' && n.url) {
        if (bookmarks <= 0) {
          cut++
          continue
        }
        bookmarks--
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
