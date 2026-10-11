import { describe, expect, it } from 'vitest'
import type { MainContext } from '../../src/main/context'
import { CommandRegistry } from '../../src/main/registry'
import { Store } from '../../src/main/store'
import { registerThemeUndo, themePickerSpace } from '../../src/main/tabs/theme-undo'
import { UndoStack } from '../../src/main/tabs/undo'
import { createInitialState } from '../../src/shared/defaults'
import type { OverlayState, SpaceTheme, WindowState } from '../../src/shared/state'

/** ⌘Z after the theme picker closes reverts what it changed (SP-14). */

const RED: SpaceTheme = { colors: ['#d4322c'], intensity: 1, grain: 0 }
const GREEN: SpaceTheme = { colors: ['#2fbf8f'], intensity: 1, grain: 0 }
const BLUE: SpaceTheme = { colors: ['#2f6bff', '#8a2fff'], intensity: 0.6, grain: 0.3 }

function setup() {
  const state = createInitialState(0)
  const spaceId = state.spaceOrder[0] as string
  state.spaces[spaceId] = { ...(state.spaces[spaceId] as (typeof state.spaces)[string]), theme: RED }
  state.settings.appearance = 'light'
  const win = {
    id: 'w1',
    kind: 'main',
    spaceId,
    activeTab: {},
    sidebar: { visible: true, width: 240, peeking: false },
    overlay: { kind: 'none' },
    focused: true,
    fullscreen: false,
  } as unknown as WindowState
  state.windows.w1 = win
  const store = new Store(state)
  const commands = new CommandRegistry()
  // As the spaces area does: the picker applies its changes live through these.
  commands.register('spaces.update', ({ spaceId: id, theme }) => {
    store.update((d) => {
      const space = d.spaces[id]
      if (space && theme) space.theme = theme
    })
  })
  commands.register('spaces.setAppearance', ({ appearance }) => {
    store.update((d) => {
      d.settings.appearance = appearance
    })
  })
  const undo = new UndoStack()
  registerThemeUndo({ store, commands } as unknown as MainContext, undo)
  const overlay = (o: OverlayState) =>
    store.update((d) => {
      const w = d.windows.w1
      if (w) w.overlay = o
    })
  const picker = (id = spaceId, nonce = 1) =>
    overlay({ kind: 'panel', panel: 'space-theme', nonce, params: { spaceId: id } })
  const edit = (theme: SpaceTheme) => void commands.run('spaces.update', { spaceId, theme })
  const theme = () => store.state.spaces[spaceId]?.theme
  return { store, commands, undo, spaceId, overlay, picker, edit, theme }
}

describe('theme picker undo (SP-14)', () => {
  it('[SP-14] ⌘Z after the picker closed puts the theme back as it was when it opened; ⌘⇧Z puts the change back, and ⌘Z undoes it again', () => {
    const { undo, overlay, picker, edit, theme } = setup()
    picker()
    // Changes apply live while it is open, many of them (a drag).
    edit(GREEN)
    edit(BLUE)
    // Nothing to undo while it is open: the change is one, made when it closes.
    expect(undo.size).toBe(0)
    overlay({ kind: 'none' })
    expect(undo.size).toBe(1)
    expect(undo.undo()).toBe('Change Theme')
    expect(theme()).toEqual(RED)
    expect(undo.redo()).toBe('Change Theme')
    expect(theme()).toEqual(BLUE)
    expect(undo.undo()).toBe('Change Theme')
    expect(theme()).toEqual(RED)
  })

  it('[SP-14][SP-18] a light/dark change made in the picker is reverted with it', () => {
    const { store, commands, undo, overlay, picker, edit, theme } = setup()
    picker()
    edit(GREEN)
    void commands.run('spaces.setAppearance', { appearance: 'dark' })
    overlay({ kind: 'none' })
    undo.undo()
    expect(theme()).toEqual(RED)
    expect(store.state.settings.appearance).toBe('light')
  })

  it('[SP-14] opening and closing it without a change records nothing; nor does a change made with it closed', () => {
    const { undo, overlay, picker, edit } = setup()
    picker()
    overlay({ kind: 'none' })
    edit(GREEN)
    expect(undo.size).toBe(0)
    // Another panel replacing it closes it too.
    picker()
    edit(BLUE)
    overlay({ kind: 'panel', panel: 'space-icon', nonce: 2, params: { spaceId: 'x' } })
    expect(undo.size).toBe(1)
  })

  it('[SP-14] a Space deleted since has nothing to revert', () => {
    const { store, undo, overlay, picker, edit, spaceId } = setup()
    picker()
    edit(GREEN)
    overlay({ kind: 'none' })
    store.update((d) => {
      delete d.spaces[spaceId]
    })
    expect(undo.undo()).toBeUndefined()
  })

  it('[SP-14] knows the picker by its panel', () => {
    expect(themePickerSpace({ kind: 'panel', panel: 'space-theme', nonce: 1, params: { spaceId: 's1' } })).toBe('s1')
    expect(
      themePickerSpace({ kind: 'panel', panel: 'space-icon', nonce: 1, params: { spaceId: 's1' } }),
    ).toBeUndefined()
    expect(themePickerSpace({ kind: 'none' })).toBeUndefined()
  })
})
