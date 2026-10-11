import { describe, expect, it } from 'vitest'
import { normalizeState } from '../../src/main/persist'
import { applySettingsPatch } from '../../src/main/settings/validate'
import { ACTIONS_BY_ID } from '../../src/shared/actions'
import { createInitialState, DEFAULT_SETTINGS } from '../../src/shared/defaults'
import type { Settings } from '../../src/shared/state'

describe('[FL-28][AP-17] the Reduce motion setting', () => {
  it('is off by default, so Orbit follows the system', () => {
    expect(DEFAULT_SETTINGS.reduceMotion).toBe(false)
    expect(createInitialState(0).settings.reduceMotion).toBe(false)
  })

  it('takes true or false from settings.update and refuses anything else', () => {
    const state = createInitialState(0)
    const draft = structuredClone(state.settings)
    expect(applySettingsPatch(draft, { reduceMotion: true }, state)).toEqual([])
    expect(draft.reduceMotion).toBe(true)
    expect(applySettingsPatch(draft, { reduceMotion: 'yes' }, state)).toEqual(['reduceMotion'])
    expect(draft.reduceMotion).toBe(true)
  })

  it('loads as off from a file without it or with a damaged value', () => {
    for (const bad of [undefined, 'on', 1, null]) {
      const raw = createInitialState(0)
      raw.settings = { ...raw.settings, reduceMotion: bad } as unknown as Settings
      if (bad === undefined) delete (raw.settings as Partial<Settings>).reduceMotion
      const state = normalizeState(JSON.parse(JSON.stringify(raw)))
      expect(state.settings.reduceMotion).toBe(false)
    }
    const raw = createInitialState(0)
    raw.settings.reduceMotion = true
    expect(normalizeState(JSON.parse(JSON.stringify(raw))).settings.reduceMotion).toBe(true)
  })

  it('has an action to toggle it from the command bar', () => {
    const def = ACTIONS_BY_ID['app.toggleReduceMotion']
    expect(def?.title).toBe('Toggle Reduce Motion')
    expect(def?.keywords).toContain('animations')
  })
})
