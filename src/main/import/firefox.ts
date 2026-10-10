import type { DatabaseSync } from 'node:sqlite'
import type { BookmarkNode } from '../../shared/commands/import'
import { MAX_DEPTH } from './chromium'
import { bookmark } from './netscape'

/**
 * Firefox's files: `profiles.ini` lists the profiles; each keeps its bookmarks and history in
 * `places.sqlite`, read from a copy (IM-14). Pure but for the queries, so it is unit-tested on fixtures.
 */

export interface FirefoxProfile {
  name: string
  path: string
  relative: boolean
}

/** `profiles.ini`'s profiles: the one an install opens by default first, then in the file's order (IM-02). */
export function firefoxProfiles(ini: string): FirefoxProfile[] {
  const sections: { name: string; values: Record<string, string> }[] = []
  for (const raw of ini.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const head = /^\[(.+)\]$/.exec(line)
    if (head) sections.push({ name: head[1] as string, values: {} })
    const eq = line.indexOf('=')
    const at = sections[sections.length - 1]
    if (!head && eq > 0 && at) at.values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  const installDefaults = new Set(sections.filter((s) => s.name.startsWith('Install')).map((s) => s.values.Default))
  const rank = (s: (typeof sections)[number]) =>
    installDefaults.has(s.values.Path) ? 0 : s.values.Default === '1' ? 1 : 2
  return sections
    .filter((s) => /^Profile\d+$/.test(s.name) && s.values.Path)
    .sort((a, b) => rank(a) - rank(b))
    .map((s) => ({
      name: s.values.Name || (s.values.Path as string),
      path: s.values.Path as string,
      relative: s.values.IsRelative !== '0',
    }))
}

/** A row of `moz_bookmarks` with its page's address and title. */
export interface PlacesRow {
  id: number
  type: number
  parent: number
  position: number
  title: string | null
  guid: string | null
  url: string | null
  pageTitle: string | null
}

const BOOKMARK_ROWS = `SELECT b.id AS id, b.type AS type, b.parent AS parent, b.position AS position, b.title AS title,
  b.guid AS guid, p.url AS url, p.title AS pageTitle FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk`

/** Firefox's roots by the names it shows; its tags aren't bookmarks to import. */
const ROOTS: [guid: string, title: string][] = [
  ['toolbar_____', 'Bookmarks Toolbar'],
  ['menu________', 'Bookmarks Menu'],
  ['unfiled_____', 'Other Bookmarks'],
  ['mobile______', 'Mobile Bookmarks'],
]

/** Bookmarks as a tree: toolbar, menu, other and mobile bookmarks as folders; separators and tags left out. */
export function firefoxBookmarks(rows: readonly PlacesRow[]): BookmarkNode[] {
  const children = new Map<number, PlacesRow[]>()
  for (const r of rows) {
    const list = children.get(r.parent) ?? []
    list.push(r)
    children.set(r.parent, list)
  }
  for (const list of children.values()) list.sort((a, b) => a.position - b.position)
  let seq = 0
  const walk = (parent: number, depth: number): BookmarkNode[] => {
    if (depth > MAX_DEPTH) return []
    const out: BookmarkNode[] = []
    for (const r of children.get(parent) ?? []) {
      const title = (r.title ?? '').trim()
      if (r.type === 2)
        out.push({ id: `f${seq++}`, title: title || 'Untitled folder', children: walk(r.id, depth + 1) })
      else if (r.type === 1 && r.url)
        out.push(bookmark(`f${seq++}`, title || (r.pageTitle ?? '').trim() || r.url, r.url))
    }
    return out
  }
  const byGuid = new Map(rows.map((r) => [r.guid, r]))
  return ROOTS.map(([guid, title]) => {
    const root = byGuid.get(guid)
    return { title, children: root ? walk(root.id, 1) : [] }
  })
    .filter((root) => root.children.length > 0)
    .map((root) => ({ id: `f${seq++}`, ...root }))
}

export function readFirefoxBookmarks(db: DatabaseSync): BookmarkNode[] {
  return firefoxBookmarks(db.prepare(BOOKMARK_ROWS).all() as unknown as PlacesRow[])
}
