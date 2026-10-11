import type { WebContents } from 'electron'

/** Isolated world for the chrome lane's small page scripts: pages can't see or tamper with them. */
export const NAV_WORLD = 1002

/**
 * Is keyboard focus in something that edits text (or in a frame Orbit can't see into)? Inside open
 * shadow roots: a web component's field counts (keys fix check K1). Page script source.
 */
export const FOCUS_IS_EDITABLE = `(() => {
  let el = document.activeElement
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement
  if (!el || el === document.body || el === document.documentElement) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'IFRAME' || tag === 'EMBED' || tag === 'OBJECT') return true
  if (tag !== 'INPUT') return false
  const type = (el.getAttribute('type') || 'text').toLowerCase()
  return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type)
})()`

/**
 * True when keyboard focus in `contents` is in a text field, where keys such as ⌘← keep their
 * text-editing meaning (KS-16). Errs on the side of "editable" when the page can't be asked.
 */
export async function focusIsEditable(contents: WebContents): Promise<boolean> {
  if (contents.isDestroyed()) return true
  try {
    return !!(await contents.executeJavaScriptInIsolatedWorld(NAV_WORLD, [{ code: FOCUS_IS_EDITABLE }]))
  } catch {
    return true
  }
}
