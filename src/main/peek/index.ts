import type {
  HandlerDetails,
  Input,
  WebContents,
  WebContentsViewConstructorOptions,
  WebContentsWillNavigateEventParams,
  WindowOpenHandlerResponse,
} from 'electron'
import { WebContentsView } from 'electron'
import { sidebarUndoFor } from '../../shared/actions'
import { decideLink, type LinkHow, type LinkSettings, type LinkSource, routeFor } from '../../shared/link-routing'
import { PEEK_RADIUS, peekCard, splitTarget } from '../../shared/peek-geometry'
import { isPrivateTab } from '../../shared/private'
import type { Rect } from '../../shared/rpc'
import { layoutLeaves, MAX_PANES, SPLIT_FULL_MESSAGE } from '../../shared/split'
import type { OrbitState, SpaceId, Tab, TabId, WindowId } from '../../shared/state'
import { insertItem, sectionOf, splitOfTab } from '../../shared/tree'
import type { MainContext } from '../context'
import { KEEP_KEYBOARD } from '../keys/focus'
import { openMiniWindow } from '../miniwindow'
import type { CallContext } from '../registry'
import { activateInDraft, todayInsertIndex } from '../tabs/model'
import type { SavedHistory } from '../tabs/runtime'
import { activeTabOf } from '../windows'
import { archiveFloating, floatingTab, keepFloatingPagesOutOfTabClose } from './floating'
import { ClickTracker, heldModifiers, isMiniClick, PAGE_WORLD, type PageClick } from './input'
import { runPageAction, setPeekPages } from './page-actions'

/**
 * A Peek card open in a window: a floating tab whose view sits above the overlay, on the card once
 * the card is at rest. While the card moves (opening, dragged, closing, expanding), the overlay
 * animates a still of the page and the view waits out of sight, at the size it shows at next, so its
 * page is laid out once and never every frame (PK-06, FL-01).
 */
interface Session {
  windowId: WindowId
  tabId: TabId
  sourceTabId: TabId
  nonce: number
  view?: WebContentsView
  /** open, or animating out: closing, expanding into a tab, or sliding into a split. */
  phase: 'open' | 'closing' | 'expanding' | 'splitting'
  /** The page area the overlay covers (window coordinates). */
  area: Rect
  /** The page view is on the card (the card is at rest); otherwise it is out of sight. */
  shown: boolean
  /** Shows the page on its card if the overlay never says where it goes (its renderer still starting). */
  revealTimer?: NodeJS.Timeout
  /** The page is in HTML fullscreen (a video): its view covers the window. */
  fullscreen: boolean
  /** Commits the running transition if the overlay never reports it finished. */
  settleTimer?: NodeJS.Timeout
  /** Takes the next still of the page for the overlay's card. */
  stillTimer?: NodeJS.Timeout
  /** The page's background colour, for the card the overlay fades out on close. */
  background?: string
}

/** A Peek closed recently, kept so ⌘Z / ⌘⇧T can bring it back (PK-10). */
interface ClosedPeek {
  windowId: WindowId
  sourceTabId: TabId
  url: string
  history?: SavedHistory
  at: number
  /** Its Archive entry, removed again when it reopens. */
  archiveId?: string
}

/** Opens a link from a page in that window's Peek (set once the feature is registered). */
let peekLink: ((tabId: TabId, url: string) => void) | undefined

/** "Open Link in Peek" from a page's context menu (PK-03). */
export function openLinkInPeek(tabId: TabId, url: string): void {
  peekLink?.(tabId, url)
}

/** ⌘Z reopens a Peek only right after it closed. */
const UNDO_WINDOW_MS = 10_000
/** How long a transition may run before main commits it anyway (overlay gone, reduced motion…). */
const SETTLE_MS = 600
/**
 * Stills of the page for the overlay's card (PK-06), taken only while the page shows on the card at
 * rest (a capture can cost the overlay a frame, so never while the card moves): the first just after
 * the page joins the card, then again a moment after anything changed it (a load, a scroll, a key).
 */
const STILL_FIRST_MS = 40
const STILL_AFTER_MS = 200
/** Input that may change what a page shows (pointer moves don't count). */
const STILL_INPUTS = new Set(['mouseUp', 'mouseWheel', 'keyUp', 'gestureScrollEnd', 'gestureFlingStart', 'touchEnd'])

let nonceCounter = 0

/**
 * The page of the Peek's view while it is alive. Once the page has gone (it closed itself, or its tab
 * went to sleep), `view.webContents` reads undefined, even before 'destroyed' fires: it is checked
 * before anything is called on it (D28).
 */
function pageOf(view: WebContentsView | undefined): WebContents | undefined {
  const contents = view?.webContents as WebContents | undefined
  return contents && !contents.isDestroyed() ? contents : undefined
}

export function registerPeek(ctx: MainContext): void {
  const { store, commands, actions, windows, tabs } = ctx
  const sessions = new Map<WindowId, Session>()
  const closed: ClosedPeek[] = []
  // One tracker for the app: ⌥-click split view reads the same keys (nav lane).
  const clicks = new ClickTracker(heldModifiers())
  /** When a sidebar tab last closed: ⌘⇧T reopens a Peek only if it closed after that. */
  let lastTabCloseAt = 0
  let undo: { windowId: WindowId; until: number } | undefined

  const windowOf = (c: CallContext): WindowId | undefined => c.windowId ?? windows.focusedWindowId()
  const sessionOfTab = (tabId: TabId): Session | undefined => {
    for (const s of sessions.values()) if (s.tabId === tabId) return s
    return undefined
  }
  windows.addFloatingOwner((tabId) => sessionOfTab(tabId)?.windowId)
  keepFloatingPagesOutOfTabClose(ctx)
  const linkSettings = (): LinkSettings => {
    const { peekExternalLinks, peekShiftClick, linkRules } = store.state.settings
    return { peekExternalLinks, peekShiftClick, linkRules: linkRules ?? [] }
  }
  const toWindow = (s: Session, r: Rect): Rect => ({
    x: s.area.x + r.x,
    y: s.area.y + r.y,
    width: r.width,
    height: r.height,
  })

  const setOverlay = (
    s: Session,
    fields: Partial<Extract<OrbitState['windows'][string]['overlay'], { kind: 'peek' }>>,
  ) => {
    store.update((d) => {
      const overlay = d.windows[s.windowId]?.overlay
      if (overlay?.kind === 'peek' && overlay.nonce === s.nonce) Object.assign(overlay, fields)
    })
  }

  // ---- Opening ----

  /** Whether a Peek can open in this window now (a main window showing a tab, with a known page area). */
  const canPeek = (windowId: WindowId | undefined): windowId is WindowId => {
    if (!windowId) return false
    const win = store.state.windows[windowId]
    return win?.kind === 'main' && !!activeTabOf(store.state, windowId) && !!windows.pageArea(windowId)
  }

  /**
   * Opens a Peek over the window's current tab (PK-01). With one already open, a plain open
   * navigates it instead of stacking a second card. `create` supplies the page's view (a
   * window.open the engine is creating); otherwise the tab's view is created and loads `url`.
   */
  const openPeek = (
    windowId: WindowId,
    url: string,
    opts: { origin?: { x: number; y: number }; create?: (tab: Tab) => WebContentsView; history?: SavedHistory } = {},
  ): TabId | null => {
    const existing = sessions.get(windowId)
    if (existing?.phase === 'open' && existing.view && !opts.create && !opts.history) {
      tabs.navigate(existing.tabId, url)
      return existing.tabId
    }
    if (existing) settleNow(existing)
    if (!canPeek(windowId)) return null
    const state = store.state
    const sourceTabId = activeTabOf(state, windowId) as TabId
    const source = state.tabs[sourceTabId] as Tab
    const area = windows.pageArea(windowId) as Rect
    const tab = floatingTab('peek', { spaceId: source.spaceId, profileId: source.profileId, url })
    const nonce = ++nonceCounter
    const origin = opts.origin
      ? {
          x: Math.max(0, Math.min(area.width, opts.origin.x - area.x)),
          y: Math.max(0, Math.min(area.height, opts.origin.y - area.y)),
        }
      : undefined
    const session: Session = {
      windowId,
      tabId: tab.id,
      sourceTabId,
      nonce,
      phase: 'open',
      area,
      shown: false,
      fullscreen: false,
    }
    sessions.set(windowId, session)
    if (opts.history) tabs.savedHistory.set(tab.id, opts.history)
    ctx.perf.mark('peek:open')
    store.update((d) => {
      d.tabs[tab.id] = tab
      const win = d.windows[windowId]
      if (win) {
        win.overlay = {
          kind: 'peek',
          tabId: tab.id,
          nonce,
          sourceTabId,
          area: { width: area.width, height: area.height },
          ...(origin ? { origin } : {}),
        }
      }
    })
    // The window manager has shown the overlay over the page area; the page goes above it.
    let view: WebContentsView | undefined
    try {
      view = opts.create ? opts.create(tab) : tabs.ensure(tab.id)
    } catch (err) {
      console.error('[peek] could not create the page', err)
    }
    if (!pageOf(view)) {
      discard(session)
      return null
    }
    place(session, view as WebContentsView)
    return tab.id
  }

  /**
   * Puts the Peek's page view above the overlay, out of sight at the card's size while the overlay
   * grows the card: the page loads, lays out and draws there once, and shows when the card is at rest.
   */
  const place = (s: Session, view: WebContentsView) => {
    const win = windows.get(s.windowId)
    const page = pageOf(view)
    if (!win || win.isDestroyed() || !page) return
    s.view = view
    view.setBorderRadius(PEEK_RADIUS)
    placeView(s)
    win.contentView.addChildView(view)
    page.focus()
    // Whatever the overlay does, the page ends on its card.
    s.revealTimer = setTimeout(() => {
      if (sessions.get(s.windowId) !== s || s.phase !== 'open' || s.shown) return
      s.shown = true
      placeView(s)
      stillSoon(s, STILL_FIRST_MS)
    }, SETTLE_MS)
  }

  /**
   * Puts the page view where the session's phase wants it: on the card at rest, or out of sight.
   * Out of sight, all of it but its corner pixel is outside the window, so its page still lays out
   * and draws, at the size it shows at next (a view wholly outside, or hidden, is given no size and
   * draws nothing). Closing, it hides: it is going. A view whose page has gone is left be: the Peek
   * closes with its page.
   */
  const placeView = (s: Session) => {
    const view = s.view
    const win = windows.get(s.windowId)
    if (!view || !pageOf(view) || !win || win.isDestroyed() || s.fullscreen) return
    if (s.phase === 'closing') {
      if (view.getVisible()) view.setVisible(false)
      return
    }
    const card = roundRect(toWindow(s, peekCard(s.area)))
    if (s.phase === 'open' && s.shown) {
      view.setBounds(card)
    } else {
      const next =
        s.phase === 'expanding' ? s.area : s.phase === 'splitting' ? roundRect(toWindow(s, splitTarget(s.area))) : card
      const [width = 0, height = 0] = win.getContentSize()
      view.setBounds({ x: width - 1, y: height - 1, width: next.width, height: next.height })
    }
    if (!view.getVisible()) view.setVisible(true)
  }

  /**
   * The page crashed, or its main frame failed to load (the tab's error, until it loads again):
   * Orbit's screen shows over its view, and a still would be of a page that has gone, or of a blank
   * one. The overlay drops the one it has (dropStill), so a card that moves or fades shows its own
   * colour (PK-06), and none is taken meanwhile.
   */
  const broken = (s: Session) => !!store.state.tabs[s.tabId]?.error

  /** Takes a still of the page and gives it to the overlay, for the card to show while the view is out of sight. */
  const takeStill = async (s: Session) => {
    const contents = s.view?.webContents
    if (!contents || contents.isDestroyed() || broken(s) || s.fullscreen || s.phase !== 'open' || !s.shown) return
    try {
      const image = await contents.capturePage()
      if (sessions.get(s.windowId) !== s || s.phase !== 'open' || broken(s) || image.isEmpty()) return
      const url = `data:image/jpeg;base64,${image.toJPEG(85).toString('base64')}`
      windows.sendToOverlay(s.windowId, 'peek:still', { nonce: s.nonce, url })
    } catch {
      // The page went away: the card keeps the still it has, or its colour.
    }
  }

  const stillSoon = (s: Session, ms: number) => {
    clearTimeout(s.stillTimer)
    s.stillTimer = setTimeout(() => void takeStill(s), ms)
  }

  /** The page shows an error now (broken()): the card drops its still and shows its own colour. */
  const dropStill = (s: Session) => {
    clearTimeout(s.stillTimer)
    windows.sendToOverlay(s.windowId, 'peek:still', { nonce: s.nonce, url: '' })
  }

  // ---- Closing, expanding, splitting ----

  /** Remembers a closing Peek for ⌘Z / ⌘⇧T and archives its page (PK-09, PK-10). */
  const remember = (s: Session) => {
    const tab = store.state.tabs[s.tabId]
    const contents = tabs.contents(s.tabId)
    if (!tab) return
    const url = contents?.getURL() || tab.url
    const history =
      contents && contents.navigationHistory.length() > 0
        ? { entries: contents.navigationHistory.getAllEntries(), index: contents.navigationHistory.getActiveIndex() }
        : undefined
    let archiveId: string | undefined
    store.update((d) => {
      const t = d.tabs[s.tabId]
      if (t) archiveId = archiveFloating(d, { ...t, url }, 'peek', 'closed')
    })
    closed.push({ windowId: s.windowId, sourceTabId: s.sourceTabId, url, history, at: Date.now(), archiveId })
    if (closed.length > 20) closed.shift()
  }

  /** Closes the window's Peek (Esc, ⌘W, ×, a click outside) and returns focus to the source tab. */
  const closePeek = (windowId: WindowId, opts: { animate?: boolean } = {}) => {
    const s = sessions.get(windowId)
    if (!s) return
    if (s.phase !== 'open') {
      if (s.phase !== 'closing') settleNow(s)
      return
    }
    remember(s)
    s.phase = 'closing'
    undo = { windowId, until: Date.now() + UNDO_WINDOW_MS }
    clearTimeout(s.settleTimer)
    if (opts.animate === false || !s.view) {
      discard(s)
      windows.focusActiveTab(windowId)
      return
    }
    // The page goes at once; the card, showing its still, shrinks and fades out on its own (FL-19).
    placeView(s)
    setOverlay(s, { phase: 'closing' })
    // Keys go to the page underneath at once.
    windows.focusActiveTab(windowId)
    s.settleTimer = setTimeout(() => discard(s), SETTLE_MS)
    sampleBackground(s)
  }

  /** Removes the Peek: its view, its tab and the overlay. */
  const discard = (s: Session) => {
    clearTimeout(s.settleTimer)
    clearTimeout(s.revealTimer)
    clearTimeout(s.stillTimer)
    if (sessions.get(s.windowId) === s) sessions.delete(s.windowId)
    const view = s.view
    const win = windows.get(s.windowId)
    if (view && win && !win.isDestroyed()) {
      try {
        win.contentView.removeChildView(view)
      } catch {
        // already gone
      }
    }
    tabs.destroy(s.tabId)
    store.update((d) => {
      if (d.tabs[s.tabId]?.floating === 'peek') delete d.tabs[s.tabId]
      const w = d.windows[s.windowId]
      if (w?.overlay.kind === 'peek' && w.overlay.nonce === s.nonce) w.overlay = { kind: 'none' }
    })
  }

  /** Turns the Peek into a selected Today tab (PK-07): the card first grows to fill the page area. */
  const expandPeek = (windowId: WindowId) => {
    const s = sessions.get(windowId)
    if (s?.phase !== 'open') return
    s.phase = 'expanding'
    clearTimeout(s.settleTimer)
    clearTimeout(s.revealTimer)
    ctx.perf.mark('peek:expand')
    // Out of sight, the page lays out at the page area's size while the card grows to it.
    placeView(s)
    setOverlay(s, { phase: 'expanding' })
    s.settleTimer = setTimeout(() => commitExpand(s), SETTLE_MS)
  }

  /** The Peek's page becomes an ordinary tab, live (no reload): top of Today, selected. */
  const commitExpand = (s: Session) => {
    clearTimeout(s.settleTimer)
    clearTimeout(s.revealTimer)
    clearTimeout(s.stillTimer)
    if (sessions.get(s.windowId) !== s) return
    sessions.delete(s.windowId)
    const state = store.state
    const win = state.windows[s.windowId]
    const tab = state.tabs[s.tabId]
    if (!win || !tab) {
      discard(s)
      return
    }
    const url = tabs.contents(s.tabId)?.getURL() || tab.url
    // Routing rules also apply when a Peek opens as a tab (NV-18).
    const routed = routeFor(state.settings.linkRules ?? [], url)
    placeInToday(s, routed && state.spaces[routed] ? routed : win.spaceId)
  }

  /** Puts the (former) Peek page at the top of a Space's Today and selects it (TB-03). */
  const placeInToday = (s: Session, spaceId: SpaceId) => {
    const tab = store.state.tabs[s.tabId]
    if (!tab) return
    const profileId = store.state.spaces[spaceId]?.profileId ?? tab.profileId
    const otherProfile = profileId !== tab.profileId
    store.update((d) => {
      const t = d.tabs[s.tabId]
      const w = d.windows[s.windowId]
      const space = d.spaces[spaceId]
      if (!t || !w || !space) return
      delete t.floating
      t.spaceId = spaceId
      t.profileId = profileId
      insertItem(d, { kind: 'today', spaceId }, todayInsertIndex(space, 'new'), s.tabId)
      if (w.overlay.kind === 'peek' && w.overlay.nonce === s.nonce) w.overlay = { kind: 'none' }
      activateInDraft(d, s.windowId, s.tabId)
    })
    if (otherProfile) {
      // Another profile is another session: the page reloads there.
      tabs.savedHistory.delete(s.tabId)
      tabs.sleep(s.tabId)
    }
  }

  /** Whether a tab's split already has the most panes Split View takes (SV-25). */
  const inFullSplit = (tabId: TabId) => {
    const state = store.state
    const splitId = splitOfTab(state, tabId)
    const split = splitId ? state.splits[splitId] : undefined
    return !!split && layoutLeaves(split.layout).length >= MAX_PANES
  }

  /** Turns the source tab and the Peek page into a split, the page on the right (PK-08). */
  const splitPeek = (windowId: WindowId) => {
    const s = sessions.get(windowId)
    if (s?.phase !== 'open') return
    // No fifth pane by any route (SV-25): the Peek stays as it is, and a toast says why.
    if (inFullSplit(s.sourceTabId)) {
      ctx.toast(windowId, SPLIT_FULL_MESSAGE)
      return
    }
    s.phase = 'splitting'
    clearTimeout(s.settleTimer)
    clearTimeout(s.revealTimer)
    // Out of sight, the page lays out at its pane's size while the card slides there.
    placeView(s)
    setOverlay(s, { phase: 'splitting' })
    s.settleTimer = setTimeout(() => commitSplit(s), SETTLE_MS)
  }

  const commitSplit = (s: Session) => {
    clearTimeout(s.settleTimer)
    clearTimeout(s.revealTimer)
    clearTimeout(s.stillTimer)
    if (sessions.get(s.windowId) !== s) return
    const state = store.state
    const source = state.tabs[s.sourceTabId]
    const tab = state.tabs[s.tabId]
    if (!source || !tab) {
      discard(s)
      return
    }
    sessions.delete(s.windowId)
    const url = tabs.contents(s.tabId)?.getURL() || tab.url
    // The page becomes an ordinary tab of the source's Space, live; the split then takes the
    // source tab's place (a pinned source makes a pinned split, SV-20), the page on the right.
    store.update((d) => {
      const t = d.tabs[s.tabId]
      if (t) {
        delete t.floating
        t.url = url
        t.spaceId = source.spaceId
        t.lastActiveAt = Date.now()
      }
      const w = d.windows[s.windowId]
      if (w?.overlay.kind === 'peek' && w.overlay.nonce === s.nonce) w.overlay = { kind: 'none' }
    })
    const fallback = () => {
      // Refused after all (the split filled up while the card moved): the page still opens, as a tab.
      if (store.state.tabs[s.tabId] && !isPlaced(s.tabId)) placeInToday(s, source.spaceId)
    }
    commands
      .run(
        'split.addTab',
        { tabId: s.tabId, target: s.sourceTabId, side: 'right', focus: true },
        { windowId: s.windowId },
      )
      .then((splitId) => {
        if (!splitId) fallback()
      })
      .catch((err) => {
        console.error('[peek] split failed', err)
        fallback()
      })
  }

  /** Whether a tab has a place in the sidebar (a row or a split pane). */
  const isPlaced = (tabId: TabId) => sectionOf(store.state, tabId) !== undefined

  /** Finishes a running transition right away (new input arrived), or removes a stale Peek. */
  const settleNow = (s: Session) => {
    if (s.phase === 'expanding') commitExpand(s)
    else if (s.phase === 'splitting') commitSplit(s)
    else discard(s)
  }

  /** Reopens the window's most recently closed Peek over its source tab (PK-10). */
  const reopenPeek = (windowId: WindowId): boolean => {
    const index = closed.findLastIndex((c) => c.windowId === windowId)
    const entry = closed[index]
    if (!entry) return false
    closed.splice(index, 1)
    undo = undefined
    const state = store.state
    const win = state.windows[windowId]
    if (!win) return false
    if (state.tabs[entry.sourceTabId] && activeTabOf(state, windowId) !== entry.sourceTabId) {
      void commands.run('tabs.activate', { tabId: entry.sourceTabId }, { windowId })
    }
    if (entry.archiveId) {
      store.update((d) => {
        // Its Archive entry goes: the page is open again.
        const i = d.archive.findLastIndex((a) => a.id === entry.archiveId)
        if (i >= 0) d.archive.splice(i, 1)
      })
    }
    return openPeek(windowId, entry.url, { history: entry.history }) !== null
  }

  const canReopen = (windowId: WindowId): boolean => {
    const entry = closed.findLast((c) => c.windowId === windowId)
    return !!entry && entry.at > lastTabCloseAt
  }

  /** Reads the page's background colour (for the card the overlay fades out), best effort. */
  const sampleBackground = (s: Session) => {
    const contents = tabs.contents(s.tabId)
    if (!contents || s.background) return
    contents
      .executeJavaScriptInIsolatedWorld(PAGE_WORLD, [
        {
          code: `(() => { for (const el of [document.body, document.documentElement]) { if (!el) continue; const c = getComputedStyle(el).backgroundColor; if (c && !/rgba\\(.*,\\s*0\\)|transparent/.test(c)) return c } return '' })()`,
        },
      ])
      .then((colour: unknown) => {
        if (typeof colour !== 'string' || !colour) return
        s.background = colour
        if (sessions.get(s.windowId) === s || s.phase === 'closing') setOverlay(s, { background: colour })
      })
      .catch(() => {})
  }

  peekLink = (tabId, url) => {
    const windowId = windows.windowOfTab(tabId)
    if (canPeek(windowId)) openPeek(windowId, url)
  }

  // ---- Wiring ----

  commands.register('peek.open', ({ url }, c) => {
    const windowId = windowOf(c)
    return windowId ? openPeek(windowId, url) : null
  })
  commands.register('peek.close', (_args, c) => {
    const windowId = windowOf(c)
    if (windowId) closePeek(windowId)
  })
  commands.register('peek.expand', (_args, c) => {
    const windowId = windowOf(c)
    if (windowId) expandPeek(windowId)
  })
  commands.register('peek.split', (_args, c) => {
    const windowId = windowOf(c)
    if (windowId) splitPeek(windowId)
  })
  commands.register('peek.settled', ({ nonce }, c) => {
    const s = sessions.get(windowOf(c) ?? '')
    if (!s || s.nonce !== nonce) return
    if (s.phase === 'closing') discard(s)
    else if (s.phase === 'expanding') commitExpand(s)
    else if (s.phase === 'splitting') commitSplit(s)
  })

  // The overlay animates the card: the page shows on it once it is at rest, and waits out of sight
  // while it moves (a drag, a swipe).
  ctx.events.on('peek.page', ({ nonce, shown }, { windowId }) => {
    const s = sessions.get(windowId ?? '')
    if (!s || s.nonce !== nonce) return
    clearTimeout(s.revealTimer)
    if (s.phase !== 'open' || s.shown === shown) return
    s.shown = shown
    placeView(s)
    if (shown) stillSoon(s, STILL_FIRST_MS)
  })
  // The page area moved or resized (sidebar toggled, window resized): the card follows.
  ctx.events.on('layout.panes', (_payload, { windowId }) => {
    const s = sessions.get(windowId ?? '')
    if (!s) return
    const area = windows.pageArea(s.windowId)
    if (!area || sameRect(area, s.area)) return
    s.area = area
    setOverlay(s, { area: { width: area.width, height: area.height } })
    placeView(s)
    if (s.phase === 'open' && s.shown) stillSoon(s, STILL_AFTER_MS)
  })

  // Find in page acts on the open Peek's page, over the top-right corner of its card (PK-11).
  setPeekPages((windowId) => {
    const s = sessions.get(windowId)
    const area = windows.pageArea(windowId) ?? s?.area
    if (s?.phase !== 'open' || s.fullscreen || !pageOf(s.view) || !area) return undefined
    const card = peekCard(area)
    return { tabId: s.tabId, card: { ...card, x: area.x + card.x, y: area.y + card.y } }
  })

  // ⌘O with nothing to expand does nothing (a Mini Window takes it over, MW-05).
  actions.register('peek.expand', () => {})

  // While a Peek is open, closing and page actions act on it, not on the tab underneath (PK-09, PK-11).
  actions.intercept((id, c) => {
    const windowId = c.windowId ?? windows.focusedWindowId()
    if (!windowId) return false
    const s = sessions.get(windowId)
    if (!s) {
      if (id === 'tab.reopenClosed' && canReopen(windowId)) return reopenPeek(windowId)
      return false
    }
    if (s.phase !== 'open') {
      // New input finishes the transition first (FL-01), then acts on the result.
      settleNow(s)
      return false
    }
    if (id === 'tab.close') {
      closePeek(windowId)
      return true
    }
    if (id === 'peek.expand') {
      expandPeek(windowId)
      return true
    }
    if (id === 'url.edit') {
      // Editing the address is about the page on screen: the Peek becomes a tab at once and the
      // command bar then edits its URL, so the tab underneath never navigates (PK-11).
      s.phase = 'expanding'
      commitExpand(s)
      return false
    }
    const contents = s.view?.webContents
    if (!contents || contents.isDestroyed()) return false
    return runPageAction(id, contents, (message) => ctx.toast(windowId, message))
  })

  // Selecting another tab, switching Space or replacing the overlay dismisses the Peek (PK-13).
  store.subscribe((next, prev, patches) => {
    for (const p of patches) {
      if (p.op === 'remove' && p.path[0] === 'tabs' && p.path.length === 2) {
        const gone = prev.tabs[String(p.path[1])]
        if (gone && !gone.floating) lastTabCloseAt = Date.now()
      }
    }
    // Switching to another main window dismisses the Peek too (PK-13).
    for (const [id, w] of Object.entries(next.windows)) {
      if (w.kind !== 'main' || !w.focused || prev.windows[id]?.focused) continue
      for (const s of sessions.values()) {
        if (s.windowId !== id && s.phase === 'open') queueMicrotask(() => closePeek(s.windowId, { animate: false }))
      }
    }
    for (const s of [...sessions.values()]) {
      const win = next.windows[s.windowId]
      const overlay = win?.overlay
      const ours = overlay?.kind === 'peek' && overlay.nonce === s.nonce
      if (!win || !ours || !next.tabs[s.tabId]) {
        if (s.phase === 'open' && win && next.tabs[s.tabId]) queueMicrotask(() => remember(s))
        queueMicrotask(() => sessions.get(s.windowId) === s && discard(s))
        continue
      }
      if (s.phase === 'open' && activeTabOf(next, s.windowId) !== s.sourceTabId) {
        queueMicrotask(() => closePeek(s.windowId, { animate: false }))
      }
      const error = next.tabs[s.tabId]?.error
      if (error && error !== prev.tabs[s.tabId]?.error) dropStill(s)
    }
  })

  // ---- Links ----

  const sourceOf = (tabId: TabId, contents: WebContents): LinkSource | undefined => {
    const tab = store.state.tabs[tabId]
    // A private window's links stay in private windows: no Peek there, and a Mini Window would
    // carry them into a normal profile (NV-11). The usual new-tab and new-window handling applies.
    if (!tab || isPrivateTab(store.state, tabId)) return undefined
    const url = contents.getURL() || tab.url
    if (tab.floating === 'peek') return { kind: 'peek', url }
    if (tab.floating === 'mini') return { kind: 'mini', url }
    return { kind: 'tab', section: sectionOf(store.state, tabId), url }
  }

  /** The click position in window coordinates (where the card grows from). */
  const clickOrigin = (tabId: TabId, click: PageClick | undefined) => {
    const view = tabs.get(tabId)
    if (!view || click?.x === undefined || click.y === undefined) return undefined
    const b = view.getBounds()
    return { x: b.x + click.x, y: b.y + click.y }
  }

  /** Opens a link as a new selected tab: a meeting link, or one a routing rule sends to a Space (PK-04). */
  const openTab = (url: string, openerTabId: TabId, spaceId?: string) => {
    const windowId =
      windows.windowOfTab(openerTabId) ?? sessionOfTab(openerTabId)?.windowId ?? windows.focusedWindowId()
    const space = spaceId && store.state.spaces[spaceId] ? spaceId : undefined
    void commands
      .run('tabs.create', { url, ...(space ? { spaceId: space } : {}) }, { windowId })
      .catch((err) => console.error('[peek] could not open a tab', err))
  }

  const howFor = (details: HandlerDetails, click: PageClick | undefined): LinkHow => {
    if (isMiniClick(click)) return 'mini'
    switch (details.disposition) {
      case 'new-window':
        return details.features ? 'popup' : 'shift'
      case 'background-tab':
        return 'background-tab'
      case 'foreground-tab':
      case 'default':
        // ⌘⇧-click asks for a foreground tab on purpose.
        return click && (click.meta || click.control) ? 'background-tab' : 'new-tab'
      default:
        // Downloads (Alt-click) and the like keep the engine's handling.
        return 'popup'
    }
  }

  // Runs before the tabs' own new-tab handling so Peek and Mini Window get first say.
  ctx.hooks.windowOpen.unshift((openerTabId, details): WindowOpenHandlerResponse | undefined => {
    const contents = tabs.contents(openerTabId)
    if (!contents) return undefined
    const source = sourceOf(openerTabId, contents)
    if (!source) return undefined
    const click = clicks.recent(contents)
    const decision = decideLink(howFor(details, click), source, details.url, linkSettings())
    switch (decision.to) {
      case 'peek': {
        const windowId = windows.windowOfTab(openerTabId)
        if (!canPeek(windowId)) return undefined
        const origin = clickOrigin(openerTabId, click)
        if (details.disposition === 'new-window') {
          // A Shift-click: the engine makes no page of its own for it, so the Peek loads the link.
          setImmediate(() => openPeek(windowId, details.url, { origin }))
          return { action: 'deny' }
        }
        // target=_blank or window.open(): keep the page the engine made (opener, form data).
        return {
          action: 'allow',
          outlivesOpener: true,
          overrideBrowserWindowOptions: { webPreferences: KEEP_KEYBOARD },
          createWindow: (options) => {
            const guest = (options as { webContents?: WebContents }).webContents
            let created: WebContents | undefined
            openPeek(windowId, details.url, {
              origin,
              create: (tab) => {
                const view = guest
                  ? new WebContentsView(options as WebContentsViewConstructorOptions)
                  : (tabs.ensure(tab.id) as WebContentsView)
                if (guest) tabs.adopt(tab.id, view)
                created = view.webContents
                return view
              },
            })
            if (created) return created
            // The Peek could not open after all: the link opens as a tab instead.
            const spare = guest
              ? new WebContentsView(options as WebContentsViewConstructorOptions)
              : new WebContentsView()
            setImmediate(() => spare.webContents.close())
            openTab(details.url, openerTabId)
            return spare.webContents
          },
        }
      }
      case 'self':
        setImmediate(() => tabs.navigate(openerTabId, details.url))
        return { action: 'deny' }
      case 'mini':
        setImmediate(() => openMiniWindow(ctx, details.url))
        return { action: 'deny' }
      case 'tab':
        setImmediate(() => openTab(details.url, openerTabId, decision.spaceId))
        return { action: 'deny' }
      default:
        return undefined
    }
  })

  const onWillNavigate = (
    tabId: TabId,
    contents: WebContents,
    event: Electron.Event<WebContentsWillNavigateEventParams>,
  ) => {
    if (!event.isMainFrame) return
    // Only a click (or Enter) on the link to this very URL. Form posts, script navigations and
    // auto-posted sign-ins keep their tab, and so does a click whose link isn't known yet.
    const url = event.url
    const click = clicks.onLink(contents, url)
    if (!click) return
    // The click already opened this link. A second navigation to it (a clickable card's script, an
    // onclick that sets location) is the same click: the tab stays where it is (lead review V1).
    if (click.opened) {
      event.preventDefault()
      return
    }
    const source = sourceOf(tabId, contents)
    if (!source) return
    const decision = decideLink('navigate', source, url, linkSettings())
    if (decision.to === 'peek') {
      const windowId = windows.windowOfTab(tabId)
      if (!canPeek(windowId)) return
      event.preventDefault()
      clicks.markOpened(contents)
      const origin = clickOrigin(tabId, click)
      setImmediate(() => openPeek(windowId, url, { origin }))
    } else if (decision.to === 'tab') {
      event.preventDefault()
      clicks.markOpened(contents)
      setImmediate(() => openTab(url, tabId, decision.spaceId))
    } else if (decision.to === 'mini') {
      event.preventDefault()
      clicks.markOpened(contents)
      setImmediate(() => openMiniWindow(ctx, url))
    }
  }

  /** Sidebar undo's key, as the keymap has it (KS-05). */
  const isUndoKey = (input: Input) => sidebarUndoFor(input, process.platform)?.redo === false

  const onKey = (tabId: TabId, event: Electron.Event, input: Input) => {
    if (input.type !== 'keyDown') return
    const s = sessionOfTab(tabId)
    if (s && input.key === 'Escape' && !input.shift && !input.control && !input.alt && !input.meta) {
      // A page in fullscreen leaves fullscreen first; the next Escape closes the Peek (PK-09).
      if (s.fullscreen) return
      event.preventDefault()
      closePeek(s.windowId)
      return
    }
    if (!undo) return
    if (undo.until < Date.now()) {
      undo = undefined
      return
    }
    if (windows.windowOfTab(tabId) !== undo.windowId) return
    // Any other key ends the chance to bring the Peek back with ⌘Z (the tabs runtime reports ⌘Z).
    if (!isUndoKey(input) && !['Shift', 'Control', 'Alt', 'Meta'].includes(input.key)) undo = undefined
  }

  /** ⌘Z right after a Peek closed in this window reopens it (PK-10). */
  const undoArmed = (windowId: WindowId | undefined): windowId is WindowId =>
    !!undo && undo.windowId === windowId && undo.until >= Date.now()
  // ⌘Z in a page (outside text fields) undoes the last sidebar change (TB-18), unless a Peek just
  // closed there: then it reopens the Peek. One handler, so a single press never does both.
  const sidebarUndo = tabs.onUndoShortcut
  tabs.onUndoShortcut = (tabId, redo) => {
    const windowId = windows.windowOfTab(tabId)
    if (!redo && undoArmed(windowId)) {
      reopenPeek(windowId)
      return
    }
    sidebarUndo?.(tabId, redo)
  }

  ctx.hooks.tabCreated.push((tabId, contents) => {
    clicks.watch(contents)
    // The overlay's still of a Peek's page is taken again once the page has drawn a change (PK-06).
    const changed = () => {
      const s = sessionOfTab(tabId)
      if (s?.phase === 'open' && s.shown && s.view?.webContents === contents) stillSoon(s, STILL_AFTER_MS)
    }
    contents.on('did-stop-loading', changed)
    contents.on('did-navigate-in-page', changed)
    contents.on('input-event', (_e, input) => {
      if (STILL_INPUTS.has(input.type)) changed()
    })
    // A Peek page that closes itself (window.close()), or goes some other way (its tab put to sleep),
    // takes its card with it. By now its view may read no page at all: that counts as this one gone.
    contents.once('destroyed', () => {
      const s = sessionOfTab(tabId)
      if (s?.view && (s.view.webContents === contents || !pageOf(s.view)) && sessions.get(s.windowId) === s) discard(s)
    })
    contents.on('will-navigate', (event) => onWillNavigate(tabId, contents, event))
    contents.on('before-input-event', (event, input) => onKey(tabId, event, input))
    // A video in fullscreen covers the window; leaving it puts the page back in the card.
    contents.on('enter-html-full-screen', () => {
      const s = sessionOfTab(tabId)
      const win = s && windows.get(s.windowId)
      if (!s?.view || !pageOf(s.view) || !win) return
      s.fullscreen = true
      const [width = 0, height = 0] = win.getContentSize()
      s.view.setBounds({ x: 0, y: 0, width, height })
      s.view.setBorderRadius(0)
    })
    contents.on('leave-html-full-screen', () => {
      const s = sessionOfTab(tabId)
      if (!s?.view || !s.fullscreen) return
      s.fullscreen = false
      s.view.setBorderRadius(PEEK_RADIUS)
      placeView(s)
    })
  })
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function roundRect(r: Rect): Rect {
  const x = Math.round(r.x)
  const y = Math.round(r.y)
  return {
    x,
    y,
    width: Math.max(1, Math.round(r.x + r.width) - x),
    height: Math.max(1, Math.round(r.y + r.height) - y),
  }
}
