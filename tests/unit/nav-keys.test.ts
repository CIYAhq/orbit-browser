import { describe, expect, it } from 'vitest'
import {
  ACTIONS_BY_ID,
  actionForInput,
  type KeyInput,
  outsideTextActionFor,
  shortcutsFor,
} from '../../src/shared/actions'

const key = (code: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  key: code.replace(/^Key|^Digit|^Arrow/, ''),
  code,
  meta: false,
  control: false,
  alt: false,
  shift: false,
  ...mods,
})

describe('navigation keys (KS-08, NV-01, NV-03)', () => {
  it('binds Back and Forward on each platform', () => {
    expect(actionForInput(key('BracketLeft', { meta: true }), 'darwin')?.id).toBe('nav.back')
    expect(actionForInput(key('BracketRight', { meta: true }), 'darwin')?.id).toBe('nav.forward')
    expect(actionForInput(key('ArrowLeft', { alt: true }), 'linux')?.id).toBe('nav.back')
    expect(actionForInput(key('ArrowRight', { alt: true }), 'win32')?.id).toBe('nav.forward')
  })

  it('binds Reload and hard reload, including the function keys off macOS', () => {
    expect(actionForInput(key('KeyR', { meta: true }), 'darwin')?.id).toBe('nav.reload')
    expect(actionForInput(key('KeyR', { meta: true, shift: true }), 'darwin')?.id).toBe('nav.hardReload')
    expect(actionForInput(key('KeyR', { control: true }), 'linux')?.id).toBe('nav.reload')
    expect(actionForInput(key('F5'), 'linux')?.id).toBe('nav.reload')
    expect(actionForInput(key('F5', { shift: true }), 'linux')?.id).toBe('nav.hardReload')
    expect(actionForInput(key('F5', { control: true }), 'win32')?.id).toBe('nav.hardReload')
    expect(actionForInput(key('KeyR', { control: true, shift: true }), 'win32')?.id).toBe('nav.hardReload')
  })

  it('leaves Backspace alone: it never navigates', () => {
    expect(actionForInput(key('Backspace'), 'linux')).toBeUndefined()
    expect(actionForInput(key('Backspace'), 'darwin')).toBeUndefined()
    expect(outsideTextActionFor(key('Backspace'), 'darwin')).toBeUndefined()
  })

  it('maps ⌘← and ⌘→ to Back and Forward on macOS outside text fields only', () => {
    // Inside a field these keys move the caret, so the global keymap never claims them.
    expect(actionForInput(key('ArrowLeft', { meta: true }), 'darwin')).toBeUndefined()
    expect(actionForInput(key('ArrowRight', { meta: true }), 'darwin')).toBeUndefined()
    expect(outsideTextActionFor(key('ArrowLeft', { meta: true }), 'darwin')?.id).toBe('nav.back')
    expect(outsideTextActionFor(key('ArrowRight', { meta: true }), 'darwin')?.id).toBe('nav.forward')
    expect(outsideTextActionFor(key('ArrowLeft', { meta: true, shift: true }), 'darwin')).toBeUndefined()
    expect(outsideTextActionFor(key('ArrowLeft', { control: true }), 'linux')).toBeUndefined()
  })

  it('names the shortcuts the tooltips show', () => {
    const back = ACTIONS_BY_ID['nav.back']
    const hard = ACTIONS_BY_ID['nav.hardReload']
    if (!back || !hard) throw new Error('missing actions')
    expect(shortcutsFor(back, 'darwin')[0]).toBe('Cmd+[')
    expect(shortcutsFor(back, 'linux')[0]).toBe('Alt+Left')
    expect(shortcutsFor(hard, 'linux')).toContain('Shift+F5')
  })
})

describe('stop keys (NV-04)', () => {
  it('binds ⌘. on macOS only; Esc is handled by the page hook', () => {
    expect(actionForInput(key('Period', { key: '.', meta: true }), 'darwin')?.id).toBe('nav.stop')
    expect(actionForInput(key('Period', { key: '.', control: true }), 'linux')).toBeUndefined()
    expect(actionForInput(key('Escape', { key: 'Escape' }), 'linux')?.id).not.toBe('nav.stop')
  })
})
