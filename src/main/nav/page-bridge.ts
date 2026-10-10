import { join } from 'node:path'
import { BrowserWindow, type IpcMainEvent, ipcMain, type Session, type WebContents } from 'electron'
import { windowMayShow } from '../../shared/private'
import { PAGE_CHANNEL, type PagePermissionState, pagePermissionKinds, permissionOrigin } from '../../shared/site'
import type { ProfileId, TabId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import type { Permissions } from './permissions'

/** The web page preload, built next to the shell's (electron.vite.config.ts). */
export function pagePreloadPath(): string {
  return join(import.meta.dirname, '../preload/page.cjs')
}

/**
 * The main side of the web page preload (src/preload/page.ts, NV-15). Every profile session runs it
 * in its pages; it asks here how a permission should read to the page ("prompt" until the user
 * decides, which Electron's yes/no check can't say) and says when the user clicked one of the
 * page's notifications, which brings the tab that sent it forward: in the window that shows it, or
 * else selected in the last window the user worked in that may show it, on its Space.
 */
export function registerPageBridge(ctx: MainContext, permissions: Permissions): void {
  const { store, sessions, tabs, windows, commands } = ctx
  const profiles = new WeakMap<Session, ProfileId>()

  sessions.onSessionCreated((ses, profileId) => {
    profiles.set(ses, profileId)
    try {
      ses.registerPreloadScript({ type: 'frame', id: 'orbit-page', filePath: pagePreloadPath() })
    } catch (err) {
      console.error('[page-bridge] preload not registered', err)
    }
  })

  const profileOf = (contents: WebContents): ProfileId | undefined => {
    const tabId = tabs.tabIdFor(contents)
    return (tabId ? store.state.tabs[tabId]?.profileId : undefined) ?? profiles.get(contents.session)
  }

  // The reply goes out as soon as returnValue is set, so it is set once.
  ipcMain.on(PAGE_CHANNEL.permission, (event: IpcMainEvent, name: unknown) => {
    let answer: PagePermissionState | null = null
    try {
      const kinds = typeof name === 'string' ? pagePermissionKinds(name) : null
      const frame = event.senderFrame
      const origin = frame ? permissionOrigin(frame.url) : null
      const profileId = profileOf(event.sender)
      if (kinds && origin && profileId) answer = permissions.pageState(profileId, origin, kinds)
    } catch (err) {
      console.error('[page-bridge] permission state', err)
    }
    event.returnValue = answer
  })

  const raise = (win: BrowserWindow | undefined) => {
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  /** The window to select a tab in that no window shows: the one the user worked in last, if it may. */
  const windowFor = (tabId: TabId): WindowId | undefined => {
    const state = store.state
    const tab = state.tabs[tabId]
    if (!tab) return undefined
    const candidates = Object.values(state.windows).filter(
      (w) => w.kind !== 'mini' && windows.get(w.id) && windowMayShow(state, w.id, tabId),
    )
    // One already on the tab's Space first (the focused one if it is), else the focused one.
    const focused = windows.focusedWindowId()
    const onSpace = candidates.filter((w) => w.spaceId === tab.spaceId)
    const ranked = [
      ...onSpace.filter((w) => w.id === focused),
      ...onSpace,
      ...candidates.filter((w) => w.id === focused),
      ...candidates,
    ]
    return ranked[0]?.id
  }

  const bringForward = (tabId: TabId) => {
    const tab = store.state.tabs[tabId]
    if (!tab) return
    const showing = windows.windowOfTab(tabId)
    if (showing) {
      // A tab in a window's layout gets selected there (its pane, in a split); a Peek or Mini Window
      // just comes forward.
      if (!tab.floating) void commands.run('tabs.activate', { tabId }, { windowId: showing }).catch(() => {})
      raise(windows.get(showing))
      return
    }
    const windowId = windowFor(tabId)
    if (!windowId) return
    void commands.run('tabs.activate', { tabId }, { windowId }).catch(() => {})
    raise(windows.get(windowId))
  }

  ipcMain.on(PAGE_CHANNEL.notificationClick, (event: IpcMainEvent) => {
    const contents = event.sender
    const tabId = tabs.tabIdFor(contents)
    if (tabId) bringForward(tabId)
    // A pop-up window's page: its window comes forward.
    else raise(BrowserWindow.fromWebContents(contents) ?? undefined)
  })
}
