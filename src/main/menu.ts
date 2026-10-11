import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { ACTIONS_BY_ID, borrowedShortcutsFor, shortcutsFor, toElectronAccelerator } from '../shared/actions'
import { editsText } from '../shared/keymap'
import { keepForMenu } from './archive/menus'
import { recentlyClosedItems } from './archive/recently-closed'
import type { MainContext } from './context'
import { keyRouter } from './keys/router'

/**
 * The macOS menu bar, built from the shared action list so menu labels and
 * shortcuts always match the keymap. Key presses are handled by the
 * before-input-event router (which suppresses the menu's own accelerator), so
 * the accelerators here are for display and for clicks.
 * Linux/Windows get no menu bar (Orbit's UI provides everything).
 */
export function installMenu(ctx: MainContext): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  const windowShown = anyWindowShown()
  const item = (id: string, label?: string): MenuItemConstructorOptions => {
    const action = ACTIONS_BY_ID[id]
    const own = action ? shortcutsFor(action, 'darwin')[0] : undefined
    // Keys lent by another action (⌘O for Open File where there is no Peek, KS-12) are shown too.
    const lent = own || !action ? undefined : borrowedShortcutsFor(action, 'darwin')?.keys[0]
    const accel = own ?? lent
    return {
      label: label ?? action?.title ?? id,
      accelerator: accel ? toElectronAccelerator(accel) : undefined,
      // A binding that types or edits text (KS-16) is only shown: the router runs it outside text
      // fields, and the menu must not take it from one. So are lent keys while a window is shown:
      // the router picks the action. With none, the menu is all there is, and ⌘O opens a file (KS-12).
      ...(accel && ((lent && windowShown) || editsText(accel, 'darwin')) ? { registerAccelerator: false } : {}),
      click: () => {
        // A key let through to a page that left it alone reaches the menu too: it runs once (KS-02).
        if (!keyRouter.menuRuns(id)) return
        const windowId = ctx.windows.focusedWindowId()
        // With a page's popup or detached DevTools focused, Close Tab closes that window instead.
        if (!windowId && (id === 'tab.close' || id === 'window.close') && ctx.windows.closeFocusedForeign()) return
        void ctx.actions.run(id, { windowId })
      },
    }
  }
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        // About opens Settings → About (ST-17, UP-07), with the update check (UP-03); ST-03's default browser.
        item('settings.about', 'About Orbit'),
        item('app.checkForUpdates', 'Check for Updates…'),
        { type: 'separator' },
        item('app.settings', 'Settings…'),
        item('settings.defaultBrowser', 'Set as Default Browser…'),
        // The import flow (import lane, IM-01).
        item('app.import', 'Import from Another Browser…'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: 'Hide Orbit' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit Orbit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        item('tab.new'),
        item('window.new'),
        item('window.newMini'),
        item('window.newPrivate'),
        item('file.open'),
        { type: 'separator' },
        item('tab.close'),
        item('window.close'),
        item('tab.reopenClosed'),
        // The last ~10 closed tabs (archive lane, AR-09); rebuilt as tabs close and come back.
        { label: 'Recently Closed', submenu: recentlyClosedItems(ctx) },
        { type: 'separator' },
        // Anti-lock-in (import lane, IM-17).
        item('app.exportPinned', 'Export Pinned Items as Bookmarks…'),
        { type: 'separator' },
        item('page.print'),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        // Find in page (NV-05).
        {
          label: 'Find',
          submenu: [
            item('page.find', 'Find…'),
            item('page.findNext'),
            item('page.findPrevious'),
            item('page.jumpToSelection'),
          ],
        },
        { type: 'separator' },
        { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] },
      ],
    },
    {
      label: 'View',
      submenu: [
        item('sidebar.toggle'),
        item('url.edit'),
        { type: 'separator' },
        item('nav.reload'),
        item('nav.hardReload'),
        { type: 'separator' },
        item('page.zoomReset'),
        item('page.zoomIn'),
        item('page.zoomOut'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        // View → Developer (DT-01, DT-02, DT-04).
        {
          label: 'Developer',
          submenu: [
            item('devtools.toggle'),
            item('devtools.console'),
            item('devtools.inspect'),
            { type: 'separator' },
            item('page.viewSource'),
          ],
        },
      ],
    },
    {
      label: 'Tabs',
      submenu: [
        item('tab.next'),
        item('tab.previous'),
        { type: 'separator' },
        item('tab.togglePin'),
        item('tab.duplicate'),
        item('tab.copyUrl'),
        item('tab.toggleMute'),
        { type: 'separator' },
        item('folder.new'),
        item('tabs.clearToday'),
        { type: 'separator' },
        item('split.add'),
      ],
    },
    {
      label: 'Spaces',
      submenu: [item('space.new'), { type: 'separator' }, item('space.next'), item('space.previous')],
    },
    // Archive → View Archive, View History, the Library they live in, Clear Archive… and how long
    // entries are kept (archive lane, AR-02, AR-10, AR-07, AR-08).
    {
      label: 'Archive',
      submenu: [
        item('app.archive'),
        item('app.history'),
        item('app.library'),
        { type: 'separator' },
        item('archive.clear'),
        // A shorter time that deletes entries asks first; until then the check stays where it was.
        keepForMenu(ctx, { refresh: () => installMenu(ctx) }),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      // Help and feedback (OB-13), release notes (UP-06), Restore Data… (AR-11) and build info (UP-07).
      submenu: [
        item('help.open', 'Orbit Help'),
        // The essential shortcuts (OB-12).
        item('help.shortcuts'),
        item('help.reportBug', 'Report a Bug…'),
        item('help.releaseNotes', 'Release Notes'),
        { type: 'separator' },
        item('app.restoreData'),
        { label: 'Troubleshooting', submenu: [item('help.copyBuildInfo')] },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * Whether an Orbit window is on screen. Key presses in one go through the key router
 * (src/main/windows.ts `attachShortcuts`); with none, only the menu bar sees them (KS-12).
 */
function anyWindowShown(): boolean {
  return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible() && !w.isMinimized())
}

let watching = false

/**
 * macOS: builds the menu bar again when the last Orbit window leaves the screen, and when one comes
 * back, so that the keys the menu only shows while a window is up (⌘O for Open File…) work from the
 * menu with none (KS-12).
 */
export function watchWindowsForMenu(ctx: MainContext): void {
  if (process.platform !== 'darwin' || watching) return
  watching = true
  let shown = anyWindowShown()
  const check = () => {
    // Once Electron has the window's new state.
    setImmediate(() => {
      const now = anyWindowShown()
      if (now === shown) return
      shown = now
      installMenu(ctx)
    })
  }
  app.on('browser-window-created', (_event, win) => {
    win.on('show', check)
    win.on('hide', check)
    win.on('minimize', check)
    win.on('restore', check)
    win.on('closed', check)
    check()
  })
}
