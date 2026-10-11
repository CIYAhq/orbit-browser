import type { MenuItemConstructorOptions } from 'electron'
import { afterEach, describe, expect, it } from 'vitest'
import { PAGE_MENU_KEYS, SPLIT_PANE_MENU_KEYS, TAB_MENU_KEYS, withKeyHints } from '../../src/main/keys/menu-hints'
import { type MenuOps, tabMenu } from '../../src/main/tabs/menus'
import { makeTab } from '../../src/main/tabs/model'
import { createInitialState, DEFAULT_PROFILE_ID } from '../../src/shared/defaults'
import { setCustomBindings } from '../../src/shared/keymap'

/** Shortcut hints in right-click menus (KS-18). */

afterEach(() => setCustomBindings(undefined))

const ops = new Proxy({}, { get: () => () => {} }) as MenuOps

function setup() {
  const state = createInitialState(0)
  const spaceId = state.spaceOrder[0] as string
  const add = (where: 'today' | 'pinned', fields: { muted?: boolean } = {}) => {
    const tab = makeTab({ spaceId, profileId: DEFAULT_PROFILE_ID, url: 'https://x.test/', ...fields })
    state.tabs[tab.id] = tab
    state.spaces[spaceId]?.[where].push(tab.id)
    return tab.id
  }
  return { state, add }
}

/** "Label=Accelerator" for each item showing a key, submenus included. */
function hints(items: MenuItemConstructorOptions[]): string[] {
  return items.flatMap((i) => [
    ...(i.accelerator ? [`${i.label}=${i.accelerator}`] : []),
    ...(Array.isArray(i.submenu) ? hints(i.submenu) : []),
  ])
}

describe('[KS-18] keys in the tab menu', () => {
  it('shows the keys of what each item does, as they are now', () => {
    const { state, add } = setup()
    const id = add('today')
    const menu = withKeyHints(tabMenu(state, id, [], ops), TAB_MENU_KEYS, 'darwin')
    expect(hints(menu)).toEqual([
      'Pin Tab=Command+D',
      'Copy Link=Command+Shift+C',
      'Copy Link as Markdown=Command+Alt+Shift+C',
      'Close Tab=Command+W',
    ])
    expect(menu.find((i) => i.label === 'Pin Tab')?.registerAccelerator).toBe(false)
    setCustomBindings({ 'tab.togglePin': ['Cmd+Shift+P'], 'tab.duplicate': ['F7'] })
    const after = hints(withKeyHints(tabMenu(state, id, [], ops), TAB_MENU_KEYS, 'darwin'))
    expect(after).toContain('Pin Tab=Command+Shift+P')
    expect(after).toContain('Duplicate=F7')
    const linux = hints(withKeyHints(tabMenu(state, id, [], ops), TAB_MENU_KEYS, 'linux'))
    expect(linux).toContain('Close Tab=Control+W')
  })

  it('names items the tab menus have: pinned, muted and several selected tabs', () => {
    const { state, add } = setup()
    const labels = (items: MenuItemConstructorOptions[]) => items.map((i) => i.label ?? '')
    const today = add('today', { muted: true })
    const pinned = add('pinned')
    const other = add('today')
    const all = new Set([
      ...labels(tabMenu(state, today, [], ops)),
      ...labels(tabMenu(state, pinned, [], ops)),
      ...labels(tabMenu(state, other, [today, other], ops)),
    ])
    for (const [label] of TAB_MENU_KEYS) {
      if (typeof label === 'string') expect(all, label).toContain(label)
      else
        expect(
          [...all].some((l) => label.test(l)),
          String(label),
        ).toBe(true)
    }
    const several = hints(withKeyHints(tabMenu(state, other, [today, other], ops), TAB_MENU_KEYS, 'linux'))
    expect(several).toEqual(['Copy Links=Control+Shift+C', 'Close 2 Tabs=Control+W'])
  })
})

describe('[KS-18] keys in other menus', () => {
  it('leaves items with a role or keys of their own, and looks into submenus', () => {
    const menu = withKeyHints(
      [
        { role: 'copy' },
        { label: 'Reload', accelerator: 'F5' },
        { label: 'More', submenu: [{ label: 'Back' }, { label: 'Print…' }] },
        { label: 'Unknown' },
      ],
      PAGE_MENU_KEYS,
      'linux',
    )
    expect(hints(menu)).toEqual(['Reload=F5', 'Back=Alt+Left', 'Print…=Control+P'])
    expect(menu[0]).toEqual({ role: 'copy' })
    expect(menu[3]).toEqual({ label: 'Unknown' })
  })

  it("a split pane's menu shows the split keys, those given later too", () => {
    const pane = () =>
      withKeyHints([{ label: 'Flip Orientation' }, { label: 'Close Pane' }], SPLIT_PANE_MENU_KEYS, 'darwin')
    expect(hints(pane())).toEqual(['Close Pane=Control+Shift+-'])
    setCustomBindings({ 'split.flip': ['Ctrl+Shift+F'] })
    expect(hints(pane())).toEqual(['Flip Orientation=Control+Shift+F', 'Close Pane=Control+Shift+-'])
  })
})
