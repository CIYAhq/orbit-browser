/** A select's choice (the shape of controls.tsx's Option; this file stays free of JSX for unit tests). */
interface Option<T> {
  value: T
  label: string
  disabled?: boolean
}

const MINUTE = 60 * 1000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** "6 hours", "24 hours", "7 days", "Never" (0). */
export function durationLabel(ms: number): string {
  if (ms <= 0) return 'Never'
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  if (ms % DAY === 0 && ms > DAY) return unit(ms / DAY, 'day')
  if (ms % HOUR === 0) return unit(ms / HOUR, 'hour')
  return unit(Math.max(1, Math.round(ms / MINUTE)), 'minute')
}

/** The choices, plus the current value when it is not one of them (set elsewhere or by an older Orbit). */
export function withCurrent(options: readonly Option<number>[], value: number): Option<number>[] {
  if (options.some((o) => o.value === value)) return [...options]
  return [...options, { value, label: durationLabel(value) }].sort((a, b) =>
    a.value === 0 ? 1 : b.value === 0 ? -1 : a.value - b.value,
  )
}
