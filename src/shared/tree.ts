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

export function removeItem(state: OrbitState, id: ItemId): ItemLocation | undefined {
  const loc = locate(state, id)
  if (!loc) return undefined
  containerItems(state, loc.container)?.splice(loc.index, 1)
  return loc
}

export function insertItem(state: OrbitState, ref: ContainerRef, index: number, id: ItemId): void {
  const list = containerItems(state, ref)
  if (!list) throw new Error(`Unknown container ${JSON.stringify(ref)}`)
  const at = Math.max(0, Math.min(index, list.length))
  list.splice(at, 0, id)
}

/**
 * Moves an item to `to` at `index` (index is in terms of the target list *after* removal).
 * Returns false when the move is invalid (e.g. a folder into itself).
 */
export function moveItem(state: OrbitState, id: ItemId, to: ContainerRef, index: number): boolean {
  if (to.kind === 'folder' && isFolderId(id) && isWithin(state, to.folderId, id)) return false
  if (to.kind === 'favorites' && isFolderId(id)) return false
  if (!containerItems(state, to)) return false
  removeItem(state, id)
  insertItem(state, to, index, id)
  return true
}
