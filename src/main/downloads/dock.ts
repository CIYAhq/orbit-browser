import { app, BrowserWindow, Notification } from 'electron'
import type { MainContext } from '../context'
import { type DockProgress, dockProgress, sameProgress } from './progress'

/** What test runs see of the Dock and the taskbar (DL-17), instead of the OS's. */
export interface DockHooks {
  progress: DockProgress | null
  bounces: number
  notifications: { title: string; body?: string }[]
  /** Whether Orbit is in front; unset, whether one of its windows has focus. */
  focused?: boolean
}

/**
 * The Dock icon and the taskbar (DL-17). While downloads run, their overall progress shows on the
 * macOS Dock icon and on the windows' taskbar buttons (Windows, and Linux docks that show it). A
 * download that finishes while Orbit is in the background bounces the Dock icon once and shows a
 * "Download complete" notification. `finished` is told of each finished download: its name, or
 * none for a private window's (the notification doesn't name it).
 */
export function showDownloadsInDock(
  ctx: MainContext,
  hooks: DockHooks | undefined,
): { finished: (filename: string | undefined) => void } {
  let shown: DockProgress | undefined
  const show = (next: DockProgress | undefined) => {
    if (sameProgress(shown, next)) return
    shown = next
    if (hooks) {
      hooks.progress = next ?? null
      return
    }
    // On macOS any window's bar is the Dock icon's; elsewhere each window has its button.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.setProgressBar(next ? next.value : -1, { mode: next ? next.mode : 'none' })
    }
  }
  ctx.store.subscribe((next, prev) => {
    if (next.downloads !== prev.downloads) show(dockProgress(Object.values(next.downloads)))
  })
  // A window opened while downloads run shows their progress too.
  app.on('browser-window-created', (_event, win) => {
    if (shown && !hooks) win.setProgressBar(shown.value, { mode: shown.mode })
  })

  return {
    finished: (filename) => {
      if (hooks?.focused ?? !!BrowserWindow.getFocusedWindow()) return
      const notice = { title: 'Download complete', ...(filename ? { body: filename } : {}) }
      if (hooks) {
        hooks.bounces++
        hooks.notifications.push(notice)
        return
      }
      app.dock?.bounce('informational')
      if (Notification.isSupported()) new Notification(notice).show()
    },
  }
}
