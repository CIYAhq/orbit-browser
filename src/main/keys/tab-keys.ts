import { sectionOf, splitOfTab } from '../../shared/tree'
import type { MainContext } from '../context'
import type { CallContext } from '../registry'
import { activeTabOf } from '../windows'

/**
 * Tab actions from KS-05's table that have no keys until the user gives them some (Settings →
 * Shortcuts): Rename Tab (TB-12), Archive Tab and Move Tab to Space (TB-11). Each acts on the
 * selected tab of a main window.
 */
export function registerTabKeys(ctx: MainContext): void {
  const { actions, commands, store, windows } = ctx

  const selected = (c: CallContext) => {
    const windowId = c.windowId ?? windows.focusedWindowId()
    if (!windowId || store.state.windows[windowId]?.kind !== 'main') return undefined
    const tabId = activeTabOf(store.state, windowId)
    return tabId ? { windowId, tabId } : undefined
  }

  // The name is edited in the tab's sidebar row (a split's in its split row): a hidden sidebar shows.
  actions.register('tab.rename', (c) => {
    const at = selected(c)
    if (!at) return
    const { windowId, tabId } = at
    if (!store.state.windows[windowId]?.sidebar.visible) {
      void commands.run('window.setSidebar', { visible: true }, { windowId })
    }
    windows.sendToWindow(windowId, 'sidebar:rename', { id: splitOfTab(store.state, tabId) ?? tabId })
  })

  // A Today tab closes into the Archive (TB-06); a pinned tab or Favorite leaves the sidebar for it (PN-06).
  actions.register('tab.archive', (c) => {
    const at = selected(c)
    if (!at) return
    const { windowId, tabId } = at
    const section = sectionOf(store.state, splitOfTab(store.state, tabId) ?? tabId)
    if (section === 'pinned' || section === 'favorite') void commands.run('tabs.delete', { id: tabId }, { windowId })
    else void commands.run('tabs.close', { tabId }, { windowId })
  })

  // The command bar, on its "Move to [Space]" rows.
  actions.register('tab.pickSpace', (c) => {
    const at = selected(c)
    if (!at) return
    void commands.run(
      'overlay.open',
      { overlay: { kind: 'commandbar', mode: 'new-tab', query: 'Move to ' } },
      { windowId: at.windowId },
    )
  })
}
