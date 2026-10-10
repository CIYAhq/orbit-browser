/**
 * How downloads read in the sidebar and the Library (DL-03, DL-10): sizes, progress, time left, and
 * names truncated in the middle. Pure: unit-tested.
 */

const UNITS = ['KB', 'MB', 'GB', 'TB']

/** A size: "512 B", "3.2 MB", "12 MB" (1024-based; one decimal under 10). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`
  let value = bytes
  let unit = ''
  for (const u of UNITS) {
    value /= 1024
    unit = u
    if (value < 1024) break
  }
  const shown = value < 10 ? Math.floor(value * 10) / 10 : Math.round(value)
  return `${shown} ${unit}`
}

/** Bytes received out of the total: "3.2 MB of 10 MB", or "3.2 MB" when the total is unknown. */
export function formatProgress(received: number, total: number): string {
  return total > 0 ? `${formatBytes(received)} of ${formatBytes(total)}` : formatBytes(received)
}

/** Seconds left at a speed, or undefined when it can't be told (no total, stalled). */
export function secondsLeft(received: number, total: number, bytesPerSecond: number | undefined): number | undefined {
  if (!(total > 0) || !bytesPerSecond || bytesPerSecond <= 0) return undefined
  return Math.max(0, (total - received) / bytesPerSecond)
}

/** "5 s left", "3 min left", "1 h 20 min left". */
export function formatTimeLeft(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds))
  if (s < 60) return `${s} s left`
  if (s < 3600) return `${Math.round(s / 60)} min left`
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  return m > 0 && m < 60 ? `${h} h ${m} min left` : `${m >= 60 ? h + 1 : h} h left`
}

/** Speed smoothed over the samples so far, so the time left doesn't jump about. */
export function smoothSpeed(previous: number | undefined, sample: number, weight = 0.3): number {
  if (previous === undefined || previous <= 0) return sample
  if (sample <= 0) return previous * (1 - weight)
  return previous + (sample - previous) * weight
}

/** Percent done (0–100), or undefined when the total is unknown. */
export function percentDone(received: number, total: number): number | undefined {
  if (!(total > 0)) return undefined
  return Math.min(100, Math.max(0, (received / total) * 100))
}

/**
 * A file name split for truncation in the middle: the head gives way (with an ellipsis), the tail
 * stays: the end of the name and its extension ("quarterly-repo…rt-final.pdf").
 */
export function splitName(name: string, tailLength = 10): { head: string; tail: string } {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 && name.length - dot <= 8 ? name.slice(dot) : ''
  const stem = name.slice(0, name.length - ext.length)
  const keep = Math.min(stem.length, Math.max(0, tailLength - ext.length))
  const cut = stem.length - keep
  if (cut <= 1) return { head: '', tail: name }
  return { head: stem.slice(0, cut), tail: stem.slice(cut) + ext }
}

/** What the Library and the flyout say about a download (DL-10, DL-12, DL-14). */
export function statusText(d: {
  state: 'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted'
  receivedBytes: number
  totalBytes: number
  canResume?: boolean
  missing?: boolean
  danger?: string
}): string {
  switch (d.state) {
    case 'completed':
      if (d.missing) return 'File missing'
      return d.danger ? 'Can harm your computer' : formatBytes(d.totalBytes || d.receivedBytes)
    case 'progressing':
      return formatProgress(d.receivedBytes, d.totalBytes)
    case 'paused':
      return `Paused · ${formatProgress(d.receivedBytes, d.totalBytes)}`
    case 'interrupted':
      return d.canResume ? `Failed · ${formatProgress(d.receivedBytes, d.totalBytes)}` : 'Failed'
    case 'cancelled':
      return 'Cancelled'
  }
}

/** Downloads grouped by local day, newest first: [start of the day (ms), how many that day]. */
export function byDay(times: readonly number[]): [number, number][] {
  const days: [number, number][] = []
  for (const at of times) {
    const d = new Date(at)
    d.setHours(0, 0, 0, 0)
    const start = d.getTime()
    const last = days[days.length - 1]
    if (last && last[0] === start) last[1]++
    else days.push([start, 1])
  }
  return days
}

/** Whether a file name has every word of a search (any case, any order). */
export function nameMatches(name: string, search: string): boolean {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean)
  const lower = name.toLowerCase()
  return words.every((w) => lower.includes(w))
}
