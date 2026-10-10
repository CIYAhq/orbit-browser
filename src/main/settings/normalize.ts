import { DEFAULT_SETTINGS } from '../../shared/defaults'
import type { OrbitState } from '../../shared/state'
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
  if (!(typeof s.settingsSection === 'string' && SECTION_ID_RE.test(s.settingsSection))) {
    s.settingsSection = DEFAULT_SETTINGS.settingsSection
  }
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
    const engine: unknown = profile.searchEngine
    if (engine === undefined) continue
    if (typeof engine !== 'string' || !engineById(state, engine)) delete profile.searchEngine
  }
}
