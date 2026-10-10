import type {
  HandlerDetails,
  Input,
  WebContents,
  WebContentsViewConstructorOptions,
  WebContentsWillNavigateEventParams,
  WindowOpenHandlerResponse,
} from 'electron'
import { WebContentsView } from 'electron'
import { decideLink, type LinkHow, type LinkSettings, type LinkSource, routeFor } from '../../shared/link-routing'
import { PEEK_RADIUS, peekCard, peekStart } from '../../shared/peek-geometry'
import { isPrivateTab } from '../../shared/private'
import type { Rect } from '../../shared/rpc'
import { layoutLeaves, MAX_PANES, SPLIT_FULL_MESSAGE } from '../../shared/split'
import type { OrbitState, SpaceId, Tab, TabId, WindowId } from '../../shared/state'
import { insertItem, sectionOf, splitOfTab } from '../../shared/tree'
import type { MainContext } from '../context'
import { openMiniWindow } from '../miniwindow'
import type { CallContext } from '../registry'
import { activateInDraft, todayInsertIndex } from '../tabs/model'
import type { SavedHistory } from '../tabs/runtime'
import { activeTabOf } from '../windows'
import { archiveFloating, floatingTab, keepFloatingPagesOutOfTabClose } from './floating'
import { ClickTracker, heldModifiers, isMiniClick, PAGE_WORLD, type PageClick } from './input'
import { runPageAction } from './page-actions'

/** A Peek card open in a window: a floating tab whose view sits above the overlay, in the card. */
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
  /** Last card rect and radius applied to the view (window coordinates). */
  rect?: Rect
  radius: number
  /** The page is in HTML fullscreen (a video): its view covers the window. */
  fullscreen: boolean
  /** Commits the running transition if the overlay never reports it finished. */
  settleTimer?: NodeJS.Timeout
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

let nonceCounter = 0

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
      radius: PEEK_RADIUS,
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
    if (!view) {
      discard(session)
      return null
    }
    place(session, view, origin)
    return tab.id
  }

  /** Puts the Peek's page view above the overlay, at the start of the open animation. */
  const place = (s: Session, view: WebContentsView, origin?: { x: number; y: number }) => {
    const win = windows.get(s.windowId)
    if (!win || win.isDestroyed()) return
    s.view = view
    const card = peekCard(s.area)
    const start = peekStart(card, s.area, origin)
    s.rect = toWindow(s, start)
    view.setBounds(roundRect(s.rect))
    view.setBorderRadius(PEEK_RADIUS)
    view.setVisible(true)
    win.contentView.addChildView(view)
    view.webContents.focus()
    // Whatever the overlay does, the card ends at its place.
    s.settleTimer = setTimeout(() => {
      if (sessions.get(s.windowId) !== s || s.phase !== 'open' || s.fullscreen) return
      applyRect(s, toWindow(s, peekCard(s.area)), PEEK_RADIUS, true)
    }, SETTLE_MS)
  }

  const applyRect = (s: Session, rect: Rect, radius: number, visible: boolean) => {
    const view = s.view
    if (!view || view.webContents.isDestroyed()) return
    s.rect = rect
    s.radius = radius
    if (s.fullscreen) return
    view.setBounds(roundRect(rect))
    view.setBorderRadius(Math.round(radius))
    if (view.getVisible() !== visible) view.setVisible(visible)
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
    setOverlay(s, { phase: 'closing' })
    // Keys go to the page underneath at once; the card fades out on its own.
    windows.focusActiveTab(windowId)
    s.settleTimer = setTimeout(() => discard(s), SETTLE_MS)
    sampleBackground(s)
  }

  /** Removes the Peek: its view, its tab and the overlay. */
  const discard = (s: Session) => {
    clearTimeout(s.settleTimer)
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
    ctx.perf.mark('peek:expand')
    setOverlay(s, { phase: 'expanding' })
    s.settleTimer = setTimeout(() => commitExpand(s), SETTLE_MS)
  }

  /** The Peek's page becomes an ordinary tab, live (no reload): top of Today, selected. */
  const commitExpand = (s: Session) => {
    clearTimeout(s.settleTimer)
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
    setOverlay(s, { phase: 'splitting' })
    s.settleTimer = setTimeout(() => commitSplit(s), SETTLE_MS)
  }

  const commitSplit = (s: Session) => {
    clearTimeout(s.settleTimer)
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

  // The overlay animates the card; the page view follows it every frame.
  ctx.events.on('peek.frame', ({ nonce, rect, radius, visible }, { windowId }) => {
    const s = sessions.get(windowId ?? '')
    if (!s || s.nonce !== nonce) return
    applyRect(s, toWindow(s, rect), radius, visible)
  })
  // The page area moved or resized (sidebar toggled, window resized): the card follows.
  ctx.events.on('layout.panes', (_payload, { windowId }) => {
    const s = sessions.get(windowId ?? '')
    if (!s) return
    const area = windows.pageArea(s.windowId)
    if (!area || sameRect(area, s.area)) return
    s.area = area
    setOverlay(s, { area: { width: area.width, height: area.height } })
    if (s.phase === 'open') applyRect(s, toWindow(s, peekCard(area)), PEEK_RADIUS, true)
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

  const isUndoKey = (input: Input) =>
    input.key.toLowerCase() === 'z' &&
    !input.shift &&
    !input.alt &&
    (process.platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta)

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
    // A Peek page that closes itself (window.close()) takes its card with it.
    contents.once('destroyed', () => {
      const s = sessionOfTab(tabId)
      if (s && s.view?.webContents === contents && sessions.get(s.windowId) === s) discard(s)
    })
    contents.on('will-navigate', (event) => onWillNavigate(tabId, contents, event))
    contents.on('before-input-event', (event, input) => onKey(tabId, event, input))
    // A video in fullscreen covers the window; leaving it puts the page back in the card.
    contents.on('enter-html-full-screen', () => {
      const s = sessionOfTab(tabId)
      const win = s && windows.get(s.windowId)
      if (!s?.view || !win) return
      s.fullscreen = true
      const [width = 0, height = 0] = win.getContentSize()
      s.view.setBounds({ x: 0, y: 0, width, height })
      s.view.setBorderRadius(0)
    })
    contents.on('leave-html-full-screen', () => {
      const s = sessionOfTab(tabId)
      if (!s?.view || !s.fullscreen) return
      s.fullscreen = false
      if (s.rect) applyRect(s, s.rect, s.radius, true)
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
