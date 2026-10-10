import { describe, expect, it } from 'vitest'
import { checkLinkRules, MAX_LINK_RULES } from '../../src/main/settings/links'
import { createInitialState } from '../../src/shared/defaults'

const state = createInitialState(0)
const spaceId = state.spaceOrder[0] as string

describe('[ST-09] link routing rules from Settings', () => {
  it('keeps the order and trims values, dropping anything else a rule carries', () => {
    const rules = [
      { match: 'contains', value: '  figma.com ', spaceId, extra: 1 },
      { match: 'exact', value: 'https://example.com/a', spaceId },
    ]
    expect(checkLinkRules(rules, state)).toEqual([
      { match: 'contains', value: 'figma.com', spaceId },
      { match: 'exact', value: 'https://example.com/a', spaceId },
    ])
  })

  it('leaves out rules whose Space is gone, as loading does', () => {
    expect(checkLinkRules([{ match: 'contains', value: 'x.com', spaceId: 's-gone' }], state)).toEqual([])
  })

  it('refuses a malformed list as a whole', () => {
    const ok = { match: 'contains', value: 'x.com', spaceId }
    for (const bad of [
      'rules',
      null,
      [ok, { match: 'starts', value: 'x', spaceId }],
      [ok, { match: 'contains', value: '   ', spaceId }],
      [ok, { match: 'contains', value: 'x'.repeat(2049), spaceId }],
      [ok, { match: 'contains', value: 7, spaceId }],
      [ok, null],
      Array.from({ length: MAX_LINK_RULES + 1 }, () => ok),
    ]) {
      expect(checkLinkRules(bad, state)).toBeUndefined()
    }
    expect(checkLinkRules([], state)).toEqual([])
  })
})
