import { clipboard, type WebContents } from 'electron'
import { sameZoom, zoomPercent, zoomStep } from '../../shared/nav'
import type { Rect } from '../../shared/rpc'
import type { TabId, WindowId } from '../../shared/state'
import { cleanUrl, markdownLink } from '../../shared/tabs'
import { fallbackTitle } from '../../shared/url'
import { runDevtoolsAction } from '../devtools/control'
import { printPage, savePage, viewSource } from '../pages/entry'

/** Zooms a page one step in (1) or out (-1), or back to 100% (0), and returns its new zoom factor. */
export type PageZoom = (contents: WebContents, direction: 1 | -1 | 0) => number

/** Chromium's zoom steps (NV-06), until page zoom puts in its own, which also remembers the site's zoom. */
let pageZoom: PageZoom = (contents, direction) => {
  const before = contents.getZoomFactor()
  const next = direction === 0 ? 1 : zoomStep(before, direction)
  if (!sameZoom(before, next)) contents.setZoomFactor(next)
  return next
}

/** Page zoom (NV-06) zooms a Peek's or a Mini Window's page as it zooms a tab's (review A-F4). */
export function setPageZoom(zoom: PageZoom): void {
  pageZoom = zoom
}

/** The page of a window's open Peek and its card's place (window coordinates). */
export interface PeekPage {
  tabId: TabId
  card: Rect
}

let peekPages: (windowId: WindowId) => PeekPage | undefined = () => undefined

/** The Peek says which page it shows, so find in page acts on it while it is open (PK-11). */
export function setPeekPages(pages: (windowId: WindowId) => PeekPage | undefined): void {
  peekPages = pages
}

/** The page a window's Peek shows while it is open and settled in its card; undefined otherwise. */
export function peekPageOf(windowId: WindowId): PeekPage | undefined {
  return peekPages(windowId)
}

/**
 * Page-level actions run on a given page: the Peek's while it is open (PK-11) and a Mini Window's
 * (MW-03). Returns false for actions that are not about the page.
 */
export function runPageAction(id: string, contents: WebContents, toast: (message: string) => void): boolean {
  const history = contents.navigationHistory
  switch (id) {
    case 'nav.back':
      if (history.canGoBack()) history.goBack()
      return true
    case 'nav.forward':
      if (history.canGoForward()) history.goForward()
      return true
    case 'nav.reload':
      contents.reload()
      return true
    case 'nav.hardReload':
      contents.reloadIgnoringCache()
      return true
    case 'nav.stop':
      contents.stop()
      return true
    // Each change says the new zoom, as the tab's indicator does (NV-06).
    case 'page.zoomIn':
    case 'page.zoomOut':
    case 'page.zoomReset': {
      const factor = pageZoom(contents, id === 'page.zoomIn' ? 1 : id === 'page.zoomOut' ? -1 : 0)
      toast(`Zoom ${zoomPercent(factor)}%`)
      return true
    }
    // Orbit's print dialog over the page (pages lane, NV-07).
    case 'page.print':
      printPage(contents)
      return true
    // Its own page, where the save dialog says (pages lane, NV-21).
    case 'page.save':
      savePage(contents)
      return true
    // Its own page's source, in a new tab (pages lane, DT-04).
    case 'page.viewSource':
      viewSource(contents)
      return true
    // DevTools dock inside the page's own view, as for a tab (DT-01).
    case 'devtools.toggle':
    case 'devtools.console':
    case 'devtools.inspect':
      return runDevtoolsAction(id, contents)
    // Copies like a tab's: tracking parameters dropped (TB-20).
    case 'tab.copyUrl':
    case 'tab.copyUrlMarkdown': {
      const url = contents.getURL()
      if (!url || url === 'about:blank') return true
      const clean = cleanUrl(url)
      const title = contents.getTitle() || fallbackTitle(clean)
      clipboard.writeText(id === 'tab.copyUrl' ? clean : markdownLink(title, clean))
      toast('Copied')
      return true
    }
    default:
      return false
  }
}
