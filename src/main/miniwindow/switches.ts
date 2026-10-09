/**
 * How Mini Windows hook into the system, kept pure so it is unit-tested without Electron.
 *
 * Command-line switches behind the Windows taskbar jump list (MW-14): a launch with one of them
 * (a second launch while Orbit runs, or the first launch) acts on Mini Windows instead of opening
 * or raising a main window.
 */
import { ACTIONS_BY_ID, shortcutsFor } from '../../shared/actions'

export const NEW_MINI_SWITCH = '--new-mini-window'
export const TOGGLE_MINIS_SWITCH = '--toggle-mini-windows'

export type MiniSwitch = 'new' | 'toggle'

/** The Mini Window switch on a command line, if any (Chromium may reorder or append arguments). */
export function miniSwitchIn(argv: readonly string[]): MiniSwitch | undefined {
  const args = argv.map((a) => a.toLowerCase())
  if (args.includes(NEW_MINI_SWITCH)) return 'new'
  if (args.includes(TOGGLE_MINIS_SWITCH)) return 'toggle'
  return undefined
}

/**
 * The shortcut that opens a Mini Window from any app (MW-06), on macOS only. On Windows and Linux,
 * Ctrl+Alt+N held system-wide would take the key from every other app (and AltGr+N, which types a
 * letter on some Windows layouts), so there it works inside Orbit only, like any other shortcut.
 */
export function systemWideShortcut(platform: NodeJS.Platform): string | undefined {
  if (platform !== 'darwin') return undefined
  const def = ACTIONS_BY_ID['window.newMini']
  return def ? shortcutsFor(def, platform)[0] : undefined
}
