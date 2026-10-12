import type { PopupAnchor } from '../../../shared/extensions'
import type { ProfileId } from '../../../shared/state'
import { invoke } from '../api'

/**
 * Where a popup hangs from an element (window coordinates: the shell, the floating sidebar and the
 * overlay all start at the window's corner). A row of the site controls panel hangs it beside the
 * panel, at the row's height; anything else (a pinned icon) under the element.
 */
export function anchorOf(el: HTMLElement): PopupAnchor {
  const r = el.getBoundingClientRect()
  const panel = el.closest('.site-panel')?.getBoundingClientRect()
  if (panel) return { x: panel.left, y: r.top, width: panel.width, height: r.height, side: 'beside' }
  return { x: r.left, y: r.top, width: r.width, height: r.height, side: 'below' }
}

/**
 * Runs an extension's action from its icon or row (EX-03, EX-04): its popup, beside or under it
 * (EX-05). `inspect`: with its DevTools (Inspect Popup, Developer mode).
 */
export function runExtension(id: string, profileId: ProfileId, el: HTMLElement, inspect = false): void {
  void invoke('extensions.run', { id, profileId, anchor: anchorOf(el), ...(inspect ? { inspect } : {}) })
}
