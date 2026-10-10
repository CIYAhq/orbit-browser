import { app, BrowserWindow, nativeTheme, type Rectangle, screen } from 'electron'
import type { SettingsContext, SettingsReveal, SettingsTarget } from '../../shared/commands/settings'
import { DEFAULT_PROFILE_ID } from '../../shared/defaults'
import type { WindowId } from '../../shared/state'
import { NEUTRAL_THEME, paletteFor } from '../../shared/theme'
import type { MainContext } from '../context'
import { loadRenderer, rendererEntry, uiWebPreferences } from '../windows'
import { SECTION_ID_RE } from './normalize'

/**
 * The Settings window's id for IPC, shortcuts and actions. It is not a browser window: there is no
 * WindowState for it, and commands it sends carry this id.
 */
export const SETTINGS_WINDOW_ID = 'w-settings'

const DEFAULT_SIZE = { width: 800, height: 600 }
const MIN_SIZE = { width: 600, height: 420 }
const isMac = process.platform === 'darwin'

/**
 * The one Settings window (ST-01). Opening it again brings the same window to the front, at the
 * requested section. It remembers its size; the section it shows is `settings.settingsSection`.
 *
 * It costs nothing while left open in the background: its renderer keeps Chromium's background
 * throttling, and its view reads only the settings it shows (narrow selectors), so browsing in
 * other windows doesn't render it.
 */
export class SettingsWindow {
  private win: BrowserWindow | undefined
  /** The browser window Settings was last opened from: its Space's theme, its profile. */
  private openerId: WindowId | undefined
  private openerProfile: string | undefined
  private target: SettingsTarget = {}
  private nonce = 0
  private saveTimer: NodeJS.Timeout | undefined
  private crashes: number[] = []

  constructor(private readonly ctx: MainContext) {
    nativeTheme.on('updated', () => this.applyBackground())
    // Linux and Windows quit when the last browser window closes. Settings acts for a browser
    // window, so it doesn't keep Orbit running on its own: it closes with the last one.
    if (!isMac) {
      app.on('browser-window-created', (_event, win) => {
        win.once('closed', () => setImmediate(() => this.closeIfAlone()))
      })
    }
  }

  /** The open Settings window, if any. */
  get window(): BrowserWindow | undefined {
    return this.win && !this.win.isDestroyed() ? this.win : undefined
  }

  /** Which browser window and profile Settings acts for. */
  context(): SettingsContext {
    const state = this.ctx.store.state
    const windowId = this.browserWindow()
    const opener = windowId ? state.windows[windowId] : undefined
    const profile = this.openerProfile ? state.profiles[this.openerProfile] : undefined
    return {
      windowId: opener?.id,
      spaceId: opener?.spaceId,
      profileId: profile?.id ?? DEFAULT_PROFILE_ID,
    }
  }

  /** What the Settings view should show: sent again with a new nonce each time it is opened. */
  reveal(): SettingsReveal {
    return { target: this.target, context: this.context(), nonce: this.nonce }
  }

  /** A browser window to act in for Settings (new tabs, links): the opener, else the last used one. */
  browserWindow(): WindowId | undefined {
    const state = this.ctx.store.state
    if (this.openerId && state.windows[this.openerId] && this.ctx.windows.get(this.openerId)) return this.openerId
    const ids = this.ctx.windows.ids().filter((id) => state.windows[id]?.kind === 'main')
    return ids[ids.length - 1]
  }

  open(target: SettingsTarget, from: WindowId | undefined): void {
    const state = this.ctx.store.state
    const opener = from && from !== SETTINGS_WINDOW_ID ? state.windows[from] : undefined
    if (opener && opener.kind !== 'mini') {
      this.openerId = opener.id
      const profileId = state.spaces[opener.spaceId]?.profileId
      const profile = profileId ? state.profiles[profileId] : undefined
      // Private windows use an in-memory profile: their settings are the Default profile's.
      this.openerProfile = profile?.partition.startsWith('persist:') ? profile.id : DEFAULT_PROFILE_ID
    }
    const section = target.section && SECTION_ID_RE.test(target.section) ? target.section : undefined
    this.target = {
      ...(section ? { section } : {}),
      ...(target.item && SECTION_ID_RE.test(target.item) ? { item: target.item } : {}),
      ...(target.profileId && state.profiles[target.profileId] ? { profileId: target.profileId } : {}),
    }
    this.nonce++
    if (section && state.settings.settingsSection !== section) {
      this.ctx.store.update((d) => {
        d.settings.settingsSection = section
      })
    }
    const win = this.window
    if (win) {
      this.focus()
      if (!win.webContents.isLoading()) win.webContents.send('orbit:settings.reveal', this.reveal())
      return
    }
    this.create()
  }

  /** Tells the Settings page to read again what main doesn't keep in state (the default browser). */
  refresh(): void {
    const win = this.window
    if (win && !win.isDestroyed() && !win.webContents.isLoading()) win.webContents.send('orbit:settings.refresh')
  }

  focus(): void {
    const win = this.window
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  close(): void {
    this.window?.close()
  }

  private closeIfAlone(): void {
    const own = this.window
    if (!own) return
    const others = BrowserWindow.getAllWindows().filter((w) => w !== own && !w.isDestroyed() && w.isVisible())
    if (others.length === 0) own.close()
  }

  private create(): void {
    const win = new BrowserWindow({
      ...this.initialBounds(),
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      show: false,
      title: 'Settings',
      fullscreenable: false,
      backgroundColor: this.background(),
      ...(isMac
        ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 18 } }
        : { autoHideMenuBar: true }),
      // Background throttling stays on (the default): Settings left open costs no CPU.
      webPreferences: uiWebPreferences(SETTINGS_WINDOW_ID, 'settings'),
    })
    this.win = win
    const contents = win.webContents
    this.ctx.windows.registerUi(contents, SETTINGS_WINDOW_ID)
    this.ctx.windows.attachShortcuts(contents)
    // Orbit's own UI never navigates away or opens windows (links open as tabs through commands).
    contents.on('will-navigate', (event, url) => {
      const entry = rendererEntry()
      if (!(entry.url && url.startsWith(entry.url))) event.preventDefault()
    })
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('render-process-gone', (_event, details) => {
      if (contents.isDestroyed() || details.reason === 'clean-exit') return
      const now = Date.now()
      this.crashes = this.crashes.filter((t) => now - t < 60_000)
      this.crashes.push(now)
      if (this.crashes.length > 3) return
      console.error(`[settings] the Settings renderer is gone (${details.reason}); reloading`)
      loadRenderer(contents, 'settings')
    })
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return
      win.show()
      win.focus()
    })
    win.on('resize', () => {
      clearTimeout(this.saveTimer)
      this.saveTimer = setTimeout(() => this.saveSize(win), 300)
    })
    win.on('close', () => {
      // While quitting, state has been saved already (the size was saved as it changed).
      if (!this.ctx.windows.quitting) this.saveSize(win)
    })
    win.once('closed', () => {
      clearTimeout(this.saveTimer)
      if (this.win === win) this.win = undefined
    })
    loadRenderer(contents, 'settings')
  }

  /** The remembered size, centred over the browser window it was opened from. */
  private initialBounds(): Rectangle {
    const saved = this.ctx.store.state.settings.settingsWindowSize ?? DEFAULT_SIZE
    const openerWin = this.openerId ? this.ctx.windows.get(this.openerId) : undefined
    const around = openerWin && !openerWin.isDestroyed() ? openerWin.getBounds() : undefined
    const area = (around ? screen.getDisplayMatching(around) : screen.getPrimaryDisplay()).workArea
    const width = Math.min(Math.max(saved.width, MIN_SIZE.width), area.width)
    const height = Math.min(Math.max(saved.height, MIN_SIZE.height), area.height)
    const centre = around
      ? { x: around.x + around.width / 2, y: around.y + around.height / 2 }
      : { x: area.x + area.width / 2, y: area.y + area.height / 2 }
    const x = Math.round(Math.min(Math.max(centre.x - width / 2, area.x), area.x + area.width - width))
    const y = Math.round(Math.min(Math.max(centre.y - height / 2, area.y), area.y + area.height - height))
    return { x, y, width, height }
  }

  private saveSize(win: BrowserWindow): void {
    clearTimeout(this.saveTimer)
    if (win.isDestroyed() || win.isMinimized() || win.isMaximized() || win.isFullScreen()) return
    const { width, height } = win.getNormalBounds()
    const saved = this.ctx.store.state.settings.settingsWindowSize
    if (saved && saved.width === width && saved.height === height) return
    this.ctx.store.update((d) => {
      d.settings.settingsWindowSize = { width, height }
    })
  }

  /** The window's native background (before the view paints, and while resizing). */
  private background(): string {
    const state = this.ctx.store.state
    const spaceId = this.context().spaceId ?? state.spaceOrder[0]
    const theme = (spaceId ? state.spaces[spaceId]?.theme : undefined) ?? NEUTRAL_THEME
    return paletteFor(theme, nativeTheme.shouldUseDarkColors).surface
  }

  private applyBackground(): void {
    this.window?.setBackgroundColor(this.background())
  }
}
