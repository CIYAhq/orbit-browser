import { describe, expect, it } from 'vitest'
import { makeTab } from '../../src/main/tabs/model'
import { createInitialState, DEFAULT_PROFILE_ID } from '../../src/shared/defaults'
import type { OrbitState } from '../../src/shared/state'
import { locate, moveItem, sectionOf, sidebarTabOrder, splitOfTab, tabsInItem } from '../../src/shared/tree'

function setup(): { state: OrbitState; spaceId: string } {
  const state = createInitialState(0)
  const spaceId = state.spaceOrder[0] as string
  return { state, spaceId }
}

function addTab(state: OrbitState, spaceId: string, where: 'today' | 'pinned' | 'favorites', url = 'https://a.test/') {
  const tab = makeTab({ spaceId, profileId: DEFAULT_PROFILE_ID, url })
  state.tabs[tab.id] = tab
  if (where === 'favorites') state.profiles[DEFAULT_PROFILE_ID]?.favorites.push(tab.id)
  else state.spaces[spaceId]?.[where].push(tab.id)
  return tab.id
}

describe('sidebar tree', () => {
  it('locates items and their section', () => {
    const { state, spaceId } = setup()
    const a = addTab(state, spaceId, 'today')
    const b = addTab(state, spaceId, 'pinned')
    const c = addTab(state, spaceId, 'favorites')
    expect(locate(state, a)).toEqual({ container: { kind: 'today', spaceId }, index: 0 })
    expect(sectionOf(state, a)).toBe('today')
    expect(sectionOf(state, b)).toBe('pinned')
    expect(sectionOf(state, c)).toBe('favorite')
  })

  it('moves items between containers and into folders', () => {
    const { state, spaceId } = setup()
    const a = addTab(state, spaceId, 'today')
    state.folders['f-1'] = { id: 'f-1', name: 'F', children: [], collapsed: false, createdAt: 0 }
    state.spaces[spaceId]?.pinned.push('f-1')
    expect(moveItem(state, a, { kind: 'folder', folderId: 'f-1' }, 0)).toBe(true)
    expect(state.folders['f-1']?.children).toEqual([a])
    expect(state.spaces[spaceId]?.today).toEqual([])
    expect(sectionOf(state, a)).toBe('pinned')
    expect(tabsInItem(state, 'f-1')).toEqual([a])
  })

  it('refuses to move a folder into itself or a descendant', () => {
    const { state, spaceId } = setup()
    state.folders['f-1'] = { id: 'f-1', name: 'outer', children: ['f-2'], collapsed: false, createdAt: 0 }
    state.folders['f-2'] = { id: 'f-2', name: 'inner', children: [], collapsed: false, createdAt: 0 }
    state.spaces[spaceId]?.pinned.push('f-1')
    expect(moveItem(state, 'f-1', { kind: 'folder', folderId: 'f-2' }, 0)).toBe(false)
    expect(moveItem(state, 'f-1', { kind: 'folder', folderId: 'f-1' }, 0)).toBe(false)
    expect(state.spaces[spaceId]?.pinned).toEqual(['f-1'])
  })

  it('refuses folders in favorites', () => {
    const { state, spaceId } = setup()
    state.folders['f-1'] = { id: 'f-1', name: 'F', children: [], collapsed: false, createdAt: 0 }
    state.spaces[spaceId]?.pinned.push('f-1')
    expect(moveItem(state, 'f-1', { kind: 'favorites', profileId: DEFAULT_PROFILE_ID }, 0)).toBe(false)
  })

  it('orders tabs favorites → pinned → today and resolves split membership', () => {
    const { state, spaceId } = setup()
    const today = addTab(state, spaceId, 'today')
    const pinned = addTab(state, spaceId, 'pinned')
    const fav = addTab(state, spaceId, 'favorites')
    expect(sidebarTabOrder(state, spaceId)).toEqual([fav, pinned, today])
    state.splits['v-1'] = {
      id: 'v-1',
      createdAt: 0,
      layout: {
        type: 'row',
        sizes: [0.5, 0.5],
        children: [
          { type: 'leaf', tabId: today },
          { type: 'leaf', tabId: pinned },
        ],
      },
    }
    expect(splitOfTab(state, today)).toBe('v-1')
  })
})
