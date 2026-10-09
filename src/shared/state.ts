/**
 * Orbit's application state. The main process owns the single source of truth
 * (see src/main/store.ts); renderers hold a read-only mirror kept in sync with
 * Immer patches. Everything here must be plain JSON (no class instances).
 *
 * IDs carry a type prefix (see ids.ts): t- tab, f- folder, v- split view,
 * s- space, p- profile, w- window. Sidebar containers hold ordered ItemId lists.
 */

export type TabId = string
export type FolderId = string
export type SplitId = string
export type SpaceId = string
export type ProfileId = string
export type WindowId = string
/** Anything that can sit in a sidebar list: a tab, a folder or a split view. */
export type ItemId = TabId | FolderId | SplitId

/** Where an item lives in the sidebar. */
export type ContainerRef =
  | { kind: 'favorites'; profileId: ProfileId }
  | { kind: 'pinned'; spaceId: SpaceId }
  | { kind: 'today'; spaceId: SpaceId }
  | { kind: 'folder'; folderId: FolderId }

/** Top-level section a tab belongs to (derived from its container). */
export type TabSection = 'favorite' | 'pinned' | 'today'

export interface Tab {
  id: TabId
  spaceId: SpaceId
  profileId: ProfileId
  /** Current URL (what the page is showing now). */
  url: string
  title: string
  /** Favicon as data: URL or https URL. */
  favicon?: string
  /** For pinned tabs and favorites: the URL the tab resets to. */
  pinnedUrl?: string
  /** User-chosen name (overrides the page title). */
  customTitle?: string
  /** Pinned tabs and favorites: title of the pinned page (the breadcrumb's first part, PN-03). */
  pinnedTitle?: string
  /** Pinned tabs and favorites: where the pinned URL resolved to after redirects (PN-03). */
  pinnedResolvedUrl?: string
  /** User-chosen emoji that replaces the favicon (TB-12). */
  icon?: string
  /** Tab whose link opened this tab (TB-19). */
  openerTabId?: TabId
  createdAt: number
  lastActiveAt: number
  /** Runtime-only fields (not persisted): */
  loading: boolean
  audible: boolean
  muted: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** True when the tab has no live web contents (never loaded, slept or discarded). */
  asleep: boolean
  /** Page load progress 0..1 while loading (best effort). */
  progress?: number
  /** Set when the page crashed or failed to load. */
  error?: { code: number; description: string }
}

export interface Folder {
  id: FolderId
  name: string
  children: ItemId[]
  collapsed: boolean
  createdAt: number
  /** User-chosen emoji for the folder (FD-07). */
  icon?: string
}

/** Split view layout tree. Leaves are tabs; max 4 leaves per split. */
export type SplitLayout =
  | { type: 'leaf'; tabId: TabId }
  | { type: 'row' | 'column'; children: SplitLayout[]; sizes: number[] }

export interface Split {
  id: SplitId
  layout: SplitLayout
  createdAt: number
}

export type ColorMode = 'system' | 'light' | 'dark'

/**
 * A Space's colours. Light/dark is not part of it: that is the one global
 * `settings.appearance`, and every theme has a light and a dark rendition
 * (see src/shared/theme.ts).
 */
export interface SpaceTheme {
  /** Zero to three colours (#rrggbb), blended top to bottom. Empty = the neutral default theme. */
  colors: string[]
  /** How strongly the colours show: 0 = faint wash … 1 = full. */
  intensity: number
  /** Static grain texture over the sidebar and frame: 0 = none … 1 = strong. */
  grain: number
}

export interface Space {
  id: SpaceId
  name: string
  /** True while `name` is an automatic placeholder ("Space 3") the user never chose. */
  unnamed?: boolean
  /** Emoji or a short icon key. */
  icon: string
  theme: SpaceTheme
  profileId: ProfileId
  pinned: ItemId[]
  today: ItemId[]
  createdAt: number
  /** Pinned section collapsed under the Space title (PN-09). */
  pinnedCollapsed?: boolean
}

export interface Profile {
  id: ProfileId
  name: string
  /** Electron session partition, e.g. "persist:orbit-p-default". */
  partition: string
  /** Favorites are shared by every Space that uses this profile. */
  favorites: ItemId[]
  createdAt: number
  /** Per-profile auto-archive period for Today tabs (TD-03); falls back to settings.archiveAfterMs. */
  archiveAfterMs?: number
}

export type CommandBarMode = 'new-tab' | 'edit-url' | 'search-tabs'

export type OverlayState =
  | { kind: 'none' }
  | { kind: 'commandbar'; mode: CommandBarMode; query: string; nonce: number }
  | { kind: 'peek'; tabId: TabId; nonce: number }
  | { kind: 'panel'; panel: string; nonce: number; params?: Record<string, string | number | boolean> }

export interface SidebarState {
  /** Docked and visible (true) or hidden/auto-hiding (false). */
  visible: boolean
  width: number
  /** When hidden: true while revealed by hovering the window edge. */
  peeking: boolean
}

export interface WindowState {
  id: WindowId
  kind: 'main' | 'mini'
  spaceId: SpaceId
  /** Active (focused) tab per space, remembered across space switches. */
  activeTab: Record<SpaceId, TabId | null>
  sidebar: SidebarState
  overlay: OverlayState
  /** Last normal-state window bounds (screen DIP), restored on relaunch. */
  bounds?: { x: number; y: number; width: number; height: number }
  maximized?: boolean
  /** Runtime-only: */
  focused: boolean
  fullscreen: boolean
}

export type SearchEngineId = 'google' | 'duckduckgo' | 'bing' | 'brave' | 'ecosia' | 'kagi'

export interface Settings {
  searchEngine: SearchEngineId
  /** Archive unpinned (Today) tabs not used for this long. 0 = never. */
  archiveAfterMs: number
  /** Put background tabs to sleep after this long. 0 = never. */
  sleepAfterMs: number
  appearance: ColorMode
  /** Open external links clicked in pinned tabs/favorites in Peek. */
  peekExternalLinks: boolean
  /** Auto picture-in-picture when leaving a tab that plays video. */
  autoPip: boolean
  /** Links opened from other apps open in a Mini Window. */
  miniWindowForExternalLinks: boolean
  onboarded: boolean
  /** ⌘1–⌘8 count Favorites first (TB-04, FV-10). */
  countFavoritesInShortcuts: boolean
  /** ⌘9 selects the last tab (true) or the 9th item (false) (TB-04). */
  lastTabOnCmd9: boolean
}

export interface ArchivedTab {
  id: string
  url: string
  title: string
  /** Not stored by the tabs lane (keeps state small): look icons up with `tabs.favicon`. */
  favicon?: string
  spaceId: SpaceId
  /** Name of the Space at archive time (kept when the Space itself is deleted). */
  spaceName?: string
  profileId: ProfileId
  archivedAt: number
  reason: 'auto' | 'closed' | 'cleared'
  /** Section the tab left from (AR-01). */
  section?: 'today' | 'pinned'
}

export interface Download {
  id: string
  url: string
  filename: string
  savePath: string
  state: 'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted'
  receivedBytes: number
  totalBytes: number
  startedAt: number
}

/** Per-site customisation ("Tweak"): CSS/JS applied to matching hosts. */
export interface Tweak {
  id: string
  host: string
  name: string
  enabled: boolean
  css: string
  js: string
  createdAt: number
}

export interface OrbitState {
  /** Schema version of the persisted state. */
  schema: number
  windows: Record<WindowId, WindowState>
  spaces: Record<SpaceId, Space>
  spaceOrder: SpaceId[]
  profiles: Record<ProfileId, Profile>
  tabs: Record<TabId, Tab>
  folders: Record<FolderId, Folder>
  splits: Record<SplitId, Split>
  /** Oldest first: new entries are appended (cheap patches) and the list is trimmed in chunks. */
  archive: ArchivedTab[]
  settings: Settings
  downloads: Record<string, Download>
  tweaks: Record<string, Tweak>
}

export const STATE_SCHEMA = 1
