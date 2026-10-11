import { describe, expect, it } from 'vitest'
import { blankSpace } from '../../src/main/tabs/blank'
import { makeTab } from '../../src/main/tabs/model'
import { recentOrder } from '../../src/main/tabs/switcher'
import { createInitialState, createSpace, createWindowState, DEFAULT_PROFILE_ID } from '../../src/shared/defaults'
import { newId } from '../../src/shared/ids'
import type { OrbitState, Profile, SpaceId, TabId } from '../../src/shared/state'
import { switcherOf, switcherParams, TAB_SWITCHER_PANEL } from '../../src/shared/tab-switcher'

/** The recent-tab switcher's list (TB-05): which tabs, in which order. */

/** Adds a Today tab to `spaceId`, last used at `at`. */
function addTab(state: OrbitState, spaceId: SpaceId, at: number, profileId = DEFAULT_PROFILE_ID): TabId {
  const tab = makeTab({ spaceId, profileId, url: `https://t${at}.test/` }, 0)
  tab.lastActiveAt = at
  state.tabs[tab.id] = tab
  state.spaces[spaceId]?.today.push(tab.id)
  return tab.id
}

/** A normal window on a Space whose Today tabs were last used at `times`; the first is shown. */
function setup(times: number[]) {
  const state: OrbitState = createInitialState(0)
  const spaceId = state.spaceOrder[0] as string
  const ids = times.map((at) => addTab(state, spaceId, at))
  const win = createWindowState(spaceId)
  win.activeTab[spaceId] = ids[0] ?? null
  state.windows[win.id] = win
  return { state, spaceId, ids, windowId: win.id }
}

describe('the recent-tab switcher (TB-05)', () => {
  it('[TB-05] lists the tab shown first, then the most recently used, five in all', () => {
    const { state, ids, windowId } = setup([10, 70, 30, 60, 20, 50, 40])
    const [shown, t70, t30, t60, , t50, t40] = ids as TabId[]
    expect(recentOrder(state, windowId, shown as TabId)).toEqual([shown, t70, t60, t50, t40])
    // Nothing shown: the most recent five.
    expect(recentOrder(state, windowId, null)).toEqual([t70, t60, t50, t40, t30])
    // One tab: nothing to switch to (the caller shows no list).
    const one = setup([5])
    expect(recentOrder(one.state, one.windowId, one.ids[0] as TabId)).toEqual(one.ids)
  })

  it('[TB-05] lists the window’s sidebar: Favorites, pinned tabs and tabs in folders, each once, and no other Space’s', () => {
    const { state, spaceId, ids, windowId } = setup([10])
    const space = state.spaces[spaceId]
    if (!space) throw new Error('no Space')
    const pinned = addTab(state, spaceId, 50)
    space.today = space.today.filter((id) => id !== pinned)
    space.pinned.push(pinned)
    const favorite = addTab(state, spaceId, 40)
    space.today = space.today.filter((id) => id !== favorite)
    state.profiles[DEFAULT_PROFILE_ID]?.favorites.push(favorite)
    const inFolder = addTab(state, spaceId, 30)
    space.today = space.today.filter((id) => id !== inFolder)
    const folderId = newId('f')
    state.folders[folderId] = { id: folderId, name: 'Folder', children: [inFolder], collapsed: true, createdAt: 0 }
    space.today.push(folderId)
    // Another Space's tab, used most recently of all.
    const other = createSpace('Other', DEFAULT_PROFILE_ID, undefined, '', 0)
    state.spaces[other.id] = other
    state.spaceOrder.push(other.id)
    addTab(state, other.id, 99)
    expect(recentOrder(state, windowId, ids[0] as TabId)).toEqual([ids[0], pinned, favorite, inFolder])
  })

  it('[TB-05][TB-17][NV-11] a blank or private window lists only its own tabs, and no other window lists them', () => {
    const { state, ids, windowId } = setup([10, 20])
    // A blank window (TB-17) with two tabs, used last.
    const blank = blankSpace(DEFAULT_PROFILE_ID, 0)
    state.spaces[blank.id] = blank
    const thrown = [addTab(state, blank.id, 90), addTab(state, blank.id, 80)]
    const blankWin = createWindowState(blank.id)
    blankWin.activeTab[blank.id] = thrown[0] ?? null
    state.windows[blankWin.id] = blankWin
    // A private window (NV-11) with two tabs; its profile's Favorites hold a third.
    const profile: Profile = {
      id: 'private-abc',
      name: 'Private',
      partition: 'orbit-private-abc',
      favorites: [],
      createdAt: 0,
    }
    state.profiles[profile.id] = profile
    const secretSpace = createSpace('Private', profile.id, undefined, '', 0)
    state.spaces[secretSpace.id] = secretSpace
    const secret = [addTab(state, secretSpace.id, 95, profile.id), addTab(state, secretSpace.id, 85, profile.id)]
    const privateWin = createWindowState(secretSpace.id, 'private')
    privateWin.activeTab[secretSpace.id] = secret[0] ?? null
    state.windows[privateWin.id] = privateWin

    expect(recentOrder(state, windowId, ids[0] as TabId)).toEqual([ids[0], ids[1]])
    expect(recentOrder(state, blankWin.id, thrown[0] as TabId)).toEqual(thrown)
    expect(recentOrder(state, privateWin.id, secret[0] as TabId)).toEqual(secret)
    // A normal tab dropped into a private window's Favorites by a hand-edited file is still not listed there.
    profile.favorites.push(ids[1] as TabId)
    expect(recentOrder(state, privateWin.id, secret[0] as TabId)).toEqual(secret)
  })

  it('[TB-05][D65] a tab an import keeps out of sight is never listed, however recent; one the user placed is', () => {
    const { state, spaceId, ids, windowId } = setup([10, 20])
    // The import's tabs are in the state but in no section (in a folder no section holds yet).
    const hidden = makeTab({ spaceId, profileId: DEFAULT_PROFILE_ID, url: 'https://imported.test/' }, 0)
    hidden.lastActiveAt = 99
    state.tabs[hidden.id] = hidden
    const folderId = newId('f')
    state.folders[folderId] = { id: folderId, name: 'Imported', children: [hidden.id], collapsed: true, createdAt: 0 }
    expect(recentOrder(state, windowId, ids[0] as TabId)).toEqual(ids)
    // Placed (D65 (2)): listed where it is.
    state.spaces[spaceId]?.today.push(hidden.id)
    expect(recentOrder(state, windowId, ids[0] as TabId)).toEqual([ids[0], hidden.id, ids[1]])
  })

  it('[TB-05] the overlay panel carries the tabs, the highlighted one and whether the list is drawn; another panel is no switcher', () => {
    const params = switcherParams(['tab-a', 'tab-b', 'tab-c'], 2, true)
    expect(switcherOf({ kind: 'panel', panel: TAB_SWITCHER_PANEL, nonce: 1, params })).toEqual({
      tabs: ['tab-a', 'tab-b', 'tab-c'],
      index: 2,
      shown: true,
    })
    const held = switcherParams(['tab-a', 'tab-b'], 1, false)
    expect(switcherOf({ kind: 'panel', panel: TAB_SWITCHER_PANEL, nonce: 2, params: held })?.shown).toBe(false)
    expect(switcherOf({ kind: 'panel', panel: 'row-menu', nonce: 1, params })).toBeNull()
    expect(switcherOf({ kind: 'none' })).toBeNull()
    expect(switcherOf(undefined)).toBeNull()
  })
})
