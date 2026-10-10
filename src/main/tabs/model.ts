/**
 * Pure tab-model helpers operating on state or drafts (no Electron imports, unit-testable).
 */
import { DEFAULT_PROFILE_ID } from '../../shared/defaults'
import { newId } from '../../shared/ids'
import { isMediaBusy } from '../../shared/media'
import { noteSplitFocus, removePane } from '../../shared/split'
import type { ItemId, OrbitState, Space, SpaceId, Tab, TabId, WindowId } from '../../shared/state'
import {
  containerItems,
  locate,
  sectionOf,
  setContainerItems,
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
  noteSplitFocus(d, tabId)
  // A page is live in one window at a time (TB-17): a window that was showing this tab (or a
  // pane of its split) hands it over and shows another tab nobody else shows.
  dedupeDisplayed(d, windowId)
}

/** The tabs one window draws: its selected tab, or every pane of the selected split view. */
export function shownBy(state: OrbitState, windowId: WindowId): TabId[] {
  const win = state.windows[windowId]
  const id = win?.activeTab[win.spaceId]
  if (!id || !state.tabs[id]) return []
  const split = splitOfTab(state, id)
  const s = split ? state.splits[split] : undefined
  return s ? splitLeaves(s.layout).filter((t) => state.tabs[t]) : [id]
}

/** Tabs drawn by every window except `windowId`. */
export function shownElsewhere(state: OrbitState, windowId: WindowId): Set<TabId> {
  const out = new Set<TabId>()
  for (const id of Object.keys(state.windows)) {
    if (id === windowId) continue
    for (const t of shownBy(state, id)) out.add(t)
  }
  return out
}

/**
 * No two windows draw the same tab (TB-17, review M4). The `winner` (the window the user just
 * acted in) keeps its tab; then each other window in turn, if it overlaps a window already
 * settled, picks again among tabs no settled window shows. Draft helper; run it after anything
 * that changes a window's selected tab or Space.
 */
export function dedupeDisplayed(d: OrbitState, winner?: WindowId): void {
  const ids = Object.keys(d.windows)
  const order = winner && d.windows[winner] ? [winner, ...ids.filter((id) => id !== winner)] : ids
  const taken = new Set<TabId>()
  for (const id of order) {
    const win = d.windows[id]
    if (!win) continue
    let shown = shownBy(d, id)
    if (shown.some((t) => taken.has(t))) {
      const current = win.activeTab[win.spaceId] as TabId
      const excluding = new Set<TabId>([...taken, ...shown])
      let next = nextAfterClose(d, win.spaceId, current, excluding)
      // A split pick must not overlap either; fall back to the most recent clean tab, else none.
      if (next && splitLeavesOf(d, next).some((t) => taken.has(t))) {
        next = mostRecentTab(d, win.spaceId, excluding, (t) => !splitLeavesOf(d, t.id).some((x) => taken.has(x)))
      }
      win.activeTab[win.spaceId] = next
      shown = shownBy(d, id)
    }
    for (const t of shown) taken.add(t)
  }
}

function splitLeavesOf(state: OrbitState, tabId: TabId): TabId[] {
  const split = splitOfTab(state, tabId)
  const s = split ? state.splits[split] : undefined
  return s ? splitLeaves(s.layout) : [tabId]
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
  pick: (spaceId: SpaceId, current: TabId, excluding: Set<TabId>) => TabId | null = (spaceId, current, excluding) =>
    nextAfterClose(d, spaceId, current, excluding),
  now = Date.now(),
): void {
  for (const win of Object.values(d.windows)) {
    for (const [spaceId, active] of Object.entries(win.activeTab)) {
      if (!active || !tabIds.has(active)) continue
      // Never a tab another window is drawing (TB-17).
      const excluding = new Set<TabId>([...tabIds, ...shownElsewhere(d, win.id)])
      const next = pick(spaceId, active, excluding)
      win.activeTab[spaceId] = next
      const tab = next ? d.tabs[next] : undefined
      if (tab && spaceId === win.spaceId) tab.lastActiveAt = now
      if (next) noteSplitFocus(d, next)
    }
  }
  dedupeDisplayed(d)
}

/**
 * Removes a tab from a split view, dissolving the split when one pane is left. The other panes
 * keep their arrangement and sizes (SV-17). Draft helper.
 */
export function detachFromSplit(d: OrbitState, tabId: TabId): void {
  const splitId = splitOfTab(d, tabId)
  if (!splitId) return
  const split = d.splits[splitId]
  if (!split) return
  const kept = removePane(split.layout, tabId)
  const remaining = kept ? splitLeaves(kept) : []
  const loc = locate(d, splitId)
  if (kept && remaining.length >= 2) {
    split.layout = kept
    if (split.focus === tabId) delete split.focus
    if (split.pending === tabId) delete split.pending
    return
  }
  delete d.splits[splitId]
  if (loc) {
    const list = containerItems(d, loc.container)
    if (list) {
      setContainerItems(d, loc.container, [...list.slice(0, loc.index), ...remaining, ...list.slice(loc.index + 1)])
    }
  }
}

/**
 * Auto-archive period for a Space's Today tabs (TD-03): its profile's value; profiles without
 * one inherit the Default profile's, then the global setting.
 */
export function archiveAfterFor(state: OrbitState, spaceId: SpaceId): number {
  const space = state.spaces[spaceId]
  const profile = space ? state.profiles[space.profileId] : undefined
  return profile?.archiveAfterMs ?? state.profiles[DEFAULT_PROFILE_ID]?.archiveAfterMs ?? state.settings.archiveAfterMs
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
      // Tabs playing media, in picture-in-picture or using camera/microphone stay (MD-12).
      if (tabs.some((t) => shown.has(t.id) || isMediaBusy(t))) continue
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
    if (!tab || shown.has(id) || isMediaBusy(tab)) continue
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
