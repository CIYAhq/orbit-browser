import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIXTURE_ROOT, manyBookmarks, netscapeHtml, sampleTree } from '../../scripts/import-fixtures'
import { cleanTree, parseFile } from '../../src/main/import/files'
import {
  countAll,
  countBookmarks,
  decodeEntities,
  NO_BOOKMARKS,
  parseBookmarksHtml,
  skipReason,
  writeBookmarksHtml,
} from '../../src/main/import/netscape'
import type { BookmarkNode } from '../../src/shared/commands/import'

const fixture = (name: string) => readFileSync(join(FIXTURE_ROOT, 'files', name), 'utf8')

/** The tree as titles and addresses, ids left out. */
function shape(nodes: readonly BookmarkNode[]): unknown[] {
  return nodes.map((n) =>
    n.children ? { [n.title]: shape(n.children) } : n.skip ? `${n.title} (skip: ${n.skip})` : `${n.title} <${n.url}>`,
  )
}

const SAMPLE_SHAPE = [
  {
    'Bookmarks bar': [
      {
        Work: [
          'Team calendar <https://example.com/page/Calendar>',
          'Design docs <https://example.com/page/Docs>',
          'Issue tracker <https://example.com/page/Issues>',
        ],
      },
      {
        News: [
          'Morning paper <https://example.com/page/Paper>',
          'Tech & Science <weekly> <https://example.com/page/Weekly>',
        ],
      },
    ],
  },
  {
    'Other bookmarks': [
      { Recipes: [{ Bread: ['Sourdough <https://example.com/page/Sourdough>'] }] },
      'Make it dark (skip: Bookmarklet (a script, not a page))',
      'Browser settings (skip: A page only that browser can open)',
    ],
  },
]

describe('[IM-13] reading a bookmarks file', () => {
  it('keeps folders, their nesting and order, titles and addresses (a Chromium export)', () => {
    const tree = parseBookmarksHtml(fixture('bookmarks.htm'))
    expect(tree && shape(tree)).toEqual(SAMPLE_SHAPE)
    expect(countBookmarks(tree ?? [])).toBe(6)
    expect(countAll(tree ?? [])).toBe(8)
  })

  it('ignores descriptions, separators and the menu heading of a Firefox export', () => {
    const tree = parseBookmarksHtml(fixture('bookmarks-firefox.htm'))
    expect(tree && shape(tree)).toEqual(SAMPLE_SHAPE)
  })

  it('reads lower-case tags, single-quoted and bare attributes, and a file without a doctype', () => {
    const html = `<dl><dt><h3>Mixed</h3><dl>
      <dt><a href='https://a.example/x?y=1&amp;z=2' add_date=1>A &#x41; &#66;</a>
      <dt><a href=https://b.example/>B</a></dl></dl>`
    expect(shape(parseBookmarksHtml(html) ?? [])).toEqual([
      { Mixed: ['A A B <https://a.example/x?y=1&z=2>', 'B <https://b.example/>'] },
    ])
  })

  it('names untitled links by their address and untitled folders as such', () => {
    const html =
      '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><H3></H3><DL><DT><A HREF="https://x.example/">  </A></DL></DL>'
    expect(shape(parseBookmarksHtml(html) ?? [])).toEqual([
      { 'Untitled folder': ['https://x.example/ <https://x.example/>'] },
    ])
  })

  it('finds no bookmarks in a page that is not an export, an empty export or plain text', () => {
    expect(parseBookmarksHtml(fixture('malformed.htm'))).toBeUndefined()
    expect(parseBookmarksHtml('<!DOCTYPE NETSCAPE-Bookmark-file-1><H1>Bookmarks</H1><DL><p></DL><p>')).toBeUndefined()
    expect(parseBookmarksHtml('just some text')).toBeUndefined()
    expect(parseBookmarksHtml('')).toBeUndefined()
  })

  it('reads what a cut-off file holds, up to where it stops', () => {
    const whole = fixture('bookmarks.htm')
    const cut = whole.slice(0, whole.indexOf('Morning paper'))
    expect(shape(parseBookmarksHtml(cut) ?? [])).toEqual([
      {
        'Bookmarks bar': [
          {
            Work: [
              'Team calendar <https://example.com/page/Calendar>',
              'Design docs <https://example.com/page/Docs>',
              'Issue tracker <https://example.com/page/Issues>',
            ],
          },
          { News: [expect.stringContaining('https://example.com/page/Paper')] },
        ],
      },
    ])
  })

  it('reads 2,000 bookmarks quickly', () => {
    const html = netscapeHtml(manyBookmarks(2000, 'http://127.0.0.1:3300'))
    const started = performance.now()
    const tree = parseBookmarksHtml(html)
    const ms = performance.now() - started
    expect(countBookmarks(tree ?? [])).toBe(2000)
    expect(ms).toBeLessThan(250)
  })

  it('says why an address cannot become a pinned tab', () => {
    expect(skipReason('https://example.com/')).toBeUndefined()
    expect(skipReason('http://localhost:3300/page')).toBeUndefined()
    expect(skipReason('file:///home/someone/notes.html')).toBeUndefined()
    expect(skipReason('javascript:alert(1)')).toBe('Bookmarklet (a script, not a page)')
    expect(skipReason('place:sort=8&maxResults=10')).toBe('Saved search, not a page')
    expect(skipReason('chrome://settings')).toBe('A page only that browser can open')
    expect(skipReason('about:config')).toBe('A page only that browser can open')
    expect(skipReason('mailto:someone@example.com')).toBe('Not a web address')
    expect(skipReason('no scheme here')).toBe('Not a web address')
    expect(skipReason('https://')).toBe('Not a web address')
    expect(skipReason(`https://example.com/${'x'.repeat(5000)}`)).toBe('Address too long')
  })

  it('decodes named and numeric entities, leaving unknown ones', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x1F600; &bogus; &#0;')).toBe(
      'a & b <c> "d" \'e\' 😀 &bogus; &#0;',
    )
  })
})

describe('[IM-13] a dropped or chosen file', () => {
  it('is a bookmarks file, a list of links, or the error that it holds no bookmarks', () => {
    const bookmarks = parseFile('bookmarks.htm', fixture('bookmarks.htm'))
    expect(bookmarks).toMatchObject({ kind: 'bookmarks', name: 'bookmarks.htm', count: 6 })
    expect(parseFile('links.txt', fixture('links.txt'))).toMatchObject({ kind: 'links', count: 5 })
    expect(parseFile('malformed.htm', fixture('malformed.htm'))).toEqual({
      kind: 'error',
      name: 'malformed.htm',
      message: NO_BOOKMARKS,
    })
    expect(NO_BOOKMARKS).toBe('No bookmarks found in this file')
    expect(parseFile('empty.txt', '\n\n')).toMatchObject({ kind: 'error', message: NO_BOOKMARKS })
    // An exported file named .txt is still read for links, not as HTML.
    expect(parseFile('notes.txt', 'hello\nworld')).toMatchObject({ kind: 'error' })
  })

  it('checks a tree sent back by the import window again', () => {
    const tree = cleanTree([
      { id: 'x', title: 'Folder', children: [{ id: 'y', title: 'Ok', url: 'https://ok.example/' }] },
      { id: 'z', title: 'Script', url: 'javascript:void 0' },
      { title: 42, url: 7 },
      'junk',
      { id: 'w', title: '', url: 'https://untitled.example/page' },
    ])
    expect(shape(tree)).toEqual([
      { Folder: ['Ok <https://ok.example/>'] },
      'Script (skip: Bookmarklet (a script, not a page))',
      expect.stringContaining('<https://untitled.example/page>'),
    ])
    // Deeper than any real file: cut off.
    let deep: unknown = [{ title: 'leaf', url: 'https://leaf.example/' }]
    for (let i = 0; i < 100; i++) deep = [{ title: `f${i}`, children: deep }]
    expect(countBookmarks(cleanTree(deep))).toBe(0)
  })
})

describe('[IM-17] writing a bookmarks file', () => {
  it('writes the format back so that it reads the same', () => {
    const html = writeBookmarksHtml([
      {
        title: 'Space & Co',
        children: [
          { title: 'A <b>', url: 'https://a.example/?q="x"&y=1', addDate: 1_709_251_200_000 },
          { title: 'Empty', children: [] },
        ],
      },
    ])
    expect(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>')).toBe(true)
    expect(html).toContain('ADD_DATE="1709251200"')
    expect(shape(parseBookmarksHtml(html) ?? [])).toEqual([
      { 'Space & Co': ['A <b> <https://a.example/?q="x"&y=1>', { Empty: [] }] },
    ])
  })

  it('round-trips the sample', () => {
    const toExport = (nodes: BookmarkNode[]): { title: string; url?: string; children?: unknown[] }[] =>
      nodes.map((n) =>
        n.children ? { title: n.title, children: toExport(n.children) } : { title: n.title, url: n.url },
      )
    const tree = parseBookmarksHtml(netscapeHtml(sampleTree())) ?? []
    const again = parseBookmarksHtml(writeBookmarksHtml(toExport(tree) as never)) ?? []
    expect(shape(again)).toEqual(SAMPLE_SHAPE)
  })
})
