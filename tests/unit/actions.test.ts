import { describe, expect, it } from 'vitest'
import {
  ACTIONS,
  actionForInput,
  formatAccelerator,
  type KeyInput,
  keyName,
  matchesAccelerator,
  shortcutsFor,
} from '../../src/shared/actions'

const key = (code: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  key: code.replace(/^Key|^Digit/, '').toLowerCase(),
  code,
  meta: false,
  control: false,
  alt: false,
  shift: false,
  ...mods,
})

describe('keymap', () => {
  it('names physical keys independent of modifiers', () => {
    expect(keyName({ code: 'KeyT', key: '†' })).toBe('T')
    expect(keyName({ code: 'Digit1', key: '¡' })).toBe('1')
    expect(keyName({ code: 'BracketLeft', key: '“' })).toBe('[')
    expect(keyName({ code: 'ArrowLeft', key: 'ArrowLeft' })).toBe('Left')
  })

  it('matches accelerators exactly', () => {
    expect(matchesAccelerator(key('KeyT', { meta: true }), 'Cmd+T')).toBe(true)
    expect(matchesAccelerator(key('KeyT', { meta: true, shift: true }), 'Cmd+T')).toBe(false)
    expect(matchesAccelerator(key('KeyT', { meta: true, shift: true }), 'Cmd+Shift+T')).toBe(true)
  })

  it('resolves platform-specific actions', () => {
    expect(actionForInput(key('KeyT', { meta: true }), 'darwin')?.id).toBe('tab.new')
    expect(actionForInput(key('KeyT', { control: true }), 'linux')?.id).toBe('tab.new')
    expect(actionForInput(key('KeyT', { control: true }), 'darwin')).toBeUndefined()
    expect(actionForInput(key('Digit2', { control: true }), 'darwin')?.id).toBe('space.goto.2')
    expect(actionForInput(key('Digit2', { meta: true }), 'darwin')?.id).toBe('tab.goto.2')
    expect(actionForInput(key('KeyS', { meta: true }), 'darwin')?.id).toBe('sidebar.toggle')
  })

  it('has no duplicate shortcuts per platform', () => {
    for (const platform of ['darwin', 'linux']) {
      const seen = new Map<string, string>()
      for (const action of ACTIONS) {
        for (const accel of shortcutsFor(action, platform)) {
          const norm = accel.toLowerCase()
          expect(seen.get(norm), `${accel} used by ${seen.get(norm)} and ${action.id} on ${platform}`).toBeUndefined()
          seen.set(norm, action.id)
        }
      }
    }
  })

  it('formats shortcuts for display', () => {
    expect(formatAccelerator('Cmd+Shift+T', 'darwin')).toBe('⇧⌘T')
    expect(formatAccelerator('Ctrl+Shift+T', 'linux')).toBe('Ctrl+Shift+T')
  })
})
