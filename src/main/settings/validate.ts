import { SECURE_DNS_CHOICES, type SettingsPatch } from '../../shared/commands/settings'
import type { OrbitState, Settings } from '../../shared/state'
import { SECTION_ID_RE } from './normalize'

const DAY = 24 * 60 * 60 * 1000

type Check = (value: unknown, state: OrbitState) => boolean

const bool: Check = (v) => typeof v === 'boolean'

/**
 * What `settings.update` accepts for each global setting. Renderers are Orbit's own UI, but a value
 * still has to make sense before it is stored: state is persisted and read by every feature.
 */
const CHECKS: { [K in keyof Required<SettingsPatch>]: Check } = {
  appearance: (v) => v === 'system' || v === 'light' || v === 'dark',
  settingsSection: (v) => typeof v === 'string' && SECTION_ID_RE.test(v),
  peekExternalLinks: bool,
  peekShiftClick: bool,
  miniWindowForExternalLinks: bool,
  externalLinksSpace: (v, state) => v === null || (typeof v === 'string' && !!state.spaces[v]),
  // 0 = never (MW-09); otherwise up to 30 days.
  miniWindowArchiveAfterMs: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 30 * DAY,
  miniWindowTrayButton: bool,
  autoPip: bool,
  searchSuggestions: bool,
  searchTopResult: bool,
  // 0 = never (TB-16); otherwise a minute to a day.
  sleepAfterMs: (v) => typeof v === 'number' && Number.isInteger(v) && (v === 0 || (v >= 60_000 && v <= DAY)),
  hardwareAcceleration: bool,
  secureDns: (v) => (SECURE_DNS_CHOICES as readonly unknown[]).includes(v),
  updateChecks: bool,
}

/**
 * Applies the valid entries of a `settings.update` patch to a settings draft. Returns the keys it
 * refused (unknown, or a value that does not fit).
 */
export function applySettingsPatch(draft: Settings, patch: unknown, state: OrbitState): string[] {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return ['(patch)']
  const refused: string[] = []
  const target = draft as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    const check = (CHECKS as Record<string, Check | undefined>)[key]
    if (!check?.(value, state)) {
      refused.push(key)
      continue
    }
    if (target[key] !== value) target[key] = value
  }
  return refused
}
