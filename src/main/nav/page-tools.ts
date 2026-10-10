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
/** Keys typed for a find bar that never takes the keyboard are let go after this long (F4). */
const HOLD_MS = 5000
/** Keys other than text that are held for the find bar (F4): it acts on them as it would. */
const HELD_KEYS = new Set(['Backspace', 'Enter', 'Escape'])
/** A held Backspace, Enter or Escape typed into the find bar waits this long at most for its page to have it. */
const KEY_WAIT_MS = 1000
/**
 * A key named with a control character carries no text: Chromium names a key "\u0000" when its
 * keymap has no symbol for it yet, as for keys xdotool maps on the fly (round 3 fix check, F2).
 */
const CONTROL = /\p{Cc}/u
/** In the page tools' page: the next key up anywhere in it (a held key typed into the find bar). */
const WATCH_KEY_UP = `window.__orbitKeyUp = new Promise((resolve) => addEventListener('keyup', () => resolve(true), { once: true, capture: true })); 0`

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

/** A key typed for the find bar before its field had the keyboard (F4). */
interface HeldKey {
  key: string
  shift: boolean
}

/**
 * A window's find bar waiting for the keyboard, from ⌘F until its field says it has it (round 2
 * fix check, F4). Keys typed for it meanwhile are held, for HOLD_MS at most, then typed into it.
 * The bar takes the keyboard when it shows, held keys or not (round 3 fix check, F2). `nonce`: the
 * focus request the field must say it took, once the bar is in the window and has been given the
 * keyboard; null before then.
 */
interface HeldKeys {
  tabId: TabId
  nonce: number | null
  /** The keys held so far, in order; null once HOLD_MS has passed, when keys go where the keyboard is again. */
  keys: HeldKey[] | null
  timer?: NodeJS.Timeout
  /** The held keys are being typed into the field: keys typed meanwhile are held, and typed in their turn. */
  typing?: boolean
}

/** Where a window's page tools are after a refresh: in the window, waiting for their page to load, or out. */
type ToolsShown = 'placed' | 'loading' | 'hidden'

export interface PageToolsInfo {
  find: FindState
  zoom: ZoomIndicator | null
  /** The pointer is on the zoom indicator (it stays while it is). */
  hovered: boolean
  /** The page tools' page has loaded: they can go into the window. */
  ready: boolean
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

  /**
   * Shows, moves or hides a window's page tools to match what they hold. They go into the window
   * only once their page has loaded (round 2 fix check, M3): until then this says 'loading', and
   * the view's page hears what to show when it asks.
   */
  const refresh = (windowId: WindowId): ToolsShown => {
    if (!windows.get(windowId)) {
      clearTimeout(tools.get(windowId)?.zoomTimer)
      tools.delete(windowId)
      dropKeys(windowId)
      return 'hidden'
    }
    const t = tools.get(windowId)
    const find = findState(windowId)
    const zoom = t?.zoom ?? null
    const page = find.tabId ? windows.tabViewBounds(find.tabId) : undefined
    if (!(find.open || zoom) || !page || windows.inHtmlFullscreen(windowId)) {
      // Nothing is under the pointer once the view has gone.
      if (t) t.hovered = false
      windows.hideTools(windowId)
      return 'hidden'
    }
    const contents = windows.toolsContents(windowId)
    if (!contents) return 'hidden'
    watchKeys(windowId, contents)
    const state = toolsOf(windowId)
    const payload = { find, zoom }
    const json = JSON.stringify(payload)
    if (state.sent !== json) {
      state.sent = json
      contents.send('orbit:pageTools', payload)
    }
    return windows.showTools(windowId, toolsBounds(page, find.open, !!zoom)) ? 'placed' : 'loading'
  }

  // ---------- Keys typed before the find bar can take them (round 2 fix check, F4) ----------

  const held = new Map<WindowId, HeldKeys>()
  /** The page tools' web contents whose keys are watched. */
  const watched = new WeakSet<WebContents>()
  /** A held key is being pressed in the page tools: it isn't held again. */
  let pressing = false

  const dropKeys = (windowId: WindowId) => {
    clearTimeout(held.get(windowId)?.timer)
    held.delete(windowId)
  }

  /** Keys typed for the bar are held from now, for HOLD_MS at most: then they go where the keyboard is again. */
  const keepHolding = (h: HeldKeys) => {
    h.keys ??= []
    clearTimeout(h.timer)
    h.timer = setTimeout(() => {
      h.keys = null
    }, HOLD_MS)
  }

  /** The find bar of a window's tab waits for the keyboard (or goes on waiting), holding keys for it. */
  const holdKeys = (windowId: WindowId, tabId: TabId): HeldKeys => {
    let h = held.get(windowId)
    if (!h || h.tabId !== tabId) {
      dropKeys(windowId)
      h = { tabId, nonce: null, keys: [] }
      held.set(windowId, h)
    }
    keepHolding(h)
    return h
  }

  /**
   * Holds a key typed in the page or the page tools while the find bar waits for the keyboard:
   * text, Backspace, Enter and Escape, without ⌘ or Ctrl (shortcuts go on as ever). True when held.
   */
  const holdKey = (windowId: WindowId | undefined, tabId: TabId | null, input: Electron.Input): boolean => {
    const h = windowId ? held.get(windowId) : undefined
    if (pressing || !h?.keys || (tabId !== null && tabId !== h.tabId)) return false
    if (input.control || input.meta || input.isComposing) return false
    if (input.alt && process.platform !== 'darwin') return false
    const text = [...input.key].length === 1
    if (!text && !HELD_KEYS.has(input.key)) return false
    if (input.type === 'keyDown') h.keys.push({ key: input.key, shift: input.shift })
    return true
  }

  const watchKeys = (windowId: WindowId, contents: WebContents) => {
    if (watched.has(contents)) return
    watched.add(contents)
    contents.on('before-input-event', (event, input) => {
      if (holdKey(windowId, null, input)) event.preventDefault()
    })
  }

  /**
   * Presses a held Backspace, Enter or Escape in the page tools, and resolves once their page has
   * had it (its key up), or after KEY_WAIT_MS: text inserted next would otherwise overtake it.
   */
  const pressKey = async (contents: WebContents, { key, shift }: HeldKey) => {
    await contents.executeJavaScript(WATCH_KEY_UP)
    if (contents.isDestroyed()) return
    const modifiers: 'shift'[] = shift ? ['shift'] : []
    pressing = true
    try {
      contents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers })
      contents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers })
    } finally {
      pressing = false
    }
    await Promise.race([
      contents.executeJavaScript('window.__orbitKeyUp'),
      new Promise((resolve) => setTimeout(resolve, KEY_WAIT_MS)),
    ])
  }

  /**
   * Types held keys into the page tools' field, in order: text as text, so every character arrives
   * as typed (round 3 fix check, F2), and Backspace, Enter and Escape as keys. Escape closes the
   * bar, so what comes after it was typed for a bar that has gone.
   */
  const typeKeys = async (contents: WebContents, keys: HeldKey[]) => {
    let text = ''
    for (const key of keys) {
      if (!HELD_KEYS.has(key.key)) {
        if (!CONTROL.test(key.key)) text += key.key
        continue
      }
      if (text) await contents.insertText(text)
      text = ''
      if (contents.isDestroyed()) return
      await pressKey(contents, key)
      if (key.key === 'Escape') return
    }
    if (text && !contents.isDestroyed()) await contents.insertText(text)
  }

  /** Types the keys held for a window's find bar into its field, then stops holding them. */
  const typeHeld = async (windowId: WindowId, h: HeldKeys, contents: WebContents) => {
    h.typing = true
    keepHolding(h)
    try {
      for (let keys = h.keys; keys?.length && held.get(windowId) === h; keys = h.keys) {
        h.keys = []
        if (contents.isDestroyed()) break
        await typeKeys(contents, keys)
      }
    } catch {
      // The page tools' page went away with the keys.
    }
    if (held.get(windowId) === h) dropKeys(windowId)
  }

  /** The find bar is in the window: it takes the keyboard, and its field says when it has it (find.focused). */
  const giveBarKeyboard = (windowId: WindowId, h: HeldKeys, s: FindSession) => {
    h.nonce = s.focus
    windows.toolsContents(windowId)?.focus()
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

  /**
   * The find bar takes the keyboard, its text selected. Not before it is in the window (round 2 fix
   * check, M3): until then the page keeps the keyboard, and keys typed for the bar meanwhile are
   * held for it (F4).
   */
  const focusBar = (windowId: WindowId, tabId: TabId, s: FindSession) => {
    s.focus = ++focusNonce
    const shown = refresh(windowId)
    if (shown === 'hidden') return
    const h = holdKeys(windowId, tabId)
    if (shown === 'placed') giveBarKeyboard(windowId, h, s)
  }

  /**
   * Find acts on the window's page, not on one a Peek or the Library covers: while either is open,
   * ⌘F, ⌘G and F3 do nothing here and the keyboard stays where it is (review A-M3, fix check A M2;
   * finding in the Peek is PK-11's, the Library's ⌘F searches it).
   */
  const findable = (windowId: WindowId | undefined): windowId is WindowId =>
    !!windowId && !peekShown(store.state, windowId) && !windows.hasPageCover(windowId)

  /** ⌘F: the bar opens (or its text is selected again), starting from the page's selection or the tab's last search. */
  const openFind = (windowId: WindowId | undefined) => {
    const tabId = activeOf(windowId)
    const contents = pageOf(tabId)
    if (!findable(windowId) || !tabId || !contents) return
    const s = sessionOf(tabId)
    if (s.open) {
      focusBar(windowId, tabId, s)
      return
    }
    s.open = true
    clearMatches(s)
    if (s.query) search(contents, s, true)
    focusBar(windowId, tabId, s)
    // Selected text on the page starts a new search instead (asked after the bar is up, so no key is lost).
    const edits = s.edits
    contents
      .executeJavaScriptInIsolatedWorld(NAV_WORLD, [{ code: SELECTION }])
      .then((selected: unknown) => {
        const text = typeof selected === 'string' ? findTextFromSelection(selected) : ''
        if (!text || text === s.query || !s.open || s.edits !== edits || finds.get(tabId) !== s) return
        s.query = text
        search(contents, s, true)
        if (activeOf(windowId) === tabId) focusBar(windowId, tabId, s)
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
      focusBar(windowId, tabId, s)
      return
    }
    search(contents, s, !s.searched && s.request === 0, forward)
  }

  const closeFind = (windowId: WindowId | undefined) => {
    const tabId = activeOf(windowId)
    const s = tabId ? finds.get(tabId) : undefined
    if (!windowId || !tabId || !s?.open) return
    dropKeys(windowId)
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
  // The bar's field has the keyboard: the keys held for it are typed into it, in order (F4).
  commands.register('find.focused', ({ focus }, c) => {
    const windowId = windowOf(c)
    const h = windowId ? held.get(windowId) : undefined
    if (!windowId || !h || h.nonce === null || focus < h.nonce || h.typing) return
    const contents = windows.toolsContents(windowId)
    if (contents && h.keys?.length) void typeHeld(windowId, h, contents)
    else dropKeys(windowId)
  })
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
    t.zoomTimer = undefined
    // Its time starts once it is in the window: a new window's page tools may still be loading.
    if (refresh(windowId) === 'loading') return
    if (!t.hovered) t.zoomTimer = setTimeout(() => hideZoom(windowId), ZOOM_INDICATOR_MS)
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
    // Not the page under the Library: it would stay zoomed, and kept so for its site (fix check A, M2).
    if (windowId && tabId && !windows.hasPageCover(windowId)) zoom(windowId, tabId, direction)
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
    // Keys held for another tab's bar aren't for this one.
    if (held.get(windowId)?.tabId !== tabId) dropKeys(windowId)
    if (t?.zoom || (tabId && finds.get(tabId)?.open) || windows.toolsInfo(windowId).placed) refresh(windowId)
  })

  // The page tools' page has loaded, so they can go into the window (round 2 fix check, M3): the zoom
  // indicator shows for its full time from now, and a find bar waiting for the keyboard takes it,
  // whether or not keys are still held for it (round 3 fix check, F2).
  windows.onToolsReady((windowId) => {
    const t = tools.get(windowId)
    if (t?.zoom && !t.hovered) {
      clearTimeout(t.zoomTimer)
      t.zoomTimer = setTimeout(() => hideZoom(windowId), ZOOM_INDICATOR_MS)
    }
    const tabId = activeOf(windowId)
    const s = tabId ? finds.get(tabId) : undefined
    const h = held.get(windowId)
    if (!s?.open || h?.tabId !== tabId) {
      refresh(windowId)
      return
    }
    s.focus = ++focusNonce
    if (refresh(windowId) === 'placed') giveBarKeyboard(windowId, h, s)
  })

  ctx.hooks.tabCreated.push((tabId, contents) => {
    allowPinch(contents)
    // Keys typed for the find bar before it has the keyboard wait for it, not reach the page (F4).
    contents.on('before-input-event', (event, input) => {
      if (holdKey(windows.windowOfTab(tabId), tabId, input)) event.preventDefault()
    })
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
        ready: placed.ready,
        placed: placed.placed,
        bounds: placed.placed ? placed.bounds : undefined,
      }
    },
  }
}
