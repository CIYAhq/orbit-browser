import type { MainContext } from '../context'
import { isPrivateOrGone } from './service'
import type { ArchiveHistory, ArchiveStore, StoredEntry } from './store'

/** How long after a delete its toast's Undo still puts the entries back. */
export const DELETE_UNDO_MS = 60_000
/** Deletes kept for Undo at most. */
const DELETES_KEPT = 10

/**
 * Entries deleted from the Archive (AR-07: a row's Delete, the selection's Delete), kept in memory
 * for a minute so the Library's toast can put them back with their history. Nothing is written for
 * them: once the minute is up they are only in the log until it is compacted.
 */
export class DeleteUndo {
  private last = 0
  private kept = new Map<number, { at: number; entries: StoredEntry[] }>()

  constructor(
    private ctx: Pick<MainContext, 'store'>,
    private store: Pick<ArchiveStore, 'add'>,
    private now: () => number = Date.now,
  ) {}

  /** Keeps the entries of one delete; returns its number for `undo`. */
  keep(entries: readonly StoredEntry[]): number {
    this.prune()
    const id = ++this.last
    this.kept.set(id, { at: this.now(), entries: [...entries] })
    if (this.kept.size > DELETES_KEPT) this.kept.delete(this.kept.keys().next().value as number)
    return id
  }

  /**
   * Puts delete `id`'s entries back (once). Entries whose tab is in the sidebar again, or whose
   * profile is private or gone, stay deleted. Returns how many came back.
   */
  undo(id: unknown): number {
    this.prune()
    const kept = typeof id === 'number' ? this.kept.get(id) : undefined
    if (!kept) return 0
    this.kept.delete(id as number)
    const state = this.ctx.store.state
    const histories = new Map<string, ArchiveHistory>()
    const entries = []
    for (const { history, ...entry } of kept.entries) {
      if (isPrivateOrGone(state, entry.profileId) || (entry.tabId && state.tabs[entry.tabId])) continue
      if (history) histories.set(entry.id, history)
      entries.push(entry)
    }
    return entries.length ? this.store.add(entries, histories).length : 0
  }

  private prune(): void {
    const cutoff = this.now() - DELETE_UNDO_MS
    for (const [id, k] of this.kept) if (k.at < cutoff) this.kept.delete(id)
  }
}
