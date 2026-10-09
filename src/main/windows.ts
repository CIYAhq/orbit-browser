import { join } from 'node:path'
import { BrowserWindow, nativeTheme, screen, type WebContents, WebContentsView, webContents } from 'electron'
import { actionForInput, outsideTextActionFor } from '../shared/actions'
import { createWindowState, DEFAULT_SIDEBAR_WIDTH } from '../shared/defaults'
import type { Rect, RendererView } from '../shared/rpc'
import type { ColorMode, OrbitState, SidebarState, SpaceId, TabId, WindowId, WindowState } from '../shared/state'
import { paletteFor } from '../shared/theme'
import { splitLeaves, splitOfTab } from '../shared/tree'
import type { MainContext } from './context'
import { focusIsEditable } from './nav/focus'
import { fastSwitchPanes } from './split/layout'

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
  /** Last reported content frame (all panes together); used to lay out split views on the fast path. */
  frameRect?: Rect
  /** Ignore renderer pane reports older than this state sequence (after a main-side fast switch). */
  minPaneSeq: number
  overlayShown: boolean
  /** Pending hide after the overlay's exit animation. */
  overlayHideTimer?: ReturnType<typeof setTimeout>
  /** The overlay closed while the window was in the background: give the page focus when it returns. */
  refocusPage?: boolean
  /** Tab whose page is in HTML fullscreen (video): its view fills the window. */
  htmlFullscreen?: TabId
  /**
   * The hidden sidebar's floating card (SB-12): its own view, made once the sidebar is hidden and
   * placed in the window only while the card is out (or sliding away).
   */
  floating?: WebContentsView
  /** The floating card is out (`sidebar.peeking`). */
  floatingShown: boolean
  /** Pending removal of the floating view after its card slid away. */
  floatingTimer?: ReturnType<typeof setTimeout>
  /** Pending start of the floating view's renderer, once the sidebar's hide animation is over. */
  floatingPrewarm?: ReturnType<typeof setTimeout>
  /** Pending release of the floating view's renderer after the sidebar stayed docked a while. */
  floatingDispose?: ReturnType<typeof setTimeout>
  /** macOS: pending return of the traffic lights once a docking sidebar has slid in. */
  buttonsTimer?: ReturnType<typeof setTimeout>
}

/** A tab view placed in a window. */
interface Attachment {
  view: WebContentsView
  windowId: WindowId
  /** Id of the view's web contents, taken while it was alive (a destroyed one can't be asked). */
  contentsId: number
}

/** How long the overlay view stays up after closing so its exit animation can play (FL-16). */
const OVERLAY_EXIT_MS = 110

/** The floating sidebar's card sits this far from the window's edges (SB-12, SB-19). */
export const FLOAT_INSET = 6
/** macOS: where the traffic lights sit in the docked sidebar's top row (SB-03, SB-20). */
const TRAFFIC_LIGHTS = { x: 16, y: 17 }
/** Room right of the floating card for its shadow; the pointer there still counts as over it (FL-03). */
export const FLOAT_BAND = 16
/** The docked sidebar's slide (FL-02): the shell's `--sidebar-dur`. */
const SIDEBAR_SLIDE_MS = 260
/** The floating view stays up this long while its card slides away (FL-03: quick timing, 160 ms)… */
const FLOAT_EXIT_MS = 200
/** …and this long when the sidebar docks, while the docked one slides in beneath it. */
const FLOAT_DOCK_MS = SIDEBAR_SLIDE_MS + 20
/** The floating view's renderer starts once the docked sidebar has slid away (not during the slide). */
const FLOAT_PREWARM_MS = SIDEBAR_SLIDE_MS
/** …and is let go after the sidebar has stayed docked this long. */
const FLOAT_DISPOSE_MS = 60_000

const isMac = process.platform === 'darwin'
/** Isolated world for Orbit's own small page scripts (the page can't tamper with them). */
const EXIT_FULLSCREEN_WORLD = 1001

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

/** Tabs a window's current layout should show: the active tab, or every pane of its split. */
export function shownTabs(state: OrbitState, windowId: WindowId): Set<TabId> {
  const active = activeTabOf(state, windowId)
  if (!active) return new Set()
  const splitId = splitOfTab(state, active)
  const split = splitId ? state.splits[splitId] : undefined
  return new Set(split ? splitLeaves(split.layout) : [active])
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
  /** Each tab's view that is placed in a window, and which window. Compared by view, not tab id. */
  private attached = new Map<TabId, Attachment>()
  /** Tabs whose page closed its own web contents (window.close()): not reopened until selected again. */
  private selfClosed = new Set<TabId>()
  /** Main window that most recently had focus (fallback when no window has focus). */
  private lastFocused: WindowId | undefined
  /** The last main window, closed while the app keeps running (macOS) or is about to quit: its state is kept. */
  private closedMain: WindowId | undefined
  quitting = false
  private ctx!: MainContext

  init(ctx: MainContext): void {
    this.ctx = ctx
    ctx.store.subscribe((next, prev) => this.onState(next, prev))
    ctx.events.on('layout.panes', ({ panes, radius, seq, frame }, { windowId }) => {
      if (!windowId) return
      const rec = this.records.get(windowId)
      if (!rec || seq < rec.minPaneSeq) return
      if (frame) rec.frameRect = frame
      this.applyPanes(windowId, panes, radius)
    })
    syncAppearance(ctx.store.state.settings.appearance)
    nativeTheme.on('updated', () => {
      for (const rec of this.records.values()) this.applyBackground(rec)
    })
    ctx.hooks.tabCreated.push((tabId, contents) => this.watchTab(tabId, contents))
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
    return this.attached.get(tabId)?.windowId
  }

  /** The Orbit window a web contents belongs to (UI renderer or attached tab). */
  windowIdFor(contents: WebContents): WindowId | undefined {
    const ui = this.uiContents.get(contents.id)
    if (ui) return ui
    const tabId = this.ctx.tabs.tabIdFor(contents)
    const entry = tabId ? this.attached.get(tabId) : undefined
    return entry && entry.contentsId === contents.id ? entry.windowId : undefined
  }

  /**
   * The Orbit window the user is working in. Undefined when something that is not an Orbit window
   * has focus (a page's popup, detached DevTools), so menu actions don't hit a window behind it.
   * With nothing focused at all (app in the background), the last focused main window.
   */
  focusedWindowId(): WindowId | undefined {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused) {
      for (const rec of this.records.values()) if (rec.win === focused) return rec.id
      // Orbit's own secondary windows (settings…) act for the window they belong to.
      return focused.isDestroyed() ? undefined : this.uiContents.get(focused.webContents.id)
    }
    const contents = webContents.getFocusedWebContents()
    if (contents && !contents.isDestroyed()) {
      const owner = this.windowIdFor(contents)
      if (owner) return owner
      // Focus in contents Orbit doesn't own (detached DevTools): not an Orbit window.
      if (!this.isUi(contents) && !this.ctx.tabs.tabIdFor(contents)) return undefined
    }
    const last = this.lastFocused ? this.records.get(this.lastFocused) : undefined
    if (last && !last.win.isDestroyed()) return last.id
    const all = [...this.records.values()].filter((r) => !r.win.isDestroyed())
    return all[all.length - 1]?.id
  }

  /**
   * Closes the focused window when it isn't an Orbit window: a page's popup, or detached DevTools
   * (closed on the page they inspect). Close Tab does this when such a window has focus.
   */
  closeFocusedForeign(): boolean {
    if (this.focusedWindowId()) return false
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && !focused.isDestroyed()) {
      focused.close()
      return true
    }
    const contents = webContents.getFocusedWebContents()
    if (!contents) return false
    for (const tabId of this.ctx.tabs.liveTabIds()) {
      const page = this.liveContents(tabId)
      if (page && page.devToolsWebContents === contents) {
        page.closeDevTools()
        return true
      }
    }
    return false
  }

  /**
   * Opens a window for an existing window state, or a new one showing `spaceId`. With no main
   * window open, the last closed main window comes back (its bounds, Space and tabs).
   */
  open(existing?: WindowState, spaceId?: string): WindowId {
    const state = this.ctx.store.state
    let winState = existing ?? this.takeClosedMain(spaceId)
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
    const win = new BrowserWindow({
      ...bounds,
      minWidth: 520,
      minHeight: 380,
      show: false,
      title: 'Orbit',
      backgroundColor: windowBackground(this.ctx.store.state, winState.spaceId) ?? '#e9eaf5',
      ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: TRAFFIC_LIGHTS } : { frame: false }),
      webPreferences: { ...uiWebPreferences(id, 'shell'), backgroundThrottling: false },
    })
    if (winState.maximized) win.maximize()
    this.registerUi(win.webContents, id)
    this.reloadUiOnCrash(win.webContents, 'shell')
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
      floatingShown: false,
    }
    this.records.set(id, rec)
    // macOS: the traffic lights live in the sidebar's top row (SB-20).
    if (isMac && !winState.sidebar.visible) win.setWindowButtonVisibility(false)

    win.once('ready-to-show', () => {
      this.ctx.perf.mark(`window:${id}:ready-to-show`)
      win.show()
      // The overlay renderer starts after the shell has painted so the two don't compete at startup.
      setTimeout(() => {
        if (!win.isDestroyed()) this.ensureOverlay(rec)
      }, 120)
      if (!this.ctx.store.state.windows[id]?.sidebar.visible) this.prewarmFloating(rec, 600)
    })
    win.on('focus', () => {
      this.lastFocused = id
      this.setRuntime(id, { focused: true })
      if (rec.refocusPage && !rec.overlayShown) {
        rec.refocusPage = false
        this.focusActiveTab(id)
      }
    })
    win.on('blur', () => this.setRuntime(id, { focused: false }))
    win.on('enter-full-screen', () => {
      this.setRuntime(id, { fullscreen: true })
      this.settleHtmlFullscreen(rec)
    })
    win.on('leave-full-screen', () => {
      this.setRuntime(id, { fullscreen: false })
      this.settleHtmlFullscreen(rec)
    })
    win.on('resize', () => {
      if (rec.overlayShown) this.fitOverlay(rec)
      if (rec.floatingShown) this.fitFloating(rec)
      if (rec.htmlFullscreen) this.applyPanes(id, rec.panes, rec.radius)
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
    win.on('close', saveBounds)
    if (process.platform === 'linux') {
      // Linux has no 'resized'/'moved': save once a resize or move settles.
      let timer: NodeJS.Timeout | undefined
      const settle = () => {
        clearTimeout(timer)
        timer = setTimeout(saveBounds, 300)
      }
      win.on('resize', settle)
      win.on('move', settle)
      win.once('closed', () => clearTimeout(timer))
    }
    win.on('closed', () => {
      clearTimeout(rec.overlayHideTimer)
      clearTimeout(rec.floatingTimer)
      clearTimeout(rec.floatingPrewarm)
      clearTimeout(rec.floatingDispose)
      clearTimeout(rec.buttonsTimer)
      if (rec.floating && !rec.floating.webContents.isDestroyed()) rec.floating.webContents.close()
      this.records.delete(id)
      for (const [tabId, entry] of [...this.attached]) {
        if (entry.windowId === id) {
          this.attached.delete(tabId)
          this.ctx.tabs.sleep(tabId)
        }
      }
      if (rec.overlay && !rec.overlay.webContents.isDestroyed()) rec.overlay.webContents.close()
      if (this.quitting) return
      if (this.ctx.store.state.windows[id]?.kind === 'main' && !this.hasOpenMain()) {
        // The last main window: keep its state. Linux and Windows quit right after this and
        // persist it (TB-22); macOS keeps running and reopens it from the dock.
        this.closedMain = id
        this.ctx.store.update((d) => {
          const w = d.windows[id]
          if (!w) return
          w.focused = false
          w.fullscreen = false
          if (w.overlay.kind !== 'none') w.overlay = { kind: 'none' }
        })
        return
      }
      this.ctx.store.update((d) => {
        delete d.windows[id]
      })
    })

    loadRenderer(win.webContents, 'shell')
    return id
  }

  private hasOpenMain(): boolean {
    for (const id of this.records.keys()) if (this.ctx.store.state.windows[id]?.kind === 'main') return true
    return false
  }

  /** The kept state of the last closed main window, when no main window is open (see 'closed'). */
  private takeClosedMain(spaceId?: string): WindowState | undefined {
    const id = this.closedMain
    this.closedMain = undefined
    if (!id || this.hasOpenMain()) return undefined
    const kept = this.ctx.store.state.windows[id]
    if (!kept) return undefined
    if (spaceId && spaceId !== kept.spaceId && this.ctx.store.state.spaces[spaceId]) {
      this.ctx.store.update((d) => {
        const w = d.windows[id]
        if (w) w.spaceId = spaceId
      })
    }
    return this.ctx.store.state.windows[id]
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
    // While the floating sidebar is out, what the sidebar shows (a rename field, the new-Space
    // flow, an undo toast) happens there and not in the hidden, docked one.
    const floating = this.floatingContents(windowId)
    const forSidebar = channel.startsWith('sidebar:') || channel.startsWith('spaces:')
    if (floating && forSidebar) floating.send(`orbit:${channel}`, payload)
    else if (!rec.win.isDestroyed()) rec.win.webContents.send(`orbit:${channel}`, payload)
    if (rec.overlay && !rec.overlay.webContents.isDestroyed()) rec.overlay.webContents.send(`orbit:${channel}`, payload)
  }

  /** The floating sidebar's web contents while its card is out (SB-12). */
  floatingContents(windowId: WindowId): WebContents | undefined {
    const rec = this.records.get(windowId)
    const contents = rec?.floatingShown ? rec.floating?.webContents : undefined
    return contents && !contents.isDestroyed() ? contents : undefined
  }

  /** Where Orbit's sidebar is drawn: the floating card while it is out, else the window's shell. */
  sidebarContents(windowId: WindowId): WebContents | undefined {
    const rec = this.records.get(windowId)
    if (!rec || rec.win.isDestroyed()) return undefined
    return this.floatingContents(windowId) ?? rec.win.webContents
  }

  /** True while a page of the window is in HTML full screen (a video). */
  inHtmlFullscreen(windowId: WindowId): boolean {
    return !!this.records.get(windowId)?.htmlFullscreen
  }

  /** A tab view's place in its window (window coordinates), while attached. */
  tabViewBounds(tabId: TabId): Rect | undefined {
    const entry = this.attached.get(tabId)
    if (!entry || !this.records.get(entry.windowId)?.visible.has(tabId)) return undefined
    return entry.view.getBounds()
  }

  /** The page under a point of a window (window coordinates), with the point in the page's coordinates. */
  pageAt(windowId: WindowId, x: number, y: number): { contents: WebContents; x: number; y: number } | undefined {
    const rec = this.records.get(windowId)
    if (!rec) return undefined
    for (const tabId of rec.visible) {
      const b = this.tabViewBounds(tabId)
      const contents = this.liveContents(tabId)
      if (!b || !contents) continue
      if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) return { contents, x: x - b.x, y: y - b.y }
    }
    return undefined
  }

  /** Test/debug view of a window's floating sidebar. */
  floatingInfo(windowId: WindowId): { exists: boolean; placed: boolean; shown: boolean; bounds?: Rect } {
    const rec = this.records.get(windowId)
    const view = rec?.floating
    if (!rec || !view || view.webContents.isDestroyed()) return { exists: false, placed: false, shown: false }
    return {
      exists: true,
      placed: rec.win.contentView.children.includes(view),
      shown: rec.floatingShown,
      bounds: view.getBounds(),
    }
  }

  /** Positions tab views where the shell says panes are; hides tabs no longer shown. */
  applyPanes(windowId: WindowId, panes: Pane[], radius: number): void {
    const rec = this.records.get(windowId)
    if (!rec || rec.win.isDestroyed()) return
    rec.panes = panes
    rec.radius = radius
    const wanted = new Set(panes.map((p) => p.tabId))
    for (const tabId of rec.visible) {
      if (wanted.has(tabId)) continue
      // Only hide what this window holds: the view may have moved to another window since.
      const entry = this.attached.get(tabId)
      if (entry?.windowId === rec.id) entry.view.setVisible(false)
    }
    const shownBefore = rec.visible
    for (const pane of panes) {
      // A page that closed itself stays closed until the tab is selected again (onState).
      if (this.selfClosed.has(pane.tabId)) continue
      const view = this.ensureView(pane.tabId)
      if (!view) continue
      this.attach(rec, pane.tabId, view)
      view.setBounds(roundRect(pane.rect))
      view.setBorderRadius(radius)
      view.setVisible(true)
      // A tab whose page crashed while in the background reloads when it is shown again.
      if (!rec.visible.has(pane.tabId) && view.webContents.isCrashed()) view.webContents.reload()
    }
    rec.visible = wanted
    if (panes.length === 1) rec.lastSingleRect = panes[0]?.rect
    if (rec.htmlFullscreen) this.layoutHtmlFullscreen(rec, wanted)
    this.focusIfNewlyShown(rec, shownBefore)
  }

  /** A page that just appeared for the focused tab or pane (e.g. a split pane filled late) takes keyboard focus. */
  private focusIfNewlyShown(rec: WindowRecord, shownBefore: Set<TabId>): void {
    const active = activeTabOf(this.ctx.store.state, rec.id)
    if (!active || !rec.visible.has(active) || shownBefore.has(active)) return
    if (!rec.overlayShown && rec.win.isFocused()) this.liveContents(active)?.focus()
  }

  /**
   * HTML fullscreen (a video's fullscreen button): the page's view covers the whole window,
   * over the sidebar and other panes, without rounded corners. Leaving the tab ends it.
   */
  private layoutHtmlFullscreen(rec: WindowRecord, shown: Set<TabId>): void {
    const tabId = rec.htmlFullscreen
    const entry = tabId ? this.attached.get(tabId) : undefined
    if (!tabId || !entry || entry.windowId !== rec.id || !shown.has(tabId)) {
      rec.htmlFullscreen = undefined
      const contents = tabId ? this.liveContents(tabId) : undefined
      contents
        ?.executeJavaScriptInIsolatedWorld(EXIT_FULLSCREEN_WORLD, [
          { code: 'document.fullscreenElement && document.exitFullscreen()' },
        ])
        .catch(() => {})
      return
    }
    for (const other of shown) {
      if (other !== tabId) this.attached.get(other)?.view.setVisible(false)
    }
    const [width = 0, height = 0] = rec.win.getContentSize()
    this.placeOnTop(rec, entry.view)
    entry.view.setBounds({ x: 0, y: 0, width, height })
    entry.view.setBorderRadius(0)
  }

  private setHtmlFullscreen(tabId: TabId, contentsId: number, on: boolean): void {
    if (on) {
      const entry = this.attached.get(tabId)
      const rec = entry?.contentsId === contentsId ? this.records.get(entry.windowId) : undefined
      if (!rec) return
      rec.htmlFullscreen = tabId
      // A floating sidebar never covers a full-screen video (SB-12).
      if (this.ctx.store.state.windows[rec.id]?.sidebar.peeking) {
        this.ctx.store.update((d) => {
          const w = d.windows[rec.id]
          if (w) w.sidebar.peeking = false
        })
      }
      this.applyPanes(rec.id, rec.panes, rec.radius)
      return
    }
    for (const rec of this.records.values()) {
      if (rec.htmlFullscreen !== tabId) continue
      rec.htmlFullscreen = undefined
      this.applyPanes(rec.id, rec.panes, rec.radius)
    }
  }

  /**
   * A native fullscreen animation just ended (macOS animates; Linux and Windows don't). A page that
   * left HTML fullscreen while it ran is told only when its view's size is next synced, so it can
   * stay in fullscreen layout and its exitFullscreen() never resolves. Nudge the size of any page
   * that still shows a fullscreen element but is no longer meant to be fullscreen.
   */
  settleHtmlFullscreen(rec: WindowRecord): void {
    for (const tabId of rec.visible) {
      if (tabId === rec.htmlFullscreen) continue
      const entry = this.attached.get(tabId)
      const contents = this.liveContents(tabId)
      if (!entry || entry.windowId !== rec.id || !contents) continue
      contents
        .executeJavaScriptInIsolatedWorld(EXIT_FULLSCREEN_WORLD, [{ code: '!!document.fullscreenElement' }])
        .then((stuck) => {
          if (!stuck || this.attached.get(tabId) !== entry || rec.htmlFullscreen === tabId) return
          const bounds = entry.view.getBounds()
          entry.view.setBounds({ ...bounds, width: Math.max(0, bounds.width - 1) })
          entry.view.setBounds(bounds)
        })
        .catch(() => {})
    }
  }

  /** Reloads a tab whose page crashed (e.g. when the user selects it again). True if it did. */
  reloadIfCrashed(tabId: TabId): boolean {
    const contents = this.liveContents(tabId)
    if (!contents?.isCrashed()) return false
    contents.reload()
    return true
  }

  /** Orbit's own UI must never stay blank: reload a shell or overlay renderer that died (a few times). */
  private reloadUiOnCrash(contents: WebContents, view: RendererView): void {
    const crashes: number[] = []
    contents.on('render-process-gone', (_event, details) => {
      if (this.quitting || contents.isDestroyed() || details.reason === 'clean-exit') return
      const now = Date.now()
      while (crashes.length > 0 && now - (crashes[0] as number) > 60_000) crashes.shift()
      crashes.push(now)
      if (crashes.length > 3) {
        console.error(`[windows] the ${view} renderer keeps crashing (${details.reason}); not reloading again`)
        return
      }
      console.error(`[windows] the ${view} renderer is gone (${details.reason}); reloading`)
      loadRenderer(contents, view)
    })
  }

  /** Removes a (sleeping, closing or replaced) tab view from whatever window holds it. Safe for destroyed views. */
  detachView(tabId: TabId, view: WebContentsView): void {
    const entry = this.attached.get(tabId)
    if (entry?.view === view) {
      this.attached.delete(tabId)
      this.records.get(entry.windowId)?.visible.delete(tabId)
    }
    this.removeEverywhere(view)
  }

  /** Global keyboard shortcuts: every Orbit-owned web contents routes key presses through the action map. */
  attachShortcuts(contents: WebContents): void {
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const action = actionForInput(input, process.platform)
      if (!action || !this.ctx.actions.has(action.id)) {
        this.runOutsideText(contents, input)
        return
      }
      event.preventDefault()
      const windowId = this.windowIdFor(contents) ?? this.focusedWindowId()
      // Close Tab in a window that isn't an Orbit window (a page's popup) closes that window.
      if (!windowId && action.id === 'tab.close') {
        BrowserWindow.fromWebContents(contents)?.close()
        return
      }
      void this.ctx.actions.run(action.id, { windowId })
    })
  }

  /**
   * Keys that edit text inside a field but are Orbit actions elsewhere (⌘← and ⌘→ go back and
   * forward on macOS, KS-16, NV-01). The key is never taken from the page: the action runs only
   * once it is clear that focus is not in a text field.
   */
  private runOutsideText(contents: WebContents, input: Electron.Input): void {
    const action = outsideTextActionFor(input, process.platform)
    if (!action || !this.ctx.actions.has(action.id)) return
    const windowId = this.windowIdFor(contents) ?? this.focusedWindowId()
    void focusIsEditable(contents).then((editable) => {
      if (!editable && !contents.isDestroyed()) void this.ctx.actions.run(action.id, { windowId })
    })
  }

  focusActiveTab(windowId: WindowId): void {
    const tabId = activeTabOf(this.ctx.store.state, windowId)
    const contents = tabId ? this.liveContents(tabId) : undefined
    if (contents) contents.focus()
    else this.records.get(windowId)?.win.webContents.focus()
  }

  /**
   * Places a tab's view in a window. Compares views, not tab ids: a tab whose view was replaced
   * (woken again, or recreated after its contents died) gets the new view and the stale one goes.
   * Taking a view from another window lays that window out again without it.
   */
  private attach(rec: WindowRecord, tabId: TabId, view: WebContentsView): void {
    const current = this.attached.get(tabId)
    const children = rec.win.contentView.children
    if (current?.view === view && current.windowId === rec.id && children.includes(view)) return
    let loser: WindowRecord | undefined
    if (current && current.view !== view) {
      this.removeEverywhere(current.view)
    } else if (current && current.windowId !== rec.id) {
      loser = this.records.get(current.windowId)
      if (loser) {
        this.removeChild(loser, view)
        loser.visible.delete(tabId)
      }
    }
    this.placeOnTop(rec, view)
    this.attached.set(tabId, { view, windowId: rec.id, contentsId: view.webContents.id })
    this.selfClosed.delete(tabId)
    if (loser && !loser.win.isDestroyed()) {
      this.applyPanes(
        loser.id,
        loser.panes.filter((p) => p.tabId !== tabId),
        loser.radius,
      )
    }
  }

  /**
   * A tab's live web contents. Reads the view directly: while a page closes itself the view's
   * webContents is already gone before 'destroyed' fires, and must not throw here.
   */
  private liveContents(tabId: TabId): WebContents | undefined {
    const contents = this.ctx.tabs.get(tabId)?.webContents as WebContents | undefined
    return contents && !contents.isDestroyed() ? contents : undefined
  }

  /** The tab's view, woken if needed; undefined (not a throw) while its old contents is half gone. */
  private ensureView(tabId: TabId): WebContentsView | undefined {
    try {
      return this.ctx.tabs.ensure(tabId)
    } catch (err) {
      console.error('[windows] could not show tab', tabId, err)
      return undefined
    }
  }

  /**
   * Puts a tab view above the other tab views but below the overlay, so the command bar and menus
   * stay on top. Reads the children afresh (a stale view may just have been removed) and moves the
   * view only when it is out of place. addChildView() reorders an existing child to the index
   * given, so a view already below the overlay goes to the overlay's index minus one.
   */
  private placeOnTop(rec: WindowRecord, view: WebContentsView): void {
    const parent = rec.win.contentView
    const children = parent.children
    const at = children.indexOf(view)
    // The overlay and the floating sidebar (SB-12) stay above every page.
    const above = [rec.overlay, rec.floating].map((v) => (v ? children.indexOf(v) : -1)).filter((i) => i >= 0)
    const overlayAt = above.length > 0 ? Math.min(...above) : -1
    if (overlayAt < 0) {
      if (at < 0 || at !== children.length - 1) parent.addChildView(view)
      return
    }
    if (at >= 0 && at === overlayAt - 1) return
    parent.addChildView(view, at >= 0 && at < overlayAt ? overlayAt - 1 : overlayAt)
  }

  /** Removes a view from every window that holds it (no-op for windows that don't). */
  private removeEverywhere(view: WebContentsView): void {
    for (const rec of this.records.values()) this.removeChild(rec, view)
  }

  private removeChild(rec: WindowRecord, view: WebContentsView): void {
    if (rec.win.isDestroyed()) return
    try {
      rec.win.contentView.removeChildView(view)
    } catch (err) {
      console.error('[windows] could not remove a view:', err)
    }
  }

  /** Follows a tab's live web contents: fullscreen requests, and pages that close themselves. */
  private watchTab(tabId: TabId, contents: WebContents): void {
    const contentsId = contents.id
    contents.on('enter-html-full-screen', () => this.setHtmlFullscreen(tabId, contentsId, true))
    contents.on('leave-html-full-screen', () => this.setHtmlFullscreen(tabId, contentsId, false))
    contents.once('destroyed', () => {
      const entry = this.attached.get(tabId)
      if (!entry || entry.contentsId !== contentsId) return // slept or closed by Orbit: already detached
      // The page closed itself (window.close()) or its contents went away without Orbit asking.
      this.attached.delete(tabId)
      this.records.get(entry.windowId)?.visible.delete(tabId)
      this.removeEverywhere(entry.view)
      this.selfClosed.add(tabId)
    })
  }

  private onState(next: OrbitState, prev: OrbitState): void {
    if (next.settings.appearance !== prev.settings.appearance) {
      syncAppearance(next.settings.appearance)
      for (const rec of this.records.values()) this.applyBackground(rec)
    }
    for (const tabId of this.selfClosed) if (!next.tabs[tabId]) this.selfClosed.delete(tabId)
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
      if (now.sidebar !== before?.sidebar) this.onSidebar(rec, now.sidebar, before?.sidebar)
      const tabNow = activeTabOf(next, rec.id)
      const tabBefore = before ? activeTabOf(prev, rec.id) : null
      if (tabNow !== tabBefore) {
        if (tabNow) this.selfClosed.delete(tabNow)
        this.fastSwitch(rec, next, prev, tabNow, tabBefore)
      }
      const spaceNow = next.spaces[now.spaceId]
      const spaceBefore = before ? prev.spaces[before.spaceId] : undefined
      if (spaceNow?.theme !== spaceBefore?.theme) this.applyBackground(rec)
      if (rec.panes.some((p) => next.tabs[p.tabId]?.asleep && prev.tabs[p.tabId]?.asleep === false)) {
        this.reviveSoon(rec)
      }
    }
  }

  /**
   * A tab on screen lost its view (put to sleep, e.g. moved to another profile's session, or its
   * contents died): lay the window out again so the tab gets a new view instead of a blank frame.
   * Deferred so the code that slept or closed the tab can first move on to another tab.
   */
  private reviveSoon(rec: WindowRecord): void {
    setImmediate(() => {
      if (this.records.get(rec.id) !== rec || rec.win.isDestroyed()) return
      const state = this.ctx.store.state
      const shown = shownTabs(state, rec.id)
      const missing = rec.panes.some(
        (p) => shown.has(p.tabId) && !this.selfClosed.has(p.tabId) && !this.liveContents(p.tabId),
      )
      if (missing) this.applyPanes(rec.id, rec.panes, rec.radius)
    })
  }

  /**
   * Swap the visible tab (or split view) immediately using the last known frame; the shell
   * confirms the layout. Focus moves within a split and splits that grow or shrink are left
   * to the shell, which animates them.
   */
  private fastSwitch(
    rec: WindowRecord,
    state: OrbitState,
    prev: OrbitState,
    tabId: TabId | null,
    before: TabId | null,
  ): void {
    const frame = rec.frameRect ?? rec.lastSingleRect
    const panes = tabId && frame ? fastSwitchPanes(state, prev, tabId, before, frame) : null
    if (panes) {
      rec.minPaneSeq = this.ctx.store.seq + 1
      this.applyPanes(rec.id, panes, rec.radius)
    } else if (!tabId) {
      rec.minPaneSeq = this.ctx.store.seq + 1
      this.applyPanes(rec.id, [], rec.radius)
    }
    if (tabId && !rec.overlayShown) this.liveContents(tabId)?.focus()
  }

  /**
   * The sidebar was hidden, docked, revealed floating or resized (SB-11, SB-12, SB-14). The floating
   * card's renderer starts once the sidebar is hidden, so the first reveal is quick, and goes again
   * after the sidebar has stayed docked for a while.
   */
  private onSidebar(rec: WindowRecord, now: SidebarState, before: SidebarState | undefined): void {
    if (now.visible !== before?.visible || now.peeking !== before?.peeking) this.applyWindowButtons(rec, now, before)
    if (now.visible) {
      clearTimeout(rec.floatingPrewarm)
      rec.floatingPrewarm = undefined
      if (rec.floating && !rec.floatingDispose) {
        rec.floatingDispose = setTimeout(() => this.disposeFloating(rec), FLOAT_DISPOSE_MS)
      }
    } else {
      clearTimeout(rec.floatingDispose)
      rec.floatingDispose = undefined
      if (!now.peeking) this.prewarmFloating(rec, FLOAT_PREWARM_MS)
    }
    if (now.peeking && !before?.peeking) this.showFloating(rec)
    else if (!now.peeking && before?.peeking) this.hideFloating(rec, now.visible ? FLOAT_DOCK_MS : FLOAT_EXIT_MS)
    else if (now.peeking && now.width !== before?.width) this.fitFloating(rec)
  }

  /**
   * macOS: the traffic lights belong to the sidebar's top row. While it is hidden they show only
   * with the floating card, moved in with it (the card sits inset from the window's corner) (SB-20).
   */
  private applyWindowButtons(rec: WindowRecord, now: SidebarState, before: SidebarState | undefined): void {
    if (!isMac || rec.win.isDestroyed()) return
    clearTimeout(rec.buttonsTimer)
    rec.buttonsTimer = undefined
    const later = (ms: number, fn: () => void) => {
      rec.buttonsTimer = setTimeout(() => {
        rec.buttonsTimer = undefined
        if (!rec.win.isDestroyed()) fn()
      }, ms)
    }
    const docked = () => rec.win.setWindowButtonPosition(TRAFFIC_LIGHTS)
    if (now.peeking) {
      rec.win.setWindowButtonPosition({ x: TRAFFIC_LIGHTS.x + FLOAT_INSET, y: TRAFFIC_LIGHTS.y + FLOAT_INSET })
      rec.win.setWindowButtonVisibility(true)
    } else if (!now.visible) {
      rec.win.setWindowButtonVisibility(false)
      docked()
    } else if (before?.peeking) {
      // Docked from the floating card: they move over once the card has gone.
      later(FLOAT_DOCK_MS, docked)
    } else if (before && !before.visible) {
      // Shown: they appear once the sidebar has slid in under them.
      docked()
      later(SIDEBAR_SLIDE_MS, () => rec.win.setWindowButtonVisibility(true))
    } else {
      docked()
      rec.win.setWindowButtonVisibility(true)
    }
  }

  private prewarmFloating(rec: WindowRecord, delay: number): void {
    if (rec.floating || rec.floatingPrewarm) return
    rec.floatingPrewarm = setTimeout(() => {
      rec.floatingPrewarm = undefined
      const sidebar = this.ctx.store.state.windows[rec.id]?.sidebar
      if (!rec.win.isDestroyed() && sidebar && !sidebar.visible) this.ensureFloating(rec)
    }, delay)
  }

  /** The floating sidebar's view (SB-12): a transparent view at the window's left edge. */
  private ensureFloating(rec: WindowRecord): WebContentsView {
    if (rec.floating && !rec.floating.webContents.isDestroyed()) return rec.floating
    clearTimeout(rec.floatingPrewarm)
    rec.floatingPrewarm = undefined
    const view = new WebContentsView({ webPreferences: uiWebPreferences(rec.id, 'sidebar') })
    view.setBackgroundColor('#00000000')
    this.registerUi(view.webContents, rec.id)
    this.reloadUiOnCrash(view.webContents, 'sidebar')
    this.attachShortcuts(view.webContents)
    this.hardenUi(view.webContents)
    loadRenderer(view.webContents, 'sidebar')
    rec.floating = view
    return view
  }

  /** Puts the floating sidebar above the pages (below the overlay); its card slides in (FL-03). */
  private showFloating(rec: WindowRecord): void {
    if (rec.win.isDestroyed()) return
    clearTimeout(rec.floatingTimer)
    rec.floatingTimer = undefined
    const view = this.ensureFloating(rec)
    rec.floatingShown = true
    this.fitFloating(rec)
    const parent = rec.win.contentView
    const children = parent.children
    const at = children.indexOf(view)
    const overlayAt = rec.overlay ? children.indexOf(rec.overlay) : -1
    if (overlayAt < 0) {
      if (at !== children.length - 1) parent.addChildView(view)
    } else if (at !== overlayAt - 1) {
      parent.addChildView(view, at >= 0 && at < overlayAt ? overlayAt - 1 : overlayAt)
    }
    view.setVisible(true)
  }

  /** The card slides away (or stays while the docked sidebar slides in), then the view leaves the window. */
  private hideFloating(rec: WindowRecord, afterMs: number): void {
    rec.floatingShown = false
    const view = rec.floating
    if (!view || view.webContents.isDestroyed()) return
    // Keyboard focus in the card goes back to the page.
    if (webContents.getFocusedWebContents() === view.webContents && !rec.overlayShown) this.focusActiveTab(rec.id)
    clearTimeout(rec.floatingTimer)
    rec.floatingTimer = setTimeout(() => {
      rec.floatingTimer = undefined
      if (!rec.floatingShown && !rec.win.isDestroyed()) this.removeChild(rec, view)
    }, afterMs)
  }

  private fitFloating(rec: WindowRecord): void {
    const view = rec.floating
    if (!view || rec.win.isDestroyed()) return
    const [width = 0, height = 0] = rec.win.getContentSize()
    const sidebar = this.ctx.store.state.windows[rec.id]?.sidebar.width ?? DEFAULT_SIDEBAR_WIDTH
    view.setBounds({ x: 0, y: 0, width: Math.min(width, FLOAT_INSET + sidebar + FLOAT_BAND), height })
  }

  private disposeFloating(rec: WindowRecord): void {
    rec.floatingDispose = undefined
    const view = rec.floating
    if (!view || rec.floatingShown || !this.ctx.store.state.windows[rec.id]?.sidebar.visible) return
    clearTimeout(rec.floatingTimer)
    rec.floatingTimer = undefined
    rec.floating = undefined
    if (!rec.win.isDestroyed()) this.removeChild(rec, view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  /** The transparent overlay view (command bar, Peek chrome, menus), created on first need. */
  private ensureOverlay(rec: WindowRecord): WebContentsView {
    if (rec.overlay) return rec.overlay
    const overlay = new WebContentsView({ webPreferences: uiWebPreferences(rec.id, 'overlay') })
    overlay.setBackgroundColor('#00000000')
    overlay.setVisible(false)
    rec.win.contentView.addChildView(overlay)
    this.registerUi(overlay.webContents, rec.id)
    this.reloadUiOnCrash(overlay.webContents, 'overlay')
    this.attachShortcuts(overlay.webContents)
    this.hardenUi(overlay.webContents)
    loadRenderer(overlay.webContents, 'overlay')
    rec.overlay = overlay
    return overlay
  }

  private showOverlay(rec: WindowRecord): void {
    clearTimeout(rec.overlayHideTimer)
    rec.refocusPage = false
    const overlay = this.ensureOverlay(rec)
    this.fitOverlay(rec)
    rec.win.contentView.addChildView(overlay)
    overlay.setVisible(true)
    rec.overlayShown = true
    overlay.webContents.focus()
  }

  private hideOverlay(rec: WindowRecord): void {
    if (!rec.overlayShown || !rec.overlay) return
    rec.overlayShown = false
    // Focus returns to the page at once (or when the window is next focused); the view stays up
    // while the renderer animates out.
    if (rec.win.isFocused()) this.focusActiveTab(rec.id)
    else rec.refocusPage = true
    const overlay = rec.overlay
    clearTimeout(rec.overlayHideTimer)
    rec.overlayHideTimer = setTimeout(() => {
      rec.overlayHideTimer = undefined
      if (rec.overlayShown || rec.win.isDestroyed() || overlay.webContents.isDestroyed()) return
      try {
        overlay.setVisible(false)
      } catch {
        // The window is going away.
      }
    }, OVERLAY_EXIT_MS)
  }

  private fitOverlay(rec: WindowRecord): void {
    const [width = 0, height = 0] = rec.win.getContentSize()
    rec.overlay?.setBounds({ x: 0, y: 0, width, height })
  }

  /** The native background shows at the window's edges while resizing: keep it the frame's colour. */
  private applyBackground(rec: WindowRecord): void {
    const state = this.ctx.store.state
    const colour = windowBackground(state, state.windows[rec.id]?.spaceId)
    if (colour && !rec.win.isDestroyed()) rec.win.setBackgroundColor(colour)
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

/**
 * Light/Dark/Automatic is one global setting (SP-18, AP-01; decision D12). Chromium's theme
 * source follows it, so Orbit's UI and web pages get the matching prefers-color-scheme.
 */
function syncAppearance(appearance: ColorMode): void {
  const source = appearance === 'light' || appearance === 'dark' ? appearance : 'system'
  if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source
}

/** A window's background: its Space's colour in the global appearance (a per-Space mode is ignored, D12). */
export function windowBackground(state: OrbitState, spaceId: SpaceId | undefined): string | undefined {
  const space = spaceId ? state.spaces[spaceId] : undefined
  if (!space) return undefined
  // The theme source follows settings.appearance, so this is the global light/dark choice.
  return paletteFor(space.theme, nativeTheme.shouldUseDarkColors).windowBackground
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
