import { app } from 'electron'
import { authDialog } from '../../shared/pages'
import type { TabId } from '../../shared/state'
import type { MainContext } from '../context'
import type { TabOps } from '../tabs/ops'
import { type PageDialogInfo, type PageDialogs$, registerDialogs } from './dialogs'
import { type LeaveInfo, registerLeave } from './leave'

/** Test-only handle (ORBIT_E2E=1): globalThis.__orbitPages. */
export interface PagesTestHooks {
  /** Every page's dialog on show or waiting to (the first of each page's). */
  dialogs: () => PageDialogInfo[]
  /** What Orbit knows of a tab's page about its leave-page warning. */
  leave: (tabId: TabId) => LeaveInfo | null
  /** Whether auto-archive and sleep may let a tab's page go (NV-24). */
  mayDiscard: (tabId: TabId) => boolean
}

/**
 * The pages lane: what a page does beyond loading. Page dialogs (NV-24): a page's alert, confirm and
 * prompt, the leave-page warning and HTTP sign-in, in Orbit's own dialog over that page.
 */
export function registerPages(ctx: MainContext, ops: TabOps): void {
  const dialogs = registerDialogs(ctx)
  const leave = registerLeave(ctx, ops, dialogs)
  registerSignIn(dialogs)

  if (ctx.e2e) {
    const hooks: PagesTestHooks = {
      dialogs: () => dialogs.info(),
      leave: (tabId) => {
        const page = ctx.tabs.contents(tabId)
        return page ? leave.info(page) : null
      },
      mayDiscard: (tabId) => leave.mayDiscard(tabId),
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
