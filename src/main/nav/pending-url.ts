import type { TabId } from '../../shared/state'
import type { MainContext } from '../context'

/** Chromium's net::ERR_ABORTED: a navigation that was replaced, or turned into a download. */
const ERR_ABORTED = -3

/** Addresses that load in the tab; others (mailto:, a custom app's scheme…) go to another app. */
const LOADS_IN_TAB = /^(https?|file):/i
const VIEW_SOURCE = /^view-source:/i

/**
 * The address while a page is on its way (NV-04), failed to load (NV-13) or shows a page's source.
 *
 * Where a navigation Orbit started is going, before it commits (an address typed in the command
 * bar, Back or Forward, Reload, a link Orbit opened in a new tab): the address display shows it at
 * once, as Chromium's address bar does, and keeps it when the user stops the load (Esc, ⌘., the
 * Stop button), so it can be tried again. A load that ends some other way without a page (a
 * download, an empty response, another app) puts the address back. A page's own navigations (its
 * links, its scripts) show only once they commit, so a page can never put an address it doesn't
 * have over its own content.
 *
 * An error page commits without `did-navigate`; the address then shows the address that failed,
 * so Reload tries it again. A page's source (View Page Source, NV-12) commits with the address of
 * the page it shows; the tab keeps its `view-source:` address, so it shows and reopens as source.
 */
export function registerPendingUrl(ctx: MainContext): { markStopped: (tabId: TabId) => void } {
  const { store } = ctx
  /** Tabs whose pending load the user stopped: their address stays where it was going. */
  const stopped = new Set<TabId>()

  const setPending = (tabId: TabId, url: string | undefined) => {
    if (store.state.tabs[tabId]?.pendingUrl === url) return
    store.update((d) => {
      const tab = d.tabs[tabId]
      if (!tab) return
      if (url === undefined) delete tab.pendingUrl
      else tab.pendingUrl = url
    })
  }

  ctx.hooks.tabCreated.push((tabId, contents) => {
    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return
      stopped.delete(tabId)
      // No initiating frame: Orbit started it (loadURL, history, reload), not the page.
      const fromOrbit = !details.initiator && LOADS_IN_TAB.test(details.url)
      setPending(tabId, fromOrbit ? details.url : undefined)
    })
    contents.on('did-navigate', () => setPending(tabId, undefined))
    contents.on('did-fail-provisional-load', (_event, code, _description, url, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED) return
      // An error page took the page's place.
      stopped.delete(tabId)
      store.update((d) => {
        const tab = d.tabs[tabId]
        if (!tab) return
        delete tab.pendingUrl
        if (url && tab.url !== url) tab.url = url
      })
    })
    contents.on('did-stop-loading', () => {
      // Stopped by the user: the address stays. Ended without a page any other way: it goes back.
      if (!stopped.has(tabId)) setPending(tabId, undefined)
    })
    contents.once('destroyed', () => {
      stopped.delete(tabId)
      setPending(tabId, undefined)
    })
  })

  ctx.hooks.tabNavigated.push((tabId, contents) => {
    const shown = contents.getURL()
    if (!VIEW_SOURCE.test(shown) || store.state.tabs[tabId]?.url === shown) return
    store.update((d) => {
      const tab = d.tabs[tabId]
      if (tab) tab.url = shown
    })
  })

  return {
    markStopped: (tabId) => {
      if (store.state.tabs[tabId]?.pendingUrl) stopped.add(tabId)
    },
  }
}
