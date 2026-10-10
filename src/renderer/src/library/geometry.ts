/**
 * Layout of the Archive list (AR-03): day headings and rows of fixed heights, so any slice of
 * thousands of entries is placed without measuring (the list is virtualised).
 */

/** Height of one entry row and of a day heading, in px. */
export const ROW_H = 40
export const HEAD_H = 36

export interface ListGeometry {
  /** [start of the day (ms), entries that day], newest day first. */
  days: readonly (readonly [number, number])[]
  /** Offset (in the whole list) of each day's first entry. */
  starts: number[]
  /** Pixel top of each day's heading. */
  tops: number[]
  /** Entries in all. */
  total: number
  height: number
}

export type ListItem =
  | { kind: 'day'; day: number; at: number; top: number; count: number }
  | { kind: 'row'; offset: number; top: number }

export function listGeometry(days: readonly (readonly [number, number])[]): ListGeometry {
  const starts: number[] = []
  const tops: number[] = []
  let rows = 0
  let top = 0
  for (const [, count] of days) {
    starts.push(rows)
    tops.push(top)
    rows += count
    top += HEAD_H + count * ROW_H
  }
  return { days, starts, tops, total: rows, height: top }
}

/** Index of the last element of a sorted list that is ≤ value (0 when none is). */
function lastAtOrBefore(list: readonly number[], value: number): number {
  let lo = 0
  let hi = list.length - 1
  let found = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if ((list[mid] as number) <= value) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

/** The day an entry (by offset) belongs to. */
export function dayOfOffset(g: ListGeometry, offset: number): number {
  return lastAtOrBefore(g.starts, offset)
}

/** Pixel top of an entry's row. */
export function rowTop(g: ListGeometry, offset: number): number {
  const d = dayOfOffset(g, offset)
  return (g.tops[d] ?? 0) + HEAD_H + (offset - (g.starts[d] ?? 0)) * ROW_H
}

/** Headings and rows that intersect [top - overscan, top + height + overscan], in order. */
export function visibleItems(g: ListGeometry, top: number, height: number, overscan = ROW_H * 6): ListItem[] {
  const from = Math.max(0, top - overscan)
  const to = top + height + overscan
  const items: ListItem[] = []
  if (g.days.length === 0) return items
  for (let d = lastAtOrBefore(g.tops, from); d < g.days.length; d++) {
    const dayTop = g.tops[d] as number
    if (dayTop >= to) break
    const [at, count] = g.days[d] as readonly [number, number]
    if (dayTop + HEAD_H > from) items.push({ kind: 'day', day: d, at, top: dayTop, count })
    const rowsTop = dayTop + HEAD_H
    const first = Math.max(0, Math.floor((from - rowsTop) / ROW_H))
    const last = Math.min(count - 1, Math.floor((to - rowsTop) / ROW_H))
    for (let i = first; i <= last; i++) {
      items.push({ kind: 'row', offset: (g.starts[d] as number) + i, top: rowsTop + i * ROW_H })
    }
  }
  return items
}

/** First and last entry offsets among the items (for fetching pages), or null when there are none. */
export function rowRange(items: readonly ListItem[]): [number, number] | null {
  let first = -1
  let last = -1
  for (const item of items) {
    if (item.kind !== 'row') continue
    if (first < 0) first = item.offset
    last = item.offset
  }
  return first < 0 ? null : [first, last]
}

/** Local-day heading: Today, Yesterday, then the date (with the year when it is not this year). */
export function dayLabel(dayStart: number, now: number, locale?: string): string {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (dayStart >= today.getTime()) return 'Today'
  if (dayStart >= yesterday.getTime()) return 'Yesterday'
  const date = new Date(dayStart)
  return dateFormat(locale, date.getFullYear() !== today.getFullYear()).format(date)
}

const formats = new Map<string, Intl.DateTimeFormat>()
/** Formatters are slow to make: one per locale and shape. */
function dateFormat(locale: string | undefined, withYear: boolean): Intl.DateTimeFormat {
  const key = `${locale ?? ''}|${withYear}`
  let format = formats.get(key)
  if (!format) {
    const opts: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric' }
    if (withYear) opts.year = 'numeric'
    format = new Intl.DateTimeFormat(locale, opts)
    formats.set(key, format)
  }
  return format
}
