import { app, BrowserWindow, dialog } from 'electron'

/**
 * Quitting while downloads run asks first: "N downloads in progress, quit anyway?" (DL-01).
 *
 * - Any quit (⌘Q, the menu, the dock, an update's relaunch) reaches `before-quit` first. This
 *   listener runs before every other one and stops the quit until the user answers; the others skip
 *   a quit that was stopped (`event.defaultPrevented`).
 * - Linux and Windows also quit when their last window closes. That window asks before it closes,
 *   so cancelling leaves it open (asking from `before-quit` would leave no window at all).
 */
export interface QuitGuard {
  /** Downloads that quitting would stop. */
  active: () => number
  /** Asks the user; true to quit. */
  ask: (count: number, parent: BrowserWindow | undefined) => Promise<boolean>
  /** Runs when a quit goes ahead, before the windows close. */
  onQuit: () => void
  /** Whether closing the last window quits (Linux, Windows). */
  lastWindowQuits: boolean
}

export function guardQuit(guard: QuitGuard): void {
  let confirmed = false
  let asking: Promise<boolean> | undefined
  const confirm = (parent: BrowserWindow | undefined): Promise<boolean> => {
    asking ??= guard.ask(guard.active(), parent).finally(() => {
      asking = undefined
    })
    return asking
  }

  app.prependListener('before-quit', (event) => {
    if (confirmed || guard.active() === 0) {
      guard.onQuit()
      return
    }
    event.preventDefault()
    void confirm(BrowserWindow.getFocusedWindow() ?? undefined).then((ok) => {
      if (!ok) return
      confirmed = true
      app.quit()
    })
  })

  if (!guard.lastWindowQuits) return
  app.on('browser-window-created', (_event, win) => {
    win.on('close', (event) => {
      if (confirmed || event.defaultPrevented || guard.active() === 0) return
      // Another window stays open (a hidden spare doesn't count): no quit follows.
      const others = BrowserWindow.getAllWindows().some((w) => w !== win && !w.isDestroyed() && w.isVisible())
      if (others) return
      event.preventDefault()
      void confirm(win).then((ok) => {
        if (!ok || win.isDestroyed()) return
        confirmed = true
        win.close()
      })
    })
  })
}

/** The question, e.g. "2 downloads in progress, quit anyway?". */
export function quitQuestion(count: number): string {
  return `${count} ${count === 1 ? 'download' : 'downloads'} in progress, quit anyway?`
}

/** The OS dialog asking it. */
export async function askToQuit(count: number, parent: BrowserWindow | undefined): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    message: quitQuestion(count),
    detail: 'Quitting stops them. You can resume or retry them from Downloads later.',
    buttons: [process.platform === 'win32' ? 'Exit' : 'Quit', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }
  const { response } =
    parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
  return response === 0
}
