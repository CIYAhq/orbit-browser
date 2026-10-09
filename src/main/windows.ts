import { join } from 'node:path'
import { BrowserWindow, nativeTheme, screen, type WebContents, WebContentsView, webContents } from 'electron'
import { actionForInput } from '../shared/actions'
import { createWindowState } from '../shared/defaults'
import type { Rect, RendererView } from '../shared/rpc'
import type { OrbitState, TabId, WindowId, WindowState } from '../shared/state'
import { paletteFor } from '../shared/theme'
import { splitOfTab } from '../shared/tree'
import type { MainContext } from './context'

interface Pane {
  tabId: TabId
  rect: Rect
}

interface WindowRecord {
  id: WindowId
  win: BrowserWindow
  /** Created shortly after the shell first paints (see ensureOverlay), or on first use. */
  overlay?: WebContentsView
  /** Tabs whose views are currently drawn in this window. */
  visible: Set<TabId>
  panes: Pane[]
  radius: number
  /** Last single-pane content rect: lets tab switches swap views without a renderer round trip. */
  lastSingleRect?: Rect
  /** Ignore renderer pane reports older than this state sequence (after a main-side fast switch). */
  minPaneSeq: number
  overlayShown: boolean
}

const isMac = process.platform === 'darwin'

export function rendererEntry(): { url?: string; file: string } {
  return {
    url: process.env.ELECTRON_RENDERER_URL,
    file: join(import.meta.dirname, '../renderer/index.html'),
  }
}

export function preloadPath(): string {
  return join(import.meta.dirname, '../preload/shell.cjs')
}

export function loadRenderer(contents: WebContents, view: RendererView, query: Record<string, string> = {}): void {
  const entry = rendererEntry()
  const params = new URLSearchParams({ view, ...query })
  if (entry.url) void contents.loadURL(`${entry.url}?${params}`)
  else void contents.loadFile(entry.file, { query: Object.fromEntries(params) })
}

export function uiWebPreferences(windowId: WindowId, view: RendererView): Electron.WebPreferences {
  return {
    preload: preloadPath(),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    spellcheck: false,
    additionalArguments: [`--orbit-window-id=${windowId}`, `--orbit-view=${view}`],
  }
}

/** The active tab of a window's current space. */
export function activeTabOf(state: OrbitState, windowId: WindowId): TabId | null {
  const win = state.windows[windowId]
  if (!win) return null
  const tabId = win.activeTab[win.spaceId] ?? null
  return tabId && state.tabs[tabId] ? tabId : null
}

/**
 * Creates and lays out browser windows. Each window has:
 *  - the shell renderer (sidebar + frame) as the window's own web contents,
 *  - one WebContentsView per visible tab, positioned where the shell reports panes,
 *  - a transparent overlay view on top for the command bar, Peek chrome and menus.
 */
export class WindowManager {
  private records = new Map<WindowId, WindowRecord>()
  /** Orbit UI web contents (shell, overlay, settings…) → window. */
  private uiContents = new Map<number, WindowId>()
  /** Tab view → window it is attached to. */
  private attached = new Map<TabId, WindowId>()
  quitting = false
  private ctx!: MainContext

  init(ctx: MainContext): void {
    this.ctx = ctx
    ctx.store.subscribe((next, prev) => this.onState(next, prev))
    ctx.events.on('layout.panes', ({ panes, radius, seq }, { windowId }) => {
      if (!windowId) return
      const rec = this.records.get(windowId)
      if (!rec || seq < rec.minPaneSeq) return
      this.applyPanes(windowId, panes, radius)
    })
    nativeTheme.on('updated', () => {
      for (const rec of this.records.values()) this.applyBackground(rec)
    })
  }

  get(windowId: WindowId): BrowserWindow | undefined {
    return this.records.get(windowId)?.win
  }

  ids(): WindowId[] {
    return [...this.records.keys()]
  }

  /** Registers extra Orbit UI web contents (e.g. a settings window) so they receive state. */
  registerUi(contents: WebContents, windowId: WindowId): void {
    this.uiContents.set(contents.id, windowId)
    contents.once('destroyed', () => this.uiContents.delete(contents.id))
  }

  isUi(contents: WebContents): boolean {
    return this.uiContents.has(contents.id)
  }

  /** The window a tab's view is currently attached to. */
  windowOfTab(tabId: TabId): WindowId | undefined {
    return this.attached.get(tabId)
  }

  /** The Orbit window a web contents belongs to (UI renderer or attached tab). */
  windowIdFor(contents: WebContents): WindowId | undefined {
    const ui = this.uiContents.get(contents.id)
    if (ui) return ui
    const tabId = this.ctx.tabs.tabIdFor(contents)
    return tabId ? this.attached.get(tabId) : undefined
  }

  focusedWindowId(): WindowId | undefined {
    const focused = BrowserWindow.getFocusedWindow()
    for (const rec of this.records.values()) if (rec.win === focused) return rec.id
    // Fall back to the most recently created main window.
    const all = [...this.records.values()].filter((r) => !r.win.isDestroyed())
    return all[all.length - 1]?.id
  }

  /** Opens a window for an existing window state, or a new one showing `spaceId`. */
  open(existing?: WindowState, spaceId?: string): WindowId {
    const state = this.ctx.store.state
    let winState = existing
    if (!winState) {
      const space = spaceId ?? state.windows[this.focusedWindowId() ?? '']?.spaceId ?? state.spaceOrder[0]
      if (!space) throw new Error('No spaces')
      winState = createWindowState(space)
      const created = winState
      this.ctx.store.update((d) => {
        d.windows[created.id] = created
      })
    }
    const id = winState.id
    const display = screen.getPrimaryDisplay().workArea
    const bounds = winState.bounds ?? {
      width: Math.min(1360, Math.round(display.width * 0.86)),
      height: Math.min(880, Math.round(display.height * 0.88)),
      x: Math.round(display.x + display.width * 0.07),
      y: Math.round(display.y + display.height * 0.05),
    }
    const space = this.ctx.store.state.spaces[winState.spaceId]
    const palette = space ? paletteFor(space.theme, nativeTheme.shouldUseDarkColors) : undefined
    const win = new BrowserWindow({
      ...bounds,
      minWidth: 520,
      minHeight: 380,
      show: false,
      title: 'Orbit',
      backgroundColor: palette?.windowBackground ?? '#e9eaf5',
      ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 17 } } : { frame: false }),
      webPreferences: { ...uiWebPreferences(id, 'shell'), backgroundThrottling: false },
    })
    if (winState.maximized) win.maximize()
    this.registerUi(win.webContents, id)
    this.attachShortcuts(win.webContents)
    this.hardenUi(win.webContents)

    const rec: WindowRecord = {
      id,
      win,
      visible: new Set(),
      panes: [],
      radius: 10,
      minPaneSeq: 0,
      overlayShown: false,
    }
    this.records.set(id, rec)

    win.once('ready-to-show', () => {
      this.ctx.perf.mark(`window:${id}:ready-to-show`)
      win.show()
      // The overlay renderer starts after the shell has painted so the two don't compete at startup.
      setTimeout(() => {
        if (!win.isDestroyed()) this.ensureOverlay(rec)
      }, 120)
    })
    win.on('focus', () => this.setRuntime(id, { focused: true }))
    win.on('blur', () => this.setRuntime(id, { focused: false }))
    win.on('enter-full-screen', () => this.setRuntime(id, { fullscreen: true }))
    win.on('leave-full-screen', () => this.setRuntime(id, { fullscreen: false }))
    win.on('resize', () => {
      if (rec.overlayShown) this.fitOverlay(rec)
    })
    const saveBounds = () => {
      if (win.isDestroyed() || win.isFullScreen() || win.isMinimized()) return
      const maximized = win.isMaximized()
      const b = win.getNormalBounds()
      this.ctx.store.update((d) => {
        const w = d.windows[id]
        if (!w) return
        w.bounds = { x: b.x, y: b.y, width: b.width, height: b.height }
        w.maximized = maximized
      })
    }
    win.on('resized', saveBounds)
    win.on('moved', saveBounds)
    win.on('maximize', saveBounds)
    win.on('unmaximize', saveBounds)
    win.on('closed', () => {
      for (const [tabId, winId] of [...this.attached]) {
        if (winId === id) {
          this.attached.delete(tabId)
          this.ctx.tabs.sleep(tabId)
        }
      }
      if (rec.overlay && !rec.overlay.webContents.isDestroyed()) rec.overlay.webContents.close()
      this.records.delete(id)
      if (!this.quitting) {
        this.ctx.store.update((d) => {
          delete d.windows[id]
        })
      }
    })

    loadRenderer(win.webContents, 'shell')
    return id
  }

  close(windowId: WindowId): void {
    this.records.get(windowId)?.win.close()
  }

  /** Sends a message to every Orbit UI renderer. */
  broadcast(channel: string, ...args: unknown[]): void {
    for (const contentsId of this.uiContents.keys()) {
      const contents = webContentsFromId(contentsId)
      if (contents && !contents.isDestroyed()) contents.send(channel, ...args)
    }
  }

  sendToWindow(windowId: WindowId, channel: string, payload: unknown): void {
    const rec = this.records.get(windowId)
    if (!rec) return
    if (!rec.win.isDestroyed()) rec.win.webContents.send(`orbit:${channel}`, payload)
    if (rec.overlay && !rec.overlay.webContents.isDestroyed()) rec.overlay.webContents.send(`orbit:${channel}`, payload)
  }

  /** Positions tab views where the shell says panes are; hides tabs no longer shown. */
  applyPanes(windowId: WindowId, panes: Pane[], radius: number): void {
    const rec = this.records.get(windowId)
    if (!rec || rec.win.isDestroyed()) return
    rec.panes = panes
    rec.radius = radius
    const wanted = new Set(panes.map((p) => p.tabId))
    for (const tabId of rec.visible) {
      if (!wanted.has(tabId)) this.ctx.tabs.get(tabId)?.setVisible(false)
    }
    for (const pane of panes) {
      const view = this.ctx.tabs.ensure(pane.tabId)
      if (!view) continue
      this.attach(rec, pane.tabId, view)
      view.setBounds(roundRect(pane.rect))
      view.setBorderRadius(radius)
      view.setVisible(true)
    }
    rec.visible = wanted
    if (panes.length === 1) rec.lastSingleRect = panes[0]?.rect
  }

  /** Removes a (sleeping or moving) tab view from whatever window holds it. */
  detachView(tabId: TabId, view: WebContentsView): void {
    const windowId = this.attached.get(tabId)
    this.attached.delete(tabId)
    if (!windowId) return
    const rec = this.records.get(windowId)
    if (!rec) return
    rec.visible.delete(tabId)
    if (!rec.win.isDestroyed()) rec.win.contentView.removeChildView(view)
  }

  /** Global keyboard shortcuts: every Orbit-owned web contents routes key presses through the action map. */
  attachShortcuts(contents: WebContents): void {
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const action = actionForInput(input, process.platform)
      if (!action || !this.ctx.actions.has(action.id)) return
      event.preventDefault()
      const windowId = this.windowIdFor(contents) ?? this.focusedWindowId()
      void this.ctx.actions.run(action.id, { windowId })
    })
  }

  focusActiveTab(windowId: WindowId): void {
    const tabId = activeTabOf(this.ctx.store.state, windowId)
    const contents = tabId ? this.ctx.tabs.contents(tabId) : undefined
    if (contents) contents.focus()
    else this.records.get(windowId)?.win.webContents.focus()
  }

  private attach(rec: WindowRecord, tabId: TabId, view: WebContentsView): void {
    const current = this.attached.get(tabId)
    if (current === rec.id) return
    if (current) {
      const other = this.records.get(current)
      if (other && !other.win.isDestroyed()) {
        other.win.contentView.removeChildView(view)
        other.visible.delete(tabId)
      }
    }
    // Insert below the overlay so menus and the command bar stay on top.
    const children = rec.win.contentView.children
    const overlayIndex = rec.overlay ? children.indexOf(rec.overlay) : -1
    rec.win.contentView.addChildView(view, overlayIndex >= 0 ? overlayIndex : undefined)
    this.attached.set(tabId, rec.id)
  }

  private onState(next: OrbitState, prev: OrbitState): void {
    for (const rec of this.records.values()) {
      const now = next.windows[rec.id]
      const before = prev.windows[rec.id]
      if (!now) {
        if (before && !rec.win.isDestroyed()) rec.win.close()
        continue
      }
      if (now.overlay !== before?.overlay) {
        if (now.overlay.kind === 'none') this.hideOverlay(rec)
        else this.showOverlay(rec)
      }
      const tabNow = activeTabOf(next, rec.id)
      const tabBefore = before ? activeTabOf(prev, rec.id) : null
      if (tabNow !== tabBefore) this.fastSwitch(rec, next, tabNow)
      const spaceNow = next.spaces[now.spaceId]
      const spaceBefore = before ? prev.spaces[before.spaceId] : undefined
      if (spaceNow?.theme !== spaceBefore?.theme) this.applyBackground(rec)
    }
  }

  /** Swap the visible tab immediately in the common single-pane case; the shell confirms the layout. */
  private fastSwitch(rec: WindowRecord, state: OrbitState, tabId: TabId | null): void {
    const singlePane = rec.panes.length <= 1 && rec.lastSingleRect
    if (tabId && singlePane && !splitOfTab(state, tabId) && rec.lastSingleRect) {
      rec.minPaneSeq = this.ctx.store.seq + 1
      this.applyPanes(rec.id, [{ tabId, rect: rec.lastSingleRect }], rec.radius)
    } else if (!tabId) {
      rec.minPaneSeq = this.ctx.store.seq + 1
      this.applyPanes(rec.id, [], rec.radius)
    }
    if (tabId && !rec.overlayShown) this.ctx.tabs.contents(tabId)?.focus()
  }

  /** The transparent overlay view (command bar, Peek chrome, menus), created on first need. */
  private ensureOverlay(rec: WindowRecord): WebContentsView {
    if (rec.overlay) return rec.overlay
    const overlay = new WebContentsView({ webPreferences: uiWebPreferences(rec.id, 'overlay') })
    overlay.setBackgroundColor('#00000000')
    overlay.setVisible(false)
    rec.win.contentView.addChildView(overlay)
    this.registerUi(overlay.webContents, rec.id)
    this.attachShortcuts(overlay.webContents)
    this.hardenUi(overlay.webContents)
    loadRenderer(overlay.webContents, 'overlay')
    rec.overlay = overlay
    return overlay
  }

  private showOverlay(rec: WindowRecord): void {
    const overlay = this.ensureOverlay(rec)
    this.fitOverlay(rec)
    rec.win.contentView.addChildView(overlay)
    overlay.setVisible(true)
    rec.overlayShown = true
    overlay.webContents.focus()
  }

  private hideOverlay(rec: WindowRecord): void {
    if (!rec.overlayShown || !rec.overlay) return
    rec.overlay.setVisible(false)
    rec.overlayShown = false
    if (rec.win.isFocused()) this.focusActiveTab(rec.id)
  }

  private fitOverlay(rec: WindowRecord): void {
    const [width = 0, height = 0] = rec.win.getContentSize()
    rec.overlay?.setBounds({ x: 0, y: 0, width, height })
  }

  private applyBackground(rec: WindowRecord): void {
    const winState = this.ctx.store.state.windows[rec.id]
    const space = winState ? this.ctx.store.state.spaces[winState.spaceId] : undefined
    if (!space || rec.win.isDestroyed()) return
    rec.win.setBackgroundColor(paletteFor(space.theme, nativeTheme.shouldUseDarkColors).windowBackground)
  }

  private setRuntime(id: WindowId, fields: Partial<Pick<WindowState, 'focused' | 'fullscreen'>>): void {
    this.ctx.store.update((d) => {
      const w = d.windows[id]
      if (!w) return
      if (fields.focused !== undefined && w.focused !== fields.focused) w.focused = fields.focused
      if (fields.fullscreen !== undefined && w.fullscreen !== fields.fullscreen) w.fullscreen = fields.fullscreen
    })
  }

  /** Orbit's UI renderers never navigate away or open windows. */
  private hardenUi(contents: WebContents): void {
    contents.on('will-navigate', (event, url) => {
      const entry = rendererEntry()
      if (!(entry.url && url.startsWith(entry.url))) event.preventDefault()
    })
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  }
}

function roundRect(r: Rect): Rect {
  const x = Math.round(r.x)
  const y = Math.round(r.y)
  return {
    x,
    y,
    width: Math.max(0, Math.round(r.x + r.width) - x),
    height: Math.max(0, Math.round(r.y + r.height) - y),
  }
}

function webContentsFromId(id: number): WebContents | undefined {
  return webContents.fromId(id)
}
