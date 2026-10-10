import { SHORTCUT_SHEET } from '../../shared/commands/keys'
import type { WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import { browserWindowFor } from './browser-window'

/**
 * Help → Keyboard Shortcuts (OB-12): the sheet of essential shortcuts shows in a browser window's
 * overlay (src/renderer/src/keys/ShortcutSheet.tsx). From Settings or a Mini Window it shows in
 * the browser window they belong to, or the last one used; with none open, in a new one.
 */
export function registerShortcutSheet(ctx: MainContext): void {
  const { store, windows, commands, actions } = ctx
  const sheetOpen = (windowId: WindowId | undefined): boolean => {
    const overlay = windowId ? store.state.windows[windowId]?.overlay : undefined
    return overlay?.kind === 'panel' && overlay.panel === SHORTCUT_SHEET
  }
  const close = (windowId: WindowId) => void commands.run('overlay.close', {}, { windowId })

  actions.register('help.shortcuts', (c) => {
    const windowId = browserWindowFor(ctx, c.windowId ?? windows.focusedWindowId())
    // Asked again while it is up: it closes, as the command bar does.
    if (sheetOpen(windowId)) {
      close(windowId)
      return
    }
    const win = windows.get(windowId)
    if (win && !win.isDestroyed() && !win.isFocused()) win.focus()
    void commands.run('overlay.open', { overlay: { kind: 'panel', panel: SHORTCUT_SHEET } }, { windowId })
  })

  // KS-19: while the sheet is up, Close Tab's keys close the sheet rather than the tab under it.
  actions.intercept((id, c) => {
    if (id !== 'tab.close') return false
    const windowId = c.windowId ?? windows.focusedWindowId()
    if (!windowId || !sheetOpen(windowId)) return false
    close(windowId)
    return true
  })
}
