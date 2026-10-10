import { describe, expect, it } from 'vitest'
import { HISTORY_MENU_MAX, historyEntryLabel, historyMenuIndexes } from '../../src/shared/nav'

describe('historyMenuIndexes (NV-01)', () => {
  it('lists the pages behind the current one, nearest first', () => {
    expect(historyMenuIndexes(5, 3, 'back')).toEqual([2, 1, 0])
    expect(historyMenuIndexes(5, 0, 'back')).toEqual([])
  })

  it('lists the pages ahead of the current one, nearest first', () => {
    expect(historyMenuIndexes(5, 1, 'forward')).toEqual([2, 3, 4])
    expect(historyMenuIndexes(5, 4, 'forward')).toEqual([])
  })

  it('caps the list at the nearest entries', () => {
    const back = historyMenuIndexes(40, 30, 'back')
    expect(back).toHaveLength(HISTORY_MENU_MAX)
    expect(back[0]).toBe(29)
    expect(back[back.length - 1]).toBe(30 - HISTORY_MENU_MAX)
    const forward = historyMenuIndexes(40, 2, 'forward', 4)
    expect(forward).toEqual([3, 4, 5, 6])
  })

  it('stays inside the history when the current index is out of range', () => {
    expect(historyMenuIndexes(3, 7, 'back')).toEqual([2, 1, 0])
    expect(historyMenuIndexes(3, -1, 'forward')).toEqual([0, 1, 2])
    expect(historyMenuIndexes(0, 0, 'back')).toEqual([])
  })
})

describe('historyEntryLabel (NV-01)', () => {
  it('uses the page title', () => {
    expect(historyEntryLabel('  Docs home ', 'https://example.com/docs')).toBe('Docs home')
  })

  it('falls back to the address without its scheme', () => {
    expect(historyEntryLabel('', 'https://example.com/')).toBe('example.com')
    expect(historyEntryLabel('   ', 'http://localhost:3300/page/A')).toBe('localhost:3300/page/A')
    expect(historyEntryLabel('', 'about:blank')).toBe('about:blank')
  })

  it('shortens long labels with an ellipsis', () => {
    const label = historyEntryLabel('x'.repeat(100), 'https://example.com/')
    expect(label).toHaveLength(60)
    expect(label.endsWith('…')).toBe(true)
    expect(historyEntryLabel('abcdefghij', 'https://example.com/', 5)).toBe('abcd…')
  })
})
