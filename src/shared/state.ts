/**
 * Orbit's application state. The main process owns the single source of truth
 * (see src/main/store.ts); renderers hold a read-only mirror kept in sync with
 * Immer patches. Everything here must be plain JSON (no class instances).
 *
 * IDs carry a type prefix (see ids.ts): t- tab, f- folder, v- split view,
 * s- space, p- profile, w- window. Sidebar containers hold ordered ItemId lists.
 */

import type { PermissionPrompt } from './site'
import type { UpdateStatus, WhatsNew } from './updates'

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
  /** The page's background colour (#rrggbb) when last seen: fills its card while it draws (SB-19). */
  pageColor?: string
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
  /** Runtime-only: pop-ups the page tried to open without a click since it loaded (NV-09). */
  blockedPopups?: number
  /** Runtime-only: the permission prompt waiting for an answer on this tab (NV-15). */
  permissionPrompt?: PermissionPrompt
  /**
   * Runtime-only: where a navigation Orbit started (typed, Back, Reload…) is going before it
   * commits; the address display shows it (NV-04).
   */
  pendingUrl?: string
  /** Runtime-only: the page's media, PiP and tray state (media lane, see shared/media.ts). */
  media?: TabMedia
  /**
   * Set while the tab lives outside the sidebar: the page of a Peek card or of a Mini Window.
   * Such a tab sits in no container (and is not persisted) until it is expanded or moved into a Space.
   */
  floating?: 'peek' | 'mini'
}

/** What Orbit knows about a tab's media (runtime-only; reported by Orbit's page script). */
export interface TabMedia {
  /** Unmuted media is playing in the page (or the tab is audible). */
  playing: boolean
  /** Any media element is playing, muted ones included (keeps the tab awake, MD-12). */
  active: boolean
  /** Orbit found a media element it can play, pause and seek. */
  controllable: boolean
  /** The page's main media is a video with frames (it can go to picture-in-picture). */
  video: boolean
  /** A video of this tab is in picture-in-picture (Orbit's player or the engine's own window). */
  pip: boolean
  /** That picture-in-picture is Orbit's floating player (MD-03, MD-04), not the engine's window. */
  player?: boolean
  /** That picture-in-picture was opened automatically when the tab was left (MD-01). */
  autoPip?: boolean
  /** Track details from the page's Media Session, when it sets them. */
  title?: string
  artist?: string
  /** The main media has a known length: seeking, next and previous work. */
  seekable: boolean
  /** The main media played to its end. */
  ended: boolean
  /** The main media (or the video in Orbit's player) is paused. */
  paused?: boolean
  /** It is a live stream: no length, no seeking (MD-04 shows "Live"). */
  live?: boolean
  /**
   * Playback position in seconds at time `at` (ms since the epoch), the length in seconds and the
   * speed, reported on play, pause, seek and speed changes only; players extrapolate in between.
   */
  position?: number
  duration?: number
  rate?: number
  at?: number
  /** Shown in the sidebar media tray (MD-09, MD-10). */
  tray: boolean
  /** When it joined the tray (newest on top). */
  since: number
  /** Closed from the tray: stays out of it until it plays again. */
  dismissed?: boolean
  /** Camera / microphone in use, as far as Orbit can see (TB-15, MD-11, MD-14). */
  mic?: boolean
  micMuted?: boolean
  camera?: boolean
  cameraOff?: boolean
}

/** A corner of the screen for Orbit's floating video player (media lane, MD-06). */
export type PipCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/** Where the floating player opens and how big it is (its longer side, in DIPs), MD-06. */
export interface PipPlacement {
  corner: PipCorner
  size: number
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
  /** User-chosen name; when set, the sidebar row shows it instead of the pane titles (SV-21, SV-22). */
  name?: string
  /** The pane focused last: selecting the split returns to it (SV-14). */
  focus?: TabId
  /** A pane still waiting for its first page while the command bar is open for it (SV-02). */
  pending?: TabId
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
  /**
   * Default search engine (ST-06): a built-in engine id, or "site:<id>" for one of the site searches.
   * Unset: the Default profile's choice, then settings.searchEngine (`engineFor` in src/shared/url.ts).
   */
  searchEngine?: string
  /**
   * Where this profile's downloads are saved (DL-07). Unset: the OS Downloads folder. It stays while
   * `downloadAsk` is on, for when that is turned off.
   */
  downloadFolder?: string
  /** "Ask every time" (DL-07): each download shows the OS save dialog. */
  downloadAsk?: boolean
  /** Where that dialog opens: the folder the last download it asked about went to (DL-07). */
  downloadAskFolder?: string
}

export type CommandBarMode = 'new-tab' | 'edit-url' | 'search-tabs'

export type OverlayState =
  | { kind: 'none' }
  | { kind: 'commandbar'; mode: CommandBarMode; query: string; nonce: number }
  | {
      kind: 'peek'
      tabId: TabId
      nonce: number
      /** The tab whose link opened the Peek (it stays selected underneath). */
      sourceTabId?: TabId
      /** Size of the page area the overlay covers while the Peek shows (the card is laid out in it). */
      area?: { width: number; height: number }
      /** Where the card grows from (the clicked link), in page-area coordinates. */
      origin?: { x: number; y: number }
      /** Set while the card animates out (closing) or into a tab or split pane (expanding). */
      phase?: 'closing' | 'expanding' | 'splitting'
      /** The page's background colour, for the card that fades out when the Peek closes. */
      background?: string
      /** The Archive entry the Peek previews from the Library (AR-06): the card can offer `archive.restorePreview`. */
      archiveEntry?: string
    }
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
  /** `private`: a private window (NV-11), showing a Space of its own with an in-memory profile. */
  kind: 'main' | 'mini' | 'private'
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

export type SearchEngineId = 'google' | 'duckduckgo' | 'bing' | 'brave' | 'ecosia' | 'kagi' | 'startpage' | 'perplexity'

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
  /** Sites (hosts) where automatic picture-in-picture is always off (MD-08). */
  pipOffSites?: string[]
  /** Sites where automatic picture-in-picture is off until a time in ms ("Turn off for today", MD-08). */
  pipSnoozed?: Record<string, number>
  /** Where the floating player opens and its size, remembered from the last time it was moved (MD-06). */
  pipPlacement?: PipPlacement
  /** Links opened from other apps open in a Mini Window (off: as tabs, MW-11). */
  miniWindowForExternalLinks: boolean
  /** Shift-click opens any link in Peek (PK-03, PK-12). */
  peekShiftClick: boolean
  /** Where links from other apps open when not in a Mini Window: null = the most recent Space (ST-09). */
  externalLinksSpace: SpaceId | null
  /** Link routing rules (ST-09): a URL that matches opens as a tab in the rule's Space. */
  linkRules: LinkRule[]
  /** Close Mini Windows left alone this long, archiving their page. 0 = never (MW-09, ST-03). */
  miniWindowArchiveAfterMs: number
  /** Profile last chosen in a Mini Window, per site (MW-10). */
  miniWindowProfiles: Record<string, ProfileId>
  /** Size and position of the last Mini Window the user moved or resized (MW-04). */
  miniWindowBounds?: { x: number; y: number; width: number; height: number }
  /** First-run onboarding is done or skipped (OB-01): later starts open the browser at once. */
  onboarded: boolean
  /** The onboarding step a quit left off at, resumed on the next start (OB-14); see ONBOARDING_STEPS. */
  onboardingStep?: string
  /** Favorites picked so far in onboarding (STARTER_APPS ids): a quit resumes with them (OB-14). */
  onboardingFavorites?: string[]
  /**
   * The first Space's colours and the appearance before onboarding's theme step first changed them:
   * Skip setup puts them back (OB-14, D44). Kept until onboarding ends, across a quit.
   */
  onboardingThemeBefore?: { spaceId: SpaceId; theme: SpaceTheme; appearance: ColorMode }
  /** The Settings window's section shown last: Settings reopens there (ST-01). */
  settingsSection: string
  /** The Settings window's size when last resized (ST-01). */
  settingsWindowSize?: { width: number; height: number }
  /** Command bar site searches (CB-11); edited in Settings (ST-06). */
  siteSearch: SiteSearchEngine[]
  /** Ask the search engine for suggestions while typing in the command bar (CB-15). Off by default: it sends keystrokes to the engine. */
  searchSuggestions: boolean
  /** ⇧Enter on a search opens the engine's first result directly where the engine supports it (CB-16). Off by default. */
  searchTopResult: boolean
  /** ⌘1–⌘8 count Favorites first (TB-04, FV-10). */
  countFavoritesInShortcuts: boolean
  /** ⌘9 selects the last tab (true) or the 9th item (false) (TB-04). */
  lastTabOnCmd9: boolean
  /** Use graphics acceleration when available (ST-12). Takes effect at the next start. */
  hardwareAcceleration: boolean
  /** Secure DNS (ST-12): the engine's automatic upgrade, off, or always one DNS-over-HTTPS provider. */
  secureDns: SecureDnsChoice
  /** Where update checks look (UP-01, UP-10; see src/shared/updates.ts). Empty (the default): Orbit never checks. */
  updateFeedUrl: string
  /** Check for updates on launch and every few hours, when a feed is set (UP-01). */
  updateChecks: boolean
  /** The version that ran last: a newer one at launch shows What's new (UP-06). */
  lastRunVersion?: string
  /** The What's new banner (UP-06), until it is opened, dismissed or a few days old. */
  whatsNew?: WhatsNew
  /** The Library section used last: the Library reopens there (AR-02, DL-09). */
  librarySection: string
  /** Archive entries older than this many days are deleted (AR-08). 0 = kept forever. */
  archiveKeepDays: number
  /** What the Library button's popover of recent files lists (DL-05): downloads, OS screenshots. */
  recentFiles: { downloads: boolean; screenshots: boolean }
  /** The OS's screenshots show in the Library's Media section (DL-11). */
  libraryScreenshots: boolean
  /**
   * Reduced motion even when the OS doesn't ask for it (FL-28, AP-17): slides, flights and springs
   * become short cross-fades. Off: Orbit follows the OS setting.
   */
  reduceMotion: boolean
}

/** Secure DNS choices (ST-12): providers are src/main/settings/dns.ts's DOH_SERVERS. */
export type SecureDnsChoice = 'automatic' | 'off' | 'cloudflare' | 'google' | 'quad9'

/** "URL contains …" or "URL is exactly …" → a Space (ST-09 link routing). */
export interface LinkRule {
  match: 'contains' | 'exact'
  value: string
  spaceId: SpaceId
}

export interface ArchivedTab {
  id: string
  /** The tab it was (AR-01): a restore reuses the id; a tab that comes back takes its entry along. */
  tabId?: TabId
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
  /** Where the page was when it closed, when not in the sidebar (the Archive's "Mini Window" filter, AR-01). */
  from?: 'mini' | 'peek'
  /** The split view it was a pane of, when the whole split went at once: it comes back as one unit (SV-19, SV-24). */
  split?: ArchivedSplit
}

/** A split view archived as one unit, as each of its panes' Archive entries keeps it (SV-19, SV-24). */
export interface ArchivedSplit {
  id: SplitId
  /** Its arrangement and sizes; the leaves are its panes' tab ids (`ArchivedTab.tabId`). */
  layout: SplitLayout
  name?: string
  /** The pane focused last. */
  focus?: TabId
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
  /** The profile whose session downloaded it (downloads lane, DL-01). */
  profileId: ProfileId
  /** When it completed, failed or was cancelled. */
  endedAt?: number
  /** Why an interrupted download stopped, e.g. "Network error". */
  error?: string
  /** Bytes per second while it runs (runtime only). */
  speed?: number
  /** An interrupted download that can continue where it stopped (DL-15). */
  canResume?: boolean
  mimeType?: string
  /** The page it was downloaded from. */
  pageUrl?: string
  /** Downloaded in a private window: never written to disk (DL-16). */
  private?: boolean
  /**
   * Held back as a file that can harm the computer (DL-12): complete, but kept under its partial
   * name until the user keeps it (it goes into place) or discards it.
   */
  danger?: 'file-type'
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
  /** Update checks (UP-01): runtime only, dropped on load and never a reason to save (persist.ts). */
  updates?: UpdateStatus
}

export const STATE_SCHEMA = 1
