import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import { ACTIONS_BY_ID, shortcutsFor, toElectronAccelerator } from '../shared/actions'
import type { MainContext } from './context'

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
  const item = (id: string, label?: string): MenuItemConstructorOptions => {
    const action = ACTIONS_BY_ID[id]
    const accel = action ? shortcutsFor(action, 'darwin')[0] : undefined
    return {
      label: label ?? action?.title ?? id,
      accelerator: accel ? toElectronAccelerator(accel) : undefined,
      click: () => {
        const windowId = ctx.windows.focusedWindowId()
        // With a page's popup or detached DevTools focused, Close Tab closes that window instead.
        if (!windowId && id === 'tab.close' && ctx.windows.closeFocusedForeign()) return
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
        { type: 'separator' },
        item('tab.close'),
        { role: 'close', label: 'Close Window', accelerator: 'Command+Shift+W' },
        item('tab.reopenClosed'),
        { type: 'separator' },
        item('page.print'),
      ],
    },
    { role: 'editMenu' },
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
        item('devtools.toggle'),
        item('page.viewSource'),
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
    { role: 'windowMenu' },
    {
      role: 'help',
      // Help and feedback (OB-13), release notes (UP-06) and build info (UP-07).
      submenu: [
        item('help.open', 'Orbit Help'),
        item('help.reportBug', 'Report a Bug…'),
        item('help.releaseNotes', 'Release Notes'),
        { type: 'separator' },
        { label: 'Troubleshooting', submenu: [item('help.copyBuildInfo')] },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
