import { clipboard, type WebContents } from 'electron'
import { sameZoom, zoomPercent, zoomStep } from '../../shared/nav'
import { cleanUrl, markdownLink } from '../../shared/tabs'
import { fallbackTitle } from '../../shared/url'
import { runDevtoolsAction } from '../devtools/control'
import { printPage } from '../pages/entry'

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
