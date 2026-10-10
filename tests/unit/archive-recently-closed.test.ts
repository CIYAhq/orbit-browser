import { describe, expect, it, vi } from 'vitest'

// Menu icons are made only on macOS; nothing else from Electron runs here.
vi.mock('electron', () => ({ nativeImage: { createFromDataURL: () => ({ isEmpty: () => true }) } }))

import { recentlyClosedItems, refreshRecentlyClosed } from '../../src/main/archive/recently-closed'
import type { MainContext } from '../../src/main/context'
import { CommandRegistry } from '../../src/main/registry'
import { Store } from '../../src/main/store'
import { createInitialState, createProfile, createSpace, DEFAULT_PROFILE_ID } from '../../src/shared/defaults'
import type { CommandResult } from '../../src/shared/rpc'

type Closed = CommandResult<'tabs.recentlyClosed'>[number]

describe('Recently Closed in normal windows (AR-09, review M3)', () => {
  it('[AR-09] the Archive toolbar’s and the File menu’s Recently Closed never list a tab of a private or deleted profile', async () => {
    const state = createInitialState(0)
    const home = state.spaceOrder[0] as string
    // A private window's profile and Space (outside the Space list), and a profile deleted since.
    const priv = { ...createProfile('Private', 'private-1'), partition: 'orbit-private-1' }
    const ps = createSpace('Private', priv.id)
    state.profiles[priv.id] = priv
    state.spaces[ps.id] = ps
    const store = new Store(state)
    const closed: Closed[] = [
      {
        tabId: 't-secret',
        url: 'https://secret.test/',
        title: 'SecretClosedPrivate',
        spaceId: ps.id,
        profileId: priv.id,
        closedAt: 3,
      },
      {
        tabId: 't-gone',
        url: 'https://gone.test/',
        title: 'From a deleted profile',
        spaceId: 's-gone',
        profileId: 'p-gone',
        closedAt: 2,
      },
      {
        tabId: 't-news',
        url: 'https://news.test/',
        title: 'News',
        spaceId: home,
        profileId: DEFAULT_PROFILE_ID,
        closedAt: 1,
      },
    ]
    const commands = new CommandRegistry()
    commands.register('tabs.recentlyClosed', () => closed)
    const ctx = { store, commands, windows: { focusedWindowId: () => undefined } } as unknown as MainContext

    await refreshRecentlyClosed(ctx)
    expect(recentlyClosedItems(ctx).map((i) => i.label)).toEqual(['News'])
    // With nothing else closed, the list says so.
    closed.splice(2, 1)
    await refreshRecentlyClosed(ctx)
    expect(recentlyClosedItems(ctx)).toEqual([{ label: 'No Recently Closed Tabs', enabled: false }])
  })
})
