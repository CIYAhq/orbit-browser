/**
 * Split View state helpers operating on state drafts (no Electron imports, unit-testable).
 * A split is one sidebar item (`v-` id) whose panes are tabs that sit in no container
 * themselves. Every helper keeps the invariants: 2–4 panes per split, canonical layout,
 * a tab in at most one place.
 */
import { produce } from 'immer'
import { MAX_FAVORITES } from '../../shared/defaults'
import { newId } from '../../shared/ids'
import {
  anchorOf,
  insertBeside,
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
    if (split.focus === tabId) delete split.focus
    if (split.pending === tabId) delete split.pending
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

/**
 * Whether a Favorite split coming apart into `tiles` tiles would take its profile past the
 * Favorites limit (FV-02). A split anywhere else never counts.
 */
export function overflowsFavorites(d: OrbitState, splitId: SplitId, tiles: number): boolean {
  const loc = locate(d, splitId)
  if (loc?.container.kind !== 'favorites') return false
  const count = d.profiles[loc.container.profileId]?.favorites.length ?? 0
  return count - 1 + tiles > MAX_FAVORITES
}

/** Whether `container` is a Favorites grid with no room for one more tile (FV-02). */
export function favoritesFull(d: OrbitState, container: ContainerRef): boolean {
  return container.kind === 'favorites' && (d.profiles[container.profileId]?.favorites.length ?? 0) >= MAX_FAVORITES
}

/**
 * Whether `recipe` would take a profile's Favorites past the limit (FV-02). It runs on a
 * throwaway copy of the state; only a grid that grows counts.
 */
export function growsFavoritesPastLimit(d: OrbitState, recipe: (draft: OrbitState) => void): boolean {
  const after = produce(d, recipe)
  return Object.values(after.profiles).some(
    (p) => p.favorites.length > MAX_FAVORITES && p.favorites.length > (d.profiles[p.id]?.favorites.length ?? 0),
  )
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
      // Only a pane that was waiting for the command bar; a page showing about:blank is a real tab.
      if (split.pending !== id) continue
      // A window that was focused on the empty pane focuses its neighbour instead.
      const current = d.splits[split.id]?.layout ?? split.layout
      const neighbor = siblingOf(current, id) ?? layoutLeaves(current).find((t) => t !== id)
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

/** The pane a drop targets: the tab itself, or for a split row its first or last pane by side. */
export function splitAnchor(state: OrbitState, target: ItemId, side: PaneSide): TabId | undefined {
  const split = state.splits[target]
  if (!split) return state.tabs[target] ? target : undefined
  const order = paneOrder(split.layout)
  return side === 'left' || side === 'top' ? order[0] : order[order.length - 1]
}

// ---- Closing and reopening panes with the tab model (SV-17, SV-19) ----

/** Where a pane closed on its own sat: beside the group `targets` of split `splitId`. */
export interface PaneAnchor {
  splitId: SplitId
  targets: TabId[]
  side: PaneSide
}

/** A whole split closed as one unit (Close Split): reopening brings it back as it was. */
export interface SplitUnit {
  id: SplitId
  layout: SplitLayout
  name?: string
  focus?: TabId
  location?: ItemLocation
  tabIds: TabId[]
}

/**
 * For tabs about to close: which are panes closing on their own (with the spot to restore them
 * to) and which close together with every other pane of their split (one unit).
 */
export function splitCloseInfo(
  state: OrbitState,
  closing: Set<TabId>,
): Map<TabId, { pane?: PaneAnchor; unit?: SplitUnit }> {
  const out = new Map<TabId, { pane?: PaneAnchor; unit?: SplitUnit }>()
  for (const split of Object.values(state.splits)) {
    const leaves = layoutLeaves(split.layout)
    const leaving = leaves.filter((id) => closing.has(id))
    if (leaving.length === 0) continue
    if (leaving.length === leaves.length) {
      const unit: SplitUnit = {
        id: split.id,
        layout: split.layout,
        name: split.name,
        focus: split.focus,
        location: locate(state, split.id),
        tabIds: leaves.filter((id) => split.pending !== id),
      }
      for (const id of leaves) out.set(id, { unit })
      continue
    }
    let layout: SplitLayout | null = split.layout
    for (const id of leaving) {
      const anchor = layout ? anchorOf(layout, id) : undefined
      if (anchor) out.set(id, { pane: { splitId: split.id, targets: anchor.targets, side: anchor.side } })
      layout = layout ? removePane(layout, id) : null
    }
  }
  return out
}

/**
 * Puts a reopened tab (in state, in no container yet) back beside its old neighbours: into its
 * split, or into a split re-formed around the neighbour if that split dissolved. Returns where it
 * landed, or undefined (nothing changed: the caller places the tab as an ordinary tab).
 */
export function restorePaneInDraft(d: OrbitState, tabId: TabId, anchor: PaneAnchor): ContainerRef | undefined {
  const targets = anchor.targets.filter((id) => id !== tabId && d.tabs[id])
  if (targets.length === 0 || splitOfTab(d, tabId) || locate(d, tabId)) return undefined
  const home = targets.some((id) => splitOfTab(d, id) === anchor.splitId) ? anchor.splitId : undefined
  const splitId = home ?? splitOfTab(d, targets[0] as TabId)
  if (splitId) {
    const split = d.splits[splitId]
    if (!split) return undefined
    const leaves = layoutLeaves(split.layout)
    if (leaves.length >= MAX_PANES) return undefined
    const next = insertBeside(
      split.layout,
      targets.filter((id) => leaves.includes(id)),
      tabId,
      anchor.side,
    )
    if (!layoutLeaves(next).includes(tabId)) return undefined
    split.layout = next
    const container = locate(d, splitId)?.container
    adoptPlacement(d, [tabId], container)
    return container
  }
  const target = targets[0] as TabId
  if (!locate(d, target)) return undefined
  const created = createSplitInDraft(d, [target, tabId], {
    at: target,
    layout: insertPane(leaf(target), target, tabId, anchor.side),
  })
  return isFailure(created) ? undefined : locate(d, created)?.container
}

/**
 * Brings back a split closed as one unit once its tabs are back in state (and in no container):
 * same arrangement, sizes, name and place. Returns where it landed, or undefined when fewer than
 * two of its tabs came back (the caller places them as ordinary tabs).
 */
export function restoreUnitInDraft(d: OrbitState, unit: SplitUnit, now = Date.now()): ContainerRef | undefined {
  const present = unit.tabIds.filter((id) => d.tabs[id] && !splitOfTab(d, id) && !locate(d, id))
  if (present.length < 2) return undefined
  let layout: SplitLayout | null = unit.layout
  for (const id of layoutLeaves(unit.layout)) if (!present.includes(id) && layout) layout = removePane(layout, id)
  const canonical = normalizeLayout(layout)
  if (!canonical || canonical.type === 'leaf') return undefined
  const first = present[0] as TabId
  // Its old place, unless that is a full Favorites grid (FV-02): then Today.
  const where =
    unit.location && containerItems(d, unit.location.container) && !favoritesFull(d, unit.location.container)
      ? unit.location
      : (() => {
          const today = todayOf(d, first)
          return today ? { container: today, index: 0 } : undefined
        })()
  if (!where) return undefined
  const id = d.splits[unit.id] ? newId('v') : unit.id
  insertItem(d, where.container, where.index, id)
  d.splits[id] = {
    id,
    layout: canonical,
    createdAt: now,
    ...(unit.name ? { name: unit.name } : {}),
    ...(unit.focus && present.includes(unit.focus) ? { focus: unit.focus } : {}),
  }
  adoptPlacement(d, present, where.container)
  return where.container
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
