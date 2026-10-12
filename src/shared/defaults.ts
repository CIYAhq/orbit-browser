import { newId } from './ids'
import type { OrbitState, Profile, Settings, SiteSearchEngine, Space, SpaceTheme, WindowState } from './state'
import { STATE_SCHEMA } from './state'
import { DEFAULT_INTENSITY } from './theme'

export const DEFAULT_PROFILE_ID = 'p-default'

/** Starter site searches for the command bar (CB-11). Users can add, edit and remove them. */
export const DEFAULT_SITE_SEARCH: SiteSearchEngine[] = [
  { id: 'youtube', name: 'YouTube', keyword: 'yt', url: 'https://www.youtube.com/results?search_query=%s' },
  { id: 'wikipedia', name: 'Wikipedia', keyword: 'w', url: 'https://en.wikipedia.org/w/index.php?search=%s' },
  { id: 'github', name: 'GitHub', keyword: 'gh', url: 'https://github.com/search?q=%s' },
  { id: 'x', name: 'X', keyword: 'x', url: 'https://x.com/search?q=%s' },
  { id: 'reddit', name: 'Reddit', keyword: 'r', url: 'https://www.reddit.com/search/?q=%s' },
  { id: 'amazon', name: 'Amazon', keyword: 'a', url: 'https://www.amazon.com/s?k=%s' },
  { id: 'spotify', name: 'Spotify', keyword: 'sp', url: 'https://open.spotify.com/search/%s' },
  { id: 'maps', name: 'Google Maps', keyword: 'maps', url: 'https://www.google.com/maps/search/%s' },
  { id: 'chatgpt', name: 'ChatGPT', keyword: 'gpt', url: 'https://chatgpt.com/?q=%s' },
  { id: 'perplexity', name: 'Perplexity', keyword: 'pp', url: 'https://www.perplexity.ai/search?q=%s' },
]

export const DEFAULT_SETTINGS: Settings = {
  searchEngine: 'google',
  archiveAfterMs: 12 * 60 * 60 * 1000,
  sleepAfterMs: 30 * 60 * 1000,
  appearance: 'system',
  peekExternalLinks: true,
  autoPip: true,
  pipOffSites: [],
  pipSnoozed: {},
  pipPlacement: { corner: 'bottom-right', size: 320 },
  miniWindowForExternalLinks: true,
  peekShiftClick: true,
  externalLinksSpace: null,
  linkRules: [],
  miniWindowArchiveAfterMs: 6 * 60 * 60 * 1000,
  miniWindowProfiles: {},
  miniWindowTrayButton: false,
  onboarded: false,
  settingsSection: 'general',
  siteSearch: DEFAULT_SITE_SEARCH,
  searchSuggestions: false,
  searchTopResult: false,
  reduceMotion: false,
  countFavoritesInShortcuts: true,
  lastTabOnCmd9: true,
  hardwareAcceleration: true,
  secureDns: 'automatic',
  adBlocking: true,
  updateFeedUrl: '',
  updateChecks: true,
  librarySection: 'archive',
  archiveKeepDays: 30,
  recentFiles: { downloads: true, screenshots: false },
  libraryScreenshots: false,
  tweaksEnabled: true,
  tweakIntroSeen: false,
}

/** Favorites per profile (FV-02). */
export const MAX_FAVORITES = 12

/** The toast when a change would pass the Favorites limit (FV-02). */
export const FAVORITES_FULL_MESSAGE = `Favorites are full (${MAX_FAVORITES} max)`

const preset = (...colors: string[]): SpaceTheme => ({ colors, intensity: DEFAULT_INTENSITY, grain: 0 })

/**
 * Orbit's own palette of Space themes (original, not taken from any other
 * product). The first eight single colours are handed out in turn to new
 * Spaces; the gradients after them are extra presets in the theme picker.
 */
export const THEME_PRESETS: SpaceTheme[] = [
  preset('#6b7cff'),
  preset('#ff7a59'),
  preset('#2fbf8f'),
  preset('#e85d9a'),
  preset('#f2b53a'),
  preset('#3fa7e0'),
  preset('#9b6bff'),
  preset('#8a8f98'),
  preset('#6b7cff', '#e85d9a'),
  preset('#2fbf8f', '#3fa7e0'),
  preset('#ff7a59', '#f2b53a'),
  preset('#9b6bff', '#3fa7e0', '#2fbf8f'),
]

/** Number of single-colour presets new Spaces rotate through. */
export const NEW_SPACE_PRESETS = 8

export const DEFAULT_SIDEBAR_WIDTH = 248
export const MIN_SIDEBAR_WIDTH = 180
export const MAX_SIDEBAR_WIDTH = 420

export function createProfile(name: string, id = newId('p'), now = Date.now()): Profile {
  return { id, name, partition: `persist:orbit-${id}`, favorites: [], createdAt: now }
}

export function createSpace(
  name: string,
  profileId: string,
  theme: SpaceTheme = THEME_PRESETS[0] as SpaceTheme,
  icon = '',
  now = Date.now(),
): Space {
  return {
    id: newId('s'),
    name,
    icon,
    theme: { ...theme, colors: [...theme.colors] },
    profileId,
    pinned: [],
    today: [],
    createdAt: now,
  }
}

export function createWindowState(spaceId: string, kind: WindowState['kind'] = 'main'): WindowState {
  return {
    id: newId('w'),
    kind,
    spaceId,
    activeTab: {},
    sidebar: { visible: true, width: DEFAULT_SIDEBAR_WIDTH, peeking: false },
    overlay: { kind: 'none' },
    focused: false,
    fullscreen: false,
  }
}

/** First-run state: one profile, one Space, no windows (the main process opens one). */
export function createInitialState(now = Date.now()): OrbitState {
  const profile = createProfile('Default', DEFAULT_PROFILE_ID, now)
  const space = createSpace('Personal', profile.id, THEME_PRESETS[0] as SpaceTheme, '', now)
  return {
    schema: STATE_SCHEMA,
    windows: {},
    spaces: { [space.id]: space },
    spaceOrder: [space.id],
    profiles: { [profile.id]: profile },
    tabs: {},
    folders: {},
    splits: {},
    archive: [],
    settings: { ...DEFAULT_SETTINGS, siteSearch: DEFAULT_SITE_SEARCH.map((s) => ({ ...s })) },
    downloads: {},
    tweaks: {},
  }
}
