import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ Menu: {}, screen: {}, webContents: {} }))

import { menuEntries } from '../../src/main/tabs/row-menu'
import { isSeparator, type RowMenuEntry, rowMenuItemAt, rowMenuLabels, typeAheadIndex } from '../../src/shared/row-menu'

/** The sidebar's row menus in Orbit's overlay (TB-14): what main sends the overlay, and type-ahead. */

const click = () => {}

const template: MenuItemConstructorOptions[] = [
  { type: 'separator' },
  { label: 'Pin Tab', accelerator: 'Command+Shift+P', click },
  { label: 'Hidden', visible: false, click },
  { type: 'separator' },
  { type: 'separator' },
  { label: 'Rename…', click },
  { label: 'Muted', type: 'checkbox', checked: true, click },
  {
    label: 'Move to',
    submenu: [
      { label: 'Favorites', click },
      { type: 'separator' },
      { label: 'Work', submenu: [{ label: 'Pinned', click }] },
    ],
  },
  { label: 'Nowhere', submenu: [{ label: 'Off', enabled: false, click }] },
  { label: 'Close Tab', enabled: false, accelerator: 'Control+W', click },
  { type: 'separator' },
]

const shape = (entries: RowMenuEntry[]): unknown[] =>
  entries.map((e) => (isSeparator(e) ? '---' : e.submenu ? { [e.label]: shape(e.submenu) } : e.label))

describe('row menu model (TB-14)', () => {
  it('[TB-14] keeps separators only between items, leaves hidden items out and numbers items by their place in the template', () => {
    const entries = menuEntries(template, 'linux')
    expect(shape(entries)).toEqual([
      'Pin Tab',
      '---',
      'Rename…',
      'Muted',
      { 'Move to': ['Favorites', '---', { Work: ['Pinned'] }] },
      { Nowhere: ['Off'] },
      'Close Tab',
    ])
    expect(rowMenuItemAt(entries, 'Move to > Work > Pinned')?.id).toBe('7.2.0')
    expect(rowMenuItemAt(entries, 'Rename…')?.id).toBe('5')
    expect(rowMenuLabels(entries)).toContain('Move to > Work')
  })

  it('[TB-14][KS-18] shows each key as the platform writes it; a submenu with nothing to choose is disabled; ticks carry over', () => {
    // The keymap writes Pin's key for the platform it runs on (menu-hints.ts).
    const pinKey = (accelerator: string) =>
      template.map((item) => (item.label === 'Pin Tab' ? { ...item, accelerator } : item))
    const mac = menuEntries(pinKey('Command+Shift+P'), 'darwin')
    const linux = menuEntries(pinKey('Control+Shift+P'), 'linux')
    expect(rowMenuItemAt(mac, 'Pin Tab')?.hint).toBe('⇧⌘P')
    expect(rowMenuItemAt(linux, 'Pin Tab')?.hint).toBe('Ctrl+Shift+P')
    expect(rowMenuItemAt(linux, 'Close Tab')).toMatchObject({ enabled: false, hint: 'Ctrl+W' })
    expect(rowMenuItemAt(linux, 'Nowhere')?.enabled).toBe(false)
    expect(rowMenuItemAt(linux, 'Move to')?.enabled).toBe(true)
    expect(rowMenuItemAt(linux, 'Muted')?.checked).toBe(true)
    expect(rowMenuItemAt(linux, 'Rename…')?.checked).toBeUndefined()
  })
})

describe('type-ahead (TB-14)', () => {
  const items = ['Copy Link', 'Copy Link as Markdown', 'Close Tab', 'Duplicate', 'Change Icon…', 'Mute Tab'].map(
    (label) => ({ label, enabled: label !== 'Change Icon…' }),
  )

  it('[TB-14] a letter goes to the next enabled item it starts, round the end; typed again, to the one after', () => {
    expect(typeAheadIndex(items, 'c', -1)).toBe(0)
    expect(typeAheadIndex(items, 'c', 0)).toBe(1)
    expect(typeAheadIndex(items, 'cc', 1)).toBe(2)
    // Change Icon… is disabled: round to the first again.
    expect(typeAheadIndex(items, 'ccc', 2)).toBe(0)
    expect(typeAheadIndex(items, 'D', 5)).toBe(3)
    expect(typeAheadIndex(items, 'x', 0)).toBe(-1)
  })

  it('[TB-14] a longer prefix keeps the focused item while it still matches', () => {
    expect(typeAheadIndex(items, 'co', 0)).toBe(0)
    expect(typeAheadIndex(items, 'cl', 0)).toBe(2)
    expect(typeAheadIndex(items, 'copy link as', 0)).toBe(1)
  })
})
