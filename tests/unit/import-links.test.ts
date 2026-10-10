import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { LINKS_TXT } from '../../scripts/import-fixtures'
import { freeFolderName, placeBookmarks, skippedLines } from '../../src/main/import/bookmarks'
import { linkNodes, parseFile } from '../../src/main/import/files'
import { parseLinkList } from '../../src/shared/commands/import'
import { createInitialState } from '../../src/shared/defaults'
import type { OrbitState } from '../../src/shared/state'

const NOW = 1_760_000_000_000

describe('[IM-12] a pasted list of links', () => {
  it('reads one address per line, or a title and an address, in order', () => {
    expect(parseLinkList(LINKS_TXT)).toEqual({
      links: [
        { url: 'https://example.com/page/One' },
        { url: 'https://example.com/page/Two', title: 'Two' },
        { url: 'https://example.org/three' },
        { url: 'https://example.com/page/Four', title: 'Four' },
        { url: 'https://example.com/page/Five', title: 'Five' },
      ],
      skipped: 1,
    })
  })

  it('takes the separators people copy: dashes, a tab, a bar; bullets and angle brackets', () => {
    const text = [
      'A – https://a.example/',
      'B - https://b.example/x',
      'C\thttps://c.example/',
      '• <https://d.example/>',
      '* https://e.example/?q=a b',
      'Title with — dash — https://f.example/',
      'http://localhost:3300/page',
      'ftp://files.example/',
    ].join('\r\n')
    const { links, skipped } = parseLinkList(text)
    expect(links).toEqual([
      { url: 'https://a.example/', title: 'A' },
      { url: 'https://b.example/x', title: 'B' },
      { url: 'https://c.example/', title: 'C' },
      { url: 'https://d.example/' },
      { url: 'https://f.example/', title: 'Title with — dash' },
      { url: 'http://localhost:3300/page' },
    ])
    // An address with a space in it, and a scheme that isn't the web's, aren't links.
    expect(skipped).toBe(2)
  })

  it('becomes bookmarks in the same order; lines that are not links are counted', () => {
    const { nodes, lines } = linkNodes(LINKS_TXT)
    expect(nodes.map((n) => [n.title, n.url])).toEqual([
      ['', 'https://example.com/page/One'],
      ['Two', 'https://example.com/page/Two'],
      ['', 'https://example.org/three'],
      ['Four', 'https://example.com/page/Four'],
      ['Five', 'https://example.com/page/Five'],
    ])
    expect(lines).toBe(1)
    expect(linkNodes('nothing here\nat all')).toEqual({ nodes: [], lines: 2, cut: 0 })
  })

  it('makes one pinned folder, named by the user, with a pinned tab per link in order', () => {
    const state = createInitialState(NOW)
    const spaceId = state.spaceOrder[0] as string
    let placed: ReturnType<typeof placeBookmarks>
    const next = produce(state, (d) => {
      placed = placeBookmarks(
        d,
        spaceId,
        freeFolderName(d, spaceId, 'From my old browser'),
        linkNodes(LINKS_TXT).nodes,
        NOW,
      )
    })
    const folder = next.folders[placed!.folderId as string]
    expect(next.spaces[spaceId]?.pinned.at(-1)).toBe(folder?.id)
    expect(folder?.name).toBe('From my old browser')
    expect(folder?.children.map((id) => [next.tabs[id]?.title, next.tabs[id]?.pinnedUrl])).toEqual([
      ['example.com', 'https://example.com/page/One'],
      ['Two', 'https://example.com/page/Two'],
      ['example.org', 'https://example.org/three'],
      ['Four', 'https://example.com/page/Four'],
      ['Five', 'https://example.com/page/Five'],
    ])
    expect(folder?.children.every((id) => next.tabs[id]?.asleep)).toBe(true)
  })

  it('says "link" in the summary of what was left out', () => {
    expect(skippedLines(new Map([['Address too long', 2]]), ['link', 'links'])).toEqual([
      { what: 'links', count: 2, reason: 'Address too long' },
    ])
  })
})

describe('[IM-13][IM-12] a .txt file', () => {
  it('is read as a list of links', () => {
    expect(parseFile('links.txt', LINKS_TXT)).toEqual({ kind: 'links', name: 'links.txt', text: LINKS_TXT, count: 5 })
  })
})

describe('[IM-15][IM-12] pasting into a name that is taken', () => {
  it('adds " (2)"', () => {
    let state: OrbitState = createInitialState(NOW)
    const spaceId = state.spaceOrder[0] as string
    const names: string[] = []
    for (let i = 0; i < 2; i++) {
      state = produce(state, (d) => {
        const placed = placeBookmarks(d, spaceId, freeFolderName(d, spaceId, 'Links'), linkNodes(LINKS_TXT).nodes, NOW)
        names.push(placed?.folderId ? (d.folders[placed.folderId]?.name ?? '') : '')
      })
    }
    expect(names).toEqual(['Links', 'Links (2)'])
  })
})
