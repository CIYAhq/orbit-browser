import { describe, expect, it } from 'vitest'
import { normalizeState } from '../../src/main/persist'
import { normalizeSettingsPrefs } from '../../src/main/settings/normalize'
import { applySettingsPatch } from '../../src/main/settings/validate'
import { createInitialState, MAX_FAVORITES } from '../../src/shared/defaults'
import { chosenApps, isOnboardingStep, ONBOARDING_STEPS, STARTER_APPS } from '../../src/shared/onboarding'
import type { OrbitState, Settings } from '../../src/shared/state'

function withSettings(settings: Record<string, unknown>): OrbitState {
  const state = createInitialState(0)
  state.settings = { ...state.settings, ...settings } as unknown as Settings
  return state
}

describe('[OB-05] the web apps offered as Favorites', () => {
  it('offers a dozen or more well-known apps, each once, over HTTPS', () => {
    expect(STARTER_APPS.length).toBeGreaterThanOrEqual(12)
    expect(STARTER_APPS.length).toBeLessThanOrEqual(20)
    expect(new Set(STARTER_APPS.map((a) => a.id)).size).toBe(STARTER_APPS.length)
    expect(new Set(STARTER_APPS.map((a) => a.url)).size).toBe(STARTER_APPS.length)
    for (const app of STARTER_APPS) expect(new URL(app.url).protocol).toBe('https:')
  })

  it('adds the apps picked, in the order picked, once each, and no more than Favorites hold', () => {
    expect(chosenApps(['github', 'gmail', 'github']).map((a) => a.id)).toEqual(['github', 'gmail'])
    expect(chosenApps(STARTER_APPS.map((a) => a.id))).toHaveLength(MAX_FAVORITES)
  })

  it('ignores anything that is not a list of known app ids', () => {
    expect(chosenApps(undefined)).toEqual([])
    expect(chosenApps('gmail')).toEqual([])
    expect(chosenApps([{ id: 'gmail' }, 'https://evil.example/', 'toString', 7])).toEqual([])
  })
})

describe('[OB-14] the step a quit left onboarding at', () => {
  it('knows only its own steps', () => {
    for (const step of ONBOARDING_STEPS) expect(isOnboardingStep(step)).toBe(true)
    for (const bad of ['account', 'Welcome', '', 'toString', 3, null, undefined]) {
      expect(isOnboardingStep(bad)).toBe(false)
    }
  })

  it('is kept while onboarding is unfinished and forgotten once it is done', () => {
    const resumed = withSettings({ onboarded: false, onboardingStep: 'favorites' })
    normalizeSettingsPrefs(resumed)
    expect(resumed.settings.onboardingStep).toBe('favorites')
    const done = withSettings({ onboarded: true, onboardingStep: 'favorites' })
    normalizeSettingsPrefs(done)
    expect(done.settings).not.toHaveProperty('onboardingStep')
  })

  it('drops a step it does not know when state loads', () => {
    for (const bad of ['account', 7, { step: 'theme' }]) {
      const raw = withSettings({ onboarded: false, onboardingStep: bad })
      const state = normalizeState(JSON.parse(JSON.stringify(raw)))
      expect(state.settings).not.toHaveProperty('onboardingStep')
    }
  })

  it('cannot be set through settings.update, like the onboarded flag', () => {
    const state = createInitialState(0)
    const draft = structuredClone(state.settings)
    expect(applySettingsPatch(draft, { onboardingStep: 'done', onboarded: true }, state).sort()).toEqual([
      'onboarded',
      'onboardingStep',
    ])
    expect(draft).not.toHaveProperty('onboardingStep')
    expect(draft.onboarded).toBe(false)
  })
})
