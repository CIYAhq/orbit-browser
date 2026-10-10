import type { BookmarkNode } from '../../shared/commands/import'
import { MAX_DEPTH } from './chromium'
import { bookmark } from './netscape'

/**
 * Safari's files (macOS only): `Bookmarks.plist`, a binary property list, and `History.db`. Reading
 * them needs Full Disk Access; without it Safari is listed with the way round it (IM-02). Built
 * from the formats' public descriptions and tested on fixtures; unverified against a real Safari.
 */

/** More objects than any bookmarks file holds: a file that claims more is not read. */
const MAX_OBJECTS = 2_000_000

/** Reads a binary property list ("bplist00"). Throws on anything else or anything broken. */
export function parseBplist(buf: Buffer): unknown {
  if (buf.length < 40 || buf.toString('latin1', 0, 8) !== 'bplist00') throw new Error('Not a binary property list')
  const t = buf.length - 32
  const offsetSize = buf[t + 6] as number
  const refSize = buf[t + 7] as number
  const count = Number(buf.readBigUInt64BE(t + 8))
  const top = Number(buf.readBigUInt64BE(t + 16))
  const table = Number(buf.readBigUInt64BE(t + 24))
  if (!offsetSize || !refSize || count > MAX_OBJECTS || table + count * offsetSize > t) {
    throw new Error('Broken property list')
  }
  const uint = (at: number, size: number) => {
    if (at + size > t) throw new Error('Broken property list')
    let v = 0
    for (let i = 0; i < size; i++) v = v * 256 + (buf[at + i] as number)
    return v
  }
  let budget = MAX_OBJECTS
  const read = (index: number, depth: number): unknown => {
    if (index >= count || depth > MAX_DEPTH || budget-- <= 0) throw new Error('Broken property list')
    const at = uint(table + index * offsetSize, offsetSize)
    const marker = uint(at, 1)
    const kind = marker >> 4
    const info = marker & 0xf
    let start = at + 1
    const length = () => {
      if (info !== 0xf) return info
      const size = 1 << (uint(start, 1) & 0xf)
      const n = uint(start + 1, size)
      start += 1 + size
      return n
    }
    switch (kind) {
      case 0x0:
        return info === 0x9 ? true : info === 0x8 ? false : null
      case 0x1:
        return uint(start, 1 << info)
      case 0x2:
        return info === 2 ? buf.readFloatBE(start) : buf.readDoubleBE(start)
      case 0x3:
        return new Date((buf.readDoubleBE(start) + 978_307_200) * 1000)
      case 0x4: {
        const n = length()
        return buf.subarray(start, start + n)
      }
      case 0x5: {
        const n = length()
        return buf.toString('latin1', start, start + n)
      }
      case 0x6: {
        const n = length()
        return Buffer.from(buf.subarray(start, start + 2 * n))
          .swap16()
          .toString('utf16le')
      }
      case 0x8:
        return uint(start, info + 1)
      case 0xa: {
        const n = length()
        return Array.from({ length: n }, (_, i) => read(uint(start + i * refSize, refSize), depth + 1))
      }
      case 0xd: {
        const n = length()
        const out: Record<string, unknown> = {}
        for (let i = 0; i < n; i++) {
          const key = read(uint(start + i * refSize, refSize), depth + 1)
          out[String(key)] = read(uint(start + (n + i) * refSize, refSize), depth + 1)
        }
        return out
      }
      default:
        throw new Error('Broken property list')
    }
  }
  return read(top, 0)
}

/** Safari's lists by the names it shows ("Favorites bar", so it isn't taken for Orbit's Favorites). */
const ROOTS: Record<string, string> = {
  BookmarksBar: 'Favorites bar',
  BookmarksMenu: 'Bookmarks Menu',
  'com.apple.ReadingList': 'Reading List',
}

interface SafariNode {
  WebBookmarkType?: unknown
  Title?: unknown
  URLString?: unknown
  URIDictionary?: { title?: unknown }
  Children?: unknown
}

/** `Bookmarks.plist` as a tree: the favorites bar, bookmarks menu and reading list as folders (IM-04). */
export function safariBookmarks(plist: unknown): BookmarkNode[] {
  let seq = 0
  const walk = (list: unknown, depth: number, top: boolean): BookmarkNode[] => {
    if (!Array.isArray(list) || depth > MAX_DEPTH) return []
    const out: BookmarkNode[] = []
    for (const n of list as (SafariNode | null)[]) {
      const title = typeof n?.Title === 'string' ? n.Title.trim() : ''
      if (n?.WebBookmarkType === 'WebBookmarkTypeList') {
        const children = walk(n.Children, depth + 1, false)
        if (!top || children.length > 0) {
          out.push({
            id: `s${seq++}`,
            title: (top ? ROOTS[title] : undefined) ?? (title || 'Untitled folder'),
            children,
          })
        }
      } else if (n?.WebBookmarkType === 'WebBookmarkTypeLeaf' && typeof n.URLString === 'string' && n.URLString) {
        const name = typeof n.URIDictionary?.title === 'string' ? n.URIDictionary.title.trim() : ''
        out.push(bookmark(`s${seq++}`, name || n.URLString, n.URLString))
      }
    }
    return out
  }
  return walk((plist as SafariNode | null)?.Children, 1, true)
}
