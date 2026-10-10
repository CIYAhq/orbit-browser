import { describe, expect, it } from 'vitest'
import { ACTIONS, ACTIONS_BY_ID, actionForInput, defaultShortcutsFor } from '../../src/shared/actions'
import { bindingProblem, canonicalAccelerator, type KeyInput } from '../../src/shared/keymap'

/**
 * The default keymap against the shortcut tables of the spec (KS-03 audit): every row Orbit binds,
 * on macOS and on Windows/Linux. Rows for features no lane has built yet (blank window, top
 * toolbar, save page, full screen keys, reader mode, developer mode, notes, canvases, extensions)
 * are left out; so are keys that belong to an open overlay (KS-04's Esc, Tab, arrows).
 */
const TABLE: [id: string, mac: string[], other: string[]][] = [
  // KS-04
  ['tab.new', ['Cmd+T'], ['Ctrl+T']],
  ['url.edit', ['Cmd+L'], ['Ctrl+L', 'Alt+D']],
  ['tab.pasteAsNewTab', ['Cmd+Alt+V'], ['Ctrl+Alt+V']],
  // KS-05
  ['window.new', ['Cmd+N'], ['Ctrl+N']],
  ['window.newPrivate', ['Cmd+Shift+N'], ['Ctrl+Shift+N']],
  ['window.newMini', ['Cmd+Alt+N'], ['Ctrl+Alt+N']],
  ['tab.close', ['Cmd+W'], ['Ctrl+W', 'Ctrl+F4']],
  ['window.close', ['Cmd+Shift+W'], ['Ctrl+Shift+W']],
  ['tab.reopenClosed', ['Cmd+Shift+T'], ['Ctrl+Shift+T']],
  ['tab.togglePin', ['Cmd+D'], ['Ctrl+D']],
  ['tab.copyUrl', ['Cmd+Shift+C'], ['Ctrl+Shift+C']],
  ['tab.copyUrlMarkdown', ['Cmd+Alt+Shift+C'], ['Ctrl+Alt+Shift+C']],
  ['sidebar.toggle', ['Cmd+S'], ['Ctrl+S']],
  ['tabs.clearToday', ['Cmd+Shift+K'], ['Ctrl+Shift+K']],
  ['sidebar.focus', ['Cmd+Shift+E'], ['Ctrl+Shift+E']],
  ['focus.cycle', ['F6'], ['F6']],
  ['tab.duplicate', [], []],
  ['tab.resetToPinned', [], []],
  // KS-06
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n): [string, string[], string[]] => [
    `tab.goto.${n}`,
    [`Cmd+${n}`],
    [`Ctrl+${n}`],
  ]),
  ['tab.next', ['Cmd+Alt+Down', 'Cmd+Shift+]'], ['Ctrl+Alt+Down', 'Ctrl+PageDown']],
  ['tab.previous', ['Cmd+Alt+Up', 'Cmd+Shift+['], ['Ctrl+Alt+Up', 'Ctrl+PageUp']],
  ['tab.recent', ['Ctrl+Tab'], ['Ctrl+Tab']],
  ['tab.recentBack', ['Ctrl+Shift+Tab', 'Ctrl+`'], ['Ctrl+Shift+Tab']],
  // KS-07: ⌃1–9 on macOS, Alt+1–9 elsewhere (Ctrl+1–9 is tabs).
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n): [string, string[], string[]] => [
    `space.goto.${n}`,
    [`Ctrl+${n}`],
    [`Alt+${n}`],
  ]),
  ['space.next', ['Cmd+Alt+Right'], ['Ctrl+Alt+Right']],
  ['space.previous', ['Cmd+Alt+Left'], ['Ctrl+Alt+Left']],
  ['space.new', [], []],
  // KS-08 (⌘← and ⌘→ act outside text fields only, KS-16)
  ['nav.back', ['Cmd+[', 'Cmd+Left'], ['Alt+Left']],
  ['nav.forward', ['Cmd+]', 'Cmd+Right'], ['Alt+Right']],
  ['nav.reload', ['Cmd+R'], ['Ctrl+R', 'F5']],
  ['nav.hardReload', ['Cmd+Shift+R'], ['Ctrl+Shift+R', 'Shift+F5', 'Ctrl+F5']],
  ['nav.stop', ['Cmd+.'], []],
  ['page.find', ['Cmd+F'], ['Ctrl+F']],
  ['page.findNext', ['Cmd+G'], ['F3', 'Ctrl+G']],
  ['page.findPrevious', ['Cmd+Shift+G'], ['Shift+F3', 'Ctrl+Shift+G']],
  ['page.jumpToSelection', ['Cmd+J'], []],
  // Ctrl+Shift+= adds a split pane on Windows/Linux (KS-09), so Ctrl++ is not zoom there.
  ['page.zoomIn', ['Cmd+=', 'Cmd+Shift+='], ['Ctrl+=']],
  ['page.zoomOut', ['Cmd+-'], ['Ctrl+-']],
  ['page.zoomReset', ['Cmd+0'], ['Ctrl+0']],
  ['page.print', ['Cmd+P'], ['Ctrl+P']],
  ['page.viewSource', ['Cmd+Alt+U'], ['Ctrl+U']],
  ['site.controls', [], []],
  // KS-09
  ['split.add', ['Ctrl+Shift+='], ['Ctrl+Shift+=']],
  ['split.close', ['Ctrl+Shift+-'], ['Ctrl+Shift+-']],
  ...[1, 2, 3, 4].map((n): [string, string[], string[]] => [
    `split.focus.${n}`,
    [`Ctrl+Shift+${n}`],
    [`Ctrl+Shift+${n}`],
  ]),
  ['split.focusNext', ['Ctrl+Shift+]'], ['Ctrl+Shift+]']],
  ['split.focusPrevious', ['Ctrl+Shift+['], ['Ctrl+Shift+[']],
  ['split.addRight', [], []],
  // KS-10
  ['peek.expand', ['Cmd+O'], ['Ctrl+O']],
  ['mini.chooseSpace', ['Cmd+Alt+O', 'Cmd+Shift+O'], ['Ctrl+Alt+O']],
  // KS-11
  ['tab.toggleMute', [], []],
  // KS-12
  ['app.history', ['Cmd+Y'], ['Ctrl+H']],
  ['app.library', ['Cmd+Shift+L'], []],
  ['app.archive', [], []],
  ['app.settings', ['Cmd+,'], ['Ctrl+,']],
  ['settings.clearBrowsingData', ['Cmd+Shift+Backspace'], ['Ctrl+Shift+Delete']],
  // KS-13
  ['devtools.toggle', ['Cmd+Alt+I', 'F12'], ['Ctrl+Shift+I', 'F12']],
  // KS-15: F1 opens help on Windows and Linux; macOS's ⌘? is the system's Help menu search.
  ['help.open', [], ['F1']],
]

const canonical = (list: readonly string[]) => list.map((a) => canonicalAccelerator(a) ?? `(invalid ${a})`)

describe('[KS-03] the default keymap follows the spec tables on each platform', () => {
  it.each(TABLE)('%s', (id, mac, other) => {
    const action = ACTIONS_BY_ID[id]
    expect(action, id).toBeDefined()
    if (!action) return
    expect(canonical(defaultShortcutsFor(action, 'darwin'))).toEqual(canonical(mac))
    expect(canonical(defaultShortcutsFor(action, 'linux'))).toEqual(canonical(other))
    expect(canonical(defaultShortcutsFor(action, 'win32'))).toEqual(canonical(other))
  })

  it('binds each key once per platform, each a binding Orbit accepts', () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
      const seen = new Map<string, string>()
      for (const action of ACTIONS) {
        for (const accel of defaultShortcutsFor(action, platform)) {
          const key = canonicalAccelerator(accel)
          expect(key, `${action.id}: ${accel}`).toBeDefined()
          expect(bindingProblem(accel, platform), `${action.id}: ${accel} on ${platform}`).toBeUndefined()
          expect(
            seen.get(key as string),
            `${accel}: ${seen.get(key as string)} and ${action.id} on ${platform}`,
          ).toBeUndefined()
          seen.set(key as string, action.id)
        }
      }
    }
  })

  const press = (key: string, code: string, mods: Partial<KeyInput>): KeyInput => ({
    key,
    code,
    meta: false,
    control: false,
    alt: false,
    shift: false,
    ...mods,
  })

  it('Linux: Alt+2 is Space 2 and Ctrl+2 the second sidebar item; macOS: ⌃2 and ⌘2', () => {
    expect(actionForInput(press('2', 'Digit2', { alt: true }), 'linux')?.id).toBe('space.goto.2')
    expect(actionForInput(press('2', 'Digit2', { control: true }), 'linux')?.id).toBe('tab.goto.2')
    expect(actionForInput(press('2', 'Digit2', { control: true }), 'darwin')?.id).toBe('space.goto.2')
    expect(actionForInput(press('2', 'Digit2', { meta: true }), 'darwin')?.id).toBe('tab.goto.2')
  })

  it('Windows/Linux exceptions: Ctrl+H history, Alt+←/→, Alt+D, F5, F3, Ctrl+F4', () => {
    const linux = (input: KeyInput) => actionForInput(input, 'win32')?.id
    expect(linux(press('h', 'KeyH', { control: true }))).toBe('app.history')
    expect(linux(press('ArrowLeft', 'ArrowLeft', { alt: true }))).toBe('nav.back')
    expect(linux(press('ArrowRight', 'ArrowRight', { alt: true }))).toBe('nav.forward')
    expect(linux(press('d', 'KeyD', { alt: true }))).toBe('url.edit')
    expect(linux(press('F5', 'F5', {}))).toBe('nav.reload')
    expect(linux(press('F3', 'F3', {}))).toBe('page.findNext')
    expect(linux(press('F4', 'F4', { control: true }))).toBe('tab.close')
  })

  it('shortcuts that use ⌃ on macOS use Ctrl elsewhere too (⌃Tab, the split keys)', () => {
    for (const id of ['tab.recent', 'split.add', 'split.close', 'split.focus.1', 'split.focusNext']) {
      const action = ACTIONS_BY_ID[id]
      if (!action) throw new Error(id)
      expect(defaultShortcutsFor(action, 'darwin')[0], id).toBe(defaultShortcutsFor(action, 'linux')[0])
    }
  })
})
