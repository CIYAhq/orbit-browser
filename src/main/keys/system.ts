import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SystemClash } from '../../shared/commands/keys'
import { canonicalAccelerator } from '../../shared/keymap'

/**
 * Keys the operating system keeps for itself, so Orbit never receives them (KS-03): macOS's
 * Mission Control "Switch to Desktop N" (⌃1–⌃9 when turned on), and on Linux the desktop's own
 * keys: the window manager's and system keys of GNOME (and of Cinnamon and MATE), Xfce's and KDE
 * Plasma's global shortcuts. Among them are the workspace keys (Ctrl+Alt+←/→ on many setups) and
 * the Alt+F-keys. Settings → Shortcuts shows them next to the actions they block, and onboarding
 * offers other keys for those actions on Linux (src/shared/system-keys.ts). Windows and other
 * desktops report nothing.
 *
 * Tests never ask the system: `systemClashes` is the one function that does, and test runs replace
 * its answer (`setSystemClashesForTest`, src/main/keys/index.ts).
 */

/** Runs a command and gives its output, or '' when it fails or takes over 3 s. */
const run = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 3000 }, (error, stdout) => resolve(error ? '' : String(stdout)))
  })

/** macOS virtual key codes of the digit keys. */
const MAC_DIGITS: Record<number, string> = {
  18: '1',
  19: '2',
  20: '3',
  21: '4',
  23: '5',
  22: '6',
  26: '7',
  28: '8',
  25: '9',
}

/**
 * The Mission Control desktop keys turned on, from `defaults read com.apple.symbolichotkeys
 * AppleSymbolicHotKeys` (entries 118–126 are Switch to Desktop 1–9).
 */
export function missionControlClashes(plist: string): SystemClash[] {
  const out: SystemClash[] = []
  const entry =
    /(?:^|[\s{;])"?(\d+)"?\s*=\s*\{\s*enabled\s*=\s*(\d+);\s*value\s*=\s*\{\s*parameters\s*=\s*\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\);/g
  for (const m of plist.matchAll(entry)) {
    const id = Number(m[1])
    if (id < 118 || id > 126 || m[2] !== '1') continue
    const digit = MAC_DIGITS[Number(m[4])]
    const mask = Number(m[5])
    if (!digit) continue
    const mods = [
      mask & 1048576 ? 'Cmd' : '',
      mask & 262144 ? 'Ctrl' : '',
      mask & 524288 ? 'Alt' : '',
      mask & 131072 ? 'Shift' : '',
    ].filter(Boolean)
    const accel = canonicalAccelerator([...mods, digit].join('+'))
    if (accel) out.push({ accel, owner: `Mission Control: Switch to Desktop ${id - 117}` })
  }
  return out
}

/** GTK key names (as GNOME, Cinnamon, MATE and Xfce write them) for the keys Orbit binds by name. */
const GTK_KEYS: Record<string, string> = {
  Left: 'Left',
  Right: 'Right',
  Up: 'Up',
  Down: 'Down',
  Page_Up: 'PageUp',
  Page_Down: 'PageDown',
  Home: 'Home',
  End: 'End',
  Insert: 'Insert',
  Delete: 'Delete',
  BackSpace: 'Backspace',
  Tab: 'Tab',
  Return: 'Enter',
  Escape: 'Escape',
  space: 'Space',
  Above_Tab: '`',
  grave: '`',
  minus: '-',
  equal: '=',
  comma: ',',
  period: '.',
  slash: '/',
  semicolon: ';',
  apostrophe: "'",
  backslash: '\\',
  bracketleft: '[',
  bracketright: ']',
}

/** A GNOME accelerator ("<Control><Alt>Left") as a binding, when Orbit could have it. */
export function gnomeAccelerator(text: string): string | undefined {
  const mods: string[] = []
  let rest = text.trim()
  for (;;) {
    const m = /^<([A-Za-z0-9]+)>/.exec(rest)
    if (!m) break
    rest = rest.slice(m[0].length)
    const name = (m[1] ?? '').toLowerCase()
    if (name === 'control' || name === 'primary' || name === 'ctrl') mods.push('Ctrl')
    else if (name === 'alt' || name === 'mod1') mods.push('Alt')
    else if (name === 'shift') mods.push('Shift')
    // Super (the Windows key) and the rest are keys Orbit never binds.
    else return undefined
  }
  const key = GTK_KEYS[rest] ?? (/^F([1-9]|1[0-2])$/.test(rest) ? rest : /^[a-z0-9]$/i.test(rest) ? rest : undefined)
  if (!key || mods.length === 0) return undefined
  return canonicalAccelerator([...mods, key].join('+'))
}

/** What a desktop's settings key does, where its name alone doesn't say it well. */
const KEY_NAMES: Record<string, string> = {
  'switch-to-workspace-left': 'Switch to workspace on the left',
  'switch-to-workspace-right': 'Switch to workspace on the right',
  'switch-to-workspace-up': 'Switch to workspace above',
  'switch-to-workspace-down': 'Switch to workspace below',
  'move-to-workspace-left': 'Move window one workspace to the left',
  'move-to-workspace-right': 'Move window one workspace to the right',
  'move-to-workspace-up': 'Move window one workspace up',
  'move-to-workspace-down': 'Move window one workspace down',
  'panel-main-menu': 'Show the overview',
  'panel-run-dialog': 'Run a command',
  close: 'Close window',
  unmaximize: 'Restore window',
  'begin-move': 'Move window',
  'begin-resize': 'Resize window',
  'toggle-maximized': 'Maximize window',
  minimize: 'Hide window',
  'activate-window-menu': 'Window menu',
  'toggle-fullscreen': 'Full screen',
  logout: 'Log out',
  terminal: 'Open a terminal',
  screensaver: 'Lock screen',
}

/** A settings key's name as words: "switch-to-session-3" → "Switch to session 3". */
function keyLabel(key: string): string {
  const known = KEY_NAMES[key]
  if (known) return known
  const words = key.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The keys in GNOME-style settings: each key's value is a list such as ['<Super>Page_Up',
 * '<Control><Alt>Left'] (or one accelerator in quotes), from `gsettings get` or `list-recursively`.
 */
export function gnomeClashes(values: Record<string, string>, desktop = 'GNOME'): SystemClash[] {
  const out: SystemClash[] = []
  for (const [key, value] of Object.entries(values)) {
    for (const m of value.matchAll(/'([^']*)'/g)) {
      const accel = gnomeAccelerator(m[1] ?? '')
      if (accel) out.push({ accel, owner: `${desktop}: ${keyLabel(key)}` })
    }
  }
  return out
}

/**
 * The keys in `gsettings list-recursively <schema>` output, one "schema key value" per line, such
 * as "org.gnome.desktop.wm.keybindings switch-to-workspace-left ['<Control><Alt>Left']".
 */
export function gsettingsClashes(text: string, desktop: string): SystemClash[] {
  const out: SystemClash[] = []
  for (const line of text.split('\n')) {
    const m = /^\S+\s+(\S+)\s+(.+)$/.exec(line.trim())
    if (m) out.push(...gnomeClashes({ [m[1] as string]: m[2] as string }, desktop))
  }
  return out
}

/**
 * Xfce's keyboard shortcuts, from `xfconf-query -c xfce4-keyboard-shortcuts -l -v`: the window
 * manager's ("/xfwm4/custom/<Primary><Alt>Left  left_workspace_key") and the commands it runs
 * ("/commands/custom/<Alt>F2  xfce4-appfinder --collapsed").
 */
export function xfceClashes(text: string): SystemClash[] {
  const out: SystemClash[] = []
  for (const line of text.split('\n')) {
    const m = /^\/(xfwm4|commands)\/custom\/(\S+)\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const accel = gnomeAccelerator(m[2] as string)
    if (!accel) continue
    const value = m[3] as string
    const what = m[1] === 'xfwm4' ? keyLabel(value.replace(/_key$/, '')) : `Runs ${value.split(/\s/)[0]}`
    out.push({ accel, owner: `Xfce: ${what}` })
  }
  return out
}

/** Qt's names for the keys Orbit binds by name, where they differ. */
const QT_KEYS: Record<string, string> = {
  PgUp: 'PageUp',
  PgDown: 'PageDown',
  Ins: 'Insert',
  Del: 'Delete',
  Return: 'Enter',
}

/** A KDE shortcut ("Ctrl+Alt+Left", "Alt+F4") as a binding, when Orbit could have it. */
export function kdeAccelerator(text: string): string | undefined {
  const parts = text.trim().split('+')
  const key = parts.pop() ?? ''
  // Meta (the Windows key) is the desktop's own: Orbit never binds it.
  if (parts.some((p) => p.toLowerCase() === 'meta')) return undefined
  const accel = canonicalAccelerator([...parts, QT_KEYS[key] ?? key].join('+'))
  // A key on its own is a shortcut only for F1–F12 (a key such as Print never reaches a page either).
  if (!accel || (parts.length === 0 && !/^F([1-9]|1[0-2])$/.test(accel))) return undefined
  return accel
}

/**
 * KDE Plasma's global shortcuts, from kglobalshortcutsrc: in each component's section, lines such
 * as "Window Close=Alt+F4,Alt+F4,Close Window" (the keys in use, the defaults, the name). Several
 * keys in use are separated by "\t".
 */
export function kdeClashes(text: string): SystemClash[] {
  const out: SystemClash[] = []
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (line.startsWith('[') || line.startsWith('_k_friendly_name') || eq <= 0) continue
    const fields = line.slice(eq + 1).split(',')
    if (fields.length < 3) continue
    const name = fields.slice(2).join(',').trim() || line.slice(0, eq).trim()
    for (const key of (fields[0] ?? '').split(/\\t|\t/)) {
      const accel = kdeAccelerator(key)
      if (accel) out.push({ accel, owner: `KDE Plasma: ${name}` })
    }
  }
  return out
}

/** The desktops whose keys Orbit reads: from XDG_CURRENT_DESKTOP ("ubuntu:GNOME", "KDE", "X-Cinnamon"…). */
export type LinuxDesktop = 'gnome' | 'cinnamon' | 'mate' | 'xfce' | 'kde'

export function linuxDesktop(value: string | undefined): LinuxDesktop | undefined {
  const names = (value ?? '').toLowerCase().split(':')
  if (names.includes('kde')) return 'kde'
  if (names.includes('xfce')) return 'xfce'
  if (names.includes('x-cinnamon') || names.includes('cinnamon')) return 'cinnamon'
  if (names.includes('mate')) return 'mate'
  // No name at all: GNOME's settings, as before desktops named themselves.
  const gnomeLike = ['', 'gnome', 'unity', 'budgie', 'pantheon', 'ubuntu', 'gnome-classic', 'gnome-flashback']
  return names.some((n) => gnomeLike.includes(n)) ? 'gnome' : undefined
}

/** Where each GNOME-style desktop keeps its keys, and the name Settings gives it. */
const GSETTINGS: Record<'gnome' | 'cinnamon' | 'mate', { label: string; schemas: string[] }> = {
  gnome: {
    label: 'GNOME',
    schemas: [
      'org.gnome.desktop.wm.keybindings',
      'org.gnome.mutter.keybindings',
      'org.gnome.mutter.wayland.keybindings',
      'org.gnome.shell.keybindings',
      'org.gnome.settings-daemon.plugins.media-keys',
    ],
  },
  cinnamon: {
    label: 'Cinnamon',
    schemas: ['org.cinnamon.desktop.keybindings.wm', 'org.cinnamon.desktop.keybindings.media-keys'],
  },
  mate: { label: 'MATE', schemas: ['org.mate.Marco.global-keybindings', 'org.mate.Marco.window-keybindings'] },
}

/** How the check asks the system: commands it runs and files it reads, and the environment. */
export interface SystemProbe {
  /** Runs a command; '' when it fails. */
  run: (file: string, args: string[]) => Promise<string>
  /** Reads a text file; '' when there is none. */
  read: (path: string) => Promise<string>
  env: Record<string, string | undefined>
  home: string
}

/** Asks the system which keys it keeps (KS-03). */
export async function detectSystemKeys(platform: string, probe: SystemProbe): Promise<SystemClash[]> {
  if (platform === 'darwin') {
    return missionControlClashes(
      await probe.run('defaults', ['read', 'com.apple.symbolichotkeys', 'AppleSymbolicHotKeys']),
    )
  }
  if (platform !== 'linux') return []
  const desktop = linuxDesktop(probe.env.XDG_CURRENT_DESKTOP)
  if (desktop === 'kde') {
    const config = probe.env.XDG_CONFIG_HOME || join(probe.home, '.config')
    return kdeClashes(await probe.read(join(config, 'kglobalshortcutsrc')))
  }
  if (desktop === 'xfce') {
    return xfceClashes(await probe.run('xfconf-query', ['-c', 'xfce4-keyboard-shortcuts', '-l', '-v']))
  }
  if (!desktop) return []
  const { label, schemas } = GSETTINGS[desktop]
  const lists = await Promise.all(schemas.map((schema) => probe.run('gsettings', ['list-recursively', schema])))
  return gsettingsClashes(lists.join('\n'), label)
}

const systemProbe: SystemProbe = {
  run,
  read: (path) => readFile(path, 'utf8').catch(() => ''),
  env: process.env,
  home: homedir(),
}

let found: Promise<SystemClash[]> | undefined
let override: SystemClash[] | undefined

/**
 * The system's keys that Orbit can't receive, looked up once per run. The only function that asks
 * the system: in test runs `setSystemClashesForTest` has always given the answer first.
 */
export function systemClashes(platform = process.platform): Promise<SystemClash[]> {
  if (override) return Promise.resolve(override)
  found ??= detectSystemKeys(platform, systemProbe).catch(() => [])
  return found
}

/** Tests: what the system keeps, instead of asking it. */
export function setSystemClashesForTest(list: SystemClash[] | undefined): void {
  override = list
}

/** Tests: the keys a test run says the system keeps (ORBIT_SYSTEM_KEYS, a JSON list of SystemClash), none by default. */
export function systemKeysForTest(text: string | undefined): SystemClash[] {
  let list: unknown
  try {
    list = JSON.parse(text || '[]')
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []
  const out: SystemClash[] = []
  for (const item of list as Partial<SystemClash>[]) {
    const accel = typeof item?.accel === 'string' ? canonicalAccelerator(item.accel) : undefined
    if (accel && typeof item.owner === 'string') out.push({ accel, owner: item.owner })
  }
  return out
}
