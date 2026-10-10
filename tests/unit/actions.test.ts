import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ActionRegistry } from '../../src/main/registry'
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

  // Review M7: shortcuts used the physical key for letters, so other layouts ran the wrong actions.
  const press = (key: string, code: string, mods: Partial<KeyInput> = {}): KeyInput => ({
    key,
    code,
    meta: false,
    control: false,
    alt: false,
    shift: false,
    ...mods,
  })
  const mac = (input: KeyInput) => actionForInput(input, 'darwin')?.id
  const linux = (input: KeyInput) => actionForInput(input, 'linux')?.id

  it('follows AZERTY letters and keeps its digit row working', () => {
    // Cmd+Z (undo) sits on the physical W key: it must not close the tab.
    expect(keyName({ key: 'z', code: 'KeyW' })).toBe('Z')
    expect(mac(press('z', 'KeyW', { meta: true }))).not.toBe('tab.close')
    expect(mac(press('w', 'KeyZ', { meta: true }))).toBe('tab.close')
    expect(linux(press('a', 'KeyQ', { control: true }))).toBe(linux(press('a', 'KeyA', { control: true })))
    // The unshifted digit row types symbols; Cmd+1 is still the first tab.
    expect(mac(press('&', 'Digit1', { meta: true }))).toBe('tab.goto.1')
    expect(mac(press('é', 'Digit2', { meta: true }))).toBe('tab.goto.2')
  })

  it('follows QWERTZ letters and symbols', () => {
    expect(keyName({ key: 'z', code: 'KeyY' })).toBe('Z')
    expect(keyName({ key: 'y', code: 'KeyZ' })).toBe('Y')
    expect(linux(press('t', 'KeyT', { control: true }))).toBe('tab.new')
    // "-" sits on the physical Slash key and "+" on BracketRight.
    expect(linux(press('-', 'Slash', { control: true }))).toBe('page.zoomOut')
    expect(linux(press('+', 'BracketRight', { control: true }))).toBe('page.zoomIn')
  })

  it('follows Dvorak letters and symbols (the review table)', () => {
    expect(mac(press('v', 'Period', { meta: true }))).not.toBe('nav.stop')
    expect(mac(press('w', 'Comma', { meta: true }))).toBe('tab.close')
    expect(mac(press('l', 'KeyP', { meta: true }))).toBe('url.edit')
    expect(mac(press('p', 'KeyR', { meta: true }))).toBe('page.print')
    // Symbols on letter keys: "," (settings) is the physical W key and must not close the tab.
    expect(mac(press(',', 'KeyW', { meta: true }))).toBe('app.settings')
    expect(mac(press('.', 'KeyE', { meta: true }))).toBe('nav.stop')
  })

  it('falls back to the physical key for non-Latin layouts and Option combos', () => {
    // Russian ЙЦУКЕН: Ctrl+T types "е" and Cmd+W types "ц".
    expect(linux(press('е', 'KeyT', { control: true }))).toBe('tab.new')
    expect(mac(press('ц', 'KeyW', { meta: true }))).toBe('tab.close')
    expect(mac(press('Т', 'KeyN', { meta: true, shift: true }))).toBe(
      mac(press('N', 'KeyN', { meta: true, shift: true })),
    )
    // macOS Option changes the character: Cmd+Option+Down and Option symbols still match.
    expect(mac(press('ArrowDown', 'ArrowDown', { meta: true, alt: true }))).toBe('tab.next')
    expect(keyName({ key: '√', code: 'KeyV' })).toBe('V')
    expect(keyName({ key: '–', code: 'Minus' })).toBe('-')
  })

  it('matches shifted symbols to their key', () => {
    expect(mac(press('+', 'Equal', { meta: true, shift: true }))).toBe('page.zoomIn')
    expect(mac(press('=', 'Equal', { meta: true }))).toBe('page.zoomIn')
    expect(keyName({ key: '_', code: 'Minus' })).toBe('-')
    expect(keyName({ key: ' ', code: 'Space' })).toBe('Space')
    expect(keyName({ key: 'Enter', code: 'NumpadEnter' })).toBe('Enter')
    expect(keyName({ key: '3', code: 'Numpad3' })).toBe('3')
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

describe('action handlers', () => {
  it('registers each action once: a later handler would silently replace the first (review A-F7)', () => {
    const counts = new Map<string, number>()
    const main = join(__dirname, '../../src/main')
    for (const file of readdirSync(main, { recursive: true, encoding: 'utf8' })) {
      if (!file.endsWith('.ts')) continue
      for (const [, id] of readFileSync(join(main, file), 'utf8').matchAll(/actions\.register\(\s*'([^']+)'/g)) {
        counts.set(id as string, (counts.get(id as string) ?? 0) + 1)
      }
    }
    expect(counts.size).toBeGreaterThan(50)
    expect([...counts].filter(([, n]) => n > 1).map(([id]) => id)).toEqual([])
  })

  it('refuses a second handler for an action, whatever made its id, so any start of Orbit finds it (round 2 fix check F5)', () => {
    const actions = new ActionRegistry()
    const first = vi.fn()
    actions.register('tab.goto.1', first)
    const n = 1
    expect(() => actions.register(`tab.goto.${n}`, () => {})).toThrow('Action already registered: tab.goto.1')
    void actions.run('tab.goto.1', {})
    expect(first).toHaveBeenCalledTimes(1)
    actions.register('tab.goto.2', () => {})
    expect(actions.has('tab.goto.2')).toBe(true)
  })
})
