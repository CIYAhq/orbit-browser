/**
 * Contextual hints (OB-11): small notes at the moment Orbit does something that can surprise, in
 * place of a long tour. Each kind shows a limited number of times, counted in the state file: a
 * one-time banner once, a tip a few times.
 */
export const HINT_LIMITS = {
  /** Today tabs were archived on their own for the first time (TD-03): what happened, and how to get them back. */
  archive: 1,
  /** The sidebar was hidden: how to bring it back. */
  sidebar: 3,
} as const satisfies Record<string, number>

export type HintKind = keyof typeof HINT_LIMITS

export const HINT_KINDS = Object.keys(HINT_LIMITS) as HintKind[]

/** How long a hint stays, unless the pointer is on it (OB-11: about 4–6 s, long enough to read). */
export const HINT_MS = 6000

/** "12 hours", "7 days": how long Today tabs wait before they're archived (ST-05), in a sentence. */
export function archivePeriodText(ms: number): string {
  const hours = Math.round(ms / 3_600_000)
  if (hours < 48) return hours === 1 ? '1 hour' : `${hours} hours`
  const days = Math.round(hours / 24)
  return `${days} days`
}
