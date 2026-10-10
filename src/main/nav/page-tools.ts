import type { Rectangle, WebContents } from 'electron'
import {
  type FindState,
  findTextFromSelection,
  PAGE_TOOLS,
  peekShown,
  sameZoom,
  type ZoomIndicator,
  zoomPercent,
  zoomStep,
} from '../../shared/nav'
import type { TabId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import { setPageZoom } from '../peek/page-actions'
import type { CallContext } from '../registry'
import { activeTabOf } from '../windows'
import { NAV_WORLD } from './focus'
import type { SitePrefs } from './site-prefs'

/** The zoom indicator stays this long after the last change, and while the pointer is on it (NV-06). */
export const ZOOM_INDICATOR_MS = 1500
/** Pinch-to-zoom reaches Chromium's own limit (NV-06). */
const PINCH_MAX = 5

const SELECTION = `String(getSelection() || '')`

/** Scrolls the page so its selection (or the focused text field) is in the middle (⌘J). */
const JUMP_TO_SELECTION = `(() => {
  const active = document.activeElement
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
    active.scrollIntoView({ block: 'center', inline: 'nearest' })
    return true
  }
  const s = getSelection()
  if (!s || s.rangeCount === 0) return false
  const node = s.getRangeAt(0).startContainer
  const el = node instanceof Element ? node : node.parentElement
  if (!el) return false
  el.scrollIntoView({ block: 'center', inline: 'nearest' })
  return true
})()`

interface FindSession {
  open: boolean
  query: string
  active: number
  matches: number
  searched: boolean
  focus: number
  /** The latest find request: results of older ones are ignored. */
  request: number
  /** Counts the bar's edits, so a late selection never replaces what was typed. */
  edits: number
}

interface WindowTools {
  zoom: ZoomIndicator | null
  zoomTimer?: NodeJS.Timeout
  hovered: boolean
  /** What the view was last told, so a layout pass doesn't repeat it. */
  sent?: string
}

export interface PageToolsInfo {
  find: FindState
  zoom: ZoomIndicator | null
  /** The pointer is on the zoom indicator (it stays while it is). */
  hovered: boolean
  placed: boolean
  bounds?: Rectangle
}

const CLOSED: FindState = {
  tabId: null,
  open: false,
  query: '',
  active: 0,
  matches: 0,
  searched: false,
  focus: 0,
}

/** The host whose zoom Orbit remembers (web pages only). */
function zoomHost(url: string): string | undefined {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : undefined
  } catch {
    return undefined
  }
}

/** Where the page tools go: their cards' top-right corner `inset` px inside the page's, plus the shadow's margin. */
function toolsBounds(page: Rectangle, find: boolean, zoom: boolean): Rectangle {
  const { margin, inset, gap, findWidth, findHeight, zoomWidth, zoomHeight } = PAGE_TOOLS
  const room = Math.max(120, page.width - 2 * inset)
  const width = Math.min(find ? findWidth : zoomWidth, room)
  const height = (find ? findHeight : 0) + (find && zoom ? gap : 0) + (zoom ? zoomHeight : 0)
  return {
    x: page.x + page.width - inset - width - margin,
    y: page.y + inset - margin,
    width: width + 2 * margin,
    height: height + 2 * margin,
  }
}

/**
 * Find in page (NV-05) and page zoom (NV-06). Both show in the page tools view over the top-right
 * corner of the active page: the find bar while it is open for that tab, and a short-lived zoom
 * indicator after each zoom change. Find is per tab (switching tabs hides the bar, returning brings
 * it back with its matches); zoom is Chromium's per-host zoom, remembered per profile across launches.
 */
export function registerPageTools(ctx: MainContext, prefs: SitePrefs): { info: (windowId: WindowId) => PageToolsInfo } {
  const { store, commands, actions, tabs, windows } = ctx
  const finds = new Map<TabId, FindSession>()
  const tools = new Map<WindowId, WindowTools>()
  let focusNonce = 0
  let zoomNonce = 0

  const windowOf = (c: CallContext): WindowId | undefined => c.windowId ?? windows.focusedWindowId()
  const toolsOf = (windowId: WindowId): WindowTools => {
    let t = tools.get(windowId)
    if (!t) {
      t = { zoom: null, hovered: false }
      tools.set(windowId, t)
    }
    return t
  }
  const pageOf = (tabId: TabId | null | undefined): WebContents | undefined => {
    const contents = tabId ? tabs.contents(tabId) : undefined
    return contents && !contents.isDestroyed() ? contents : undefined
  }
  const activeOf = (windowId: WindowId | undefined): TabId | null =>
    windowId ? activeTabOf(store.state, windowId) : null

  const findState = (windowId: WindowId): FindState => {
    const tabId = activeOf(windowId)
    const s = tabId ? finds.get(tabId) : undefined
    if (!tabId || !s) return { ...CLOSED, tabId }
    const { open, query, active, matches, searched, focus } = s
    return { tabId, open, query, active, matches, searched, focus }
  }

  /** Shows, moves or hides a window's page tools to match what they hold. */
  const refresh = (windowId: WindowId) => {
    if (!windows.get(windowId)) {
      clearTimeout(tools.get(windowId)?.zoomTimer)
      tools.delete(windowId)
      return
    }
    const t = tools.get(windowId)
    const find = findState(windowId)
    const zoom = t?.zoom ?? null
    const page = find.tabId ? windows.tabViewBounds(find.tabId) : undefined
    if (!(find.open || zoom) || !page || windows.inHtmlFullscreen(windowId)) {
      // Nothing is under the pointer once the view has gone.
      if (t) t.hovered = false
      windows.hideTools(windowId)
      return
    }
    const contents = windows.toolsContents(windowId)
    if (!contents) return
    const state = toolsOf(windowId)
    const payload = { find, zoom }
    const json = JSON.stringify(payload)
    if (state.sent !== json) {
      state.sent = json
      contents.send('orbit:pageTools', payload)
    }
    windows.showTools(windowId, toolsBounds(page, find.open, !!zoom))
  }

  const refreshTab = (tabId: TabId) => {
    const windowId = windows.windowOfTab(tabId)
    if (windowId && activeOf(windowId) === tabId) refresh(windowId)
  }

  // ---------- Find in page (NV-05) ----------

  const sessionOf = (tabId: TabId): FindSession => {
    let s = finds.get(tabId)
    if (!s) {
      s = { open: false, query: '', active: 0, matches: 0, searched: false, focus: 0, request: 0, edits: 0 }
      finds.set(tabId, s)
    }
    return s
  }

  const clearMatches = (s: FindSession) => {
    s.request = 0
    s.active = 0
    s.matches = 0
    s.searched = false
  }

  /** Highlights the session's text: a new search (`fresh`) or the next or previous match. */
  const search = (contents: WebContents, s: FindSession, fresh: boolean, forward = true) => {
    if (!s.query) {
      clearMatches(s)
      contents.stopFindInPage('clearSelection')
      return
    }
    try {
      s.request = contents.findInPage(s.query, { forward, findNext: fresh })
    } catch {
      s.request = 0
    }
  }

  const focusBar = (windowId: WindowId, s: FindSession) => {
    s.focus = ++focusNonce
    refresh(windowId)
    windows.toolsContents(windowId)?.focus()
  }

  /**
   * Find acts on the window's page, not on one a Peek covers: while a Peek is open, ⌘F and ⌘G do
   * nothing and the keyboard stays in the Peek (review A-M3; finding in the Peek is PK-11's).
   */
  const findable = (windowId: WindowId | undefined): windowId is WindowId =>
    !!windowId && !peekShown(store.state, windowId)

  /** ⌘F: the bar opens (or its text is selected again), starting from the page's selection or the tab's last search. */
  const openFind = (windowId: WindowId | undefined) => {
    const tabId = activeOf(windowId)
    const contents = pageOf(tabId)
    if (!findable(windowId) || !tabId || !contents) return
    const s = sessionOf(tabId)
    if (s.open) {
      focusBar(windowId, s)
      return
    }
    s.open = true
    clearMatches(s)
    if (s.query) search(contents, s, true)
    focusBar(windowId, s)
    // Selected text on the page starts a new search instead (asked after the bar is up, so no key is lost).
    const edits = s.edits
    contents
      .executeJavaScriptInIsolatedWorld(NAV_WORLD, [{ code: SELECTION }])
      .then((selected: unknown) => {
        const text = typeof selected === 'string' ? findTextFromSelection(selected) : ''
        if (!text || text === s.query || !s.open || s.edits !== edits || finds.get(tabId) !== s) return
        s.query = text
        search(contents, s, true)
        if (activeOf(windowId) === tabId) focusBar(windowId, s)
      })
      .catch(() => {})
  }

  const step = (windowId: WindowId | undefined, forward: boolean) => {
    const tabId = activeOf(windowId)
    const contents = pageOf(tabId)
    if (!findable(windowId) || !tabId || !contents) return
    const s = finds.get(tabId)
    if (!s?.query) {
      openFind(windowId)
      return
    }
    if (!s.open) {
      // ⌘G with the bar closed opens it on the last search.
      s.open = true
      clearMatches(s)
      search(contents, s, true)
      focusBar(windowId, s)
      return
    }
    search(contents, s, !s.searched && s.request === 0, forward)
  }

  const closeFind = (windowId: WindowId | undefined) => {
    const tabId = activeOf(windowId)
    const s = tabId ? finds.get(tabId) : undefined
    if (!windowId || !tabId || !s?.open) return
    s.open = false
    clearMatches(s)
    pageOf(tabId)?.stopFindInPage('keepSelection')
    refresh(windowId)
    windows.focusActiveTab(windowId)
  }

  actions.register('page.find', (c) => openFind(windowOf(c)))
  actions.register('page.jumpToSelection', (c) => {
    void pageOf(activeOf(windowOf(c)))
      ?.executeJavaScriptInIsolatedWorld(NAV_WORLD, [{ code: JUMP_TO_SELECTION }])
      .catch(() => {})
  })
  actions.register('page.findNext', (c) => step(windowOf(c), true))
  actions.register('page.findPrevious', (c) => step(windowOf(c), false))

  commands.register('find.update', ({ query }, c) => {
    const windowId = windowOf(c)
    const tabId = activeOf(windowId)
    const contents = pageOf(tabId)
    if (!windowId || !tabId || !contents) return
    const s = sessionOf(tabId)
    if (!s.open) return
    s.edits++
    if (s.query === query) return
    s.query = query
    search(contents, s, true)
    if (!query) refresh(windowId)
  })
  commands.register('find.step', ({ forward }, c) => step(windowOf(c), forward))
  commands.register('find.close', (_args, c) => closeFind(windowOf(c)))

  // ---------- Page zoom (NV-06) ----------

  const hideZoom = (windowId: WindowId) => {
    const t = tools.get(windowId)
    if (!t?.zoom) return
    clearTimeout(t.zoomTimer)
    t.zoomTimer = undefined
    t.zoom = null
    refresh(windowId)
  }

  const showZoom = (windowId: WindowId, factor: number) => {
    const t = toolsOf(windowId)
    t.zoom = { percent: zoomPercent(factor), nonce: ++zoomNonce }
    clearTimeout(t.zoomTimer)
    t.zoomTimer = t.hovered ? undefined : setTimeout(() => hideZoom(windowId), ZOOM_INDICATOR_MS)
    refresh(windowId)
  }

  /** Chromium zooms every tab of the host in the profile's session; Orbit also keeps it for next time. */
  const remember = (tabId: TabId, url: string, factor: number) => {
    const tab = store.state.tabs[tabId]
    const host = zoomHost(url)
    if (tab && host) prefs.setZoom(tab.profileId, host, factor)
  }

  const allowPinch = (contents: WebContents) => {
    void contents.setVisualZoomLevelLimits(1, PINCH_MAX).catch(() => {})
  }

  /** ⌘0 also undoes a pinch: the scale limits close in on 1 and open again. */
  const resetPinch = (contents: WebContents) => {
    void contents
      .setVisualZoomLevelLimits(1, 1)
      .then(() => (contents.isDestroyed() ? undefined : contents.setVisualZoomLevelLimits(1, PINCH_MAX)))
      .catch(() => {})
  }

  /** Zooms a page one step in (1) or out (-1), or back to 100% (0), and keeps it for the site. Returns the new factor. */
  const zoomContents = (contents: WebContents, tabId: TabId | undefined, direction: 1 | -1 | 0): number => {
    const before = contents.getZoomFactor()
    const next = direction === 0 ? 1 : zoomStep(before, direction)
    if (!sameZoom(before, next)) contents.setZoomFactor(next)
    if (direction === 0) resetPinch(contents)
    if (tabId) remember(tabId, contents.getURL(), next)
    return next
  }

  /** Zooms a tab and shows the indicator in its window. */
  const zoom = (windowId: WindowId, tabId: TabId, direction: 1 | -1 | 0) => {
    const contents = pageOf(tabId)
    if (contents) showZoom(windowId, zoomContents(contents, tabId, direction))
  }
  // A Peek's page and a Mini Window's zoom the same way, and are remembered too (review A-F4).
  setPageZoom((contents, direction) => zoomContents(contents, tabs.tabIdFor(contents), direction))

  const zoomAction = (direction: 1 | -1 | 0) => (c: CallContext) => {
    const windowId = windowOf(c)
    const tabId = activeOf(windowId)
    if (windowId && tabId) zoom(windowId, tabId, direction)
  }
  actions.register('page.zoomIn', zoomAction(1))
  actions.register('page.zoomOut', zoomAction(-1))
  actions.register('page.zoomReset', zoomAction(0))

  commands.register('zoom.get', ({ tabId }, c) => {
    const contents = pageOf(tabId ?? activeOf(windowOf(c)))
    return { percent: contents ? zoomPercent(contents.getZoomFactor()) : 100 }
  })

  // ---------- The view ----------

  commands.register('pageTools.state', (_args, c) => {
    const windowId = windowOf(c)
    return {
      find: windowId ? findState(windowId) : CLOSED,
      zoom: windowId ? (tools.get(windowId)?.zoom ?? null) : null,
    }
  })
  commands.register('pageTools.hover', ({ over }, c) => {
    const windowId = windowOf(c)
    if (!windowId) return
    const t = toolsOf(windowId)
    t.hovered = over
    clearTimeout(t.zoomTimer)
    t.zoomTimer = !over && t.zoom ? setTimeout(() => hideZoom(windowId), ZOOM_INDICATOR_MS) : undefined
  })

  // The tools follow the active page: tab switches, resizes, splits and full screen.
  windows.onLayout((windowId) => {
    const t = tools.get(windowId)
    const tabId = activeOf(windowId)
    if (t?.zoom || (tabId && finds.get(tabId)?.open) || windows.toolsInfo(windowId).placed) refresh(windowId)
  })

  ctx.hooks.tabCreated.push((tabId, contents) => {
    allowPinch(contents)
    contents.on('found-in-page', (_event, result) => {
      const s = finds.get(tabId)
      if (!s?.open || result.requestId !== s.request) return
      s.matches = result.matches
      s.active = result.activeMatchOrdinal
      s.searched = true
      refreshTab(tabId)
    })
    contents.on('did-navigate', () => {
      // A new page: the old matches are gone (the bar stays open with its text).
      allowPinch(contents)
      const s = finds.get(tabId)
      if (s?.open && (s.request || s.searched)) {
        clearMatches(s)
        refreshTab(tabId)
      }
    })
    // Ctrl+wheel (Windows, Linux) zooms the page under the pointer.
    contents.on('zoom-changed', (_event, direction) => {
      const windowId = windows.windowOfTab(tabId)
      if (windowId) zoom(windowId, tabId, direction === 'in' ? 1 : -1)
    })
    contents.once('destroyed', () => {
      const s = finds.get(tabId)
      finds.delete(tabId)
      if (s?.open) for (const windowId of windows.ids()) if (activeOf(windowId) === tabId) refresh(windowId)
    })
  })

  // A page opens at the zoom its host had in this profile.
  ctx.hooks.tabNavigated.push((tabId, contents, url) => {
    const tab = store.state.tabs[tabId]
    const host = zoomHost(url)
    if (!tab || !host || contents.isDestroyed()) return
    const want = prefs.zoomFor(tab.profileId, host) ?? 1
    if (!sameZoom(contents.getZoomFactor(), want)) contents.setZoomFactor(want)
  })

  return {
    info: (windowId) => {
      const placed = windows.toolsInfo(windowId)
      return {
        find: findState(windowId),
        zoom: tools.get(windowId)?.zoom ?? null,
        hovered: tools.get(windowId)?.hovered ?? false,
        placed: placed.placed,
        bounds: placed.placed ? placed.bounds : undefined,
      }
    },
  }
}
