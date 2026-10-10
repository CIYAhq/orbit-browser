/**
 * Private windows (NV-11, SB-25, AP-05). Each private window shows a Space of its own, kept out of
 * the Space order, so no other window lists it. Its profile is "private": an in-memory session
 * partition that every open private window shares and that is wiped when the last one closes.
 * Nothing private is ever written to disk: `withoutPrivate` is what the state file gets.
 */
import type {
  ContainerRef,
  Download,
  ItemId,
  OrbitState,
  Profile,
  ProfileId,
  SpaceId,
  SplitLayout,
  Tab,
  TabId,
  WindowId,
} from './state'
import type { Palette } from './theme'
import { locate, spaceOfContainer } from './tree'

/** Ids of private profiles start with this, so a tab still says it was private after its profile went. */
export const PRIVATE_PROFILE_PREFIX = 'private-'
/** Session partitions of private profiles: no "persist:" prefix, so Chromium keeps them in memory. */
export const PRIVATE_PARTITION_PREFIX = 'orbit-private-'

/** What the private window's sidebar says about it (NV-11: plain about what it does and doesn't hide). */
export const PRIVATE_NOTE =
  'Hides your browsing from other people using this device, not from websites or your network. History, cookies and site data are deleted when the last private window closes.'

export function isPrivateProfileId(id: string | undefined): boolean {
  return !!id && id.startsWith(PRIVATE_PROFILE_PREFIX)
}

/** A profile whose data stays in memory: a private window's, or any profile without a persistent session. */
export function isPrivateProfile(profile: Profile | undefined): boolean {
  return !!profile && (isPrivateProfileId(profile.id) || !profile.partition.startsWith('persist:'))
}

/**
 * A private window's Space. Windows keep apart by this (and `isPrivateTab`): only private windows'
 * own profiles count, so another profile on an in-memory session still shows in normal windows.
 */
export function isPrivateSpace(state: OrbitState, spaceId: SpaceId | undefined): boolean {
  const space = spaceId ? state.spaces[spaceId] : undefined
  return !!space && isPrivateProfileId(space.profileId)
}

export function isPrivateWindow(state: OrbitState, windowId: WindowId | undefined): boolean {
  const win = windowId ? state.windows[windowId] : undefined
  return !!win && (win.kind === 'private' || isPrivateSpace(state, win.spaceId))
}

/** A private window's tab. */
export function isPrivateTab(state: OrbitState, tabId: TabId | undefined): boolean {
  const tab = tabId ? state.tabs[tabId] : undefined
  return !!tab && isPrivateProfileId(tab.profileId)
}

/**
 * Whether a window may show a tab: a private window shows only its own Space's tabs, and no other
 * window ever shows a private tab.
 */
export function windowMayShow(state: OrbitState, windowId: WindowId, tabId: TabId): boolean {
  const win = state.windows[windowId]
  const tab = state.tabs[tabId]
  if (!win || !tab) return false
  if (isPrivateWindow(state, windowId)) return tab.spaceId === win.spaceId
  return !isPrivateTab(state, tabId)
}

const isPrivateContainer = (state: OrbitState, ref: ContainerRef) =>
  ref.kind === 'favorites' ? isPrivateProfileId(ref.profileId) : isPrivateSpace(state, spaceOfContainer(state, ref))

/**
 * Whether items may move into a container (NV-11, SB-25): a private window's tabs stay in its
 * Today (it has no pinned tabs, Favorites or folders), and nothing moves in from elsewhere.
 */
export function privateMoveAllowed(state: OrbitState, items: ItemId[], to: ContainerRef): boolean {
  const toPrivate = isPrivateContainer(state, to)
  return items.every((id) => {
    const at = locate(state, id)
    const fromPrivate = !!at && isPrivateContainer(state, at.container)
    if (!fromPrivate && !toPrivate) return true
    return (
      fromPrivate && toPrivate && to.kind === 'today' && !!at && spaceOfContainer(state, at.container) === to.spaceId
    )
  })
}

/** Tab menu items for what a private window doesn't have: pinned tabs, Favorites, folders, other Spaces. */
const NOT_PRIVATE =
  /^(Pin |Unpin |Add to Favorites|Remove from Favorites|Reset to Pinned URL|Pinned URL|Move to|New Folder with Tabs|Delete from Sidebar|Delete Favorite)/

/** A private tab's menu (SB-25): the tab menu without what a private window doesn't have. */
export function privateTabMenu<T extends { label?: string; type?: string }>(items: T[]): T[] {
  const out: T[] = []
  for (const item of items) {
    if (item.label && NOT_PRIVATE.test(item.label)) continue
    if (item.type === 'separator' && (out.length === 0 || out[out.length - 1]?.type === 'separator')) continue
    out.push(item)
  }
  while (out[out.length - 1]?.type === 'separator') out.pop()
  return out
}

/** A closed private tab whose window (Space) is gone: it never comes back (NV-11). */
export function isLostPrivateTab(state: OrbitState, tab: Pick<Tab, 'profileId' | 'spaceId'>): boolean {
  return isPrivateProfileId(tab.profileId) && (!state.spaces[tab.spaceId] || !state.profiles[tab.profileId])
}

/**
 * Whether a closed tab may come back in a window (Reopen Closed Tab): a private tab only in its
 * own private window, a normal tab only in a normal window (NV-11).
 */
export function mayReopenIn(
  state: OrbitState,
  tab: Pick<Tab, 'profileId' | 'spaceId'>,
  windowId: WindowId | undefined,
): boolean {
  const privateTab = isPrivateProfileId(tab.profileId) || isPrivateSpace(state, tab.spaceId)
  const win = windowId ? state.windows[windowId] : undefined
  if (!privateTab) return !isPrivateWindow(state, windowId)
  return !!win && win.spaceId === tab.spaceId && !isLostPrivateTab(state, tab)
}

/**
 * The private window's look (AP-05): near-black whatever the theme or light/dark setting, with
 * hover and selection tuned to read on black.
 */
export const PRIVATE_PALETTE: Palette = {
  dark: true,
  frameTop: '#141417',
  frameMid: '#111114',
  frameBottom: '#0e0e10',
  windowBackground: '#141417',
  accent: '#a78bfa',
  selection: '#a78bfa55',
  surface: '#202025',
  text: '#f2f2f5',
  textMuted: 'rgba(242,242,245,0.62)',
  hover: 'rgba(255,255,255,0.09)',
  active: 'rgba(255,255,255,0.16)',
  activeShadow: '0 1px 2px rgba(0,0,0,0.5)',
  divider: 'rgba(255,255,255,0.1)',
  grain: 0,
}

function layoutLeaves(layout: SplitLayout): TabId[] {
  return layout.type === 'leaf' ? [layout.tabId] : layout.children.flatMap(layoutLeaves)
}

/**
 * The state with every private window, Space, profile, tab, folder and split left out (and any
 * Archive entry that names a private profile, and the downloads of a private session, DL-16): what
 * may be written to disk. Returns `state` itself when there is nothing private.
 */
export function withoutPrivate(state: OrbitState): OrbitState {
  const profiles = new Set(Object.keys(state.profiles).filter(isPrivateProfileId))
  const isPrivate = (profileId: ProfileId) => isPrivateProfileId(profileId)
  const spaces = new Set(
    Object.values(state.spaces)
      .filter((s) => isPrivate(s.profileId))
      .map((s) => s.id),
  )
  const tabs = new Set(
    Object.values(state.tabs)
      .filter((t) => isPrivate(t.profileId) || spaces.has(t.spaceId))
      .map((t) => t.id),
  )
  const windows = new Set(
    Object.values(state.windows)
      .filter((w) => w.kind === 'private' || spaces.has(w.spaceId))
      .map((w) => w.id),
  )
  const archive = state.archive.some((a) => isPrivate(a.profileId) || spaces.has(a.spaceId))
  // A download from any session kept in memory, a private window's or another (DL-16).
  const isPrivateDownload = (d: Download) => !!d.private || isPrivate(d.profileId)
  const downloads = Object.values(state.downloads).some(isPrivateDownload)
  if (profiles.size + spaces.size + tabs.size + windows.size === 0 && !archive && !downloads) return state

  // Folders and splits have no Space of their own: they go with the private Spaces holding them.
  const items = new Set<ItemId>()
  const visit = (ids: ItemId[]) => {
    for (const id of ids) {
      if (items.has(id)) continue
      items.add(id)
      const folder = state.folders[id]
      if (folder) visit(folder.children)
    }
  }
  for (const id of spaces) {
    const space = state.spaces[id]
    if (space) visit([...space.pinned, ...space.today])
  }
  for (const id of profiles) visit(state.profiles[id]?.favorites ?? [])

  const keep = <T>(record: Record<string, T>, drop: (id: string, value: T) => boolean): Record<string, T> => {
    const out: Record<string, T> = {}
    for (const [id, value] of Object.entries(record)) if (!drop(id, value)) out[id] = value
    return out
  }
  const out: OrbitState = {
    ...state,
    profiles: keep(state.profiles, (id) => profiles.has(id)),
    spaces: keep(state.spaces, (id) => spaces.has(id)),
    spaceOrder: state.spaceOrder.filter((id) => !spaces.has(id)),
    tabs: keep(state.tabs, (id) => tabs.has(id)),
    folders: keep(state.folders, (id) => items.has(id)),
    splits: keep(
      state.splits,
      (id, split) => items.has(id) || layoutLeaves(split.layout).some((tabId) => tabs.has(tabId)),
    ),
    windows: keep(state.windows, (id) => windows.has(id)),
    archive: archive ? state.archive.filter((a) => !isPrivate(a.profileId) && !spaces.has(a.spaceId)) : state.archive,
    downloads: downloads ? keep(state.downloads, (_id, d) => isPrivateDownload(d)) : state.downloads,
  }
  // A normal window never shows a private tab, but its remembered tabs per Space must not name one.
  for (const [id, win] of Object.entries(out.windows)) {
    const stale = Object.entries(win.activeTab).filter(
      ([spaceId, tabId]) => spaces.has(spaceId) || (tabId && tabs.has(tabId)),
    )
    if (stale.length === 0) continue
    const activeTab = { ...win.activeTab }
    for (const [spaceId] of stale) delete activeTab[spaceId]
    out.windows[id] = { ...win, activeTab }
  }
  return out
}
