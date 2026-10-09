import { describe, expect, it } from 'vitest'
import type { MainContext } from '../../src/main/context'
import { detachTab } from '../../src/main/split/model'
import { Store } from '../../src/main/store'
import { activateInDraft, makeTab } from '../../src/main/tabs/model'
import { TabOps } from '../../src/main/tabs/ops'
import { createInitialState, createWindowState, DEFAULT_PROFILE_ID } from '../../src/shared/defaults'
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
  const ctx = {
    store,
    tabs: { contents: () => undefined, savedHistory: new Map(), destroy() {}, sleep() {} },
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
  return { store, ops, spaceId, w1: w1.id, w2: w2.id, add, split, focus, active }
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
})
