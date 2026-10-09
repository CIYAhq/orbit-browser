import { clipboard, type WebContents } from 'electron'

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
    case 'tab.copyUrl': {
      const url = contents.getURL()
      if (!url) return true
      clipboard.writeText(url)
      toast('Copied URL to clipboard')
      return true
    }
    default:
      return false
  }
}
