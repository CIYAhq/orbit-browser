import { execFile } from 'node:child_process'
import type { SystemClash } from '../../shared/commands/keys'
import { canonicalAccelerator } from '../../shared/keymap'

/**
 * Keys the operating system keeps for itself, so Orbit never receives them (KS-03): macOS's
 * Mission Control "Switch to Desktop N" (⌃1–⌃9 when turned on) and GNOME's workspace keys
 * (Ctrl+Alt+←/→ on many setups). Settings → Shortcuts shows them next to the actions they block.
 * Other desktops and Windows report nothing.
 */

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

const GNOME_KEYS: Record<string, string> = {
  Left: 'Left',
  Right: 'Right',
  Up: 'Up',
  Down: 'Down',
  Page_Up: 'PageUp',
  Page_Down: 'PageDown',
  Home: 'Home',
  End: 'End',
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
  const key = GNOME_KEYS[rest] ?? (/^F([1-9]|1[0-2])$/.test(rest) ? rest : /^[a-z0-9]$/i.test(rest) ? rest : undefined)
  if (!key || mods.length === 0) return undefined
  return canonicalAccelerator([...mods, key].join('+'))
}

const GNOME_SETTINGS: [key: string, owner: string][] = [
  ['switch-to-workspace-left', 'GNOME: Switch to workspace on the left'],
  ['switch-to-workspace-right', 'GNOME: Switch to workspace on the right'],
  ['switch-to-workspace-up', 'GNOME: Switch to workspace above'],
  ['switch-to-workspace-down', 'GNOME: Switch to workspace below'],
  ['move-to-workspace-left', 'GNOME: Move window one workspace to the left'],
  ['move-to-workspace-right', 'GNOME: Move window one workspace to the right'],
]

/** GNOME's window manager keys, from `gsettings get org.gnome.desktop.wm.keybindings <key>` (a list such as ['<Super>Page_Up', '<Control><Alt>Left']). */
export function gnomeClashes(values: Record<string, string>): SystemClash[] {
  const out: SystemClash[] = []
  for (const [key, owner] of GNOME_SETTINGS) {
    for (const m of (values[key] ?? '').matchAll(/'([^']*)'/g)) {
      const accel = gnomeAccelerator(m[1] ?? '')
      if (accel) out.push({ accel, owner })
    }
  }
  return out
}

async function detect(platform: string): Promise<SystemClash[]> {
  if (platform === 'darwin') {
    return missionControlClashes(await run('defaults', ['read', 'com.apple.symbolichotkeys', 'AppleSymbolicHotKeys']))
  }
  if (platform === 'linux') {
    const values: Record<string, string> = {}
    for (const [key] of GNOME_SETTINGS) {
      values[key] = await run('gsettings', ['get', 'org.gnome.desktop.wm.keybindings', key])
    }
    return gnomeClashes(values)
  }
  return []
}

let found: Promise<SystemClash[]> | undefined
let override: SystemClash[] | undefined

/** The system's keys that Orbit can't receive, looked up once per run. */
export function systemClashes(platform = process.platform): Promise<SystemClash[]> {
  if (override) return Promise.resolve(override)
  found ??= detect(platform).catch(() => [])
  return found
}

/** Tests: what the system keeps, instead of asking it. */
export function setSystemClashesForTest(list: SystemClash[] | undefined): void {
  override = list
}
