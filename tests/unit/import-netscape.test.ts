import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIXTURE_ROOT, manyBookmarks, netscapeHtml, sampleTree } from '../../scripts/import-fixtures'
import { cleanTree, parseFile } from '../../src/main/import/files'
import {
  cleanText,
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

/** How many folders a tree holds. */
function countFolders(nodes: readonly BookmarkNode[]): number {
  let n = 0
  const lists: (readonly BookmarkNode[])[] = [nodes]
  for (let list = lists.pop(); list; list = lists.pop()) {
    for (const node of list) {
      if (!node.children) continue
      n++
      lists.push(node.children)
    }
  }
  return n
}

/** How many folders deep the deepest bookmark is. */
function depthOf(nodes: readonly BookmarkNode[]): number {
  let deepest = 0
  const lists: [readonly BookmarkNode[], number][] = [[nodes, 0]]
  for (let at = lists.pop(); at; at = lists.pop()) {
    for (const n of at[0]) {
      if (n.children) lists.push([n.children, at[1] + 1])
      else deepest = Math.max(deepest, at[1])
    }
  }
  return deepest
}

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

  it('[D58] keeps each title to its own item when a file leaves out </A> and </H3>', () => {
    const html = [
      '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
      '<DL><p>',
      '<DT><H3>Folder',
      '<DL><p>',
      '<DT><A HREF="https://a.example/">A title',
      '<DD>What A is about',
      '<DT><A HREF="https://b.example/"><B>B</B> title',
      '</DL><p>',
      '<DT><A HREF="https://c.example/">C title</A>',
      '</DL>',
    ].join('\n')
    expect(shape(parseBookmarksHtml(html) ?? [])).toEqual([
      { Folder: ['A title <https://a.example/>', 'B title <https://b.example/>'] },
      'C title <https://c.example/>',
    ])
  })

  it('[D58] cuts a title to 1,000 characters, never inside a character', () => {
    const html = (title: string) =>
      `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><A HREF="https://x.example/">${title}</A></DL>`
    expect(parseBookmarksHtml(html('t'.repeat(5000)))?.[0]?.title).toBe('t'.repeat(1000))
    expect(parseBookmarksHtml(html(`${'t'.repeat(999)}😀`))?.[0]?.title).toBe('t'.repeat(999))
    expect(cleanText(`<${'<'.repeat(10)}b>x`)).toBe(`${'<'.repeat(10)}x`)
  })

  it('[F1] reads a file nested 2,000 or 50,000 folders deep, flattening it into the 64th folder', () => {
    for (const levels of [2000, 50_000]) {
      const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p>\n${'<DT><H3>Deeper</H3>\n<DL><p>\n'.repeat(levels)}<DT><A HREF="https://deep.example/">Deep</A>\n<DT><A HREF="javascript:void 0">Script</A>\n${'</DL><p>\n'.repeat(levels)}<DT><A HREF="https://top.example/">Top</A>\n</DL>`
      const read = parseFile('deep.html', html)
      expect(read).toMatchObject({ kind: 'bookmarks', count: 2, cut: 0 })
      const tree = read.kind === 'bookmarks' ? read.tree : []
      expect(depthOf(tree)).toBe(64)
      expect(countAll(tree)).toBe(3)
      // The file's order is kept: the deep ones, then the one after all the folders.
      expect(shape(tree).at(-1)).toBe('Top <https://top.example/>')
      expect(JSON.parse(JSON.stringify(tree))).toEqual(tree)
    }
  })

  it('[F3] counts the bookmarks of a file past 200,000, without keeping them', () => {
    const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL>${'<DT><A HREF="https://example.com/">A</A>'.repeat(200_010)}</DL>`
    expect(parseFile('many.html', html)).toMatchObject({ kind: 'bookmarks', count: 200_000, cut: 10 })
  })

  it('[N7] counts only bookmarks toward the 200,000: the selection and the summary agree', () => {
    const link = '<DT><A HREF="https://example.com/">A</A>'
    const folder = (n: number, size: number) => `<DT><H3>F${n}</H3><DL>${link.repeat(size)}</DL>`
    const file = (folders: string[]) => `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL>${folders.join('')}</DL>`
    // 200 folders of 1,000: every bookmark is kept.
    const exact = parseFile('exact.html', file(Array.from({ length: 200 }, (_, i) => folder(i, 1000))))
    expect(exact).toMatchObject({ kind: 'bookmarks', count: 200_000, cut: 0 })
    // 200,010 in 21 folders: "200,000 of 200,000 bookmarks selected", and the summary leaves out the other 10.
    const over = parseFile(
      'over.html',
      file([...Array.from({ length: 20 }, (_, i) => folder(i, 10_000)), folder(20, 10)]),
    )
    expect(over).toMatchObject({ kind: 'bookmarks', count: 200_000, cut: 10 })
    // The window sends that tree back: the import keeps all of it.
    const tree = parseBookmarksHtml(file(Array.from({ length: 200 }, (_, i) => folder(i, 1000)))) ?? []
    const clean = cleanTree(tree)
    expect([countBookmarks(clean.nodes), countFolders(clean.nodes), clean.cut]).toEqual([200_000, 200, 0])
  })

  it('[N7] makes at most 20,000 folders: the bookmarks of those past it go in the folder that holds them', () => {
    const folders = Array.from(
      { length: 20_005 },
      (_, i) => `<DT><H3>F${i}</H3><DL><DT><A HREF="https://example.com/${i}">B${i}</A></DL>`,
    )
    const read = parseBookmarksHtml(`<!DOCTYPE NETSCAPE-Bookmark-file-1><DL>${folders.join('')}</DL>`) ?? []
    expect([countBookmarks(read), countFolders(read)]).toEqual([20_005, 20_000])
    expect(read.slice(-6).map((n) => n.title)).toEqual(['F19999', 'B20000', 'B20001', 'B20002', 'B20003', 'B20004'])
    const tree = Array.from({ length: 20_005 }, (_, i) => ({
      title: `F${i}`,
      children: [{ title: `B${i}`, url: `https://example.com/${i}` }],
    }))
    const clean = cleanTree(tree)
    expect([countBookmarks(clean.nodes), countFolders(clean.nodes), clean.cut]).toEqual([20_005, 20_000, 0])
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
    expect(parseFile('links.txt', fixture('links.txt'))).toMatchObject({ kind: 'links', info: { count: 5 } })
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
    const { nodes: tree, cut } = cleanTree([
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
    expect(cut).toBe(0)
  })

  it('[F1] flattens folders deeper than 64 into the deepest one kept, at any depth, as reading a file does', () => {
    for (const levels of [100, 50_000]) {
      let deep: unknown = [{ title: 'leaf', url: 'https://leaf.example/' }]
      for (let i = 0; i < levels; i++) deep = [{ title: `f${i}`, children: deep }]
      const { nodes, cut } = cleanTree(deep)
      expect(countBookmarks(nodes)).toBe(1)
      expect(cut).toBe(0)
      expect(depthOf(nodes)).toBe(64)
    }
  })

  it('[F3] counts the bookmarks past 200,000 that it leaves out', () => {
    const many = Array.from({ length: 200_010 }, (_, i) => ({ title: `b${i}`, url: `https://example.com/${i}` }))
    const { nodes, cut } = cleanTree([{ title: 'All', children: many }])
    // The folder doesn't count toward the 200,000 (N7).
    expect(countBookmarks(nodes)).toBe(200_000)
    expect(cut).toBe(10)
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
