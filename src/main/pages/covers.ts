import { webContents as allContents, BrowserWindow, type WebContents, WebContentsView } from 'electron'
import type { Rect, RendererView } from '../../shared/rpc'
import type { WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import { activeTabOf, loadRenderer, rendererEntry, uiWebPreferences, viewContents } from '../windows'

/**
 * Where a page's cover shows: over a tab's page in a main window (a split pane included), over a
 * Peek's or a Mini Window's page, or over a pop-up window's page.
 */
export type HostKind = 'tab' | 'floating' | 'popup'

interface Host {
  kind: HostKind
  win: BrowserWindow
  /** The Orbit window: the main window (a tab, a Peek) or the Mini Window. None for a pop-up. */
  windowId?: WindowId
}

/** What a cover's view shows; its page is sent each new one (by id). */
export interface CoverContent {
  id: number
}

/** One page's cover. */
interface Cover {
  page: WebContents
  view?: WebContentsView
  host?: Host
  /** The view's page has loaded: only then does the view go into its window. */
  ready: boolean
  /** What the view's page was last sent. */
  sent?: number
  /** The view is in its window, over the page. */
  onScreen: boolean
  off: () => void
}

export interface CoverInfo {
  /** Where it shows; null while the page has no window. */
  host: HostKind | null
  /** Its view is on screen over the page. */
  onScreen: boolean
  /** Its view has the keyboard. */
  focused: boolean
  bounds?: Rect
}

export interface PageCovers<C extends CoverContent> {
  /** Brings a page's cover in line with what it shows now (`content`): shown, moved or gone. */
  update(page: WebContents): void
  /** What the cover view `sender` shows, and over which page (for the view's own requests). */
  shownBy(sender: WebContents): { page: WebContents; content: C } | undefined
  /** Whether Orbit can place a cover over a page: a tab's (a Peek's and a Mini Window's too) or a pop-up's. */
  hostable(page: WebContents): boolean
  info(page: WebContents): CoverInfo
}

/**
 * Orbit's own views over one page's area only (NV-24, NV-13, NV-14): a transparent view of the
 * renderer (`view`) placed over the page while `content(page)` gives it something to show, and
 * kept there as the page moves (tab switches, splits, resizes, a Peek springing open). It waits
 * while the page is off screen and shows again with it. When it appears over the page the user is
 * on, it takes the keyboard (unless `mayTakeKeyboard` says no), and keeps it while it shows: the
 * page gets it back when it goes.
 *
 * A main window's views are made when first needed and kept for the next cover; a Peek's, a Mini
 * Window's or a pop-up's view is its own and is closed when the cover goes.
 */
export function createCovers<C extends CoverContent>(
  ctx: MainContext,
  opts: {
    view: RendererView
    content: (page: WebContents) => C | undefined
    /**
     * Whether a cover that appears over the page the user is on may take the keyboard from
     * `focused` (what has it now). By default it always does, as a page's own dialog does.
     */
    mayTakeKeyboard?: (page: WebContents, focused: WebContents | null) => boolean
    /** A key pressed in the view (`view`) while it shows over `page`. */
    onKey?: (page: WebContents, view: WebContents, event: Electron.Event, input: Electron.Input) => void
  },
): PageCovers<C> {
  const { store, tabs, windows } = ctx
  const channel = `orbit:${opts.view}:content`
  const covers = new Map<number, Cover>()
  const pools = new Map<WindowId, Set<WebContentsView>>()
  const inUse = new Set<WebContentsView>()

  const hostOf = (page: WebContents): Host | undefined => {
    const tabId = tabs.tabIdFor(page)
    if (tabId) {
      const windowId = windows.windowOfTab(tabId)
      if (!windowId) return undefined
      if (store.state.tabs[tabId]?.floating) {
        const win = BrowserWindow.fromWebContents(page)
        return win && !win.isDestroyed() ? { kind: 'floating', win, windowId } : undefined
      }
      const win = windows.get(windowId)
      return win && !win.isDestroyed() ? { kind: 'tab', win, windowId } : undefined
    }
    // A pop-up window's page: the window's own contents.
    if (windows.isUi(page)) return undefined
    const win = BrowserWindow.fromWebContents(page)
    return win && !win.isDestroyed() && win.webContents === page ? { kind: 'popup', win } : undefined
  }

  const hostable = (page: WebContents): boolean => {
    if (tabs.tabIdFor(page)) return true
    if (windows.isUi(page)) return false
    return BrowserWindow.fromWebContents(page)?.webContents === page
  }

  const sameHost = (a: Host, b: Host) => a.kind === b.kind && a.win === b.win

  /** Where the cover goes (window coordinates): over the page, while the page is on screen. */
  const placeOf = (c: Cover, host: Host): Rect | undefined => {
    if (host.kind === 'popup') {
      if (!host.win.isVisible()) return undefined
      const [width = 0, height = 0] = host.win.getContentSize()
      return { x: 0, y: 0, width, height }
    }
    const tabId = tabs.tabIdFor(c.page)
    if (!tabId) return undefined
    if (host.kind === 'tab') return windows.tabViewBounds(tabId)
    const view = tabs.get(tabId)
    if (!view?.getVisible() || !host.win.contentView.children.includes(view)) return undefined
    return view.getBounds()
  }

  /** The page is the one the user is on: its window has focus, and nothing covers the page. */
  const pageIsCurrent = (c: Cover, host: Host): boolean => {
    if (!host.win.isFocused()) return false
    if (host.kind !== 'tab' || !host.windowId) return true
    const tabId = tabs.tabIdFor(c.page)
    const win = store.state.windows[host.windowId]
    return (
      !!tabId &&
      activeTabOf(store.state, host.windowId) === tabId &&
      win?.overlay.kind === 'none' &&
      !windows.hasPageCover(host.windowId)
    )
  }

  const hasKeyboard = (view: WebContentsView | undefined) => {
    const contents = viewContents(view)
    return !!contents && allContents.getFocusedWebContents() === contents
  }

  /** Orbit's UI never navigates away or opens windows (as WindowManager's own views). */
  const harden = (contents: WebContents) => {
    contents.on('will-navigate', (event, url) => {
      const entry = rendererEntry()
      if (!(entry.url && url.startsWith(entry.url))) event.preventDefault()
    })
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  }

  /** Follows a view: its loads, its crashes, and keys pressed in it. */
  const watchView = (view: WebContentsView) => {
    const contents = viewContents(view)
    const { onKey } = opts
    if (contents && onKey) {
      contents.on('before-input-event', (event, input) => {
        for (const c of covers.values()) if (c.view === view && c.onScreen) onKey(c.page, contents, event, input)
      })
    }
    contents?.on('did-finish-load', () => {
      for (const c of covers.values()) {
        if (c.view !== view) continue
        c.ready = true
        c.sent = undefined
        update(c.page)
      }
    })
    contents?.on('render-process-gone', () => {
      for (const c of covers.values()) {
        if (c.view !== view) continue
        c.ready = false
        c.onScreen = false
      }
    })
  }

  /** A main window's free view, made if none is free. */
  const pooledView = (windowId: WindowId): WebContentsView | undefined => {
    const pool = pools.get(windowId) ?? new Set<WebContentsView>()
    pools.set(windowId, pool)
    for (const view of pool) {
      if (!viewContents(view)) pool.delete(view)
      else if (!inUse.has(view)) return view
    }
    const view = windows.createUiView(windowId, opts.view)
    if (!view) return undefined
    pool.add(view)
    watchView(view)
    windows.get(windowId)?.once('closed', () => {
      for (const v of pool) inUse.delete(v)
      pools.delete(windowId)
    })
    return view
  }

  /** A view over a Peek's, a Mini Window's or a pop-up's page: its own, closed after the cover goes. */
  const looseView = (host: Host): WebContentsView => {
    const windowId = host.windowId ?? windows.focusedWindowId() ?? windows.ids()[0] ?? ''
    const view = new WebContentsView({ webPreferences: uiWebPreferences(windowId, opts.view) })
    view.setBackgroundColor('#00000000')
    view.setVisible(false)
    const contents = view.webContents
    windows.registerUi(contents, windowId)
    windows.attachShortcuts(contents)
    harden(contents)
    // A view that crashed loads again, once: what it showed shows again.
    contents.once('render-process-gone', (_event, details) => {
      if (details.reason !== 'clean-exit' && !contents.isDestroyed()) loadRenderer(contents, opts.view)
    })
    watchView(view)
    loadRenderer(contents, opts.view)
    host.win.once('closed', () => viewContents(view)?.close())
    return view
  }

  const ensureView = (c: Cover, host: Host): WebContentsView | undefined => {
    if (c.view && viewContents(c.view) && c.host && sameHost(c.host, host)) return c.view
    release(c)
    c.host = host
    c.ready = false
    c.sent = undefined
    const view = host.kind === 'tab' && host.windowId ? pooledView(host.windowId) : looseView(host)
    if (!view) return undefined
    c.view = view
    inUse.add(view)
    // A pooled view that has loaded already is ready now.
    const contents = viewContents(view)
    if (contents && !contents.isLoading() && contents.getURL() !== '') c.ready = true
    return view
  }

  /** Takes a page's view off screen; `focusPage` gives the page the keyboard if the view had it. */
  const hide = (c: Cover, focusPage: boolean) => {
    const view = c.view
    const host = c.host
    c.onScreen = false
    if (!view || !host || !viewContents(view)) return
    const had = hasKeyboard(view)
    if (host.kind === 'tab' && host.windowId) windows.hideUiView(host.windowId, view)
    else {
      if (!host.win.isDestroyed() && host.win.contentView.children.includes(view))
        host.win.contentView.removeChildView(view)
      view.setVisible(false)
    }
    if (had && focusPage && !c.page.isDestroyed()) c.page.focus()
  }

  /** Gives a page's view back: a pooled one to its window's pool, a loose one is closed. */
  const release = (c: Cover) => {
    const view = c.view
    if (!view) return
    hide(c, false)
    inUse.delete(view)
    c.view = undefined
    c.host = undefined
    c.ready = false
    c.sent = undefined
    const pooled = [...pools.values()].some((pool) => pool.has(view))
    if (!pooled) viewContents(view)?.close()
  }

  /** The cover's gone: the keyboard goes back to the page (KS-16), and a main window keeps the view. */
  const drop = (c: Cover) => {
    covers.delete(c.page.id)
    hide(c, true)
    release(c)
    c.off()
  }

  const entryFor = (page: WebContents): Cover => {
    const existing = covers.get(page.id)
    if (existing) return existing
    // The page has the keyboard while its cover shows: the cover takes it (KS-19).
    const onFocus = () => {
      const c = covers.get(page.id)
      if (c?.onScreen) viewContents(c.view)?.focus()
    }
    const gone = () => {
      const c = covers.get(page.id)
      if (!c) return
      covers.delete(page.id)
      c.off()
      release(c)
    }
    const onBounds = () => {
      if (covers.has(page.id)) update(page)
    }
    page.on('focus', onFocus)
    page.once('destroyed', gone)
    // A Peek's or a Mini Window's page moves on its own: the cover follows it.
    const tabId = tabs.tabIdFor(page)
    const pageView = tabId ? tabs.get(tabId) : undefined
    pageView?.on('bounds-changed', onBounds)
    const c: Cover = {
      page,
      ready: false,
      onScreen: false,
      off: () => {
        if (!page.isDestroyed()) {
          page.off('focus', onFocus)
          page.off('destroyed', gone)
        }
        pageView?.off('bounds-changed', onBounds)
      },
    }
    covers.set(page.id, c)
    return c
  }

  const update = (page: WebContents) => {
    const content = page.isDestroyed() ? undefined : opts.content(page)
    const existing = covers.get(page.id)
    if (!content) {
      if (existing) drop(existing)
      return
    }
    const c = existing ?? entryFor(page)
    const host = hostOf(page)
    const bounds = host ? placeOf(c, host) : undefined
    if (!host || !bounds || bounds.width < 1 || bounds.height < 1) {
      hide(c, false)
      return
    }
    const view = ensureView(c, host)
    if (!view || !c.ready) return
    if (c.sent !== content.id) {
      c.sent = content.id
      viewContents(view)?.send(channel, content)
    }
    const appearing = !c.onScreen
    if (host.kind === 'tab' && host.windowId) windows.showUiView(host.windowId, view, bounds)
    else {
      // Over the page, which sits above the window's overlay (a Peek) or alone in its window.
      const parent = host.win.contentView
      if (parent.children[parent.children.length - 1] !== view) parent.addChildView(view)
      const at = view.getBounds()
      if (at.x !== bounds.x || at.y !== bounds.y || at.width !== bounds.width || at.height !== bounds.height) {
        view.setBounds(bounds)
      }
      if (!view.getVisible()) view.setVisible(true)
    }
    c.onScreen = true
    if (!appearing || !pageIsCurrent(c, host)) return
    const focused = allContents.getFocusedWebContents() ?? null
    if (opts.mayTakeKeyboard && !opts.mayTakeKeyboard(page, focused)) return
    viewContents(view)?.focus()
  }

  const updateAll = () => {
    for (const c of [...covers.values()]) update(c.page)
  }
  // Pages move: tab switches, splits, resizes, full screen, DevTools docking, the Library.
  windows.onLayout(() => updateAll())
  store.subscribe(() => {
    if (covers.size > 0) updateAll()
  })

  return {
    update,
    shownBy(sender) {
      for (const c of covers.values()) {
        if (viewContents(c.view) !== sender) continue
        const content = c.page.isDestroyed() ? undefined : opts.content(c.page)
        if (!content) return undefined
        c.sent = content.id
        return { page: c.page, content }
      }
      return undefined
    },
    hostable,
    info(page) {
      const c = covers.get(page.id)
      return {
        host: page.isDestroyed() ? null : (hostOf(page)?.kind ?? null),
        onScreen: !!c?.onScreen,
        focused: hasKeyboard(c?.view),
        ...(c?.onScreen && c.view ? { bounds: c.view.getBounds() } : {}),
      }
    },
  }
}
