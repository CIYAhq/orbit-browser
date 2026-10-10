/** When update checks run and how long their results last (UP-01, UP-02, UP-06). */

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

/** Background checks run about this often, after one shortly after launch (UP-01). */
export const CHECK_EVERY_MS = 4 * HOUR
/** ± this much, so copies of Orbit started together don't all ask at the same moment. */
export const CHECK_JITTER_MS = 30 * MINUTE
/** The first check waits this long after launch, so it never slows the start. */
export const FIRST_CHECK_MS = 30 * 1000
/** A dismissed update banner comes back after about a day, or at the next launch (UP-02). */
export const DISMISS_MS = 24 * HOUR
/** What's new shows for a few days at most (UP-06). */
export const WHATS_NEW_MS = 3 * 24 * HOUR
/** A check that takes longer than this has failed. */
export const CHECK_TIMEOUT_MS = 20 * 1000
/** A feed larger than this isn't one. */
export const MAX_FEED_BYTES = 1_000_000

/** The delay before the next background check: CHECK_EVERY_MS ± CHECK_JITTER_MS. */
export function nextCheckDelay(random = Math.random()): number {
  const r = Math.min(1, Math.max(0, random))
  return Math.round(CHECK_EVERY_MS + (r * 2 - 1) * CHECK_JITTER_MS)
}
