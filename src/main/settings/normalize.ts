import { SECURE_DNS_CHOICES } from '../../shared/commands/settings'
import { DEFAULT_SETTINGS } from '../../shared/defaults'
import { chosenApps, isOnboardingStep } from '../../shared/onboarding'
import { cleanSiteDefaults } from '../../shared/site-settings'
import type { ColorMode, OrbitState, Settings } from '../../shared/state'
import { normalizeSpaceTheme } from '../../shared/theme'
import { cleanVersion, feedUrlProblem } from '../../shared/updates'
import { engineById, isBuiltInEngine } from '../../shared/url'

/** A Settings section id: a short word from the section registry, never a path or markup. */
export const SECTION_ID_RE = /^[a-z][\w.-]{0,63}$/i

/** Smallest and largest Settings window sizes worth remembering (DIP). */
export const SETTINGS_SIZE_RANGE = { min: 320, max: 8000 }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const saneSize = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= SETTINGS_SIZE_RANGE.min && n <= SETTINGS_SIZE_RANGE.max

/**
 * The settings lane's fields of loaded state (ST-01): a malformed value falls back to its default.
 * Called from normalizeState (src/main/persist.ts).
 */
export function normalizeSettingsPrefs(state: OrbitState): void {
  const s = state.settings
  if (typeof s.onboarded !== 'boolean') s.onboarded = DEFAULT_SETTINGS.onboarded
  if (s.onboarded || !isOnboardingStep(s.onboardingStep)) delete s.onboardingStep
  normalizeOnboardingPicks(state)
  if (!(typeof s.settingsSection === 'string' && SECTION_ID_RE.test(s.settingsSection))) {
    s.settingsSection = DEFAULT_SETTINGS.settingsSection
  }
  if (typeof s.hardwareAcceleration !== 'boolean') s.hardwareAcceleration = DEFAULT_SETTINGS.hardwareAcceleration
  if (!SECURE_DNS_CHOICES.includes(s.secureDns)) s.secureDns = DEFAULT_SETTINGS.secureDns
  normalizeUpdatePrefs(s)
  const size: unknown = s.settingsWindowSize
  if (isRecord(size) && saneSize(size.width) && saneSize(size.height)) {
    s.settingsWindowSize = { width: Math.round(size.width), height: Math.round(size.height) }
  } else {
    delete s.settingsWindowSize
  }
  // Search engines (ST-06): an engine that no longer exists falls back (Google, or the Default
  // profile's choice). Runs after the site searches are cleaned up.
  if (!isBuiltInEngine(s.searchEngine)) s.searchEngine = DEFAULT_SETTINGS.searchEngine
  for (const profile of Object.values(state.profiles)) {
    // Site settings' defaults (ST-13): only categories that can change, with a value they take.
    const siteDefaults = cleanSiteDefaults(profile.siteDefaults)
    if (siteDefaults) profile.siteDefaults = siteDefaults
    else delete profile.siteDefaults
    const engine: unknown = profile.searchEngine
    if (engine === undefined) continue
    if (typeof engine !== 'string' || !engineById(state, engine)) delete profile.searchEngine
  }
}

/** What a run of onboarding picked so far (OB-14): kept only while it isn't done, and only if sane. */
function normalizeOnboardingPicks(state: OrbitState): void {
  const s = state.settings
  const picked = chosenApps(s.onboardingFavorites).map((app) => app.id)
  if (s.onboarded || picked.length === 0) delete s.onboardingFavorites
  else s.onboardingFavorites = picked
  const before: unknown = s.onboardingThemeBefore
  if (s.onboarded || !isRecord(before) || typeof before.spaceId !== 'string' || !state.spaces[before.spaceId]) {
    delete s.onboardingThemeBefore
    return
  }
  const appearance = COLOR_MODES.includes(before.appearance as ColorMode)
    ? (before.appearance as ColorMode)
    : DEFAULT_SETTINGS.appearance
  s.onboardingThemeBefore = { spaceId: before.spaceId, theme: normalizeSpaceTheme(before.theme), appearance }
}

const COLOR_MODES: readonly ColorMode[] = ['system', 'light', 'dark']

/** Update settings (UP-01, UP-06): a feed address that isn't usable turns checks off. */
function normalizeUpdatePrefs(s: Settings): void {
  if (typeof s.updateFeedUrl !== 'string' || feedUrlProblem(s.updateFeedUrl) !== '') {
    s.updateFeedUrl = DEFAULT_SETTINGS.updateFeedUrl
  } else {
    s.updateFeedUrl = s.updateFeedUrl.trim()
  }
  if (typeof s.updateChecks !== 'boolean') s.updateChecks = DEFAULT_SETTINGS.updateChecks
  if (s.lastRunVersion !== undefined && cleanVersion(s.lastRunVersion) !== s.lastRunVersion) delete s.lastRunVersion
  const news: unknown = s.whatsNew
  if (
    news !== undefined &&
    !(isRecord(news) && cleanVersion(news.version) === news.version && Number.isFinite(news.since))
  ) {
    delete s.whatsNew
  }
}
