import {
  app,
  BrowserWindow,
  globalShortcut,
  Menu,
  nativeTheme,
  screen,
  systemPreferences,
  type WebContents,
} from 'electron'
import { toElectronAccelerator } from '../../shared/actions'
import { createWindowState } from '../../shared/defaults'
import { newId } from '../../shared/ids'
import { routeFor } from '../../shared/link-routing'
import { findTextFromSelection } from '../../shared/nav'
import { isPrivateTab } from '../../shared/private'
import type { Rect } from '../../shared/rpc'
import type { OrbitState, ProfileId, SpaceId, TabId, WindowId } from '../../shared/state'
import { NEUTRAL_THEME, paletteFor } from '../../shared/theme'
import { insertItem, removeItem, sectionOf } from '../../shared/tree'
import { engineForWindow, parseInput, siteOf } from '../../shared/url'
import type { MainContext } from '../context'
import { NAV_WORLD } from '../nav/focus'
import { archiveFloating, floatingTab, keepFloatingPagesOutOfTabClose } from '../peek/floating'
import { runPageAction } from '../peek/page-actions'
import type { CallContext } from '../registry'
import { activateInDraft, detachFromSplit, reselectAway, todayInsertIndex } from '../tabs/model'
import { activeTabOf, loadRenderer, rendererEntry, uiWebPreferences } from '../windows'
import { miniSwitchIn, NEW_MINI_SWITCH, systemWideShortcut, TOGGLE_MINIS_SWITCH } from './switches'

/**
 * Mini Windows (MW-*): small, separate windows holding one page, for links from other apps and
 * quick lookups. Each is a WindowState of kind 'mini' whose page is a floating tab (in no sidebar
 * container) placed by this module in the card the `mini` renderer draws.
 */

interface Mini {
  id: WindowId
  win: BrowserWindow
  /** The page; none while the blank window shows its lookup bar (MW-06). */
  tabId?: TabId
  /** The URL another app asked for, so a repeat finds this window even after redirects (MW-02). */
  openedUrl?: string
  /** The card the renderer reports (window coordinates). */
  rect?: Rect
  lastActive: number
  /** Has focus (from the window's focus/blur events). */
  focused?: boolean
  archiveTimer?: NodeJS.Timeout
  /** Closing because it sat idle (archived as such). */
  idleClose?: boolean
  /** The page moved into a Space: closing must not archive or destroy it. */
  moved?: boolean
  /** The page is in HTML fullscreen: its view covers the window. */
  fullscreen?: boolean
  /** The command bar over the page is open (CB-23): it takes ⌘W and ⌘L first (KS-19). */
  bar?: boolean
  /** The page's view is hidden behind the bar's still image of it (CB-23). */
  pageHidden?: boolean
  /**
   * The open grow (MW-04): waiting for the UI to take its starting size (`ready`), then growing;
   * the page's view sits out the grow (`pageOut`) and joins at full size when it ends.
   */
  grow?: { ready?: (ms: number | null) => void; pageOut: boolean }
  /** Find in the page (NV-05): its field is in the top bar. */
  find?: MiniFind
}

interface MiniFind {
  open: boolean
  query: string
  /** The latest find request: results of older ones are ignored. */
  request: number
}

/** What the find field shows of a search (`mini:find-result`). */
interface MiniFindResult {
  matches: number
  active: number
  searched: boolean
}

/** Layout of the mini renderer (kept in step with mini.css): top bar height and card inset. */
export const MINI_BAR = 40
export const MINI_INSET = 6
export const MINI_RADIUS = 10
const DEFAULT_SIZE = { width: 900, height: 650 }
const CASCADE = 24
const isMac = process.platform === 'darwin'
/** Window opacity animations exist on macOS and Windows only. */
const canFade = isMac || process.platform === 'win32'
/**
 * The open grow (MW-04): the window's content starts at this scale. The OS window itself is not
 * resized (that would lay the page out again every frame): its UI grows in its own layer.
 */
const GROW_FROM = 0.92
/** How long main waits for the UI to take its starting size before showing the window anyway. */
const GROW_READY_WAIT_MS = 100

interface MiniApi {
  open(url?: string): WindowId | undefined
  openOrFocus(url: string): WindowId | undefined
}

let api: MiniApi | undefined

/** Opens a link in a new Mini Window (⌘⌥-click, MW-07). */
export function openMiniWindow(_ctx: MainContext, url?: string): WindowId | undefined {
  return api?.open(url)
}

/**
 * Where a link from another app goes (NV-18, MW-02): a routing rule's Space, else a Mini Window
 * (an open one for the same URL comes forward), or with Mini Windows off a tab in the chosen or
 * most recent Space (MW-11).
 */
export function routeExternalLink(ctx: MainContext, url: string): void {
  const settings = ctx.store.state.settings
  const routed = routeFor(settings.linkRules ?? [], url)
  if (routed && ctx.store.state.spaces[routed]) {
    openInSpace(ctx, url, routed)
    return
  }
  if (settings.miniWindowForExternalLinks && api) {
    api.openOrFocus(url)
    return
  }
  const chosen = settings.externalLinksSpace
  openInSpace(ctx, url, chosen && ctx.store.state.spaces[chosen] ? chosen : undefined)
}

/** Opens a URL as a selected Today tab in a main window (one showing `spaceId`, else the most recent). */
function openInSpace(ctx: MainContext, url: string, spaceId?: SpaceId): void {
  const windowId = mainWindowFor(ctx, spaceId) ?? ctx.windows.open(undefined, spaceId)
  void ctx.commands.run('tabs.create', { url, ...(spaceId ? { spaceId } : {}) }, { windowId }).catch((err) => {
    console.error('[mini] could not open', url, err)
  })
  raise(ctx.windows.get(windowId))
}

/** A main window to use: one already showing `spaceId`, else the focused or most recent one. */
function mainWindowFor(ctx: MainContext, spaceId?: SpaceId): WindowId | undefined {
  const state = ctx.store.state
  const ids = ctx.windows.ids().filter((id) => state.windows[id]?.kind === 'main')
  if (spaceId) {
    const showing = ids.find((id) => state.windows[id]?.spaceId === spaceId)
    if (showing) return showing
  }
  const focused = ctx.windows.focusedWindowId()
  if (focused && ids.includes(focused)) return focused
  return lastMain && ids.includes(lastMain) ? lastMain : ids[0]
}

/** The main window that most recently had focus. */
let lastMain: WindowId | undefined

function raise(win: BrowserWindow | undefined): void {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function reducedMotion(): boolean {
  try {
    return systemPreferences.getAnimationSettings().prefersReducedMotion
  } catch {
    return false
  }
}

export function registerMiniWindow(ctx: MainContext): void {
  const { store, commands, actions, windows, tabs } = ctx
  const minis = new Map<WindowId, Mini>()
  let spare: { id: WindowId; win: BrowserWindow } | undefined
  let spareTimer: NodeJS.Timeout | undefined
  let quitting = false
  let lastShortcutOpen = 0

  const miniOfTab = (tabId: TabId): Mini | undefined => {
    for (const m of minis.values()) if (m.tabId === tabId) return m
    return undefined
  }
  windows.addFloatingOwner((tabId) => miniOfTab(tabId)?.id)
  keepFloatingPagesOutOfTabClose(ctx)

  const send = (mini: Mini, channel: string, payload: unknown = {}) => {
    if (!mini.win.isDestroyed()) mini.win.webContents.send(`orbit:${channel}`, payload)
  }

  // ---- Profiles and Spaces ----

  /** The Space whose profile a page should use: the most recent main window's, when it has that profile. */
  const spaceForProfile = (state: OrbitState, profileId: ProfileId): SpaceId => {
    const recent = mainWindowFor(ctx)
    const recentSpace = recent ? state.windows[recent]?.spaceId : undefined
    if (recentSpace && state.spaces[recentSpace]?.profileId === profileId) return recentSpace
    return (state.spaceOrder.find((s) => state.spaces[s]?.profileId === profileId) ?? state.spaceOrder[0]) as SpaceId
  }

  /** The profile for a URL: the one last chosen for its site (MW-10), else the most recent Space's. */
  const profileFor = (state: OrbitState, url?: string): ProfileId => {
    const remembered = url ? state.settings.miniWindowProfiles?.[siteOf(url)] : undefined
    if (remembered && state.profiles[remembered]) return remembered
    const recent = mainWindowFor(ctx)
    const spaceId = (recent && state.windows[recent]?.spaceId) || state.spaceOrder[0]
    return state.spaces[spaceId ?? '']?.profileId ?? (Object.keys(state.profiles)[0] as ProfileId)
  }

  // ---- Windows ----

  /** Where the next Mini Window goes: the last-used size and place, cascaded past open ones (MW-04). */
  const nextBounds = (): Rect => {
    const saved = store.state.settings.miniWindowBounds
    const cursor = screen.getCursorScreenPoint()
    const display = (saved ? screen.getDisplayMatching(saved) : screen.getDisplayNearestPoint(cursor)).workArea
    const width = Math.min(saved?.width ?? DEFAULT_SIZE.width, Math.round(display.width * 0.7))
    const height = Math.min(saved?.height ?? DEFAULT_SIZE.height, Math.round(display.height * 0.7))
    let x = saved ? saved.x : Math.round(display.x + (display.width - width) / 2)
    let y = saved ? saved.y : Math.round(display.y + (display.height - height) / 2)
    const open = [...minis.values()].filter((m) => !m.win.isDestroyed()).length
    x += (open % 8) * CASCADE
    y += (open % 8) * CASCADE
    x = Math.max(display.x, Math.min(x, display.x + display.width - width))
    y = Math.max(display.y, Math.min(y, display.y + display.height - height))
    return { x, y, width, height }
  }

  /** A Mini Window has no Space: the neutral theme, light or dark as the app is (MW-03). */
  const neutralBackground = () => paletteFor(NEUTRAL_THEME, nativeTheme.shouldUseDarkColors).windowBackground

  const createWindow = (id: WindowId): BrowserWindow => {
    const win = new BrowserWindow({
      ...nextBounds(),
      minWidth: 380,
      minHeight: 280,
      show: false,
      title: 'Orbit',
      backgroundColor: neutralBackground(),
      ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 13 } } : { frame: false }),
      webPreferences: { ...uiWebPreferences(id, 'mini'), backgroundThrottling: false },
    })
    windows.registerUi(win.webContents, id)
    windows.attachShortcuts(win.webContents)
    // Orbit's own UI never navigates away or opens windows.
    win.webContents.on('will-navigate', (event, url) => {
      const entry = rendererEntry()
      if (!(entry.url && url.startsWith(entry.url))) event.preventDefault()
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    loadRenderer(win.webContents, 'mini')
    return win
  }

  /** Keeps one Mini Window rendered and hidden, so ⌘⌥N shows a ready lookup bar at once (MW-15). */
  const ensureSpare = () => {
    clearTimeout(spareTimer)
    if (spare || quitting || windows.ids().length === 0) return
    const id = newId('w')
    const win = createWindow(id)
    spare = { id, win }
    win.once('closed', () => {
      if (spare?.win === win) spare = undefined
    })
  }
  const spareSoon = (ms: number) => {
    clearTimeout(spareTimer)
    spareTimer = setTimeout(ensureSpare, ms)
  }
  const dropSpare = () => {
    clearTimeout(spareTimer)
    const s = spare
    spare = undefined
    if (s && !s.win.isDestroyed()) s.win.destroy()
  }

  const cardRect = (mini: Mini): Rect => {
    if (mini.rect) return mini.rect
    const [width = 0, height = 0] = mini.win.getContentSize()
    return {
      x: MINI_INSET,
      y: MINI_BAR,
      width: Math.max(1, width - MINI_INSET * 2),
      height: Math.max(1, height - MINI_BAR - MINI_INSET),
    }
  }

  /** Puts the page's view into the window's card (creating and loading it if needed). */
  const attachPage = (mini: Mini) => {
    if (!mini.tabId || mini.win.isDestroyed()) return
    const view = tabs.ensure(mini.tabId)
    if (!view) return
    view.setBounds(roundRect(cardRect(mini)))
    view.setBorderRadius(MINI_RADIUS)
    // While the window grows open the page waits out of sight, then joins at full size (MW-04).
    view.setVisible(!mini.grow)
    if (mini.grow) mini.grow.pageOut = true
    mini.win.contentView.addChildView(view)
    if (mini.win.isFocused()) view.webContents.focus()
  }

  /** The bar over the page is gone: the page's view comes back from behind its still image (CB-23). */
  const uncover = (mini: Mini) => {
    mini.bar = false
    if (!mini.pageHidden) return
    mini.pageHidden = false
    const view = mini.tabId ? tabs.get(mini.tabId) : undefined
    view?.setVisible(true)
  }

  const detachPage = (mini: Mini) => {
    const view = mini.tabId ? tabs.get(mini.tabId) : undefined
    if (!view || mini.win.isDestroyed()) return
    try {
      mini.win.contentView.removeChildView(view)
    } catch {
      // not there
    }
  }

  const fadeIn = (win: BrowserWindow, ms: number) => {
    if (!canFade || reducedMotion()) {
      win.show()
      return
    }
    win.setOpacity(0)
    win.show()
    const start = Date.now()
    const timer = setInterval(() => {
      if (win.isDestroyed()) return clearInterval(timer)
      const t = Math.min(1, (Date.now() - start) / ms)
      win.setOpacity(1 - (1 - t) ** 3)
      if (t >= 1) clearInterval(timer)
    }, 12)
  }

  /**
   * Shows a Mini Window with a quick scale-and-fade rather than the OS's own animation (MW-04):
   * its UI grows from 92% to full size in its own layer as the window fades in (where windows can
   * fade; elsewhere the UI fades too). The page's native view can't scale, so it sits out the
   * grow and joins at full size when it ends; it has been loading all along (MW-15). `shown` runs
   * once the window is on screen.
   */
  const growOpen = (mini: Mini, shown: () => void) => {
    const win = mini.win
    if (reducedMotion()) {
      win.show()
      shown()
      return
    }
    const view = mini.tabId ? tabs.get(mini.tabId) : undefined
    const pageOut = !!view && !mini.pageHidden && !mini.fullscreen
    if (pageOut) view?.setVisible(false)
    const grow: NonNullable<Mini['grow']> = { pageOut }
    mini.grow = grow
    const end = () => {
      if (mini.grow !== grow) return
      mini.grow = undefined
      const page = mini.tabId ? tabs.get(mini.tabId) : undefined
      if (!grow.pageOut || !page || win.isDestroyed() || mini.pageHidden || mini.fullscreen) return
      page.setVisible(true)
      // A hidden view can't take the keyboard: the page gets it now, unless the bar or find has it.
      if (win.isFocused() && !mini.bar && !mini.find?.open) page.webContents.focus()
    }
    const start = (ms: number | null) => {
      if (grow.ready !== start) return
      grow.ready = undefined
      clearTimeout(wait)
      if (win.isDestroyed()) return
      if (ms === null) {
        // The UI didn't answer in time (still starting): the window shows without the grow.
        send(mini, 'mini:grow', { phase: 'cancel' })
        win.show()
        shown()
        end()
        return
      }
      fadeIn(win, ms)
      shown()
      send(mini, 'mini:grow', { phase: 'run' })
      setTimeout(end, ms)
    }
    grow.ready = start
    const wait = setTimeout(() => start(null), GROW_READY_WAIT_MS)
    send(mini, 'mini:grow', { phase: 'prepare', scale: GROW_FROM, fade: !canFade })
  }

  /**
   * Closes with a quick fade (about 150 ms, MW-15) where windows can fade. After "Open in…" it
   * also shrinks a little, as if the page went into the main window; its page has already left,
   * so only the window's own bar re-lays out.
   */
  const closeWindow = (mini: Mini, opts: { shrink?: boolean } = {}) => {
    const win = mini.win
    if (win.isDestroyed()) return
    if (!canFade || reducedMotion() || !win.isVisible()) {
      win.close()
      return
    }
    const from = win.getBounds()
    const start = Date.now()
    const timer = setInterval(() => {
      if (win.isDestroyed()) return clearInterval(timer)
      const t = Math.min(1, (Date.now() - start) / 140)
      win.setOpacity(1 - t)
      if (opts.shrink) {
        const scale = 1 - 0.08 * (1 - (1 - t) ** 3)
        const width = Math.round(from.width * scale)
        const height = Math.round(from.height * scale)
        win.setBounds({
          x: from.x + Math.round((from.width - width) / 2),
          y: from.y + Math.round((from.height - height) / 2),
          width,
          height,
        })
      }
      if (t >= 1) {
        clearInterval(timer)
        win.close()
      }
    }, 12)
  }

  /** Shows a Mini Window in front, above a full-screen Orbit window on macOS (MW-04). */
  const present = (mini: Mini) => {
    const win = mini.win
    const overFullscreen = isMac && windows.ids().some((id) => windows.get(id)?.isFullScreen())
    if (overFullscreen) {
      win.setAlwaysOnTop(true, 'floating')
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    }
    growOpen(mini, () => {
      win.focus()
      if (overFullscreen) setTimeout(() => !win.isDestroyed() && win.setVisibleOnAllWorkspaces(false), 300)
    })
  }

  /** Closes idle Mini Windows after the set time, archiving their page; never while media plays (MW-09). */
  const scheduleIdleClose = (mini: Mini) => {
    clearTimeout(mini.archiveTimer)
    const limit = store.state.settings.miniWindowArchiveAfterMs
    if (!limit || limit <= 0 || mini.win.isDestroyed() || mini.focused) return
    const wait = Math.max(0, mini.lastActive + limit - Date.now())
    mini.archiveTimer = setTimeout(() => {
      if (minis.get(mini.id) !== mini || mini.win.isDestroyed() || mini.focused) return
      if (mini.tabId && store.state.tabs[mini.tabId]?.audible) {
        mini.lastActive = Date.now()
        scheduleIdleClose(mini)
        return
      }
      mini.idleClose = true
      mini.win.close()
    }, wait)
  }

  const wire = (mini: Mini) => {
    const { win, id } = mini
    win.on('focus', () => {
      mini.focused = true
      mini.lastActive = Date.now()
      clearTimeout(mini.archiveTimer)
      const contents = mini.tabId ? tabs.contents(mini.tabId) : undefined
      if (contents) contents.focus()
    })
    win.on('blur', () => {
      mini.focused = false
      mini.lastActive = Date.now()
      scheduleIdleClose(mini)
    })
    win.on('resize', () => {
      mini.rect = undefined
      const view = mini.tabId ? tabs.get(mini.tabId) : undefined
      if (!view) return
      if (mini.fullscreen) {
        const [width = 0, height = 0] = win.getContentSize()
        view.setBounds({ x: 0, y: 0, width, height })
      } else view.setBounds(roundRect(cardRect(mini)))
    })
    let saveTimer: NodeJS.Timeout | undefined
    const saveBounds = () => {
      clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        // A window shrinking away as it closes is not a size to remember.
        if (win.isDestroyed() || win.isFullScreen() || win.isMinimized() || !win.isVisible() || mini.moved) return
        const b = win.getNormalBounds()
        store.update((d) => {
          d.settings.miniWindowBounds = { x: b.x, y: b.y, width: b.width, height: b.height }
        })
      }, 400)
    }
    win.on('resize', saveBounds)
    win.on('move', saveBounds)
    win.on('close', () => {
      clearTimeout(mini.archiveTimer)
      if (mini.moved || !mini.tabId) return
      const tab = store.state.tabs[mini.tabId]
      if (!tab) return
      const url = tabs.contents(mini.tabId)?.getURL() || tab.url
      store.update((d) => {
        archiveFloating(d, { ...tab, url }, 'mini', mini.idleClose ? 'auto' : 'closed')
      })
    })
    win.once('closed', () => {
      clearTimeout(saveTimer)
      clearTimeout(mini.archiveTimer)
      minis.delete(id)
      const tabId = mini.tabId
      if (tabId && !mini.moved) tabs.destroy(tabId)
      store.update((d) => {
        if (tabId && d.tabs[tabId]?.floating === 'mini') delete d.tabs[tabId]
        if (d.windows[id]?.kind === 'mini') delete d.windows[id]
      })
    })
  }

  /**
   * Opens a Mini Window: with a page, or blank with its lookup bar focused (MW-01, MW-06).
   * `adopt` moves a sidebar tab in, live: it leaves the sidebar and the window that showed it
   * selects another tab (MW-07). `profileId` opens the page in that profile.
   */
  const open = (url?: string, opts: { adopt?: TabId; profileId?: ProfileId } = {}): WindowId | undefined => {
    if (quitting) return undefined
    const adopted = opts.adopt ? store.state.tabs[opts.adopt] : undefined
    if (opts.adopt && (!adopted || adopted.floating)) return undefined
    const claimed = spare && !spare.win.isDestroyed() ? spare : undefined
    spare = undefined
    const id = claimed?.id ?? newId('w')
    const win = claimed?.win ?? createWindow(id)
    if (claimed) win.setBounds(nextBounds())
    const state = store.state
    const profileId = adopted?.profileId ?? opts.profileId ?? profileFor(state, url)
    const spaceId = adopted && state.spaces[adopted.spaceId] ? adopted.spaceId : spaceForProfile(state, profileId)
    const tab = !adopted && url ? floatingTab('mini', { spaceId, profileId, url }) : undefined
    const tabId = adopted?.id ?? tab?.id
    store.update((d) => {
      if (adopted) {
        // Other windows let go of it first (it is not in the new window yet), then it leaves the sidebar.
        reselectAway(d, new Set([adopted.id]))
        detachFromSplit(d, adopted.id)
        removeItem(d, adopted.id)
        const t = d.tabs[adopted.id]
        if (t) t.floating = 'mini'
      }
      const w = { ...createWindowState(spaceId, 'mini'), id }
      w.sidebar.visible = false
      if (tab) d.tabs[tab.id] = tab
      if (tabId) w.activeTab[spaceId] = tabId
      d.windows[id] = w
    })
    if (adopted) {
      // The page keeps running: its view moves from the main window to this one.
      const view = tabs.get(adopted.id)
      if (view) windows.detachView(adopted.id, view)
    }
    const mini: Mini = { id, win, tabId, openedUrl: url ?? adopted?.url, lastActive: Date.now() }
    minis.set(id, mini)
    wire(mini)
    ctx.perf.mark(`mini:${id}:open`)
    // The page starts loading before the window appears (MW-15).
    attachPage(mini)
    if (claimed) present(mini)
    else win.once('ready-to-show', () => !win.isDestroyed() && present(mini))
    spareSoon(claimed ? 600 : 1500)
    return id
  }

  /** A link from another app: an open Mini Window for the same URL comes forward instead (MW-02). */
  const openOrFocus = (url: string): WindowId | undefined => {
    const norm = normalizeUrl(url)
    for (const mini of minis.values()) {
      if (mini.win.isDestroyed() || !mini.tabId) continue
      const current = tabs.contents(mini.tabId)?.getURL() || store.state.tabs[mini.tabId]?.url
      if ((mini.openedUrl && normalizeUrl(mini.openedUrl) === norm) || (current && normalizeUrl(current) === norm)) {
        if (mini.win.isMinimized()) mini.win.restore()
        mini.win.show()
        mini.win.focus()
        return mini.id
      }
    }
    return open(url)
  }

  /**
   * ⌘⌥-click on a sidebar row (MW-07): a Today tab (or a split pane) moves into a Mini Window,
   * live; a pinned tab or Favorite keeps its place and its page opens in a Mini Window.
   */
  const fromTab = (tabId: TabId): WindowId | undefined => {
    const state = store.state
    const tab = state.tabs[tabId]
    // A private window's tab stays in private windows: a Mini Window is a normal-profile window (NV-11).
    if (!tab || tab.floating || isPrivateTab(state, tabId)) return undefined
    const section = sectionOf(state, tabId)
    if (section === 'today') return open(undefined, { adopt: tabId })
    const url = tabs.contents(tabId)?.getURL() || tab.url
    if (!url || url === 'about:blank') return undefined
    return open(url, { profileId: tab.profileId })
  }

  api = { open, openOrFocus }

  /** Loads what was typed (lookup bar or address field) in the Mini Window (MW-06). */
  const navigate = (mini: Mini, input: string) => {
    const text = input.trim()
    if (!text) return
    const url = parseInput(text, engineForWindow(store.state, mini.id)).url
    if (mini.tabId && store.state.tabs[mini.tabId]) {
      tabs.navigate(mini.tabId, url)
      tabs.contents(mini.tabId)?.focus()
      return
    }
    const state = store.state
    const profileId = profileFor(state, url)
    const spaceId = spaceForProfile(state, profileId)
    const tab = floatingTab('mini', { spaceId, profileId, url })
    mini.tabId = tab.id
    mini.openedUrl = url
    store.update((d) => {
      d.tabs[tab.id] = tab
      const w = d.windows[mini.id]
      if (w) {
        w.spaceId = spaceId
        w.activeTab = { [spaceId]: tab.id }
      }
    })
    attachPage(mini)
    tabs.contents(tab.id)?.focus()
  }

  /** Moves the page, live, into a Space of the main window and closes the Mini Window (MW-05). */
  const moveToSpace = (mini: Mini, spaceId?: SpaceId, pinned = false) => {
    const state = store.state
    const tabId = mini.tabId
    const tab = tabId ? state.tabs[tabId] : undefined
    if (!tabId || !tab) return
    const target =
      spaceId && state.spaces[spaceId]
        ? spaceId
        : (() => {
            const recent = mainWindowFor(ctx)
            return (recent && state.windows[recent]?.spaceId) || spaceForProfile(state, tab.profileId)
          })()
    const profileId = state.spaces[target]?.profileId ?? tab.profileId
    const mainId = mainWindowFor(ctx, target) ?? windows.open(undefined, target)
    const url = tabs.contents(tabId)?.getURL() || tab.url
    // The main window takes the page's view: it leaves the Mini Window first. The page is the
    // main window's from here on, while this window shrinks and fades out showing its old bar.
    send(mini, 'mini:leaving')
    uncover(mini)
    detachPage(mini)
    mini.moved = true
    mini.tabId = undefined
    ctx.perf.mark('mini:move')
    store.update((d) => {
      const t = d.tabs[tabId]
      const w = d.windows[mainId]
      if (!t || !w) return
      delete t.floating
      t.url = url
      t.spaceId = target
      t.profileId = profileId
      if (pinned) {
        t.pinnedUrl = url
        insertItem(d, { kind: 'pinned', spaceId: target }, Number.MAX_SAFE_INTEGER, tabId)
      } else {
        const space = d.spaces[target]
        insertItem(d, { kind: 'today', spaceId: target }, space ? todayInsertIndex(space, 'move') : 0, tabId)
      }
      // The Mini Window lets go of the page, then the main window selects it (TB-17).
      const m = d.windows[mini.id]
      if (m) m.activeTab = {}
      activateInDraft(d, mainId, tabId)
    })
    if (profileId !== tab.profileId) {
      // Another profile is another session: the page reloads there.
      tabs.savedHistory.delete(tabId)
      tabs.sleep(tabId)
    }
    raise(windows.get(mainId))
    closeWindow(mini, { shrink: true })
  }

  /** Reopens the page in another profile and remembers the choice for its site (MW-10). */
  const setProfile = (mini: Mini, profileId: ProfileId) => {
    const state = store.state
    const tabId = mini.tabId
    const tab = tabId ? state.tabs[tabId] : undefined
    if (!tabId || !tab || !state.profiles[profileId] || tab.profileId === profileId) return
    const url = tabs.contents(tabId)?.getURL() || tab.url
    const spaceId = spaceForProfile(state, profileId)
    uncover(mini)
    detachPage(mini)
    tabs.savedHistory.delete(tabId)
    tabs.sleep(tabId)
    store.update((d) => {
      const t = d.tabs[tabId]
      if (t) {
        t.profileId = profileId
        t.spaceId = spaceId
        t.url = url
      }
      const w = d.windows[mini.id]
      if (w) {
        w.spaceId = spaceId
        w.activeTab = { [spaceId]: tabId }
      }
      if (/^https?:/i.test(url))
        d.settings.miniWindowProfiles = { ...d.settings.miniWindowProfiles, [siteOf(url)]: profileId }
    })
    attachPage(mini)
  }

  const toggleAll = () => {
    const open = [...minis.values()].filter((m) => !m.win.isDestroyed())
    const anyVisible = open.some((m) => m.win.isVisible() && !m.win.isMinimized())
    for (const m of open) {
      if (anyVisible) m.win.hide()
      else m.win.showInactive()
    }
    if (!anyVisible) open.at(-1)?.win.focus()
  }

  // ---- Find in page (NV-05) ----

  const pageContents = (mini: Mini): WebContents | undefined => {
    const contents = mini.tabId ? tabs.contents(mini.tabId) : undefined
    return contents && !contents.isDestroyed() ? contents : undefined
  }
  const findResult = (mini: Mini, result: MiniFindResult) => send(mini, 'mini:find-result', result)

  /** Searches the page for `query` from the start (a new text), or for its next match forward or back. */
  const search = (mini: Mini, query: string, opts: { next?: boolean; forward?: boolean } = {}) => {
    const contents = pageContents(mini)
    const f = mini.find
    if (!contents || !f?.open) return
    const fresh = query !== f.query || !opts.next || f.request === 0
    f.query = query
    if (!query) {
      f.request = 0
      contents.stopFindInPage('clearSelection')
      findResult(mini, { matches: 0, active: 0, searched: false })
      return
    }
    try {
      f.request = contents.findInPage(query, { forward: opts.forward ?? true, findNext: fresh })
    } catch {
      f.request = 0
    }
  }

  /**
   * ⌘F: the find field opens in the top bar with the keyboard, on the page's selected text, else
   * this window's last search (NV-05).
   */
  const openFind = (mini: Mini) => {
    const contents = pageContents(mini)
    if (!contents || mini.win.isDestroyed()) return
    if (!mini.find) mini.find = { open: false, query: '', request: 0 }
    const f = mini.find
    const reopened = !f.open
    f.open = true
    mini.win.webContents.focus()
    send(mini, 'mini:find', { query: f.query })
    if (reopened && f.query) search(mini, f.query)
    contents
      .executeJavaScriptInIsolatedWorld(NAV_WORLD, [{ code: 'String(getSelection() || "")' }])
      .then((selected: unknown) => {
        const text = typeof selected === 'string' ? findTextFromSelection(selected) : ''
        // The field takes it unless something was typed there meanwhile.
        if (text && text !== f.query && f.open && mini.find === f)
          send(mini, 'mini:find', { query: text, selection: true })
      })
      .catch(() => {})
  }

  /** ⌘G, F3, Enter: the next match (or the previous); with the field closed it opens on the last search. */
  const stepFind = (mini: Mini, forward: boolean) => {
    const f = mini.find
    if (!f?.open || !f.query) {
      openFind(mini)
      return
    }
    search(mini, f.query, { next: true, forward })
  }

  const closeFind = (mini: Mini, keepFocus = false) => {
    const f = mini.find
    if (!f?.open) return
    f.open = false
    f.request = 0
    const contents = pageContents(mini)
    contents?.stopFindInPage('keepSelection')
    if (!keepFocus) contents?.focus()
  }

  // ---- Commands, events, actions ----

  const miniOf = (c: CallContext): Mini | undefined => {
    const windowId = c.windowId ?? windows.focusedWindowId()
    return windowId ? minis.get(windowId) : undefined
  }

  commands.register('mini.open', ({ url }) => open(url) ?? '')
  commands.register('mini.fromTab', ({ tabId }) => fromTab(tabId) ?? null)
  commands.register('mini.navigate', ({ input }, c) => {
    const mini = miniOf(c)
    if (mini) navigate(mini, input)
  })
  commands.register('mini.moveToSpace', ({ spaceId, pinned }, c) => {
    const mini = miniOf(c)
    if (mini) moveToSpace(mini, spaceId, pinned)
  })
  commands.register('mini.setProfile', ({ profileId }, c) => {
    const mini = miniOf(c)
    if (mini) setProfile(mini, profileId)
  })
  commands.register('mini.menu', ({ menu, x, y }, c) => {
    const mini = miniOf(c)
    const state = store.state
    const tab = mini?.tabId ? state.tabs[mini.tabId] : undefined
    if (!mini || !tab || mini.win.isDestroyed()) return
    const items: Electron.MenuItemConstructorOptions[] =
      menu === 'open-in'
        ? // Only the Spaces of the page's profile (MW-10); Today by default, or pinned there.
          state.spaceOrder
            .map((id) => state.spaces[id])
            .filter((space): space is NonNullable<typeof space> => space?.profileId === tab.profileId)
            .map((space) => ({
              label: `${space.icon ? `${space.icon}  ` : ''}${space.name}`,
              click: () => moveToSpace(mini, space.id),
            }))
        : Object.values(state.profiles).map((profile) => ({
            label: profile.name,
            type: 'radio' as const,
            checked: profile.id === tab.profileId,
            click: () => setProfile(mini, profile.id),
          }))
    if (items.length === 0) return
    Menu.buildFromTemplate(items).popup({ window: mini.win, x: Math.round(x), y: Math.round(y) })
  })
  // The bar over the page closed (Esc, ⌘W, ⌘L, a choice): the keyboard goes back to the page, which
  // had it before ⌘L (KS-16, KS-20). The page shows again first, so it can take the keyboard.
  commands.register('mini.focusPage', (_args, c) => {
    const mini = miniOf(c)
    if (mini) uncover(mini)
    const contents = mini?.tabId ? tabs.contents(mini.tabId) : undefined
    if (contents && !contents.isDestroyed()) contents.focus()
  })
  // CB-23: the bar over the page. Its list covers the page: the renderer draws a still image of
  // the page on the card, then main hides the page's view until the bar closes.
  commands.register('mini.bar', async ({ open }, c) => {
    const mini = miniOf(c)
    if (!mini) return null
    if (!open) {
      uncover(mini)
      return null
    }
    mini.bar = true
    const view = mini.tabId ? tabs.get(mini.tabId) : undefined
    if (!view || view.webContents.isDestroyed() || mini.fullscreen) return null
    try {
      const image = await view.webContents.capturePage()
      return image.isEmpty() ? null : `data:image/jpeg;base64,${image.toJPEG(85).toString('base64')}`
    } catch {
      return null
    }
  })
  commands.register('mini.hidePage', (_args, c) => {
    const mini = miniOf(c)
    const view = mini?.tabId ? tabs.get(mini.tabId) : undefined
    if (!mini?.bar || !view || mini.fullscreen) return
    view.setVisible(false)
    mini.pageHidden = true
  })
  commands.register('mini.find', ({ query, next, forward }, c) => {
    const mini = miniOf(c)
    if (mini) search(mini, query, { next, forward })
  })
  commands.register('mini.findClose', ({ keepFocus }, c) => {
    const mini = miniOf(c)
    if (mini) closeFind(mini, keepFocus)
  })
  commands.register('mini.control', ({ op }, c) => {
    const mini = miniOf(c)
    if (!mini || mini.win.isDestroyed()) return
    if (op === 'close') closeWindow(mini)
    else if (op === 'minimize') mini.win.minimize()
    else if (mini.win.isMaximized()) mini.win.unmaximize()
    else mini.win.maximize()
  })

  ctx.events.on('mini.layout', ({ rect }, { windowId }) => {
    const mini = minis.get(windowId ?? '')
    if (!mini) return
    mini.rect = rect
    const view = mini.tabId ? tabs.get(mini.tabId) : undefined
    if (view && !mini.fullscreen) view.setBounds(roundRect(rect))
  })
  // The UI took the grow's starting size: the window shows and grows (MW-04).
  ctx.events.on('mini.growReady', ({ ms }, { windowId }) => {
    const ready = minis.get(windowId ?? '')?.grow?.ready
    if (ready) ready(Number.isFinite(ms) && ms > 0 ? Math.min(ms, 1000) : null)
  })

  actions.register('window.newMini', () => {
    if (Date.now() - lastShortcutOpen < 250) return
    open()
  })
  actions.register('mini.chooseSpace', () => {})
  actions.register('mini.toggleAll', toggleAll)

  // In a Mini Window, keys act on its page; sidebar, Space and tab-list keys do nothing (KS-20).
  // Help → Keyboard Shortcuts, File → Open File… and the Library's keys (⌘Y / Ctrl+H for History,
  // ⌘⇧L) act in the browser window behind (OB-12, KS-12, AR-10, keys lane).
  const APP_ACTIONS = new Set([
    'window.new',
    'window.newMini',
    'window.newPrivate',
    'app.settings',
    'app.archive',
    'app.history',
    'app.library',
    'help.shortcuts',
    'file.open',
  ])
  actions.intercept((id, c) => {
    const mini = miniOf(c)
    if (!mini) return false
    // KS-19: the bar over the page takes ⌘W and ⌘L first, as the main window's bar does: each
    // closes it (CB-23).
    if (mini.bar && (id === 'tab.close' || id === 'url.edit')) {
      send(mini, 'mini:close-bar')
      return true
    }
    switch (id) {
      case 'tab.close':
      case 'window.close':
        closeWindow(mini)
        return true
      case 'peek.expand':
        moveToSpace(mini)
        return true
      case 'mini.chooseSpace':
        if (mini.tabId) send(mini, 'mini:choose-space')
        return true
      case 'url.edit':
        // The keyboard goes to the address field too: the page had it (KS-20, keys lane).
        if (!mini.win.isDestroyed()) mini.win.webContents.focus()
        send(mini, 'mini:edit-url')
        return true
      case 'tab.new': {
        const mainId = mainWindowFor(ctx) ?? windows.open()
        raise(windows.get(mainId))
        void actions.run('tab.new', { windowId: mainId })
        return true
      }
      // Find in the page, with its field in the top bar (NV-05; keys review F3).
      case 'page.find':
        openFind(mini)
        return true
      case 'page.findNext':
      case 'page.findPrevious':
        stepFind(mini, id === 'page.findNext')
        return true
    }
    if (APP_ACTIONS.has(id) || id === 'mini.toggleAll') return false
    const contents = mini.tabId ? tabs.contents(mini.tabId) : undefined
    if (contents) runPageAction(id, contents, () => {})
    return true
  })

  // Pages in a Mini Window: a video's fullscreen covers the window (MW-12).
  ctx.hooks.tabCreated.push((tabId, contents: WebContents) => {
    contents.on('found-in-page', (_event, result) => {
      const mini = miniOfTab(tabId)
      if (!mini?.find?.open || result.requestId !== mini.find.request) return
      findResult(mini, { matches: result.matches, active: result.activeMatchOrdinal, searched: true })
    })
    // A new page: the old matches are gone (the field stays open with its text).
    contents.on('did-navigate', () => {
      const mini = miniOfTab(tabId)
      if (!mini?.find?.open) return
      mini.find.request = 0
      findResult(mini, { matches: 0, active: 0, searched: false })
    })
    // A page that closes itself (window.close()) closes its Mini Window.
    contents.once('destroyed', () => {
      const mini = miniOfTab(tabId)
      if (!mini || mini.moved || quitting || mini.win.isDestroyed()) return
      // Reopened in another profile: a new page already took its place.
      const current = tabs.contents(tabId)
      if (current && current !== contents) return
      mini.win.close()
    })
    contents.on('enter-html-full-screen', () => {
      const mini = miniOfTab(tabId)
      const view = tabs.get(tabId)
      if (!mini || !view) return
      mini.fullscreen = true
      const [width = 0, height = 0] = mini.win.getContentSize()
      view.setBounds({ x: 0, y: 0, width, height })
      view.setBorderRadius(0)
    })
    contents.on('leave-html-full-screen', () => {
      const mini = miniOfTab(tabId)
      const view = tabs.get(tabId)
      if (!mini || !view || !mini.fullscreen) return
      mini.fullscreen = false
      view.setBounds(roundRect(cardRect(mini)))
      view.setBorderRadius(MINI_RADIUS)
    })
  })

  // Track the most recent main window; changed idle limits apply to open windows.
  store.subscribe((next, prev) => {
    for (const [id, w] of Object.entries(next.windows)) {
      if (w.kind === 'main' && w.focused && !prev.windows[id]?.focused) lastMain = id
    }
    if (next.settings.miniWindowArchiveAfterMs !== prev.settings.miniWindowArchiveAfterMs) {
      for (const mini of minis.values()) scheduleIdleClose(mini)
    }
  })

  // A hidden spare must never keep the app alive once the last main window is gone.
  app.on('browser-window-created', (_event, win) => {
    win.once('closed', () => {
      // After the window manager's own 'closed' handling, which runs later for main windows.
      setImmediate(() => {
        if (windows.ids().length === 0) dropSpare()
      })
    })
  })
  app.on('before-quit', (event) => {
    // Stopped by a feature that asks first (downloads in progress, DL-01): not quitting yet.
    if (event.defaultPrevented) return
    quitting = true
    dropSpare()
  })
  // A spare a moment after launch. Under the e2e harness only Mini Window tests ask for one
  // (mini.prepare): an extra renderer starting mid-test would skew every other test's timing.
  if (!ctx.e2e) spareSoon(1500)
  commands.register('mini.prepare', () => ensureSpare())

  // ⌘⌥N from any app, on macOS only (MW-06); elsewhere the shortcut works inside Orbit.
  const accel = systemWideShortcut(process.platform)
  if (accel && !ctx.e2e) {
    const electronAccel = toElectronAccelerator(accel)
    try {
      globalShortcut.register(electronAccel, () => {
        lastShortcutOpen = Date.now()
        open()
      })
    } catch {
      // Not available here (e.g. some Wayland compositors): the in-app shortcut still works.
    }
    app.on('will-quit', () => globalShortcut.unregister(electronAccel))
  }

  // Windows taskbar jump list: the same two entries (MW-08, MW-14). Each launches Orbit again with
  // a switch, which reaches the running app as a second instance.
  if (process.platform === 'win32') {
    const task = (args: string, title: string, description: string) => ({
      program: process.execPath,
      arguments: args,
      iconPath: process.execPath,
      iconIndex: 0,
      title,
      description,
    })
    app.setUserTasks([
      task(NEW_MINI_SWITCH, 'New Mini Window', 'Open a blank Mini Window for a quick lookup'),
      task(TOGGLE_MINIS_SWITCH, 'Show/Hide All Mini Windows', 'Show or hide every open Mini Window'),
    ])
  }
  const onSwitch = (argv: readonly string[]) => {
    const which = miniSwitchIn(argv)
    if (which === 'new') open()
    else if (which === 'toggle') toggleAll()
  }
  app.on('second-instance', (_event, argv) => onSwitch(argv))
  // Launched from the jump list while Orbit was not running.
  if (miniSwitchIn(process.argv)) setImmediate(() => onSwitch(process.argv))

  // macOS dock menu: a blank Mini Window, and show/hide them all (MW-08).
  if (isMac) {
    app.dock?.setMenu(
      Menu.buildFromTemplate([
        { label: 'New Mini Window', click: () => open() },
        { label: 'Show/Hide All Mini Windows', click: toggleAll },
      ]),
    )
  }
}

/** The tab a Mini Window shows (its WindowState's active tab). */
export function miniTabOf(state: OrbitState, windowId: WindowId): TabId | null {
  return activeTabOf(state, windowId)
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/$/, '')}${u.search}${u.hash}`
  } catch {
    return url
  }
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
