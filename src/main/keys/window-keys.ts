import { webContents } from 'electron'
import type { MainContext } from '../context'

/**
 * Window keys from the keymap's tables that no feature had yet (KS-05): Close Window
 * (⌘⇧W / Ctrl+Shift+W) and F6, which moves the keyboard between the sidebar and the page (SB-22).
 * Settings, onboarding and Mini Windows close themselves through their own action interceptors.
 */
export function registerWindowKeys(ctx: MainContext): void {
  const { actions, windows } = ctx
  actions.register('window.close', (c) => {
    const windowId = c.windowId ?? windows.focusedWindowId()
    const win = windowId ? windows.get(windowId) : undefined
    if (win && !win.isDestroyed()) win.close()
    // A page's pop-up or detached DevTools in front.
    else windows.closeFocusedForeign()
  })
  actions.register('focus.cycle', (c) => {
    const windowId = c.windowId ?? windows.focusedWindowId()
    const win = windowId ? windows.get(windowId) : undefined
    if (!windowId || !win || win.isDestroyed()) return
    if (webContents.getFocusedWebContents() === win.webContents) windows.focusActiveTab(windowId)
    else void actions.run('sidebar.focus', { windowId })
  })
}
