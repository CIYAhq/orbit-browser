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
  /** User-chosen name for a pinned tab or favorite (overrides the page title). */
  customTitle?: string
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

export interface SpaceTheme {
  /** Base colour as #rrggbb. */
  color: string
  /** Optional second colour for a gradient. */
  color2?: string
  mode: ColorMode
}

export interface Space {
  id: SpaceId
  name: string
  /** Emoji or a short icon key. */
  icon: string
  theme: SpaceTheme
  profileId: ProfileId
  pinned: ItemId[]
  today: ItemId[]
  createdAt: number
}

export interface Profile {
  id: ProfileId
  name: string
  /** Electron session partition, e.g. "persist:orbit-p-default". */
  partition: string
  /** Favorites are shared by every Space that uses this profile. */
  favorites: ItemId[]
  createdAt: number
}

export type CommandBarMode = 'new-tab' | 'edit-url' | 'search-tabs'

export type OverlayState =
  | { kind: 'none' }
  | { kind: 'commandbar'; mode: CommandBarMode; query: string; nonce: number }
  | { kind: 'peek'; tabId: TabId; nonce: number }
  | { kind: 'panel'; panel: string; nonce: number }

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

/** Site search (CB-11, ST-06): type the keyword in the command bar, press Tab, then the query. */
export interface SiteSearchEngine {
  id: string
  name: string
  keyword: string
  /** Results URL with %s where the query goes. */
  url: string
}

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
  /** Command bar site searches (CB-11); edited in Settings (ST-06). */
  siteSearch: SiteSearchEngine[]
  /** Ask the search engine for suggestions while typing in the command bar (CB-15). Off by default: it sends keystrokes to the engine. */
  searchSuggestions: boolean
  /** ⇧Enter on a search opens the engine's first result directly where the engine supports it (CB-16). Off by default. */
  searchTopResult: boolean
}

export interface ArchivedTab {
  id: string
  url: string
  title: string
  favicon?: string
  spaceId: SpaceId
  profileId: ProfileId
  archivedAt: number
  reason: 'auto' | 'closed'
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
  archive: ArchivedTab[]
  settings: Settings
  downloads: Record<string, Download>
  tweaks: Record<string, Tweak>
}

export const STATE_SCHEMA = 1
