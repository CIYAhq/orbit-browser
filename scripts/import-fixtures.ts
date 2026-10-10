/**
 * Builds the import lane's test fixtures (IM-*) from made-up data, into `tests/fixtures/import/`:
 * - `files/bookmarks.htm`, `files/bookmarks-firefox.htm`: bookmarks files as browsers export them
 *   (folders, a bookmarklet, a browser's own page, entities);
 * - `files/links.txt`: a list of links, plain and "Title — address";
 * - `files/malformed.htm`: an HTML file with no bookmarks in it;
 * - `chrome/`, `firefox/`, `safari/`: the folders where those browsers keep their profiles, with only
 *   the files Orbit reads (IM-02 to IM-09): Chromium's `Local State`, `Bookmarks`, `History` and
 *   `Preferences`; Firefox's `profiles.ini` and `places.sqlite`; Safari's `Bookmarks.plist` (a binary
 *   property list) and `History.db`.
 * HTML fixtures end in `.htm`, which the linter leaves alone: an export isn't meant to be valid HTML.
 *
 * Run it with `node scripts/import-fixtures.ts` after changing it, and commit what it writes. Tests
 * also import its builders to make large files on the fly. Nothing here reads anything on this
 * machine: every name, address and date is invented.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

export const FIXTURE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'import')

/** A made-up bookmark (with `url`) or folder (with `children`). */
export interface FixtureNode {
  title: string
  url?: string
  children?: FixtureNode[]
}

/** A fixed date for every fixture (2024-03-01), so the files don't change between runs. */
const ADDED = 1709251200

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * A Netscape bookmark file. `style` follows one exporter's habits: Chromium's (bookmarks bar flag,
 * `<p>` after lists), or Firefox's (`<DD>` descriptions, `<HR>`, unquoted-looking extras).
 */
export function netscapeHtml(nodes: readonly FixtureNode[], style: 'chromium' | 'firefox' = 'chromium'): string {
  const out = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file.',
    '     It will be read and overwritten.',
    '     DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    style === 'firefox' ? '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">' : '',
    '<TITLE>Bookmarks</TITLE>',
    style === 'firefox' ? '<H1>Bookmarks Menu</H1>' : '<H1>Bookmarks</H1>',
    '<DL><p>',
  ]
  const walk = (list: readonly FixtureNode[], depth: number, top: boolean) => {
    const pad = '    '.repeat(depth)
    list.forEach((node, i) => {
      if (node.children) {
        const flag = top && i === 0 ? ' PERSONAL_TOOLBAR_FOLDER="true"' : ''
        out.push(`${pad}<DT><H3 ADD_DATE="${ADDED}" LAST_MODIFIED="${ADDED}"${flag}>${escapeHtml(node.title)}</H3>`)
        out.push(`${pad}<DL><p>`)
        walk(node.children, depth + 1, false)
        out.push(`${pad}</DL><p>`)
        if (style === 'firefox' && top) out.push(`${pad}<HR>`)
      } else if (node.url) {
        const icon = style === 'chromium' ? ' ICON="data:image/png;base64,iVBORw0KGgo="' : ''
        out.push(`${pad}<DT><A HREF="${escapeHtml(node.url)}" ADD_DATE="${ADDED}"${icon}>${escapeHtml(node.title)}</A>`)
        if (style === 'firefox') out.push(`${pad}<DD>A note about ${escapeHtml(node.title)}`)
      }
    })
  }
  walk(nodes, 1, true)
  out.push('</DL><p>', '')
  return out.filter((line) => line !== '').join('\n')
}

/**
 * The bookmarks of IM-05's example, served from `base`: a bookmarks bar with "Work" (3 links) and
 * "News" (2 links), other bookmarks with a nested folder, a bookmarklet and a browser's own page.
 */
export function sampleTree(base = 'https://example.com'): FixtureNode[] {
  return [
    {
      title: 'Bookmarks bar',
      children: [
        {
          title: 'Work',
          children: [
            { title: 'Team calendar', url: `${base}/page/Calendar` },
            { title: 'Design docs', url: `${base}/page/Docs` },
            { title: 'Issue tracker', url: `${base}/page/Issues` },
          ],
        },
        {
          title: 'News',
          children: [
            { title: 'Morning paper', url: `${base}/page/Paper` },
            { title: 'Tech & Science <weekly>', url: `${base}/page/Weekly` },
          ],
        },
      ],
    },
    {
      title: 'Other bookmarks',
      children: [
        {
          title: 'Recipes',
          children: [{ title: 'Bread', children: [{ title: 'Sourdough', url: `${base}/page/Sourdough` }] }],
        },
        { title: 'Make it dark', url: 'javascript:document.body.style.background="#000"' },
        { title: 'Browser settings', url: 'chrome://settings/' },
      ],
    },
  ]
}

/** `count` bookmarks served from `base`: 10 folders of sub-folders of 20, plus a few loose ones. */
export function manyBookmarks(count: number, base: string): FixtureNode[] {
  const top: FixtureNode[] = []
  let n = 0
  const next = (): FixtureNode => {
    n++
    return { title: `Page ${n}`, url: `${base}/page/p${n}` }
  }
  const loose = Math.min(5, count)
  for (let f = 0; n < count - loose; f++) {
    const folder: FixtureNode = { title: `Folder ${f + 1}`, children: [] }
    for (let s = 0; s < 10 && n < count - loose; s++) {
      const sub: FixtureNode = { title: `Folder ${f + 1}.${s + 1}`, children: [] }
      for (let i = 0; i < 20 && n < count - loose; i++) sub.children?.push(next())
      folder.children?.push(sub)
    }
    top.push(folder)
  }
  while (n < count) top.push(next())
  return top
}

/** A list of links as someone might copy them (IM-12): plain, "Title — address", and noise. */
export const LINKS_TXT = [
  'https://example.com/page/One',
  'Two — https://example.com/page/Two',
  'example.org/three',
  '',
  'not a link at all',
  '- [Four](https://example.com/page/Four)',
  'Five | https://example.com/page/Five',
  '',
].join('\n')

/** An HTML file that holds no bookmarks: a page, not an export (IM-13). */
export const MALFORMED_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Not bookmarks</title></head>
<body><h1>Recipes</h1><p>Flour, water, salt.</p><dl><dt>Bread</dt><dd>Bake it.</dd></dl></body></html>
`

const DAY = 86_400_000
/** The fixtures' "now" (2024-03-01), in ms: every visit is before it. */
export const FIXTURE_NOW = ADDED * 1000

/** Browsers' clocks: Chromium counts microseconds from 1601, Firefox from 1970, Safari seconds from 2001. */
export const chromeTime = (ms: number) => (BigInt(Math.round(ms)) + 11_644_473_600_000n) * 1000n
export const firefoxTime = (ms: number) => Math.round(ms) * 1000
export const safariTime = (ms: number) => ms / 1000 - 978_307_200

/** A made-up page in a browser's history: its last visit (Unix ms), how often it was visited and typed. */
export interface FixturePage {
  url: string
  title: string
  visits: number
  typed?: number
  last: number
  /** A page the browser keeps but doesn't list (a frame, a redirect). */
  hidden?: boolean
}

/** A small history: sites visited often (IM-16's starters), a browser's own page, a hidden one. */
export function sampleHistory(own = 'chrome://settings/'): FixturePage[] {
  const at = (minutesAgo: number) => FIXTURE_NOW - minutesAgo * 60_000
  return [
    { url: 'https://mail.example.net/inbox', title: 'Inbox', visits: 300, typed: 5, last: at(1) },
    { url: 'https://news.example.org/', title: 'Example News', visits: 120, typed: 80, last: at(10) },
    { url: 'https://example.com/page/Calendar', title: 'Team calendar', visits: 42, typed: 30, last: at(60) },
    { url: 'https://docs.example.com/d/plan', title: 'Plan for the spring', visits: 17, typed: 2, last: at(2 * 1440) },
    { url: 'https://example.com/search?q=sourdough', title: 'sourdough - Search', visits: 1, last: at(5 * 1440) },
    { url: 'https://shop.example.com/cart', title: 'Cart', visits: 3, last: at(30 * 1440) },
    { url: own, title: 'Settings', visits: 4, last: at(1440) },
    { url: 'https://ads.example.com/frame', title: '', visits: 9, last: at(1440), hidden: true },
  ]
}

/** `count` made-up pages a minute apart, most recent first. */
export function manyPages(count: number, base = 'https://example.com'): FixturePage[] {
  return Array.from({ length: count }, (_, i) => ({
    url: `${base}/h/${i + 1}`,
    title: `History page ${i + 1}`,
    visits: 1 + (i % 3),
    last: FIXTURE_NOW - i * 60_000,
  }))
}

/** A made-up extension in a Chromium-family profile (IM-09). Location 1 is the store's, 4 unpacked, 5 the browser's own. */
export interface FixtureExtension {
  id: string
  name: string
  location?: number
  pinned?: boolean
}

export const SAMPLE_EXTENSIONS: FixtureExtension[] = [
  { id: 'a'.repeat(32), name: 'Example Blocker', pinned: true },
  { id: 'b'.repeat(32), name: 'Another Ad Blocker' },
  { id: 'c'.repeat(32), name: 'Notes Helper', pinned: true },
  { id: 'd'.repeat(32), name: 'My Unpacked Tool', location: 4 },
  { id: 'e'.repeat(32), name: 'Built-in Payments', location: 5 },
]

/** Writes a SQLite file afresh: small pages, one transaction, compacted. */
function sqlite(path: string, fill: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  rmSync(path, { force: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA page_size = 1024; PRAGMA journal_mode = DELETE')
  db.exec('BEGIN')
  fill(db)
  db.exec('COMMIT')
  db.exec('VACUUM')
  db.close()
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/** A Chromium-family profile's bookmark roots. */
export interface ChromiumRoots {
  bar: FixtureNode[]
  other: FixtureNode[]
  mobile: FixtureNode[]
}

/** Chromium's `Bookmarks` file: JSON, indented by three as Chromium writes it. */
export function chromiumBookmarksJson(roots: ChromiumRoots): string {
  const added = String(chromeTime(FIXTURE_NOW - 30 * DAY))
  let id = 3
  const node = (n: FixtureNode): unknown => {
    id++
    const common = { date_added: added, guid: uuid(id), id: String(id), name: n.title }
    return n.children
      ? { children: n.children.map(node), ...common, date_modified: added, type: 'folder' }
      : { ...common, type: 'url', url: n.url }
  }
  const root = (n: number, name: string, children: FixtureNode[]) => ({
    children: children.map(node),
    date_added: added,
    date_modified: added,
    guid: uuid(n),
    id: String(n),
    name,
    type: 'folder',
  })
  const bookmark_bar = root(1, 'Bookmarks bar', roots.bar)
  const other = root(2, 'Other bookmarks', roots.other)
  const synced = root(3, 'Mobile bookmarks', roots.mobile)
  return JSON.stringify({ checksum: 'f'.repeat(32), roots: { bookmark_bar, other, synced }, version: 1 }, null, 3)
}

/** Chromium's `History`: the `urls` and `visits` tables, with the columns Orbit reads. */
export function writeChromiumHistory(path: string, pages: readonly FixturePage[]): void {
  sqlite(path, (db) => {
    db.exec(`CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
      INSERT INTO meta VALUES ('version', '67');
      CREATE TABLE urls(id INTEGER PRIMARY KEY AUTOINCREMENT, url LONGVARCHAR, title LONGVARCHAR,
        visit_count INTEGER DEFAULT 0 NOT NULL, typed_count INTEGER DEFAULT 0 NOT NULL,
        last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0 NOT NULL);
      CREATE TABLE visits(id INTEGER PRIMARY KEY AUTOINCREMENT, url INTEGER NOT NULL, visit_time INTEGER NOT NULL,
        from_visit INTEGER, transition INTEGER DEFAULT 0 NOT NULL, segment_id INTEGER,
        visit_duration INTEGER DEFAULT 0 NOT NULL);
      CREATE INDEX visits_url_index ON visits (url);`)
    const url = db.prepare(
      'INSERT INTO urls (url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (?, ?, ?, ?, ?, ?)',
    )
    const visit = db.prepare('INSERT INTO visits (url, visit_time, transition) VALUES (?, ?, ?)')
    for (const p of pages) {
      const id = url.run(p.url, p.title, p.visits, p.typed ?? 0, chromeTime(p.last), p.hidden ? 1 : 0).lastInsertRowid
      // Its latest visits (a fixture keeps three at most), a day apart; typed ones are transition 1.
      for (let i = Math.min(p.visits, 3) - 1; i >= 0; i--) {
        visit.run(id, chromeTime(p.last - i * DAY), i < (p.typed ?? 0) ? 1 : 0)
      }
    }
  })
}

/** A Chromium-family profile folder (`folder` '.' puts its files in the browser's folder, as Opera does). */
export interface ChromiumProfileFixture {
  folder: string
  name: string
  bookmarks?: ChromiumRoots
  history?: readonly FixturePage[]
  extensions?: readonly FixtureExtension[]
}

/** A Chromium-family browser's folder: `Local State` naming the profiles, then each profile's files. */
export function writeChromium(dir: string, profiles: readonly ChromiumProfileFixture[], localState = true): void {
  rmSync(dir, { recursive: true, force: true })
  if (localState) {
    const cache = Object.fromEntries(profiles.map((p) => [p.folder, { is_using_default_name: false, name: p.name }]))
    write(
      join(dir, 'Local State'),
      JSON.stringify({ profile: { info_cache: cache, profiles_order: profiles.map((p) => p.folder) } }),
    )
  }
  for (const p of profiles) {
    const at = join(dir, p.folder)
    if (p.bookmarks) write(join(at, 'Bookmarks'), chromiumBookmarksJson(p.bookmarks))
    if (p.history) writeChromiumHistory(join(at, 'History'), p.history)
    if (p.extensions) {
      const settings = Object.fromEntries(
        p.extensions.map((x) => [
          x.id,
          {
            from_webstore: (x.location ?? 1) === 1,
            location: x.location ?? 1,
            manifest: { manifest_version: 3, name: x.name, version: '1.0.0' },
            state: 1,
          },
        ]),
      )
      const pinned = p.extensions.filter((x) => x.pinned).map((x) => x.id)
      write(join(at, 'Preferences'), JSON.stringify({ extensions: { pinned_extensions: pinned, settings } }))
    }
  }
}

/** A Firefox profile's bookmark roots, and its tags (tag → addresses), which aren't imported. */
export interface FirefoxRoots {
  toolbar: FixtureNode[]
  menu: FixtureNode[]
  unfiled: FixtureNode[]
  mobile: FixtureNode[]
  tags?: Record<string, string[]>
}

const revHost = (url: string) => {
  try {
    return `${[...new URL(url).hostname].reverse().join('')}.`
  } catch {
    return ''
  }
}

/** Firefox's `places.sqlite`: pages, visits and bookmarks, with the columns Orbit reads. */
export function writePlaces(path: string, roots: FirefoxRoots, pages: readonly FixturePage[]): void {
  sqlite(path, (db) => {
    db.exec(`CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, rev_host LONGVARCHAR,
        visit_count INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0 NOT NULL, typed INTEGER DEFAULT 0 NOT NULL,
        frecency INTEGER DEFAULT -1 NOT NULL, last_visit_date INTEGER, guid TEXT);
      CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER DEFAULT NULL, parent INTEGER,
        position INTEGER, title LONGVARCHAR, dateAdded INTEGER, lastModified INTEGER, guid TEXT);
      CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, from_visit INTEGER, place_id INTEGER,
        visit_date INTEGER, visit_type INTEGER, session INTEGER);
      CREATE INDEX moz_historyvisits_placedateindex ON moz_historyvisits (place_id, visit_date);`)
    const placeIds = new Map<string, number>()
    const addPlace = db.prepare(
      'INSERT INTO moz_places (url, title, rev_host, visit_count, hidden, typed, last_visit_date, guid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    const visit = db.prepare('INSERT INTO moz_historyvisits (place_id, visit_date, visit_type) VALUES (?, ?, ?)')
    const place = (url: string, title: string, p?: FixturePage): number => {
      const known = placeIds.get(url)
      if (known !== undefined) return known
      const last = p ? firefoxTime(p.last) : null
      const row = addPlace.run(
        url,
        title,
        revHost(url),
        p?.visits ?? 0,
        p?.hidden ? 1 : 0,
        p?.typed ? 1 : 0,
        last,
        uuid(placeIds.size),
      )
      const id = Number(row.lastInsertRowid)
      placeIds.set(url, id)
      // Its latest visits, a day apart; typed ones are visit type 2.
      for (let i = Math.min(p?.visits ?? 0, 3) - 1; i >= 0; i--) {
        visit.run(id, firefoxTime((p?.last ?? 0) - i * DAY), i < (p?.typed ?? 0) ? 2 : 1)
      }
      return id
    }
    for (const p of pages) place(p.url, p.title, p)
    const mark = db.prepare(
      'INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, dateAdded, lastModified, guid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    const added = firefoxTime(FIXTURE_NOW - 30 * DAY)
    let id = 0
    const add = (type: number, fk: number | null, parent: number, position: number, title: string, guid?: string) => {
      id++
      mark.run(id, type, fk, parent, position, title, added, added, guid ?? `bookmark${String(id).padStart(4, '0')}`)
      return id
    }
    const root = add(2, null, 0, 0, '', 'root________')
    const menu = add(2, null, root, 0, 'menu', 'menu________')
    const toolbar = add(2, null, root, 1, 'toolbar', 'toolbar_____')
    const tags = add(2, null, root, 2, 'tags', 'tags________')
    const unfiled = add(2, null, root, 3, 'unfiled', 'unfiled_____')
    const mobile = add(2, null, root, 4, 'mobile', 'mobile______')
    const walk = (list: readonly FixtureNode[], parent: number) =>
      list.forEach((n, i) => {
        if (n.children) walk(n.children, add(2, null, parent, i, n.title))
        else if (n.url) add(1, place(n.url, n.title), parent, i, n.title)
      })
    walk(roots.toolbar, toolbar)
    walk(roots.menu, menu)
    // A separator ends the menu, as in a new profile.
    add(3, null, menu, roots.menu.length, '')
    walk(roots.unfiled, unfiled)
    walk(roots.mobile, mobile)
    Object.entries(roots.tags ?? {}).forEach(([tag, urls], i) => {
      const folder = add(2, null, tags, i, tag)
      urls.forEach((u, j) => {
        add(1, place(u, ''), folder, j, '')
      })
    })
  })
}

/** Firefox's folder: `profiles.ini` (the install's default first; `stale` names a folder that is gone), then each profile. */
export function writeFirefox(
  dir: string,
  profiles: readonly { path: string; name: string; roots: FirefoxRoots; history: readonly FixturePage[] }[],
  stale?: string,
): void {
  rmSync(dir, { recursive: true, force: true })
  const ini = [`[Install4F96D1932A9F858E]`, `Default=${profiles[0]?.path ?? ''}`, 'Locked=1', '']
  const listed = [...(stale ? [{ path: stale, name: 'old' }] : []), ...profiles]
  listed.forEach((p, i) => {
    ini.push(`[Profile${i}]`, `Name=${p.name}`, 'IsRelative=1', `Path=${p.path}`, '')
  })
  ini.push('[General]', 'StartWithLastProfile=1', 'Version=2', '')
  write(join(dir, 'profiles.ini'), ini.join('\n'))
  for (const p of profiles) writePlaces(join(dir, p.path, 'places.sqlite'), p.roots, p.history)
}

/**
 * A binary property list ("bplist00"), the format of Safari's `Bookmarks.plist`: dictionaries,
 * arrays, strings, integers and booleans; two-byte references, four-byte offsets.
 */
export function bplist(root: unknown): Buffer {
  const objects: Buffer[] = []
  const int = (n: number) =>
    n < 0x100
      ? Buffer.from([0x10, n])
      : n < 0x10000
        ? Buffer.from([0x11, n >> 8, n & 0xff])
        : Buffer.from([0x12, n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff])
  const head = (kind: number, n: number) =>
    n < 15 ? Buffer.from([(kind << 4) | n]) : Buffer.concat([Buffer.from([(kind << 4) | 0xf]), int(n)])
  const refs = (list: number[]) => {
    const b = Buffer.alloc(list.length * 2)
    list.forEach((r, i) => {
      b.writeUInt16BE(r, i * 2)
    })
    return b
  }
  const encode = (v: unknown): number => {
    const i = objects.push(Buffer.alloc(0)) - 1
    if (Array.isArray(v)) {
      const items = v.map(encode)
      objects[i] = Buffer.concat([head(0xa, items.length), refs(items)])
    } else if (v && typeof v === 'object') {
      const entries = Object.entries(v)
      const keys = entries.map(([k]) => encode(k))
      const values = entries.map(([, x]) => encode(x))
      objects[i] = Buffer.concat([head(0xd, entries.length), refs(keys), refs(values)])
    } else if (typeof v === 'string') {
      const ascii = Buffer.byteLength(v, 'utf8') === v.length
      const body = ascii ? Buffer.from(v, 'latin1') : Buffer.from(v, 'utf16le').swap16()
      objects[i] = Buffer.concat([head(ascii ? 0x5 : 0x6, v.length), body])
    } else if (typeof v === 'boolean') {
      objects[i] = Buffer.from([v ? 0x09 : 0x08])
    } else {
      const b = Buffer.alloc(9)
      b[0] = 0x13
      b.writeBigInt64BE(BigInt(Math.round(Number(v))), 1)
      objects[i] = b
    }
    return i
  }
  encode(root)
  const offsets = Buffer.alloc(objects.length * 4)
  let at = 8
  objects.forEach((o, i) => {
    offsets.writeUInt32BE(at, i * 4)
    at += o.length
  })
  const trailer = Buffer.alloc(32)
  trailer[6] = 4
  trailer[7] = 2
  trailer.writeBigUInt64BE(BigInt(objects.length), 8)
  trailer.writeBigUInt64BE(BigInt(at), 24)
  return Buffer.concat([Buffer.from('bplist00', 'latin1'), ...objects, offsets, trailer])
}

/** Safari's folder: `Bookmarks.plist` (favorites bar, bookmarks menu, reading list) and `History.db`. */
export function writeSafari(
  dir: string,
  roots: { bar: FixtureNode[]; menu: FixtureNode[]; readingList: FixtureNode[] },
  pages: readonly FixturePage[],
): void {
  rmSync(dir, { recursive: true, force: true })
  let n = 0
  const list = (title: string, children: readonly FixtureNode[]) => ({
    Children: children.map(node),
    Title: title,
    WebBookmarkType: 'WebBookmarkTypeList',
    WebBookmarkUUID: uuid(++n),
  })
  const node = (b: FixtureNode): unknown =>
    b.children
      ? list(b.title, b.children)
      : {
          URIDictionary: { title: b.title },
          URLString: b.url,
          WebBookmarkType: 'WebBookmarkTypeLeaf',
          WebBookmarkUUID: uuid(++n),
        }
  const plist = {
    Children: [
      { Title: 'History', WebBookmarkIdentifier: 'History', WebBookmarkType: 'WebBookmarkTypeProxy' },
      list('BookmarksBar', roots.bar),
      list('BookmarksMenu', roots.menu),
      { ...list('com.apple.ReadingList', roots.readingList), ShouldOmitFromUI: true },
    ],
    Title: '',
    WebBookmarkFileVersion: 1,
    WebBookmarkType: 'WebBookmarkTypeList',
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'Bookmarks.plist'), bplist(plist))
  sqlite(join(dir, 'History.db'), (db) => {
    db.exec(`CREATE TABLE history_items (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE,
        domain_expansion TEXT NULL, visit_count INTEGER NOT NULL);
      CREATE TABLE history_visits (id INTEGER PRIMARY KEY AUTOINCREMENT, history_item INTEGER NOT NULL,
        visit_time REAL NOT NULL, title TEXT NULL, load_successful BOOLEAN NOT NULL DEFAULT 1);`)
    const item = db.prepare('INSERT INTO history_items (url, visit_count) VALUES (?, ?)')
    const visit = db.prepare('INSERT INTO history_visits (history_item, visit_time, title) VALUES (?, ?, ?)')
    for (const p of pages) {
      if (p.hidden) continue
      const id = item.run(p.url, p.visits).lastInsertRowid
      for (let i = Math.min(p.visits, 3) - 1; i >= 0; i--) visit.run(id, safariTime(p.last - i * DAY), p.title || null)
    }
  })
}

/** The made-up browsers of the made-up computer the tests search (IM-02). */
export function buildBrowsers(root = FIXTURE_ROOT): void {
  const [bar, other] = sampleTree()
  const weather = { title: 'Weather', url: 'https://weather.example.org/' }
  writeChromium(join(root, 'chrome'), [
    {
      folder: 'Default',
      name: 'Work',
      bookmarks: { bar: bar?.children ?? [], other: other?.children ?? [], mobile: [] },
      history: sampleHistory(),
      extensions: SAMPLE_EXTENSIONS,
    },
    {
      folder: 'Profile 1',
      name: 'Personal',
      bookmarks: {
        bar: [weather],
        other: [{ title: 'Travel', children: [{ title: 'Trains', url: 'https://example.com/page/Trains' }] }],
        mobile: [{ title: 'Recipes on the go', url: 'https://example.com/page/Mobile' }],
      },
      history: [{ url: weather.url, title: 'Weather', visits: 12, typed: 12, last: FIXTURE_NOW - 3 * 60_000 }],
    },
  ])
  writeFirefox(
    join(root, 'firefox'),
    [
      {
        path: 'abcd1234.default-release',
        name: 'default-release',
        roots: {
          toolbar: [{ title: 'Most Visited', url: 'place:sort=8&maxResults=10' }, ...(bar?.children ?? [])],
          menu: other?.children ?? [],
          unfiled: [{ title: 'Read later', url: 'https://example.com/page/Later' }],
          mobile: [],
          tags: { bread: ['https://example.com/page/Sourdough'] },
        },
        history: sampleHistory('about:preferences'),
      },
    ],
    'zzzz0000.old',
  )
  writeSafari(
    join(root, 'safari'),
    {
      bar: bar?.children ?? [],
      menu: [{ title: 'Recipes', children: [{ title: 'Sourdough', url: 'https://example.com/page/Sourdough' }] }],
      readingList: [{ title: 'A long read', url: 'https://example.com/page/Long' }],
    },
    sampleHistory('favorites://'),
  )
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** Writes every fixture under `root`. */
export function buildFixtures(root = FIXTURE_ROOT): void {
  write(join(root, 'files', 'bookmarks.htm'), netscapeHtml(sampleTree()))
  write(join(root, 'files', 'bookmarks-firefox.htm'), netscapeHtml(sampleTree(), 'firefox'))
  write(join(root, 'files', 'links.txt'), LINKS_TXT)
  write(join(root, 'files', 'malformed.htm'), MALFORMED_HTML)
  buildBrowsers(root)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildFixtures()
  console.log(`import fixtures written to ${FIXTURE_ROOT}`)
}
