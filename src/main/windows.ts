import { join } from 'node:path'
import { BrowserWindow, nativeTheme, screen, type WebContents, WebContentsView, webContents } from 'electron'
import { actionForInput } from '../shared/actions'
import { createWindowState } from '../shared/defaults'
import type { Rect, RendererView } from '../shared/rpc'
import type { ColorMode, OrbitState, OverlayState, SpaceId, TabId, WindowId, WindowState } from '../shared/state'
import { paletteFor } from '../shared/theme'
import { splitLeaves, splitOfTab } from '../shared/tree'
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
  /** Pending hide after the overlay's exit animation. */
  overlayHideTimer?: ReturnType<typeof setTimeout>
  /** The overlay closed while the window was in the background: give the page focus when it returns. */
  refocusPage?: boolean
  /** Tab whose page is in HTML fullscreen (video): its view fills the window. */
  htmlFullscreen?: TabId
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
  private floatingOwners: ((tabId: TabId) => WindowId | undefined)[] = []
  /** Main window that most recently had focus (fallback when no window has focus). */
  private lastFocused: WindowId | undefined
  /** The last main window, closed while the app keeps running (macOS) or is about to quit: its state is kept. */
  private closedMain: WindowId | undefined
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
    return this.attached.get(tabId)?.windowId ?? this.floatingWindowOf(tabId)
  }

  /** The Orbit window a web contents belongs to (UI renderer or attached tab). */
  windowIdFor(contents: WebContents): WindowId | undefined {
    const ui = this.uiContents.get(contents.id)
    if (ui) return ui
    const tabId = this.ctx.tabs.tabIdFor(contents)
    const entry = tabId ? this.attached.get(tabId) : undefined
    if (entry) return entry.contentsId === contents.id ? entry.windowId : undefined
    return tabId ? this.floatingWindowOf(tabId) : undefined
  }

  /**
   * Features that place a tab's view themselves (a Peek card, a Mini Window) say which window
   * holds it, so shortcuts and menus in that page act on the right window.
   */
  addFloatingOwner(owner: (tabId: TabId) => WindowId | undefined): void {
    this.floatingOwners.push(owner)
  }

  private floatingWindowOf(tabId: TabId): WindowId | undefined {
    for (const owner of this.floatingOwners) {
      const windowId = owner(tabId)
      if (windowId) return windowId
    }
    return undefined
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
      ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 17 } } : { frame: false }),
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
      if (wanted.has(tabId)) continue
      // Only hide what this window holds: the view may have moved to another window since.
      const entry = this.attached.get(tabId)
      if (entry?.windowId === rec.id) entry.view.setVisible(false)
    }
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
    // A Peek's overlay covers the page area, which just moved or resized.
    if (rec.overlayShown) this.fitOverlay(rec)
  }

  /** The page area: the bounding box of the window's page panes (window coordinates, DIP). */
  pageArea(windowId: WindowId): Rect | undefined {
    const rec = this.records.get(windowId)
    if (!rec || rec.win.isDestroyed()) return undefined
    const rects = rec.panes.length > 0 ? rec.panes.map((p) => p.rect) : rec.lastSingleRect ? [rec.lastSingleRect] : []
    if (rects.length === 0) return undefined
    const x = Math.min(...rects.map((r) => r.x))
    const y = Math.min(...rects.map((r) => r.y))
    const right = Math.max(...rects.map((r) => r.x + r.width))
    const bottom = Math.max(...rects.map((r) => r.y + r.height))
    return roundRect({ x, y, width: right - x, height: bottom - y })
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
      if (!action || !this.ctx.actions.has(action.id)) return
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
    const overlayAt = rec.overlay ? children.indexOf(rec.overlay) : -1
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
        // A Peek has played its own close by now (or was dismissed outright): its layer goes at
        // once so the page takes clicks again (FL-19). Other overlays linger to animate out.
        if (now.overlay.kind === 'none') this.hideOverlay(rec, before?.overlay.kind === 'peek')
        else if (!rec.overlayShown || overlayKey(now.overlay) !== overlayKey(before?.overlay)) this.showOverlay(rec)
        // The same overlay changed (e.g. a Peek's phase or area): keep its place and focus.
        else this.fitOverlay(rec)
      }
      const tabNow = activeTabOf(next, rec.id)
      const tabBefore = before ? activeTabOf(prev, rec.id) : null
      if (tabNow !== tabBefore) {
        if (tabNow) this.selfClosed.delete(tabNow)
        this.fastSwitch(rec, next, tabNow)
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
    if (tabId && !rec.overlayShown) this.liveContents(tabId)?.focus()
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

  private hideOverlay(rec: WindowRecord, immediately = false): void {
    if (!rec.overlayShown || !rec.overlay) return
    rec.overlayShown = false
    // Focus returns to the page at once (or when the window is next focused); the view stays up
    // while the renderer animates out.
    if (rec.win.isFocused()) this.focusActiveTab(rec.id)
    else rec.refocusPage = true
    const overlay = rec.overlay
    clearTimeout(rec.overlayHideTimer)
    if (immediately) {
      overlay.setVisible(false)
      return
    }
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
    // A Peek's overlay covers only the page area, so the sidebar stays usable beside it (PK-13).
    const area = this.ctx.store.state.windows[rec.id]?.overlay.kind === 'peek' ? this.pageArea(rec.id) : undefined
    rec.overlay?.setBounds(area ?? { x: 0, y: 0, width, height })
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

/** Identifies one opening of an overlay (its kind and nonce): updates to it keep the same key. */
function overlayKey(overlay: OverlayState | undefined): string {
  return overlay && overlay.kind !== 'none' ? `${overlay.kind}:${overlay.nonce}` : 'none'
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
