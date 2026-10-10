import { describe, expect, it } from 'vitest'
import {
  dayLabel,
  dayOfOffset,
  HEAD_H,
  listGeometry,
  ROW_H,
  rowRange,
  rowTop,
  visibleItems,
} from '../../src/renderer/src/library/geometry'

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime()

describe('Archive list layout (AR-03)', () => {
  it('[AR-03] each day is a heading followed by its rows; offsets count rows only', () => {
    const g = listGeometry([
      [day(2026, 10, 9), 2],
      [day(2026, 10, 8), 3],
    ])
    expect(g.total).toBe(5)
    expect(g.starts).toEqual([0, 2])
    expect(g.tops).toEqual([0, HEAD_H + 2 * ROW_H])
    expect(g.height).toBe(2 * HEAD_H + 5 * ROW_H)
    expect(rowTop(g, 0)).toBe(HEAD_H)
    expect(rowTop(g, 1)).toBe(HEAD_H + ROW_H)
    // The third entry is the first of the second day: below that day's heading.
    expect(rowTop(g, 2)).toBe(2 * HEAD_H + 2 * ROW_H)
    expect(dayOfOffset(g, 1)).toBe(0)
    expect(dayOfOffset(g, 2)).toBe(1)
    expect(dayOfOffset(g, 4)).toBe(1)
  })

  it('[AR-03] only the headings and rows near the viewport are laid out (virtualised)', () => {
    // 10,000 entries over 30 days.
    const days = Array.from(
      { length: 30 },
      (_, i) => [day(2026, 10, 30 - i), i === 29 ? 10_000 - 29 * 333 : 333] as const,
    )
    const g = listGeometry(days)
    expect(g.total).toBe(10_000)
    const height = 600
    const top = rowTop(g, 5000) - 100
    const items = visibleItems(g, top, height, 0)
    const rows = items.filter((i) => i.kind === 'row')
    // Never more than a screenful (plus partial rows at both ends).
    expect(rows.length).toBeLessThanOrEqual(Math.ceil(height / ROW_H) + 2)
    for (const item of items) {
      const bottom = item.top + (item.kind === 'row' ? ROW_H : HEAD_H)
      expect(bottom).toBeGreaterThan(top)
      expect(item.top).toBeLessThan(top + height)
    }
    const range = rowRange(items)
    expect(range?.[0]).toBeLessThanOrEqual(5000)
    expect(range?.[1]).toBeGreaterThanOrEqual(5000)
    // Rows are in order and placed where rowTop says.
    for (const r of rows) if (r.kind === 'row') expect(r.top).toBe(rowTop(g, r.offset))
  })

  it('[AR-03] a heading in view is listed with its day and count; overscan adds rows around', () => {
    const g = listGeometry([
      [day(2026, 10, 9), 3],
      [day(2026, 10, 8), 50],
    ])
    const items = visibleItems(g, 0, 200)
    expect(items[0]).toMatchObject({ kind: 'day', day: 0, at: day(2026, 10, 9), top: 0, count: 3 })
    expect(items.some((i) => i.kind === 'day' && i.day === 1)).toBe(true)
    const withOverscan = visibleItems(g, 0, 200, ROW_H * 6).filter((i) => i.kind === 'row').length
    const without = visibleItems(g, 0, 200, 0).filter((i) => i.kind === 'row').length
    expect(withOverscan).toBeGreaterThan(without)
    expect(visibleItems(listGeometry([]), 0, 500)).toEqual([])
    expect(rowRange([])).toBeNull()
  })

  it('[AR-03] headings read Today, Yesterday, then the date (with the year only when not this year)', () => {
    const now = new Date(2026, 9, 9, 15, 30).getTime()
    expect(dayLabel(day(2026, 10, 9), now, 'en-US')).toBe('Today')
    expect(dayLabel(day(2026, 10, 8), now, 'en-US')).toBe('Yesterday')
    expect(dayLabel(day(2026, 10, 6), now, 'en-US')).toBe('Tuesday, October 6')
    expect(dayLabel(day(2025, 12, 31), now, 'en-US')).toBe('Wednesday, December 31, 2025')
  })
})
