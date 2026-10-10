import { describe, expect, it } from 'vitest'
import { applySettingsPatch } from '../../src/main/settings/validate'
import { createInitialState } from '../../src/shared/defaults'
import type { OrbitState } from '../../src/shared/state'

const DAY = 24 * 60 * 60 * 1000

function apply(patch: unknown, state: OrbitState = createInitialState(0)) {
  const draft = structuredClone(state.settings)
  const refused = applySettingsPatch(draft, patch, state)
  return { settings: draft, refused }
}

describe('[ST-01] settings.update', () => {
  it('applies valid values at once', () => {
    const { settings, refused } = apply({
      appearance: 'dark',
      settingsSection: 'links',
      peekExternalLinks: false,
      miniWindowArchiveAfterMs: 6 * 60 * 60 * 1000,
    })
    expect(refused).toEqual([])
    expect(settings.appearance).toBe('dark')
    expect(settings.settingsSection).toBe('links')
    expect(settings.peekExternalLinks).toBe(false)
    expect(settings.miniWindowArchiveAfterMs).toBe(6 * 60 * 60 * 1000)
  })

  it('refuses unknown keys and values that do not fit, and keeps the rest', () => {
    const before = createInitialState(0).settings
    const { settings, refused } = apply({
      appearance: 'sepia',
      settingsSection: '../x',
      autoPip: 'yes',
      miniWindowArchiveAfterMs: -1,
      onboarded: true,
      searchSuggestions: false,
    })
    expect(refused.sort()).toEqual([
      'appearance',
      'autoPip',
      'miniWindowArchiveAfterMs',
      'onboarded',
      'settingsSection',
    ])
    expect(settings.appearance).toBe(before.appearance)
    expect(settings.onboarded).toBe(before.onboarded)
    expect(settings.searchSuggestions).toBe(false)
  })

  it('allows Never (0) and up to 30 days for the Mini Window archive time', () => {
    expect(apply({ miniWindowArchiveAfterMs: 0 }).refused).toEqual([])
    expect(apply({ miniWindowArchiveAfterMs: 30 * DAY }).refused).toEqual([])
    expect(apply({ miniWindowArchiveAfterMs: 31 * DAY }).refused).toEqual(['miniWindowArchiveAfterMs'])
    expect(apply({ miniWindowArchiveAfterMs: 1.5 }).refused).toEqual(['miniWindowArchiveAfterMs'])
  })

  it('takes an external-links Space only if it exists', () => {
    const state = createInitialState(0)
    const spaceId = state.spaceOrder[0] as string
    expect(apply({ externalLinksSpace: spaceId }, state).settings.externalLinksSpace).toBe(spaceId)
    expect(apply({ externalLinksSpace: null }, state).refused).toEqual([])
    expect(apply({ externalLinksSpace: 's-gone' }, state).refused).toEqual(['externalLinksSpace'])
  })

  it('refuses a patch that is not an object', () => {
    for (const bad of [null, 'dark', [1], 3]) expect(apply(bad).refused).toEqual(['(patch)'])
  })
})
