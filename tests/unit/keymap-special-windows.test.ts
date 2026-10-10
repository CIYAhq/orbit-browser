import { describe, expect, it, vi } from 'vitest'
import type { MainContext } from '../../src/main/context'
import { needsSpaces, PRIVATE_WINDOW_HINT, registerSpecialWindows } from '../../src/main/keys/special-windows'
import { ActionRegistry } from '../../src/main/registry'
import { Store } from '../../src/main/store'
import { ACTIONS, defaultShortcutsFor } from '../../src/shared/actions'
import { createInitialState, createProfile, createSpace, createWindowState } from '../../src/shared/defaults'
import { canonicalAccelerator } from '../../src/shared/keymap'

/** Keys in special windows (KS-20): a private window has no Spaces, pinned tabs, Favorites or folders. */

describe('[KS-20] keys in a private window', () => {
  it('the actions behind ⌘D, ⌃1–9, ⌘⌥← / ⌘⌥→ and ⌘⇧K need Spaces, pinned tabs or Favorites; tab keys don’t', () => {
    const keys = ['Cmd+D', 'Ctrl+1', 'Ctrl+5', 'Ctrl+9', 'Cmd+Alt+Left', 'Cmd+Alt+Right', 'Cmd+Shift+K']
    for (const key of keys) {
      const action = ACTIONS.find((a) =>
        defaultShortcutsFor(a, 'darwin').some((k) => canonicalAccelerator(k) === canonicalAccelerator(key)),
      )
      expect(action, key).toBeDefined()
      expect(needsSpaces(action?.id ?? ''), `${key}: ${action?.id}`).toBe(true)
    }
    for (const id of ['tab.goto.1', 'tab.next', 'tab.close', 'tab.new', 'nav.reload', 'sidebar.toggle', 'page.find']) {
      expect(needsSpaces(id), id).toBe(false)
    }
  })

  it('they do nothing there and say so; elsewhere they run', async () => {
    const state = createInitialState(0)
    const priv = { ...createProfile('Private', 'private-1'), partition: 'orbit-private-1' }
    const privateSpace = createSpace('Private', priv.id)
    state.profiles[priv.id] = priv
    state.spaces[privateSpace.id] = privateSpace
    const normal = createWindowState(state.spaceOrder[0] as string)
    const privateWindow = createWindowState(privateSpace.id, 'private')
    state.windows[normal.id] = normal
    state.windows[privateWindow.id] = privateWindow
    const actions = new ActionRegistry()
    const toast = vi.fn()
    const ctx = {
      store: new Store(state),
      actions,
      windows: { focusedWindowId: () => privateWindow.id },
      toast,
    } as unknown as MainContext
    registerSpecialWindows(ctx)
    const ran: string[] = []
    for (const id of ['tabs.clearToday', 'space.goto.2', 'tab.goto.1']) {
      actions.register(id, (c) => void ran.push(`${id}@${c.windowId}`))
    }

    await actions.run('tabs.clearToday', { windowId: privateWindow.id })
    await actions.run('space.goto.2', {})
    expect(ran).toEqual([])
    expect(toast.mock.calls).toEqual([
      [privateWindow.id, PRIVATE_WINDOW_HINT],
      [privateWindow.id, PRIVATE_WINDOW_HINT],
    ])
    await actions.run('tab.goto.1', { windowId: privateWindow.id })
    await actions.run('tabs.clearToday', { windowId: normal.id })
    expect(ran).toEqual([`tab.goto.1@${privateWindow.id}`, `tabs.clearToday@${normal.id}`])
    expect(toast).toHaveBeenCalledTimes(2)
  })
})
