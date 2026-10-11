import { afterEach, describe, expect, it, vi } from 'vitest'
import { frontendKeys } from '../../src/main/devtools/control'
import {
  bind,
  MAX_BINDINGS,
  normalizeKeySettings,
  normalizePriorities,
  normalizeShortcuts,
  reset,
  setPriority,
  unbind,
} from '../../src/main/keys/bindings'
import {
  ACTIONS,
  ACTIONS_BY_ID,
  type ActionDef,
  actionForAccelerator,
  actionForInput,
  buildKeymap,
  isFixed,
  priorityFor,
  shortcutsFor,
} from '../../src/shared/actions'
import { type KeyInput, keymapVersion, onKeymapChange, setCustomBindings } from '../../src/shared/keymap'
import type { Settings } from '../../src/shared/state'

const action = (id: string) => {
  const found = ACTIONS_BY_ID[id]
  if (!found) throw new Error(`no action ${id}`)
  return found
}
const cmdS = { key: 's', code: 'KeyS', meta: true, control: false, alt: false, shift: false }
const cmdShiftB = { key: 'b', code: 'KeyB', meta: true, control: false, alt: false, shift: true }

afterEach(() => setCustomBindings(undefined))

describe('[KS-01] one keymap with the user’s bindings', () => {
  it('uses the user’s list for an action they changed and the defaults elsewhere', () => {
    const keymap = buildKeymap({ 'sidebar.toggle': ['Cmd+Shift+B'] }, 'darwin')
    expect(keymap.lists.get('sidebar.toggle')).toEqual(['Cmd+Shift+B'])
    expect(keymap.direct.get('Cmd+Shift+B')?.id).toBe('sidebar.toggle')
    expect(keymap.direct.get('Cmd+S')).toBeUndefined()
    expect(keymap.lists.get('tab.new')).toEqual(['Cmd+T'])
  })

  it('gives a key the user took for another action to that action only', () => {
    const keymap = buildKeymap({ 'sidebar.toggle': ['Cmd+D'] }, 'darwin')
    expect(keymap.direct.get('Cmd+D')?.id).toBe('sidebar.toggle')
    expect(keymap.lists.get('tab.togglePin')).toEqual([])
  })

  it('never lets a binding take a fixed action’s key (⌘, stays Settings)', () => {
    const keymap = buildKeymap({ 'tab.new': ['Cmd+,'], 'tab.recent': ['Cmd+J'] }, 'darwin')
    expect(keymap.direct.get('Cmd+,')?.id).toBe('app.settings')
    expect(keymap.lists.get('tab.new')).toEqual([])
    // A fixed action keeps its own keys whatever is stored for it.
    expect(keymap.lists.get('tab.recent')).toEqual(['Ctrl+Tab'])
  })

  it('keeps an action with no bindings: the command bar and menus still reach it', () => {
    const keymap = buildKeymap({ 'sidebar.toggle': [] }, 'linux')
    expect(keymap.lists.get('sidebar.toggle')).toEqual([])
    expect(keymap.direct.get('Ctrl+S')).toBeUndefined()
  })

  it('puts a binding that types text with the keys that act only outside text fields (KS-16)', () => {
    const keymap = buildKeymap({ 'tab.new': ['Shift+K'] }, 'darwin')
    expect(keymap.outsideText.get('Shift+K')?.id).toBe('tab.new')
    expect(keymap.direct.get('Shift+K')).toBeUndefined()
    // ⌘← on macOS: Back, outside text fields only.
    expect(keymap.outsideText.get('Cmd+Left')?.id).toBe('nav.back')
  })

  it('follows the user’s bindings live, and tells listeners', () => {
    const heard = vi.fn()
    const off = onKeymapChange(heard)
    const before = keymapVersion()
    expect(actionForInput(cmdS, 'darwin')?.id).toBe('sidebar.toggle')
    setCustomBindings({ 'sidebar.toggle': ['Cmd+Shift+B'] })
    expect(keymapVersion()).toBe(before + 1)
    expect(heard).toHaveBeenCalledTimes(1)
    expect(actionForInput(cmdS, 'darwin')).toBeUndefined()
    expect(actionForInput(cmdShiftB, 'darwin')?.id).toBe('sidebar.toggle')
    expect(shortcutsFor(action('sidebar.toggle'), 'darwin')).toEqual(['Cmd+Shift+B'])
    expect(actionForAccelerator('Shift+Cmd+b', 'darwin')?.id).toBe('sidebar.toggle')
    // The same map again is no change.
    setCustomBindings({ 'sidebar.toggle': ['Cmd+Shift+B'] })
    expect(heard).toHaveBeenCalledTimes(2)
    const same = { 'sidebar.toggle': ['Cmd+Shift+B'] }
    setCustomBindings(same)
    setCustomBindings(same)
    expect(heard).toHaveBeenCalledTimes(3)
    off()
    setCustomBindings(undefined)
    expect(heard).toHaveBeenCalledTimes(3)
    expect(actionForInput(cmdS, 'darwin')?.id).toBe('sidebar.toggle')
  })
})

describe('[KS-01][ST-08] changing bindings', () => {
  it('replaces a binding, or adds another (aliases)', () => {
    const replaced = bind(undefined, { actionId: 'sidebar.toggle', accel: 'Cmd+Shift+B', replace: 'Cmd+S' }, 'darwin')
    expect(replaced.result).toEqual({ ok: true })
    expect(replaced.custom).toEqual({ 'sidebar.toggle': ['Cmd+Shift+B'] })
    const added = bind(undefined, { actionId: 'sidebar.toggle', accel: 'shift+cmd+b' }, 'darwin')
    expect(added.custom).toEqual({ 'sidebar.toggle': ['Cmd+S', 'Cmd+Shift+B'] })
  })

  it('drops an action’s entry when its bindings are the defaults again', () => {
    const { custom } = bind(
      { 'sidebar.toggle': ['Cmd+Shift+B'] },
      { actionId: 'sidebar.toggle', accel: 'Cmd+S', replace: 'Cmd+Shift+B' },
      'darwin',
    )
    expect(custom).toEqual({})
  })

  it('reports a conflict and changes nothing until asked to clear or swap', () => {
    const asked = bind(undefined, { actionId: 'sidebar.toggle', accel: 'Cmd+D', replace: 'Cmd+S' }, 'darwin')
    expect(asked.result).toEqual({ ok: false, conflict: { actionId: 'tab.togglePin', title: 'Pin / Unpin Tab' } })
    expect(asked.custom).toEqual({})

    const cleared = bind(
      undefined,
      { actionId: 'sidebar.toggle', accel: 'Cmd+D', replace: 'Cmd+S', onConflict: 'clear' },
      'darwin',
    )
    expect(cleared.result).toEqual({ ok: true })
    expect(cleared.custom).toEqual({ 'sidebar.toggle': ['Cmd+D'], 'tab.togglePin': [] })

    const swapped = bind(
      undefined,
      { actionId: 'sidebar.toggle', accel: 'Cmd+D', replace: 'Cmd+S', onConflict: 'swap' },
      'darwin',
    )
    expect(swapped.custom).toEqual({ 'sidebar.toggle': ['Cmd+D'], 'tab.togglePin': ['Cmd+S'] })
    const keymap = buildKeymap(swapped.custom, 'darwin')
    expect(keymap.direct.get('Cmd+S')?.id).toBe('tab.togglePin')
    expect(keymap.direct.get('Cmd+D')?.id).toBe('sidebar.toggle')
  })

  it('refuses bindings Orbit can’t use and keys a fixed action keeps', () => {
    expect(bind(undefined, { actionId: 'sidebar.toggle', accel: 'B' }, 'darwin').result).toEqual({
      ok: false,
      problem: 'A shortcut starts with ⇧, ⌃, ⌥ or ⌘ (F1–F12 can be used on their own).',
    })
    expect(bind(undefined, { actionId: 'sidebar.toggle', accel: 'Cmd+,' }, 'darwin').result).toEqual({
      ok: false,
      problem: '⌘, is kept for Settings.',
    })
    expect(bind(undefined, { actionId: 'app.settings', accel: 'Cmd+Shift+B' }, 'darwin').result).toEqual({
      ok: false,
      problem: 'Settings keeps its shortcut.',
    })
    expect(bind(undefined, { actionId: 'no.such', accel: 'Cmd+Shift+B' }, 'darwin').result).toMatchObject({
      ok: false,
    })
    expect(bind(undefined, { actionId: 'sidebar.toggle', accel: 'F7' }, 'linux').result).toEqual({ ok: true })
  })

  it('[D60] macOS refuses a plain ⌃-letter binding: text fields move the caret with them', () => {
    for (const accel of ['Ctrl+A', 'Ctrl+E', 'Ctrl+N', 'Ctrl+P', 'ctrl+k']) {
      expect(bind(undefined, { actionId: 'sidebar.toggle', accel }, 'darwin').result, accel).toEqual({
        ok: false,
        problem: `⌃${accel.slice(-1).toUpperCase()} is kept for text fields: on macOS, ⌃ with a letter moves the caret.`,
      })
    }
    // ⌃ with another modifier, a digit or an F key is a binding like any other (⌃7 is Space 7's, so
    // it asks first); so is Ctrl+letter elsewhere.
    for (const accel of ['Ctrl+Shift+N', 'Ctrl+Alt+N', 'Ctrl+Cmd+N', 'Ctrl+7', 'Ctrl+F7']) {
      const { result } = bind(undefined, { actionId: 'sidebar.toggle', accel }, 'darwin')
      expect('problem' in result ? result.problem : undefined, accel).toBeUndefined()
    }
    expect(bind(undefined, { actionId: 'sidebar.toggle', accel: 'Ctrl+K' }, 'linux').result).toEqual({ ok: true })
    // One stored before is dropped when the settings load.
    expect(normalizeShortcuts({ 'sidebar.toggle': ['Ctrl+N', 'Cmd+Shift+B'] }, 'darwin')).toEqual({
      'sidebar.toggle': ['Cmd+Shift+B'],
    })
  })

  it('[KS-15] F1 stays Help on Windows and Linux; on macOS Help has no keys and can be given some', () => {
    for (const platform of ['linux', 'win32']) {
      expect(bind(undefined, { actionId: 'sidebar.toggle', accel: 'F1' }, platform).result).toEqual({
        ok: false,
        problem: 'F1 is kept for Help.',
      })
      expect(bind(undefined, { actionId: 'help.open', accel: 'F9' }, platform).result).toEqual({
        ok: false,
        problem: 'Help keeps its shortcut.',
      })
      // Whatever is stored, F1 is Help's.
      const keymap = buildKeymap({ 'help.open': [], 'sidebar.toggle': ['F1'] }, platform)
      expect(keymap.direct.get('F1')?.id).toBe('help.open')
      expect(normalizeShortcuts({ 'help.open': ['F9'], 'tab.new': ['F1', 'F2'] }, platform)).toEqual({
        'tab.new': ['F2'],
      })
    }
    expect(shortcutsFor(ACTIONS_BY_ID['help.open'] as ActionDef, 'darwin')).toEqual([])
    expect(bind(undefined, { actionId: 'help.open', accel: 'F9' }, 'darwin').result).toEqual({ ok: true })
    expect(bind(undefined, { actionId: 'sidebar.toggle', accel: 'F1' }, 'darwin').result).toEqual({ ok: true })
  })

  it(`keeps at most ${MAX_BINDINGS} bindings on an action`, () => {
    let custom = {}
    for (const n of [1, 2, 3, 4]) custom = bind(custom, { actionId: 'tab.new', accel: `F${n}` }, 'darwin').custom
    expect(custom).toEqual({ 'tab.new': ['Cmd+T', 'F1', 'F2', 'F3', 'F4'] })
    const more = bind(custom, { actionId: 'tab.new', accel: 'F9' }, 'darwin')
    expect(more.result).toEqual({ ok: false, problem: `An action can have up to ${MAX_BINDINGS} shortcuts.` })
    expect(more.custom).toEqual(custom)
  })

  it('takes a binding off, leaving the action without keys', () => {
    expect(unbind(undefined, 'sidebar.toggle', 'Ctrl+S', 'linux')).toEqual({ 'sidebar.toggle': [] })
    expect(unbind(undefined, 'sidebar.toggle', 'Ctrl+Q', 'linux')).toEqual({})
    expect(unbind(undefined, 'app.settings', 'Ctrl+,', 'linux')).toEqual({})
  })

  it('resets an action, taking its default keys back from the action given them', () => {
    const { custom } = bind(undefined, { actionId: 'sidebar.toggle', accel: 'Cmd+D', onConflict: 'clear' }, 'darwin')
    expect(custom).toEqual({ 'sidebar.toggle': ['Cmd+S', 'Cmd+D'], 'tab.togglePin': [] })
    expect(reset(custom, 'tab.togglePin', 'darwin')).toEqual({})
    expect(reset(custom, 'sidebar.toggle', 'darwin')).toEqual({ 'tab.togglePin': [] })
  })
})

describe('[KS-01] stored bindings survive a restart only as Orbit can use them', () => {
  it('keeps what is valid and drops the rest', () => {
    expect(normalizeShortcuts(undefined, 'darwin')).toBeUndefined()
    expect(normalizeShortcuts(['Cmd+B'], 'darwin')).toBeUndefined()
    expect(
      normalizeShortcuts(
        {
          'sidebar.toggle': ['shift+cmd+b', 'B', 42, 'Cmd+Q', 'Cmd+Shift+B'],
          'space.goto.2': ['F8'],
          'no.such': ['Cmd+Shift+Y'],
          'app.settings': ['Cmd+Shift+U'],
          'tab.new': 'Cmd+T',
          // Taken already by an action earlier in the list.
          'space.rename': ['Cmd+Shift+B'],
          'tab.close': ['Cmd+W'],
        },
        'darwin',
      ),
    ).toEqual({ 'sidebar.toggle': ['Cmd+Shift+B'], 'space.goto.2': ['F8'] })
  })

  it('keeps no more than the most bindings an action can have', () => {
    const many = ['F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8']
    expect(normalizeShortcuts({ 'tab.new': many }, 'linux')).toEqual({ 'tab.new': many.slice(0, MAX_BINDINGS) })
  })

  it('cleans settings in place', () => {
    const settings = {
      shortcuts: { 'sidebar.toggle': ['Ctrl+S'] },
      shortcutPriority: { 'sidebar.toggle': 'orbit', 'tab.new': 'sometimes' },
    } as unknown as Settings
    normalizeKeySettings(settings, 'linux')
    expect(settings.shortcuts).toBeUndefined()
    expect(settings.shortcutPriority).toEqual({ 'sidebar.toggle': 'orbit' })
  })
})

describe('[KS-02] who gets an action’s keys first', () => {
  it('has defaults per action and platform', () => {
    // ⌘S prefers Orbit on macOS, Ctrl+S websites on Windows and Linux (D60).
    expect(priorityFor(action('sidebar.toggle'), 'darwin')).toBe('orbit')
    expect(priorityFor(action('sidebar.toggle'), 'linux')).toBe('websites')
    expect(priorityFor(action('sidebar.toggle'), 'win32')).toBe('websites')
    expect(priorityFor(action('tab.copyUrl'), 'darwin')).toBe('orbit')
    expect(priorityFor(action('tab.copyUrl'), 'win32')).toBe('websites')
    expect(priorityFor(action('tab.new'), 'linux')).toBe('orbit')
  })

  it('stores only a choice that differs from the default', () => {
    expect(setPriority(undefined, 'sidebar.toggle', 'orbit', 'linux')).toEqual({ 'sidebar.toggle': 'orbit' })
    expect(setPriority({ 'sidebar.toggle': 'orbit' }, 'sidebar.toggle', 'websites', 'linux')).toEqual({})
    expect(setPriority(undefined, 'app.settings', 'websites', 'linux')).toEqual({})
    expect(priorityFor(action('tab.new'), 'linux', { 'tab.new': 'websites' })).toBe('websites')
    expect(normalizePriorities({ 'tab.new': 'orbit', 'tab.close': 'websites', x: 'orbit' }, 'linux')).toEqual({
      'tab.close': 'websites',
    })
  })
})

describe('[KS-16] keys a page’s text field may use', () => {
  it('Back and Forward go to a focused text field first; no other action does', () => {
    expect(ACTIONS.filter((a) => a.pageFirstInFields).map((a) => a.id)).toEqual(['nav.back', 'nav.forward'])
    // They prefer Orbit: outside text fields the page never has them first.
    expect(priorityFor(action('nav.back'), 'darwin')).toBe('orbit')
    expect(priorityFor(action('nav.forward'), 'linux')).toBe('orbit')
  })
})

describe('[KS-13] the DevTools keys can be remapped', () => {
  const press = (key: string, code: string, mods: Partial<KeyInput> = {}): KeyInput => ({
    key,
    code,
    meta: false,
    control: false,
    alt: false,
    shift: false,
    ...mods,
  })

  it('open, console, element picker, view source and hard reload: none is fixed', () => {
    for (const id of ['devtools.toggle', 'devtools.console', 'devtools.inspect', 'page.viewSource', 'nav.hardReload']) {
      for (const platform of ['darwin', 'linux', 'win32'])
        expect(isFixed(action(id), platform), `${id} ${platform}`).toBe(false)
    }
  })

  it('a remapped open key moves in the router and in the DevTools page itself', () => {
    const { custom, result } = bind(undefined, { actionId: 'devtools.toggle', accel: 'F9', replace: 'F12' }, 'linux')
    expect(result).toEqual({ ok: true })
    setCustomBindings(custom)
    expect(actionForInput(press('F9', 'F9'), 'linux')?.id).toBe('devtools.toggle')
    expect(actionForInput(press('F12', 'F12'), 'linux')).toBeUndefined()
    expect(frontendKeys('linux').toggle.map((k) => k.key)).toEqual(['I', 'F9'])
  })

  it('the element picker can take ⇧⌘C from Copy URL, as DT-02 says users may', () => {
    const { custom, result } = bind(
      undefined,
      { actionId: 'devtools.inspect', accel: 'Cmd+Shift+C', onConflict: 'clear' },
      'darwin',
    )
    expect(result).toEqual({ ok: true })
    expect(custom).toEqual({ 'devtools.inspect': ['Cmd+Alt+C', 'Cmd+Shift+C'], 'tab.copyUrl': [] })
    setCustomBindings(custom)
    expect(actionForInput(press('C', 'KeyC', { meta: true, shift: true }), 'darwin')?.id).toBe('devtools.inspect')
    expect(frontendKeys('darwin').inspect).toEqual([
      { cmd: true, ctrl: false, alt: true, shift: false, key: 'C' },
      { cmd: true, ctrl: false, alt: false, shift: true, key: 'C' },
    ])
  })
})
