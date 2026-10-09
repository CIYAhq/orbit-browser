/**
 * Pure helpers for the sidebar item tree. They work on plain state objects and
 * on Immer drafts (mutating helpers are named as verbs and must only be called
 * on drafts inside store.update()).
 */
import { isFolderId, isSplitId, isTabId } from './ids'
import type {
  ContainerRef,
  FolderId,
  ItemId,
  OrbitState,
  ProfileId,
  SpaceId,
  SplitId,
  SplitLayout,
  TabId,
  TabSection,
} from './state'

export interface ItemLocation {
  container: ContainerRef
  index: number
}

export function containerItems(state: OrbitState, ref: ContainerRef): ItemId[] | undefined {
  switch (ref.kind) {
    case 'favorites':
      return state.profiles[ref.profileId]?.favorites
    case 'pinned':
      return state.spaces[ref.spaceId]?.pinned
    case 'today':
      return state.spaces[ref.spaceId]?.today
    case 'folder':
      return state.folders[ref.folderId]?.children
  }
}

export function sameContainer(a: ContainerRef, b: ContainerRef): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'favorites':
      return a.profileId === (b as typeof a).profileId
    case 'pinned':
    case 'today':
      return a.spaceId === (b as typeof a).spaceId
    case 'folder':
      return a.folderId === (b as typeof a).folderId
  }
}

/** Finds the container that directly holds an item (tabs inside a split are not "located"; see splitOfTab). */
export function locate(state: OrbitState, id: ItemId): ItemLocation | undefined {
  for (const p of Object.values(state.profiles)) {
    const i = p.favorites.indexOf(id)
    if (i >= 0) return { container: { kind: 'favorites', profileId: p.id }, index: i }
  }
  for (const s of Object.values(state.spaces)) {
    let i = s.pinned.indexOf(id)
    if (i >= 0) return { container: { kind: 'pinned', spaceId: s.id }, index: i }
    i = s.today.indexOf(id)
    if (i >= 0) return { container: { kind: 'today', spaceId: s.id }, index: i }
  }
  for (const f of Object.values(state.folders)) {
    const i = f.children.indexOf(id)
    if (i >= 0) return { container: { kind: 'folder', folderId: f.id }, index: i }
  }
  return undefined
}

/** Top-level section of an item (folders are resolved to their root section). */
export function sectionOf(state: OrbitState, id: ItemId): TabSection | undefined {
  let current: ItemId = id
  const split = isTabId(id) ? splitOfTab(state, id) : undefined
  if (split) current = split
  for (let depth = 0; depth < 64; depth++) {
    const loc = locate(state, current)
    if (!loc) return undefined
    switch (loc.container.kind) {
      case 'favorites':
        return 'favorite'
      case 'pinned':
        return 'pinned'
      case 'today':
        return 'today'
      case 'folder':
        current = loc.container.folderId
    }
  }
  return undefined
}

/** Space whose sidebar shows this container (favorites belong to every space of the profile, so undefined). */
export function spaceOfContainer(state: OrbitState, ref: ContainerRef): SpaceId | undefined {
  if (ref.kind === 'pinned' || ref.kind === 'today') return ref.spaceId
  if (ref.kind === 'favorites') return undefined
  const loc = locate(state, ref.folderId)
  return loc ? spaceOfContainer(state, loc.container) : undefined
}

export function profileOfContainer(state: OrbitState, ref: ContainerRef): ProfileId | undefined {
  if (ref.kind === 'favorites') return ref.profileId
  const spaceId = spaceOfContainer(state, ref)
  return spaceId ? state.spaces[spaceId]?.profileId : undefined
}

export function splitLeaves(layout: SplitLayout): TabId[] {
  if (layout.type === 'leaf') return [layout.tabId]
  return layout.children.flatMap(splitLeaves)
}

export function splitOfTab(state: OrbitState, tabId: TabId): SplitId | undefined {
  for (const s of Object.values(state.splits)) {
    if (splitLeaves(s.layout).includes(tabId)) return s.id
  }
  return undefined
}

/** All tabs contained in an item: a tab, a folder (recursively) or a split view. */
export function tabsInItem(state: OrbitState, id: ItemId): TabId[] {
  if (isTabId(id)) return state.tabs[id] ? [id] : []
  if (isSplitId(id)) {
    const split = state.splits[id]
    return split ? splitLeaves(split.layout) : []
  }
  if (isFolderId(id)) {
    const folder = state.folders[id]
    return folder ? folder.children.flatMap((child) => tabsInItem(state, child)) : []
  }
  return []
}

/** True if `ancestor` is `id` or contains it (folders only). */
export function isWithin(state: OrbitState, id: ItemId, ancestor: FolderId): boolean {
  if (id === ancestor) return true
  let current: ItemId = id
  for (let depth = 0; depth < 64; depth++) {
    const loc = locate(state, current)
    if (loc?.container.kind !== 'folder') return false
    if (loc.container.folderId === ancestor) return true
    current = loc.container.folderId
  }
  return false
}

/** Tab order as shown in a space's sidebar (favorites, pinned, today; collapsed folders included). */
export function sidebarTabOrder(state: OrbitState, spaceId: SpaceId): TabId[] {
  const space = state.spaces[spaceId]
  if (!space) return []
  const profile = state.profiles[space.profileId]
  const ids = [...(profile?.favorites ?? []), ...space.pinned, ...space.today]
  return ids.flatMap((id) => tabsInItem(state, id))
}

// ---- Draft mutations (call inside store.update) ----

/**
 * Replaces a container's list. On an Immer draft this yields one `replace` patch instead
 * of one patch per shifted index (inserting at the top of a 200-tab Today list would
 * otherwise emit 201 patches).
 */
export function setContainerItems(state: OrbitState, ref: ContainerRef, items: ItemId[]): void {
  switch (ref.kind) {
    case 'favorites': {
      const p = state.profiles[ref.profileId]
      if (p) p.favorites = items
      return
    }
    case 'pinned':
    case 'today': {
      const s = state.spaces[ref.spaceId]
      if (s) s[ref.kind] = items
      return
    }
    case 'folder': {
      const f = state.folders[ref.folderId]
      if (f) f.children = items
    }
  }
}

export function removeItem(state: OrbitState, id: ItemId): ItemLocation | undefined {
  const loc = locate(state, id)
  if (!loc) return undefined
  const list = containerItems(state, loc.container)
  if (!list) return undefined
  if (loc.index === list.length - 1) list.pop()
  else setContainerItems(state, loc.container, [...list.slice(0, loc.index), ...list.slice(loc.index + 1)])
  return loc
}

export function insertItem(state: OrbitState, ref: ContainerRef, index: number, id: ItemId): void {
  const list = containerItems(state, ref)
  if (!list) throw new Error(`Unknown container ${JSON.stringify(ref)}`)
  const at = Math.max(0, Math.min(index, list.length))
  if (at === list.length) list.push(id)
  else setContainerItems(state, ref, [...list.slice(0, at), id, ...list.slice(at)])
}

/**
 * Moves an item to `to` at `index` (index is in terms of the target list *after* removal).
 * Returns false when the move is invalid (e.g. a folder into itself).
 */
export function moveItem(state: OrbitState, id: ItemId, to: ContainerRef, index: number): boolean {
  if (!canMoveTo(state, id, to)) return false
  removeItem(state, id)
  insertItem(state, to, index, id)
  return true
}

/**
 * Whether an item may live in a container. Folders exist only in the pinned area
 * (FD-01): never in Favorites or Today, and never inside themselves.
 */
export function canMoveTo(state: OrbitState, id: ItemId, to: ContainerRef): boolean {
  if (!containerItems(state, to)) return false
  // Unknown ids and split panes (which live inside a split, not in a container) can't move on their own.
  if (!locate(state, id)) return false
  if (isFolderId(id)) {
    if (to.kind === 'favorites' || to.kind === 'today') return false
    if (to.kind === 'folder' && isWithin(state, to.folderId, id)) return false
  }
  // The Favorites grid holds tabs only (a split pane can't be favorited on its own).
  if (isSplitId(id) && to.kind === 'favorites') return false
  if (to.kind === 'folder') {
    // A folder must itself sit in a pinned area.
    const root = rootContainerOf(state, { kind: 'folder', folderId: to.folderId })
    if (root && root.kind !== 'pinned') return false
  }
  return true
}

/** The top-level container (favorites, pinned or today) that a container sits in. */
export function rootContainerOf(state: OrbitState, ref: ContainerRef): ContainerRef | undefined {
  let current = ref
  for (let depth = 0; depth < 64; depth++) {
    if (current.kind !== 'folder') return current
    const loc = locate(state, current.folderId)
    if (!loc) return undefined
    current = loc.container
  }
  return undefined
}

/** Key that identifies a container (stable string, handy for maps and DOM attributes). */
export function containerKey(ref: ContainerRef): string {
  switch (ref.kind) {
    case 'favorites':
      return `favorites:${ref.profileId}`
    case 'pinned':
      return `pinned:${ref.spaceId}`
    case 'today':
      return `today:${ref.spaceId}`
    case 'folder':
      return `folder:${ref.folderId}`
  }
}

export function parseContainerKey(key: string): ContainerRef | undefined {
  const i = key.indexOf(':')
  const kind = key.slice(0, i)
  const id = key.slice(i + 1)
  if (!id) return undefined
  if (kind === 'favorites') return { kind, profileId: id }
  if (kind === 'pinned' || kind === 'today') return { kind, spaceId: id }
  if (kind === 'folder') return { kind, folderId: id }
  return undefined
}

// ---- Visible order (what the sidebar shows, top to bottom) ----

export interface VisibleOrderOptions {
  /** The window's selected tab: it stays visible inside a collapsed folder or pinned section (FD-04, PN-09). */
  activeTabId?: TabId | null
  /** Count Favorites first (default true). */
  includeFavorites?: boolean
}

/** The tab a split view stands for in keyboard order: its most recently used pane. */
function splitStop(state: OrbitState, splitId: SplitId): TabId[] {
  const split = state.splits[splitId]
  if (!split) return []
  const leaves = splitLeaves(split.layout).filter((id) => state.tabs[id])
  if (leaves.length === 0) return []
  const best = leaves.reduce((a, b) =>
    (state.tabs[b]?.lastActiveAt ?? 0) > (state.tabs[a]?.lastActiveAt ?? 0) ? b : a,
  )
  return [best]
}

function visibleIn(state: OrbitState, items: ItemId[], active: TabId | null | undefined): TabId[] {
  const out: TabId[] = []
  for (const id of items) {
    if (isTabId(id)) {
      if (state.tabs[id]) out.push(id)
    } else if (isSplitId(id)) {
      out.push(...splitStop(state, id))
    } else if (isFolderId(id)) {
      const folder = state.folders[id]
      if (!folder) continue
      if (!folder.collapsed) out.push(...visibleIn(state, folder.children, active))
      else if (active && tabsInItem(state, id).includes(active)) out.push(active)
    }
  }
  return out
}

/** Tabs per section in the order the sidebar shows them, skipping rows hidden in collapsed sections. */
export function visibleSections(
  state: OrbitState,
  spaceId: SpaceId,
  opts: VisibleOrderOptions = {},
): { favorites: TabId[]; pinned: TabId[]; today: TabId[] } {
  const space = state.spaces[spaceId]
  if (!space) return { favorites: [], pinned: [], today: [] }
  const active = opts.activeTabId
  const favorites = visibleIn(state, state.profiles[space.profileId]?.favorites ?? [], active)
  let pinned = visibleIn(state, space.pinned, active)
  if (space.pinnedCollapsed) pinned = active && pinned.includes(active) ? [active] : []
  const today = visibleIn(state, space.today, active)
  return { favorites: opts.includeFavorites === false ? [] : favorites, pinned, today }
}

export function visibleTabOrder(state: OrbitState, spaceId: SpaceId, opts: VisibleOrderOptions = {}): TabId[] {
  const s = visibleSections(state, spaceId, opts)
  return [...s.favorites, ...s.pinned, ...s.today]
}
