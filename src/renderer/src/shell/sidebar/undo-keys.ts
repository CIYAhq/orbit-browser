import { sidebarUndoFor } from '../../../../shared/actions'

/**
 * Sidebar undo or redo for this key press, as the keymap has them now (TB-18, KS-05): the views
 * that undo sidebar changes read their keys here, so a remap in Settings → Shortcuts reaches them.
 */
export function sidebarUndoKey(e: KeyboardEvent): { redo: boolean; outsideText: boolean } | undefined {
  if (e.isComposing) return undefined
  return sidebarUndoFor(
    { key: e.key, code: e.code, meta: e.metaKey, control: e.ctrlKey, alt: e.altKey, shift: e.shiftKey },
    window.orbit.platform,
  )
}
