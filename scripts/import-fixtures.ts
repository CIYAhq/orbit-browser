/**
 * Builds the import lane's test fixtures (IM-*) from made-up data, into `tests/fixtures/import/`:
 * - `files/bookmarks.htm`, `files/bookmarks-firefox.htm`: bookmarks files as browsers export them
 *   (folders, a bookmarklet, a browser's own page, entities);
 * - `files/links.txt`: a list of links, plain and "Title — address";
 * - `files/malformed.htm`: an HTML file with no bookmarks in it.
 * HTML fixtures end in `.htm`, which the linter leaves alone: an export isn't meant to be valid HTML.
 *
 * Run it with `node scripts/import-fixtures.ts` after changing it, and commit what it writes. Tests
 * also import its builders to make large files on the fly. Nothing here reads anything on this
 * machine: every name, address and date is invented.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildFixtures()
  console.log(`import fixtures written to ${FIXTURE_ROOT}`)
}
