import type { MenuItemConstructorOptions } from 'electron'
import { pageMayOpen } from '../../shared/link-routing'
import { MAX_PANES, SPLIT_FULL_MESSAGE } from '../../shared/split'
import type { OrbitState, TabId, WindowId } from '../../shared/state'
import { splitOfTab } from '../../shared/tree'
import type { MainContext } from '../context'
import { isBlankPane, leavesOf } from './model'

const activeTabOf = (state: OrbitState, windowId: WindowId): TabId | null => {
  const win = state.windows[windowId]
  const id = win?.activeTab[win.spaceId]
  return id && state.tabs[id] ? id : null
}

/**
 * Split View items for menus owned by other areas, so wiring them is one line each.
 * They only call split commands; nothing here changes how those menus work.
 */

/**
 * For a tab row's right-click menu (tabs.md TB-14, split-view.md SV-06/SV-09):
 * - 2–4 selected tabs: "Open in Split View" (disabled with a hint above 4).
 * - one tab that isn't shown: "Open in Split View" beside the current tab.
 */
export function tabSplitMenuItems(
  ctx: MainContext,
  tabIds: TabId[],
  windowId: WindowId | undefined,
): MenuItemConstructorOptions[] {
  const state = ctx.store.state
  const ids = [...new Set(tabIds)].filter((id) => state.tabs[id])
  if (ids.length > 1) {
    const tooMany = ids.length > MAX_PANES
    return [
      {
        label: tooMany ? `Open in Split View (${SPLIT_FULL_MESSAGE})` : 'Open in Split View',
        enabled: !tooMany,
        click: () => void ctx.commands.run('split.create', { tabIds: ids }, { windowId }),
      },
    ]
  }
  const tabId = ids[0]
  const current = windowId ? activeTabOf(state, windowId) : null
  if (!tabId || !current || current === tabId || isBlankPane(state.tabs[current])) return []
  const sameSplit = splitOfTab(state, current) && splitOfTab(state, current) === splitOfTab(state, tabId)
  if (sameSplit) return []
  return [
    {
      label: 'Open in Split View',
      enabled: leavesOf(state, splitOfTab(state, current)).length < MAX_PANES,
      click: () => void ctx.commands.run('split.addTab', { tabId, target: current, side: 'right' }, { windowId }),
    },
  ]
}

/**
 * For a page's link context menu (SV-08): open the link in a new pane beside the page's pane.
 * `from` is the page (or frame) the link is in: none for a link it may not open, a local file for a
 * web page (D49) or an internal page for any but another (D53).
 */
export function linkSplitMenuItems(
  ctx: MainContext,
  tabId: TabId,
  url: string,
  from: string | undefined,
): MenuItemConstructorOptions[] {
  if (!url || !pageMayOpen(from, url)) return []
  const windowId = ctx.windows.windowOfTab(tabId)
  const full = leavesOf(ctx.store.state, splitOfTab(ctx.store.state, tabId)).length >= MAX_PANES
  return [
    {
      label: 'Open Link in Split View',
      enabled: !full,
      click: () => void ctx.commands.run('split.openUrl', { url, target: tabId, side: 'right' }, { windowId }),
    },
  ]
}

/** For the sidebar "+" menu or a title-bar split button (SV-07). */
export function newSplitMenuItems(ctx: MainContext, windowId: WindowId | undefined): MenuItemConstructorOptions[] {
  const run = (id: string) => () => void ctx.actions.run(id, { windowId })
  return [
    { label: 'Add Split Right', click: run('split.addRight') },
    { label: 'Add Split Left', click: run('split.addLeft') },
    { label: 'Add Split Above', click: run('split.addAbove') },
    { label: 'Add Split Below', click: run('split.addBelow') },
  ]
}
