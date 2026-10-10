import type { BookmarkNode } from '../../shared/commands/import'
import { bookmark } from './netscape'

/**
 * The Chromium family's files (Chrome, Chromium, Brave, Edge, Vivaldi, Opera): `Local State` names
 * the profiles; each profile keeps `Bookmarks` (JSON). Pure, so it is unit-tested on fixtures.
 */

export const MAX_DEPTH = 64

/** A profile as its browser lists it: its folder and the name the user gave it. */
export interface ProfileEntry {
  folder: string
  name: string
}

/** A folder name with no path in it (the list comes from another program's file). */
export const isPlainFolder = (f: string) => !!f && f !== '.' && f !== '..' && !/[\\/\0]/.test(f)

/** `Local State`'s profiles, in the browser's own order (IM-02). */
export function chromiumProfiles(localState: string): ProfileEntry[] {
  let data: { profile?: { info_cache?: unknown; profiles_order?: unknown } } | undefined
  try {
    data = JSON.parse(localState)
  } catch {
    return []
  }
  const cache = data?.profile?.info_cache as Record<string, { name?: unknown } | undefined> | undefined
  if (!cache || typeof cache !== 'object') return []
  const order = Array.isArray(data?.profile?.profiles_order) ? (data.profile.profiles_order as unknown[]) : []
  const folders = new Set([...order.filter((f): f is string => typeof f === 'string'), ...Object.keys(cache)])
  return [...folders]
    .filter((f) => cache[f] && isPlainFolder(f))
    .map((folder) => {
      const name = cache[folder]?.name
      return { folder, name: typeof name === 'string' && name.trim() ? name.trim() : folder }
    })
}

/** Chromium's three roots, by the names people know them by (IM-04, IM-05). */
const ROOTS: [key: string, title: string][] = [
  ['bookmark_bar', 'Bookmarks bar'],
  ['other', 'Other bookmarks'],
  ['synced', 'Mobile bookmarks'],
]

interface RawNode {
  type?: unknown
  name?: unknown
  url?: unknown
  children?: unknown
  [key: string]: unknown
}

/**
 * A profile's `Bookmarks` as a tree: the bookmarks bar, other and mobile bookmarks become folders
 * (empty ones left out), with their folders and order kept.
 */
export function chromiumBookmarks(json: string): BookmarkNode[] {
  const data = JSON.parse(json) as { roots?: Record<string, RawNode | undefined> } | null
  let seq = 0
  const walk = (list: unknown, depth: number): BookmarkNode[] => {
    if (!Array.isArray(list) || depth > MAX_DEPTH) return []
    const out: BookmarkNode[] = []
    for (const n of list as (RawNode | null)[]) {
      const title = typeof n?.name === 'string' ? n.name.trim() : ''
      if (n?.type === 'folder') {
        out.push({ id: `b${seq++}`, title: title || 'Untitled folder', children: walk(n.children, depth + 1) })
      } else if (n?.type === 'url' && typeof n.url === 'string' && n.url) {
        out.push(bookmark(`b${seq++}`, title || n.url, n.url))
      }
    }
    return out
  }
  return ROOTS.map(([key, title]) => ({ title, children: walk(data?.roots?.[key]?.children, 1) }))
    .filter((root) => root.children.length > 0)
    .map((root) => ({ id: `b${seq++}`, ...root }))
}
