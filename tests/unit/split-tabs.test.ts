import { describe, expect, it } from 'vitest'
import type { MainContext } from '../../src/main/context'
import { detachTab, overflowsFavorites } from '../../src/main/split/model'
import { Store } from '../../src/main/store'
import { activateInDraft, makeTab } from '../../src/main/tabs/model'
import { TabOps } from '../../src/main/tabs/ops'
import {
  createInitialState,
  createProfile,
  createSpace,
  createWindowState,
  DEFAULT_PROFILE_ID,
} from '../../src/shared/defaults'
import { layoutLeaves } from '../../src/shared/split'
import type { OrbitState, SplitLayout, TabId } from '../../src/shared/state'
import { locate, splitOfTab } from '../../src/shared/tree'

const L = (tabId: string): SplitLayout => ({ type: 'leaf', tabId })

/** A real store and TabOps with a fake runtime (no Electron). */
function world() {
  const state = createInitialState(0)
  const spaceId = state.spaceOrder[0] as string
  const w1 = createWindowState(spaceId)
  const w2 = createWindowState(spaceId)
  state.windows[w1.id] = w1
  state.windows[w2.id] = w2
  const store = new Store(state)
  const runtime = { contents: () => undefined, savedHistory: new Map<string, unknown>(), destroy() {}, sleep() {} }
  const ctx = {
    store,
    tabs: runtime,
    toast() {},
    windows: { get: () => undefined },
  } as unknown as MainContext
  const ops = new TabOps(ctx)
  const add = (where: 'today' | 'pinned' = 'today', url = 'https://x.test/') => {
    const tab = makeTab({ spaceId, profileId: DEFAULT_PROFILE_ID, url })
    store.update((d) => {
      d.tabs[tab.id] = tab
      d.spaces[spaceId]?.[where].push(tab.id)
    })
    return tab.id
  }
  /** Makes a split from tabs already in `where`, in that container's place. */
  const split = (
    layout: SplitLayout,
    where: 'today' | 'pinned' = 'today',
    extra: Partial<OrbitState['splits'][string]> = {},
  ) => {
    const id = `v-${Math.random().toString(36).slice(2, 8)}`
    store.update((d) => {
      const space = d.spaces[spaceId]
      if (!space) return
      const leaves = layoutLeaves(layout)
      const list = space[where]
      const at = list.findIndex((x) => leaves.includes(x))
      space[where] = list.filter((x) => !leaves.includes(x))
      space[where].splice(Math.max(0, at), 0, id)
      d.splits[id] = { id, layout, createdAt: 0, ...extra }
    })
    return id
  }
  const focus = (windowId: string, tabId: TabId) => store.update((d) => activateInDraft(d, windowId, tabId))
  const active = (windowId: string) => {
    const win = store.state.windows[windowId]
    return win ? (win.activeTab[win.spaceId] ?? null) : null
  }
  return { store, ops, runtime, spaceId, w1: w1.id, w2: w2.id, add, split, focus, active }
}

describe('split panes in the tab model', () => {
  it('[SV-17] closing the focused pane keeps the split on screen and its arrangement, in one update', () => {
    const { store, ops, w1, add, split, focus, active } = world()
    const [x, a, b, c, d] = [add(), add(), add(), add(), add()]
    const layout: SplitLayout = {
      type: 'row',
      sizes: [0.4, 0.4, 0.2],
      children: [L(a), { type: 'column', sizes: [0.5, 0.5], children: [L(b), L(c)] }, L(d)],
    }
    const id = split(layout)
    focus(w1, x)
    focus(w1, c)
    // Every state the window manager sees while closing keeps the selection inside the split.
    const seen: (string | null)[] = []
    const stop = store.subscribe((next) => {
      const win = next.windows[w1]
      seen.push(win ? (win.activeTab[win.spaceId] ?? null) : null)
    })
    ops.closeTabs([c], 'closed')
    stop()
    expect(seen.every((t) => t && [a, b, d].includes(t))).toBe(true)
    expect(active(w1)).toBe(b)
    expect(store.state.splits[id]?.layout).toEqual({
      type: 'row',
      sizes: [0.4, 0.4, 0.2],
      children: [L(a), L(b), L(d)],
    })
    expect(store.state.tabs[x]?.lastActiveAt).toBeLessThan(store.state.tabs[b]?.lastActiveAt ?? 0)
  })

  it('[SV-17][SV-26] reopening a pane puts it back in its exact spot in the same update', () => {
    const { store, ops, w1, add, split, focus, active } = world()
    const [a, b, c, d] = [add(), add(), add(), add()]
    const layout: SplitLayout = {
      type: 'row',
      sizes: [0.4, 0.4, 0.2],
      children: [L(a), { type: 'column', sizes: [0.5, 0.5], children: [L(b), L(c)] }, L(d)],
    }
    const id = split(layout)
    focus(w1, c)
    ops.closeTabs([c], 'closed')
    const seen: { active: string | null; inSplit: boolean }[] = []
    const stop = store.subscribe((next) => {
      const win = next.windows[w1]
      const now = win ? (win.activeTab[win.spaceId] ?? null) : null
      seen.push({ active: now, inSplit: !!now && splitOfTab(next, now) === id })
    })
    ops.reopenLast(w1)
    stop()
    // No state ever shows the reopened pane on its own.
    expect(seen.every((s) => s.inSplit)).toBe(true)
    expect(active(w1)).toBe(c)
    expect(store.state.splits[id]?.layout).toEqual(layout)
  })

  it('[SV-17] a pane of a pinned split closes (archived), it does not just unload', () => {
    const { store, ops, w1, add, split, focus, spaceId } = world()
    const [a, b] = [add('pinned'), add('pinned')]
    const id = split({ type: 'row', sizes: [0.5, 0.5], children: [L(a), L(b)] }, 'pinned')
    focus(w1, a)
    ops.closeTabs([a], 'closed')
    expect(store.state.tabs[a]).toBeUndefined()
    expect(store.state.splits[id]).toBeUndefined()
    expect(store.state.spaces[spaceId]?.pinned).toEqual([b])
    // Closing every pane of a pinned split unloads it as a unit instead.
    const c = add('pinned')
    const id2 = split({ type: 'row', sizes: [0.5, 0.5], children: [L(b), L(c)] }, 'pinned')
    ops.closeTabs([b, c], 'closed')
    expect(store.state.splits[id2]).toBeDefined()
    expect(store.state.tabs[b]).toBeDefined()
  })

  it('[SV-17] reopening never leaves a tab outside every container (no orphan)', () => {
    const { store, ops, w1, add, split, focus } = world()
    const [cc, s, t, b] = [add(), add(), add(), add()]
    split({
      type: 'row',
      sizes: [0.3, 0.4, 0.3],
      children: [L(cc), { type: 'column', sizes: [0.5, 0.5], children: [L(s), L(t)] }, L(b)],
    })
    focus(w1, b)
    ops.closeTabs([b], 'closed')
    // Its old neighbour group changes before it comes back.
    store.update((d) => {
      detachTab(d, s)
      d.spaces[d.spaceOrder[0] as string]?.today.push(s)
    })
    ops.reopenLast(w1)
    const where = locate(store.state, splitOfTab(store.state, b) ?? b)
    expect(where).toBeDefined()
    expect(store.state.tabs[b]).toBeDefined()
  })

  it('[SV-19] Close Split, then one reopen brings back the same split', () => {
    const { store, ops, w1, add, split, focus, spaceId } = world()
    const [z, a, b, c] = [add(), add(), add(), add()]
    const layout: SplitLayout = {
      type: 'row',
      sizes: [0.7, 0.3],
      children: [L(a), { type: 'column', sizes: [0.5, 0.5], children: [L(b), L(c)] }],
    }
    const id = split(layout, 'today', { name: 'Research' })
    focus(w1, b)
    const before = store.state.spaces[spaceId]?.today
    ops.closeTabs([a, b, c], 'closed')
    expect(store.state.splits[id]).toBeUndefined()
    expect(active(w1)).toBe(z)
    ops.reopenLast(w1)
    const back = store.state.splits[id]
    expect(back?.layout).toEqual(layout)
    expect(back?.name).toBe('Research')
    expect(store.state.spaces[spaceId]?.today).toEqual(before)
    expect(active(w1)).toBe(b)
    function active(windowId: string) {
      const win = store.state.windows[windowId]
      return win ? (win.activeTab[win.spaceId] ?? null) : null
    }
  })

  it('[SV-24] a window hands a split over when another window selects any of its panes', () => {
    const { w1, w2, add, split, focus, active } = world()
    const [x, a, b] = [add(), add(), add()]
    split({ type: 'row', sizes: [0.5, 0.5], children: [L(a), L(b)] })
    focus(w2, x)
    focus(w1, b)
    focus(w2, a)
    expect(active(w2)).toBe(a)
    expect([a, b]).not.toContain(active(w1))
  })

  it('[SV-17] a pane reopened under another profile leaves the old session’s history behind (PR-05)', () => {
    const { store, ops, runtime, w1, add, split, focus } = world()
    const [a, b, c] = [add(), add(), add()]
    const id = split({ type: 'row', sizes: [0.4, 0.3, 0.3], children: [L(a), L(b), L(c)] })
    const other = createProfile('Work', 'p-work')
    const space = createSpace('Work', other.id)
    store.update((d) => {
      d.profiles[other.id] = other
      d.spaces[space.id] = space
      d.spaceOrder.push(space.id)
    })
    runtime.savedHistory.set(b, { entries: [{ url: 'https://old-session.test/' }], index: 0 })
    focus(w1, b)
    ops.closeTabs([b], 'closed')
    // Its split moves to a Space of another profile before the pane comes back.
    expect(ops.moveItems([id], { kind: 'today', spaceId: space.id }, 0)).toBe(true)
    ops.reopenLast(w1)
    expect(splitOfTab(store.state, b)).toBe(id)
    expect(store.state.tabs[b]?.profileId).toBe(other.id)
    expect(runtime.savedHistory.has(b)).toBe(false)
  })

  it('[SV-05] a tab dropped on a row half makes a split that undo and redo take back and forth', () => {
    const { store, ops, w1, add, spaceId } = world()
    const [a, b, c] = [add(), add(), add()]
    const before = [...(store.state.spaces[spaceId]?.today ?? [])]
    const id = ops.splitWith(c, a, 'right', w1) as string
    expect(store.state.splits[id]?.layout).toEqual({ type: 'row', sizes: [0.5, 0.5], children: [L(a), L(c)] })
    expect(store.state.spaces[spaceId]?.today).toEqual([id, b])
    expect(ops.undo.undo()).toBe('Split View')
    expect(store.state.splits[id]).toBeUndefined()
    expect(store.state.spaces[spaceId]?.today).toEqual(before)
    expect(ops.undo.redo()).toBe('Split View')
    expect(Object.values(store.state.splits)).toHaveLength(1)
    // Joining an existing split: undo gives the split its old arrangement back.
    const d = add()
    const joined = ops.splitWith(d, Object.keys(store.state.splits)[0] as string, 'right', w1) as string
    expect(layoutLeaves(store.state.splits[joined]?.layout as SplitLayout)).toHaveLength(3)
    ops.undo.undo()
    expect(layoutLeaves(store.state.splits[joined]?.layout as SplitLayout)).toEqual([a, c])
    expect(store.state.spaces[spaceId]?.today).toContain(d)
  })
})

describe('Favorite splits and the Favorites cap', () => {
  it('[FV-02][SV-23] a Favorite split takes one of the 12 Favorites, however many panes it has (D19)', () => {
    const { store, ops, spaceId, add } = world()
    // Ten single Favorites and one 3-pane split: 11 tiles.
    const singles = Array.from({ length: 10 }, () => add())
    const panes = [add(), add(), add()]
    const v = 'v-favorite'
    store.update((d) => {
      const space = d.spaces[spaceId]
      const profile = d.profiles[DEFAULT_PROFILE_ID]
      if (!space || !profile) return
      space.today = space.today.filter((id) => !singles.includes(id) && !panes.includes(id))
      profile.favorites.push(...singles, v)
      d.splits[v] = { id: v, layout: { type: 'row', sizes: [0.4, 0.3, 0.3], children: panes.map(L) }, createdAt: 0 }
    })
    expect(ops.favoriteCount(DEFAULT_PROFILE_ID)).toBe(11)
    // A twelfth fits; a thirteenth is refused.
    expect(ops.favorite(add())).toBe(true)
    expect(ops.favorite(add())).toBe(false)
    expect(store.state.profiles[DEFAULT_PROFILE_ID]?.favorites).toHaveLength(12)
  })

  it('[FV-02][SV-23] a split moved in from Today takes one Favorite: it fits as the twelfth tile (D19)', () => {
    const { store, ops, add, split } = world()
    const favorites = { kind: 'favorites', profileId: DEFAULT_PROFILE_ID } as const
    for (let i = 0; i < 11; i++) expect(ops.favorite(add())).toBe(true)
    const v = split({ type: 'row', sizes: [0.4, 0.3, 0.3], children: [add(), add(), add()].map(L) })
    expect(ops.moveItems([v], favorites, 11)).toBe(true)
    expect(store.state.profiles[DEFAULT_PROFILE_ID]?.favorites).toHaveLength(12)
    expect(store.state.profiles[DEFAULT_PROFILE_ID]?.favorites).toContain(v)
    // Full now: one more tile is refused.
    expect(ops.moveItems([add()], favorites, 0)).toBe(false)
    expect(store.state.profiles[DEFAULT_PROFILE_ID]?.favorites).toHaveLength(12)
  })

  it('[FV-02][SV-23] a Favorite split may not come apart past 12 tiles; one elsewhere always may (lead review F1)', () => {
    const { store, ops, add, split } = world()
    const favorites = { kind: 'favorites', profileId: DEFAULT_PROFILE_ID } as const
    for (let i = 0; i < 10; i++) expect(ops.favorite(add())).toBe(true)
    const v = split({ type: 'row', sizes: [0.4, 0.3, 0.3], children: [add(), add(), add()].map(L) })
    // In Today, any number of tiles is fine.
    expect(overflowsFavorites(store.state, v, 3)).toBe(false)
    expect(ops.moveItems([v], favorites, 10)).toBe(true)
    // 11 tiles: a pane popped out makes 12, separating all three makes 13.
    expect(overflowsFavorites(store.state, v, 2)).toBe(false)
    expect(overflowsFavorites(store.state, v, 3)).toBe(true)
    expect(ops.favorite(add())).toBe(true)
    // 12 tiles: no room for even one more.
    expect(overflowsFavorites(store.state, v, 2)).toBe(true)
  })
})
