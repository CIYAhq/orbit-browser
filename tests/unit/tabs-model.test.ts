import { describe, expect, it } from 'vitest'
import {
  autoArchiveCandidates,
  FAVORITE_WARM_FACTOR,
  makeTab,
  nextAfterClose,
  numberedTarget,
  sleepCandidates,
  steppedTarget,
  todayInsertIndex,
} from '../../src/main/tabs/model'
import { UndoStack } from '../../src/main/tabs/undo'
import {
  createInitialState,
  createProfile,
  createSpace,
  createWindowState,
  DEFAULT_PROFILE_ID,
} from '../../src/shared/defaults'
import type { OrbitState } from '../../src/shared/state'
import { cleanUrl, isAwayFromPinned, markdownLink, rowTitle } from '../../src/shared/tabs'
import { canMoveTo, moveItem, repairTree, visibleTabOrder } from '../../src/shared/tree'

const HOUR = 60 * 60 * 1000

function world() {
  const state = createInitialState(0)
  const s1 = state.spaceOrder[0] as string
  const space2 = createSpace('Work', DEFAULT_PROFILE_ID)
  state.spaces[space2.id] = space2
  state.spaceOrder.push(space2.id)
  const win = createWindowState(s1)
  state.windows[win.id] = win
  const add = (spaceId: string, where: 'today' | 'pinned' | 'favorites', lastActiveAt = 0, url = 'https://x.test/') => {
    const tab = makeTab({ spaceId, profileId: DEFAULT_PROFILE_ID, url }, lastActiveAt)
    state.tabs[tab.id] = tab
    if (where === 'favorites') state.profiles[DEFAULT_PROFILE_ID]?.favorites.push(tab.id)
    else state.spaces[spaceId]?.[where].push(tab.id)
    if (where !== 'today') tab.pinnedUrl = url
    return tab.id
  }
  const folder = (spaceId: string, id: string, children: string[], collapsed = false) => {
    state.folders[id] = { id, name: id, children, collapsed, createdAt: 0 }
    const space = state.spaces[spaceId]
    if (space) {
      space.pinned = space.pinned.filter((c) => !children.includes(c))
      space.today = space.today.filter((c) => !children.includes(c))
      space.pinned.push(id)
    }
  }
  const select = (tabId: string | null, spaceId = s1) => {
    const w = state.windows[win.id]
    if (w) {
      w.spaceId = spaceId
      w.activeTab[spaceId] = tabId
    }
  }
  return { state, s1, s2: space2.id, win: win.id, add, folder, select }
}

describe('[TB-03] insertion rule', () => {
  it('puts new, background, unpinned and restored tabs at the top of Today', () => {
    const space = createSpace('A', DEFAULT_PROFILE_ID)
    space.today = ['t-1', 't-2']
    for (const reason of ['new', 'background', 'unpin', 'restore', 'reopen', 'move'] as const) {
      expect(todayInsertIndex(space, reason)).toBe(0)
    }
  })
})

describe('[TB-06] selection after close', () => {
  it('picks the tab below, else above, else the most recent, else nothing', () => {
    const { state, s1, add } = world()
    const a = add(s1, 'today', 1)
    const b = add(s1, 'today', 2)
    const c = add(s1, 'today', 3)
    expect(nextAfterClose(state, s1, b)).toBe(c)
    expect(nextAfterClose(state, s1, c)).toBe(b)
    expect(nextAfterClose(state, s1, c, new Set([b, c]))).toBe(a)
    const p = add(s1, 'pinned', 50)
    expect(nextAfterClose(state, s1, a, new Set([a, b, c]))).toBe(p)
    expect(nextAfterClose(state, s1, p, new Set([a, b, c, p]))).toBeNull()
  })

  it('stays in the closed tab section first (pinned neighbours before Today)', () => {
    const { state, s1, add } = world()
    const p1 = add(s1, 'pinned', 1)
    const p2 = add(s1, 'pinned', 2)
    add(s1, 'today', 99)
    expect(nextAfterClose(state, s1, p1)).toBe(p2)
    expect(nextAfterClose(state, s1, p2)).toBe(p1)
  })
})

describe('[TB-04][FV-10] numbered and stepped switching', () => {
  it('counts Favorites first, then pinned, then Today; ⌘9 is the last tab', () => {
    const { state, s1, win, add } = world()
    const f1 = add(s1, 'favorites')
    const f2 = add(s1, 'favorites')
    const p1 = add(s1, 'pinned')
    const t1 = add(s1, 'today')
    const t2 = add(s1, 'today')
    expect(numberedTarget(state, win, 1)).toBe(f1)
    expect(numberedTarget(state, win, 2)).toBe(f2)
    expect(numberedTarget(state, win, 3)).toBe(p1)
    expect(numberedTarget(state, win, 9)).toBe(t2)
    state.settings.countFavoritesInShortcuts = false
    expect(numberedTarget(state, win, 1)).toBe(p1)
    expect(numberedTarget(state, win, 2)).toBe(t1)
    state.settings.lastTabOnCmd9 = false
    expect(numberedTarget(state, win, 9)).toBeUndefined()
  })

  it('steps through visible rows, skipping tabs in collapsed folders and pinned sections', () => {
    const { state, s1, win, add, folder, select } = world()
    const p1 = add(s1, 'pinned')
    const inner = add(s1, 'pinned')
    folder(s1, 'f-1', [inner], true)
    const t1 = add(s1, 'today')
    select(p1)
    expect(steppedTarget(state, win, 1)).toBe(t1)
    expect(steppedTarget(state, win, -1)).toBe(t1)
    state.folders['f-1']!.collapsed = false
    expect(steppedTarget(state, win, 1)).toBe(inner)
    // The selected tab peeks out of a collapsed folder and stays in the order.
    state.folders['f-1']!.collapsed = true
    select(inner)
    expect(visibleTabOrder(state, s1, { activeTabId: inner })).toEqual([p1, inner, t1])
    state.spaces[s1]!.pinnedCollapsed = true
    select(t1)
    expect(visibleTabOrder(state, s1, { activeTabId: t1 })).toEqual([t1])
  })
})

describe('[TD-02][TD-03][TD-06] auto-archive rule', () => {
  it('archives idle Today tabs only, per Space profile period', () => {
    const { state, s1, s2, add, select } = world()
    const idle = add(s1, 'today', 0)
    const fresh = add(s1, 'today', 11 * HOUR)
    const pinned = add(s1, 'pinned', 0)
    const fav = add(s1, 'favorites', 0)
    const shown = add(s1, 'today', 0)
    const loud = add(s1, 'today', 0)
    state.tabs[loud]!.audible = true
    const other = add(s2, 'today', 0)
    select(shown)
    const now = 12 * HOUR + 1
    const out = autoArchiveCandidates(state, now)
    expect(out).toContain(idle)
    expect(out).toContain(other)
    expect(out).not.toContain(fresh)
    expect(out).not.toContain(pinned)
    expect(out).not.toContain(fav)
    expect(out).not.toContain(shown)
    expect(out).not.toContain(loud)
    // A profile with a longer period keeps its Spaces' tabs (TD-03).
    const work = createProfile('Work', 'p-work')
    work.archiveAfterMs = 7 * 24 * HOUR
    state.profiles[work.id] = work
    state.spaces[s2]!.profileId = work.id
    expect(autoArchiveCandidates(state, now)).not.toContain(other)
    // A profile without its own value inherits the Default profile's.
    delete work.archiveAfterMs
    state.profiles[DEFAULT_PROFILE_ID]!.archiveAfterMs = 24 * HOUR
    expect(autoArchiveCandidates(state, now)).not.toContain(other)
    expect(autoArchiveCandidates(state, 24 * HOUR + 1)).toContain(other)
  })

  it('archives a split view in Today as one unit', () => {
    const { state, s1, add } = world()
    const a = add(s1, 'today', 0)
    const b = add(s1, 'today', 5 * HOUR)
    state.spaces[s1]!.today = ['v-1']
    state.splits['v-1'] = {
      id: 'v-1',
      createdAt: 0,
      layout: {
        type: 'row',
        sizes: [0.5, 0.5],
        children: [
          { type: 'leaf', tabId: a },
          { type: 'leaf', tabId: b },
        ],
      },
    }
    expect(autoArchiveCandidates(state, 12 * HOUR + 1)).toEqual([])
    expect(autoArchiveCandidates(state, 17 * HOUR + 1)).toEqual(['v-1'])
  })
})

describe('[TB-16][FV-08] sleeping', () => {
  it('sleeps idle background tabs, keeps Favorites warm longer and never sleeps audible or shown tabs', () => {
    const { state, s1, add, select } = world()
    const after = state.settings.sleepAfterMs
    const idle = add(s1, 'today', 0)
    const fav = add(s1, 'favorites', 0)
    const loud = add(s1, 'today', 0)
    state.tabs[loud]!.audible = true
    const shown = add(s1, 'today', 0)
    select(shown)
    const awake = [idle, fav, loud, shown]
    expect(sleepCandidates(state, after + 1, awake)).toEqual([idle])
    expect(sleepCandidates(state, after * FAVORITE_WARM_FACTOR + 1, awake).sort()).toEqual([idle, fav].sort())
    state.settings.sleepAfterMs = 0
    expect(sleepCandidates(state, after * 100, awake)).toEqual([])
  })
})

describe('[FD-01] folders live only in the pinned area', () => {
  it('refuses folders in Today and Favorites but allows nesting in pinned', () => {
    const { state, s1, folder } = world()
    folder(s1, 'f-1', [])
    folder(s1, 'f-2', [])
    expect(canMoveTo(state, 'f-1', { kind: 'today', spaceId: s1 })).toBe(false)
    expect(canMoveTo(state, 'f-1', { kind: 'favorites', profileId: DEFAULT_PROFILE_ID })).toBe(false)
    expect(moveItem(state, 'f-2', { kind: 'folder', folderId: 'f-1' }, 0)).toBe(true)
    expect(canMoveTo(state, 'f-1', { kind: 'folder', folderId: 'f-2' })).toBe(false)
  })
})

describe('[TB-22] restore repairs the sidebar tree', () => {
  it('drops dangling and duplicate ids and re-homes orphaned tabs', () => {
    const { state, s1, add } = world()
    const a = add(s1, 'today')
    const b = add(s1, 'pinned')
    const orphan = makeTab({ spaceId: s1, profileId: DEFAULT_PROFILE_ID, url: 'https://o.test/' })
    state.tabs[orphan.id] = orphan
    state.spaces[s1]!.today.push('t-missing', a)
    state.spaces[s1]!.pinned.push('f-missing')
    state.folders['f-lost'] = { id: 'f-lost', name: 'x', children: [], collapsed: false, createdAt: 0 }
    repairTree(state as OrbitState)
    expect(state.spaces[s1]!.today).toEqual([orphan.id, a])
    expect(state.spaces[s1]!.pinned).toEqual([b])
    expect(state.folders['f-lost']).toBeUndefined()
  })
})

describe('[PN-03][TB-20] tab display helpers', () => {
  it('shows a breadcrumb only when a pinned tab left its pinned page (redirects count as home)', () => {
    const tab = {
      title: 'Plan',
      url: 'https://docs.test/b',
      pinnedUrl: 'https://docs.test/a',
      pinnedTitle: 'Docs',
      pinnedResolvedUrl: 'https://docs.test/a/home',
    }
    expect(isAwayFromPinned(tab)).toBe(true)
    expect(rowTitle(tab)).toEqual({ prefix: 'Docs', title: 'Plan' })
    expect(rowTitle({ ...tab, customTitle: 'Mail' })).toEqual({ prefix: 'Mail', title: 'Plan' })
    expect(isAwayFromPinned({ ...tab, url: 'https://docs.test/a/home' })).toBe(false)
    expect(isAwayFromPinned({ ...tab, url: 'https://docs.test/a#section' })).toBe(false)
    expect(rowTitle({ ...tab, url: 'https://docs.test/a', title: 'Docs' })).toEqual({ title: 'Docs' })
  })

  it('strips tracking parameters and formats Markdown links', () => {
    expect(cleanUrl('https://a.test/p?utm_source=x&id=3&fbclid=y')).toBe('https://a.test/p?id=3')
    expect(cleanUrl('https://a.test/p?utm_source=x')).toBe('https://a.test/p')
    expect(markdownLink('A [b]', 'https://a.test/')).toBe('[A \\[b\\]](https://a.test/)')
  })
})

describe('[TB-18] undo stack', () => {
  it('reverts the latest change first and skips entries already undone another way', () => {
    const stack = new UndoStack()
    const log: string[] = []
    let reopened = false
    stack.push('move', () => log.push('move'))
    stack.push(
      'close',
      () => log.push('close'),
      0,
      () => reopened,
    )
    reopened = true
    expect(stack.undo()).toBe('move')
    expect(log).toEqual(['move'])
    expect(stack.undo()).toBeUndefined()
  })

  it('redoes what undo returned, and a new change ends the redo chain', () => {
    const stack = new UndoStack()
    const log: string[] = []
    const record = (n: string) => {
      stack.push(n, () => {
        log.push(`undo ${n}`)
        return () => {
          log.push(`redo ${n}`)
          record(n)
        }
      })
    }
    record('a')
    record('b')
    stack.undo()
    stack.undo()
    expect(stack.redo()).toBe('a')
    expect(stack.redo()).toBe('b')
    expect(stack.redo()).toBeUndefined()
    stack.undo()
    record('c')
    expect(stack.redo()).toBeUndefined()
    expect(log).toEqual(['undo b', 'undo a', 'redo a', 'redo b', 'undo b'])
  })
})

describe('[TB-03] cheap patches for sidebar lists (review F2)', () => {
  it('inserting at the top of a long Today list is one replace patch, not one per row', async () => {
    const { enablePatches, produceWithPatches } = await import('immer')
    enablePatches()
    const { insertItem, removeItem } = await import('../../src/shared/tree')
    const { state, s1, add } = world()
    for (let i = 0; i < 200; i++) add(s1, 'today')
    const [, patches] = produceWithPatches(state, (d: OrbitState) => {
      insertItem(d, { kind: 'today', spaceId: s1 }, 0, 't-new')
    })
    expect(patches).toHaveLength(1)
    expect(patches[0]?.op).toBe('replace')
    const middle = state.spaces[s1]?.today[100] as string
    const [, removal] = produceWithPatches(state, (d: OrbitState) => {
      removeItem(d, middle)
    })
    expect(removal).toHaveLength(1)
  })
})

describe('[FV-03][FD-01][TB-22] review fixes in the tree rules', () => {
  it('refuses a split view in the Favorites grid', () => {
    const { state, s1, add } = world()
    const a = add(s1, 'today')
    const b = add(s1, 'today')
    state.spaces[s1]!.today = ['v-1']
    state.splits['v-1'] = {
      id: 'v-1',
      createdAt: 0,
      layout: {
        type: 'row',
        sizes: [0.5, 0.5],
        children: [
          { type: 'leaf', tabId: a },
          { type: 'leaf', tabId: b },
        ],
      },
    }
    expect(canMoveTo(state, 'v-1', { kind: 'favorites', profileId: DEFAULT_PROFILE_ID })).toBe(false)
    // A pane is not an item of its own.
    expect(canMoveTo(state, a, { kind: 'pinned', spaceId: s1 })).toBe(false)
  })

  it('a folder found in Today on load is removed and its tabs come back to Today', () => {
    const { state, s1, add } = world()
    const a = add(s1, 'today')
    state.spaces[s1]!.today = ['f-bad']
    state.folders['f-bad'] = { id: 'f-bad', name: 'x', children: [a], collapsed: false, createdAt: 0 }
    repairTree(state)
    expect(state.folders['f-bad']).toBeUndefined()
    expect(state.spaces[s1]!.today).toEqual([a])
  })
})
