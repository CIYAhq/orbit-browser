import type { ArchiveKeepResult } from '../../shared/commands/archive'
import type { OrbitState } from '../../shared/state'
import type { MainContext } from '../context'
import type { ArchiveSync } from './service'
import type { ArchiveStore } from './store'

export const DAY_MS = 24 * 60 * 60_000
/** How often the Archive is checked for entries past their time (AR-08: "on launch and daily"). */
export const PURGE_EVERY_MS = 60 * 60_000
/** The default and the choices offered (AR-08); 0 keeps entries forever. */
export const KEEP_DAYS_DEFAULT = 30
export const KEEP_DAYS_CHOICES: readonly { days: number; label: string }[] = [
  { days: 30, label: '30 Days' },
  { days: 90, label: '90 Days' },
  { days: 365, label: '1 Year' },
  { days: 0, label: 'Forever' },
]

/** The setting as a number of days: a whole number of days, 0 for forever, else the default. */
export function keepDaysOf(state: Pick<OrbitState, 'settings'>): number {
  const days = state.settings.archiveKeepDays
  return Number.isInteger(days) && days >= 0 ? days : KEEP_DAYS_DEFAULT
}

/**
 * Sets how long Archive entries are kept (AR-08). A shorter time deletes the older entries at once
 * (scheduleRetention), so when it would delete any, nothing changes until `confirmed`: the user is
 * asked first, told how many go. The store must be read.
 */
export function setKeepDays(
  ctx: Pick<MainContext, 'store'>,
  store: Pick<ArchiveStore, 'olderThan'>,
  days: number,
  confirmed: boolean,
  now: number = Date.now(),
): ArchiveKeepResult {
  if (!KEEP_DAYS_CHOICES.some((c) => c.days === days)) return { set: false, purges: 0 }
  if (keepDaysOf(ctx.store.state) === days) return { set: true, purges: 0 }
  const purges = days > 0 ? store.olderThan(now - days * DAY_MS).length : 0
  if (purges > 0 && !confirmed) return { set: false, purges }
  ctx.store.update((d) => {
    d.settings.archiveKeepDays = days
  })
  return { set: true, purges }
}

/**
 * Removes Archive entries archived more than `keepDays` days ago (AR-08), from the store and from
 * `state.archive`. Browsing history is not touched: a purged page stays findable there (AR-10).
 * Returns the ids removed.
 */
export function purgeExpired(sync: ArchiveSync, store: ArchiveStore, keepDays: number, now: number): string[] {
  if (!(keepDays > 0) || !store.ready) return []
  const ids = store.olderThan(now - keepDays * DAY_MS)
  return ids.length ? sync.remove(ids) : []
}

/**
 * Keeps the Archive within its retention (AR-08): once the store is read at launch, every hour
 * after that, and right away when the setting gets shorter.
 */
export function scheduleRetention(
  ctx: { store: { state: OrbitState; subscribe(fn: (next: OrbitState) => void): () => void } },
  sync: ArchiveSync,
  store: ArchiveStore,
  now: () => number = Date.now,
): () => void {
  const purge = () => purgeExpired(sync, store, keepDaysOf(ctx.store.state), now())
  store.afterLoad(purge)
  const timer = setInterval(purge, PURGE_EVERY_MS)
  timer.unref?.()
  let days = keepDaysOf(ctx.store.state)
  const off = ctx.store.subscribe((next) => {
    const next_ = keepDaysOf(next)
    if (next_ === days) return
    days = next_
    purge()
  })
  return () => {
    clearInterval(timer)
    off()
  }
}
