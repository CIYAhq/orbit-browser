import { afterEach, describe, expect, it } from 'vitest'
import { type KeyInput, sidebarUndoFor, sidebarUndoLabel } from '../../src/shared/actions'
import { setCustomBindings } from '../../src/shared/keymap'

/** Sidebar undo and redo are in the keymap, so Settings → Shortcuts can change them (KS-05). */

afterEach(() => setCustomBindings(undefined))

const press = (key: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  key,
  code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key,
  meta: false,
  control: false,
  alt: false,
  shift: false,
  ...mods,
})

describe('sidebar undo’s keys (KS-05, TB-18)', () => {
  it('[KS-05][TB-18][KS-16] ⌘Z and ⌘⇧Z by default (Ctrl elsewhere), each only outside text fields', () => {
    expect(sidebarUndoFor(press('z', { meta: true }), 'darwin')).toEqual({ redo: false, outsideText: true })
    expect(sidebarUndoFor(press('Z', { meta: true, shift: true }), 'darwin')).toEqual({ redo: true, outsideText: true })
    expect(sidebarUndoFor(press('z', { control: true }), 'linux')).toEqual({ redo: false, outsideText: true })
    expect(sidebarUndoFor(press('Z', { control: true, shift: true }), 'win32')).toEqual({
      redo: true,
      outsideText: true,
    })
    // Not the other platform's modifier, nor with Alt.
    expect(sidebarUndoFor(press('z', { control: true }), 'darwin')).toBeUndefined()
    expect(sidebarUndoFor(press('z', { meta: true, alt: true }), 'darwin')).toBeUndefined()
    expect(sidebarUndoFor(press('t', { meta: true }), 'darwin')).toBeUndefined()
    expect(sidebarUndoLabel('darwin')).toBe('⌘Z')
    expect(sidebarUndoLabel('linux')).toBe('Ctrl+Z')
  })

  it('[KS-05][KS-18] a remap moves them: the new key acts everywhere when it edits no text, the old one is no sidebar undo', () => {
    setCustomBindings({ 'tab.undo': ['F7'], 'tab.redo': ['Cmd+Alt+Y'] })
    expect(sidebarUndoFor(press('F7'), 'darwin')).toEqual({ redo: false, outsideText: false })
    expect(sidebarUndoFor(press('y', { meta: true, alt: true }), 'darwin')).toEqual({ redo: true, outsideText: false })
    expect(sidebarUndoFor(press('z', { meta: true }), 'darwin')).toBeUndefined()
    expect(sidebarUndoFor(press('Z', { meta: true, shift: true }), 'darwin')).toBeUndefined()
    // Notes that say how to undo name the key as it is now; none when it has none.
    expect(sidebarUndoLabel('darwin')).toBe('F7')
    setCustomBindings({ 'tab.undo': [] })
    expect(sidebarUndoLabel('darwin')).toBe('')
    expect(sidebarUndoFor(press('z', { meta: true }), 'darwin')).toBeUndefined()
  })
})
