/**
 * Command-line switches behind the Windows taskbar jump list (MW-14): a launch with one of them
 * (a second launch while Orbit runs, or the first launch) acts on Mini Windows instead of opening
 * or raising a main window. Pure, so it is unit-tested without Electron.
 */
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
