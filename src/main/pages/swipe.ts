import { type IpcMainEvent, ipcMain, systemPreferences, type WebContents, type WebContentsView } from 'electron'
import { PAGE_CHANNEL } from '../../shared/site'
import type { TabId, WindowId } from '../../shared/state'
import { HISTORY_SWIPE, type SwipeArrow, type SwipeDirection } from '../../shared/swipe'
import type { MainContext } from '../context'
import { shownTabs, viewContents } from '../windows'

export interface SwipeInfo {
  visible: boolean
  tabId: TabId | null
  direction: SwipeDirection | null
  travel: number
  armed: boolean
  bounds?: Electron.Rectangle
  /** How the last swipe ended: how far it had gone, and whether it went back or forward. */
  last: { direction: SwipeDirection; travel: number; went: boolean } | null
}

interface WindowSwipe {
  view?: WebContentsView
  tabId: TabId | null
  direction: SwipeDirection
  travel: number
  /** What the view shows: the last swipe's arrow, which a view that loads late shows too (faded, if done). */
  arrow: SwipeArrow | null
  fade?: ReturnType<typeof setTimeout>
  last: SwipeInfo['last']
}

/** Whether a two-finger swipe may go back or forward here: macOS's "Swipe between pages" setting. */
const swipesBetweenPages = (): boolean =>
  process.platform !== 'darwin' || systemPreferences.isSwipeTrackingFromScrollEventsEnabled()

/**
 * Two-finger swipe back and forward over a page (NV-02). The page preload tells of a horizontal
 * swipe the page doesn't take (src/preload/swipe.ts). An arrow slides in from that edge of the
 * page's card, following the fingers 1:1, and letting go once it's fully in goes back or forward, as
 * the Back and Forward buttons do. Only for a page shown in a window's page card (split panes
 * included), with somewhere to go, and on macOS only with the system's "Swipe between pages" on.
 * Over the sidebar the same swipe is the Space swipe (SP-08): the sidebar isn't the page.
 */
export function registerSwipe(ctx: MainContext): { info: (windowId: WindowId) => SwipeInfo } {
  const { commands, store, tabs, windows } = ctx
  const perWindow = new Map<WindowId, WindowSwipe>()
  const { size, distance } = HISTORY_SWIPE

  const stateOf = (windowId: WindowId): WindowSwipe | undefined => {
    const existing = perWindow.get(windowId)
    if (existing) return existing
    const win = windows.get(windowId)
    if (!win || win.isDestroyed()) return undefined
    const s: WindowSwipe = { tabId: null, direction: 'back', travel: 0, arrow: null, last: null }
    perWindow.set(windowId, s)
    win.once('closed', () => {
      clearTimeout(s.fade)
      perWindow.delete(windowId)
    })
    return s
  }

  const tell = (s: WindowSwipe, arrow: SwipeArrow) => {
    const was = s.arrow
    s.arrow = arrow
    if (was?.direction === arrow.direction && was.armed === arrow.armed && was.done === arrow.done) return
    viewContents(s.view)?.send('orbit:swipe', arrow)
  }

  const hide = (windowId: WindowId, s: WindowSwipe) => {
    clearTimeout(s.fade)
    s.fade = undefined
    s.tabId = null
    s.travel = 0
    if (viewContents(s.view) && s.view) windows.hideUiView(windowId, s.view)
  }

  /** The arrow `travel` px in from its edge of the card, the part past the edge cut off. */
  const place = (windowId: WindowId, s: WindowSwipe) => {
    const card = s.tabId ? windows.tabViewBounds(s.tabId) : undefined
    if (!card || !s.view) return hide(windowId, s)
    const inner = Math.min(s.travel, distance)
    const shown = Math.min(size, inner)
    if (shown < 1) return windows.hideUiView(windowId, s.view)
    const offset = inner - shown
    const x = s.direction === 'back' ? card.x + offset : card.x + card.width - offset - shown
    const y = card.y + Math.round((card.height - size) / 2)
    windows.showUiView(windowId, s.view, { x, y, width: shown, height: size })
  }

  const move = (windowId: WindowId, tabId: TabId, page: WebContents, direction: SwipeDirection, travel: number) => {
    const s = stateOf(windowId)
    if (!s) return
    if (s.tabId !== tabId || s.direction !== direction || s.fade) {
      // A new swipe: only with somewhere to go.
      const history = page.navigationHistory
      const canGo = direction === 'back' ? history.canGoBack() : history.canGoForward()
      if (!canGo || !swipesBetweenPages()) return
      hide(windowId, s)
      s.tabId = tabId
      s.direction = direction
      if (!viewContents(s.view)) s.view = windows.createUiView(windowId, 'swipe')
    }
    s.travel = Math.max(0, Math.min(distance, travel))
    tell(s, { direction, armed: s.travel >= distance, done: false })
    place(windowId, s)
  }

  const end = (windowId: WindowId, tabId: TabId, direction: SwipeDirection, commit: boolean) => {
    const s = perWindow.get(windowId)
    if (!s || s.tabId !== tabId || s.direction !== direction || s.fade) return
    const go = commit && s.travel >= distance
    s.last = { direction, travel: s.travel, went: go }
    if (go) void commands.run(direction === 'back' ? 'tabs.back' : 'tabs.forward', { tabId })
    tell(s, { direction, armed: go, done: true })
    s.fade = setTimeout(() => {
      if (perWindow.get(windowId) === s && s.tabId === tabId) hide(windowId, s)
    }, HISTORY_SWIPE.fadeMs)
  }

  // The view asks when it loads: what was sent before it listened is lost.
  commands.register('pages.swipeArrow', (_args, c) => (c.windowId ? (perWindow.get(c.windowId)?.arrow ?? null) : null))

  ipcMain.on(PAGE_CHANNEL.swipe, (event: IpcMainEvent, kind: unknown, direction: unknown, value: unknown) => {
    const page = event.sender
    const frame = event.senderFrame
    if (!frame || frame.parent || page.isDestroyed()) return
    if (direction !== 'back' && direction !== 'forward') return
    const tabId = tabs.tabIdFor(page)
    const windowId = tabId ? windows.windowOfTab(tabId) : undefined
    if (!tabId || !windowId || !shownTabs(store.state, windowId).has(tabId)) return
    if (kind === 'move' && typeof value === 'number' && Number.isFinite(value)) {
      move(windowId, tabId, page, direction, value)
    } else if (kind === 'end') end(windowId, tabId, direction, value === true)
  })

  // Another tab shown: its arrow goes. The page card moved: the arrow follows.
  store.subscribe((next) => {
    for (const [windowId, s] of perWindow) if (s.tabId && !shownTabs(next, windowId).has(s.tabId)) hide(windowId, s)
  })
  windows.onLayout((windowId) => {
    const s = perWindow.get(windowId)
    if (s?.tabId) place(windowId, s)
  })

  return {
    info: (windowId) => {
      const s = perWindow.get(windowId)
      const view = viewContents(s?.view) ? s?.view : undefined
      return {
        visible: !!view?.getVisible(),
        tabId: s?.tabId ?? null,
        direction: s?.tabId ? s.direction : null,
        travel: s?.travel ?? 0,
        armed: !!s?.tabId && s.travel >= distance,
        ...(view ? { bounds: view.getBounds() } : {}),
        last: s?.last ?? null,
      }
    },
  }
}
