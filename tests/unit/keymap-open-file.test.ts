import { afterEach, describe, expect, it, vi } from 'vitest'

/** Open File… (KS-12): the dialog is a stand-in that returns what the test chose. */
const dialog = vi.hoisted(() => ({
  result: { canceled: false, filePaths: [] as string[] },
  asked: [] as unknown[][],
}))
vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: async (...args: unknown[]) => {
      dialog.asked.push(args)
      return dialog.result
    },
  },
}))

import type { MainContext } from '../../src/main/context'
import { actionInWindow, registerOpenFile } from '../../src/main/keys/open-file'
import { ActionRegistry } from '../../src/main/registry'
import { ACTIONS_BY_ID, type ActionDef, borrowedShortcutsFor } from '../../src/shared/actions'
import { createInitialState, createWindowState } from '../../src/shared/defaults'
import { setCustomBindings } from '../../src/shared/keymap'
import type { OrbitState } from '../../src/shared/state'

const peekExpand = ACTIONS_BY_ID['peek.expand'] as ActionDef
const openFile = ACTIONS_BY_ID['file.open'] as ActionDef

/** A state with a browser window and a Mini Window. */
function windowsState(): { state: OrbitState; main: string; mini: string } {
  const state = createInitialState(0)
  const spaceId = state.spaceOrder[0] as string
  const main = createWindowState(spaceId)
  const mini = { ...createWindowState(spaceId), kind: 'mini' as const }
  state.windows[main.id] = main
  state.windows[mini.id] = mini
  return { state, main: main.id, mini: mini.id }
}

afterEach(() => {
  setCustomBindings(undefined)
  dialog.asked = []
})

describe('[KS-12] ⌘O / Ctrl+O', () => {
  it('opens a file in a window with no Peek, and in a page’s pop-up; a Peek or a Mini Window keeps them', () => {
    const { state, main, mini } = windowsState()
    expect(actionInWindow(peekExpand, state, () => main).id).toBe('file.open')
    expect(actionInWindow(peekExpand, state, () => undefined).id).toBe('file.open')
    expect(actionInWindow(peekExpand, state, () => mini).id).toBe('peek.expand')
    const win = state.windows[main]
    if (!win) throw new Error('no window')
    win.overlay = { kind: 'peek' } as unknown as typeof win.overlay
    expect(actionInWindow(peekExpand, state, () => main).id).toBe('peek.expand')
    // Other keys are never changed.
    const reload = ACTIONS_BY_ID['nav.reload'] as ActionDef
    expect(actionInWindow(reload, state, () => main)).toBe(reload)
  })

  it('are Open Peek as Tab’s keys, lent to Open File as they are now', () => {
    expect(borrowedShortcutsFor(openFile, 'darwin')?.keys).toEqual(['Cmd+O'])
    expect(borrowedShortcutsFor(openFile, 'linux')?.keys).toEqual(['Ctrl+O'])
    expect(borrowedShortcutsFor(openFile, 'darwin')?.from.id).toBe('peek.expand')
    setCustomBindings({ 'peek.expand': ['Cmd+E'] })
    expect(borrowedShortcutsFor(openFile, 'darwin')?.keys).toEqual(['Cmd+E'])
    setCustomBindings({ 'peek.expand': [] })
    expect(borrowedShortcutsFor(openFile, 'darwin')).toBeUndefined()
    expect(borrowedShortcutsFor(peekExpand, 'darwin')).toBeUndefined()
  })
})

describe('[KS-12] Open File…', () => {
  function setup() {
    const { state, main, mini } = windowsState()
    const created: { url: string; activate: boolean; windowId: string | undefined }[] = []
    const focused: string[] = []
    const fakeWindow = (id: string) => ({
      isDestroyed: () => false,
      isFocused: () => false,
      focus: () => void focused.push(id),
    })
    const actions = new ActionRegistry()
    const ctx = {
      store: { state },
      actions,
      windows: {
        focusedWindowId: () => main,
        get: (id: string) => (id === main ? fakeWindow(id) : undefined),
        ids: () => [main],
        open: () => main,
      },
      commands: {
        run: async (name: string, args: { url: string; activate: boolean }, c: { windowId?: string }) => {
          if (name === 'tabs.create') created.push({ url: args.url, activate: args.activate, windowId: c.windowId })
        },
      },
    } as unknown as MainContext
    registerOpenFile(ctx)
    return { actions, main, mini, created, focused }
  }

  it('opens each file chosen in a new tab of the window, the last one selected', async () => {
    const { actions, main, created } = setup()
    dialog.result = { canceled: false, filePaths: ['/tmp/a b.html', '/tmp/c.pdf'] }
    await actions.run('file.open', { windowId: main })
    expect(dialog.asked).toHaveLength(1)
    expect(created).toEqual([
      { url: 'file:///tmp/a%20b.html', activate: false, windowId: main },
      { url: 'file:///tmp/c.pdf', activate: true, windowId: main },
    ])
  })

  it('opens nothing when the dialog is cancelled', async () => {
    const { actions, main, created } = setup()
    dialog.result = { canceled: true, filePaths: [] }
    await actions.run('file.open', { windowId: main })
    expect(created).toEqual([])
  })

  it('asked from a Mini Window, opens the files in the browser window, which comes forward', async () => {
    const { actions, main, mini, created, focused } = setup()
    dialog.result = { canceled: false, filePaths: ['/tmp/d.txt'] }
    await actions.run('file.open', { windowId: mini })
    expect(focused).toEqual([main])
    expect(created).toEqual([{ url: 'file:///tmp/d.txt', activate: true, windowId: main }])
  })
})
