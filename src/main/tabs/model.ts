/**
 * Pure tab-model helpers operating on state or drafts (no Electron imports, unit-testable).
 */
import { newId } from '../../shared/ids'
import type { ItemId, OrbitState, Space, SpaceId, Tab, TabId, WindowId } from '../../shared/state'
import {
  containerItems,
  locate,
  sectionOf,
  sidebarTabOrder,
  splitLeaves,
  splitOfTab,
  tabsInItem,
  visibleSections,
} from '../../shared/tree'
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

/** Why a tab is being placed in Today (TB-03). */
export type TodayInsertReason = 'new' | 'background' | 'unpin' | 'restore' | 'reopen' | 'move'

/**
 * Where a tab lands in a Space's Today section. One tunable rule (TB-03 build note):
 * everything currently goes to the top, directly under the "+ New Tab" row.
 */
export function todayInsertIndex(_space: Pick<Space, 'today'>, _reason: TodayInsertReason): number {
  return 0
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

/** Tabs currently on screen: each window's selected tab, with all panes of its split view. */
export function displayedTabs(state: OrbitState): Set<TabId> {
  const out = new Set<TabId>()
  for (const win of Object.values(state.windows)) {
    const id = win.activeTab[win.spaceId]
    if (!id || !state.tabs[id]) continue
    const split = splitOfTab(state, id)
    const s = split ? state.splits[split] : undefined
    if (s) for (const leaf of splitLeaves(s.layout)) out.add(leaf)
    else out.add(id)
  }
  return out
}

/** Most recently used tab of a Space (Favorites included), skipping `excluding`. */
export function mostRecentTab(
  state: OrbitState,
  spaceId: SpaceId,
  excluding: Set<TabId>,
  filter: (tab: Tab) => boolean = () => true,
): TabId | null {
  let best: Tab | undefined
  for (const id of sidebarTabOrder(state, spaceId)) {
    if (excluding.has(id)) continue
    const tab = state.tabs[id]
    if (!tab || !filter(tab)) continue
    if (!best || tab.lastActiveAt > best.lastActiveAt) best = tab
  }
  return best?.id ?? null
}

/**
 * The tab to select after `closedTabId` leaves (TB-06): the tab directly below in the
 * same section, else the one above, else the most recently used tab in this Space,
 * else nothing (empty Space state).
 */
export function nextAfterClose(
  state: OrbitState,
  spaceId: SpaceId,
  closedTabId: TabId,
  closing: Set<TabId> = new Set([closedTabId]),
): TabId | null {
  const sections = visibleSections(state, spaceId, { activeTabId: closedTabId })
  for (const list of [sections.favorites, sections.pinned, sections.today]) {
    const i = list.indexOf(closedTabId)
    if (i < 0) continue
    for (let j = i + 1; j < list.length; j++) {
      const id = list[j] as TabId
      if (!closing.has(id)) return id
    }
    for (let j = i - 1; j >= 0; j--) {
      const id = list[j] as TabId
      if (!closing.has(id)) return id
    }
    break
  }
  return mostRecentTab(state, spaceId, closing)
}

/** Replaces the selection in every window/Space that selected one of `tabIds`. Draft helper. */
export function reselectAway(
  d: OrbitState,
  tabIds: Set<TabId>,
  pick: (spaceId: SpaceId, current: TabId) => TabId | null = (spaceId, current) =>
    nextAfterClose(d, spaceId, current, tabIds),
  now = Date.now(),
): void {
  for (const win of Object.values(d.windows)) {
    for (const [spaceId, active] of Object.entries(win.activeTab)) {
      if (!active || !tabIds.has(active)) continue
      const next = pick(spaceId, active)
      win.activeTab[spaceId] = next
      const tab = next ? d.tabs[next] : undefined
      if (tab && spaceId === win.spaceId) tab.lastActiveAt = now
    }
  }
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

/** Auto-archive period for a Space's Today tabs: its profile's value, else the global setting (TD-03). */
export function archiveAfterFor(state: OrbitState, spaceId: SpaceId): number {
  const space = state.spaces[spaceId]
  const profile = space ? state.profiles[space.profileId] : undefined
  return profile?.archiveAfterMs ?? state.settings.archiveAfterMs
}

/**
 * Today items (tabs or whole split views) idle longer than their Space's archive period
 * (TD-02). Never: tabs on screen, tabs playing audio, anything outside Today.
 */
export function autoArchiveCandidates(state: OrbitState, now: number): ItemId[] {
  const shown = displayedTabs(state)
  const out: ItemId[] = []
  for (const space of Object.values(state.spaces)) {
    const after = archiveAfterFor(state, space.id)
    if (!(after > 0)) continue
    for (const id of space.today) {
      const tabs = tabsInItem(state, id)
        .map((t) => state.tabs[t])
        .filter((t): t is Tab => !!t)
      if (tabs.length === 0) continue
      if (tabs.some((t) => shown.has(t.id) || t.audible)) continue
      const last = Math.max(...tabs.map((t) => t.lastActiveAt))
      if (now - last >= after) out.push(id)
    }
  }
  return out
}

/** Favorites stay warm this many times longer than other tabs (FV-08). */
export const FAVORITE_WARM_FACTOR = 4

/**
 * Awake tabs idle longer than the sleep period (TB-16). Never: tabs on screen or playing
 * audio. Favorites stay loaded for longer (FV-08).
 */
export function sleepCandidates(state: OrbitState, now: number, awake: Iterable<TabId>): TabId[] {
  const after = state.settings.sleepAfterMs
  if (!(after > 0)) return []
  const shown = displayedTabs(state)
  const out: TabId[] = []
  for (const id of awake) {
    const tab = state.tabs[id]
    if (!tab || shown.has(id) || tab.audible) continue
    const limit = sectionOf(state, id) === 'favorite' ? after * FAVORITE_WARM_FACTOR : after
    if (now - tab.lastActiveAt >= limit) out.push(id)
  }
  return out
}

/** The tab ⌘N jumps to (TB-04, FV-10). `n` is 1–9. */
export function numberedTarget(state: OrbitState, windowId: WindowId, n: number): TabId | undefined {
  const win = state.windows[windowId]
  if (!win) return undefined
  const active = win.activeTab[win.spaceId] ?? null
  const s = visibleSections(state, win.spaceId, {
    activeTabId: active,
    includeFavorites: state.settings.countFavoritesInShortcuts,
  })
  const order = [...s.favorites, ...s.pinned, ...s.today]
  if (n === 9 && state.settings.lastTabOnCmd9) return order[order.length - 1]
  return order[n - 1]
}

/** Next/previous tab in sidebar order, skipping rows hidden in collapsed sections (TB-04). */
export function steppedTarget(state: OrbitState, windowId: WindowId, delta: number): TabId | undefined {
  const win = state.windows[windowId]
  if (!win) return undefined
  const active = win.activeTab[win.spaceId] ?? null
  const s = visibleSections(state, win.spaceId, { activeTabId: active })
  const order = [...s.favorites, ...s.pinned, ...s.today]
  if (order.length === 0) return undefined
  const i = active ? order.indexOf(active) : -1
  if (i < 0) return delta > 0 ? order[0] : order[order.length - 1]
  return order[(i + delta + order.length) % order.length]
}
