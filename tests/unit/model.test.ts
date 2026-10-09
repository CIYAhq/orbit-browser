import { describe, expect, it } from 'vitest'
import { activateInDraft, detachFromSplit, makeTab, pickNextActive } from '../../src/main/tabs/model'
import { createInitialState, createSpace, createWindowState, DEFAULT_PROFILE_ID } from '../../src/shared/defaults'
import { matchScore } from '../../src/shared/match'

function world() {
  const state = createInitialState(0)
  const s1 = state.spaceOrder[0] as string
  const space2 = createSpace('Work', DEFAULT_PROFILE_ID)
  state.spaces[space2.id] = space2
  state.spaceOrder.push(space2.id)
  const win = createWindowState(s1)
  state.windows[win.id] = win
  const add = (spaceId: string, where: 'today' | 'pinned' | 'favorites', lastActiveAt = 0) => {
    const tab = makeTab({ spaceId, profileId: DEFAULT_PROFILE_ID, url: 'https://x.test/' }, lastActiveAt)
    state.tabs[tab.id] = tab
    if (where === 'favorites') state.profiles[DEFAULT_PROFILE_ID]?.favorites.push(tab.id)
    else state.spaces[spaceId]?.[where].push(tab.id)
    return tab.id
  }
  return { state, s1, s2: space2.id, win: win.id, add }
}

describe('tab model', () => {
  it('activating a tab in another space switches the window to that space', () => {
    const { state, s2, win, add } = world()
    const t = add(s2, 'today')
    activateInDraft(state, win, t, 5)
    expect(state.windows[win]?.spaceId).toBe(s2)
    expect(state.windows[win]?.activeTab[s2]).toBe(t)
    expect(state.tabs[t]?.lastActiveAt).toBe(5)
  })

  it('activating a favorite keeps the current space', () => {
    const { state, s1, s2, win, add } = world()
    const fav = add(s2, 'favorites')
    activateInDraft(state, win, fav)
    expect(state.windows[win]?.spaceId).toBe(s1)
    expect(state.windows[win]?.activeTab[s1]).toBe(fav)
  })

  it('picks the most recently used awake tab next', () => {
    const { state, s1, add } = world()
    const a = add(s1, 'today', 10)
    const b = add(s1, 'today', 30)
    const c = add(s1, 'today', 20)
    for (const id of [a, b, c]) if (state.tabs[id]) (state.tabs[id] as { asleep: boolean }).asleep = false
    expect(pickNextActive(state, s1, new Set([b]))).toBe(c)
  })

  it('dissolves a split when only one pane is left', () => {
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
    detachFromSplit(state, a)
    expect(state.splits['v-1']).toBeUndefined()
    expect(state.spaces[s1]?.today).toEqual([b])
  })

  it('ranks command bar matches sensibly', () => {
    expect(matchScore('git', 'GitHub')).toBeGreaterThan(matchScore('git', 'Digital'))
    expect(matchScore('gml', 'Gmail')).toBeGreaterThan(0)
    expect(matchScore('xyz', 'Gmail')).toBe(0)
  })
})
