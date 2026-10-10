import type { ActionDef } from '../actions'
import type { ProfileId, Settings, SpaceId, WindowId } from '../state'

/**
 * Owned by the settings lane: the Settings window (ST-*), the global appearance (AP-01),
 * onboarding (OB-*) and updates (UP-*).
 */

/** Which browser window, Space and profile the Settings window acts for (ST-01, ST-07, ST-20). */
export interface SettingsContext {
  /** The browser window Settings was last opened from, while that window is open. */
  windowId?: WindowId
  /** That window's Space: Settings takes its theme colours (ST-01). */
  spaceId?: SpaceId
  /** The profile per-profile settings open for: the Space's profile, else the Default profile. */
  profileId: ProfileId
}

/** Where `settings.open` goes. */
export interface SettingsTarget {
  /** A section id from the Settings section registry (src/renderer/src/settings/registry.ts). */
  section?: string
  /** One setting in it to scroll to and highlight: the `id` of its `<SettingRow>` (ST-02). */
  item?: string
  /** The profile the Profiles section shows (ST-04); the opener's by default. */
  profileId?: ProfileId
}

/** An action that opens Settings at a section or at one setting (ST-02). */
export interface SettingsActionDef extends ActionDef {
  /** Where it opens Settings. */
  settings: SettingsTarget
}

/**
 * Settings sections and common settings as actions (ST-02). The command bar lists them by name, and
 * choosing one opens Settings there, scrolled to the setting (src/main/settings/index.ts registers
 * them all). They are spread at the end of ACTIONS (src/shared/actions.ts). A lane that adds a
 * Settings section adds its action here.
 */
export const SETTINGS_ACTIONS: SettingsActionDef[] = [
  {
    id: 'settings.general',
    title: 'General Settings',
    category: 'App',
    settings: { section: 'general' },
    keywords: ['preferences', 'mini window'],
  },
  {
    id: 'settings.defaultBrowser',
    title: 'Set as Default Browser',
    category: 'App',
    settings: { section: 'general', item: 'default-browser' },
    keywords: ['default browser', 'make default'],
  },
  {
    id: 'settings.profiles',
    title: 'Profile Settings',
    category: 'App',
    settings: { section: 'profiles' },
    keywords: ['profiles', 'new profile', 'rename profile', 'delete profile', 'archive timing', 'auto archive'],
  },
  {
    id: 'settings.search',
    title: 'Search Engine Settings',
    category: 'App',
    settings: { section: 'search' },
    keywords: ['default search engine', 'google', 'duckduckgo', 'bing', 'search suggestions'],
  },
  {
    id: 'settings.siteSearch',
    title: 'Site Search Settings',
    category: 'App',
    settings: { section: 'search', item: 'site-search' },
    keywords: ['search keywords', 'custom search engine', 'add search engine'],
  },
  {
    id: 'settings.appearance',
    title: 'Appearance Settings',
    category: 'App',
    settings: { section: 'appearance' },
    keywords: ['theme', 'dark mode', 'light mode', 'match system'],
  },
  {
    id: 'settings.about',
    // Not "About Orbit": typing the app's own name in the command bar shouldn't add a row.
    title: 'About',
    category: 'App',
    settings: { section: 'about' },
    keywords: ['version', 'build info', 'licence', 'license', 'credits'],
  },
]

/** Sent to the Settings window each time it is opened again (`window.orbit.on('settings.reveal', …)`). */
export interface SettingsReveal {
  target: SettingsTarget
  context: SettingsContext
  nonce: number
}

/**
 * The global settings `settings.update` may change. Main validates every value
 * (src/main/settings/validate.ts) and ignores keys it does not know.
 */
export type SettingsPatch = Partial<
  Pick<
    Settings,
    | 'appearance'
    | 'settingsSection'
    | 'peekExternalLinks'
    | 'peekShiftClick'
    | 'miniWindowForExternalLinks'
    | 'externalLinksSpace'
    | 'miniWindowArchiveAfterMs'
    | 'autoPip'
    | 'searchSuggestions'
    | 'searchTopResult'
  >
>

/** A custom search engine as typed in Settings (ST-06): with an `id`, an edit of that one. */
export interface SiteSearchDraft {
  id?: string
  name: string
  keyword: string
  /** Results URL with %s where the query goes. */
  url: string
}

export type SiteSearchSaved =
  | { ok: true; id: string }
  | { ok: false; field: 'name' | 'keyword' | 'url'; message: string }

const HOUR = 60 * 60 * 1000

/**
 * "Archive Today tabs after" choices, per profile (ST-05). 12 hours is the default; archiving can't be
 * turned off.
 */
export const ARCHIVE_AFTER_CHOICES: readonly number[] = [12 * HOUR, 24 * HOUR, 7 * 24 * HOUR, 30 * 24 * HOUR]

/** Whether Orbit is the OS default browser (ST-03, OB-07). */
export interface DefaultBrowserStatus {
  isDefault: boolean
  /** Whether Orbit can ask to become it (installed builds). */
  canSet: boolean
  /** Why it can't, when it can't. */
  note?: string
}

/** Optional features other lanes provide, which Settings and onboarding offer when present. */
export interface SettingsCapabilities {
  /** The import lane's flow (`import.open`, IM-01). */
  importer: boolean
}

/** What About shows and "Copy build info" copies (ST-17). */
export interface BuildInfo {
  version: string
  electron: string
  chrome: string
  node: string
  v8: string
  /** e.g. "macOS 15.1", "Linux 6.8.0". */
  os: string
  arch: string
}

export interface SettingsCommands {
  /** Opens the one Settings window, or brings it to the front (ST-01), at a section or item (ST-02). */
  'settings.open': { args: SettingsTarget; result: void }
  'settings.close': { args: Record<string, never>; result: void }
  /** What Settings shows and acts for: the window it was opened from and the last target. */
  'settings.context': { args: Record<string, never>; result: SettingsReveal }
  /** Changes global settings; they apply at once and persist (ST-01). */
  'settings.update': { args: SettingsPatch; result: void }
  /** Opens a web page in a new tab of the browser window Settings belongs to. */
  'settings.openUrl': { args: { url: string }; result: void }
  'settings.buildInfo': { args: Record<string, never>; result: BuildInfo }
  /** Copies the build info for a bug report (ST-17) and returns the text copied. */
  'settings.copyBuildInfo': { args: Record<string, never>; result: string }
  /** A profile's default search engine (ST-06): a built-in id or "site:<site search id>". */
  'settings.setSearchEngine': { args: { profileId: ProfileId; engine: string }; result: void }
  /** Adds a custom search engine, or changes one (ST-06, CB-11). */
  'settings.saveSiteSearch': { args: SiteSearchDraft; result: SiteSearchSaved }
  'settings.removeSiteSearch': { args: { id: string }; result: void }
  /**
   * A profile's "Archive Today tabs after" (ST-05): one of ARCHIVE_AFTER_CHOICES, or null for a
   * profile other than Default to follow the Default profile's.
   */
  'settings.setArchiveAfter': { args: { profileId: ProfileId; ms: number | null }; result: void }
  /** Whether Orbit is the default browser (ST-03). */
  'settings.defaultBrowser': { args: Record<string, never>; result: DefaultBrowserStatus }
  /** Asks the OS to make Orbit the default browser (ST-03, OB-07). */
  'settings.setDefaultBrowser': { args: Record<string, never>; result: DefaultBrowserStatus }
  'settings.capabilities': { args: Record<string, never>; result: SettingsCapabilities }
  /** Opens the import flow (IM-01) in the browser window Settings belongs to, when the import lane provides it. */
  'settings.openImport': { args: Record<string, never>; result: boolean }
}
