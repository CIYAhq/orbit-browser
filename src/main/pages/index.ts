import { app } from 'electron'
import { authDialog } from '../../shared/pages'
import type { TabId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import type { TabOps } from '../tabs/ops'
import { type PageDialogInfo, type PageDialogs$, registerDialogs } from './dialogs'
import { type FullScreenInfo, registerFullScreen } from './fullscreen'
import { type LeaveInfo, registerLeave } from './leave'
import { findSystemApp, findTestApp, launchInApp, registerOtherApps } from './other-apps'
import { LOAD_TIMEOUT_MS, type PageScreenInfo, registerScreens } from './screens'

/** Test-only handle (ORBIT_E2E=1): globalThis.__orbitPages. */
export interface PagesTestHooks {
  /** Every page's dialog on show or waiting to (the first of each page's). */
  dialogs: () => PageDialogInfo[]
  /** What Orbit knows of a tab's page about its leave-page warning. */
  leave: (tabId: TabId) => LeaveInfo | null
  /** Whether auto-archive and sleep may let a tab's page go (NV-24). */
  mayDiscard: (tabId: TabId) => boolean
  /** Every page's error or crash screen (NV-13, NV-14). */
  screens: () => PageScreenInfo[]
  /** Links Orbit opened in another app, oldest first (NV-19): test runs never start one. */
  launched: string[]
  /** A window's full screen (NV-20). */
  fullScreen: (windowId: WindowId) => FullScreenInfo
}

/**
 * The pages lane: what a page does beyond loading. Page dialogs (NV-24): a page's alert, confirm and
 * prompt, the leave-page warning and HTTP sign-in, in Orbit's own dialog over that page. Error and
 * crash screens (NV-13, NV-14): what the page's area shows when its page couldn't load, crashed or
 * stopped responding. Links that open other apps (NV-19): asked about over the page. Window full
 * screen (NV-20): the sidebar hidden, and Esc in the page.
 */
export function registerPages(ctx: MainContext, ops: TabOps): void {
  const dialogs = registerDialogs(ctx)
  const leave = registerLeave(ctx, ops, dialogs)
  registerSignIn(dialogs)
  // Tests give a navigation's first answer less time (ORBIT_E2E_LOAD_TIMEOUT_MS).
  const testTimeout = ctx.e2e ? Number(process.env.ORBIT_E2E_LOAD_TIMEOUT_MS) : Number.NaN
  const fullScreen = registerFullScreen(ctx)
  const screens = registerScreens(ctx, ops, dialogs, fullScreen, testTimeout > 0 ? testTimeout : LOAD_TIMEOUT_MS)
  // Test runs record each launch instead, and take the OS's apps from ORBIT_E2E_APPS.
  const launched: string[] = []
  registerOtherApps(
    ctx,
    dialogs,
    ctx.e2e
      ? {
          launch: async (url) => {
            launched.push(url)
          },
          findApp: findTestApp(process.env.ORBIT_E2E_APPS),
        }
      : { launch: launchInApp, findApp: findSystemApp },
  )

  if (ctx.e2e) {
    const hooks: PagesTestHooks = {
      dialogs: () => dialogs.info(),
      leave: (tabId) => {
        const page = ctx.tabs.contents(tabId)
        return page ? leave.info(page) : null
      },
      mayDiscard: (tabId) => leave.mayDiscard(tabId),
      screens: () => screens.info(),
      launched,
      fullScreen: (windowId) => fullScreen.info(windowId),
    }
    ;(globalThis as unknown as { __orbitPages: PagesTestHooks }).__orbitPages = hooks
  }
}

/**
 * HTTP sign-in (Basic and Digest, NV-24): a server or a proxy asks for a username and password, and
 * Orbit asks the user over the page that asked. Cancel (or the page going) sends none, and the page
 * gets the server's answer to that.
 */
function registerSignIn(dialogs: PageDialogs$): void {
  app.on('login', (event, page, details, authInfo, callback) => {
    // Without a page to ask over (a request of Orbit's own, a utility process): no sign-in.
    if (!page || page.isDestroyed() || !dialogs.hostable(page)) return
    event.preventDefault()
    void dialogs.open(page, authDialog(authInfo, details.url)).then((answer) => {
      try {
        if (answer?.ok) callback(answer.user ?? '', answer.password ?? '')
        else callback()
      } catch {
        // The request went meanwhile.
      }
    })
  })
}
