import { describe, expect, it } from 'vitest'
import { bind } from '../../src/main/keys/bindings'
import {
  detectSystemKeys,
  gsettingsClashes,
  kdeClashes,
  linuxDesktop,
  type SystemProbe,
  systemKeysForTest,
  xfceClashes,
} from '../../src/main/keys/system'
import { buildKeymap } from '../../src/shared/actions'
import type { SystemClash } from '../../src/shared/commands/keys'
import { bindingProblem, editsText } from '../../src/shared/keymap'
import { keyRemaps } from '../../src/shared/system-keys'

/**
 * KS-03's Linux first-run check: which keys the desktop keeps (read from its own settings, never
 * by a test), and the keys onboarding suggests in their place.
 */

describe('[KS-03] the desktop keys Orbit reads on Linux', () => {
  it('reads GNOME’s window manager and system keys, the Alt+F-keys among them', () => {
    const text = [
      "org.gnome.desktop.wm.keybindings switch-to-workspace-left ['<Super>Page_Up', '<Super><Alt>Left', '<Control><Alt>Left']",
      "org.gnome.desktop.wm.keybindings switch-to-workspace-right ['<Super>Page_Down', '<Control><Alt>Right']",
      "org.gnome.desktop.wm.keybindings move-to-workspace-right ['<Super><Shift>Page_Down', '<Control><Shift><Alt>Right']",
      "org.gnome.desktop.wm.keybindings panel-run-dialog ['<Alt>F2']",
      "org.gnome.desktop.wm.keybindings begin-move ['<Alt>F7']",
      "org.gnome.desktop.wm.keybindings activate-window-menu ['<Alt>space']",
      'org.gnome.desktop.wm.keybindings switch-to-workspace-3 @as []',
      "org.gnome.mutter.wayland.keybindings switch-to-session-1 ['<Primary><Alt>F1']",
      "org.gnome.settings-daemon.plugins.media-keys custom-keybindings ['/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/']",
      'org.gnome.settings-daemon.plugins.media-keys volume-step 6',
      "org.gnome.settings-daemon.plugins.media-keys screensaver '<Control><Alt>l'",
    ].join('\n')
    expect(gsettingsClashes(text, 'GNOME')).toEqual([
      { accel: 'Ctrl+Alt+Left', owner: 'GNOME: Switch to workspace on the left' },
      { accel: 'Ctrl+Alt+Right', owner: 'GNOME: Switch to workspace on the right' },
      { accel: 'Ctrl+Alt+Shift+Right', owner: 'GNOME: Move window one workspace to the right' },
      { accel: 'Alt+F2', owner: 'GNOME: Run a command' },
      { accel: 'Alt+F7', owner: 'GNOME: Move window' },
      { accel: 'Alt+Space', owner: 'GNOME: Window menu' },
      { accel: 'Ctrl+Alt+F1', owner: 'GNOME: Switch to session 1' },
      { accel: 'Ctrl+Alt+L', owner: 'GNOME: Lock screen' },
    ])
    expect(gsettingsClashes('', 'GNOME')).toEqual([])
  })

  it('reads Xfce’s window manager keys and the commands its keys run', () => {
    const text = [
      '/commands/custom/<Alt>F2                   xfce4-appfinder --collapsed',
      '/commands/custom/<Primary><Alt>Delete       xfce4-session-logout',
      '/commands/custom/override                  true',
      '/commands/default/<Alt>F3                  xfce4-appfinder',
      '/xfwm4/custom/<Primary><Alt>Left           left_workspace_key',
      '/xfwm4/custom/<Super>Tab                   switch_window_key',
    ].join('\n')
    expect(xfceClashes(text)).toEqual([
      { accel: 'Alt+F2', owner: 'Xfce: Runs xfce4-appfinder' },
      { accel: 'Ctrl+Alt+Delete', owner: 'Xfce: Runs xfce4-session-logout' },
      { accel: 'Ctrl+Alt+Left', owner: 'Xfce: Left workspace' },
    ])
  })

  it('reads KDE Plasma’s global shortcuts in use, not their defaults', () => {
    const text = [
      '[kwin]',
      '_k_friendly_name=KWin',
      'Switch One Desktop to the Left=Meta+Ctrl+Left,Meta+Ctrl+Left,Switch One Desktop to the Left',
      'Switch to Desktop 4=Ctrl+F4,Ctrl+F4,Switch to Desktop 4',
      'Window Close=Alt+F4\\tCtrl+Alt+Q,Alt+F4,Close Window',
      'Window Maximize=none,Meta+PgUp,Maximize Window',
      'Window to Next Desktop=Ctrl+Alt+PgDown,,Window to Next Desktop',
      '[yakuake]',
      'toggle-window-state=F12,F12,Open/Retract Yakuake',
    ].join('\n')
    expect(kdeClashes(text)).toEqual([
      { accel: 'Ctrl+F4', owner: 'KDE Plasma: Switch to Desktop 4' },
      { accel: 'Alt+F4', owner: 'KDE Plasma: Close Window' },
      { accel: 'Ctrl+Alt+Q', owner: 'KDE Plasma: Close Window' },
      { accel: 'Ctrl+Alt+PageDown', owner: 'KDE Plasma: Window to Next Desktop' },
      { accel: 'F12', owner: 'KDE Plasma: Open/Retract Yakuake' },
    ])
  })

  it('knows the desktop from XDG_CURRENT_DESKTOP', () => {
    expect(linuxDesktop('ubuntu:GNOME')).toBe('gnome')
    expect(linuxDesktop('Budgie:GNOME')).toBe('gnome')
    expect(linuxDesktop(undefined)).toBe('gnome')
    expect(linuxDesktop('KDE')).toBe('kde')
    expect(linuxDesktop('XFCE')).toBe('xfce')
    expect(linuxDesktop('X-Cinnamon')).toBe('cinnamon')
    expect(linuxDesktop('MATE')).toBe('mate')
    // A desktop whose keys live somewhere Orbit doesn't read (a config file of its own).
    expect(linuxDesktop('sway')).toBeUndefined()
  })
})

/** A probe that records what the check asks, and answers from a table instead of the system. */
function fakeProbe(desktop: string | undefined, answers: Record<string, string> = {}) {
  const asked: string[] = []
  const probe: SystemProbe = {
    run: async (file, args) => {
      const call = [file, ...args].join(' ')
      asked.push(call)
      return answers[call] ?? ''
    },
    read: async (path) => {
      asked.push(`read ${path}`)
      return answers[`read ${path}`] ?? ''
    },
    env: { XDG_CURRENT_DESKTOP: desktop },
    home: '/home/someone',
  }
  return { probe, asked }
}

describe('[KS-03] asking the desktop', () => {
  it('asks each desktop where it keeps its keys, and nothing else', async () => {
    const gnome = fakeProbe('ubuntu:GNOME', {
      'gsettings list-recursively org.gnome.desktop.wm.keybindings':
        "org.gnome.desktop.wm.keybindings switch-to-workspace-left ['<Control><Alt>Left']",
    })
    expect(await detectSystemKeys('linux', gnome.probe)).toEqual([
      { accel: 'Ctrl+Alt+Left', owner: 'GNOME: Switch to workspace on the left' },
    ])
    expect(gnome.asked).toEqual([
      'gsettings list-recursively org.gnome.desktop.wm.keybindings',
      'gsettings list-recursively org.gnome.mutter.keybindings',
      'gsettings list-recursively org.gnome.mutter.wayland.keybindings',
      'gsettings list-recursively org.gnome.shell.keybindings',
      'gsettings list-recursively org.gnome.settings-daemon.plugins.media-keys',
    ])

    const cinnamon = fakeProbe('X-Cinnamon')
    await detectSystemKeys('linux', cinnamon.probe)
    expect(cinnamon.asked.every((c) => c.startsWith('gsettings list-recursively org.cinnamon.'))).toBe(true)

    const kde = fakeProbe('KDE')
    await detectSystemKeys('linux', kde.probe)
    expect(kde.asked).toEqual(['read /home/someone/.config/kglobalshortcutsrc'])

    const xfce = fakeProbe('XFCE')
    await detectSystemKeys('linux', xfce.probe)
    expect(xfce.asked).toEqual(['xfconf-query -c xfce4-keyboard-shortcuts -l -v'])

    const sway = fakeProbe('sway')
    expect(await detectSystemKeys('linux', sway.probe)).toEqual([])
    expect(sway.asked).toEqual([])

    const windows = fakeProbe(undefined)
    expect(await detectSystemKeys('win32', windows.probe)).toEqual([])
    expect(windows.asked).toEqual([])
  })

  it('takes a test run’s list instead (ORBIT_SYSTEM_KEYS), none when it names none', () => {
    expect(systemKeysForTest(undefined)).toEqual([])
    expect(systemKeysForTest('not json')).toEqual([])
    expect(
      systemKeysForTest(
        JSON.stringify([{ accel: 'alt+ctrl+left', owner: 'GNOME' }, { accel: 'Hyper+X', owner: 'x' }, { owner: 'y' }]),
      ),
    ).toEqual([{ accel: 'Ctrl+Alt+Left', owner: 'GNOME' }])
  })
})

/** GNOME's keys on a default Ubuntu install: workspaces on Ctrl+Alt+←/→, the window keys on Alt+F-keys. */
const GNOME_DEFAULTS: SystemClash[] = [
  { accel: 'Ctrl+Alt+Left', owner: 'GNOME: Switch to workspace on the left' },
  { accel: 'Ctrl+Alt+Right', owner: 'GNOME: Switch to workspace on the right' },
  { accel: 'Ctrl+Alt+Shift+Right', owner: 'GNOME: Move window one workspace to the right' },
  { accel: 'Alt+F2', owner: 'GNOME: Run a command' },
  { accel: 'Alt+F7', owner: 'GNOME: Move window' },
  { accel: 'Alt+F8', owner: 'GNOME: Resize window' },
]

describe('[KS-03] the keys onboarding suggests', () => {
  it('lists the actions whose keys the desktop keeps, each with a free key to use instead', () => {
    const remaps = keyRemaps(GNOME_DEFAULTS, {}, 'linux')
    expect(remaps.map((r) => [r.actionId, r.accel, r.owner])).toEqual([
      ['space.next', 'Ctrl+Alt+Right', 'GNOME: Switch to workspace on the right'],
      ['space.previous', 'Ctrl+Alt+Left', 'GNOME: Switch to workspace on the left'],
    ])
    // The same key with Shift, unless the desktop keeps that too.
    expect(remaps.find((r) => r.actionId === 'space.previous')?.suggestion).toBe('Ctrl+Alt+Shift+Left')
    const next = remaps.find((r) => r.actionId === 'space.next')?.suggestion as string
    expect(next).not.toBe('Ctrl+Alt+Shift+Right')
    const keymap = buildKeymap({}, 'linux')
    for (const r of remaps) {
      const key = r.suggestion as string
      expect(keymap.direct.has(key) || keymap.outsideText.has(key), key).toBe(false)
      expect(GNOME_DEFAULTS.some((c) => c.accel === key)).toBe(false)
      expect(bindingProblem(key, 'linux')).toBeUndefined()
      expect(editsText(key, 'linux')).toBe(false)
    }
  })

  it('says which of an action’s keys still work, and leaves fixed actions and ones Orbit doesn’t run out', () => {
    const remaps = keyRemaps(
      [
        { accel: 'Ctrl+Alt+Down', owner: 'GNOME: Switch to workspace below' },
        { accel: 'F1', owner: 'Some desktop: Help' },
        { accel: 'Ctrl+F4', owner: 'KDE Plasma: Switch to Desktop 4' },
      ],
      {},
      'linux',
      (id) => id !== 'tab.close',
    )
    expect(remaps).toEqual([
      {
        actionId: 'tab.next',
        title: 'Next Tab',
        accel: 'Ctrl+Alt+Down',
        owner: 'GNOME: Switch to workspace below',
        others: ['Ctrl+PageDown'],
        suggestion: 'Ctrl+Alt+Shift+Down',
      },
    ])
  })

  it('follows the user’s own bindings, and never suggests a key the desktop is likely to keep', () => {
    // A key Orbit doesn't bind by default clashes once the user binds it.
    const custom = { 'tab.duplicate': ['Alt+F7'] }
    const [remap] = keyRemaps(GNOME_DEFAULTS, custom, 'linux').filter((r) => r.actionId === 'tab.duplicate')
    expect(remap?.accel).toBe('Alt+F7')
    // Not another Alt+F-key, nor Ctrl+Alt with one (a text console).
    expect(remap?.suggestion).toBe('Alt+Shift+F7')
    // Two clashes never get the same key.
    const both = keyRemaps(
      [
        { accel: 'Ctrl+Alt+Left', owner: 'a' },
        { accel: 'Ctrl+Alt+Shift+Left', owner: 'b' },
      ],
      { 'space.previous': ['Ctrl+Alt+Left'], 'tab.duplicate': ['Ctrl+Alt+Shift+Left'] },
      'linux',
    )
    const keys = both.map((r) => r.suggestion)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('a suggestion taken is a binding Settings → Shortcuts accepts, in place of the kept key', () => {
    let custom: Record<string, string[]> = {}
    for (const r of keyRemaps(GNOME_DEFAULTS, {}, 'linux')) {
      const done = bind(custom, { actionId: r.actionId, accel: r.suggestion as string, replace: r.accel }, 'linux')
      expect(done.result).toEqual({ ok: true })
      custom = done.custom
    }
    expect(custom['space.previous']).toEqual(['Ctrl+Alt+Shift+Left'])
    // Nothing left to suggest: the desktop's keys no longer run any of Orbit's actions.
    expect(keyRemaps(GNOME_DEFAULTS, custom, 'linux')).toEqual([])
  })
})
