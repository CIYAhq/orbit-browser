import { clipboard, type WebContents } from 'electron'
import { cleanUrl, markdownLink } from '../../shared/tabs'
import { fallbackTitle } from '../../shared/url'

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
    case 'page.zoomIn':
      contents.setZoomLevel(Math.min(contents.getZoomLevel() + 0.5, 5))
      return true
    case 'page.zoomOut':
      contents.setZoomLevel(Math.max(contents.getZoomLevel() - 0.5, -5))
      return true
    case 'page.zoomReset':
      contents.setZoomLevel(0)
      return true
    case 'page.print':
      contents.print()
      return true
    case 'devtools.toggle':
      if (contents.isDevToolsOpened()) contents.closeDevTools()
      else contents.openDevTools({ mode: 'detach' })
      return true
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
