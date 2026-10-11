import { describe, expect, it } from 'vitest'
import { actionForInput, outsideTextActionFor } from '../../src/shared/actions'
import {
  acceleratorFromInput,
  bindingProblem,
  canonicalAccelerator,
  editsText,
  formatAccelerator,
  type KeyInput,
  typedWithAltGr,
} from '../../src/shared/keymap'

const press = (key: string, code: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  key,
  code,
  meta: false,
  control: false,
  alt: false,
  shift: false,
  ...mods,
})

describe('[KS-01] bindings have one written form', () => {
  it('orders modifiers and names keys one way', () => {
    expect(canonicalAccelerator('Shift+Cmd+t')).toBe('Cmd+Shift+T')
    expect(canonicalAccelerator('control+option+shift+n')).toBe('Ctrl+Alt+Shift+N')
    expect(canonicalAccelerator('Command+Meta+K')).toBeUndefined()
    expect(canonicalAccelerator('Cmd++')).toBe('Cmd+=')
    expect(canonicalAccelerator('Cmd+Shift+=')).toBe('Cmd+Shift+=')
    expect(canonicalAccelerator('Ctrl+Shift+{')).toBe('Ctrl+Shift+[')
    expect(canonicalAccelerator('alt+left')).toBe('Alt+Left')
    expect(canonicalAccelerator('Cmd+esc')).toBe('Cmd+Escape')
    expect(canonicalAccelerator('f5')).toBe('F5')
    expect(canonicalAccelerator('Shift+F24')).toBe('Shift+F24')
  })

  it('refuses what is not a binding', () => {
    for (const bad of ['', 'Cmd+', 'Hyper+A', 'Cmd+Cmd+A', 'Cmd+Ö', 'Cmd+F25', 'Cmd+MediaPlayPause', 'Cmd+Shift']) {
      expect(canonicalAccelerator(bad), bad).toBeUndefined()
    }
  })

  it('reads a key press as the binding it makes, and nothing for a lone modifier', () => {
    expect(acceleratorFromInput(press('b', 'KeyB', { meta: true, shift: true }))).toBe('Cmd+Shift+B')
    expect(acceleratorFromInput(press('B', 'KeyB', { control: true, shift: true }))).toBe('Ctrl+Shift+B')
    expect(acceleratorFromInput(press('+', 'Equal', { meta: true, shift: true }))).toBe('Cmd+Shift+=')
    expect(acceleratorFromInput(press('F7', 'F7'))).toBe('F7')
    expect(acceleratorFromInput(press('Shift', 'ShiftLeft', { shift: true }))).toBeUndefined()
    expect(acceleratorFromInput(press('Meta', 'MetaLeft', { meta: true }))).toBeUndefined()
  })
})

describe('[KS-01] what a new binding must be', () => {
  it('needs a modifier, except F1–F12 on their own', () => {
    expect(bindingProblem('B', 'darwin')).toBe('A shortcut starts with ⇧, ⌃, ⌥ or ⌘ (F1–F12 can be used on their own).')
    expect(bindingProblem('Enter', 'linux')).toBe(
      'A shortcut starts with Shift, Ctrl or Alt (F1–F12 can be used on their own).',
    )
    expect(bindingProblem('F7', 'darwin')).toBeUndefined()
    expect(bindingProblem('F12', 'linux')).toBeUndefined()
    expect(bindingProblem('F13', 'linux')).toBeDefined()
    expect(bindingProblem('Shift+F13', 'linux')).toBeUndefined()
    expect(bindingProblem('Shift+B', 'darwin')).toBeUndefined()
    expect(bindingProblem('Cmd+Shift+B', 'darwin')).toBeUndefined()
  })

  it('keeps the system’s own keys', () => {
    expect(bindingProblem('Cmd+Q', 'darwin')).toBe('⌘Q is kept for Quit Orbit.')
    expect(bindingProblem('Cmd+M', 'darwin')).toBe('⌘M is kept for Minimize.')
    expect(bindingProblem('Cmd+Q', 'linux')).toBeUndefined()
    expect(bindingProblem('Alt+F4', 'win32')).toBe('Alt+F4 is kept for closing the window.')
    expect(bindingProblem('Alt+F', 'linux')).toBe('Alt+F is kept for the app menu.')
  })

  it('says when Orbit cannot use the key at all', () => {
    expect(bindingProblem('Cmd+Ö', 'darwin')).toBe("Orbit can't use that key for a shortcut.")
  })

  it('shows bindings as each platform writes them', () => {
    expect(formatAccelerator('Cmd+Shift+B', 'darwin')).toBe('⇧⌘B')
    expect(formatAccelerator('Cmd+Shift+Backspace', 'darwin')).toBe('⇧⌘⌫')
    expect(formatAccelerator('Ctrl+Shift+Delete', 'linux')).toBe('Ctrl+Shift+Delete')
    expect(formatAccelerator('Ctrl+PageDown', 'linux')).toBe('Ctrl+PageDown')
  })
})

describe('[KS-16] keys that edit text act only outside text fields', () => {
  it('knows the caret, selection, clipboard and undo keys of each platform', () => {
    for (const accel of ['Cmd+Left', 'Cmd+Shift+Right', 'Alt+Left', 'Cmd+Z', 'Cmd+Shift+Z', 'Cmd+A', 'Cmd+V']) {
      expect(editsText(accel, 'darwin'), accel).toBe(true)
    }
    for (const accel of ['Ctrl+Left', 'Ctrl+Shift+Right', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+Backspace', 'Shift+Insert']) {
      expect(editsText(accel, 'linux'), accel).toBe(true)
    }
    // Back and forward, tab and Space switching, clearing data: they edit nothing.
    for (const accel of ['Cmd+[', 'Cmd+Alt+Left', 'Cmd+Alt+Down', 'Cmd+Shift+Backspace', 'Ctrl+Tab', 'F5']) {
      expect(editsText(accel, 'darwin'), accel).toBe(false)
    }
    for (const accel of ['Alt+Left', 'Ctrl+PageDown', 'Ctrl+Alt+Right', 'Ctrl+Shift+Delete', 'Alt+2']) {
      expect(editsText(accel, 'linux'), accel).toBe(false)
    }
  })

  it('counts a printable key with Shift, or macOS’s ⌥, as typing', () => {
    expect(editsText('Shift+K', 'darwin')).toBe(true)
    expect(editsText('Alt+K', 'darwin')).toBe(true)
    expect(editsText('Alt+K', 'linux')).toBe(false)
    expect(editsText('Shift+F3', 'linux')).toBe(false)
  })

  it('leaves keys to an input method while it composes, unless ⌘ or Ctrl is held', () => {
    expect(actionForInput(press('F5', 'F5', { isComposing: true }), 'linux')).toBeUndefined()
    expect(actionForInput(press('F5', 'F5'), 'linux')?.id).toBe('nav.reload')
    expect(actionForInput(press('t', 'KeyT', { control: true, isComposing: true }), 'linux')?.id).toBe('tab.new')
  })
})

describe('[KS-03] AltGr typing is not a Ctrl+Alt shortcut', () => {
  it('tells AltGr characters from the key’s own', () => {
    // Polish AltGr+N types ń; German AltGr+Q types @ and AltGr+7 types {.
    expect(typedWithAltGr(press('ń', 'KeyN', { control: true, alt: true }), 'win32')).toBe(true)
    expect(typedWithAltGr(press('@', 'KeyQ', { control: true, alt: true }), 'linux')).toBe(true)
    expect(typedWithAltGr(press('{', 'Digit7', { control: true, alt: true }), 'linux')).toBe(true)
    expect(typedWithAltGr(press('n', 'KeyN', { control: true, alt: true }), 'win32')).toBe(false)
    expect(typedWithAltGr(press('2', 'Digit2', { control: true, alt: true }), 'linux')).toBe(false)
    expect(typedWithAltGr(press('[', 'BracketLeft', { control: true, alt: true }), 'linux')).toBe(false)
    expect(typedWithAltGr(press('ArrowLeft', 'ArrowLeft', { control: true, alt: true }), 'linux')).toBe(false)
    expect(typedWithAltGr(press('ń', 'KeyN', { meta: true, alt: true }), 'darwin')).toBe(false)
  })

  it('runs a Ctrl+Alt action only outside text fields when the press typed a character', () => {
    const altGrN = press('ń', 'KeyN', { control: true, alt: true })
    expect(actionForInput(altGrN, 'win32')).toBeUndefined()
    expect(outsideTextActionFor(altGrN, 'win32')?.id).toBe('window.newMini')
    const plain = press('n', 'KeyN', { control: true, alt: true })
    expect(actionForInput(plain, 'win32')?.id).toBe('window.newMini')
    expect(outsideTextActionFor(plain, 'win32')).toBeUndefined()
  })
})
