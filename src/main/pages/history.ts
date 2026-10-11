import { clipboard, Menu, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { INTERNAL_SCHEME } from '../../shared/commands/devtools'
import { PAGE_CHANNEL } from '../../shared/site'
import type { Tab, TabId, WindowId } from '../../shared/state'
import { historyMenuItems } from '../archive/history-view'
import type { MainContext } from '../context'
import { internalPageName } from '../devtools/internal-urls'
import { isUnplacedImportTab } from '../import/unplaced'
import type { ActionContext, CallContext } from '../registry'
import { findMenuItem, menuLabels } from '../tabs/menus'
import { shownTabs } from '../windows'

/** The History page's name: `orbit://history/` (src/renderer/src/pages/history.internal-page.tsx). */
export const HISTORY_PAGE = 'history'
export const HISTORY_URL = `${INTERNAL_SCHEME}://${HISTORY_PAGE}/`

/**
 * History in a tab (AR-10): `orbit://history/`, an internal page (DT-13) that shows the Library's
 * History section, every visit of the tab's profile. ⌘Y (Ctrl+H), Archive → View History and the
 * command bar's View History show it in a main window: the History tab of the Space the window
 * shows if it has one (the one used last), else a new tab. An open Library makes way. The Library
 * keeps its History section.
 *
 * The page runs only the `pages.history*` commands (INTERNAL_PAGE_COMMANDS, D53). Each one takes the
 * profile from the calling page's own tab, never from the page, and opens only a page that page was
 * given: a script that got into it (through a title, say) can't read another profile's history or
 * open any other address.
 */
export function registerHistoryPage(ctx: MainContext): void {
  const { actions, commands, store, tabs, windows } = ctx

  // ---- ⌘Y / Ctrl+H, the menu and the command bar ----

  /** History shows in a main window: from a Mini Window, the latest one, brought to the front. */
  const mainWindowFor = (c: ActionContext): WindowId | undefined => {
    const { state } = store
    const isMain = (id: WindowId | undefined): id is WindowId => !!id && state.windows[id]?.kind === 'main'
    const asked = c.windowId ?? windows.focusedWindowId()
    if (isMain(asked)) return asked
    const mains = windows.ids().filter(isMain)
    const target = mains[mains.length - 1] ?? windows.open(undefined, asked ? state.windows[asked]?.spaceId : undefined)
    windows.get(target)?.focus()
    return target
  }

  /** The History tab of the Space a window shows, the one used last; an import's unplaced tabs aside (D65). */
  const historyTabIn = (windowId: WindowId): TabId | undefined => {
    const { state } = store
    const spaceId = state.windows[windowId]?.spaceId
    let found: Tab | undefined
    for (const tab of Object.values(state.tabs)) {
      if (tab.spaceId !== spaceId || tab.floating || isUnplacedImportTab(tab.id)) continue
      if (internalPageName(tab.url) !== HISTORY_PAGE) continue
      if (!found || tab.lastActiveAt > found.lastActiveAt) found = tab
    }
    return found?.id
  }

  actions.register('app.history', async (c) => {
    const windowId = mainWindowFor(c)
    if (!windowId) return
    // The Library makes way, as for any tab opened from it.
    await commands.run('library.close', {}, { windowId })
    const tabId = historyTabIn(windowId)
    if (tabId) await commands.run('tabs.activate', { tabId }, { windowId })
    else await commands.run('tabs.create', { url: HISTORY_URL, activate: true }, { windowId })
  })

  // ---- The page's commands (D53) ----

  /** The History page that calls and its tab's profile: from the tab, never from the page. */
  const caller = (c: CallContext): { page: WebContents; profileId: string } => {
    const page = c.sender
    const tabId = page && !page.isDestroyed() ? tabs.tabIdFor(page) : undefined
    const profileId = tabId ? store.state.tabs[tabId]?.profileId : undefined
    if (!page || !profileId || internalPageName(page.getURL()) !== HISTORY_PAGE) throw new Error('Forbidden')
    return { page, profileId }
  }

  /** The pages each History page was given: the only ones it may open. */
  const listed = new WeakMap<WebContents, Set<string>>()
  const isListed = (page: WebContents, url: unknown): url is string =>
    typeof url === 'string' && !!listed.get(page)?.has(url)

  /** Tells a History page what its menu did (a toast, a page that went), as the Library is told. */
  const tell = (page: WebContents, channel: string, payload: unknown) => {
    if (page.isDestroyed() || internalPageName(page.getURL()) !== HISTORY_PAGE) return
    try {
      page.mainFrame.send(PAGE_CHANNEL.internalEvent, `orbit:${channel}`, payload)
    } catch {
      // The page went meanwhile.
    }
  }

  // A History tab shown again loads its list again: pages were visited since. (The page can't tell:
  // the engine keeps a hidden tab's page visible.)
  let shown = new Set<TabId>()
  store.subscribe((next, prev) => {
    if (next.windows === prev.windows && next.tabs === prev.tabs) return
    const now = new Set<TabId>()
    for (const windowId of Object.keys(next.windows)) {
      for (const tabId of shownTabs(next, windowId)) {
        if (internalPageName(next.tabs[tabId]?.url) === HISTORY_PAGE) now.add(tabId)
      }
    }
    for (const tabId of now) {
      const page = shown.has(tabId) ? undefined : tabs.contents(tabId)
      if (page) tell(page, 'history:shown', {})
    }
    shown = now
  })

  commands.register('pages.history', async (q, c) => {
    const { page, profileId } = caller(c)
    const { text, before, limit } = q ?? {}
    const rows = await commands.run('library.history', { text, before, limit, profileId }, c)
    const urls = listed.get(page) ?? new Set<string>()
    listed.set(page, urls)
    for (const row of rows) urls.add(row.url)
    return rows
  })
  commands.register('pages.historyOpen', async ({ url, background }, c) => {
    const { page } = caller(c)
    if (!isListed(page, url)) return
    await commands.run('tabs.create', { url, activate: background !== true }, { windowId: c.windowId })
  })
  commands.register('pages.historyDelete', async ({ url }, c) => {
    const { profileId } = caller(c)
    if (typeof url === 'string' && url) await commands.run('history.delete', { profileId, url })
  })

  let lastMenu: MenuItemConstructorOptions[] = []
  commands.register('pages.historyMenu', ({ url }, c) => {
    const { page, profileId } = caller(c)
    if (!isListed(page, url)) return
    const windowId = c.windowId
    lastMenu = historyMenuItems(ctx, {
      url,
      profileId,
      windowId,
      send: (channel, payload) => tell(page, channel, payload),
      copy: (text) => clipboard.writeText(text),
    })
    if (ctx.e2e) return
    const win = windowId ? windows.get(windowId) : undefined
    if (win && !win.isDestroyed()) Menu.buildFromTemplate(lastMenu).popup({ window: win })
  })
  if (ctx.e2e) {
    commands.register('pages.testHistoryMenu', ({ click }) => {
      const item = click ? findMenuItem(lastMenu, click) : undefined
      if (item?.click && item.enabled !== false) (item.click as () => void)()
      return menuLabels(lastMenu)
    })
  }
}
