import { mkdirSync, renameSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
  type SaveDialogOptions,
  type Session,
  type WebContents,
} from 'electron'
import { DOWNLOADS_FLYOUT_PANEL } from '../../shared/commands/downloads'
import { DEFAULT_PROFILE_ID } from '../../shared/defaults'
import type { Profile, ProfileId, Settings, TabId, WindowId } from '../../shared/state'
import { sectionOf } from '../../shared/tree'
import type { MainContext } from '../context'
import type { CallContext } from '../registry'
import { activeTabOf } from '../windows'
import { type DockHooks, showDownloadsInDock } from './dock'
import { copyFileToClipboard, type FileActions, systemFiles } from './files'
import { DownloadsLibrary, dragIcon, isScreenshotId } from './library'
import { type DownloadFeedback, DownloadManager, type SaveLocation } from './manager'
import { downloadMenu, fileMenu } from './menu'
import { askToQuit, guardQuit, quitQuestion } from './quit'
import { readMacScreenshotLocation, type ScreenshotFolder, screenshotFolders } from './screenshots'
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
 * - `dragged`: files dragged out of Orbit (DL-06); test runs never start the OS's drag.
 * - `screenshots`: the folder test runs take the OS's screenshots from (DL-05, DL-11).
 * - `platform`: the OS the Downloads keys act as on (DL-14), to try macOS's on another.
 * - `saveDialogs`, `answerSave`: the save dialogs shown (DL-07), where each opened (and the folder it
 *   asked instead of), and answering the oldest still open: a path, or null for Cancel.
 * - `pickFolder`: what the folder picker (Download location → Other…, DL-07) answers next, a folder
 *   or null for Cancel; `folderPicks`, where each opened.
 * - `dock`: the Dock and taskbar progress, bounces and notifications (DL-17); `dock.focused` says
 *   whether Orbit is in front.
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
  dragged: string[]
  screenshots: string
  platform?: NodeJS.Platform
  saveDialogs: { defaultPath: string; unavailable?: string }[]
  answerSave: (path: string | null) => boolean
  pickFolder?: string | null
  folderPicks: string[]
  dock: DockHooks
}

/**
 * Downloads (DL-01 to DL-08, DL-10 to DL-17): every profile session's downloads go to that profile's
 * download folder, or where the save dialog chooses (DL-07); the sidebar (and the Dock, DL-17) shows
 * them while they run, the Library's Downloads and Media sections afterwards.
 * Main-process API for other features: `registerDownloads(ctx)` returns the DownloadManager.
 */
export function registerDownloads(ctx: MainContext): DownloadManager {
  const { store, commands, windows, sessions } = ctx
  // Test runs never write to the real Downloads folder.
  const defaultFolder =
    process.env.ORBIT_DOWNLOADS_DIR || (ctx.e2e ? join(ctx.paths.userData, 'Downloads') : app.getPath('downloads'))
  // Download location, per profile (DL-07): Settings → Profiles → [profile] → Download location.
  const location = (profileId: ProfileId): SaveLocation => {
    const p = store.state.profiles[profileId]
    return {
      folder: p?.downloadFolder ?? defaultFolder,
      ask: p?.downloadAsk === true,
      ...(p?.downloadAskFolder ? { askFolder: p.downloadAskFolder } : {}),
      fallback: defaultFolder,
    }
  }
  const changeProfile = (profileId: ProfileId, change: (p: Profile) => void) =>
    store.update((d) => {
      const p = d.profiles[profileId]
      if (p) change(p)
    })
  /** Save dialogs open in test runs, oldest first: answering one resolves it. */
  const openSaves: ((path: string | undefined) => void)[] = []
  /** The OS save dialog for a download (DL-07), over its window. */
  const askWhere = async (windowId: WindowId | undefined, defaultPath: string, unavailable?: string) => {
    if (ctx.e2e) {
      hooks.saveDialogs.push(unavailable ? { defaultPath, unavailable } : { defaultPath })
      return new Promise<string | undefined>((resolve) => openSaves.push(resolve))
    }
    const options: SaveDialogOptions = unavailable
      ? {
          defaultPath,
          title: 'Choose Where to Save',
          message: `The download folder ${unavailable} can’t be used. Choose where to save this file.`,
        }
      : { defaultPath }
    const win = windowId ? windows.get(windowId) : undefined
    const { canceled, filePath } =
      win && !win.isDestroyed() ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    return canceled || !filePath ? undefined : filePath
  }
  /** The OS folder picker for a profile's download folder (DL-07), over the window asking. */
  const pickFolder = async (sender: WebContents | undefined, current: string): Promise<string | undefined> => {
    if (ctx.e2e) {
      hooks.folderPicks.push(current)
      const answer = hooks.pickFolder ?? undefined
      hooks.pickFolder = undefined
      return answer
    }
    const options: OpenDialogOptions = {
      title: 'Download Location',
      defaultPath: current,
      buttonLabel: 'Select',
      properties: ['openDirectory', 'createDirectory'],
    }
    const win = sender && !sender.isDestroyed() ? BrowserWindow.fromWebContents(sender) : null
    const { canceled, filePaths } = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return canceled ? undefined : filePaths[0]
  }

  let lastMenu: MenuItemConstructorOptions[] = []
  /** Shows a menu at the pointer, over a window (test runs keep it for the hooks instead). */
  const popup = (template: MenuItemConstructorOptions[], windowId: WindowId | undefined) => {
    lastMenu = template
    if (ctx.e2e) return
    const win = windowId ? windows.get(windowId) : undefined
    Menu.buildFromTemplate(template).popup(win ? { window: win } : undefined)
  }
  const hooks: DownloadTestHooks = {
    asked: [],
    folder: (profileId) => location(profileId ?? DEFAULT_PROFILE_ID).folder,
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
    dragged: [],
    screenshots: process.env.ORBIT_SCREENSHOTS_DIR || join(ctx.paths.userData, 'Screenshots'),
    saveDialogs: [],
    answerSave: (path) => {
      const answer = openSaves.shift()
      answer?.(path ?? undefined)
      return !!answer
    },
    folderPicks: [],
    dock: { progress: null, bounces: 0, notifications: [] },
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
          : event === 'held'
            ? `${d.filename} can harm your computer: keep or discard it in Downloads`
            : `Couldn't download ${d.filename}`
    ctx.toast(target, message)
  }
  // Right after a download, the Library opens on Downloads (DL-09).
  const libraryOnDownloads = async (windowId: WindowId | undefined) => {
    const target = mainWindow(windowId)
    if (!target || !commands.has('library.setSection')) return
    const status = await commands.run('library.status', {}, { windowId: target })
    if (!status.open) await commands.run('library.setSection', { section: 'downloads' }, { windowId: target })
  }

  const dock = showDownloadsInDock(ctx, ctx.e2e ? hooks.dock : undefined)
  const manager: DownloadManager = new DownloadManager(
    ctx,
    new DownloadStore(join(ctx.paths.userData, 'downloads.json')),
    {
      location,
      askWhere,
      askedIn: (profileId, folder) =>
        changeProfile(profileId, (p) => {
          if (p.downloadAskFolder !== folder) p.downloadAskFolder = folder
        }),
      feedback: (windowId, event, d) => {
        feedback(windowId, event, d)
        if (event === 'started') void libraryOnDownloads(windowId).catch(() => {})
        if (event === 'done') dock.finished(manager.get(d.id)?.private ? undefined : d.filename)
      },
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
  // The OS's screenshots (DL-05, DL-11): test runs read a folder of their own.
  const screenshotPlaces = async (): Promise<ScreenshotFolder[]> => {
    if (ctx.e2e || process.env.ORBIT_SCREENSHOTS_DIR) return [{ path: hooks.screenshots, all: false }]
    const paths = { home: app.getPath('home'), desktop: app.getPath('desktop'), pictures: app.getPath('pictures') }
    const macLocation = process.platform === 'darwin' ? await readMacScreenshotLocation() : undefined
    return screenshotFolders(process.platform, paths, macLocation)
  }
  const library = new DownloadsLibrary(ctx, manager, {
    files,
    screenshotFolders: screenshotPlaces,
    startDrag: (sender, path) => {
      if (ctx.e2e) {
        hooks.dragged.push(path)
        return
      }
      sender.startDrag({ file: path, icon: dragIcon() })
    },
    mainWindow,
    notify: (windowId, message) => ctx.toast(mainWindow(windowId), message),
  })

  const copyFile = async (id: string): Promise<boolean> => {
    const path = library.pathOf(id)
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
  commands.register('downloads.open', ({ id }, c) => library.open(id, c.windowId))
  commands.register('downloads.preview', ({ id, tab }, c) => library.preview(id, tab === true, c.windowId))
  commands.register('downloads.showInFolder', ({ id }) => library.showInFolder(id))
  commands.register('downloads.copyFile', ({ id }) => copyFile(id))
  commands.register('downloads.copyLink', ({ id }) => copyLink(id))
  commands.register('downloads.drag', ({ id }, c) => library.drag(id, c.sender))
  commands.register('downloads.keep', ({ id }, c) => manager.keep(id, c.windowId))
  commands.register('downloads.discard', ({ id }) => manager.discard(id))
  commands.register('downloads.media', ({ profileId, limit }, c) => library.media(profileOf(profileId, c), limit))
  commands.register('downloads.recent', ({ limit }, c) => library.recent(profileOf(undefined, c), limit))
  commands.register('downloads.remove', ({ id }) => manager.remove(id))
  commands.register('downloads.delete', ({ id }, c) => manager.trash(id, c.windowId))
  commands.register('downloads.clear', ({ profileId }, c) => manager.clear(profileOf(profileId, c)))
  commands.register('downloads.pause', ({ id }) => manager.pause(id))
  commands.register('downloads.resume', ({ id }) => manager.resume(id))
  commands.register('downloads.retry', ({ id }) => manager.retry(id))
  commands.register('downloads.menu', ({ id }, c) => {
    const windowId = c.windowId
    if (isScreenshotId(id)) {
      if (!library.pathOf(id)) return
      popup(
        fileMenu({
          open: () => void library.open(id, windowId),
          showInFolder: () => void library.showInFolder(id),
          copyFile: () => void copyFile(id),
        }),
        windowId,
      )
      return
    }
    const record = manager.get(id)
    if (!record) return
    const menu = downloadMenu(manager.entry(record), {
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
      keep: () => void manager.keep(id, windowId),
      discard: () => manager.discard(id),
    })
    popup(menu, windowId)
  })

  // The Library button's right-click menu (DL-05, DL-11): what its popover and the Media section show.
  const setSettings = (change: (s: Settings) => void) => store.update((d) => change(d.settings))
  commands.register('downloads.libraryMenu', (_args, c) => {
    const { recentFiles, libraryScreenshots } = store.state.settings
    popup(
      [
        { label: 'Recent Files', enabled: false },
        {
          label: 'Downloads',
          type: 'checkbox',
          checked: recentFiles.downloads,
          click: () =>
            setSettings((s) => {
              s.recentFiles = { ...s.recentFiles, downloads: !recentFiles.downloads }
            }),
        },
        {
          label: 'Screenshots',
          type: 'checkbox',
          checked: recentFiles.screenshots,
          click: () =>
            setSettings((s) => {
              s.recentFiles = { ...s.recentFiles, screenshots: !recentFiles.screenshots }
            }),
        },
        { type: 'separator' },
        {
          label: 'Show Screenshots in Library',
          type: 'checkbox',
          checked: libraryScreenshots,
          click: () =>
            setSettings((s) => {
              s.libraryScreenshots = !libraryScreenshots
            }),
        },
      ],
      c.windowId,
    )
  })

  // The downloads flyout (DL-14, Windows and Linux): over the window's top left; again closes it.
  const toggleFlyout = (windowId: WindowId | undefined) => {
    const target = mainWindow(windowId)
    if (!target) return
    const overlay = store.state.windows[target]?.overlay
    if (overlay?.kind === 'panel' && overlay.panel === DOWNLOADS_FLYOUT_PANEL) {
      void commands.run('overlay.close', {}, { windowId: target })
      return
    }
    void commands.run(
      'overlay.open',
      { overlay: { kind: 'panel', panel: DOWNLOADS_FLYOUT_PANEL } },
      { windowId: target },
    )
  }
  commands.register('downloads.flyout', (_args, c) => toggleFlyout(c.windowId))

  commands.register('downloads.location', ({ profileId }, c) => {
    const { folder, ask } = location(profileOf(profileId, c))
    return { folder, ask }
  })
  commands.register('downloads.setAsk', ({ profileId, ask }) =>
    changeProfile(profileId, (p) => {
      if (ask) p.downloadAsk = true
      else delete p.downloadAsk
    }),
  )
  commands.register('downloads.chooseFolder', async ({ profileId }, c) => {
    if (!store.state.profiles[profileId]) return null
    const folder = await pickFolder(c.sender, location(profileId).folder)
    if (!folder || !store.state.profiles[profileId]) return null
    changeProfile(profileId, (p) => {
      p.downloadFolder = folder
      delete p.downloadAsk
    })
    return folder
  })
  // ⌘⇧J / ⌥⌘L on macOS: the Library's Downloads section; Ctrl+J elsewhere: the flyout (DL-14).
  ctx.actions.register('app.downloads', (c) => {
    if ((hooks.platform ?? process.platform) !== 'darwin') {
      toggleFlyout(c.windowId)
      return
    }
    const target = mainWindow(c.windowId)
    if (target) void commands.run('library.open', { section: 'downloads' }, { windowId: target })
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
