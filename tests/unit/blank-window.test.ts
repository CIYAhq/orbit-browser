import { describe, expect, it } from 'vitest'
import type { MainContext } from '../../src/main/context'
import { normalizeState } from '../../src/main/persist'
import { deleteProfileInDraft, normalizeSpacesInDraft, switchSpaceInDraft } from '../../src/main/spaces/model'
import { Store } from '../../src/main/store'
import { blankSpace } from '../../src/main/tabs/blank'
import { activateInDraft, makeTab } from '../../src/main/tabs/model'
import { TabOps } from '../../src/main/tabs/ops'
import { isBlankSpace, isBlankWindow } from '../../src/shared/blank'
import {
  createInitialState,
  createProfile,
  createSpace,
  createWindowState,
  DEFAULT_PROFILE_ID,
} from '../../src/shared/defaults'
import { mayReopenIn, privateMoveAllowed, windowMayShow } from '../../src/shared/private'
import type { OrbitState, WindowState } from '../../src/shared/state'
import { locate } from '../../src/shared/tree'

/** Blank windows (TB-17): a sidebar of their own, kept out of the Space list, kept across a relaunch. */

/** A normal window on a Space with one tab, a second Space, and a blank window holding one tab. */
function setup() {
  const state: OrbitState = createInitialState(0)
  const spaceId = state.spaceOrder[0] as string
  const other = createSpace('Other', DEFAULT_PROFILE_ID, undefined, '', 0)
  state.spaces[other.id] = other
  state.spaceOrder.push(other.id)
  const normal = makeTab({ spaceId, profileId: DEFAULT_PROFILE_ID, url: 'https://a.test/' }, 0)
  state.tabs[normal.id] = normal
  state.spaces[spaceId]?.today.push(normal.id)
  const main = createWindowState(spaceId)
  main.activeTab[spaceId] = normal.id
  state.windows[main.id] = main

  const space = blankSpace(DEFAULT_PROFILE_ID, 0)
  state.spaces[space.id] = space
  const thrown = makeTab({ spaceId: space.id, profileId: DEFAULT_PROFILE_ID, url: 'https://thrown.test/' }, 0)
  state.tabs[thrown.id] = thrown
  space.today.push(thrown.id)
  const blank = createWindowState(space.id)
  blank.activeTab[space.id] = thrown.id
  state.windows[blank.id] = blank
  return {
    state,
    spaceId,
    other: other.id,
    normal: normal.id,
    main: main.id,
    blankSpace: space.id,
    thrown: thrown.id,
    blank: blank.id,
  }
}

describe('blank windows (TB-17)', () => {
  it('[TB-17][SP-23] a blank window shows only its own tabs, and no other window shows them', () => {
    const { state, normal, main, thrown, blank, blankSpace: sp } = setup()
    expect(isBlankSpace(state, sp)).toBe(true)
    expect(isBlankWindow(state, blank)).toBe(true)
    expect(isBlankWindow(state, main)).toBe(false)
    expect(windowMayShow(state, blank, thrown)).toBe(true)
    expect(windowMayShow(state, blank, normal)).toBe(false)
    expect(windowMayShow(state, main, thrown)).toBe(false)
    expect(windowMayShow(state, main, normal)).toBe(true)
  })

  it('[TB-17][SP-23] it has no Spaces: it never switches, and no window switches to its Space', () => {
    const { state, spaceId, other, main, blank, blankSpace: sp } = setup()
    expect(switchSpaceInDraft(state, blank, other)).toBe(false)
    expect(state.windows[blank]?.spaceId).toBe(sp)
    expect(switchSpaceInDraft(state, main, sp)).toBe(false)
    expect(state.windows[main]?.spaceId).toBe(spaceId)
    expect(switchSpaceInDraft(state, main, other)).toBe(true)
  })

  it('[TB-17] its tabs stay in its Today: nothing moves in or out, nor into pinned tabs or Favorites', () => {
    const { state, spaceId, normal, thrown, blankSpace: sp } = setup()
    const second = makeTab({ spaceId: sp, profileId: DEFAULT_PROFILE_ID, url: 'https://b.test/' }, 0)
    state.tabs[second.id] = second
    state.spaces[sp]?.today.push(second.id)
    expect(privateMoveAllowed(state, [thrown], { kind: 'today', spaceId: sp })).toBe(true)
    expect(privateMoveAllowed(state, [thrown], { kind: 'today', spaceId })).toBe(false)
    expect(privateMoveAllowed(state, [thrown], { kind: 'pinned', spaceId: sp })).toBe(false)
    expect(privateMoveAllowed(state, [thrown], { kind: 'favorites', profileId: DEFAULT_PROFILE_ID })).toBe(false)
    expect(privateMoveAllowed(state, [normal], { kind: 'today', spaceId: sp })).toBe(false)
  })

  it('[TB-17][TB-07] a closed tab comes back in its own blank window while it is open; once it is gone, in a normal one', () => {
    const { state, normal, main, thrown, blank, blankSpace: sp } = setup()
    const closed = { ...(state.tabs[thrown] as NonNullable<OrbitState['tabs'][string]>) }
    expect(mayReopenIn(state, closed, blank)).toBe(true)
    expect(mayReopenIn(state, closed, main)).toBe(false)
    // A normal tab never comes back in a blank window: it can't show it.
    expect(mayReopenIn(state, state.tabs[normal] as NonNullable<OrbitState['tabs'][string]>, blank)).toBe(false)
    delete state.windows[blank]
    delete state.spaces[sp]
    expect(mayReopenIn(state, closed, main)).toBe(true)
  })

  it('[TB-17][TB-22] saved and loaded, it is kept with its tabs and stays out of the Space list, with its window or without', () => {
    const { state, spaceId, other, thrown, blank, blankSpace: sp } = setup()
    const loaded = normalizeState(JSON.parse(JSON.stringify(state)))
    expect(loaded.spaceOrder).toEqual([spaceId, other])
    expect(loaded.spaces[sp]?.blank).toBe(true)
    expect(loaded.spaces[sp]?.today).toEqual([thrown])
    expect(loaded.tabs[thrown]?.spaceId).toBe(sp)
    expect(loaded.windows[blank]?.spaceId).toBe(sp)
    expect(loaded.windows[blank]?.activeTab[sp]).toBe(thrown)
    // Its window gone (a crash part-way through closing it): the Space and its tabs are kept, out of the Space list,
    // for main to send its tabs to the Archive once it has loaded (tabs/blank.ts), as when its window closes.
    const lost = JSON.parse(JSON.stringify(state)) as OrbitState
    delete lost.windows[blank]
    const again = normalizeState(lost)
    expect(again.spaces[sp]?.blank).toBe(true)
    expect(again.spaces[sp]?.today).toEqual([thrown])
    expect(again.tabs[thrown]?.spaceId).toBe(sp)
    expect(again.spaceOrder).toEqual([spaceId, other])
    // Listed in the Space order (a file edited by hand, say), it comes out of it.
    const listed = JSON.parse(JSON.stringify(state)) as OrbitState
    listed.spaceOrder.push(sp)
    expect(normalizeState(listed).spaceOrder).toEqual([spaceId, other])
    // Only `true` marks a blank Space.
    const odd = JSON.parse(JSON.stringify(state)) as OrbitState
    ;(odd.spaces[other] as unknown as { blank: unknown }).blank = 'yes'
    expect(normalizeState(odd).spaces[other]?.blank).toBeUndefined()
  })

  it('[TB-17][TB-09][TB-18] a Today tab dragged out moves to a blank window and ⌘Z puts it back; ⌘⇧Z once that window has closed leaves it in a Space that exists', () => {
    const state = createInitialState(0)
    const spaceId = state.spaceOrder[0] as string
    const main = createWindowState(spaceId)
    state.windows[main.id] = main
    const store = new Store(state)
    const opened: string[] = []
    const ctx = {
      store,
      tabs: { contents: () => undefined, savedHistory: new Map<string, unknown>(), destroy() {}, sleep() {} },
      toast() {},
      windows: {
        get: () => undefined,
        open: (w: WindowState) => {
          opened.push(w.id)
          return w.id
        },
      },
    } as unknown as MainContext
    const ops = new TabOps(ctx)
    const add = (url: string) => {
      const tab = makeTab({ spaceId, profileId: DEFAULT_PROFILE_ID, url }, 0)
      store.update((d) => {
        d.tabs[tab.id] = tab
        d.spaces[spaceId]?.today.push(tab.id)
      })
      return tab.id
    }
    const keep = add('https://keep.test/')
    const other = add('https://other.test/')
    store.update((d) => activateInDraft(d, main.id, keep))

    const id = ops.toNewWindow(keep, main.id) as string
    expect(opened).toEqual([id])
    let s = store.state
    const blank = s.windows[id]?.spaceId as string
    expect(s.spaces[blank]?.blank).toBe(true)
    expect(s.spaceOrder).toEqual([spaceId])
    expect(s.spaces[blank]?.today).toEqual([keep])
    expect(s.tabs[keep]?.spaceId).toBe(blank)
    expect(s.windows[id]?.activeTab[blank]).toBe(keep)
    // The window it left shows another tab.
    expect(s.spaces[spaceId]?.today).toEqual([other])
    expect(s.windows[main.id]?.activeTab[spaceId]).toBe(other)

    expect(ops.undo.undo()).toBe('Move to New Window')
    s = store.state
    expect(s.spaces[spaceId]?.today).toEqual([keep, other])
    expect(s.tabs[keep]?.spaceId).toBe(spaceId)
    expect(s.spaces[blank]?.today).toEqual([])
    expect(s.windows[id]?.activeTab[blank] ?? null).toBeNull()

    // The blank window closes, and its Space goes; redo has no blank window to put the tab back in.
    store.update((d) => {
      delete d.windows[id]
      delete d.spaces[blank]
    })
    expect(ops.undo.redo()).toBe('Move to New Window')
    s = store.state
    expect(locate(s, keep)?.container).toEqual({ kind: 'today', spaceId })
    expect(s.tabs[keep]?.spaceId).toBe(spaceId)
    expect(s.tabs[keep]?.profileId).toBe(DEFAULT_PROFILE_ID)
  })

  it('[TB-17][PR-08] a profile a blank window shows pages of is not deleted; once that window has closed, it is', () => {
    const state = createInitialState(0)
    const work = createProfile('Work')
    state.profiles[work.id] = work
    const space = blankSpace(work.id, 0)
    state.spaces[space.id] = space
    const win = createWindowState(space.id)
    state.windows[win.id] = win
    expect(deleteProfileInDraft(state, work.id)).toBeUndefined()
    expect(state.profiles[work.id]).toBeDefined()
    delete state.windows[win.id]
    delete state.spaces[space.id]
    expect(deleteProfileInDraft(state, work.id)).toEqual({ removed: [] })
    expect(state.profiles[work.id]).toBeUndefined()
  })

  it('[TB-17] stored Spaces brought up to date include blank windows’ Spaces', () => {
    const { state, blankSpace: sp } = setup()
    const stored = state.spaces[sp] as unknown as Record<string, unknown>
    stored.profileId = 'gone'
    stored.today = 'not a list'
    normalizeSpacesInDraft(state)
    expect(state.spaces[sp]?.profileId).toBe(DEFAULT_PROFILE_ID)
    expect(state.spaces[sp]?.today).toEqual([])
    expect(state.spaceOrder).not.toContain(sp)
  })
})
