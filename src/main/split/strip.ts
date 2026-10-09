import { type MouseInputEvent, WebContentsView } from 'electron'
import { layoutLeaves } from '../../shared/split'
import type { OrbitState, TabId, WindowId } from '../../shared/state'
import { splitOfTab } from '../../shared/tree'
import type { MainContext } from '../context'
import { activeTabOf, loadRenderer, rendererEntry, uiWebPreferences } from '../windows'

/** Pointer within this many px of a pane's top edge reveals the strip. */
const REVEAL_ZONE = 28
/** …and it hides again once the pointer is this far down. */
const HIDE_ZONE = 64
const SHOW_DELAY_MS = 150
const HIDE_DELAY_MS = 250
export const STRIP_WIDTH = 104
export const STRIP_HEIGHT = 30

interface StripState {
  view?: WebContentsView
  tabId: TabId | null
  /** Tab the pointer is near the top of (pending show). */
  candidate: TabId | null
  hovered: boolean
  /** The strip's pane is being dragged by it (SV-20): stay put until the drag ends. */
  dragging: boolean
  showTimer?: NodeJS.Timeout
  hideTimer?: NodeJS.Timeout
  fadeTimer?: NodeJS.Timeout
}

/** The strip fades out over this long before its view hides (SV-12). */
const FADE_OUT_MS = 120

/**
 * The floating pane strip (SV-12): a small transparent view centred at the top of a split
 * pane with the pane's close button and its split-controls menu. Pages are native views
 * above the shell, so the strip is a view of its own, shown while the pointer is near the
 * pane's top edge and never covering the page otherwise.
 */
export class PaneStrip {
  private windows = new Map<WindowId, StripState>()

  constructor(private ctx: MainContext) {
    ctx.store.subscribe((next) => this.onState(next))
  }

  /** Test/debug view of where the strip is. */
  info(windowId: WindowId): { tabId: TabId | null; visible: boolean; bounds?: Electron.Rectangle } {
    const s = this.windows.get(windowId)
    const view = s?.view
    return {
      tabId: s?.tabId ?? null,
      visible: !!view && !view.webContents.isDestroyed() && view.getVisible(),
      bounds: view?.getBounds(),
    }
  }

  onPageMouse(tabId: TabId, mouse: MouseInputEvent): void {
    const windowId = this.ctx.windows.windowOfTab(tabId)
    if (!windowId || !this.isShownPane(this.ctx.store.state, windowId, tabId)) return
    const s = this.stateOf(windowId)
    if (s.dragging) return
    if (mouse.type === 'mouseLeave') {
      s.candidate = null
      this.scheduleHide(windowId)
      return
    }
    if (mouse.type !== 'mouseMove' && mouse.type !== 'mouseEnter') return
    if (mouse.y <= REVEAL_ZONE) {
      clearTimeout(s.hideTimer)
      if (s.tabId === tabId || s.candidate === tabId) return
      s.candidate = tabId
      clearTimeout(s.showTimer)
      s.showTimer = setTimeout(() => {
        if (s.candidate === tabId) this.show(windowId, tabId)
      }, SHOW_DELAY_MS)
    } else if (mouse.y > HIDE_ZONE || s.tabId !== tabId) {
      if (s.candidate === tabId) s.candidate = null
      clearTimeout(s.showTimer)
      if (s.tabId) this.scheduleHide(windowId)
    }
  }

  setDragging(windowId: WindowId, dragging: boolean): void {
    const s = this.stateOf(windowId)
    if (s.dragging === dragging) return
    s.dragging = dragging
    if (dragging) clearTimeout(s.hideTimer)
    else this.scheduleHide(windowId)
  }

  setHovered(windowId: WindowId | undefined, hovered: boolean): void {
    if (!windowId) return
    const s = this.stateOf(windowId)
    s.hovered = hovered
    if (hovered) clearTimeout(s.hideTimer)
    else this.scheduleHide(windowId)
  }

  /** Shows the strip over a pane right away (also used by tests). */
  show(windowId: WindowId, tabId: TabId): void {
    const win = this.ctx.windows.get(windowId)
    const page = this.ctx.tabs.get(tabId)
    const state = this.ctx.store.state
    if (!win || win.isDestroyed() || !page || !this.isShownPane(state, windowId, tabId)) return
    if (state.windows[windowId]?.overlay.kind !== 'none') return
    const s = this.stateOf(windowId)
    clearTimeout(s.showTimer)
    clearTimeout(s.hideTimer)
    clearTimeout(s.fadeTimer)
    const view = s.view ?? this.createView(windowId)
    s.view = view
    s.tabId = tabId
    s.candidate = null
    const b = page.getBounds()
    view.setBounds({
      x: Math.round(b.x + b.width / 2 - STRIP_WIDTH / 2),
      y: Math.round(b.y + 6),
      width: STRIP_WIDTH,
      height: STRIP_HEIGHT,
    })
    // On top of the pages; the overlay re-adds itself above when it opens.
    win.contentView.addChildView(view)
    view.setVisible(true)
    view.webContents.send('orbit:strip:show', { tabId })
  }

  /** Hides the strip: a short fade, then the view goes away (`now` skips the fade). */
  hide(windowId: WindowId, now = false): void {
    const s = this.windows.get(windowId)
    if (!s) return
    clearTimeout(s.showTimer)
    clearTimeout(s.hideTimer)
    clearTimeout(s.fadeTimer)
    const wasShown = s.tabId !== null
    s.tabId = null
    s.candidate = null
    s.hovered = false
    s.dragging = false
    const view = s.view
    if (!view || view.webContents.isDestroyed()) return
    if (now || !wasShown) {
      view.setVisible(false)
      return
    }
    view.webContents.send('orbit:strip:hide', {})
    s.fadeTimer = setTimeout(() => {
      if (!s.tabId && !view.webContents.isDestroyed()) view.setVisible(false)
    }, FADE_OUT_MS)
  }

  private scheduleHide(windowId: WindowId): void {
    const s = this.stateOf(windowId)
    clearTimeout(s.hideTimer)
    s.hideTimer = setTimeout(() => {
      if (!s.hovered && !s.dragging) this.hide(windowId)
    }, HIDE_DELAY_MS)
  }

  private stateOf(windowId: WindowId): StripState {
    let s = this.windows.get(windowId)
    if (!s) {
      s = { tabId: null, candidate: null, hovered: false, dragging: false }
      this.windows.set(windowId, s)
    }
    return s
  }

  private isShownPane(state: OrbitState, windowId: WindowId, tabId: TabId): boolean {
    const active = activeTabOf(state, windowId)
    const splitId = splitOfTab(state, tabId)
    const split = splitId ? state.splits[splitId] : undefined
    return !!active && !!split && layoutLeaves(split.layout).includes(active)
  }

  private createView(windowId: WindowId): WebContentsView {
    const view = new WebContentsView({ webPreferences: uiWebPreferences(windowId, 'strip') })
    view.setBackgroundColor('#00000000')
    view.setVisible(false)
    const contents = view.webContents
    this.ctx.windows.registerUi(contents, windowId)
    this.ctx.windows.attachShortcuts(contents)
    contents.on('will-navigate', (event, url) => {
      const entry = rendererEntry()
      if (!(entry.url && url.startsWith(entry.url))) event.preventDefault()
    })
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    loadRenderer(contents, 'strip')
    const win = this.ctx.windows.get(windowId)
    win?.once('closed', () => {
      this.windows.delete(windowId)
      if (!contents.isDestroyed()) contents.close()
    })
    return view
  }

  /** The strip follows its pane: it hides when the pane goes away, the split is hidden or the overlay opens. */
  private onState(next: OrbitState): void {
    for (const [windowId, s] of this.windows) {
      if (!s.tabId) continue
      const win = next.windows[windowId]
      if (win?.overlay.kind !== 'none' || !next.tabs[s.tabId] || !this.isShownPane(next, windowId, s.tabId)) {
        this.hide(windowId, true)
      }
    }
  }
}
