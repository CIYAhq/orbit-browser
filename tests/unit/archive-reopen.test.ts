import { describe, expect, it } from 'vitest'
import type { MainContext } from '../../src/main/context'
import { Store } from '../../src/main/store'
import { makeTab } from '../../src/main/tabs/model'
import { TabOps } from '../../src/main/tabs/ops'
import { createInitialState, createWindowState, DEFAULT_PROFILE_ID } from '../../src/shared/defaults'
import type { SpaceId, TabId } from '../../src/shared/state'

type History = { entries: { url: string; title: string }[]; index: number }

/** Space A with window w1 on it; tabs close through TabOps as in the app. */
function world() {
  const state = createInitialState(0)
  const a = state.spaceOrder[0] as SpaceId
  const w1 = createWindowState(a)
  state.windows[w1.id] = w1
  const store = new Store(state)
  const savedHistory = new Map<string, History>()
  const runtime = { contents: () => undefined, savedHistory, destroy() {}, sleep() {} }
  const ctx = { store, tabs: runtime, toast() {}, windows: { get: () => undefined } } as unknown as MainContext
  const ops = new TabOps(ctx)
  /** A Today tab that went from `back` to `url`, shown in w1 when `show`. */
  const open = (url: string, back: string, show = false): TabId => {
    const tab = makeTab({ spaceId: a, profileId: DEFAULT_PROFILE_ID, url, title: url })
    store.update((d) => {
      d.tabs[tab.id] = tab
      d.spaces[a]?.today.unshift(tab.id)
      const win = d.windows[w1.id]
      if (show && win) win.activeTab[a] = tab.id
    })
    savedHistory.set(tab.id, {
      entries: [
        { url: back, title: back },
        { url, title: url },
      ],
      index: 1,
    })
    return tab.id
  }
  const shown = () => store.state.windows[w1.id]?.activeTab[a] ?? null
  const today = () => store.state.spaces[a]?.today ?? []
  return { store, ops, savedHistory, a, w1: w1.id, open, shown, today }
}

describe('Reopen closed tabs (AR-09)', () => {
  it('[AR-09] Reopen Closed Tab walks back through the closes, newest first; each comes back selected with its history', () => {
    const { store, ops, savedHistory, w1, open, shown } = world()
    const tabA = open('https://a.test/2', 'https://a.test/1')
    const tabB = open('https://b.test/2', 'https://b.test/1')
    const tabC = open('https://c.test/2', 'https://c.test/1')
    for (const id of [tabA, tabB, tabC]) {
      ops.closeTabs([id], 'closed')
      // The tab's view went with it (the runtime keeps no history for a closed tab).
      savedHistory.delete(id)
    }
    expect(ops.recentlyClosed.map((r) => r.tab.id)).toEqual([tabA, tabB, tabC])
    for (const [id, host] of [
      [tabC, 'c'],
      [tabB, 'b'],
      [tabA, 'a'],
    ] as const) {
      expect(ops.reopenLast(w1)).toBe(id)
      expect(shown()).toBe(id)
      expect(store.state.tabs[id]?.url).toBe(`https://${host}.test/2`)
      expect(savedHistory.get(id)).toEqual({
        entries: [
          { url: `https://${host}.test/1`, title: `https://${host}.test/1` },
          { url: `https://${host}.test/2`, title: `https://${host}.test/2` },
        ],
        index: 1,
      })
    }
    expect(ops.reopenLast(w1)).toBeNull()
  })

  it('[AR-09] ⌘Z reopens a just-closed tab in its place, and shows it again when it was the tab shown', () => {
    const { ops, savedHistory, open, shown, today } = world()
    const other = open('https://other.test/', 'https://other.test/0')
    const tab = open('https://shown.test/2', 'https://shown.test/1', true)
    const order = [...today()]
    ops.closeTabs([tab], 'closed')
    savedHistory.delete(tab)
    expect(shown()).toBe(other)
    expect(ops.undo.undo()).toBe('Close Tab')
    expect(today()).toEqual(order)
    expect(shown()).toBe(tab)
    expect(savedHistory.get(tab)?.entries.map((e) => e.url)).toEqual(['https://shown.test/1', 'https://shown.test/2'])
    // A tab closed in the background comes back without taking the selection.
    const bg = open('https://bg.test/', 'https://bg.test/0')
    ops.closeTabs([bg], 'closed')
    expect(ops.undo.undo()).toBe('Close Tab')
    expect(today()).toContain(bg)
    expect(shown()).toBe(tab)
  })
})
