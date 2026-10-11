import type { WebContentsView } from 'electron'
import type { Rect } from '../../shared/rpc'
import type { WindowId } from '../../shared/state'
import type { ToastPayload } from '../../shared/toast'
import type { MainContext } from '../context'
import { activeTabOf, viewContents } from '../windows'

/** Where the toasts sit in their view over the page (SB-13, FL-22). */
export const TOAST_VIEW = {
  /** Room around the stack in its view, for the toasts' shadow and the rise they come in with. */
  margin: 24,
  /** The stack's bottom edge above the page card's. */
  gap: 16,
} as const

export interface ToastViewInfo {
  /** The view is in the window, showing toasts. */
  visible: boolean
  bounds?: Rect
  /** The page card the toasts are centred on. */
  card?: Rect
}

interface WindowToasts {
  view?: WebContentsView
  /** The view's page listens for toasts. */
  ready: boolean
  /** Toasts sent before it did. */
  waiting: ToastPayload[]
  /** The stack's size as the view last measured it. */
  size: { width: number; height: number }
}

/**
 * Toasts while the sidebar is hidden (SB-13). The sidebar shows toasts at its foot, which is under
 * the page while it is hidden, so a confirmation (a new Space, SP-02; a tab opened in the background,
 * NV-08) and its button would go unseen. Then they show in a small view of their own over the
 * bottom centre of the page card (FL-22), sized to the stack and only there while it has toasts, in
 * the Space's colours (SP-16). The keyboard stays where it is.
 */
export function registerToastView(ctx: MainContext): { info: (windowId: WindowId) => ToastViewInfo } {
  const { store, windows, commands } = ctx
  const perWindow = new Map<WindowId, WindowToasts>()

  const live = (view: WebContentsView | undefined): view is WebContentsView => !!viewContents(view)

  const stateOf = (windowId: WindowId): WindowToasts | undefined => {
    const existing = perWindow.get(windowId)
    if (existing) return existing
    const win = windows.get(windowId)
    if (!win || win.isDestroyed()) return undefined
    const s: WindowToasts = { ready: false, waiting: [], size: { width: 0, height: 0 } }
    perWindow.set(windowId, s)
    win.once('closed', () => perWindow.delete(windowId))
    return s
  }

  /**
   * The page card the toasts go over: the selected tab's (its pane, in a split, FL-22), else the
   * card's frame (a Space with no tabs yet, as a new one is, SP-02).
   */
  const cardOf = (windowId: WindowId): Rect | undefined => {
    const active = activeTabOf(store.state, windowId)
    const card =
      (active ? windows.tabViewBounds(active) : undefined) ?? windows.frameArea(windowId) ?? windows.pageArea(windowId)
    if (card) return card
    const win = windows.get(windowId)
    if (!win || win.isDestroyed()) return undefined
    const [width = 0, height = 0] = win.getContentSize()
    return { x: 0, y: 0, width, height }
  }

  const rectFor = (card: Rect, size: { width: number; height: number }): Rect => {
    const { margin, gap } = TOAST_VIEW
    const width = Math.ceil(size.width) + 2 * margin
    const height = Math.ceil(size.height) + 2 * margin
    return {
      x: Math.round(card.x + (card.width - width) / 2),
      y: Math.round(card.y + card.height - gap + margin - height),
      width,
      height,
    }
  }

  const place = (windowId: WindowId) => {
    const s = perWindow.get(windowId)
    if (!s || !live(s.view)) return
    const card = s.size.width > 0 && s.size.height > 0 ? cardOf(windowId) : undefined
    if (!card) windows.hideUiView(windowId, s.view)
    else windows.showUiView(windowId, s.view, rectFor(card, s.size))
  }

  windows.routeToasts((windowId, payload) => {
    const win = store.state.windows[windowId]
    // The sidebar shows its own toasts while it is there; a Mini Window has none.
    if (!win || win.sidebar.visible || win.kind === 'mini') return false
    const s = stateOf(windowId)
    if (!s) return false
    if (!live(s.view)) {
      s.view = windows.createUiView(windowId, 'toasts')
      s.ready = false
      s.size = { width: 0, height: 0 }
    }
    if (!live(s.view)) return false
    const toast = payload as ToastPayload
    if (s.ready) viewContents(s.view)?.send('orbit:toast', toast)
    else s.waiting.push(toast)
    return true
  })

  commands.register('toasts.ready', (_args, c) => {
    const s = c.windowId ? perWindow.get(c.windowId) : undefined
    const contents = viewContents(s?.view)
    if (!s || !contents || c.sender !== contents) return
    s.ready = true
    for (const toast of s.waiting.splice(0)) contents.send('orbit:toast', toast)
  })

  commands.register('toasts.size', ({ width, height }, c) => {
    const windowId = c.windowId
    const s = windowId ? perWindow.get(windowId) : undefined
    if (!windowId || !s || c.sender !== viewContents(s.view)) return
    s.size = { width: Math.max(0, width), height: Math.max(0, height) }
    place(windowId)
  })

  // The page card moved, or another tab shows: the toasts go with the card.
  windows.onLayout((windowId) => place(windowId))
  // The other pane of a split in use (its card stays where it was, so no layout follows): the toasts
  // go over it.
  store.subscribe((next, prev) => {
    if (next.windows === prev.windows && next.tabs === prev.tabs) return
    for (const windowId of perWindow.keys()) {
      if (activeTabOf(next, windowId) !== activeTabOf(prev, windowId)) place(windowId)
    }
  })

  return {
    info: (windowId) => {
      const s = perWindow.get(windowId)
      const view = live(s?.view) ? s?.view : undefined
      const placed = !!view && !!windows.get(windowId)?.contentView.children.includes(view)
      return {
        visible: placed && !!view?.getVisible(),
        bounds: view?.getBounds(),
        card: cardOf(windowId),
      }
    },
  }
}
