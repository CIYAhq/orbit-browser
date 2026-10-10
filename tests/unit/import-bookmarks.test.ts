import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { manyBookmarks, netscapeHtml, sampleTree } from '../../scripts/import-fixtures'
import {
  applyPlacement,
  COLLAPSE_OVER,
  freeFolderName,
  type PlacedFolder,
  placeBookmarks,
  planPlacement,
  skippedLines,
} from '../../src/main/import/bookmarks'
import { parseBookmarksHtml } from '../../src/main/import/netscape'
import { filterTree, leafKey, leafKeys } from '../../src/renderer/src/import/tree'
import type { BookmarkNode } from '../../src/shared/commands/import'
import { createInitialState } from '../../src/shared/defaults'
import type { OrbitState } from '../../src/shared/state'

const NOW = 1_760_000_000_000

/** The pinned section as names, tabs as title <pinned URL>. */
function pinnedShape(state: OrbitState, ids: readonly string[]): unknown[] {
  return ids.map((id) => {
    const f = state.folders[id]
    if (f) return { [f.name]: pinnedShape(state, f.children) }
    const t = state.tabs[id]
    return `${t?.title} <${t?.pinnedUrl}>`
  })
}

function place(state: OrbitState, name: string, nodes: BookmarkNode[]) {
  const spaceId = state.spaceOrder[0] as string
  let placed: ReturnType<typeof placeBookmarks>
  const next = produce(state, (d) => {
    placed = placeBookmarks(d, spaceId, freeFolderName(d, spaceId, name), nodes, NOW)
  })
  return { next, placed: placed!, spaceId }
}

describe('[IM-05] bookmarks become pinned items', () => {
  it('makes one pinned folder at the end of the Space, with sub-folders, order and titles kept', () => {
    const base = createInitialState(NOW)
    const tree = parseBookmarksHtml(netscapeHtml(sampleTree())) ?? []
    const { next, placed, spaceId } = place(base, 'Imported bookmarks', tree)
    const space = next.spaces[spaceId]!
    expect(space.pinned.at(-1)).toBe(placed.folderId)
    expect(space.pinned.slice(0, -1)).toEqual(base.spaces[spaceId]?.pinned)
    expect(pinnedShape(next, [placed.folderId])).toEqual([
      {
        'Imported bookmarks': [
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
          { 'Other bookmarks': [{ Recipes: [{ Bread: ['Sourdough <https://example.com/page/Sourdough>'] }] }] },
        ],
      },
    ])
    expect(placed.tabIds).toHaveLength(6)
    expect(skippedLines(placed.skipped)).toEqual([
      { what: 'bookmark', count: 1, reason: 'Bookmarklet (a script, not a page)' },
      { what: 'bookmark', count: 1, reason: 'A page only that browser can open' },
    ])
  })

  it('adds pinned tabs that are asleep, without icons, never used, in the Space’s profile', () => {
    const base = createInitialState(NOW)
    const { next, placed, spaceId } = place(
      base,
      'Imported bookmarks',
      parseBookmarksHtml(netscapeHtml(sampleTree())) ?? [],
    )
    for (const id of placed.tabIds) {
      const tab = next.tabs[id]!
      expect(tab).toMatchObject({ asleep: true, loading: false, spaceId, profileId: next.spaces[spaceId]?.profileId })
      expect(tab.pinnedUrl).toBe(tab.url)
      expect(tab.pinnedResolvedUrl).toBe(tab.url)
      expect(tab.pinnedTitle).toBe(tab.title)
      expect(tab.favicon).toBeUndefined()
      expect(tab.lastActiveAt).toBe(0)
      expect(tab.createdAt).toBe(NOW)
    }
    // Sub-folders start closed; the folder itself is open when small.
    expect(next.folders[placed.folderId]?.collapsed).toBe(false)
    for (const id of placed.folderIds.slice(1)) expect(next.folders[id]?.collapsed).toBe(true)
    // Nothing else changed: no window's active tab, no Today tab.
    expect(next.windows).toEqual(base.windows)
    expect(next.spaces[spaceId]?.today).toEqual(base.spaces[spaceId]?.today)
  })

  it('shows a folder of more than 1,000 items closed', () => {
    const base = createInitialState(NOW)
    const big = parseBookmarksHtml(netscapeHtml(manyBookmarks(2000, 'https://example.com'))) ?? []
    const { next, placed } = place(base, 'Imported bookmarks', big)
    expect(placed.tabIds).toHaveLength(2000)
    expect(placed.tabIds.length + placed.folderIds.length).toBeGreaterThan(COLLAPSE_OVER)
    expect(next.folders[placed.folderId]?.collapsed).toBe(true)
  })

  it('adds no empty folder when every bookmark is left out', () => {
    const base = createInitialState(NOW)
    const nodes: BookmarkNode[] = [
      { id: 'a', title: 'Scripts', children: [{ id: 'b', title: 'x', url: 'javascript:1', skip: 'Bookmarklet' }] },
    ]
    const { next, placed, spaceId } = place(base, 'Imported bookmarks', nodes)
    expect(placed.folderId).toBe('')
    expect(next.spaces[spaceId]?.pinned).toEqual(base.spaces[spaceId]?.pinned)
    expect(Object.keys(next.folders)).toEqual(Object.keys(base.folders))
    expect(skippedLines(placed.skipped)).toEqual([{ what: 'bookmark', count: 1, reason: 'Bookmarklet' }])
  })
})

describe('[IM-05][IM-14] a large import goes in parts', () => {
  const tree = parseBookmarksHtml(netscapeHtml(sampleTree())) ?? []

  /** Applies a plan `size` steps per store update, as an import does. */
  function inParts(state: OrbitState, size: number, between?: (s: OrbitState, placed: PlacedFolder) => OrbitState) {
    const spaceId = state.spaceOrder[0] as string
    const plan = planPlacement('Imported bookmarks', tree)
    const placed: PlacedFolder = { folderId: '', tabIds: [], folderIds: [], skipped: plan.skipped }
    const ids = new Map<number, string>()
    let updates = 0
    for (let from = 0; from < plan.steps.length; from += size) {
      if (from > 0 && between) state = between(state, placed)
      let more = true
      state = produce(state, (d) => {
        more = applyPlacement(d, spaceId, plan, from, from + size, placed, ids, NOW)
      })
      updates++
      if (!more) break
    }
    return { state, placed, spaceId, updates }
  }

  it('ends as one placement would, in the same order', () => {
    const whole = place(createInitialState(NOW), 'Imported bookmarks', tree)
    const parts = inParts(createInitialState(NOW), 2)
    expect(parts.updates).toBeGreaterThan(5)
    expect(pinnedShape(parts.state, [parts.placed.folderId])).toEqual(pinnedShape(whole.next, [whole.placed.folderId]))
    expect(parts.placed.tabIds).toHaveLength(6)
  })

  it('stops when the new folder is deleted part-way, and skips into a sub-folder that was', () => {
    const gone = inParts(createInitialState(NOW), 3, (s, placed) =>
      produce(s, (d) => {
        const space = d.spaces[d.spaceOrder[0] as string]
        if (space) space.pinned = space.pinned.filter((id) => id !== placed.folderId)
        delete d.folders[placed.folderId]
      }),
    )
    expect(gone.updates).toBe(2)
    expect(gone.placed.tabIds.length).toBeLessThan(6)
    // A sub-folder deleted part-way: what was to go in it is left out; the rest still comes.
    let deleted = ''
    const sub = inParts(createInitialState(NOW), 3, (s, placed) => {
      if (deleted) return s
      return produce(s, (d) => {
        const root = d.folders[placed.folderId]
        deleted = root?.children[0] ?? ''
        if (root) root.children = root.children.slice(1)
        delete d.folders[deleted]
      })
    })
    expect(pinnedShape(sub.state, [sub.placed.folderId])).toEqual([
      {
        'Imported bookmarks': [
          { 'Other bookmarks': [{ Recipes: [{ Bread: ['Sourdough <https://example.com/page/Sourdough>'] }] }] },
        ],
      },
    ])
  })
})

describe('[IM-15] importing again', () => {
  it('names the next folder "(2)", then "(3)", leaving the first as it was', () => {
    let state = createInitialState(NOW)
    const nodes: BookmarkNode[] = [{ id: 'a', title: 'A', url: 'https://a.example/' }]
    const names: string[] = []
    for (let i = 0; i < 3; i++) {
      const { next, placed } = place(state, 'Imported bookmarks', nodes)
      state = next
      names.push(state.folders[placed.folderId]?.name ?? '')
    }
    expect(names).toEqual(['Imported bookmarks', 'Imported bookmarks (2)', 'Imported bookmarks (3)'])
  })
})

describe('[IM-04] choosing bookmarks', () => {
  const tree = parseBookmarksHtml(netscapeHtml(sampleTree())) ?? []

  it('counts the bookmarks that can be imported, not skipped ones', () => {
    expect(leafKeys('p', tree)).toHaveLength(6)
  })

  it('keeps chosen bookmarks, drops folders left empty, keeps skipped ones for the summary', () => {
    const work = tree[0]?.children?.[0]
    const first = work?.children?.[0] as BookmarkNode
    const chosen = filterTree(tree, 'p', new Set([leafKey('p', first)]))
    const titles = (nodes: BookmarkNode[]): unknown[] =>
      nodes.map((n) => (n.children ? { [n.title]: titles(n.children) } : n.title))
    // Skipped bookmarks can't be chosen or left out: they always stay, to be counted (F3).
    const skipped = { 'Other bookmarks': ['Make it dark', 'Browser settings'] }
    expect(titles(chosen)).toEqual([{ 'Bookmarks bar': [{ Work: ['Team calendar'] }] }, skipped])
    expect(titles(filterTree(tree, 'p', new Set()))).toEqual([skipped])
    // Everything chosen: the whole tree (skipped bookmarks included, to be counted).
    expect(filterTree(tree, 'p', new Set(leafKeys('p', tree)))).toEqual(tree)
  })

  it('[F3] counts the skipped bookmarks of a folder that holds nothing else, and adds no empty folder for it', () => {
    const nodes =
      parseBookmarksHtml(
        netscapeHtml([
          {
            title: 'Scripts',
            children: [
              { title: 'One', url: 'javascript:void(1)' },
              { title: 'Nested', children: [{ title: 'Two', url: 'javascript:void(2)' }] },
              { title: 'Three', url: 'javascript:void(3)' },
            ],
          },
          { title: 'Four', url: 'javascript:void(4)' },
          { title: 'A page', url: 'https://example.com/page/A' },
        ]),
      ) ?? []
    const chosen = filterTree(nodes, '', new Set(leafKeys('', nodes)))
    const { next, placed } = place(createInitialState(NOW), 'Imported bookmarks', chosen)
    expect(skippedLines(placed.skipped)).toEqual([
      { what: 'bookmarks', count: 4, reason: 'Bookmarklet (a script, not a page)' },
    ])
    expect(pinnedShape(next, [placed.folderId])).toEqual([
      { 'Imported bookmarks': ['A page <https://example.com/page/A>'] },
    ])
    expect(placed.folderIds).toEqual([placed.folderId])
  })
})
