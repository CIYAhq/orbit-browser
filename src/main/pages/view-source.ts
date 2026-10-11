import type { WebContents } from 'electron'
import type { SpaceId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import { setPageEntries } from './entry'

/** Whether a page at `url` has a source to show: not a blank page, nor a source view itself. */
export function hasSource(url: string): boolean {
  return url !== '' && url !== 'about:blank' && !url.startsWith('view-source:')
}

/**
 * View source (DT-04): the page's own address, as `view-source:`, in a new tab, shown at once. The
 * engine's source view is read-only, coloured and numbered by line. A Peek's page opens its own
 * source in the Peek's window; a Mini Window's, in a main window (one showing its Space if there
 * is one), brought to the front. Only the page's own address goes, so D49 holds: a web page's
 * address is never a `file:` one.
 */
export function registerViewSource(ctx: MainContext): void {
  const { commands, store, tabs, windows } = ctx

  /** Where a page's source opens: the page's own window, or a main window for a Mini Window's page. */
  const windowFor = (windowId: WindowId | undefined, spaceId: SpaceId | undefined): WindowId | undefined => {
    const { state } = store
    if (!windowId || state.windows[windowId]?.kind !== 'mini') return windowId
    const mains = windows.ids().filter((id) => state.windows[id]?.kind === 'main')
    return mains.find((id) => state.windows[id]?.spaceId === spaceId) ?? mains[0] ?? windows.open(undefined, spaceId)
  }

  const open = (page: WebContents) => {
    const url = page.isDestroyed() ? '' : page.getURL()
    if (!hasSource(url)) return
    const tabId = tabs.tabIdFor(page)
    const spaceId = tabId ? store.state.tabs[tabId]?.spaceId : undefined
    const from = (tabId ? windows.windowOfTab(tabId) : undefined) ?? windows.focusedWindowId()
    const windowId = windowFor(from, spaceId)
    // In the Space the window shows: the page's own, unless it was a Mini Window's.
    void commands
      .run('tabs.create', { url: `view-source:${url}`, activate: true }, { windowId })
      .catch((err: unknown) => console.error('[pages] view source', err))
    if (windowId && windowId !== from) windows.get(windowId)?.focus()
  }
  setPageEntries({ viewSource: open })
}
