import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { manyBookmarks, netscapeHtml, sampleTree } from '../../scripts/import-fixtures'
import {
  addUnplacedTabs,
  attachFolders,
  COLLAPSE_OVER,
  DetachedFolder,
  freeFolderName,
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

describe('[IM-05][IM-14] a large import is made out of sight, then shown at once (D62 (3))', () => {
  const tree = parseBookmarksHtml(netscapeHtml(sampleTree())) ?? []

  /** The import's folder for the first Space, its tabs added `size` at a time where no section shows them. */
  function inParts(state: OrbitState, size: number) {
    const spaceId = state.spaceOrder[0] as string
    const folder = new DetachedFolder(
      planPlacement('Imported bookmarks', tree),
      spaceId,
      state.spaces[spaceId]?.profileId as string,
      NOW,
    )
    let parts = 0
    for (; !folder.whole; parts++) {
      const tabs = folder.build(size)
      state = produce(state, (d) => addUnplacedTabs(d, tabs))
    }
    return { state, folder, spaceId, parts }
  }

  it('ends as one placement would, in the same order; until it is shown, no section holds any of it', () => {
    const whole = place(createInitialState(NOW), 'Imported bookmarks', tree)
    const base = createInitialState(NOW)
    const { state, folder, parts } = inParts(base, 2)
    expect(parts).toBe(3)
    expect(Object.keys(state.tabs)).toHaveLength(6)
    expect(state.spaces).toEqual(base.spaces)
    expect(state.folders).toEqual({})
    let added: ReturnType<typeof attachFolders> = []
    const next = produce(state, (d) => {
      added = attachFolders(d, [folder], ['Imported bookmarks'])
    })
    expect(added).toHaveLength(1)
    expect(added[0]?.tabs).toBe(6)
    expect(pinnedShape(next, [added[0]?.folderId as string])).toEqual(pinnedShape(whole.next, [whole.placed.folderId]))
  })

  it('shows nothing in a Space deleted while its folder was made, nor a folder not yet whole', () => {
    const { state, folder } = inParts(createInitialState(NOW), 3)
    const gone = produce(state, (d) => {
      delete d.spaces[d.spaceOrder[0] as string]
    })
    let added: ReturnType<typeof attachFolders> = []
    const after = produce(gone, (d) => {
      added = attachFolders(d, [folder], ['Imported bookmarks'])
    })
    expect(added).toEqual([])
    expect(after).toBe(gone)
    const base = createInitialState(NOW)
    const spaceId = base.spaceOrder[0] as string
    const part = new DetachedFolder(planPlacement('Imported bookmarks', tree), spaceId, 'p-default', NOW)
    const some = produce(base, (d) => addUnplacedTabs(d, part.build(4)))
    expect(part.whole).toBe(false)
    expect(produce(some, (d) => void attachFolders(d, [part], ['Imported bookmarks']))).toBe(some)
  })

  it('gives the tabs the Space’s profile when the Space moved to another one meanwhile (PR-03)', () => {
    const { state, folder, spaceId } = inParts(createInitialState(NOW), 100)
    const moved = produce(state, (d) => {
      const space = d.spaces[spaceId]
      if (space) space.profileId = 'p-other'
    })
    let added: ReturnType<typeof attachFolders> = []
    const next = produce(moved, (d) => {
      added = attachFolders(d, [folder], ['Imported bookmarks'])
    })
    expect(added[0]?.tabs).toBe(6)
    expect(folder.tabs.map((t) => next.tabs[t.id]?.profileId)).toEqual(Array(6).fill('p-other'))
  })

  it('leaves out of its folders a tab gone while it was made', () => {
    const { state, folder } = inParts(createInitialState(NOW), 100)
    const first = folder.tabs[0]?.id as string
    const without = produce(state, (d) => {
      delete d.tabs[first]
    })
    expect(folder.keepOnly((id) => !!without.tabs[id])).toBe(5)
    let added: ReturnType<typeof attachFolders> = []
    const next = produce(without, (d) => {
      added = attachFolders(d, [folder], ['Imported bookmarks'])
    })
    const root = added[0]?.folderId as string
    const shown = (ids: readonly string[]): string[] =>
      ids.flatMap((id) => [id, ...shown(next.folders[id]?.children ?? [])])
    expect(shown([root])).not.toContain(first)
    expect(shown([root]).filter((id) => next.tabs[id])).toHaveLength(5)
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
