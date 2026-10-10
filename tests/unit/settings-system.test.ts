import { describe, expect, it } from 'vitest'
import { normalizeState } from '../../src/main/persist'
import { clearRangeStart, DOH_SERVERS, hostResolverConfig, isClearRange } from '../../src/main/settings/dns'
import { applySettingsPatch } from '../../src/main/settings/validate'
import { createInitialState } from '../../src/shared/defaults'

const HOUR = 3_600_000

describe('[ST-12] Secure DNS', () => {
  it('leaves automatic to the engine, turns DNS over HTTPS off, or pins one provider', () => {
    expect(hostResolverConfig('automatic', 'linux')).toEqual({
      enableBuiltInResolver: false,
      secureDnsMode: 'automatic',
    })
    expect(hostResolverConfig('off', 'darwin')).toEqual({ enableBuiltInResolver: true, secureDnsMode: 'off' })
    expect(hostResolverConfig('quad9', 'win32')).toEqual({
      enableBuiltInResolver: false,
      secureDnsMode: 'secure',
      secureDnsServers: [DOH_SERVERS.quad9],
    })
    for (const url of Object.values(DOH_SERVERS)) expect(url).toMatch(/^https:\/\/[a-z0-9.-]+\/dns-query/)
  })

  it('a stored choice that is not one of them falls back to automatic', () => {
    const base = createInitialState(0)
    const loaded = normalizeState({ ...base, settings: { ...base.settings, secureDns: 'nextdns' as never } })
    expect(loaded.settings.secureDns).toBe('automatic')
    expect(loaded.settings.hardwareAcceleration).toBe(true)
  })
})

describe('[ST-12] Clear browsing data ranges', () => {
  it('start an hour, a day, a week or four weeks back; all time has no start', () => {
    const now = 100 * 24 * HOUR
    expect(clearRangeStart('hour', now)).toBe(now - HOUR)
    expect(clearRangeStart('day', now)).toBe(now - 24 * HOUR)
    expect(clearRangeStart('week', now)).toBe(now - 7 * 24 * HOUR)
    expect(clearRangeStart('month', now)).toBe(now - 28 * 24 * HOUR)
    expect(clearRangeStart('all', now)).toBeUndefined()
    expect(isClearRange('all')).toBe(true)
    expect(isClearRange('year')).toBe(false)
    expect(isClearRange('toString')).toBe(false)
  })
})

describe('[ST-10][ST-12] settings.update for Advanced and Privacy', () => {
  it('takes tab sleeping from a minute to a day or never, graphics acceleration and Secure DNS', () => {
    const state = createInitialState(0)
    const draft = structuredClone(state.settings)
    expect(
      applySettingsPatch(draft, { sleepAfterMs: 2 * HOUR, hardwareAcceleration: false, secureDns: 'off' }, state),
    ).toEqual([])
    expect(draft).toMatchObject({ sleepAfterMs: 2 * HOUR, hardwareAcceleration: false, secureDns: 'off' })
    expect(applySettingsPatch(draft, { sleepAfterMs: 0 }, state)).toEqual([])
    expect(
      applySettingsPatch(
        draft,
        { sleepAfterMs: 1000, hardwareAcceleration: 'no', secureDns: 'https://x' },
        state,
      ).sort(),
    ).toEqual(['hardwareAcceleration', 'secureDns', 'sleepAfterMs'])
    expect(applySettingsPatch(draft, { sleepAfterMs: 2 * 24 * HOUR }, state)).toEqual(['sleepAfterMs'])
  })
})
