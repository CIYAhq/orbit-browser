import { actionForInput } from '../../shared/actions'
import { followKeymap, recordingKeys } from './keys/live'

/**
 * Fallback shortcut router for Orbit's own UI pages. Real key presses are
 * normally handled in the main process (before-input-event), which stops
 * them reaching the page; anything that still arrives here (e.g. synthetic
 * input from automation) is mapped through the same keymap.
 */
export function installShortcutFallback(): void {
  // This page's hints and this fallback use the user's bindings (KS-01).
  followKeymap()
  window.addEventListener(
    'keydown',
    (e) => {
      // Settings → Shortcuts takes the keys while it records a new binding (ST-08).
      if (e.defaultPrevented || e.isComposing || recordingKeys()) return
      const action = actionForInput(
        { key: e.key, code: e.code, meta: e.metaKey, control: e.ctrlKey, alt: e.altKey, shift: e.shiftKey },
        window.orbit.platform,
      )
      // Sidebar undo's keys are the view's own (KS-05).
      if (!action || action.inPlace) return
      e.preventDefault()
      e.stopPropagation()
      void window.orbit.invoke('action.run', { id: action.id })
    },
    { capture: true },
  )
}
