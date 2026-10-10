import type { WebContentsView } from 'electron'
import type { TabId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import { activeTabOf, viewContents } from '../windows'

/** A page has to be loading this long before the indicator shows, so quick loads never flash it (FL-23). */
export const LOADING_SHOW_AFTER_MS = 150
/** The indicator's finish (a short fill, then a fade; loading.css) before its view goes: within 200 ms (FL-23). */
const LOADING_FINISH_MS = 180
/**
 * The indicator's view: a small pill centred just inside the page card's top edge, with room for its
 * shadow. Kept small, as it sits over the page (a view takes the clicks under it).
 */
export const LOADING_VIEW = { width: 60, height: 14, top: 2 } as const

export type LoadingState = 'loading' | 'done'

export interface LoadingInfo {
  tabId: TabId | null
  visible: boolean
  state: LoadingState | null
  bounds?: Electron.Rectangle
  /** How many times it has been shown in this window (tests: a quick load never shows it). */
  shown: number
  /** Waiting out the delay before it shows. */
  pending: boolean
}

interface WindowLoading {
  view?: WebContentsView
  /** The tab the indicator is out for. */
  tabId: TabId | null
  state: LoadingState | null
  showTimer?: ReturnType<typeof setTimeout>
  hideTimer?: ReturnType<typeof setTimeout>
  shown: number
}

/**
 * The page loading indicator (SB-28, FL-23): a small theme-tinted pill at the top centre of the
 * page card of the window's shown tab (the focused pane in split view), drawn in a view of its own
 * over the page, so it never moves page content and shows in full screen too. It appears once the
 * page has been loading for 150 ms; when the load ends (or is stopped) it fills and fades out.
 */
export function registerLoading(ctx: MainContext): { info: (windowId: WindowId) => LoadingInfo } {
  const { store, windows } = ctx
  /** When each loading tab started loading. */
  const since = new Map<TabId, number>()
  const perWindow = new Map<WindowId, WindowLoading>()

  const stateOf = (windowId: WindowId): WindowLoading | undefined => {
    let s = perWindow.get(windowId)
    if (s) return s
    const win = windows.get(windowId)
    if (!win || win.isDestroyed()) return undefined
    s = { tabId: null, state: null, shown: 0 }
    perWindow.set(windowId, s)
    const record = s
    win.once('closed', () => {
      clearTimeout(record.showTimer)
      clearTimeout(record.hideTimer)
      perWindow.delete(windowId)
    })
    return s
  }

  /** A view whose page is alive (its `webContents` is undefined once the page is gone). */
  const live = (view: WebContentsView | undefined): view is WebContentsView => !!viewContents(view)

  const send = (s: WindowLoading, state: LoadingState) => {
    s.state = state
    viewContents(s.view)?.send('orbit:loading:state', { state })
  }

  /** Where the pill goes over a tab's page, or undefined when the page isn't on screen. */
  const boundsFor = (tabId: TabId): Electron.Rectangle | undefined => {
    const page = windows.tabViewBounds(tabId)
    if (!page || page.width < LOADING_VIEW.width || page.height < LOADING_VIEW.height) return undefined
    return {
      x: Math.round(page.x + page.width / 2 - LOADING_VIEW.width / 2),
      y: Math.round(page.y + LOADING_VIEW.top),
      width: LOADING_VIEW.width,
      height: LOADING_VIEW.height,
    }
  }

  const hide = (windowId: WindowId, s: WindowLoading) => {
    clearTimeout(s.hideTimer)
    s.hideTimer = undefined
    s.tabId = null
    s.state = null
    if (live(s.view)) windows.hideUiView(windowId, s.view)
  }

  const show = (windowId: WindowId, s: WindowLoading, tabId: TabId) => {
    const bounds = boundsFor(tabId)
    if (!bounds) {
      hide(windowId, s)
      return
    }
    clearTimeout(s.hideTimer)
    s.hideTimer = undefined
    if (!live(s.view)) s.view = windows.createUiView(windowId, 'loading')
    if (!s.view) return
    const fresh = s.tabId !== tabId || s.state !== 'loading'
    s.tabId = tabId
    send(s, 'loading')
    windows.showUiView(windowId, s.view, bounds)
    if (fresh) s.shown++
  }

  /** The load the indicator was out for ended: it finishes, then goes. */
  const finish = (windowId: WindowId, s: WindowLoading) => {
    if (s.state === 'done') return
    send(s, 'done')
    clearTimeout(s.hideTimer)
    s.hideTimer = setTimeout(() => {
      s.hideTimer = undefined
      if (s.state === 'done') hide(windowId, s)
    }, LOADING_FINISH_MS)
  }

  /** Brings a window's indicator in line with its shown tab and that tab's loading. */
  const evaluate = (windowId: WindowId) => {
    const s = stateOf(windowId)
    if (!s) return
    clearTimeout(s.showTimer)
    s.showTimer = undefined
    // Never over a page in HTML full screen (a video): it comes back when that ends, if the page is
    // still loading (review A-M1). Native full screen keeps it (SB-28).
    if (windows.inHtmlFullscreen(windowId)) {
      if (s.tabId) hide(windowId, s)
      return
    }
    const target = activeTabOf(store.state, windowId)
    const started = target ? since.get(target) : undefined
    if (!target || started === undefined) {
      // The page finished (or was stopped): the pill fills and fades. Another tab took its place: it goes.
      if (s.tabId && s.tabId === target && s.state === 'loading') finish(windowId, s)
      else if (s.tabId && s.tabId !== target) hide(windowId, s)
      return
    }
    if (s.tabId === target && s.state === 'loading') {
      // Still loading: follow the page card if it moved.
      show(windowId, s, target)
      return
    }
    const wait = started + LOADING_SHOW_AFTER_MS - Date.now()
    if (wait <= 0) {
      show(windowId, s, target)
      return
    }
    // Not long enough yet; a tab that was out for another page goes at once.
    if (s.tabId && s.tabId !== target) hide(windowId, s)
    s.showTimer = setTimeout(() => {
      s.showTimer = undefined
      if (perWindow.get(windowId) === s) evaluate(windowId)
    }, wait)
  }

  const evaluateTab = (tabId: TabId) => {
    const windowId = windows.windowOfTab(tabId)
    if (windowId) evaluate(windowId)
  }

  ctx.hooks.tabCreated.push((tabId, contents) => {
    contents.on('did-start-loading', () => {
      since.set(tabId, Date.now())
      evaluateTab(tabId)
    })
    contents.on('did-stop-loading', () => {
      since.delete(tabId)
      evaluateTab(tabId)
    })
    contents.once('destroyed', () => {
      since.delete(tabId)
      for (const [windowId, s] of perWindow) if (s.tabId === tabId) evaluate(windowId)
    })
  })

  // Another tab shown (tab switch, Space switch, split focus), or the page card moved.
  store.subscribe((next, prev) => {
    for (const windowId of perWindow.keys()) {
      if (activeTabOf(next, windowId) !== activeTabOf(prev, windowId)) evaluate(windowId)
    }
    for (const windowId of Object.keys(next.windows)) {
      if (perWindow.has(windowId)) continue
      const tabId = activeTabOf(next, windowId)
      if (tabId && since.has(tabId)) evaluate(windowId)
    }
  })
  // The page card moved, or HTML full screen began or ended: the indicator follows, goes, or comes back.
  windows.onLayout((windowId) => {
    const s = perWindow.get(windowId)
    if (!s) return
    const target = activeTabOf(store.state, windowId)
    if (s.tabId || (target && since.has(target))) evaluate(windowId)
  })

  return {
    info: (windowId) => {
      const s = perWindow.get(windowId)
      const view = live(s?.view) ? s?.view : undefined
      return {
        tabId: s?.tabId ?? null,
        visible: !!view?.getVisible(),
        state: s?.state ?? null,
        bounds: view?.getBounds(),
        shown: s?.shown ?? 0,
        pending: !!s?.showTimer,
      }
    },
  }
}
