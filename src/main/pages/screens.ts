import {
  webContents as allContents,
  app,
  BrowserWindow,
  type IpcMainEvent,
  ipcMain,
  type Session,
  type WebContents,
} from 'electron'
import {
  crashScreen,
  errorScreen,
  hangDialog,
  type PageScreenAction,
  type PageScreenContent,
  screenSite,
  timeoutScreen,
} from '../../shared/pages'
import { PAGE_CHANNEL } from '../../shared/site'
import type { TabId } from '../../shared/state'
import type { MainContext } from '../context'
import type { TabOps } from '../tabs/ops'
import { type CoverInfo, createCovers } from './covers'
import type { PageDialogs$ } from './dialogs'
import type { FullScreen$ } from './fullscreen'

/**
 * A main-frame navigation that gets no answer from its server within this time is stopped and gets
 * the timeout screen. Chromium has no such limit (it waits for a server that never answers until
 * the user stops it); Orbit's is generous, so a slow server still gets its time.
 */
export const LOAD_TIMEOUT_MS = 120_000

/** Chromium's net::ERR_ABORTED: a navigation stopped or replaced, or turned into a download. */
const ERR_ABORTED = -3

/** What a page's row shows: its title and icon. */
interface RowLook {
  title: string
  favicon?: string
}

interface Screen {
  content: PageScreenContent
  /** The address it's for: what Try again loads. */
  url: string
  /**
   * Orbit's own time limit stopped the navigation: it never committed, so the page underneath is
   * the one before it, and Try again (or Reload) loads the address again rather than reloading.
   */
  timedOut: boolean
  /** The page had the keyboard when this happened (or nothing had): the screen takes it. */
  hadKeyboard: boolean
  /** What the page's row shows while the screen is up; none for a crash (the row keeps what it had). */
  row?: RowLook
  /** A timeout's: the screen the page showed when it timed out, which Back shows again. */
  under?: Screen
}

/** What Orbit knows of one page for its screens. */
interface PageState {
  screen?: Screen
  /** The address of the page's last document that loaded (not an error page). */
  committed?: string
  /**
   * The row when the page's last navigation started with no screen up: what an error on the site
   * it showed keeps, and what Back from a timeout puts back.
   */
  row?: RowLook
  /** The navigation being timed: where it goes, and the timer. */
  timing?: { url: string; timer: ReturnType<typeof setTimeout> }
  /** The page said it sends a form to this address (`PAGE_CHANNEL.formSent`): its navigation is next. */
  formTo?: string
  /** The navigation under way sends a form, so it isn't timed: it may be uploading. */
  sending?: boolean
  /** The address the network's return already retried once, until a page loads. */
  autoRetried?: string
  /** The last certificate error the page met: Proceed lets that certificate through for its host. */
  cert?: { host: string; fingerprint: string }
  /** "Page unresponsive" is open over the page. */
  hangOpen?: boolean
  /** The user chose Close page there: the crash screen says so. */
  closedHung?: boolean
}

export interface PageScreenInfo extends CoverInfo {
  id: number
  kind: PageScreenContent['kind']
  title: string
  message: string
  site: string
  code?: string
  /** The address Try again loads. */
  url: string
  timedOut: boolean
  tabId: TabId | null
}

export interface PageScreens {
  /** Tests: every page's screen. */
  info(): PageScreenInfo[]
}

/**
 * What a page's area shows when its page couldn't load (NV-13) or crashed (NV-14), in a view of
 * Orbit's over that page only (`createCovers`), as a page dialog is. The page stays where it was:
 * an error page keeps the address that failed (the engine's own error document is under the
 * screen, so Reload and Try again load it again, and Back leaves it), and a crashed page keeps its
 * tab and its row until it is reloaded.
 *
 * - **Load errors.** A main-frame navigation that fails shows a title, one plain sentence, the site
 *   and Try again (Chromium's wording, Orbit's look). The screen stays until a page loads, so a
 *   retry that fails again doesn't flash. The row keeps its title and icon when the site that
 *   failed is the one it showed; another site's failure shows that site's name instead (and its
 *   icon, if Orbit knows one).
 * - **Time limit.** A navigation with no answer within LOAD_TIMEOUT_MS is stopped and shows "took
 *   too long to respond"; the address stays, and Reload or Try again loads it again. Back shows
 *   the page as it was before, screen and row and all. A navigation that sends a form isn't timed:
 *   it may be a large upload (the page preload says so, `PAGE_CHANNEL.formSent`).
 * - **Certificates.** "Your connection is not private": Back to safety leads (goes back, or closes
 *   a tab with nowhere to go back to); Advanced, then Proceed, lets that certificate through for
 *   that host until Orbit quits (per profile).
 * - **Offline.** When the network comes back while an error screen shows, the page loads again,
 *   once (the screen's view hears the engine's `online` event).
 * - **Crashes.** "This page crashed" with Reload; ⌘R and ⌘⇧R reload as well.
 * - **Hangs.** A page that stops responding (`unresponsive`) gets "Page unresponsive" over it:
 *   Wait, or Close page, which ends the page's process (its crash screen says so). It goes by
 *   itself when the page responds again.
 */
export function registerScreens(
  ctx: MainContext,
  ops: TabOps,
  dialogs: PageDialogs$,
  fullScreen: FullScreen$,
  loadTimeout = LOAD_TIMEOUT_MS,
): PageScreens {
  const { store, tabs, commands } = ctx
  const states = new Map<number, { page: WebContents; state: PageState }>()
  let nextId = 1

  /** Whether nothing, or the page itself, has the keyboard. */
  const pageHasKeyboard = (page: WebContents, focused = allContents.getFocusedWebContents() ?? null) =>
    !focused || focused.isDestroyed() || focused === page

  const covers = createCovers(ctx, {
    view: 'screen',
    content: (page) => states.get(page.id)?.state.screen?.content,
    // A screen takes the keyboard only where the page would have it: not from the sidebar's field.
    mayTakeKeyboard: (page, focused) =>
      pageHasKeyboard(page, focused) || states.get(page.id)?.state.screen?.hadKeyboard === true,
    // In full screen, Esc on a screen leaves it as on a page: pressed twice, or held (NV-20).
    onKey: (page, view, event, input) => {
      const tabId = page.isDestroyed() ? undefined : tabs.tabIdFor(page)
      fullScreen.onKey(tabId ? ctx.windows.windowOfTab(tabId) : undefined, view, event, input)
    },
  })

  const stateOf = (page: WebContents): PageState => {
    let entry = states.get(page.id)
    if (!entry) {
      entry = { page, state: {} }
      states.set(page.id, entry)
    }
    return entry.state
  }

  type Tab = NonNullable<(typeof store.state.tabs)[TabId]>
  const tabOf = (page: WebContents): Tab | undefined => {
    const tabId = tabs.tabIdFor(page)
    return tabId ? store.state.tabs[tabId] : undefined
  }

  const setTab = (page: WebContents, change: (tab: Tab) => void) => {
    const tabId = tabs.tabIdFor(page)
    if (!tabId || !store.state.tabs[tabId]) return
    store.update((d) => {
      const tab = d.tabs[tabId]
      if (tab) change(tab)
    })
  }

  const rowOf = (page: WebContents): RowLook | undefined => {
    const tab = tabOf(page)
    return tab && { title: tab.title, ...(tab.favicon ? { favicon: tab.favicon } : {}) }
  }

  /** Puts a title and icon on the page's row (if it has one). */
  const showRow = (page: WebContents, row: RowLook) => {
    const tab = tabOf(page)
    if (!tab || (tab.title === row.title && tab.favicon === row.favicon)) return
    setTab(page, (t) => {
      t.title = row.title
      if (row.favicon) t.favicon = row.favicon
      else delete t.favicon
    })
  }

  // ---- Showing and clearing ----

  const show = (page: WebContents, content: Omit<PageScreenContent, 'id'>, url: string, timedOut: boolean) => {
    const st = stateOf(page)
    const before = st.screen
    const screen: Screen = { content: { ...content, id: nextId++ }, url, timedOut, hadKeyboard: pageHasKeyboard(page) }
    // A timeout leaves the page as it was, screen and all: Back shows that again.
    if (timedOut && before) screen.under = before.timedOut ? before.under : before
    // The row keeps the title and icon of the site it showed. Another site's failure is named by
    // its site (with its icon, if Orbit knows one), as the engine names its own error page by its
    // address.
    if (content.kind !== 'crash' && content.site) {
      const sameSite = screenSite(st.committed) === content.site
      const icon = tabs.faviconFor(url)
      screen.row = sameSite && st.row ? st.row : { title: content.site, ...(icon ? { favicon: icon } : {}) }
      showRow(page, screen.row)
    }
    st.screen = screen
    covers.update(page)
  }

  const clear = (page: WebContents) => {
    const st = states.get(page.id)?.state
    if (!st?.screen) return
    st.screen = undefined
    covers.update(page)
  }

  // ---- Orbit's time limit ----

  const stopTiming = (st: PageState) => {
    if (st.timing) clearTimeout(st.timing.timer)
    st.timing = undefined
  }

  const timedOut = (page: WebContents, url: string) => {
    const st = states.get(page.id)?.state
    if (!st || st.timing?.url !== url || page.isDestroyed() || !page.isLoading()) return
    st.timing = undefined
    // The screen first: stopping updates the tab's Back button, which the screen keeps on (Back
    // shows the page underneath).
    show(page, timeoutScreen(url), url, true)
    // The address stays where it was going (as when the user stops a load), so it can be tried again.
    page.once('did-stop-loading', () => {
      if (page.isDestroyed() || !stateOf(page).screen?.timedOut) return
      setTab(page, (tab) => {
        tab.pendingUrl = url
      })
    })
    page.stop()
  }

  const startTiming = (page: WebContents, url: string) => {
    const st = stateOf(page)
    stopTiming(st)
    if (st.sending || !/^https?:/i.test(url)) return
    st.timing = { url, timer: setTimeout(() => timedOut(page, url), loadTimeout) }
  }

  // ---- What the screen's buttons do ----

  /** Loads the screen's address again: a crashed or failed page reloads, a timed-out one loads its address. */
  const retry = (page: WebContents) => {
    const screen = states.get(page.id)?.state.screen
    if (!screen || page.isDestroyed()) return
    if (screen.timedOut) void page.loadURL(screen.url).catch(() => {})
    else page.reload()
  }

  /** Back to safety: back where the user came from; a tab with nowhere to go back to closes. */
  const back = (page: WebContents) => {
    if (page.navigationHistory.canGoBack()) {
      page.navigationHistory.goBack()
      return
    }
    const tabId = tabs.tabIdFor(page)
    if (tabId && !store.state.tabs[tabId]?.floating) {
      ops.closeTabs([tabId], 'closed')
      return
    }
    const win = BrowserWindow.fromWebContents(page)
    if (!tabId && win?.webContents === page) win.close()
    else void page.loadURL('about:blank').catch(() => {})
  }

  /** Certificates the user chose to go on with, by profile session: `<host>|<fingerprint>`. */
  const allowed = new WeakMap<Session, Set<string>>()

  const proceed = (page: WebContents) => {
    const st = states.get(page.id)?.state
    const screen = st?.screen
    if (!st || screen?.content.kind !== 'cert' || !screen.content.advanced?.proceedLabel || !st.cert) return
    if (st.cert.host !== hostOf(screen.url)) return
    const set = allowed.get(page.session) ?? new Set<string>()
    allowed.set(page.session, set)
    set.add(`${st.cert.host}|${st.cert.fingerprint}`)
    page.reload()
  }

  const act = (page: WebContents, action: PageScreenAction) => {
    const st = states.get(page.id)?.state
    const screen = st?.screen
    if (!st || !screen) return
    if (action === 'proceed') proceed(page)
    else if (action === 'back') back(page)
    else if (action === 'online') {
      // The network came back: an error page loads again, once (until a page loads).
      if (screen.content.kind === 'crash' || screen.content.kind === 'cert') return
      if (st.autoRetried === screen.url || page.isLoading()) return
      st.autoRetried = screen.url
      retry(page)
    } else retry(page)
  }

  // ---- Hangs ----

  const askHang = (page: WebContents) => {
    const st = stateOf(page)
    // A page waiting on its own dialog isn't hung: it waits for the user.
    if (st.hangOpen || dialogs.pending(page, 'script') || !covers.hostable(page)) return
    st.hangOpen = true
    void dialogs.open(page, hangDialog(page.getURL())).then((answer) => {
      st.hangOpen = false
      if (!answer || answer.ok || page.isDestroyed()) return
      st.closedHung = true
      page.forcefullyCrashRenderer()
    })
  }

  // ---- Watching pages ----

  /**
   * A timed-out page's Reload loads the address it was going to, and Back shows the page it was on
   * (the navigation never committed, so the page underneath is that page, with the screen it had if
   * it had one): Back is on while the screen shows, as it would be with an error page. (Wraps the
   * page's own methods, as leave.ts does.)
   */
  const wrapNavigation = (page: WebContents) => {
    const wrap = (target: object, name: string, instead: () => unknown) => {
      const original = (target as Record<string, unknown>)[name]
      if (typeof original !== 'function') return
      const replacement = function (this: unknown, ...args: unknown[]) {
        if (!page.isDestroyed() && states.get(page.id)?.state.screen?.timedOut) return instead()
        return Reflect.apply(original, this, args)
      }
      try {
        Object.defineProperty(target, name, { value: replacement, configurable: true, writable: true })
      } catch {
        // Not replaceable: Reload reloads the page underneath.
      }
    }
    const history = page.navigationHistory
    wrap(page, 'reload', () => retry(page))
    wrap(page, 'reloadIgnoringCache', () => retry(page))
    wrap(history, 'canGoBack', () => true)
    wrap(history, 'goBack', () => {
      const st = stateOf(page)
      stopTiming(st)
      // A retry still on its way stops: the page underneath is where Back leads.
      if (page.isLoading()) page.stop()
      // That page, with the screen it had if it had one, and its row as it was.
      const under = st.screen?.under
      const row = under ? under.row : st.row
      st.screen = under
      covers.update(page)
      if (row) showRow(page, row)
      setTab(page, (tab) => {
        delete tab.pendingUrl
        tab.canGoBack = history.canGoBack()
        tab.canGoForward = history.canGoForward()
      })
    })
  }

  const watched = new WeakSet<WebContents>()
  const watch = (page: WebContents, tab: boolean) => {
    if (watched.has(page)) return
    watched.add(page)
    page.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument || !covers.hostable(page)) return
      const st = stateOf(page)
      st.sending = st.formTo === details.url
      st.formTo = undefined
      if (!st.screen) st.row = rowOf(page)
      startTiming(page, details.url)
    })
    // The server answered: where it sends the page is timed afresh (a form's redirect isn't).
    page.on('did-redirect-navigation', (details) => {
      if (details.isMainFrame && states.has(page.id)) startTiming(page, details.url)
    })
    page.on('did-navigate', (_event, url) => {
      if (!covers.hostable(page)) return
      const st = stateOf(page)
      stopTiming(st)
      st.sending = false
      st.committed = url
      st.autoRetried = undefined
      st.closedHung = false
      clear(page)
    })
    page.on('did-fail-provisional-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || !covers.hostable(page)) return
      const st = stateOf(page)
      stopTiming(st)
      st.sending = false
      if (code === ERR_ABORTED) return
      show(page, errorScreen(code, description, url), url, false)
    })
    page.on('did-stop-loading', () => {
      const st = states.get(page.id)?.state
      if (!st) return
      stopTiming(st)
      st.sending = false
    })
    // The engine names an error page by nothing, and a page under a timeout may still rename
    // itself: while a screen is up, its row shows what the screen chose. (After the tab runtime's
    // own listener, which adds the title to the store.)
    page.on('page-title-updated', () => {
      const row = states.get(page.id)?.state.screen?.row
      if (row) showRow(page, row)
    })
    page.on('render-process-gone', (_event, details) => {
      if (!covers.hostable(page)) return
      const st = stateOf(page)
      stopTiming(st)
      if (details.reason === 'clean-exit') return
      dialogs.dismiss(page, 'all')
      const url = page.getURL()
      show(page, crashScreen(st.closedHung ? 'hung' : details.reason, url), url, false)
    })
    page.on('unresponsive', () => askHang(page))
    page.on('responsive', () => dialogs.dismiss(page, 'hang'))
    page.once('destroyed', () => {
      const st = states.get(page.id)?.state
      if (st) stopTiming(st)
      states.delete(page.id)
    })
    if (tab) wrapNavigation(page)
  }

  // The page is about to send a form: its navigation isn't timed (it may be a large upload).
  ipcMain.on(PAGE_CHANNEL.formSent, (event: IpcMainEvent, url: unknown) => {
    if (typeof url !== 'string') return
    const page = event.sender
    try {
      const frame = event.senderFrame
      if (!frame || page.isDestroyed() || frame.frameTreeNodeId !== page.mainFrame.frameTreeNodeId) return
    } catch {
      // A frame or page that went away while the message was on its way.
      return
    }
    if (!watched.has(page) || !covers.hostable(page)) return
    const st = stateOf(page)
    // Its navigation started first: it isn't timed from now on.
    if (st.timing?.url === url) {
      stopTiming(st)
      st.sending = true
    } else st.formTo = url
  })

  ctx.hooks.tabCreated.push((_tabId, page) => watch(page, true))
  // A pop-up's page is its window's own.
  app.on('browser-window-created', (_event, win) => watch(win.webContents, false))

  // A certificate the user chose to go on with goes through for its host; any other is refused,
  // and the page's error screen offers the choice.
  app.on('certificate-error', (event, page, url, _error, certificate, callback, isMainFrame) => {
    const host = hostOf(url)
    if (isMainFrame && covers.hostable(page)) stateOf(page).cert = { host, fingerprint: certificate.fingerprint }
    if (allowed.get(page.session)?.has(`${host}|${certificate.fingerprint}`)) {
      event.preventDefault()
      callback(true)
    }
  })

  commands.register('pages.screenContent', (_args, c) => {
    if (!c.sender) return null
    return covers.shownBy(c.sender)?.content ?? null
  })

  commands.register('pages.screenAction', (args, c) => {
    const shown = c.sender ? covers.shownBy(c.sender) : undefined
    if (!shown || shown.content.id !== args.id) return
    act(shown.page, args.action)
  })

  return {
    info() {
      return [...states.values()].flatMap(({ page, state }) => {
        const screen = state.screen
        if (!screen || page.isDestroyed()) return []
        const { content } = screen
        return [
          {
            id: content.id,
            kind: content.kind,
            title: content.title,
            message: content.message,
            site: content.site,
            ...(content.code ? { code: content.code } : {}),
            url: screen.url,
            timedOut: screen.timedOut,
            tabId: tabs.tabIdFor(page) ?? null,
            ...covers.info(page),
          },
        ]
      })
    },
  }
}

/** A URL's host with its port, or "". */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}
