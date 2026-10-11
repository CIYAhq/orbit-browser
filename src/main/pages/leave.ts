import { app, BrowserWindow, type WebContents } from 'electron'
import { leaveDialog } from '../../shared/pages'
import type { ArchivedTab, TabId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import type { CloseTabsOptions, TabOps } from '../tabs/ops'
import type { PageDialogs$ } from './dialogs'
import { gestureCount, watchGestures } from './gestures'

/** How long Orbit waits for the page preload to say which navigation a warning stopped. */
const ASK_MS = 250
/** After Leave, the warning of the navigation Orbit starts again goes through within this time. */
const ALLOW_MS = 5_000
/**
 * After Leave on a navigation the page started and Orbit can't start again (a page's own Back, a
 * frame's own navigation), the user's next try goes through within this time.
 */
const ALLOW_RETRY_MS = 10_000
/** A navigation Orbit started is the one a warning stopped, within this time. */
const STARTED_MS = 10_000
/** A pop-up's window began closing: its page's warning comes within this time. */
const CLOSING_MS = 5_000
/** A window whose pages went is closing: its tabs are asleep once it has, or after this time. */
const WINDOW_CLOSE_MS = 2_000
/** The page preload's own world, where it answers main (`__orbitLeave`, src/preload/page.ts). */
const PRELOAD_WORLD = 999

const STOPPED = `typeof __orbitLeave === 'object' ? __orbitLeave.stopped() : ''`
const REDO = `typeof __orbitLeave === 'object' ? __orbitLeave.redo() : false`

/** A navigation Orbit started (the address field, Back, Reload…), to start again on Leave. */
interface Started {
  redo: () => void
  reload: boolean
  until: number
}

type Stopped = Started | 'page' | 'close'

/** What Orbit knows of one page about its leave-page warning. */
interface LeavePage {
  /**
   * The page's gesture count (`gestureCount`, D77) when its current document began: a document
   * that no gesture has reached, in any of its frames, never warns (Chromium's rule), so Orbit
   * closes it without asking the engine.
   */
  since: number
  /** Main-frame documents so far. */
  doc: number
  /**
   * Auto-archive or sleep tried to let the page go, and it warned: they leave it until it navigates
   * or gets a new user gesture (D73). `gestures`: its gesture count then.
   */
  refused?: { doc: number; gestures: number }
  /** The user chose Leave: the page's next warning goes through until then. */
  allowUntil: number
  /** The navigation Orbit started last, until it starts or a warning stops it. */
  started?: Started
  /** A pop-up's window is closing (its 'close' came; the warning comes after it). */
  closingUntil: number
  /** "Leave site?" is open over the page, for this stopped navigation or close. */
  asking?: Stopped
}

export interface LeaveInfo {
  /** User gestures in the page's current document, from any of its frames. */
  gestures: number
  /** Auto-archive and sleep found the page warning, and leave it until it navigates or gets a new gesture. */
  refused: boolean
  /** The page's next warning goes through (the user chose Leave). */
  allowed: boolean
}

export interface PageLeave {
  /** Whether auto-archive and sleep may try to let a live tab's page go (ops.mayDiscard). */
  mayDiscard(tabId: TabId): boolean
  /** Tests: what Orbit knows of a page. */
  info(page: WebContents): LeaveInfo | null
}

/**
 * The leave-page warning (NV-24): "Leave site? Changes you made may not be saved" when closing or
 * navigating away from a page that asks for it (`beforeunload`), in Orbit's own dialog over the page.
 *
 * - **Navigations.** The engine runs the `beforeunload` of every frame, and where Chromium would ask
 *   (a frame that has had a user gesture cancels the event), Electron says so (`will-prevent-unload`)
 *   and stops the navigation unless told there and then to go on. So Orbit goes on only where the
 *   user just chose Leave; otherwise it asks, and on Leave starts the navigation again: one Orbit
 *   started (the address field, Back, Reload…) from here, one the page started (a link, a form,
 *   `location`, its own reload) from the page preload. A page's own Back and a frame's own
 *   navigation can't be started again: the user's next try within ALLOW_RETRY_MS goes through.
 * - **Closing a tab, a window or a Space** closes each page through the engine (D73): every frame's
 *   `beforeunload` runs, as when Chromium closes a tab, and a page that warns stays. Orbit shows its
 *   tab and asks there; Leave closes it, Cancel keeps that tab (or the window, or the Space). A page
 *   without a user gesture in its document closes at once: it can't warn (the engine itself would
 *   let its main frame warn on a close). Quitting doesn't ask.
 * - **A pop-up's window.** Closing it runs the page's `beforeunload` as a navigation does.
 * - **Auto-archive and sleep** let a page go the same way (D73), and keep it, without asking, when
 *   the engine says it warned; they leave it until it navigates or gets a new user gesture.
 *
 * Orbit runs no page's `beforeunload` of its own: only the engine does, once a close, an archive or
 * a sleep has started. A page's own alert, confirm or prompt goes as soon as Orbit navigates the
 * page: the page can't answer its warning while it waits for one.
 */
export function registerLeave(ctx: MainContext, ops: TabOps, dialogs: PageDialogs$): PageLeave {
  const { store, tabs, windows } = ctx
  const pages = new Map<number, LeavePage>()
  /** Windows the user agreed to close (the next 'close' goes through). */
  const confirmedWindows = new Set<WindowId>()
  /** Windows and tabs Orbit is letting go now. */
  const guardingWindows = new Set<WindowId>()
  const guardingTabs = new Set<TabId>()

  const stateOf = (page: WebContents): LeavePage => {
    let p = pages.get(page.id)
    if (!p) {
      p = { since: gestureCount(page), doc: 0, allowUntil: 0, closingUntil: 0 }
      pages.set(page.id, p)
    }
    return p
  }

  /** User gestures in the page's current document, from any of its frames (D77). */
  const gesturesIn = (page: WebContents, p: LeavePage | undefined): number => (p ? gestureCount(page) - p.since : 0)

  /**
   * Whether a page could warn now: Chromium's warning needs a user gesture in the page first, and a
   * page waiting on its own alert, confirm or prompt goes with it.
   */
  const mayWarn = (page: WebContents | undefined): page is WebContents =>
    !!page && !page.isDestroyed() && gesturesIn(page, pages.get(page.id)) > 0 && !dialogs.pending(page, 'script')

  const isRefused = (page: WebContents, p: LeavePage | undefined): boolean =>
    !!p?.refused && p.refused.doc === p.doc && p.refused.gestures === gestureCount(page)

  /** Runs one of the preload's answers in its world; `fallback` when the page is gone or too busy. */
  const ask = <T>(page: WebContents, code: string, fallback: T, timeout = ASK_MS): Promise<T> => {
    if (page.isDestroyed()) return Promise.resolve(fallback)
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => resolve(fallback), timeout)
      page.executeJavaScriptInIsolatedWorld(PRELOAD_WORLD, [{ code }]).then(
        (value: unknown) => {
          clearTimeout(timer)
          resolve(value as T)
        },
        () => {
          clearTimeout(timer)
          resolve(fallback)
        },
      )
    })
  }

  /** Closes a tab's page through the engine (D73): true once it's gone, false if a frame warned. */
  const unload = (tabId: TabId): Promise<boolean> => new Promise((resolve) => tabs.unload(tabId, resolve))

  /** Puts a tab's page on screen, so its dialog shows: its window shows the tab. */
  const reveal = (tabId: TabId) => {
    if (store.state.tabs[tabId]?.floating || windows.tabViewBounds(tabId)) return
    const windowId = windows.windowOfTab(tabId) ?? windows.focusedWindowId() ?? windows.ids()[0]
    if (windowId) ops.activate(windowId, tabId)
  }

  /** "Leave site?" over a tab whose page stayed when Orbit closed it: true to close it. */
  const askToClose = async (tabId: TabId): Promise<boolean> => {
    const page = tabs.contents(tabId)
    if (!page) return true
    reveal(tabId)
    const answer = await dialogs.open(page, leaveDialog(false))
    // The page went meanwhile: nothing is left to keep.
    if (!answer && page.isDestroyed()) return true
    return answer?.ok === true
  }

  /**
   * Lets tabs' pages go through the engine, all at once, and asks over each that stayed, one at a
   * time (D73): false as soon as the user keeps one (Cancel). The pages that went are in `gone`:
   * their tabs are the caller's to close or put to sleep.
   */
  const letGo = async (tabIds: TabId[], gone: TabId[]): Promise<boolean> => {
    const went = await Promise.all(tabIds.map(unload))
    for (const [i, tabId] of tabIds.entries()) if (went[i]) gone.push(tabId)
    for (const [i, tabId] of tabIds.entries()) {
      if (went[i] || !store.state.tabs[tabId]) continue
      if (!(await askToClose(tabId))) return false
    }
    return true
  }

  /** Auto-archive or sleep found the page warning: not again until it navigates or gets a new gesture. */
  const refuse = (tabId: TabId) => {
    const page = tabs.contents(tabId)
    if (!page) return
    const p = stateOf(page)
    p.refused = { doc: p.doc, gestures: gestureCount(page) }
  }

  // ---- Navigations ----

  /** A warning stopped a navigation (or a pop-up's close): asks, and on Leave goes on with it. */
  const askToLeave = async (page: WebContents, p: LeavePage, stopped: Stopped) => {
    if (p.asking) {
      // A later navigation stopped while asking: Leave goes on with that one (the page's own: the
      // preload notes which, as it does when asked).
      p.asking = stopped
      if (stopped === 'page') void ask(page, STOPPED, '')
      return
    }
    p.asking = stopped
    try {
      const reload =
        stopped === 'page' ? (await ask(page, STOPPED, '')) === 'reload' : stopped !== 'close' && stopped.reload
      if (page.isDestroyed()) return
      const answer = await dialogs.open(page, leaveDialog(reload))
      const now = p.asking
      if (!answer?.ok || !now || page.isDestroyed()) return
      p.allowUntil = Date.now() + (now === 'page' ? ALLOW_RETRY_MS : ALLOW_MS)
      if (now === 'close') BrowserWindow.fromWebContents(page)?.close()
      else if (now === 'page') void ask(page, REDO, false, ALLOW_MS)
      else now.redo()
    } finally {
      p.asking = undefined
    }
  }

  /**
   * Navigations Orbit starts in a tab: the page's own alert, confirm or prompt goes first (it can't
   * answer its warning while it waits), and the navigation is noted, to start it again on Leave.
   */
  const watchNavigations = (page: WebContents, p: LeavePage) => {
    const wrap = (target: object, name: string, reload: boolean, navigates: (args: unknown[]) => boolean) => {
      const original = (target as Record<string, unknown>)[name]
      if (typeof original !== 'function') return
      const replacement = function (this: unknown, ...args: unknown[]) {
        if (!page.isDestroyed() && navigates(args)) {
          dialogs.dismiss(page, 'script')
          p.started = {
            reload,
            until: Date.now() + STARTED_MS,
            redo: () => {
              const result: unknown = Reflect.apply(original, target, args)
              // A load a warning stops again is ERR_ABORTED: its failure is the page's to show.
              if (result instanceof Promise) result.catch(() => {})
            },
          }
        }
        return Reflect.apply(original, this, args)
      }
      try {
        Object.defineProperty(target, name, { value: replacement, configurable: true, writable: true })
      } catch {
        // Not replaceable: a dialog still goes when the navigation starts, and Leave lets the next try through.
      }
    }
    const always = () => true
    wrap(page, 'loadURL', false, always)
    wrap(page, 'reload', true, always)
    wrap(page, 'reloadIgnoringCache', true, always)
    const history = page.navigationHistory
    const moves = (offset: number) => offset !== 0 && history.canGoToOffset(offset)
    wrap(history, 'goBack', false, () => history.canGoBack())
    wrap(history, 'goForward', false, () => history.canGoForward())
    wrap(history, 'goToOffset', false, ([offset]) => typeof offset === 'number' && moves(offset))
    wrap(history, 'goToIndex', false, ([index]) => typeof index === 'number' && moves(index - history.getActiveIndex()))
  }

  /** Watches a page's gestures, navigations and warnings: a tab's or a pop-up's. */
  const watched = new WeakSet<WebContents>()
  const watch = (page: WebContents, kind: 'tab' | 'popup') => {
    if (watched.has(page)) return
    watched.add(page)
    // A press in any of its frames counts (D77): an embedded editor is often another site's.
    watchGestures(page)
    const p = stateOf(page)
    page.on('did-start-navigation', (details) => {
      if (!details.isMainFrame) return
      // The navigation goes on: nothing is stopped, and a Leave was used or no longer needed.
      p.started = undefined
      p.allowUntil = 0
      // A page that goes takes its dialogs with it.
      if (!details.isSameDocument) dialogs.dismiss(page, 'all')
    })
    page.on('did-navigate', () => {
      // A new document: no gesture has reached it yet.
      p.doc++
      p.since = gestureCount(page)
    })
    page.on('will-prevent-unload', (event) => {
      if (windows.isUi(page)) return
      // A close Orbit started through the engine (D73): the page stays, and that close asks (or,
      // for auto-archive and sleep, leaves it).
      const tabId = tabs.tabIdFor(page)
      if (tabId && tabs.isUnloading(tabId)) {
        tabs.kept(tabId)
        return
      }
      const now = Date.now()
      if (now <= p.allowUntil) {
        p.allowUntil = 0
        event.preventDefault()
        return
      }
      const started = p.started && now <= p.started.until ? p.started : undefined
      p.started = undefined
      const closing = now <= p.closingUntil
      p.closingUntil = 0
      void askToLeave(page, p, closing ? 'close' : (started ?? 'page'))
    })
    if (kind === 'tab') watchNavigations(page, p)
    page.once('destroyed', () => pages.delete(page.id))
  }

  ctx.hooks.tabCreated.push((_tabId, page) => watch(page, 'tab'))

  // A pop-up's page is its window's own: closing the window runs its `beforeunload`.
  app.on('browser-window-created', (_event, win) => {
    const page = win.webContents
    watch(page, 'popup')
    win.on('close', () => {
      if (!page.isDestroyed() && !windows.isUi(page) && !tabs.tabIdFor(page)) {
        stateOf(page).closingUntil = Date.now() + CLOSING_MS
      }
    })
  })

  // ---- Closing tabs ----

  /**
   * Closes tabs once each page that may warn was let go through the engine: one that warns stays,
   * and Orbit asks over it (Cancel keeps that tab), or, for auto-archive, keeps it without asking.
   */
  const closeAsking = async (
    tabIds: TabId[],
    asking: TabId[],
    reason: ArchivedTab['reason'],
    opts: CloseTabsOptions,
  ) => {
    for (const id of asking) guardingTabs.add(id)
    const keep = new Set<TabId>()
    try {
      const went = await Promise.all(asking.map(unload))
      for (const [i, tabId] of asking.entries()) {
        if (went[i] || !store.state.tabs[tabId]) continue
        if (opts.idle) {
          refuse(tabId)
          keep.add(tabId)
        } else if (!(await askToClose(tabId))) keep.add(tabId)
      }
    } finally {
      for (const id of asking) guardingTabs.delete(id)
    }
    if (windows.quitting) return
    const closing = tabIds.filter((id) => !keep.has(id) && store.state.tabs[id])
    if (closing.length > 0) ops.closeTabs(closing, reason, { ...opts, confirmed: true })
  }

  ops.closeGuard = (tabIds, reason, opts) => {
    // Orbit's own closes (a private window's tabs, a download's empty tab) go; auto-archive (`idle`)
    // lets its pages go through the engine.
    if (reason === 'auto' && !opts.idle) return false
    const ids = [...new Set(tabIds)]
    // Being let go already: that answer closes it.
    if (ids.some((id) => guardingTabs.has(id))) return true
    const asking = ids.filter((id) => mayWarn(tabs.contents(id)))
    if (asking.length === 0) return false
    void closeAsking(ids, asking, reason, opts)
    return true
  }

  // ---- Auto-sleep ----

  ops.sleepGuard = (tabId) => {
    if (guardingTabs.has(tabId)) return true
    if (!mayWarn(tabs.contents(tabId))) return false
    guardingTabs.add(tabId)
    void unload(tabId).then((gone) => {
      guardingTabs.delete(tabId)
      if (windows.quitting) return
      if (gone) tabs.sleep(tabId)
      else refuse(tabId)
    })
    return true
  }

  // ---- Closing a window ----

  windows.onWindowCreated((windowId, win) => {
    win.on('close', (event) => {
      // Quitting doesn't ask; another guard asking first (downloads in progress) goes first.
      if (windows.quitting || event.defaultPrevented) return
      if (confirmedWindows.delete(windowId)) return
      const asking = tabs
        .liveTabIds()
        .filter((id) => windows.windowOfTab(id) === windowId && !guardingTabs.has(id) && mayWarn(tabs.contents(id)))
      if (asking.length === 0) return
      event.preventDefault()
      if (guardingWindows.has(windowId)) return
      guardingWindows.add(windowId)
      void (async () => {
        const gone: TabId[] = []
        let closes = false
        for (const id of asking) guardingTabs.add(id)
        try {
          closes = await letGo(asking, gone)
        } finally {
          for (const id of asking) guardingTabs.delete(id)
          guardingWindows.delete(windowId)
        }
        if (windows.quitting) return
        const sleep = () => {
          for (const id of gone) tabs.sleep(id)
        }
        // Cancel keeps the window: the pages that went are asleep, and show again when their tab does.
        if (!closes || win.isDestroyed()) {
          sleep()
          return
        }
        // Their tabs sleep once the window has gone (before, the window would load them again), or
        // if it stays (another guard kept it).
        const timer = setTimeout(sleep, WINDOW_CLOSE_MS)
        win.once('closed', () => {
          clearTimeout(timer)
          sleep()
        })
        confirmedWindows.add(windowId)
        win.close()
      })()
    })
    win.once('closed', () => confirmedWindows.delete(windowId))
  })

  // ---- Deleting a Space ----

  tabs.letGo = async (tabIds) => {
    const asking = [...new Set(tabIds)].filter((id) => !guardingTabs.has(id) && mayWarn(tabs.contents(id)))
    if (asking.length === 0) return true
    const gone: TabId[] = []
    for (const id of asking) guardingTabs.add(id)
    try {
      const goes = await letGo(asking, gone)
      // Cancel keeps the Space: the pages that went are asleep.
      if (!goes) for (const id of gone) tabs.sleep(id)
      return goes && !windows.quitting
    } finally {
      for (const id of asking) guardingTabs.delete(id)
    }
  }

  // ---- Auto-archive and sleep ----

  const service: PageLeave = {
    mayDiscard(tabId) {
      const page = tabs.contents(tabId)
      if (!page) return true
      // A page waiting on the user (its dialog, or a sign-in) waits for them.
      if (dialogs.pending(page, 'all')) return false
      // Being let go already, or it warned when last tried (D73).
      return !guardingTabs.has(tabId) && !isRefused(page, pages.get(page.id))
    },
    info(page) {
      const p = pages.get(page.id)
      if (!p) return null
      return { gestures: gesturesIn(page, p), refused: isRefused(page, p), allowed: Date.now() <= p.allowUntil }
    },
  }
  ops.mayDiscard = (tabId) => service.mayDiscard(tabId)
  return service
}
