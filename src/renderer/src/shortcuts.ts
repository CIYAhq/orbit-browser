import { actionForInput } from '../../shared/actions'

/**
 * Fallback shortcut router for Orbit's own UI pages. Real key presses are
 * normally handled in the main process (before-input-event), which stops
 * them reaching the page; anything that still arrives here (e.g. synthetic
 * input from automation) is mapped through the same keymap.
 */
export function installShortcutFallback(): void {
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.defaultPrevented || e.isComposing) return
      const action = actionForInput(
        { key: e.key, code: e.code, meta: e.metaKey, control: e.ctrlKey, alt: e.altKey, shift: e.shiftKey },
        window.orbit.platform,
      )
      if (!action) return
      e.preventDefault()
      e.stopPropagation()
      void window.orbit.invoke('action.run', { id: action.id })
    },
    { capture: true },
  )
}
