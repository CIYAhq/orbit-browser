/**
 * Dialogs Orbit opens over its windows, for the floating player to keep clear of (MD-06).
 *
 * The player sees most dialogs by itself: the engine disables a window while it shows an alert, and
 * on macOS a window's alerts and file pickers are sheets. A file picker on Linux leaves its window
 * as it was, so the code that opens one says so here: `withDialog(win, dialog.showOpenDialog(win, …))`.
 */
import type { BrowserWindow } from 'electron'

/** Windows showing a dialog noted here, with how many. */
const showing = new Map<BrowserWindow, number>()
const listeners = new Set<() => void>()

function changed(): void {
  for (const listener of listeners) listener()
}

/** Notes that `win` shows a dialog until `shown` settles; returns `shown`. */
export function withDialog<T>(win: BrowserWindow | null | undefined, shown: Promise<T>): Promise<T> {
  if (!win || win.isDestroyed()) return shown
  showing.set(win, (showing.get(win) ?? 0) + 1)
  changed()
  const done = () => {
    const left = (showing.get(win) ?? 1) - 1
    if (left > 0) showing.set(win, left)
    else showing.delete(win)
    changed()
  }
  shown.then(done, done)
  return shown
}

/** The windows showing a dialog noted with withDialog(). */
export function windowsWithDialogs(): BrowserWindow[] {
  return [...showing.keys()].filter((win) => !win.isDestroyed())
}

/** Calls `listener` whenever a noted dialog opens or closes; returns the unsubscribe. */
export function onDialogsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
