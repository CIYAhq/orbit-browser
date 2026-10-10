import { describe, expect, it, vi } from 'vitest'
import { frontendKeys } from '../../src/main/devtools/control'
import { type FrontendKeys, keyHandler } from '../../src/main/devtools/frontend'
import { actionForInput, type KeyInput } from '../../src/shared/actions'

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

describe('DevTools keys', () => {
  it('[DT-01][KS-13] open, console and picker keys per platform', () => {
    expect(mac(press('F12', 'F12'))).toBe('devtools.toggle')
    expect(linux(press('F12', 'F12'))).toBe('devtools.toggle')
    // macOS Option combos type other characters; the physical key counts.
    expect(mac(press('ˆ', 'KeyI', { meta: true, alt: true }))).toBe('devtools.toggle')
    expect(linux(press('I', 'KeyI', { control: true, shift: true }))).toBe('devtools.toggle')
    expect(mac(press('∆', 'KeyJ', { meta: true, alt: true }))).toBe('devtools.console')
    expect(linux(press('J', 'KeyJ', { control: true, shift: true }))).toBe('devtools.console')
    expect(mac(press('ç', 'KeyC', { meta: true, alt: true }))).toBe('devtools.inspect')
  })

  it('[DT-02] ⇧⌘C (Ctrl+Shift+C) stays Copy URL; the picker has no Windows/Linux key', () => {
    expect(mac(press('C', 'KeyC', { meta: true, shift: true }))).toBe('tab.copyUrl')
    expect(linux(press('C', 'KeyC', { control: true, shift: true }))).toBe('tab.copyUrl')
    expect(frontendKeys('linux').inspect).toEqual([])
  })

  it('[DT-01] the keys DevTools pages listen for follow the keymap', () => {
    const none = { cmd: false, ctrl: false, alt: false, shift: false }
    expect(frontendKeys('darwin')).toEqual({
      toggle: [
        { ...none, cmd: true, alt: true, key: 'I' },
        { ...none, key: 'F12' },
      ],
      console: [{ ...none, cmd: true, alt: true, key: 'J' }],
      inspect: [{ ...none, cmd: true, alt: true, key: 'C' }],
    })
    expect(frontendKeys('linux')).toEqual({
      toggle: [
        { ...none, ctrl: true, shift: true, key: 'I' },
        { ...none, key: 'F12' },
      ],
      console: [{ ...none, ctrl: true, shift: true, key: 'J' }],
      inspect: [],
    })
  })
})

/** A DevTools page, faked: its window's key listeners and the engine's embedder API. */
function fakeDevtools() {
  const listeners: ((e: unknown) => void)[] = []
  const window: Record<string, unknown> = {
    addEventListener: (type: string, listener: (e: unknown) => void, capture: boolean) => {
      expect([type, capture]).toEqual(['keydown', true])
      listeners.push(listener)
    },
  }
  const host = { closeWindow: vi.fn() }
  const api = { showPanel: vi.fn(), enterInspectElementMode: vi.fn() }
  const install = (keys: FrontendKeys) =>
    new Function('window', 'InspectorFrontendHost', 'DevToolsAPI', keyHandler(keys))(window, host, api)
  /** Sends a keydown; true when the page's own handling was stopped. */
  const keydown = (
    key: string,
    code: string,
    mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean; repeat?: boolean } = {},
  ) => {
    let stopped = false
    const event = {
      key,
      code,
      metaKey: !!mods.meta,
      ctrlKey: !!mods.ctrl,
      altKey: !!mods.alt,
      shiftKey: !!mods.shift,
      repeat: !!mods.repeat,
      preventDefault: () => {
        stopped = true
      },
      stopImmediatePropagation: () => {},
    }
    for (const listener of listeners) listener(event)
    return stopped
  }
  return { listeners, host, api, install, keydown }
}

describe('DevTools page keys', () => {
  it('[DT-01] the open key closes DevTools once, however long it is held', () => {
    const page = fakeDevtools()
    page.install(frontendKeys('linux'))
    expect(page.keydown('F12', 'F12')).toBe(true)
    expect(page.host.closeWindow).toHaveBeenCalledTimes(1)
    expect(page.keydown('F12', 'F12', { repeat: true })).toBe(true)
    expect(page.keydown('I', 'KeyI', { ctrl: true, shift: true, repeat: true })).toBe(true)
    expect(page.host.closeWindow).toHaveBeenCalledTimes(1)
  })

  it('[DT-01] macOS Option keys match by their physical key; the console key shows the Console', () => {
    const page = fakeDevtools()
    page.install(frontendKeys('darwin'))
    expect(page.keydown('Dead', 'KeyI', { meta: true, alt: true })).toBe(true)
    expect(page.host.closeWindow).toHaveBeenCalledTimes(1)
    expect(page.keydown('∆', 'KeyJ', { meta: true, alt: true })).toBe(true)
    expect(page.api.showPanel).toHaveBeenCalledWith('console')
    expect(page.keydown('ç', 'KeyC', { meta: true, alt: true })).toBe(true)
    expect(page.api.enterInspectElementMode).toHaveBeenCalledTimes(1)
  })

  it("[DT-02] every other key is DevTools' own, ⇧⌘C included", () => {
    const page = fakeDevtools()
    page.install(frontendKeys('darwin'))
    expect(page.keydown('C', 'KeyC', { meta: true, shift: true })).toBe(false)
    expect(page.keydown('M', 'KeyM', { meta: true, shift: true })).toBe(false)
    // Exact modifiers: ⇧F12 and ⌥⌘⇧I are not the open key.
    expect(page.keydown('F12', 'F12', { shift: true })).toBe(false)
    expect(page.keydown('I', 'KeyI', { meta: true, alt: true, shift: true })).toBe(false)
    expect(page.host.closeWindow).not.toHaveBeenCalled()
    expect(page.api.enterInspectElementMode).not.toHaveBeenCalled()
  })

  it('[DT-01] installing again only updates the keys', () => {
    const page = fakeDevtools()
    page.install(frontendKeys('linux'))
    page.install({ toggle: [], console: [], inspect: [] })
    expect(page.listeners).toHaveLength(1)
    expect(page.keydown('F12', 'F12')).toBe(false)
  })
})
