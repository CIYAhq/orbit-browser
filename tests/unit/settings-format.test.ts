import { describe, expect, it } from 'vitest'
import { DAY, durationLabel, HOUR, withCurrent } from '../../src/renderer/src/settings/format'
import { ARCHIVE_AFTER_CHOICES } from '../../src/shared/commands/settings'

describe('Settings duration labels', () => {
  it('[ST-05] names the archive choices as people say them', () => {
    expect(ARCHIVE_AFTER_CHOICES.map(durationLabel)).toEqual(['12 hours', '24 hours', '7 days', '30 days'])
    expect(durationLabel(0)).toBe('Never')
    expect(durationLabel(HOUR)).toBe('1 hour')
    expect(durationLabel(30 * 60 * 1000)).toBe('30 minutes')
    expect(durationLabel(2 * DAY)).toBe('2 days')
  })

  it('[ST-05] keeps a value set elsewhere in the list, in order, with Never last', () => {
    const options = [
      { value: 6 * HOUR, label: '6 hours' },
      { value: 0, label: 'Never' },
    ]
    expect(withCurrent(options, 6 * HOUR)).toEqual(options)
    expect(withCurrent(options, 3 * DAY).map((o) => o.label)).toEqual(['6 hours', '3 days', 'Never'])
  })
})
