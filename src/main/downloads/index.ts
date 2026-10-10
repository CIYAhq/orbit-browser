import { mkdirSync, renameSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app, type BrowserWindow, clipboard, Menu, type MenuItemConstructorOptions, type Session } from 'electron'
import { DEFAULT_PROFILE_ID } from '../../shared/defaults'
import type { ProfileId, TabId, WindowId } from '../../shared/state'
import { sectionOf } from '../../shared/tree'
import type { MainContext } from '../context'
import type { CallContext } from '../registry'
import { activeTabOf } from '../windows'
import { copyFileToClipboard, type FileActions, systemFiles } from './files'
import { type DownloadFeedback, DownloadManager } from './manager'
import { downloadMenu } from './menu'
import { askToQuit, guardQuit, quitQuestion } from './quit'
import { DownloadStore } from './store'

/**
 * Test-only handle (ORBIT_E2E=1): globalThis.__orbitDownloads.
 * - `quitAnswer`: what the user answers when quitting would stop downloads. Unset, test runs
 *   never ask (so `app.close()` always quits).
 * - `asked`: the questions asked so far.
 * - `opened`, `shown`: files "opened with their app" and "shown in their folder"; test runs never
 *   start another app.
 * - `trash`: the test runs' Trash (a folder in userData); `trashFails` makes moving there fail.
 * - `menu`, `clickMenu`: the last download menu's labels, and clicking one (the menu never shows).
 */
export interface DownloadTestHooks {
  quitAnswer?: 'quit' | 'cancel'
  asked: string[]
  folder: (profileId?: ProfileId) => string
  settle: () => Promise<void>
  opened: string[]
  shown: string[]
  trash: string
  trashFails?: boolean
  menu: () => string[]
  clickMenu: (label: string) => boolean
}

/**
 * Downloads (DL-01 to DL-04, DL-08, DL-15, DL-16): every profile session's downloads go to that
 * profile's download folder; the sidebar shows them while they run.
 * Main-process API for other features: `registerDownloads(ctx)` returns the DownloadManager.
 */
export function registerDownloads(ctx: MainContext): DownloadManager {
  const { store, commands, windows, sessions } = ctx
  // Test runs never write to the real Downloads folder.
  const defaultFolder =
    process.env.ORBIT_DOWNLOADS_DIR || (ctx.e2e ? join(ctx.paths.userData, 'Downloads') : app.getPath('downloads'))
  const folder = (_profileId?: ProfileId) => defaultFolder

  let lastMenu: MenuItemConstructorOptions[] = []
  const hooks: DownloadTestHooks = {
    asked: [],
    folder: (profileId) => folder(profileId ?? DEFAULT_PROFILE_ID),
    settle: () => manager.list.settle(),
    opened: [],
    shown: [],
    trash: join(ctx.paths.userData, 'Trash'),
    menu: () => lastMenu.filter((i) => i.label).map((i) => i.label as string),
    clickMenu: (label) => {
      const item = lastMenu.find((i) => i.label === label && i.enabled !== false)
      ;(item?.click as (() => void) | undefined)?.()
      return !!item?.click
    },
  }
  const files: FileActions = ctx.e2e
    ? {
        openPath: async (path) => {
          hooks.opened.push(path)
          return ''
        },
        showItemInFolder: (path) => void hooks.shown.push(path),
        trashItem: async (path) => {
          if (hooks.trashFails) throw new Error('the Trash is unavailable (test)')
          mkdirSync(hooks.trash, { recursive: true })
          renameSync(path, join(hooks.trash, `${Date.now()}-${basename(path)}`))
        },
      }
    : systemFiles

  /** The main window feedback goes to: a Mini Window has no sidebar, its main window shows its downloads. */
  const mainWindow = (windowId: WindowId | undefined): WindowId | undefined => {
    const isMain = (id: WindowId | undefined) => !!id && store.state.windows[id]?.kind === 'main'
    if (isMain(windowId)) return windowId
    const focused = windows.focusedWindowId()
    if (isMain(focused)) return focused
    return windows.ids().filter(isMain).pop()
  }
  const feedback = (windowId: WindowId | undefined, event: DownloadFeedback, d: { id: string; filename: string }) => {
    const target = mainWindow(windowId)
    const win = target ? store.state.windows[target] : undefined
    if (!target || !win) return
    // The sidebar shows downloads (DL-02, DL-03); where it's hidden, a toast says what happened.
    if (win.sidebar.visible || win.sidebar.peeking) {
      if (event === 'started') windows.sendToWindow(target, 'downloads.started', d)
      return
    }
    const message =
      event === 'started'
        ? `Downloading ${d.filename}`
        : event === 'done'
          ? `Downloaded ${d.filename}`
          : `Couldn't download ${d.filename}`
    ctx.toast(target, message)
  }

  const manager: DownloadManager = new DownloadManager(
    ctx,
    new DownloadStore(join(ctx.paths.userData, 'downloads.json')),
    {
      folder,
      feedback,
      notify: (windowId, message) => ctx.toast(mainWindow(windowId), message),
      closeBlankTab: (tabId) => closeBlankTab(ctx, tabId),
      changed: (profileId) => windows.broadcast('orbit:downloads.changed', { profileId }),
      session: (profileId) => sessions.get(profileId),
      files,
      openInTab: (url, windowId) =>
        void commands.run('tabs.create', { url, activate: true }, { windowId: mainWindow(windowId) }),
    },
  )
  sessions.onSessionCreated((ses, profileId) => manager.attach(ses, profileId))
  // Sessions that aren't a profile's (a private window's) download too.
  app.on('session-created', (ses) => manager.attach(ses))
  trackPrivateSessions(manager)
  // Downloads cut off by the last quit: Resume or Retry (DL-15).
  setImmediate(() => manager.restore())

  const profileOf = (profileId: ProfileId | undefined, c: CallContext): ProfileId => {
    if (profileId && store.state.profiles[profileId]) return profileId
    const windowId: WindowId | undefined = c.windowId ?? windows.focusedWindowId()
    const win = windowId ? store.state.windows[windowId] : undefined
    return (win && store.state.spaces[win.spaceId]?.profileId) || DEFAULT_PROFILE_ID
  }
  const copyFile = async (id: string): Promise<boolean> => {
    const path = manager.finishedFile(id)
    if (!path) return false
    await copyFileToClipboard(path)
    return true
  }
  const copyLink = async (id: string): Promise<void> => {
    const record = manager.get(id)
    if (record) await clipboard.writeText(record.url)
  }

  commands.register('downloads.list', ({ profileId, limit }, c) => manager.entries(profileOf(profileId, c), limit))
  commands.register('downloads.cancel', ({ id }) => manager.cancel(id))
  commands.register('downloads.dismiss', ({ id }) => manager.dismiss(id))
  commands.register('downloads.active', () => manager.activeCount())
  commands.register('downloads.open', ({ id }, c) => manager.open(id, c.windowId))
  commands.register('downloads.showInFolder', ({ id }) => manager.showInFolder(id))
  commands.register('downloads.copyFile', ({ id }) => copyFile(id))
  commands.register('downloads.copyLink', ({ id }) => copyLink(id))
  commands.register('downloads.remove', ({ id }) => manager.remove(id))
  commands.register('downloads.delete', ({ id }, c) => manager.trash(id, c.windowId))
  commands.register('downloads.clear', ({ profileId }, c) => manager.clear(profileOf(profileId, c)))
  commands.register('downloads.pause', ({ id }) => manager.pause(id))
  commands.register('downloads.resume', ({ id }) => manager.resume(id))
  commands.register('downloads.retry', ({ id }) => manager.retry(id))
  commands.register('downloads.menu', ({ id }, c) => {
    const record = manager.get(id)
    if (!record) return
    const windowId = c.windowId
    lastMenu = downloadMenu(manager.entry(record), {
      open: () => void manager.open(id, windowId),
      showInFolder: () => void manager.showInFolder(id),
      copyFile: () => void copyFile(id),
      copyLink: () => void copyLink(id),
      pause: () => manager.pause(id),
      // One that can't continue any more starts again.
      resume: () => {
        if (!manager.resume(id)) manager.retry(id)
      },
      retry: () => manager.retry(id),
      cancel: () => manager.cancel(id),
      remove: () => manager.remove(id),
      delete: () => void manager.trash(id, windowId),
    })
    if (ctx.e2e) return
    const win = windowId ? windows.get(windowId) : undefined
    Menu.buildFromTemplate(lastMenu).popup(win ? { window: win } : undefined)
  })

  // Quitting with downloads in progress asks first (DL-01).
  guardQuit({
    active: () => (ctx.e2e && !hooks.quitAnswer ? 0 : manager.activeCount()),
    ask: (count: number, parent: BrowserWindow | undefined) => {
      if (!ctx.e2e) return askToQuit(count, parent)
      hooks.asked.push(quitQuestion(count))
      return Promise.resolve(hooks.quitAnswer === 'quit')
    },
    onQuit: () => manager.quit(),
    lastWindowQuits: process.platform !== 'darwin',
  })
  if (ctx.e2e) (globalThis as unknown as { __orbitDownloads: DownloadTestHooks }).__orbitDownloads = hooks
  return manager
}

/**
 * A private window's downloads are listed until it closes (DL-16). Until Orbit has private windows,
 * a private session's "window" is its pages: when the last one closes, its downloads leave the list.
 */
function trackPrivateSessions(manager: DownloadManager): void {
  const pages = new Map<Session, number>()
  app.on('web-contents-created', (_event, contents) => {
    const ses = contents.session
    if (ses.isPersistent()) return
    pages.set(ses, (pages.get(ses) ?? 0) + 1)
    manager.privateSessionOpened(ses)
    contents.once('destroyed', () => {
      const left = (pages.get(ses) ?? 1) - 1
      if (left > 0) {
        pages.set(ses, left)
        return
      }
      pages.delete(ses)
      manager.privateSessionClosed(ses)
    })
  })
}

/**
 * A tab opened only for a download never showed a page: it closes, and the tab it was opened from
 * is selected again (DL-01, NV-09). A Peek or Mini Window opened for one closes too. Pinned tabs and
 * Favorites stay.
 */
function closeBlankTab(ctx: MainContext, tabId: TabId): void {
  const { store, commands, windows } = ctx
  const tab = store.state.tabs[tabId]
  if (!tab) return
  const windowId = windows.windowOfTab(tabId)
  if (tab.floating === 'peek') {
    if (windowId) void commands.run('peek.close', {}, { windowId })
    return
  }
  if (tab.floating === 'mini') {
    if (windowId) void commands.run('mini.control', { op: 'close' }, { windowId })
    return
  }
  if (sectionOf(store.state, tabId) !== 'today') return
  const wasShown = !!windowId && activeTabOf(store.state, windowId) === tabId
  const opener = tab.openerTabId && store.state.tabs[tab.openerTabId] ? tab.openerTabId : undefined
  // The tab's URL is the file's: the Archive gets no entry for a page that never showed.
  store.update((d) => {
    const t = d.tabs[tabId]
    if (t) t.url = 'about:blank'
  })
  // The opener first: closing the selected tab would select a neighbour on the way.
  const back = wasShown && opener ? commands.run('tabs.activate', { tabId: opener }, { windowId }) : undefined
  void Promise.resolve(back).then(() => commands.run('tabs.close', { tabId }, { windowId }))
}
