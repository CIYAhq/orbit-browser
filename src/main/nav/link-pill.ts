import type { WebContentsView } from 'electron'
import { type LinkPillContent, linkPillText } from '../../shared/nav'
import type { TabId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import { shownTabs, viewContents } from '../windows'

/** The link status pill's geometry and timing (SB-27). */
export const LINK_PILL = {
  /** The pill's height. */
  height: 22,
  /** Room around the pill in its view, for the shadow. */
  margin: 6,
  /** Gap between the pill and the page card's edges. */
  inset: 6,
  /** The pointer this close to the pill moves it to the card's other corner. */
  near: 24,
  /** Hovering a link this long shows the full URL. */
  expandAfterMs: 1500,
  /** The pill stays this long after the pointer leaves a link, so moving between links doesn't flicker. */
  hideAfterMs: 120,
  /** The short pill's widest, as a share of the card's width, and at least this many px. */
  compactShare: 1 / 3,
  compactMin: 180,
} as const

type Side = 'left' | 'right'
type Point = { x: number; y: number }

export interface LinkPillInfo {
  visible: boolean
  tabId: TabId | null
  url: string | null
  text: string | null
  expanded: boolean
  side: Side
  bounds?: Electron.Rectangle
  /** How long the link had been hovered when the full URL showed (ms), once it has. */
  expandedAfter: number | null
}

interface WindowPill {
  view?: WebContentsView
  /** The tab whose hovered link it shows, and the link. */
  tabId: TabId | null
  url: string | null
  /** When the pointer came onto this link. */
  urlSince: number
  expanded: boolean
  expandedAfter: number | null
  side: Side
  /** Numbers each content sent to the view; the view's size report names the one it measured. */
  key: number
  maxWidth: number
  /** The pill's measured width for `key`, once the view said. */
  width: number | null
  expandTimer?: ReturnType<typeof setTimeout>
  hideTimer?: ReturnType<typeof setTimeout>
}

/**
 * The link status pill (SB-27): hovering a link (or giving one keyboard focus) shows where it goes
 * in a small theme-styled pill in the bottom-left corner of that page's card; after about 1.5 s on
 * the link it shows the full URL, and links after it too while it stays up. When the pointer comes
 * near it, it moves to the other corner (and out of the way if it is near both). It is drawn in a
 * small view of its own over the page, sized to the pill, so it covers as little as it can.
 */
export function registerLinkPill(ctx: MainContext): { info: (windowId: WindowId) => LinkPillInfo } {
  const { store, windows, commands } = ctx
  const perWindow = new Map<WindowId, WindowPill>()
  /** Where the pointer is over each page (page coordinates), while it is. */
  const pointers = new Map<TabId, Point>()

  /** A view whose page is alive (its `webContents` is undefined once the page is gone). */
  const live = (view: WebContentsView | undefined): view is WebContentsView => !!viewContents(view)

  const stateOf = (windowId: WindowId): WindowPill | undefined => {
    const existing = perWindow.get(windowId)
    if (existing) return existing
    const win = windows.get(windowId)
    if (!win || win.isDestroyed()) return undefined
    const s: WindowPill = {
      tabId: null,
      url: null,
      urlSince: 0,
      expanded: false,
      expandedAfter: null,
      side: 'left',
      key: 0,
      maxWidth: LINK_PILL.compactMin,
      width: null,
    }
    perWindow.set(windowId, s)
    win.once('closed', () => {
      clearTimeout(s.expandTimer)
      clearTimeout(s.hideTimer)
      perWindow.delete(windowId)
    })
    return s
  }

  const contentOf = (s: WindowPill): LinkPillContent | null =>
    s.url
      ? { key: s.key, url: s.url, text: linkPillText(s.url, s.expanded), expanded: s.expanded, maxWidth: s.maxWidth }
      : null

  const maxWidthFor = (expanded: boolean, card: Electron.Rectangle): number => {
    const room = Math.max(40, card.width - 2 * LINK_PILL.inset)
    if (expanded) return room
    return Math.min(room, Math.max(LINK_PILL.compactMin, Math.round(card.width * LINK_PILL.compactShare)))
  }

  /** Sends the view what to show, numbered anew: it measures the pill and says how wide it came out. */
  const send = (s: WindowPill) => {
    s.key++
    s.width = null
    const content = contentOf(s)
    if (content) viewContents(s.view)?.send('orbit:link:show', content)
  }

  /** The pill's view in one of the card's bottom corners. */
  const rectFor = (card: Electron.Rectangle, width: number, side: Side): Electron.Rectangle => {
    const { height, margin, inset } = LINK_PILL
    const w = Math.ceil(width)
    return {
      x: Math.round(side === 'left' ? card.x + inset - margin : card.x + card.width - inset - w - margin),
      y: Math.round(card.y + card.height - inset - height - margin),
      width: w + 2 * margin,
      height: height + 2 * margin,
    }
  }

  /** The pointer (window coordinates) within `near` of the pill drawn in `rect`. */
  const isNear = (rect: Electron.Rectangle, p: Point | undefined): boolean => {
    if (!p) return false
    const { margin, near } = LINK_PILL
    return (
      p.x >= rect.x + margin - near &&
      p.x <= rect.x + rect.width - margin + near &&
      p.y >= rect.y + margin - near &&
      p.y <= rect.y + rect.height - margin + near
    )
  }

  const hideNow = (windowId: WindowId, s: WindowPill) => {
    clearTimeout(s.expandTimer)
    clearTimeout(s.hideTimer)
    s.expandTimer = undefined
    s.hideTimer = undefined
    s.tabId = null
    s.url = null
    s.expanded = false
    s.side = 'left'
    s.width = null
    if (live(s.view)) windows.hideUiView(windowId, s.view)
  }

  /** Puts the pill's view where it goes, or out of the way, once the view has measured the pill. */
  const place = (windowId: WindowId, s: WindowPill) => {
    if (!s.tabId || !s.url || !live(s.view)) return
    const card = windows.tabViewBounds(s.tabId)
    if (!card) {
      hideNow(windowId, s)
      return
    }
    const maxWidth = maxWidthFor(s.expanded, card)
    if (maxWidth !== s.maxWidth) {
      s.maxWidth = maxWidth
      send(s)
    }
    if (s.width === null) return
    const at = pointers.get(s.tabId)
    const pointer = at ? { x: card.x + at.x, y: card.y + at.y } : undefined
    if (isNear(rectFor(card, s.width, s.side), pointer)) s.side = s.side === 'left' ? 'right' : 'left'
    if (isNear(rectFor(card, s.width, s.side), pointer)) {
      // Near both corners (a wide pill): out of the way until the pointer moves off.
      windows.hideUiView(windowId, s.view)
      return
    }
    windows.showUiView(windowId, s.view, rectFor(card, s.width, s.side))
  }

  const startExpandTimer = (windowId: WindowId, s: WindowPill) => {
    clearTimeout(s.expandTimer)
    s.expandTimer = setTimeout(() => {
      s.expandTimer = undefined
      if (perWindow.get(windowId) !== s || !s.url || s.expanded) return
      s.expanded = true
      s.expandedAfter = Date.now() - s.urlSince
      const card = s.tabId ? windows.tabViewBounds(s.tabId) : undefined
      if (card) s.maxWidth = maxWidthFor(true, card)
      send(s)
    }, LINK_PILL.expandAfterMs)
  }

  const onTarget = (tabId: TabId, url: string) => {
    const windowId = windows.windowOfTab(tabId)
    if (!windowId) return
    const s = stateOf(windowId)
    if (!s) return
    if (!url) {
      // Off the link: the pill fades, then goes, unless another link comes first.
      if (s.tabId !== tabId || !s.url || s.hideTimer) return
      viewContents(s.view)?.send('orbit:link:hide', {})
      s.hideTimer = setTimeout(() => {
        s.hideTimer = undefined
        if (perWindow.get(windowId) === s) hideNow(windowId, s)
      }, LINK_PILL.hideAfterMs)
      return
    }
    // Only a page in one of the window's page cards (not a Peek's, which has a card of its own).
    if (!shownTabs(store.state, windowId).has(tabId)) return
    const card = windows.tabViewBounds(tabId)
    if (!card) return
    clearTimeout(s.hideTimer)
    s.hideTimer = undefined
    if (!live(s.view)) s.view = windows.createUiView(windowId, 'link')
    if (s.tabId === tabId && s.url === url) {
      // The same link again, before the pill went: it stays as it was.
      send(s)
      place(windowId, s)
      return
    }
    if (!s.url) {
      s.expanded = false
      s.expandedAfter = null
      s.side = 'left'
    }
    s.tabId = tabId
    s.url = url
    s.urlSince = Date.now()
    // The full URL after a continued hover of one link; once it shows, the next links show in full too.
    if (!s.expanded) startExpandTimer(windowId, s)
    s.maxWidth = maxWidthFor(s.expanded, card)
    send(s)
    place(windowId, s)
  }

  commands.register('nav.linkPill', (_args, c) => {
    const s = c.windowId ? perWindow.get(c.windowId) : undefined
    if (!s?.url) return null
    // The view just loaded: it measures this content and says.
    s.key++
    s.width = null
    return contentOf(s)
  })
  commands.register('nav.linkPillSize', ({ key, width }, c) => {
    const windowId = c.windowId
    const s = windowId ? perWindow.get(windowId) : undefined
    if (!windowId || !s || key !== s.key || !(width > 0)) return
    s.width = width
    place(windowId, s)
  })

  ctx.hooks.tabCreated.push((tabId, contents) => {
    contents.on('update-target-url', (_event, url) => onTarget(tabId, url))
    contents.on('before-mouse-event', (_event, mouse) => {
      if (mouse.type === 'mouseLeave') {
        pointers.delete(tabId)
        return
      }
      if (mouse.type !== 'mouseMove') return
      pointers.set(tabId, { x: mouse.x, y: mouse.y })
      const windowId = windows.windowOfTab(tabId)
      const s = windowId ? perWindow.get(windowId) : undefined
      if (windowId && s?.url && s.tabId === tabId) place(windowId, s)
    })
    // A new page: no link of it is hovered yet.
    contents.on('did-navigate', () => {
      for (const [windowId, s] of perWindow) if (s.tabId === tabId) hideNow(windowId, s)
    })
    contents.once('destroyed', () => {
      pointers.delete(tabId)
      for (const [windowId, s] of perWindow) if (s.tabId === tabId) hideNow(windowId, s)
    })
  })

  // Another tab shown: the pill goes with its page. The page card moved: the pill follows.
  store.subscribe((next) => {
    for (const [windowId, s] of perWindow) {
      if (s.tabId && !shownTabs(next, windowId).has(s.tabId)) hideNow(windowId, s)
    }
  })
  windows.onLayout((windowId) => {
    const s = perWindow.get(windowId)
    if (s?.url) place(windowId, s)
  })

  return {
    info: (windowId) => {
      const s = perWindow.get(windowId)
      const view = live(s?.view) ? s?.view : undefined
      return {
        visible: !!view?.getVisible(),
        tabId: s?.tabId ?? null,
        url: s?.url ?? null,
        text: s?.url ? linkPillText(s.url, s.expanded) : null,
        expanded: !!s?.expanded,
        side: s?.side ?? 'left',
        bounds: view?.getBounds(),
        expandedAfter: s?.expandedAfter ?? null,
      }
    },
  }
}
