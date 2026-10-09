/**
 * Pure tab-model helpers operating on state drafts (no Electron imports, unit-testable).
 */
import { newId } from '../../shared/ids'
import type { OrbitState, Tab, TabId, WindowId } from '../../shared/state'
import { containerItems, locate, sectionOf, sidebarTabOrder, splitLeaves, splitOfTab } from '../../shared/tree'
import { fallbackTitle } from '../../shared/url'

export function makeTab(fields: Pick<Tab, 'spaceId' | 'profileId' | 'url'> & Partial<Tab>, now = Date.now()): Tab {
  return {
    id: newId('t'),
    title: fallbackTitle(fields.url),
    createdAt: now,
    lastActiveAt: now,
    loading: false,
    audible: false,
    muted: false,
    canGoBack: false,
    canGoForward: false,
    asleep: true,
    ...fields,
  }
}

/** Makes `tabId` the active tab of a window (switching Space when needed). Draft helper. */
export function activateInDraft(d: OrbitState, windowId: WindowId, tabId: TabId, now = Date.now()): void {
  const win = d.windows[windowId]
  const tab = d.tabs[tabId]
  if (!win || !tab) return
  const isFavorite = sectionOf(d, tabId) === 'favorite'
  const currentSpace = d.spaces[win.spaceId]
  // Favorites are shared by all Spaces of a profile: stay in the current Space when it shows them.
  if (
    !(isFavorite && currentSpace?.profileId === tab.profileId) &&
    win.spaceId !== tab.spaceId &&
    d.spaces[tab.spaceId]
  ) {
    win.spaceId = tab.spaceId
  }
  win.activeTab[win.spaceId] = tabId
  tab.lastActiveAt = now
}

/** Most recently used other tab visible in a Space (prefers awake tabs). */
export function pickNextActive(state: OrbitState, spaceId: string, excluding: Set<TabId>): TabId | null {
  const candidates = sidebarTabOrder(state, spaceId)
    .filter((id) => !excluding.has(id))
    .map((id) => state.tabs[id])
    .filter((t): t is Tab => !!t)
  if (candidates.length === 0) return null
  const awake = candidates.filter((t) => !t.asleep)
  const pool = awake.length > 0 ? awake : candidates.filter((t) => sectionOf(state, t.id) === 'today')
  if (pool.length === 0) return null
  return pool.reduce((best, t) => (t.lastActiveAt > best.lastActiveAt ? t : best)).id
}

/** Removes a tab from a split view, dissolving the split when one pane is left. Draft helper. */
export function detachFromSplit(d: OrbitState, tabId: TabId): void {
  const splitId = splitOfTab(d, tabId)
  if (!splitId) return
  const split = d.splits[splitId]
  if (!split) return
  const remaining = splitLeaves(split.layout).filter((id) => id !== tabId)
  const loc = locate(d, splitId)
  if (remaining.length >= 2) {
    split.layout = {
      type: 'row',
      children: remaining.map((id) => ({ type: 'leaf', tabId: id })),
      sizes: remaining.map(() => 1 / remaining.length),
    }
    return
  }
  delete d.splits[splitId]
  if (loc) {
    const list = containerItems(d, loc.container)
    if (list) list.splice(loc.index, 1, ...remaining)
  }
}
