import { BaseWindow, Menu, type PopupOptions } from 'electron'

/** Native menus up now, by the id of the window each opened in. */
const upIn = new Map<number, number>()
const closedListeners: ((win: BaseWindow) => void)[] = []
let watching = false

/**
 * Counts the native menus up in each window, for every `Menu.popup()` in the app, whichever module
 * opens it: the floating sidebar's card stays out while a menu opened from it is up, even where
 * the menu reaches out of the window (round 2 fix check, M4). A menu that names no window counts
 * for the focused one, where Electron opens it.
 */
export function watchMenus(): void {
  if (watching) return
  watching = true
  const popup = Menu.prototype.popup
  Menu.prototype.popup = function (this: Menu, options?: PopupOptions): void {
    const win = options?.window ?? BaseWindow.getFocusedWindow()
    if (!win || win.isDestroyed()) {
      popup.call(this, options)
      return
    }
    const id = win.id
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      const left = (upIn.get(id) ?? 1) - 1
      if (left > 0) {
        upIn.set(id, left)
        return
      }
      upIn.delete(id)
      if (!win.isDestroyed()) for (const listener of closedListeners) listener(win)
    }
    upIn.set(id, (upIn.get(id) ?? 0) + 1)
    this.once('menu-will-close', close)
    try {
      popup.call(this, options)
    } catch (error) {
      this.removeListener('menu-will-close', close)
      close()
      throw error
    }
  }
}

/** Whether a native menu is up in `win`. */
export function menuUpIn(win: BaseWindow | undefined): boolean {
  return !!win && !win.isDestroyed() && (upIn.get(win.id) ?? 0) > 0
}

/** Runs once the last native menu up in a window has closed. */
export function onMenusClosed(listener: (win: BaseWindow) => void): void {
  closedListeners.push(listener)
}
