import { describe, expect, it } from 'vitest'
import { linksFromArgv } from '../../src/main/external-links'
import { miniSwitchIn, NEW_MINI_SWITCH, TOGGLE_MINIS_SWITCH } from '../../src/main/miniwindow/switches'

describe('Mini Window jump-list switches (MW-14)', () => {
  it('[MW-14] finds the switch wherever the launch puts it, in any case', () => {
    expect(miniSwitchIn(['C:\\Orbit\\Orbit.exe', NEW_MINI_SWITCH])).toBe('new')
    expect(miniSwitchIn(['C:\\Orbit\\Orbit.exe', '--original-process-start-time=1', '--TOGGLE-MINI-WINDOWS'])).toBe(
      'toggle',
    )
    expect(miniSwitchIn(['C:\\Orbit\\Orbit.exe', 'https://example.com/a'])).toBeUndefined()
    expect(miniSwitchIn([])).toBeUndefined()
  })

  it('[MW-14] a switch is never taken for a link to open', () => {
    expect(linksFromArgv(['orbit', NEW_MINI_SWITCH, TOGGLE_MINIS_SWITCH], '/')).toEqual([])
  })
})
