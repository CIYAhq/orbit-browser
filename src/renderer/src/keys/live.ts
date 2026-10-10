import { useSyncExternalStore } from 'react'
import { ACTIONS_BY_ID, formatAccelerator, shortcutsFor } from '../../../shared/actions'
import { keymapVersion, onKeymapChange, setCustomBindings } from '../../../shared/keymap'
import { useMirror } from '../store'

/**
 * The keymap in an Orbit renderer (KS-01, KS-18): the user's bindings follow the state mirror's
 * `settings.shortcuts`, and hints read them through `shortcutLabel` while `useKeymap` re-renders
 * a component after a remap.
 */
export function followKeymap(): void {
  const apply = () => setCustomBindings(useMirror.getState().state?.settings.shortcuts)
  apply()
  useMirror.subscribe(apply)
}

/** Re-renders the component when the user changes a binding; returns the keymap's version. */
export function useKeymap(): number {
  return useSyncExternalStore(onKeymapChange, keymapVersion)
}

/** The action's first shortcut as this platform shows it ("⇧⌘T", "Ctrl+Shift+T"), or '' when it has none. */
export function shortcutLabel(actionId: string): string {
  const action = ACTIONS_BY_ID[actionId]
  const accel = action ? shortcutsFor(action, window.orbit.platform)[0] : undefined
  return accel ? formatAccelerator(accel, window.orbit.platform) : ''
}

/** `shortcutLabel` that follows remaps: the component re-renders when the binding changes. */
export function useShortcutLabel(actionId: string): string {
  useKeymap()
  return shortcutLabel(actionId)
}
