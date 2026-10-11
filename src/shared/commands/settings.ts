import type { ActionDef } from '../actions'
import type { OnboardingInfo, OnboardingStep } from '../onboarding'
import type {
  ColorMode,
  LinkRule,
  ProfileId,
  SearchEngineId,
  SecureDnsChoice,
  Settings,
  SpaceId,
  SpaceTheme,
  WindowId,
} from '../state'
import type { UpdateStatus } from '../updates'

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
  // Keys lane: Settings → Shortcuts (ST-08, KS-12).
  {
    id: 'settings.shortcuts',
    title: 'Shortcut Settings',
    category: 'App',
    settings: { section: 'shortcuts' },
    keywords: ['keyboard shortcuts', 'shortcuts', 'remap keys', 'key bindings', 'hotkeys'],
  },
  {
    id: 'settings.links',
    title: 'Link Settings',
    category: 'App',
    settings: { section: 'links' },
    keywords: ['links from other apps', 'external links', 'link routing', 'routing rules', 'peek', 'mini window'],
  },
  {
    id: 'settings.privacy',
    title: 'Privacy and Security Settings',
    category: 'App',
    settings: { section: 'privacy' },
    keywords: ['secure dns', 'dns over https', 'cookies', 'privacy'],
  },
  {
    id: 'settings.clearBrowsingData',
    title: 'Clear Browsing Data…',
    category: 'App',
    mac: ['Cmd+Shift+Backspace'],
    other: ['Ctrl+Shift+Delete'],
    settings: { section: 'privacy', item: 'clear-data' },
    keywords: ['delete history', 'clear history', 'clear cookies', 'clear cache'],
  },
  {
    id: 'settings.advanced',
    title: 'Advanced Settings',
    category: 'App',
    settings: { section: 'advanced' },
    keywords: ['graphics acceleration', 'hardware acceleration', 'picture in picture', 'tab sleeping', 'memory'],
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

/** The settings lane's other actions, for the command bar and menus. */
export const SETTINGS_LANE_ACTIONS: ActionDef[] = [
  // Runs the first-run flow again over the open windows, keeping all data (OB-14).
  { id: 'onboarding.reset', title: 'Reset Onboarding', category: 'App', keywords: ['welcome', 'first run', 'setup'] },
  // Help and feedback (OB-13): the project's public pages, in a tab. Orbit has no support server.
  {
    id: 'help.open',
    title: 'Help',
    category: 'App',
    // Windows and Linux: F1, which can't be changed (KS-15); macOS has ⌘? for the Help menu.
    other: ['F1'],
    fixed: 'other',
    keywords: ['documentation', 'user guide', 'support', 'readme'],
  },
  {
    id: 'help.reportBug',
    title: 'Report a Bug',
    category: 'App',
    keywords: ['send feedback', 'feedback', 'bug report', 'issue', 'problem'],
  },
  // Release notes (UP-06).
  {
    id: 'help.releaseNotes',
    title: "What's New",
    category: 'App',
    keywords: ['release notes', 'changelog', 'changes'],
  },
  // Help → Troubleshooting → Copy Build Info (UP-07, ST-17).
  {
    id: 'help.copyBuildInfo',
    title: 'Copy Build Info',
    category: 'App',
    keywords: ['version', 'troubleshooting', 'bug report'],
  },
  // Opens About in Settings with a check running (UP-03).
  {
    id: 'app.checkForUpdates',
    title: 'Check for Updates',
    category: 'App',
    keywords: ['update', 'upgrade', 'new version', 'software update'],
  },
]

/** The built-in search engines, in the order Settings and onboarding list them (ST-06, OB-08). */
export const ENGINE_ORDER: readonly SearchEngineId[] = [
  'google',
  'bing',
  'duckduckgo',
  'brave',
  'ecosia',
  'startpage',
  'kagi',
  'perplexity',
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
    | 'sleepAfterMs'
    | 'hardwareAcceleration'
    | 'secureDns'
    | 'updateChecks'
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

/** Secure DNS choices, in the order Settings lists them (ST-12). */
export const SECURE_DNS_CHOICES: readonly SecureDnsChoice[] = ['automatic', 'off', 'cloudflare', 'google', 'quad9']

/** "Put inactive tabs to sleep after" choices (TB-16): 30 minutes is the default; 0 is Never. */
export const SLEEP_AFTER_CHOICES: readonly number[] = [15 * 60_000, 30 * 60_000, HOUR, 2 * HOUR, 0]

/** What is cleared by Clear browsing data (ST-12). */
export type ClearDataKind = 'history' | 'siteData' | 'cache'

/** Clear browsing data's time ranges (ST-12). Site data and the cache only clear for all time. */
export type ClearDataRange = 'hour' | 'day' | 'week' | 'month' | 'all'

export interface ClearDataRequest {
  profileId: ProfileId
  range: ClearDataRange
  kinds: ClearDataKind[]
}

/** Engine state Settings shows next to the settings it depends on (ST-12). */
export interface SystemStatus {
  /** The graphics acceleration setting this run started with (it applies from the next start). */
  hardwareAcceleration: boolean
  /** Whether Settings may offer "Restart Orbit" (not in test runs). */
  canRelaunch: boolean
}

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
  /** The day this build was made, "2026-10-10" (UP-07); missing in unit tests. */
  built?: string
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
  /**
   * Opens the open-source credits that come with Orbit in a new tab, like `settings.openUrl`
   * (ST-17, UP-07): at Orbit's licence with `at: 'orbit'`.
   */
  'settings.openCredits': { args: { at?: 'orbit' }; result: void }
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
  /**
   * Replaces the link routing rules (ST-09), in order: the first that matches wins. Rules for a Space
   * that is gone are dropped; a malformed list changes nothing.
   */
  'settings.setLinkRules': { args: { rules: LinkRule[] }; result: void }
  /** Clears a profile's browsing data (ST-12): history for the range, site data and cache for all time. */
  'settings.clearData': { args: ClearDataRequest; result: void }
  'settings.systemStatus': { args: Record<string, never>; result: SystemStatus }
  /** Restarts Orbit (to apply graphics acceleration); refused in test runs. */
  'settings.relaunch': { args: Record<string, never>; result: boolean }
  /** Whether Orbit is the default browser (ST-03). */
  'settings.defaultBrowser': { args: Record<string, never>; result: DefaultBrowserStatus }
  /** Asks the OS to make Orbit the default browser (ST-03, OB-07). */
  'settings.setDefaultBrowser': { args: Record<string, never>; result: DefaultBrowserStatus }
  'settings.capabilities': { args: Record<string, never>; result: SettingsCapabilities }
  /** Opens the import flow (IM-01) in the browser window Settings belongs to, when the import lane provides it. */
  'settings.openImport': { args: Record<string, never>; result: boolean }
  /** Where first-run onboarding starts and what it can offer (OB-01, OB-03). */
  'onboarding.info': { args: Record<string, never>; result: OnboardingInfo }
  /** Remembers the step shown, so a quit part-way resumes there (OB-14). */
  'onboarding.setStep': { args: { step: OnboardingStep }; result: void }
  /**
   * The theme step's live change (OB-04): the first Space's colours and/or the appearance. The first
   * one records what was there before, for Skip setup.
   */
  'onboarding.setTheme': { args: { theme?: SpaceTheme; appearance?: ColorMode }; result: void }
  /** Remembers the Favorites picked so far (STARTER_APPS ids), so a quit resumes with them (OB-14). */
  'onboarding.setFavorites': { args: { favorites: string[] }; result: void }
  /**
   * Ends onboarding (OB-09): adds the chosen Favorites (STARTER_APPS ids) and opens the first browser
   * window, or returns to the one already open.
   */
  'onboarding.finish': { args: { favorites: string[] }; result: void }
  /**
   * Skip setup (OB-14, D44): a default first window. The theme step's change is undone, no Favorites
   * are added and nothing is imported; then as onboarding.finish.
   */
  'onboarding.skip': { args: Record<string, never>; result: void }
  /** Copies Orbit's version (UP-03: clicking the version copies it) and returns it. */
  'settings.copyVersion': { args: Record<string, never>; result: string }
  /**
   * Checks the update feed now (UP-03) and returns what it found; with no feed set, does nothing.
   * One check at a time: a second call while one runs gets that one's result.
   */
  'updates.check': { args: Record<string, never>; result: UpdateStatus }
  /** Sets the update feed address (UP-01); returns why it can't be used, or '' once set. */
  'updates.setFeed': { args: { url: string }; result: string }
  /** Opens the newer release's page in a tab of the window it came from (UP-10). */
  'updates.open': { args: Record<string, never>; result: void }
  /** The sidebar banner's ✕ (UP-02, UP-06). */
  'updates.dismiss': { args: { banner: 'update' | 'whatsNew' }; result: void }
  /** Opens this version's release notes in a tab and ends the What's new banner (UP-06). */
  'updates.whatsNew': { args: Record<string, never>; result: void }
}
