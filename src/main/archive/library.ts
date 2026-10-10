import { WebContentsView } from 'electron'
import type { LibraryOpenArgs, LibraryShow } from '../../shared/commands/archive'
import type { Rect } from '../../shared/rpc'
import type { OrbitState, SpaceId, TabId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import { activeTabOf, loadRenderer, rendererEntry, uiWebPreferences } from '../windows'

/** The Library fades out over this long before its view hides (FL-24). */
const EXIT_MS = 180
const DEFAULT_RADIUS = 10

interface LibraryWindow {
  view?: WebContentsView
  open: boolean
  show: LibraryShow
  /** The tab and Space shown when the Library opened: selecting another one closes the Library. */
  tab: TabId | null
  space?: SpaceId
  /** The command bar, a menu or a Peek is over the window: when it goes, the Library takes the keys back. */
  overlay?: boolean
  hideTimer?: ReturnType<typeof setTimeout>
}

/**
 * A view's page while it is alive. `view.webContents` is undefined once the page is gone (its
 * window closed), so it is checked before `isDestroyed()` is called on it (D28).
 */
function pageOf(view: WebContentsView | undefined): Electron.WebContents | undefined {
  const contents = view?.webContents
  return contents && !contents.isDestroyed() ? contents : undefined
}

const round = (r: Rect): Rect => ({
  x: Math.round(r.x),
  y: Math.round(r.y),
  width: Math.max(0, Math.round(r.width)),
  height: Math.max(0, Math.round(r.height)),
})

/**
 * The Library (AR-02, DL-09): a full view over a window's page area, beside the sidebar, with the
 * section list on the left (renderer view `library`, src/renderer/src/library/).
 *
 * Pages are native views above the shell, so the Library is a view of its own, kept above the
 * window's tab views and below the overlay (command bar, menus) and a Peek, which can preview an
 * entry over it (AR-06). It follows the content frame the shell reports (`layout.panes`), closes
 * when another tab is selected, and gives keyboard focus back when a page under it takes it.
 */
export class LibraryHost {
  private wins = new Map<WindowId, LibraryWindow>()
  private frames = new Map<WindowId, Rect>()
  private radii = new Map<WindowId, number>()
  private nonce = 0
  /** Called when the Library opens, closes or changes section in a window. */
  onChange?: (windowId: WindowId, open: boolean, section: string) => void

  constructor(
    private ctx: MainContext,
    private sections: { last(): string; remember(section: string): void },
  ) {
    // Registered after the window manager's own listener: the tab views are placed by now.
    ctx.events.on('layout.panes', ({ frame, radius }, { windowId }) => {
      if (!windowId) return
      if (frame && frame.width > 0 && frame.height > 0) this.frames.set(windowId, frame)
      this.radii.set(windowId, radius)
      const w = this.wins.get(windowId)
      if (!w?.open || !w.view || !pageOf(w.view)) return
      w.view.setBounds(this.bounds(windowId))
      w.view.setBorderRadius(radius)
      this.place(windowId)
    })
    ctx.store.subscribe((next) => this.onState(next))
    ctx.hooks.tabCreated.push((tabId, contents) => {
      contents.on('focus', () => this.pageFocused(tabId))
      // A page view that shows up later (a tab woken or revived) goes below the Library.
      setImmediate(() => {
        for (const windowId of this.wins.keys()) this.place(windowId)
      })
    })
  }

  isOpen(windowId: WindowId | undefined): boolean {
    return !!windowId && !!this.wins.get(windowId)?.open
  }

  status(windowId: WindowId | undefined): LibraryShow & { open: boolean } {
    const w = windowId ? this.wins.get(windowId) : undefined
    return w ? { ...w.show, open: w.open } : { open: false, section: this.sections.last(), nonce: 0 }
  }

  /** Creates a main window's Library view ahead of its first open, so that open is quick. */
  prepare(windowId: WindowId | undefined): void {
    const win = windowId ? this.ctx.windows.get(windowId) : undefined
    if (!windowId || !win || win.isDestroyed() || this.ctx.store.state.windows[windowId]?.kind !== 'main') return
    const w = this.stateOf(windowId)
    if (!w.view) this.createView(windowId, w)
  }

  /** Opens the Library (or switches its section) in a main window. False when it can't. */
  open(windowId: WindowId | undefined, args: LibraryOpenArgs = {}): boolean {
    const state = this.ctx.store.state
    const win = windowId ? this.ctx.windows.get(windowId) : undefined
    if (!windowId || !win || win.isDestroyed() || state.windows[windowId]?.kind !== 'main') return false
    this.ctx.perf.mark('library:open:start')
    const w = this.stateOf(windowId)
    const view = w.view ?? this.createView(windowId, w)
    const page = pageOf(view)
    if (!page) return false
    clearTimeout(w.hideTimer)
    const section = args.section || this.sections.last()
    if (section !== this.sections.last()) this.sections.remember(section)
    const entering = !w.open
    w.open = true
    w.tab = activeTabOf(state, windowId)
    w.space = state.windows[windowId]?.spaceId
    w.overlay = (state.windows[windowId]?.overlay.kind ?? 'none') !== 'none'
    w.show = {
      section,
      nonce: ++this.nonce,
      ...(args.confirmClear ? { confirmClear: true } : {}),
      ...(args.confirmKeep ? { confirmKeep: args.confirmKeep } : {}),
      entering,
    }
    view.setBounds(this.bounds(windowId))
    view.setBorderRadius(this.radii.get(windowId) ?? DEFAULT_RADIUS)
    this.place(windowId)
    view.setVisible(true)
    page.send('orbit:library:show', w.show)
    // With the command bar still up, focus comes here when it closes (onState).
    if (!w.overlay) page.focus()
    this.onChange?.(windowId, true, section)
    return true
  }

  /** Closes the Library; the page underneath takes the keys again (unless `focusPage` is false). */
  close(windowId: WindowId | undefined, opts: { focusPage?: boolean } = {}): void {
    const w = windowId ? this.wins.get(windowId) : undefined
    if (!windowId || !w?.open) return
    w.open = false
    const view = w.view
    const page = pageOf(view)
    if (view && page) {
      page.send('orbit:library:hide', {})
      clearTimeout(w.hideTimer)
      w.hideTimer = setTimeout(() => {
        if (!w.open && pageOf(view)) view.setVisible(false)
      }, EXIT_MS)
    }
    const win = this.ctx.windows.get(windowId)
    if (opts.focusPage !== false && win && !win.isDestroyed() && win.isFocused()) {
      this.ctx.windows.focusActiveTab(windowId)
    }
    this.onChange?.(windowId, false, w.show.section)
  }

  /** The section shown changed inside the Library: it reopens there (AR-02). */
  setSection(windowId: WindowId | undefined, section: string): void {
    this.sections.remember(section)
    const w = windowId ? this.wins.get(windowId) : undefined
    if (!windowId || !w) return
    w.show = { ...w.show, section, confirmClear: undefined, confirmKeep: undefined, entering: false }
    if (w.open) this.onChange?.(windowId, true, section)
  }

  /**
   * Keys the Library takes while it is open and nothing is over it (KS-19): ⌘W closes it (DL-09)
   * and ⌘F goes to its search field. An open command bar or Peek handles its keys first.
   */
  intercept(id: string, windowId: WindowId | undefined): boolean {
    if (!windowId || !this.isOpen(windowId)) return false
    const overlay = this.ctx.store.state.windows[windowId]?.overlay
    if (overlay && overlay.kind !== 'none') return false
    if (id === 'tab.close') {
      this.close(windowId)
      return true
    }
    if (id === 'page.find') return this.send(windowId, 'library:find')
    return false
  }

  /** Sends a message to the Library view of a window (when it is open). */
  send(windowId: WindowId | undefined, channel: string, payload: unknown = {}): boolean {
    const w = windowId ? this.wins.get(windowId) : undefined
    const page = w?.open ? pageOf(w.view) : undefined
    if (!page) return false
    page.send(`orbit:${channel}`, payload)
    return true
  }

  focus(windowId: WindowId | undefined): void {
    const w = windowId ? this.wins.get(windowId) : undefined
    const page = w?.open ? pageOf(w.view) : undefined
    page?.focus()
  }

  /** A point of the Library view in its window's coordinates (where a menu pops up). */
  toWindowPoint(windowId: WindowId | undefined, x: number, y: number): { x: number; y: number } | undefined {
    const view = windowId ? this.wins.get(windowId)?.view : undefined
    if (!view || !pageOf(view) || !Number.isFinite(x) || !Number.isFinite(y)) return undefined
    const b = view.getBounds()
    return { x: Math.round(b.x + x), y: Math.round(b.y + y) }
  }

  /** Where the view is, for tests: bounds, whether it is shown, above every tab view and focused. */
  info(windowId: WindowId | undefined): {
    open: boolean
    visible: boolean
    bounds?: Rect
    aboveTabs: boolean
    focused: boolean
  } {
    const w = windowId ? this.wins.get(windowId) : undefined
    const view = w?.view
    const page = pageOf(view)
    if (!windowId || !w || !view || !page) {
      return { open: false, visible: false, aboveTabs: false, focused: false }
    }
    const win = this.ctx.windows.get(windowId)
    const children = win && !win.isDestroyed() ? win.contentView.children : []
    return {
      open: w.open,
      visible: view.getVisible(),
      bounds: view.getBounds(),
      aboveTabs: children.includes(view) && children.indexOf(view) > this.topTabIndex(children, view),
      focused: page.isFocused(),
    }
  }

  private stateOf(windowId: WindowId): LibraryWindow {
    let w = this.wins.get(windowId)
    if (!w) {
      w = { open: false, show: { section: this.sections.last(), nonce: 0 }, tab: null }
      this.wins.set(windowId, w)
    }
    return w
  }

  private bounds(windowId: WindowId): Rect {
    const frame = this.frames.get(windowId) ?? this.ctx.windows.pageArea(windowId)
    if (frame) return round(frame)
    // Nothing laid out yet: the window beside the sidebar.
    const [width = 0, height = 0] = this.ctx.windows.get(windowId)?.getContentSize() ?? []
    const sidebar = this.ctx.store.state.windows[windowId]?.sidebar
    const left = sidebar?.visible ? sidebar.width : 8
    return round({ x: left, y: 8, width: width - left - 8, height: height - 16 })
  }

  /** Index of the topmost child view that shows a sidebar tab's page (not a Peek's). */
  private topTabIndex(children: Electron.View[], except: Electron.View): number {
    const state = this.ctx.store.state
    let top = -1
    children.forEach((child, i) => {
      if (child === except || !(child instanceof WebContentsView) || !child.webContents) return
      const tabId = this.ctx.tabs.tabIdFor(child.webContents)
      if (tabId && state.tabs[tabId] && !state.tabs[tabId]?.floating) top = i
    })
    return top
  }

  /** Keeps the open Library right above the window's tab views (so below the overlay and a Peek). */
  private place(windowId: WindowId): void {
    const w = this.wins.get(windowId)
    const view = w?.view
    const win = this.ctx.windows.get(windowId)
    if (!w?.open || !view || !win || win.isDestroyed() || !pageOf(view)) return
    const parent = win.contentView
    const children = parent.children
    const top = this.topTabIndex(children, view)
    const at = children.indexOf(view)
    if (at > top) return
    // addChildView() moves a child it already holds to the index given (the views above shift down).
    parent.addChildView(view, at >= 0 ? top : top + 1)
  }

  /** A page under the open Library took focus (the window refocused it): give it back to the Library. */
  private pageFocused(tabId: TabId): void {
    setImmediate(() => {
      const windowId = this.ctx.windows.windowOfTab(tabId)
      const w = windowId ? this.wins.get(windowId) : undefined
      const contents = w?.open ? pageOf(w.view) : undefined
      if (!windowId || !contents || contents.isFocused()) return
      const state = this.ctx.store.state
      if (!state.tabs[tabId] || state.tabs[tabId]?.floating) return
      const overlay = state.windows[windowId]?.overlay
      // An open command bar, menu or Peek keeps the keys; a Peek that is going away does not.
      if (overlay && overlay.kind !== 'none' && !(overlay.kind === 'peek' && overlay.phase)) return
      contents.focus()
    })
  }

  private onState(next: OrbitState): void {
    for (const [windowId, w] of this.wins) {
      if (!w.open) continue
      if (!next.windows[windowId]) {
        this.close(windowId, { focusPage: false })
        continue
      }
      // Another tab or Space was selected: show it (DL-09 "returns to the previous tab").
      if (activeTabOf(next, windowId) !== w.tab || next.windows[windowId]?.spaceId !== w.space) {
        this.close(windowId, { focusPage: false })
        continue
      }
      this.place(windowId)
      const overlay = (next.windows[windowId]?.overlay.kind ?? 'none') !== 'none'
      if (w.overlay && !overlay) this.refocus(windowId)
      w.overlay = overlay
    }
  }

  /**
   * The command bar, a menu or a Peek over the open Library went away: the window gave the keys
   * to its page (or to the sidebar when no page is loaded); the Library takes them back.
   */
  private refocus(windowId: WindowId): void {
    setImmediate(() => {
      const w = this.wins.get(windowId)
      const contents = w?.open ? pageOf(w.view) : undefined
      if (!contents || contents.isFocused()) return
      const win = this.ctx.windows.get(windowId)
      if (!win || win.isDestroyed() || !win.isFocused()) return
      if ((this.ctx.store.state.windows[windowId]?.overlay.kind ?? 'none') !== 'none') return
      contents.focus()
    })
  }

  private createView(windowId: WindowId, w: LibraryWindow): WebContentsView {
    const view = new WebContentsView({ webPreferences: uiWebPreferences(windowId, 'library') })
    view.setBackgroundColor('#00000000')
    view.setVisible(false)
    w.view = view
    const contents = view.webContents
    this.ctx.windows.registerUi(contents, windowId)
    this.ctx.windows.attachShortcuts(contents)
    contents.on('will-navigate', (event, url) => {
      const entry = rendererEntry()
      if (!(entry.url && url.startsWith(entry.url))) event.preventDefault()
    })
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // A Library whose renderer died closes and loads again for next time.
    contents.on('render-process-gone', (_event, details) => {
      if (details.reason === 'clean-exit' || contents.isDestroyed()) return
      this.close(windowId)
      loadRenderer(contents, 'library')
    })
    loadRenderer(contents, 'library')
    this.ctx.windows.get(windowId)?.once('closed', () => {
      clearTimeout(w.hideTimer)
      this.wins.delete(windowId)
      this.frames.delete(windowId)
      this.radii.delete(windowId)
      if (!contents.isDestroyed()) contents.close()
    })
    return view
  }
}
