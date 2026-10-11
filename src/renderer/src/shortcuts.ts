import { actionForInput } from '../../shared/actions'
import { followKeymap, recordingKeys } from './keys/live'

/**
 * The recent-tab switcher's actions (TB-05). In the overlay, main runs their keys without taking
 * them (`windows.ts`), so such a key arrives here after it ran, and must not run again.
 */
const MAIN_RUNS = new Set(['tab.recent', 'tab.recentBack'])

/** Parts of this page up now that take every key themselves (the recent-tab switcher, TB-05). */
let keyTakers = 0

/**
 * Keeps this fallback from running anything until the returned function is called: the recent-tab
 * switcher's keys (W, `) come here after main ran them, and must not run again as Close Tab.
 */
export function takeAllKeys(): () => void {
  keyTakers++
  let given = false
  return () => {
    if (!given) keyTakers--
    given = true
  }
}

/**
 * Fallback shortcut router for Orbit's own UI pages. Real key presses are
 * normally handled in the main process (before-input-event), which stops
 * them reaching the page; anything that still arrives here (e.g. synthetic
 * input from automation) is mapped through the same keymap.
 */
export function installShortcutFallback(): void {
  // This page's hints and this fallback use the user's bindings (KS-01).
  followKeymap()
  const overlay = window.orbit.view === 'overlay'
  window.addEventListener(
    'keydown',
    (e) => {
      // Settings → Shortcuts takes the keys while it records a new binding (ST-08).
      if (e.defaultPrevented || e.isComposing || recordingKeys() || keyTakers > 0) return
      const action = actionForInput(
        { key: e.key, code: e.code, meta: e.metaKey, control: e.ctrlKey, alt: e.altKey, shift: e.shiftKey },
        window.orbit.platform,
      )
      // Sidebar undo's keys are the view's own (KS-05).
      if (!action || action.inPlace || (overlay && MAIN_RUNS.has(action.id))) return
      e.preventDefault()
      e.stopPropagation()
      void window.orbit.invoke('action.run', { id: action.id })
    },
    { capture: true },
  )
}
