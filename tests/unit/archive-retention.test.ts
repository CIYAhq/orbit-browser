import { afterEach, describe, expect, it, vi } from 'vitest'
import { DAY_MS, PURGE_EVERY_MS, purgeExpired, scheduleRetention, setKeepDays } from '../../src/main/archive/retention'
import { ArchiveSync } from '../../src/main/archive/service'
import { ArchiveStore } from '../../src/main/archive/store'
import type { MainContext } from '../../src/main/context'
import { normalizeState } from '../../src/main/persist'
import { Store } from '../../src/main/store'
import { createInitialState, DEFAULT_PROFILE_ID } from '../../src/shared/defaults'
import type { ArchivedTab } from '../../src/shared/state'

const NOW = new Date(2026, 9, 9, 15, 0, 0).getTime()

const syncs: ArchiveSync[] = []
afterEach(() => {
  for (const s of syncs.splice(0)) s.stop()
  vi.useRealTimers()
})

/** OrbitState with the Archive sync on a memory store; `push` archives a page `daysAgo` days ago. */
function world() {
  const state = createInitialState(0)
  const spaceId = state.spaceOrder[0] as string
  const store = new Store(state)
  const ctx = { store } as unknown as MainContext
  const archive = new ArchiveStore(null)
  const sync = new ArchiveSync(ctx, archive)
  syncs.push(sync)
  sync.start()
  let seq = 0
  const push = (daysAgo: number): string => {
    seq++
    const entry: ArchivedTab = {
      id: `a-${seq}`,
      url: `https://site${seq}.test/`,
      title: `Page ${seq}`,
      spaceId,
      profileId: DEFAULT_PROFILE_ID,
      archivedAt: NOW - daysAgo * DAY_MS,
      reason: 'auto',
      section: 'today',
    }
    store.update((d) => {
      d.archive.push(entry)
    })
    return entry.id
  }
  /** What the Archive holds: the store and OrbitState agree. */
  const ids = () => {
    const inStore = [...archive.newestFirst(DEFAULT_PROFILE_ID)].map((i) => i.e.id).reverse()
    const inState = store.state.archive.map((a) => a.id)
    expect(inState.filter((id) => !inStore.includes(id))).toEqual([])
    return inStore
  }
  return { store, ctx, archive, sync, push, ids }
}

describe('Archive retention (AR-08)', () => {
  it('[AR-08] entries archived longer ago than the days kept leave the store and OrbitState; 0 keeps them all', () => {
    const { archive, sync, push, ids } = world()
    const old = push(40)
    const older = push(31)
    const inside = push(29)
    const fresh = push(1 / 24)
    expect(purgeExpired(sync, archive, 0, NOW)).toEqual([])
    expect(ids()).toEqual([old, older, inside, fresh])
    expect(purgeExpired(sync, archive, 30, NOW).sort()).toEqual([old, older].sort())
    expect(ids()).toEqual([inside, fresh])
    expect(archive.has(old)).toBe(false)
  })

  it('[AR-08] retention runs at once, then every hour, and right away when fewer days are kept', () => {
    vi.useFakeTimers({ now: NOW })
    const { store, archive, sync, push, ids } = world()
    store.update((d) => {
      d.settings.archiveKeepDays = 90
    })
    push(100)
    const sixty = push(60)
    const twenty = push(20)
    // Half an hour short of 90 days: it goes with the next hourly check.
    const almost = push(90 - 1 / 48)
    const stop = scheduleRetention({ store }, sync, archive)
    // Oldest first.
    expect(ids()).toEqual([almost, sixty, twenty])
    vi.advanceTimersByTime(PURGE_EVERY_MS)
    expect(ids()).toEqual([sixty, twenty])
    store.update((d) => {
      d.settings.archiveKeepDays = 30
    })
    expect(ids()).toEqual([twenty])
    // Forever: nothing more goes, however long it runs.
    store.update((d) => {
      d.settings.archiveKeepDays = 0
    })
    vi.advanceTimersByTime(60 * DAY_MS)
    expect(ids()).toEqual([twenty])
    stop()
  })

  it('[AR-08] the setting defaults to 30 days, takes the offered choices only, and is repaired on load', () => {
    const { store, ctx, archive } = world()
    expect(store.state.settings.archiveKeepDays).toBe(30)
    expect(setKeepDays(ctx, archive, 45, false, NOW)).toEqual({ set: false, purges: 0 })
    expect(store.state.settings.archiveKeepDays).toBe(30)
    for (const days of [90, 365, 0, 30]) {
      expect(setKeepDays(ctx, archive, days, false, NOW)).toEqual({ set: true, purges: 0 })
      expect(store.state.settings.archiveKeepDays).toBe(days)
    }
    const load = (value: unknown) =>
      normalizeState({ settings: { archiveKeepDays: value } as never }).settings.archiveKeepDays
    expect(load(undefined)).toBe(30)
    expect(load(-1)).toBe(30)
    expect(load(2.5)).toBe(30)
    expect(load('90')).toBe(30)
    expect(load(0)).toBe(0)
    expect(load(365)).toBe(365)
  })

  it('[AR-08] a shorter Keep time that would delete entries changes nothing until the user says yes, and says how many (review F5)', () => {
    vi.useFakeTimers({ now: NOW })
    const { store, ctx, archive, sync, push, ids } = world()
    store.update((d) => {
      d.settings.archiveKeepDays = 0
    })
    const stop = scheduleRetention({ store }, sync, archive)
    const old = push(100)
    const sixty = push(60)
    const twenty = push(20)
    // Forever → 30 days would delete two: asked, not done.
    expect(setKeepDays(ctx, archive, 30, false, NOW)).toEqual({ set: false, purges: 2 })
    expect(store.state.settings.archiveKeepDays).toBe(0)
    vi.advanceTimersByTime(PURGE_EVERY_MS)
    expect(ids()).toEqual([old, sixty, twenty])
    // A time that deletes nothing is set at once.
    expect(setKeepDays(ctx, archive, 365, false, NOW)).toEqual({ set: true, purges: 0 })
    expect(store.state.settings.archiveKeepDays).toBe(365)
    expect(ids()).toEqual([old, sixty, twenty])
    // 90 days deletes one: once confirmed, it goes.
    expect(setKeepDays(ctx, archive, 90, false, NOW)).toEqual({ set: false, purges: 1 })
    expect(store.state.settings.archiveKeepDays).toBe(365)
    expect(setKeepDays(ctx, archive, 90, true, NOW)).toEqual({ set: true, purges: 1 })
    expect(store.state.settings.archiveKeepDays).toBe(90)
    expect(ids()).toEqual([sixty, twenty])
    stop()
  })
})
