import { isPrivateWindow } from '../../shared/private'
import type { MainContext } from '../context'

/**
 * Keys in special windows (KS-20). A private window has no Spaces, pinned tabs, Favorites or
 * folders (NV-11, SB-25), so the actions that need them do nothing there, whether a key, a menu or
 * the command bar asks, and a short hint says why rather than leaving the press unanswered. Mini
 * Windows route their keys themselves (src/main/miniwindow/index.ts).
 */

/** What the hint says. */
export const PRIVATE_WINDOW_HINT = 'Not available in a private window'

/** Actions on pinned tabs, Favorites, folders and Today's Clear (⌘D, ⌘⇧K…); every Space action is one too. */
const NEEDS_SPACES = new Set([
  'tab.togglePin',
  'tab.favorite',
  'tab.resetToPinned',
  'tab.pickSpace',
  'pinned.toggleCollapsed',
  'folder.new',
  'tabs.clearToday',
])

/** Whether an action needs the Spaces, pinned tabs, Favorites or folders a private window doesn't have. */
export function needsSpaces(actionId: string): boolean {
  return NEEDS_SPACES.has(actionId) || actionId.startsWith('space.')
}

export function registerSpecialWindows(ctx: MainContext): void {
  const { store, windows, actions } = ctx
  actions.intercept((id, c) => {
    if (!needsSpaces(id)) return false
    const windowId = c.windowId ?? windows.focusedWindowId()
    if (!windowId || !isPrivateWindow(store.state, windowId)) return false
    ctx.toast(windowId, PRIVATE_WINDOW_HINT)
    return true
  })
}
