import { BrowserWindow, nativeTheme, type Rectangle, screen } from 'electron'
import type { ImportSession, ImportStart } from '../../shared/commands/import'
import type { WindowId } from '../../shared/state'
import { NEUTRAL_THEME, paletteFor } from '../../shared/theme'
import type { MainContext } from '../context'
import { guardOwnWindow } from '../settings/ui-window'
import { loadRenderer, uiWebPreferences } from '../windows'

/** The import window's id for IPC, shortcuts and actions (not a browser window). */
export const IMPORT_WINDOW_ID = 'w-import'

const SIZE = { width: 680, height: 600 }
const MIN_SIZE = { width: 560, height: 480 }
const isMac = process.platform === 'darwin'

/**
 * The import window (IM-01): one at a time, over the browser window it was opened from. It is that
 * window's child but not modal, so browsing goes on while an import runs (IM-14).
 */
export class ImportWindow {
  private win: BrowserWindow | undefined
  private openerId: WindowId | undefined
  private start: ImportStart | undefined
  private nonce = 0

  constructor(
    private readonly ctx: MainContext,
    private readonly session: () => Omit<ImportSession, 'start' | 'nonce'>,
  ) {
    nativeTheme.on('updated', () => this.window?.setBackgroundColor(this.background()))
  }

  get window(): BrowserWindow | undefined {
    return this.win && !this.win.isDestroyed() ? this.win : undefined
  }

  /** The browser window the import acts for: its opener while open, else the last one used. */
  browserWindow(): WindowId | undefined {
    const state = this.ctx.store.state
    if (this.openerId && state.windows[this.openerId] && this.ctx.windows.get(this.openerId)) return this.openerId
    const ids = this.ctx.windows.ids().filter((id) => state.windows[id]?.kind === 'main')
    return ids[ids.length - 1]
  }

  /** What the page shows: the start it was opened with, once. */
  takeSession(): ImportSession {
    const start = this.start
    this.start = undefined
    return { ...this.session(), ...(start ? { start } : {}), nonce: this.nonce }
  }

  open(from: WindowId | undefined, start?: ImportStart): void {
    const state = this.ctx.store.state
    if (from && state.windows[from]?.kind === 'main') this.openerId = from
    this.start = start
    this.nonce++
    const win = this.window
    if (win) {
      this.focus()
      if (start && !win.webContents.isLoading()) win.webContents.send('orbit:import.session', this.takeSession())
      return
    }
    this.create()
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

  private create(): void {
    const opener = this.openerId ? this.ctx.windows.get(this.openerId) : undefined
    const win = new BrowserWindow({
      ...this.initialBounds(opener),
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      show: false,
      title: 'Import',
      fullscreenable: false,
      minimizable: false,
      ...(opener && !opener.isDestroyed() ? { parent: opener } : {}),
      backgroundColor: this.background(),
      ...(isMac
        ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 16 } }
        : { autoHideMenuBar: true }),
      webPreferences: uiWebPreferences(IMPORT_WINDOW_ID, 'import'),
    })
    this.win = win
    const contents = win.webContents
    this.ctx.windows.registerUi(contents, IMPORT_WINDOW_ID)
    this.ctx.windows.attachShortcuts(contents)
    guardOwnWindow(contents, 'import')
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return
      win.show()
      win.focus()
    })
    win.once('closed', () => {
      if (this.win === win) this.win = undefined
      // Back to the browser window it was opened over.
      const back = this.browserWindow()
      const target = back ? this.ctx.windows.get(back) : undefined
      if (target && !target.isDestroyed() && !this.ctx.windows.quitting) target.focus()
    })
    loadRenderer(contents, 'import')
  }

  /** Centred over the browser window it was opened from. */
  private initialBounds(opener: BrowserWindow | undefined): Rectangle {
    const around = opener && !opener.isDestroyed() ? opener.getBounds() : undefined
    const area = (around ? screen.getDisplayMatching(around) : screen.getPrimaryDisplay()).workArea
    const width = Math.min(SIZE.width, area.width)
    const height = Math.min(SIZE.height, area.height)
    const centre = around
      ? { x: around.x + around.width / 2, y: around.y + around.height / 2 }
      : { x: area.x + area.width / 2, y: area.y + area.height / 2 }
    const x = Math.round(Math.min(Math.max(centre.x - width / 2, area.x), area.x + area.width - width))
    const y = Math.round(Math.min(Math.max(centre.y - height / 2, area.y), area.y + area.height - height))
    return { x, y, width, height }
  }

  private background(): string {
    const state = this.ctx.store.state
    const windowId = this.browserWindow()
    const spaceId = (windowId ? state.windows[windowId]?.spaceId : undefined) ?? state.spaceOrder[0]
    const theme = (spaceId ? state.spaces[spaceId]?.theme : undefined) ?? NEUTRAL_THEME
    return paletteFor(theme, nativeTheme.shouldUseDarkColors).surface
  }
}
