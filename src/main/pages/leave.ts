import { app, BrowserWindow, type WebContents } from 'electron'
import { leaveDialog } from '../../shared/pages'
import type { ArchivedTab, TabId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import type { CloseTabsOptions, TabOps } from '../tabs/ops'
import { isActivation } from '../tabs/runtime'
import type { PageDialogs$ } from './dialogs'

/** How long Orbit waits for a page to say whether it would warn: a busy page doesn't. */
export const PROBE_MS = 250
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
/** The page preload's own world, where it answers main (`__orbitLeave`, src/preload/page.ts). */
const PRELOAD_WORLD = 999

const PROBE = `typeof __orbitLeave === 'object' ? __orbitLeave.probe() : false`
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
  /** User gestures that reached the page: a page without one never warns (Chromium's rule). */
  gestures: number
  /** Main-frame documents so far. */
  doc: number
  /** The page warned in this document: auto-archive and sleep leave it alone. */
  warnedDoc?: number
  /** The last time Orbit asked whether the page would warn: the answer, and what it saw. */
  probed?: { gestures: number; doc: number; warns: boolean }
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
  gestures: number
  /** The page warned in its current document. */
  warned: boolean
  /** The page's next warning goes through (the user chose Leave). */
  allowed: boolean
}

export interface PageLeave {
  /** Whether Orbit may let a live tab's page go without asking: auto-archive and sleep (ops.mayDiscard). */
  mayDiscard(tabId: TabId): boolean
  /** Tests: what Orbit knows of a page. */
  info(page: WebContents): LeaveInfo | null
}

/**
 * The leave-page warning (NV-24): "Leave site? Changes you made may not be saved" when closing or
 * navigating away from a page that asks for it (`beforeunload`), in Orbit's own dialog over the page.
 *
 * - **Navigations.** The engine runs the page's `beforeunload`, and where Chromium would ask (the
 *   page has had a user gesture and cancels the event), Electron says so (`will-prevent-unload`) and
 *   stops the navigation unless told there and then to go on. So Orbit goes on only where the user
 *   just chose Leave; otherwise it asks, and on Leave starts the navigation again: one Orbit started
 *   (the address field, Back, Reload…) from here, one the page started (a link, a form, `location`,
 *   its own reload) from the page preload. A page's own Back and a frame's own navigation can't be
 *   started again: the user's next try within ALLOW_RETRY_MS goes through.
 * - **Closing a tab or a window.** The engine runs no `beforeunload` when Orbit closes a page, so
 *   Orbit asks the page (`__orbitLeave.probe()` in the preload's world) when it has had a gesture, and
 *   for each page that would warn shows its tab and asks there. Cancel keeps that tab (or the
 *   window). Quitting doesn't ask.
 * - **A pop-up's window.** Closing it runs the page's `beforeunload` as a navigation does.
 * - **Auto-archive and sleep** never discard a page that would warn: they leave it until the user
 *   closes it (`mayDiscard`).
 *
 * A page's own alert, confirm or prompt goes as soon as Orbit navigates the page: the page can't
 * answer its warning while it waits for one.
 */
export function registerLeave(ctx: MainContext, ops: TabOps, dialogs: PageDialogs$): PageLeave {
  const { store, tabs, windows } = ctx
  const pages = new Map<number, LeavePage>()
  /** Windows the user agreed to close (the next 'close' goes through). */
  const confirmedWindows = new Set<WindowId>()
  /** Windows and tabs Orbit is asking about now. */
  const guardingWindows = new Set<WindowId>()
  const guardingTabs = new Set<TabId>()

  const stateOf = (page: WebContents): LeavePage => {
    let p = pages.get(page.id)
    if (!p) {
      p = { gestures: 0, doc: 0, allowUntil: 0, closingUntil: 0 }
      pages.set(page.id, p)
    }
    return p
  }

  /** Whether a page could warn now: Chromium's warning needs a user gesture in the page first. */
  const mayWarn = (page: WebContents | undefined): page is WebContents =>
    !!page && !page.isDestroyed() && (pages.get(page.id)?.gestures ?? 0) > 0 && !dialogs.pending(page, 'script')

  /** Runs one of the preload's answers in its world; `fallback` when the page is gone or too busy. */
  const ask = <T>(page: WebContents, code: string, fallback: T, timeout = PROBE_MS): Promise<T> => {
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

  /** Whether the page would warn if it went now. */
  const probe = async (page: WebContents): Promise<boolean> => {
    if (!mayWarn(page)) return false
    const p = stateOf(page)
    const seen = { gestures: p.gestures, doc: p.doc }
    const warns = (await ask(page, PROBE, false)) === true
    p.probed = { ...seen, warns }
    if (warns) p.warnedDoc = seen.doc
    return warns
  }

  /** Puts a tab's page on screen, so its dialog shows: its window shows the tab. */
  const reveal = (tabId: TabId) => {
    if (store.state.tabs[tabId]?.floating || windows.tabViewBounds(tabId)) return
    const windowId = windows.windowOfTab(tabId) ?? windows.focusedWindowId() ?? windows.ids()[0]
    if (windowId) ops.activate(windowId, tabId)
  }

  /** "Leave site?" over a tab about to close: true to close it. */
  const askToClose = async (tabId: TabId): Promise<boolean> => {
    const page = tabs.contents(tabId)
    if (!page) return true
    reveal(tabId)
    const answer = await dialogs.open(page, leaveDialog(false))
    // The page went meanwhile: nothing is left to keep.
    if (!answer && page.isDestroyed()) return true
    return answer?.ok === true
  }

  // ---- Navigations ----

  /** A warning stopped a navigation (or a pop-up's close): asks, and on Leave goes on with it. */
  const askToLeave = async (page: WebContents, p: LeavePage, stopped: Stopped) => {
    if (p.asking) {
      // A later navigation stopped while asking: Leave goes on with that one.
      p.asking = stopped
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
    const p = stateOf(page)
    page.on('input-event', (_event, input) => {
      if (isActivation(input)) p.gestures++
    })
    page.on('did-start-navigation', (details) => {
      if (!details.isMainFrame) return
      // The navigation goes on: nothing is stopped, and a Leave was used or no longer needed.
      p.started = undefined
      p.allowUntil = 0
      // A page that goes takes its dialogs with it.
      if (!details.isSameDocument) dialogs.dismiss(page, 'all')
    })
    page.on('did-navigate', () => {
      p.doc++
    })
    page.on('will-prevent-unload', (event) => {
      if (windows.isUi(page)) return
      p.warnedDoc = p.doc
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

  /** Closes tabs once each page that would warn was asked about: Cancel keeps that tab. */
  const closeAsking = async (
    tabIds: TabId[],
    asking: TabId[],
    reason: ArchivedTab['reason'],
    opts: CloseTabsOptions,
  ) => {
    for (const id of asking) guardingTabs.add(id)
    const keep = new Set<TabId>()
    try {
      const warns = await Promise.all(asking.map((id) => probe(tabs.contents(id) as WebContents)))
      for (const [i, tabId] of asking.entries()) {
        if (warns[i] && store.state.tabs[tabId] && !(await askToClose(tabId))) keep.add(tabId)
      }
    } finally {
      for (const id of asking) guardingTabs.delete(id)
    }
    const closing = tabIds.filter((id) => !keep.has(id) && store.state.tabs[id])
    if (closing.length > 0) ops.closeTabs(closing, reason, { ...opts, confirmed: true })
  }

  ops.closeGuard = (tabIds, reason, opts) => {
    // Orbit's own closes (a private window's tabs, a download's empty tab) go: auto-archive asks mayDiscard.
    if (reason === 'auto') return false
    const ids = [...new Set(tabIds)]
    // Asked about already: that answer closes it.
    if (ids.some((id) => guardingTabs.has(id))) return true
    const asking = ids.filter((id) => mayWarn(tabs.contents(id)))
    if (asking.length === 0) return false
    void closeAsking(ids, asking, reason, opts)
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
        .filter((id) => windows.windowOfTab(id) === windowId && mayWarn(tabs.contents(id)))
      if (asking.length === 0) return
      event.preventDefault()
      if (guardingWindows.has(windowId)) return
      guardingWindows.add(windowId)
      void (async () => {
        try {
          const warns = await Promise.all(asking.map((id) => probe(tabs.contents(id) as WebContents)))
          for (const [i, tabId] of asking.entries()) {
            // Cancel keeps the window open.
            if (warns[i] && store.state.tabs[tabId] && !(await askToClose(tabId))) return
          }
          if (win.isDestroyed()) return
          confirmedWindows.add(windowId)
          win.close()
        } finally {
          guardingWindows.delete(windowId)
        }
      })()
    })
    win.once('closed', () => confirmedWindows.delete(windowId))
  })

  // ---- Auto-archive and sleep ----

  const service: PageLeave = {
    mayDiscard(tabId) {
      const page = tabs.contents(tabId)
      if (!page) return true
      // A page waiting on the user (its dialog, or a sign-in) waits for them.
      if (dialogs.pending(page, 'all')) return false
      if (!mayWarn(page)) return true
      const p = stateOf(page)
      // It warned in this document: it stays until the user closes it (NV-24).
      if (p.warnedDoc === p.doc) return false
      if (p.probed && p.probed.doc === p.doc && p.probed.gestures === p.gestures) return !p.probed.warns
      // Unknown since the page's last gesture: ask it now, and decide on the next pass.
      void probe(page)
      return false
    },
    info(page) {
      const p = pages.get(page.id)
      if (!p) return null
      return { gestures: p.gestures, warned: p.warnedDoc === p.doc, allowed: Date.now() <= p.allowUntil }
    },
  }
  ops.mayDiscard = (tabId) => service.mayDiscard(tabId)
  return service
}
