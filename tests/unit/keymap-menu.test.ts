import type { MenuItemConstructorOptions } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The macOS menu bar as installMenu builds it, on any platform: Electron's Menu is replaced by one
 * that keeps the template, and the Archive's own items by stand-ins.
 */
const menu = vi.hoisted(() => ({ template: [] as MenuItemConstructorOptions[] }))
vi.mock('electron', () => ({
  app: { name: 'Orbit' },
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      menu.template = template
      return template
    },
    setApplicationMenu: () => {},
  },
}))
vi.mock('../../src/main/archive/menus', () => ({ keepForMenu: () => ({ label: 'Keep Archived Tabs For' }) }))
vi.mock('../../src/main/archive/recently-closed', () => ({ recentlyClosedItems: () => [] }))
vi.mock('../../src/main/keys/router', () => ({ keyRouter: { menuRuns: () => true } }))

import type { MainContext } from '../../src/main/context'
import { installMenu } from '../../src/main/menu'
import { ACTIONS_BY_ID, type ActionDef, isFixed } from '../../src/shared/actions'
import { bindingProblem, setCustomBindings } from '../../src/shared/keymap'

const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor
const ctx = { windows: { focusedWindowId: () => undefined } } as unknown as MainContext

beforeEach(() => Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' }))
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  setCustomBindings(undefined)
})

/** The menu built now: each top-level menu by its label or role. */
function build(): Record<string, MenuItemConstructorOptions[]> {
  installMenu(ctx)
  return Object.fromEntries(
    menu.template.map((m) => [m.label ?? m.role ?? '?', Array.isArray(m.submenu) ? m.submenu : []]),
  )
}

const find = (items: MenuItemConstructorOptions[], label: string) => items.find((i) => i.label === label)

describe('the macOS menu bar', () => {
  it('[KS-15] keeps the system’s keys: Hide, Hide Others and Quit, the Window menu (⌘M, ⌘`) and the Help menu (⌘? search)', () => {
    const menus = build()
    expect(menus.Orbit?.filter((i) => i.role).map((i) => i.role)).toEqual([
      'services',
      'hide',
      'hideOthers',
      'unhide',
      'quit',
    ])
    expect(menu.template.map((m) => m.role).filter(Boolean)).toEqual(['windowMenu', 'help'])
    // No action may take them, so they always do what the system says.
    const mac = { 'Cmd+Q': 'Quit Orbit', 'Cmd+H': 'Hide Orbit', 'Cmd+Alt+H': 'Hide Others', 'Cmd+M': 'Minimize' }
    for (const [key, what] of Object.entries(mac)) expect(bindingProblem(key, 'darwin')).toContain(what)
    expect(bindingProblem('Cmd+`', 'darwin')).toContain('switching between Orbit windows')
    expect(bindingProblem('Cmd+Shift+/', 'darwin')).toContain('Help menu search')
    for (const p of ['linux', 'win32']) {
      expect(bindingProblem('Alt+F4', p)).toContain('closing the window')
      expect(bindingProblem('Alt+Tab', p)).toContain('switching apps')
    }
    // Windows and Linux have no Help menu: F1 opens Help (OB-13) and can't be changed there.
    const help = ACTIONS_BY_ID['help.open'] as ActionDef
    expect(help.other).toEqual(['F1'])
    expect([isFixed(help, 'linux'), isFixed(help, 'win32'), isFixed(help, 'darwin')]).toEqual([true, true, false])
  })

  it('[KS-01][KS-18] shows each item’s keys as they are now, and none for an action without keys', () => {
    let view = build().View ?? []
    expect(find(view, 'Toggle Sidebar')?.accelerator).toBe('Command+S')
    setCustomBindings({ 'sidebar.toggle': ['Cmd+Shift+B'], 'tab.togglePin': [] })
    const menus = build()
    view = menus.View ?? []
    expect(find(view, 'Toggle Sidebar')?.accelerator).toBe('Command+Shift+B')
    const pin = find(menus.Tabs ?? [], 'Pin / Unpin Tab')
    expect(pin).toBeDefined()
    expect(pin?.accelerator).toBeUndefined()
  })

  it('[KS-16] a key that edits text is only shown, so the menu never takes it from a text field', () => {
    setCustomBindings({ 'tab.togglePin': ['Cmd+A'] })
    const pin = find(build().Tabs ?? [], 'Pin / Unpin Tab')
    expect(pin?.accelerator).toBe('Command+A')
    expect(pin?.registerAccelerator).toBe(false)
    expect(find(build().View ?? [], 'Toggle Sidebar')?.registerAccelerator).toBeUndefined()
  })

  it('[KS-12] File → Open File… shows Open Peek as Tab’s ⌘O, which opens a file where there is no Peek; keys of its own replace it', () => {
    const open = find(build().File ?? [], 'Open File…')
    expect(open?.accelerator).toBe('Command+O')
    // The key router decides what ⌘O does: the menu only shows it.
    expect(open?.registerAccelerator).toBe(false)
    setCustomBindings({ 'file.open': ['Cmd+Shift+F2'] })
    const own = find(build().File ?? [], 'Open File…')
    expect(own?.accelerator).toBe('Command+Shift+F2')
    expect(own?.registerAccelerator).toBeUndefined()
  })

  it('[OB-12][OB-13] Help → Keyboard Shortcuts comes after Orbit Help', () => {
    const help = build().help
    expect(help?.map((i) => i.label).slice(0, 3)).toEqual(['Orbit Help', 'Keyboard Shortcuts', 'Report a Bug…'])
  })
})
