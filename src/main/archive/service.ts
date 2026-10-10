import type { Patch } from 'immer'
import type { ArchivedTab, OrbitState, ProfileId, TabId } from '../../shared/state'
import type { MainContext } from '../context'
import { onArchiveHistory, takeArchiveHistory } from './inbox'
import type { ArchiveHistory, ArchiveStore } from './store'

/** `state.archive` keeps the most recent entries (other code writes and undoes against them)… */
export const HOT_MAX = 300
/** …and when it grows past HOT_MAX, the oldest go to the store only, down to this many… */
export const HOT_KEEP = 200
/** …but never entries younger than this (an undo may still take them back out of state). */
export const MIN_HOT_AGE_MS = 15 * 60_000

/** Private (in-memory) profiles leave nothing behind (AR-01, NV-11). Unknown profiles neither. */
export function isPrivateOrGone(state: OrbitState, profileId: ProfileId): boolean {
  if (profileId.startsWith('private-')) return true
  const profile = state.profiles[profileId]
  return !profile?.partition.startsWith('persist:')
}

/**
 * Keeps the Archive store in step with `state.archive` (AR-01).
 *
 * `state.archive` is the recent window: the tabs, Spaces, Peek and Mini Window code append entries
 * there and remove them again when they undo or reopen. The store holds every entry plus its
 * history. This service:
 * - adds each new entry to the store, with the history the tabs code handed over (inbox.ts);
 * - deletes from the store what other code removed from state (restored by undo or ⌘⇧T);
 * - moves the oldest entries out of state once it holds more than HOT_MAX ("spill"): they stay
 *   in the store, which is what the Library and the command bar search;
 * - drops entries of private or deleted profiles, and entries whose tab came back after a spill.
 */
export class ArchiveSync {
  /** Ids of the entries in state.archive, as last seen. */
  private hot = new Set<string>()
  /** Ids this service took out of state itself: moved to the store only, or already deleted there. */
  private ownRemovals = new Set<string>()
  private started = false
  /**
   * New entries to leave out of the Archive (taken out of state again), beside private ones: a
   * preview's page coming back as its Peek closes (AR-06, preview.ts).
   */
  skip?: (state: OrbitState, entry: ArchivedTab) => boolean

  constructor(
    private ctx: Pick<MainContext, 'store'>,
    readonly store: ArchiveStore,
    private now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.started) return
    this.started = true
    const state = this.ctx.store.state
    this.hot = new Set(state.archive.map((a) => a.id))
    this.ingest(state, state.archive)
    this.ctx.store.subscribe((next, prev, patches) => this.onState(next, prev, patches))
    onArchiveHistory((id) => {
      if (!this.hot.has(id) && !this.store.has(id)) return
      const h = takeArchiveHistory(id)
      if (h) this.store.setHistory(id, h)
    })
    this.store.afterLoad(() => this.afterLoad())
  }

  /** Detaches from the inbox (tests that make several). */
  stop(): void {
    onArchiveHistory(undefined)
  }

  /** Removes entries from state and the store (restored, deleted). */
  remove(ids: Iterable<string>): string[] {
    const list = [...ids]
    const set = new Set(list)
    const inState = this.ctx.store.state.archive.some((a) => set.has(a.id))
    if (inState) {
      for (const id of set) if (this.hot.has(id)) this.ownRemovals.add(id)
      this.ctx.store.update((d) => {
        d.archive = d.archive.filter((a) => !set.has(a.id))
      })
    }
    return this.store.delete(list)
  }

  /** Clears a profile's entries from state and the store. Returns the ids removed. */
  clearProfile(profileId: ProfileId): string[] {
    const state = this.ctx.store.state
    const hotIds = state.archive.filter((a) => a.profileId === profileId).map((a) => a.id)
    if (hotIds.length) {
      for (const id of hotIds) this.ownRemovals.add(id)
      const set = new Set(hotIds)
      this.ctx.store.update((d) => {
        d.archive = d.archive.filter((a) => !set.has(a.id))
      })
    }
    const gone = new Set(this.store.clear(profileId, this.now()))
    for (const id of hotIds) gone.add(id)
    return [...gone]
  }

  /** The store's entries are known once the log is read: catch up with state. */
  private afterLoad(): void {
    const state = this.ctx.store.state
    this.ingest(state, state.archive)
    // Entries whose tab is back in the sidebar (an undo that raced a crash, say) leave the Archive.
    const stale: string[] = []
    for (const tabId of Object.keys(state.tabs)) {
      for (const id of this.store.idsOfTab(tabId)) if (!this.hot.has(id)) stale.push(id)
    }
    if (stale.length) this.store.delete(stale)
    this.dropProfilesGone(state)
    this.spill(state)
  }

  private onState(next: OrbitState, prev: OrbitState, patches: Patch[]): void {
    if (next.archive !== prev.archive) this.syncArchive(next)
    if (next.profiles !== prev.profiles) this.dropProfilesGone(next)
    // A tab that comes back (undo, ⌘⇧T) takes its entry out of the Archive, even one moved to the store.
    for (const p of patches) {
      if (p.op !== 'add' || p.path.length !== 2 || p.path[0] !== 'tabs') continue
      const tabId = String(p.path[1]) as TabId
      const cold = this.store.idsOfTab(tabId).filter((id) => !this.hot.has(id))
      if (cold.length) this.store.delete(cold)
    }
  }

  private syncArchive(next: OrbitState): void {
    const ids = new Set<string>()
    const added: ArchivedTab[] = []
    for (const a of next.archive) {
      ids.add(a.id)
      if (!this.hot.has(a.id)) added.push(a)
    }
    const removed: string[] = []
    for (const id of this.hot) {
      if (ids.has(id)) continue
      if (this.ownRemovals.delete(id)) continue
      removed.push(id)
    }
    this.hot = ids
    if (removed.length) this.store.delete(removed)
    if (added.length) this.ingest(next, added)
    this.spill(next)
  }

  /** Adds entries to the store; private ones (and `skip`'s) are taken out of state instead. */
  private ingest(state: OrbitState, entries: readonly ArchivedTab[]): void {
    const keep: ArchivedTab[] = []
    const drop: string[] = []
    const histories = new Map<string, ArchiveHistory>()
    for (const e of entries) {
      if (isPrivateOrGone(state, e.profileId) || this.skip?.(state, e)) {
        drop.push(e.id)
        takeArchiveHistory(e.id)
        continue
      }
      keep.push(e)
      const h = takeArchiveHistory(e.id)
      if (h) histories.set(e.id, h)
    }
    if (keep.length) this.store.add(keep, histories)
    if (drop.length) this.dropFromState(drop)
  }

  private dropFromState(ids: string[]): void {
    const set = new Set(ids)
    for (const id of ids) if (this.hot.has(id)) this.ownRemovals.add(id)
    this.ctx.store.update((d) => {
      d.archive = d.archive.filter((a) => !set.has(a.id))
    })
  }

  /** A deleted profile's Archive goes with it (like its history). */
  private dropProfilesGone(state: OrbitState): void {
    if (!this.store.ready) return
    const profiles = new Set<ProfileId>()
    for (const e of this.store.newestFirst()) if (!state.profiles[e.e.profileId]) profiles.add(e.e.profileId)
    for (const p of profiles) this.store.clear(p)
    const hotGone = state.archive.filter((a) => !state.profiles[a.profileId]).map((a) => a.id)
    if (hotGone.length) this.dropFromState(hotGone)
  }

  /** Moves the oldest entries out of state once it holds more than HOT_MAX. */
  private spill(state: OrbitState): void {
    const list = state.archive
    if (list.length <= HOT_MAX) return
    const cutoff = this.now() - MIN_HOT_AGE_MS
    const want = list.length - HOT_KEEP
    const out: string[] = []
    for (const a of list) {
      if (out.length >= want) break
      if (a.archivedAt < cutoff) out.push(a.id)
    }
    if (out.length === 0) return
    const set = new Set(out)
    for (const id of out) this.ownRemovals.add(id)
    this.ctx.store.update((d) => {
      d.archive = d.archive.filter((a) => !set.has(a.id))
    })
  }
}
