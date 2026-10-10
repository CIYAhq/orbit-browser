/**
 * The Netscape bookmark file (IM-13, IM-17): the HTML every browser exports and imports.
 * Pure (no Electron), so it is unit-tested directly.
 *
 * Reading keeps folders (H3 + DL), their order, and each link's title and address; it ignores
 * everything else (icons, dates, descriptions, tags). Writing produces the same format.
 */
import type { BookmarkNode } from '../../shared/commands/import'

export const NO_BOOKMARKS = 'No bookmarks found in this file'

const CLOSE_H3 = /<\/h3\s*>/gi
const CLOSE_A = /<\/a\s*>/gi

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

function cleanText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
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

/** Bookmarks that will become pinned tabs (not counting skipped ones). */
export function countBookmarks(nodes: readonly BookmarkNode[]): number {
  let n = 0
  for (const node of nodes) {
    if (node.children) n += countBookmarks(node.children)
    else if (node.url && !node.skip) n++
  }
  return n
}

/** Every bookmark, skipped ones included. */
export function countAll(nodes: readonly BookmarkNode[]): number {
  let n = 0
  for (const node of nodes) n += node.children ? countAll(node.children) : node.url ? 1 : 0
  return n
}

/**
 * Reads a bookmarks HTML file. Returns the top-level items (the file's root list), or undefined
 * when it holds no bookmarks: not this format, empty, or too broken to read.
 */
export function parseBookmarksHtml(html: string): BookmarkNode[] | undefined {
  if (!/<!doctype\s+netscape-bookmark-file/i.test(html) && !(/<dl[\s>]/i.test(html) && /<dt[\s>]/i.test(html))) {
    return undefined
  }
  const root: BookmarkNode[] = []
  const stack: BookmarkNode[][] = [root]
  /** A folder whose H3 was just read: the next DL holds its children. */
  let opened: BookmarkNode | undefined
  let seq = 0
  const tag = /<(\/?)(dl|h3|a)\b([^>]*)>/gi
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    const closing = m[1] === '/'
    const name = (m[2] as string).toLowerCase()
    const attrs = m[3] ?? ''
    const level = stack[stack.length - 1] as BookmarkNode[]
    if (name === 'dl') {
      if (closing) {
        if (stack.length > 1) stack.pop()
      } else {
        // A DL right after a folder's title is that folder's list; any other DL is the file's own.
        stack.push(opened?.children ?? level)
      }
      opened = undefined
      continue
    }
    if (closing) continue
    const close = name === 'h3' ? CLOSE_H3 : CLOSE_A
    close.lastIndex = tag.lastIndex
    const end = close.exec(html)?.index ?? -1
    const inner = end >= 0 ? html.slice(tag.lastIndex, end) : ''
    if (end >= 0) tag.lastIndex = end
    if (name === 'h3') {
      const folder: BookmarkNode = { id: `n${seq++}`, title: cleanText(inner) || 'Untitled folder', children: [] }
      level.push(folder)
      opened = folder
    } else {
      opened = undefined
      const href = attribute(attrs, 'href')
      if (!href) continue
      level.push(bookmark(`n${seq++}`, cleanText(inner) || href, href))
    }
  }
  return countAll(root) > 0 ? root : undefined
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
