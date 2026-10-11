import type { BrowserWindow, WebContents } from 'electron'
import { ACTIONS_BY_ID, type ActionDef, priorityFor } from '../../shared/actions'
import type { ShortcutPriority } from '../../shared/commands/keys'
import type { WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import { AGAIN_MS } from '../keys/router'

/** Isolated world in which main asks a page to leave its own full screen (a video's). */
const FULLSCREEN_WORLD = 1030
/** How long main waits for a page to leave its own full screen before it goes on without it. */
const PAGE_EXIT_WAIT_MS = 1000

/** What one page's Esc presses did: what the page got, and what Orbit took. */
export interface EscapeMemory {
  /** When the last press the page got came (main's clock). */
  toPage?: number
  /** Who got the press held now: its release goes the same way. */
  down?: 'page' | 'orbit'
  /** The press held now left full screen: the rest of its repeats go nowhere. */
  left?: boolean
}

export interface EscapePress {
  type: 'down' | 'up'
  /** The keyboard's repeat of a held key. */
  repeat: boolean
  /** When it came (main's clock). */
  now: number
  /** The window is in full screen, and nothing takes Esc before the page (an overlay, a video's own full screen). */
  fullScreen: boolean
}

/** 'page': the page gets the key; 'exit': Orbit takes it and leaves full screen; 'swallow': Orbit takes it. */
export type EscapeVerdict = 'page' | 'exit' | 'swallow'

/**
 * Esc in a page while its window is in full screen (NV-20, KS-02). Pure: takes what the page's
 * presses did before and this press, and gives what to do and what to remember.
 * - Prefer websites (the default): the page gets the press, so a web app's own Esc never ends full
 *   screen. Pressing Esc again within AGAIN_MS of the press the page got, or holding it (its first
 *   repeat), leaves full screen, and the page doesn't get that press.
 * - Prefer Orbit: a press leaves full screen at once, and the page never gets it.
 * A press Orbit took is Orbit's to its release, and so are the repeats of a held press once it left
 * full screen.
 */
export function escapeInFullScreen(
  memory: EscapeMemory,
  press: EscapePress,
  priority: ShortcutPriority,
): { verdict: EscapeVerdict; memory: EscapeMemory } {
  if (press.type === 'up') {
    return { verdict: memory.down === 'orbit' ? 'swallow' : 'page', memory: { toPage: memory.toPage } }
  }
  if (press.repeat) {
    if (memory.left) return { verdict: 'swallow', memory }
    // Held: the page got the press, and its first repeat leaves. A press the page never saw (the
    // engine took it to end a video's full screen) leaves nothing more.
    if (press.fullScreen && memory.down === 'page') return { verdict: 'exit', memory: { ...memory, left: true } }
    return { verdict: 'page', memory }
  }
  if (!press.fullScreen) return { verdict: 'page', memory: { down: 'page' } }
  const again = memory.toPage !== undefined && press.now - memory.toPage <= AGAIN_MS
  if (priority === 'orbit' || again) return { verdict: 'exit', memory: { down: 'orbit', left: true } }
  return { verdict: 'page', memory: { toPage: press.now, down: 'page' } }
}

/** A plain Esc: no modifier held. */
const plainEscape = (input: Electron.Input) =>
  input.key === 'Escape' && !input.meta && !input.control && !input.alt && !input.shift

export interface FullScreen$ {
  /**
   * Esc pressed in `contents` (a tab's page, or Orbit's own view over one) of window `windowId`:
   * follows the full-screen rule, and takes the press from the page (`event.preventDefault()`)
   * when Orbit uses it.
   */
  onKey(windowId: WindowId | undefined, contents: WebContents, event: Electron.Event, input: Electron.Input): void
  info(windowId: WindowId): FullScreenInfo
}

/** A window's full screen as tests see it. */
export interface FullScreenInfo {
  /** The window is in full screen (the OS's, or one a page asked for). */
  fullScreen: boolean
  /** Orbit hid the window's sidebar for its full screen, and docks it again when that ends. */
  sidebarHidden: boolean
}

/**
 * Window full screen (NV-20): Toggle Full Screen (⌃⌘F; F11 and Alt+Shift+F elsewhere; the command
 * bar; View → Toggle Full Screen on macOS) and Exit Full Screen.
 *
 * In full screen the sidebar hides, and comes in over the page from the window's left edge (SB-12,
 * src/main/nav/sidebar-reveal.ts); the loading indicator stays (SB-28). Orbit docks the sidebar
 * again when full screen ends, unless the user chose meanwhile (⌘S). A page's own full screen (a
 * video's) is the page's: the sidebar is left as it is, and Esc there is Chromium's.
 *
 * Esc follows `escapeInFullScreen`, with the priority of Exit Full Screen (Settings → Shortcuts,
 * KS-02). Only a main or private window goes full screen this way; a Mini Window doesn't.
 */
export function registerFullScreen(ctx: MainContext): FullScreen$ {
  const { store, windows, tabs, actions } = ctx
  const exitAction = ACTIONS_BY_ID['window.exitFullScreen'] as ActionDef
  /** Windows whose sidebar Orbit hid for full screen. */
  const hiddenFor = new Set<WindowId>()
  /** Pages in their own full screen. */
  const inPageFullScreen = new Set<WebContents>()
  /** What each page's Esc presses did, by contents id. */
  const escapes = new Map<number, EscapeMemory>()

  const fullScreenWindow = (windowId: WindowId | undefined): BrowserWindow | undefined => {
    const win = windowId ? windows.get(windowId) : undefined
    const kind = windowId ? store.state.windows[windowId]?.kind : undefined
    return win && !win.isDestroyed() && (kind === 'main' || kind === 'private') ? win : undefined
  }

  /** The window's page in its own full screen, if one is. */
  const pageInFullScreen = (windowId: WindowId): WebContents | undefined => {
    for (const page of inPageFullScreen) {
      const tabId = page.isDestroyed() ? undefined : tabs.tabIdFor(page)
      if (tabId && windows.windowOfTab(tabId) === windowId) return page
    }
    return undefined
  }

  /** Asks a page to leave its own full screen; resolves once it has, or after PAGE_EXIT_WAIT_MS. */
  const exitPageFullScreen = (page: WebContents): Promise<unknown> =>
    Promise.race([
      page
        .executeJavaScriptInIsolatedWorld(FULLSCREEN_WORLD, [
          { code: 'document.fullscreenElement ? document.exitFullscreen().then(() => true, () => false) : false' },
        ])
        .catch(() => false),
      new Promise((resolve) => setTimeout(resolve, PAGE_EXIT_WAIT_MS)),
    ])

  /** Leaves full screen: a page's own first (it would stay over the window), then the window's. */
  const leave = async (windowId: WindowId) => {
    const page = pageInFullScreen(windowId)
    if (page) await exitPageFullScreen(page)
    const win = fullScreenWindow(windowId)
    if (win?.isFullScreen()) win.setFullScreen(false)
  }

  actions.register('window.toggleFullScreen', (c) => {
    // A held key toggles once.
    if (c.repeat) return
    const windowId = c.windowId ?? windows.focusedWindowId()
    const win = fullScreenWindow(windowId)
    if (!win || !windowId) return
    if (win.isFullScreen()) void leave(windowId)
    else win.setFullScreen(true)
  })
  actions.register('window.exitFullScreen', (c) => {
    const windowId = c.windowId ?? windows.focusedWindowId()
    if (windowId && fullScreenWindow(windowId)?.isFullScreen()) void leave(windowId)
  })

  // The sidebar in full screen.
  const setVisible = (windowId: WindowId, visible: boolean) =>
    store.update((d) => {
      const w = d.windows[windowId]
      if (!w || w.sidebar.visible === visible) return
      w.sidebar.visible = visible
      w.sidebar.peeking = false
    })
  const entered = (windowId: WindowId) => {
    const win = fullScreenWindow(windowId)
    // A page's own full screen (a video's) covers the window by itself: the sidebar stays as it is.
    if (!win?.isFullScreen() || windows.inHtmlFullscreen(windowId)) return
    if (!store.state.windows[windowId]?.sidebar.visible) return
    hiddenFor.add(windowId)
    setVisible(windowId, false)
  }
  const left = (windowId: WindowId) => {
    if (hiddenFor.delete(windowId)) setVisible(windowId, true)
  }
  windows.onWindowCreated((windowId, win) => {
    win.on('enter-full-screen', () => {
      // A page asking for full screen says so just after the window goes (Linux, Windows) or
      // before (macOS): look once both have.
      setImmediate(() => entered(windowId))
    })
    win.on('leave-full-screen', () => left(windowId))
    // A window closed in full screen keeps its sidebar for the next time it opens.
    win.once('closed', () => left(windowId))
  })
  // The user docked the sidebar in full screen (⌘S): theirs from now on.
  store.subscribe((next) => {
    for (const windowId of hiddenFor) if (next.windows[windowId]?.sidebar.visible !== false) hiddenFor.delete(windowId)
  })

  ctx.hooks.tabCreated.push((_tabId, contents) => {
    const { id } = contents
    contents.on('enter-html-full-screen', () => inPageFullScreen.add(contents))
    contents.on('leave-html-full-screen', () => inPageFullScreen.delete(contents))
    // Before the page's other Esc handling (stopping a load, NV-04), which skips a press taken here.
    contents.prependListener('before-input-event', (event: Electron.Event, input: Electron.Input) => {
      const tabId = tabs.tabIdFor(contents)
      onKey(tabId ? windows.windowOfTab(tabId) : undefined, contents, event, input)
    })
    contents.once('destroyed', () => {
      inPageFullScreen.delete(contents)
      escapes.delete(id)
    })
  })

  const onKey: FullScreen$['onKey'] = (windowId, contents, event, input) => {
    if (input.key !== 'Escape' || contents.isDestroyed()) return
    const type = input.type === 'keyDown' ? 'down' : input.type === 'keyUp' ? 'up' : undefined
    if (!type || (type === 'down' && !plainEscape(input))) return
    const win = fullScreenWindow(windowId)
    const w = windowId ? store.state.windows[windowId] : undefined
    // An open overlay (the command bar, a Peek) and a page's own full screen take Esc first (KS-19).
    const fullScreen =
      !!win?.isFullScreen() && !!windowId && w?.overlay.kind === 'none' && !windows.inHtmlFullscreen(windowId)
    const priority = priorityFor(exitAction, process.platform, store.state.settings.shortcutPriority)
    const memory = escapes.get(contents.id) ?? {}
    const next = escapeInFullScreen(memory, { type, repeat: input.isAutoRepeat, now: Date.now(), fullScreen }, priority)
    escapes.set(contents.id, next.memory)
    if (next.verdict === 'page') return
    event.preventDefault()
    if (next.verdict === 'exit' && windowId) void leave(windowId)
  }

  return {
    onKey,
    info: (windowId) => ({
      fullScreen: !!windows.get(windowId)?.isFullScreen(),
      sidebarHidden: hiddenFor.has(windowId),
    }),
  }
}
