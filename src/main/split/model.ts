/**
 * Split View state helpers operating on state drafts (no Electron imports, unit-testable).
 * A split is one sidebar item (`v-` id) whose panes are tabs that sit in no container
 * themselves. Every helper keeps the invariants: 2–4 panes per split, canonical layout,
 * a tab in at most one place.
 */
import { newId } from '../../shared/ids'
import {
  insertPane,
  layoutLeaves,
  leaf,
  MAX_PANES,
  makeLayout,
  normalizeLayout,
  type PaneSide,
  paneOrder,
  removePane,
  replacePane,
  type SplitAxis,
  siblingOf,
} from '../../shared/split'
import type { ContainerRef, ItemId, OrbitState, SplitId, SplitLayout, Tab, TabId, WindowId } from '../../shared/state'
import {
  containerItems,
  type ItemLocation,
  insertItem,
  locate,
  profileOfContainer,
  removeItem,
  sidebarTabOrder,
  spaceOfContainer,
  splitOfTab,
} from '../../shared/tree'
import { activateInDraft } from '../tabs/model'

export type SplitFailure = 'full' | 'invalid'

export const isFailure = (r: unknown): r is SplitFailure => r === 'full' || r === 'invalid'

export function leavesOf(state: OrbitState, splitId: SplitId | undefined): TabId[] {
  const split = splitId ? state.splits[splitId] : undefined
  return split ? layoutLeaves(split.layout) : []
}

/** True for the placeholder tab of a pane that has no page yet. */
export function isBlankPane(tab: Pick<Tab, 'url'> | undefined): boolean {
  return !tab?.url || tab.url === 'about:blank'
}

/** The sidebar item that stands for a tab: its split, or the tab itself. */
export function itemOfTab(state: OrbitState, tabId: TabId): ItemId {
  return splitOfTab(state, tabId) ?? tabId
}

function rootKind(state: OrbitState, ref: ContainerRef): ContainerRef['kind'] | undefined {
  let current: ContainerRef = ref
  for (let depth = 0; depth < 64; depth++) {
    if (current.kind !== 'folder') return current.kind
    const loc = locate(state, current.folderId)
    if (!loc) return undefined
    current = loc.container
  }
  return undefined
}

/**
 * Brings tabs' bookkeeping in line with the container their split sits in: Space,
 * profile and pinned URL. Returns the tabs whose profile changed (they must reload
 * in the new session).
 */
export function adoptPlacement(d: OrbitState, tabIds: TabId[], container: ContainerRef | undefined): TabId[] {
  if (!container) return []
  const kind = rootKind(d, container)
  const pinned = kind === 'pinned' || kind === 'favorites'
  const spaceId = spaceOfContainer(d, container)
  const profileId = profileOfContainer(d, container)
  const moved: TabId[] = []
  for (const id of tabIds) {
    const tab = d.tabs[id]
    if (!tab) continue
    if (pinned && !tab.pinnedUrl && !isBlankPane(tab)) tab.pinnedUrl = tab.url
    if (!pinned && tab.pinnedUrl) tab.pinnedUrl = undefined
    if (spaceId && tab.spaceId !== spaceId) tab.spaceId = spaceId
    if (profileId && tab.profileId !== profileId) {
      tab.profileId = profileId
      moved.push(id)
    }
  }
  return moved
}

/**
 * Takes a tab out of wherever it is: its sidebar row, or a pane of a split (the split
 * keeps its arrangement; with one pane left it dissolves into an ordinary tab in its place).
 */
export function detachTab(d: OrbitState, tabId: TabId): ItemLocation | undefined {
  const splitId = splitOfTab(d, tabId)
  if (!splitId) return removeItem(d, tabId)
  const split = d.splits[splitId]
  if (!split) return undefined
  const next = removePane(split.layout, tabId)
  const remaining = next ? layoutLeaves(next) : []
  const loc = locate(d, splitId)
  if (next && remaining.length >= 2) {
    split.layout = next
    return loc
  }
  delete d.splits[splitId]
  if (loc) containerItems(d, loc.container)?.splice(loc.index, 1, ...remaining)
  return loc
}

/** Where a new or restored item should go when nothing better is known: top of its Space's Today. */
function todayOf(d: OrbitState, tabId: TabId): ContainerRef | undefined {
  const tab = d.tabs[tabId]
  const spaceId = tab && d.spaces[tab.spaceId] ? tab.spaceId : d.spaceOrder[0]
  return spaceId ? { kind: 'today', spaceId } : undefined
}

/**
 * Makes a split from 2–4 tabs. The split takes the place of `at` (default: the first
 * tab) and its panes are ordered as given (or by `layout`). Tabs leave their rows or
 * other splits.
 */
export function createSplitInDraft(
  d: OrbitState,
  tabIds: TabId[],
  opts: { at?: TabId; axis?: SplitAxis; layout?: SplitLayout; now?: number; id?: SplitId } = {},
): SplitId | SplitFailure {
  const ids = [...new Set(tabIds)].filter((id) => d.tabs[id])
  if (ids.length < 2) return 'invalid'
  if (ids.length > MAX_PANES) return 'full'
  const anchorTab = opts.at && d.tabs[opts.at] ? opts.at : (ids[0] as TabId)
  const anchorItem = itemOfTab(d, anchorTab)
  const anchorLoc = locate(d, anchorItem)
  const id = opts.id ?? newId('v')
  const target = anchorLoc ?? (todayOf(d, anchorTab) && { container: todayOf(d, anchorTab) as ContainerRef, index: 0 })
  if (!target) return 'invalid'
  insertItem(d, target.container, target.index, id)
  for (const tabId of ids) detachTab(d, tabId)
  const layout = normalizeLayout(opts.layout) ?? makeLayout(ids, opts.axis ?? 'row')
  d.splits[id] = { id, layout, createdAt: opts.now ?? Date.now() }
  adoptPlacement(d, ids, locate(d, id)?.container)
  return id
}

/**
 * Puts `tabId` on `side` of the pane showing `target`. Joins the target's split, or makes
 * a new split in the target's place. Moving a pane within its own split rearranges it.
 */
export function addPaneInDraft(
  d: OrbitState,
  tabId: TabId,
  target: TabId,
  side: PaneSide,
  now = Date.now(),
): SplitId | SplitFailure {
  if (tabId === target || !d.tabs[tabId] || !d.tabs[target]) return 'invalid'
  const splitId = splitOfTab(d, target)
  if (!splitId) {
    const layout = insertPane(leaf(target), target, tabId, side)
    return createSplitInDraft(d, [target, tabId], { at: target, layout, now })
  }
  const split = d.splits[splitId]
  if (!split) return 'invalid'
  const leaves = layoutLeaves(split.layout)
  if (leaves.includes(tabId)) {
    const without = removePane(split.layout, tabId)
    if (!without) return 'invalid'
    split.layout = insertPane(without, target, tabId, side)
    return splitId
  }
  if (leaves.length >= MAX_PANES) return 'full'
  detachTab(d, tabId)
  const current = d.splits[splitId]
  if (!current) return 'invalid'
  current.layout = insertPane(current.layout, target, tabId, side)
  adoptPlacement(d, [tabId], locate(d, splitId)?.container)
  return splitId
}

/** Separates a split: every pane becomes an ordinary tab, in pane order, in the split's place. */
export function separateInDraft(d: OrbitState, splitId: SplitId): TabId[] {
  const split = d.splits[splitId]
  if (!split) return []
  const order = paneOrder(split.layout).filter((id) => d.tabs[id])
  const loc = locate(d, splitId)
  delete d.splits[splitId]
  if (loc) containerItems(d, loc.container)?.splice(loc.index, 1, ...order)
  else {
    const first = order[0]
    const today = first ? todayOf(d, first) : undefined
    if (today) containerItems(d, today)?.splice(0, 0, ...order)
  }
  return order
}

/**
 * Takes one pane out of its split and puts it as an ordinary tab right after the split
 * (or where the dissolved split was), or at the top of its Space's Today with `toToday`.
 */
export function popOutInDraft(d: OrbitState, tabId: TabId, opts: { toToday?: boolean } = {}): void {
  const splitId = splitOfTab(d, tabId)
  if (!splitId) return
  const loc = detachTab(d, tabId)
  if (!opts.toToday && loc) {
    // Right after the split (or after the tab a dissolved split left behind).
    insertItem(d, loc.container, loc.index + 1, tabId)
    adoptPlacement(d, [tabId], loc.container)
    return
  }
  const today = todayOf(d, tabId)
  if (!today) return
  insertItem(d, today, 0, tabId)
  adoptPlacement(d, [tabId], today)
}

/** Replaces a pane's tab with another open tab (which leaves its own place). The old tab goes to Today. */
export function swapIntoPaneInDraft(d: OrbitState, paneTab: TabId, incoming: TabId): boolean {
  const splitId = splitOfTab(d, paneTab)
  if (!splitId || paneTab === incoming || !d.tabs[incoming]) return false
  if (leavesOf(d, splitId).includes(incoming)) return false
  detachTab(d, incoming)
  const split = d.splits[splitId]
  if (!split) return false
  split.layout = replacePane(split.layout, paneTab, incoming)
  adoptPlacement(d, [incoming], locate(d, splitId)?.container)
  const today = todayOf(d, paneTab)
  if (today) {
    insertItem(d, today, 0, paneTab)
    adoptPlacement(d, [paneTab], today)
  }
  return true
}

/** Focuses a pane (or any tab) in a window, with the tab model's selection rules. */
export function focusInDraft(d: OrbitState, windowId: WindowId, tabId: TabId, now = Date.now()): void {
  activateInDraft(d, windowId, tabId, now)
}

/** Windows (and their Space) currently focused on one of `tabIds`. */
export function windowsShowing(d: OrbitState, tabIds: TabId[]): { windowId: WindowId; spaceId: string }[] {
  const out: { windowId: WindowId; spaceId: string }[] = []
  for (const win of Object.values(d.windows)) {
    for (const [spaceId, active] of Object.entries(win.activeTab)) {
      if (active && tabIds.includes(active)) out.push({ windowId: win.id, spaceId })
    }
  }
  return out
}

/** The pane a split row stands for: the one focused most recently. */
export function lastFocusedPane(state: OrbitState, splitId: SplitId): TabId | undefined {
  const leaves = leavesOf(state, splitId)
  let best: TabId | undefined
  for (const id of leaves) {
    const t = state.tabs[id]
    if (!t) continue
    if (!best || t.lastActiveAt > (state.tabs[best]?.lastActiveAt ?? 0)) best = id
  }
  return best
}

/** Tabs sorted the way the sidebar shows them (unknown ones last, keeping their order). */
export function sidebarSorted(state: OrbitState, tabIds: TabId[]): TabId[] {
  const order = new Map<TabId, number>()
  for (const spaceId of state.spaceOrder) {
    for (const [i, id] of sidebarTabOrder(state, spaceId).entries()) if (!order.has(id)) order.set(id, i)
  }
  return tabIds
    .map((id, i) => ({ id, i, o: order.get(id) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.o - b.o || a.i - b.i)
    .map((x) => x.id)
}

/**
 * Removes panes still waiting for their first page (an empty pane whose command bar was open
 * when Orbit quit). Returns the removed tab ids.
 */
export function dropBlankPanes(d: OrbitState): TabId[] {
  const removed: TabId[] = []
  for (const split of Object.values(d.splits)) {
    for (const id of layoutLeaves(split.layout)) {
      if (!isBlankPane(d.tabs[id])) continue
      // A window that was focused on the empty pane focuses its neighbour instead.
      const current = d.splits[split.id]?.layout ?? split.layout
      const neighbor = siblingOf(current, id) ?? layoutLeaves(current).find((t) => t !== id && !isBlankPane(d.tabs[t]))
      for (const win of Object.values(d.windows)) {
        for (const [spaceId, active] of Object.entries(win.activeTab)) {
          if (active === id) win.activeTab[spaceId] = neighbor ?? null
        }
      }
      detachTab(d, id)
      delete d.tabs[id]
      removed.push(id)
    }
  }
  return removed
}

/** Copies a tab (same page, fresh id) for Duplicate. */
export function copyTab(tab: Tab, now = Date.now()): Tab {
  return {
    ...structuredClone(tab),
    id: newId('t'),
    createdAt: now,
    lastActiveAt: now,
    loading: false,
    audible: false,
    asleep: true,
    error: undefined,
    progress: undefined,
  }
}
