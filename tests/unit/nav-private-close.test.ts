import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { on: () => {} },
  Menu: { buildFromTemplate: () => ({}) },
  session: {
    fromPartition: () => ({
      clearStorageData: async () => {},
      clearCache: async () => {},
      clearAuthCache: async () => {},
      clearHostResolverCache: async () => {},
    }),
  },
}))
vi.mock('../../src/main/external-links', () => ({
  PRIVATE_WINDOW_SWITCH: '--private',
  privateSwitchIn: () => false,
  urlsInArgv: () => [],
}))

import type { MainContext } from '../../src/main/context'
import { registerPrivate } from '../../src/main/nav/private'
import type { SitePrefs } from '../../src/main/nav/site-prefs'
import { Store } from '../../src/main/store'
import { makeTab } from '../../src/main/tabs/model'
import type { TabOps } from '../../src/main/tabs/ops'
import { createInitialState, createSpace, createWindowState, DEFAULT_PROFILE_ID } from '../../src/shared/defaults'
import type { OrbitState, Profile } from '../../src/shared/state'

/** The private windows module with fakes around it; `closed` is every closeTabs call it makes. */
function register(state: OrbitState) {
  const store = new Store(state)
  const closed: { tabIds: string[]; opts: unknown }[] = []
  const ops = {
    // Closed with `remove`: gone from the state, as the tabs module does it.
    closeTabs: (tabIds: string[], _how: string, opts: unknown) => {
      closed.push({ tabIds: [...tabIds], opts })
      store.update((d) => {
        for (const id of tabIds) {
          const space = d.spaces[d.tabs[id]?.spaceId ?? '']
          if (space) space.today = space.today.filter((t) => t !== id)
          delete d.tabs[id]
        }
      })
    },
    recentlyClosed: [],
    createTab: () => undefined,
  } as unknown as TabOps
  const ctx = {
    store,
    actions: { register: () => {}, intercept: () => {}, run: async () => {} },
    commands: { run: async () => {} },
    windows: { focusedWindowId: () => undefined },
    sessions: { forget: () => {} },
    e2e: true,
  } as unknown as MainContext
  registerPrivate(ctx, ops, { forgetPrivate: () => {} } as unknown as SitePrefs)
  return { store, closed }
}

/** What the module does once a window has gone comes on the next turn of the event loop. */
const settled = () => new Promise((resolve) => setImmediate(resolve))

/** A normal Space with a tab, and a second one the normal window shows. */
function normalSpaces() {
  const state = createInitialState(0)
  const home = state.spaceOrder[0] as string
  const tab = makeTab({ spaceId: home, profileId: DEFAULT_PROFILE_ID, url: 'https://a.test/' }, 0)
  state.tabs[tab.id] = tab
  state.spaces[home]?.today.push(tab.id)
  const work = createSpace('Work', DEFAULT_PROFILE_ID, undefined, '', 0)
  state.spaces[work.id] = work
  state.spaceOrder.push(work.id)
  const main = createWindowState(work.id)
  state.windows[main.id] = main
  return { state, home, tab: tab.id }
}

describe('closing a private window (NV-11, fix check B F3)', () => {
  it('a private window showing a normal Space leaves that Space and its tabs when it closes', async () => {
    const { state, home, tab } = normalSpaces()
    const win = createWindowState(home, 'private')
    state.windows[win.id] = win
    const { store, closed } = register(state)
    store.update((d) => {
      delete d.windows[win.id]
    })
    await settled()
    await settled()
    expect(closed).toEqual([])
    expect(store.state.spaces[home]?.today).toEqual([tab])
  })

  it('a private window’s own Space and tabs go when it closes, with nothing kept', async () => {
    const { state } = normalSpaces()
    const profile: Profile = {
      id: 'private-abc',
      name: 'Private',
      partition: 'orbit-private-abc',
      favorites: [],
      createdAt: 0,
    }
    state.profiles[profile.id] = profile
    const space = createSpace('Private', profile.id, undefined, '', 0)
    state.spaces[space.id] = space
    const secret = makeTab({ spaceId: space.id, profileId: profile.id, url: 'https://secret.test/' }, 0)
    state.tabs[secret.id] = secret
    space.today.push(secret.id)
    const win = createWindowState(space.id, 'private')
    state.windows[win.id] = win
    const { store, closed } = register(state)
    store.update((d) => {
      delete d.windows[win.id]
    })
    await settled()
    await settled()
    expect(closed).toEqual([{ tabIds: [secret.id], opts: { remove: true, undoLabel: false } }])
    expect(store.state.spaces[space.id]).toBeUndefined()
    expect(store.state.profiles[profile.id]).toBeUndefined()
  })
})
