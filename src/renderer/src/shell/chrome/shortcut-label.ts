import { ACTIONS_BY_ID, formatAccelerator, shortcutsFor } from '../../../../shared/actions'

/** "Back (⌘[)": a button's tooltip with the action's first shortcut on this platform. */
export function withShortcut(label: string, actionId: string): string {
  const action = ACTIONS_BY_ID[actionId]
  const accel = action ? shortcutsFor(action, window.orbit.platform)[0] : undefined
  return accel ? `${label} (${formatAccelerator(accel, window.orbit.platform)})` : label
}
