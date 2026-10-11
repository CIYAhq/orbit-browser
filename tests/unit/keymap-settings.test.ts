import { afterEach, describe, expect, it } from 'vitest'
import {
  CATEGORY_ORDER,
  clashesOf,
  entryMatches,
  formatModifiers,
  searchWords,
  shortcutEntry,
  shortcutGroups,
} from '../../src/renderer/src/keys/shortcut-list'
import { ACTIONS, ACTIONS_BY_ID } from '../../src/shared/actions'
import { setCustomBindings } from '../../src/shared/keymap'

/** What Settings → Shortcuts lists and how its search filters it (ST-08). */

afterEach(() => setCustomBindings(undefined))

const entry = (id: string, platform: string, options = { lastTabOnCmd9: true }) => {
  const action = ACTIONS_BY_ID[id]
  if (!action) throw new Error(`no action ${id}`)
  return shortcutEntry(action, platform, options)
}

describe('[ST-08] the list of shortcuts', () => {
  it('lists every action once, in its group, groups in a fixed order', () => {
    const groups = shortcutGroups('linux', { lastTabOnCmd9: true })
    expect(groups.map((g) => g.category)).toEqual(CATEGORY_ORDER.filter((c) => groups.some((g) => g.category === c)))
    const ids = groups.flatMap((g) => g.entries.map((e) => e.action.id))
    expect(ids).toHaveLength(ACTIONS.length)
    expect(new Set(ids).size).toBe(ACTIONS.length)
  })

  it('shows each action with its keys now and says when they or its priority differ from the defaults', () => {
    expect(entry('sidebar.toggle', 'darwin')).toMatchObject({
      title: 'Toggle Sidebar',
      bindings: ['Cmd+S'],
      // ⌘S prefers Orbit on macOS (D60); Ctrl+S websites elsewhere.
      priority: 'orbit',
      isDefault: true,
    })
    expect(entry('sidebar.toggle', 'linux')).toMatchObject({
      bindings: ['Ctrl+S'],
      priority: 'websites',
      isDefault: true,
    })
    setCustomBindings({ 'sidebar.toggle': ['Cmd+Shift+B'] })
    expect(entry('sidebar.toggle', 'darwin')).toMatchObject({ bindings: ['Cmd+Shift+B'], isDefault: false })
    setCustomBindings(undefined)
    const action = ACTIONS_BY_ID['sidebar.toggle']
    if (!action) throw new Error('no action')
    const chosen = shortcutEntry(action, 'linux', { lastTabOnCmd9: true, priorities: { 'sidebar.toggle': 'orbit' } })
    expect(chosen).toMatchObject({ bindings: ['Ctrl+S'], priority: 'orbit', isDefault: false })
  })

  it('names ⌘9 after what it does', () => {
    expect(entry('tab.goto.9', 'darwin').title).toBe('Go to Last Tab')
    expect(entry('tab.goto.9', 'darwin', { lastTabOnCmd9: false }).title).toBe('Go to Tab 9')
  })
})

describe('[ST-08] search', () => {
  it('finds an action by every word typed: its name, search words or keys as this platform shows them', () => {
    const sidebar = entry('sidebar.toggle', 'darwin')
    expect(entryMatches(sidebar, searchWords('Sidebar tog'), 'darwin')).toBe(true)
    expect(entryMatches(sidebar, searchWords('⌘S'), 'darwin')).toBe(true)
    expect(entryMatches(sidebar, searchWords('sidebar exit'), 'darwin')).toBe(false)
    const linux = entry('sidebar.toggle', 'linux')
    expect(entryMatches(linux, searchWords('ctrl+s'), 'linux')).toBe(true)
    expect(entryMatches(entry('tab.toggleMute', 'linux'), searchWords('audio'), 'linux')).toBe(true)
    expect(entryMatches(linux, [], 'linux')).toBe(true)
  })
})

describe('[ST-08] recording and system keys', () => {
  it('shows the modifiers held as this platform writes them', () => {
    expect(formatModifiers('Cmd+Shift', 'darwin')).toBe('⇧⌘')
    expect(formatModifiers('Ctrl+Alt+Shift+Cmd', 'darwin')).toBe('⌃⌥⇧⌘')
    expect(formatModifiers('Ctrl+Shift', 'linux')).toBe('Ctrl+Shift+')
    expect(formatModifiers('', 'linux')).toBe('')
  })

  it('marks the keys of an action that the system keeps (KS-03)', () => {
    const space = entry('space.goto.1', 'darwin')
    const clash = { accel: 'Ctrl+1', owner: 'Mission Control: Switch to Desktop 1' }
    expect(clashesOf(space, [clash, { accel: 'Ctrl+2', owner: 'Mission Control: Switch to Desktop 2' }])).toEqual([
      clash,
    ])
    expect(clashesOf(space, undefined)).toEqual([])
  })
})
