import { describe, expect, it } from 'vitest'
import { makeTab } from '../../src/main/tabs/model'
import { createInitialState, createSpace, createWindowState, DEFAULT_PROFILE_ID } from '../../src/shared/defaults'
import { newId } from '../../src/shared/ids'
import { popupTitle } from '../../src/shared/nav'
import {
  isLostPrivateTab,
  isPrivateTab,
  isPrivateWindow,
  mayReopenIn,
  privateMoveAllowed,
  privateTabMenu,
  windowMayShow,
  withoutPrivate,
} from '../../src/shared/private'
import type { OrbitState, Profile } from '../../src/shared/state'

/** A normal window with one tab, and a private window (profile, Space, tab) as Orbit makes them. */
function setup() {
  const state: OrbitState = createInitialState(0)
  const spaceId = state.spaceOrder[0] as string
  const normal = makeTab({ spaceId, profileId: DEFAULT_PROFILE_ID, url: 'https://a.test/' }, 0)
  state.tabs[normal.id] = normal
  state.spaces[spaceId]?.today.push(normal.id)
  const main = createWindowState(spaceId)
  main.activeTab[spaceId] = normal.id
  state.windows[main.id] = main

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
  win.activeTab[space.id] = secret.id
  state.windows[win.id] = win
  return {
    state,
    spaceId,
    normal: normal.id,
    main: main.id,
    privateSpace: space.id,
    secret: secret.id,
    privateWindow: win.id,
  }
}

describe('private windows (NV-11)', () => {
  it('knows private tabs and windows', () => {
    const { state, normal, secret, main, privateWindow } = setup()
    expect(isPrivateTab(state, secret)).toBe(true)
    expect(isPrivateTab(state, normal)).toBe(false)
    expect(isPrivateWindow(state, privateWindow)).toBe(true)
    expect(isPrivateWindow(state, main)).toBe(false)
  })

  it('leaves everything private out of what is written to disk', () => {
    const { state, spaceId, normal, secret, main, privateSpace, privateWindow } = setup()
    // A folder and a split view in the private Space, and an Archive entry naming it.
    const folderId = newId('f')
    const inFolder = makeTab({ spaceId: privateSpace, profileId: 'private-abc', url: 'https://in.test/' }, 0)
    state.tabs[inFolder.id] = inFolder
    state.folders[folderId] = { id: folderId, name: 'F', children: [inFolder.id], collapsed: false, createdAt: 0 }
    state.spaces[privateSpace]?.today.push(folderId)
    const pane = makeTab({ spaceId: privateSpace, profileId: 'private-abc', url: 'https://pane.test/' }, 0)
    state.tabs[pane.id] = pane
    const splitId = newId('v')
    state.splits[splitId] = {
      id: splitId,
      createdAt: 0,
      layout: {
        type: 'row',
        sizes: [0.5, 0.5],
        children: [
          { type: 'leaf', tabId: secret },
          { type: 'leaf', tabId: pane.id },
        ],
      },
    }
    state.archive.push(
      {
        id: newId('a'),
        url: 'https://gone.test/',
        title: 'Gone',
        spaceId: privateSpace,
        profileId: 'private-abc',
        archivedAt: 0,
        reason: 'closed',
      },
      {
        id: newId('a'),
        url: 'https://kept.test/',
        title: 'Kept',
        spaceId,
        profileId: DEFAULT_PROFILE_ID,
        archivedAt: 0,
        reason: 'closed',
      },
    )
    // A normal window that once showed the private Space must not name it.
    const mainWin = state.windows[main]
    if (mainWin) mainWin.activeTab[privateSpace] = secret

    const out = withoutPrivate(state)
    const text = JSON.stringify(out)
    for (const word of ['private-abc', 'orbit-private-abc', 'secret.test', 'in.test', 'pane.test', 'gone.test']) {
      expect(text).not.toContain(word)
    }
    expect(Object.keys(out.windows)).toEqual([main])
    expect(out.windows[main]?.activeTab).toEqual({ [spaceId]: normal })
    expect(Object.keys(out.tabs)).toEqual([normal])
    expect(out.spaces[privateSpace]).toBeUndefined()
    expect(out.folders[folderId]).toBeUndefined()
    expect(out.splits[splitId]).toBeUndefined()
    expect(out.archive.map((a) => a.url)).toEqual(['https://kept.test/'])
    expect(out.windows[privateWindow]).toBeUndefined()
    // The live state is untouched.
    expect(state.tabs[secret]).toBeDefined()
  })

  it('returns the state itself when nothing is private', () => {
    const { state, privateWindow, privateSpace, secret } = setup()
    delete state.windows[privateWindow]
    delete state.spaces[privateSpace]
    delete state.tabs[secret]
    delete state.profiles['private-abc']
    expect(withoutPrivate(state)).toBe(state)
  })

  it('a private window shows only its own tabs; no other window shows them', () => {
    const { state, normal, secret, main, privateWindow } = setup()
    expect(windowMayShow(state, privateWindow, secret)).toBe(true)
    expect(windowMayShow(state, privateWindow, normal)).toBe(false)
    expect(windowMayShow(state, main, normal)).toBe(true)
    expect(windowMayShow(state, main, secret)).toBe(false)
  })

  it('private tabs only move within their own Today, and nothing moves in', () => {
    const { state, spaceId, normal, secret, privateSpace } = setup()
    expect(privateMoveAllowed(state, [secret], { kind: 'today', spaceId: privateSpace })).toBe(true)
    expect(privateMoveAllowed(state, [secret], { kind: 'pinned', spaceId: privateSpace })).toBe(false)
    expect(privateMoveAllowed(state, [secret], { kind: 'today', spaceId })).toBe(false)
    expect(privateMoveAllowed(state, [secret], { kind: 'favorites', profileId: DEFAULT_PROFILE_ID })).toBe(false)
    expect(privateMoveAllowed(state, [normal], { kind: 'today', spaceId: privateSpace })).toBe(false)
    expect(privateMoveAllowed(state, [normal], { kind: 'pinned', spaceId })).toBe(true)
  })

  it('Reopen Closed Tab: a private tab only in its own window, a normal tab never in a private one', () => {
    const { state, spaceId, privateSpace, main, privateWindow } = setup()
    const closedSecret = { profileId: 'private-abc', spaceId: privateSpace }
    const closedNormal = { profileId: DEFAULT_PROFILE_ID, spaceId }
    expect(mayReopenIn(state, closedSecret, privateWindow)).toBe(true)
    expect(mayReopenIn(state, closedSecret, main)).toBe(false)
    expect(mayReopenIn(state, closedNormal, main)).toBe(true)
    expect(mayReopenIn(state, closedNormal, privateWindow)).toBe(false)
    // Once its window (Space) is gone, a private tab never comes back.
    delete state.spaces[privateSpace]
    expect(isLostPrivateTab(state, closedSecret)).toBe(true)
    expect(mayReopenIn(state, closedSecret, privateWindow)).toBe(false)
  })

  it('a private tab’s menu has nothing for pinned tabs, Favorites, folders or other Spaces', () => {
    const menu = [
      { label: 'Copy Link' },
      { label: 'Pin Tab' },
      { label: 'Add to Favorites' },
      { type: 'separator' },
      { label: 'Move to' },
      { label: 'New Folder with Tabs' },
      { type: 'separator' },
      { label: 'Duplicate' },
      { type: 'separator' },
      { label: 'Delete from Sidebar' },
    ]
    expect(privateTabMenu(menu)).toEqual([{ label: 'Copy Link' }, { type: 'separator' }, { label: 'Duplicate' }])
  })
})

describe('pop-up window titles (NV-09)', () => {
  it('shows the host, marked when the connection is not secure', () => {
    expect(popupTitle('https://accounts.example.com/signin?x=1')).toBe('accounts.example.com')
    expect(popupTitle('http://pay.example.com/')).toBe('Not secure — pay.example.com')
    expect(popupTitle('http://localhost:3000/cb')).toBe('localhost:3000')
    expect(popupTitle('about:blank')).toBe('')
    expect(popupTitle('not a url')).toBe('not a url')
  })
})
