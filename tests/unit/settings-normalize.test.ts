import { describe, expect, it } from 'vitest'
import { normalizeState } from '../../src/main/persist'
import { normalizeSettingsPrefs } from '../../src/main/settings/normalize'
import { createInitialState, DEFAULT_SETTINGS } from '../../src/shared/defaults'
import type { OrbitState, Settings } from '../../src/shared/state'

/** A state whose settings carry whatever an older or damaged file had. */
function withSettings(settings: Record<string, unknown>): OrbitState {
  const state = createInitialState(0)
  state.settings = { ...state.settings, ...settings } as unknown as Settings
  return state
}

describe('[ST-01] loaded Settings window preferences', () => {
  it('keeps a valid section and size', () => {
    const state = withSettings({ settingsSection: 'appearance', settingsWindowSize: { width: 900.4, height: 640 } })
    normalizeSettingsPrefs(state)
    expect(state.settings.settingsSection).toBe('appearance')
    expect(state.settings.settingsWindowSize).toEqual({ width: 900, height: 640 })
  })

  it('falls back to General for a missing or malformed section', () => {
    for (const bad of [undefined, 42, '', '../etc', '<b>x</b>', 'a'.repeat(80)]) {
      const state = withSettings({ settingsSection: bad })
      normalizeSettingsPrefs(state)
      expect(state.settings.settingsSection).toBe(DEFAULT_SETTINGS.settingsSection)
    }
  })

  it('forgets a size that is not a sane window size', () => {
    for (const bad of [
      null,
      'big',
      { width: 10, height: 600 },
      { width: 800, height: Number.NaN },
      { width: 800 },
      { width: 99999, height: 600 },
      [800, 600],
    ]) {
      const state = withSettings({ settingsWindowSize: bad })
      normalizeSettingsPrefs(state)
      expect(state.settings).not.toHaveProperty('settingsWindowSize')
    }
  })

  it('treats a non-boolean onboarded flag as not onboarded', () => {
    const state = withSettings({ onboarded: 'yes' })
    normalizeSettingsPrefs(state)
    expect(state.settings.onboarded).toBe(false)
  })

  it('runs as part of loading state', () => {
    const raw = withSettings({ settingsSection: 7, settingsWindowSize: { width: 'x', height: 1 } })
    const state = normalizeState(JSON.parse(JSON.stringify(raw)))
    expect(state.settings.settingsSection).toBe('general')
    expect(state.settings).not.toHaveProperty('settingsWindowSize')
  })

  it('gives a state from before Settings existed the defaults', () => {
    const raw = JSON.parse(JSON.stringify(createInitialState(0)))
    delete raw.settings.settingsSection
    const state = normalizeState(raw)
    expect(state.settings.settingsSection).toBe('general')
    expect(state.settings.onboarded).toBe(false)
  })
})
