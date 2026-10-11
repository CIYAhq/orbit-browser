import { afterEach, describe, expect, it } from 'vitest'
import { type SheetGroup, sheetGroups } from '../../src/renderer/src/keys/sheet'
import { ACTIONS_BY_ID } from '../../src/shared/actions'
import { setCustomBindings } from '../../src/shared/keymap'

/** Help → Keyboard Shortcuts (OB-12): the essential shortcuts with the keys they have now (KS-18). */

afterEach(() => setCustomBindings(undefined))

const keysOf = (groups: SheetGroup[], title: string) =>
  groups.flatMap((g) => g.rows).find((r) => r.title === title)?.keys

describe('[OB-12] the shortcut sheet', () => {
  it('groups the essential shortcuts as Everyday, Navigation, Spaces and Split View', () => {
    const groups = sheetGroups('darwin', { lastTabOnCmd9: true })
    expect(groups.map((g) => g.title)).toEqual(['Everyday', 'Navigation', 'Spaces', 'Split View'])
    expect(groups.every((g) => g.rows.length > 0)).toBe(true)
    expect(keysOf(groups, 'New Tab or Search')).toBe('⌘T')
    expect(keysOf(groups, 'Back / Forward')).toBe('⌘[ / ⌘]')
    expect(keysOf(groups, 'Go to Tab 1–8')).toBe('⌘1–⌘8')
    expect(keysOf(groups, 'Switch to Space 1–9')).toBe('⌃1–⌃9')
    expect(keysOf(groups, 'Focus Pane 1–4')).toBe('⌃⇧1–⌃⇧4')
    const linux = sheetGroups('linux', { lastTabOnCmd9: true })
    expect(keysOf(linux, 'Switch to Space 1–9')).toBe('Alt+1–Alt+9')
    expect(keysOf(linux, 'Back / Forward')).toBe('Alt+← / Alt+→')
  })

  it('names only actions Orbit has', () => {
    const ids = ['tab.new', 'tab.close', 'nav.back', 'space.goto.9', 'split.focus.4', 'help.shortcuts']
    for (const id of ids) expect(ACTIONS_BY_ID[id], id).toBeDefined()
  })

  it('shows the keys after a remap, and says when an action has none', () => {
    setCustomBindings({ 'tab.new': ['Cmd+Shift+Y'], 'nav.back': [], 'tab.reopenClosed': [] })
    const groups = sheetGroups('darwin', { lastTabOnCmd9: false })
    expect(keysOf(groups, 'New Tab or Search')).toBe('⇧⌘Y')
    expect(keysOf(groups, 'Back / Forward')).toBe('— / ⌘]')
    expect(keysOf(groups, 'Reopen Closed Tab')).toBe('')
    // ⌘9 is named after what it does (TB-04).
    expect(keysOf(groups, 'Go to Tab 9')).toBe('⌘9')
  })
})
