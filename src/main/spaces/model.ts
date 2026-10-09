/**
 * Pure Space and profile model helpers (no Electron imports, unit-tested).
 * Mutating helpers take an Immer draft (or a plain state in tests) and must
 * only be called inside store.update().
 */
import { current, type Draft, isDraft } from 'immer'
import { createProfile, createSpace, DEFAULT_PROFILE_ID, NEW_SPACE_PRESETS, THEME_PRESETS } from '../../shared/defaults'
import { isFolderId, isSplitId, isTabId, newId } from '../../shared/ids'
import type {
  ArchivedTab,
  Folder,
  ItemId,
  OrbitState,
  Profile,
  ProfileId,
  Space,
  SpaceId,
  SpaceTheme,
  Split,
  Tab,
  TabId,
  WindowId,
} from '../../shared/state'
import { normalizeSpaceTheme, sameTheme } from '../../shared/theme'
import { splitLeaves, tabsInItem } from '../../shared/tree'

/** Archive size cap; trimmed in chunks from the oldest end so trims are rare (review F2). */
export const MAX_ARCHIVE = 5000
const ARCHIVE_TRIM = 500

const snapshot = <T>(value: T): T => (isDraft(value) ? (current(value as Draft<T>) as T) : structuredClone(value))

/** "Space N", where N is the Space's position or the next number no other Space uses (SP-02). */
export function placeholderName(state: OrbitState, position: number, exceptId?: SpaceId): string {
  const taken = new Set(
    Object.values(state.spaces)
      .filter((s) => s.id !== exceptId)
      .map((s) => s.name),
  )
  let n = Math.max(1, Math.round(position))
  while (taken.has(`Space ${n}`)) n++
  return `Space ${n}`
}

export interface CreateSpaceOptions {
  name?: string
  icon?: string
  theme?: SpaceTheme
  profileId?: ProfileId
  /** Insert right after this Space (SP-02: next to the active Space); default: at the end. */
  afterSpaceId?: SpaceId
}

export function createSpaceInDraft(d: OrbitState, opts: CreateSpaceOptions, now = Date.now()): Space {
  const after = opts.afterSpaceId && d.spaceOrder.includes(opts.afterSpaceId) ? opts.afterSpaceId : undefined
  const index = after ? d.spaceOrder.indexOf(after) + 1 : d.spaceOrder.length
  const neighbourProfile = after ? d.spaces[after]?.profileId : undefined
  const profileId =
    (opts.profileId && d.profiles[opts.profileId] && opts.profileId) ||
    (neighbourProfile && d.profiles[neighbourProfile] && neighbourProfile) ||
    (d.profiles[DEFAULT_PROFILE_ID] ? DEFAULT_PROFILE_ID : (Object.keys(d.profiles)[0] as string))
  const theme = opts.theme
    ? normalizeSpaceTheme(opts.theme)
    : (THEME_PRESETS[d.spaceOrder.length % NEW_SPACE_PRESETS] as SpaceTheme)
  const name = opts.name?.trim() ?? ''
  const space = createSpace(name || 'Space', profileId, theme, opts.icon ?? '', now)
  if (!name) {
    space.name = placeholderName(d, index + 1)
    space.unnamed = true
  }
  d.spaces[space.id] = space
  d.spaceOrder.splice(index, 0, space.id)
  return space
}

/** Renames a Space; an empty name restores the placeholder (SP-03). */
export function renameSpaceInDraft(d: OrbitState, spaceId: SpaceId, name: string): void {
  const space = d.spaces[spaceId]
  if (!space) return
  const trimmed = name.replace(/\s+/g, ' ').trim()
  if (trimmed) {
    if (space.name !== trimmed) space.name = trimmed
    if (space.unnamed) delete space.unnamed
    return
  }
  if (space.unnamed) return
  space.name = placeholderName(d, d.spaceOrder.indexOf(spaceId) + 1, spaceId)
  space.unnamed = true
}

export function setThemeInDraft(d: OrbitState, spaceId: SpaceId, theme: SpaceTheme): void {
  const space = d.spaces[spaceId]
  if (!space) return
  const next = normalizeSpaceTheme(theme)
  if (!sameTheme(space.theme, next)) space.theme = next
}

export function reorderSpaceInDraft(d: OrbitState, spaceId: SpaceId, index: number): void {
  const from = d.spaceOrder.indexOf(spaceId)
  if (from < 0) return
  const to = Math.max(0, Math.min(Math.round(index), d.spaceOrder.length - 1))
  if (to === from) return
  d.spaceOrder.splice(from, 1)
  d.spaceOrder.splice(to, 0, spaceId)
}

export function switchSpaceInDraft(d: OrbitState, windowId: WindowId, spaceId: SpaceId): boolean {
  const win = d.windows[windowId]
  if (!win || !d.spaces[spaceId] || win.spaceId === spaceId) return false
  win.spaceId = spaceId
  return true
}

/** The Space `delta` steps away from `spaceId` in the user's order, without wrapping. */
export function neighbourSpace(state: OrbitState, spaceId: SpaceId, delta: number): SpaceId | undefined {
  const i = state.spaceOrder.indexOf(spaceId)
  if (i < 0) return undefined
  const j = i + delta
  return j >= 0 && j < state.spaceOrder.length ? state.spaceOrder[j] : undefined
}

// ---- Delete and undo (SP-12) ----

export interface DeletedSpace {
  space: Space
  index: number
  tabs: Tab[]
  folders: Folder[]
  splits: Split[]
  /** Every window that had the Space: was it showing it, and which tab it remembered there. */
  windows: { windowId: WindowId; showing: boolean; activeTab: TabId | null | undefined }[]
  /** Archive entries written for its tabs (removed again on undo). */
  archiveIds: string[]
  deletedAt: number
}

function collectItem(d: OrbitState, id: ItemId, out: Pick<DeletedSpace, 'tabs' | 'folders' | 'splits'>): void {
  if (isTabId(id)) {
    const tab = d.tabs[id]
    if (tab) out.tabs.push(tab)
  } else if (isFolderId(id)) {
    const folder = d.folders[id]
    if (!folder) return
    out.folders.push(folder)
    for (const child of folder.children) collectItem(d, child, out)
  } else if (isSplitId(id)) {
    const split = d.splits[id]
    if (!split) return
    out.splits.push(split)
    for (const tabId of splitLeaves(split.layout)) {
      const tab = d.tabs[tabId]
      if (tab) out.tabs.push(tab)
    }
  }
}

/** Appends archive entries (never unshift: review F2) and trims the oldest in chunks. */
export function appendArchive(d: OrbitState, entries: ArchivedTab[]): void {
  d.archive.push(...entries)
  if (d.archive.length > MAX_ARCHIVE) d.archive.splice(0, Math.max(ARCHIVE_TRIM, d.archive.length - MAX_ARCHIVE))
}

/**
 * Deletes a Space: its pinned items, folders, splits and Today tabs leave the
 * sidebar and its tabs go to the Archive tagged with the Space's name. Windows
 * showing it move to the neighbour on the left (else the right). The profile is
 * kept. Returns what is needed to undo, or undefined (unknown or last Space).
 */
export function deleteSpaceInDraft(d: OrbitState, spaceId: SpaceId, now = Date.now()): DeletedSpace | undefined {
  const space = d.spaces[spaceId]
  const index = d.spaceOrder.indexOf(spaceId)
  if (!space || index < 0 || d.spaceOrder.length <= 1) return undefined
  const items = { tabs: [] as Tab[], folders: [] as Folder[], splits: [] as Split[] }
  for (const id of [...space.pinned, ...space.today]) collectItem(d, id, items)
  const deleted: DeletedSpace = {
    space: snapshot(space),
    index,
    tabs: items.tabs.map(snapshot),
    folders: items.folders.map(snapshot),
    splits: items.splits.map(snapshot),
    windows: [],
    archiveIds: [],
    deletedAt: now,
  }

  d.spaceOrder.splice(index, 1)
  const fallback = d.spaceOrder[Math.max(0, index - 1)] as SpaceId
  for (const win of Object.values(d.windows)) {
    const showing = win.spaceId === spaceId
    if (showing || spaceId in win.activeTab) {
      deleted.windows.push({ windowId: win.id, showing, activeTab: win.activeTab[spaceId] })
    }
    if (showing) win.spaceId = fallback
    delete win.activeTab[spaceId]
  }

  const entries: ArchivedTab[] = []
  for (const tab of deleted.tabs) {
    if (!tab.url || tab.url === 'about:blank') continue
    const id = newId('a')
    deleted.archiveIds.push(id)
    entries.push({
      id,
      url: tab.url,
      title: tab.customTitle ?? tab.title,
      favicon: tab.favicon,
      spaceId,
      spaceName: space.name,
      profileId: tab.profileId,
      archivedAt: now,
      reason: 'closed',
    })
  }
  if (entries.length) appendArchive(d, entries)

  for (const tab of deleted.tabs) delete d.tabs[tab.id]
  for (const folder of deleted.folders) delete d.folders[folder.id]
  for (const split of deleted.splits) delete d.splits[split.id]
  delete d.spaces[spaceId]
  return deleted
}

/** Puts a deleted Space back exactly where it was (SP-12 undo). Returns false if it already exists. */
export function restoreSpaceInDraft(d: OrbitState, deleted: DeletedSpace, windowId?: WindowId): boolean {
  const { space } = deleted
  if (d.spaces[space.id]) return false
  const restored: Space = structuredClone(space)
  if (!d.profiles[restored.profileId]) restored.profileId = DEFAULT_PROFILE_ID
  d.spaces[restored.id] = restored
  d.spaceOrder.splice(Math.min(deleted.index, d.spaceOrder.length), 0, restored.id)
  for (const tab of deleted.tabs) {
    d.tabs[tab.id] = {
      ...structuredClone(tab),
      profileId: restored.profileId,
      spaceId: restored.id,
      asleep: true,
      loading: false,
      audible: false,
      progress: undefined,
      error: undefined,
    }
  }
  for (const folder of deleted.folders) d.folders[folder.id] = structuredClone(folder)
  for (const split of deleted.splits) d.splits[split.id] = structuredClone(split)
  // Archive entries were appended, so they sit at the end: remove from the back (few patches).
  const ids = new Set(deleted.archiveIds)
  for (let i = d.archive.length - 1; i >= 0 && ids.size > 0; i--) {
    const entry = d.archive[i]
    if (entry && ids.delete(entry.id)) d.archive.splice(i, 1)
  }
  for (const w of deleted.windows) {
    const win = d.windows[w.windowId]
    if (!win) continue
    if (w.activeTab !== undefined) win.activeTab[restored.id] = w.activeTab
    if (w.showing || w.windowId === windowId) win.spaceId = restored.id
  }
  const caller = windowId ? d.windows[windowId] : undefined
  if (caller) caller.spaceId = restored.id
  return true
}

// ---- Profiles (PR-*) ----

export function createProfileInDraft(d: OrbitState, name: string, now = Date.now()): Profile {
  const profile = createProfile(name.replace(/\s+/g, ' ').trim() || 'Profile', undefined, now)
  d.profiles[profile.id] = profile
  return profile
}

export function renameProfileInDraft(d: OrbitState, profileId: ProfileId, name: string): void {
  const profile = d.profiles[profileId]
  const trimmed = name.replace(/\s+/g, ' ').trim()
  if (profile && trimmed && profile.name !== trimmed) profile.name = trimmed
}

/**
 * Assigns a Space to a profile (PR-03). Its pinned and Today tabs move with it
 * and must reload in the new profile's session: returns those tab ids.
 */
export function assignProfileInDraft(d: OrbitState, spaceId: SpaceId, profileId: ProfileId): TabId[] {
  const space = d.spaces[spaceId]
  if (!space || !d.profiles[profileId] || space.profileId === profileId) return []
  const oldFavorites = new Set(d.profiles[space.profileId]?.favorites.flatMap((id) => tabsInItem(d, id)) ?? [])
  space.profileId = profileId
  const moved: TabId[] = []
  for (const id of [...space.pinned, ...space.today]) {
    for (const tabId of tabsInItem(d, id)) {
      const tab = d.tabs[tabId]
      if (tab && tab.profileId !== profileId) {
        tab.profileId = profileId
        moved.push(tabId)
      }
    }
  }
  // A window showing one of the old profile's Favorites here no longer shows that tile.
  for (const win of Object.values(d.windows)) {
    const active = win.activeTab[spaceId]
    if (active && oldFavorites.has(active)) win.activeTab[spaceId] = null
  }
  return moved
}

/**
 * Deletes a profile (never the Default one). Spaces still using it fall back
 * to Default, and its Favorites move to Default's grid. Returns the tabs that
 * changed profile (they must be put to sleep so no page keeps the deleted
 * session), or undefined when nothing was deleted.
 */
export function deleteProfileInDraft(d: OrbitState, profileId: ProfileId): { moved: TabId[] } | undefined {
  const profile = d.profiles[profileId]
  const fallback = d.profiles[DEFAULT_PROFILE_ID]
  if (!profile || !fallback || profileId === DEFAULT_PROFILE_ID) return undefined
  const moved: TabId[] = []
  for (const spaceId of d.spaceOrder) {
    if (d.spaces[spaceId]?.profileId === profileId) moved.push(...assignProfileInDraft(d, spaceId, DEFAULT_PROFILE_ID))
  }
  for (const id of profile.favorites) {
    for (const tabId of tabsInItem(d, id)) {
      const tab = d.tabs[tabId]
      if (tab) {
        tab.profileId = DEFAULT_PROFILE_ID
        moved.push(tabId)
      }
    }
  }
  fallback.favorites.push(...profile.favorites)
  delete d.profiles[profileId]
  return { moved }
}

/** Spaces using a profile, in order. */
export function spacesOfProfile(state: OrbitState, profileId: ProfileId): SpaceId[] {
  return state.spaceOrder.filter((id) => state.spaces[id]?.profileId === profileId)
}

// ---- Normalization of stored Spaces (old files keep loading; D12 drops theme.mode) ----

/** Brings every stored Space up to the current shape. Only writes fields that change. */
export function normalizeSpacesInDraft(d: OrbitState): void {
  const fallbackProfile = d.profiles[DEFAULT_PROFILE_ID] ? DEFAULT_PROFILE_ID : Object.keys(d.profiles)[0]
  d.spaceOrder.forEach((spaceId, i) => {
    const space = d.spaces[spaceId]
    if (!space) return
    // Total for any stored shape: a theme without a `colors` array is rewritten, never compared.
    const raw: unknown = space.theme
    const theme = normalizeSpaceTheme(raw)
    const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined
    if (!r || !Array.isArray(r.colors) || 'mode' in r || 'color' in r || !sameTheme(space.theme, theme)) {
      space.theme = theme
    }
    if (typeof space.icon !== 'string') space.icon = ''
    if (!Array.isArray(space.pinned)) space.pinned = []
    if (!Array.isArray(space.today)) space.today = []
    if (typeof space.name !== 'string' || !space.name.trim()) {
      space.name = placeholderName(d, i + 1, spaceId)
      space.unnamed = true
    }
    if (!d.profiles[space.profileId] && fallbackProfile) space.profileId = fallbackProfile
  })
}
