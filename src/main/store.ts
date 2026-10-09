import { type Draft, enablePatches, type Patch, produceWithPatches, setAutoFreeze } from 'immer'
import type { OrbitState } from '../shared/state'

enablePatches()
// State is replaced, never mutated, so freezing only costs time in hot paths.
setAutoFreeze(false)

export type StateListener = (next: OrbitState, prev: OrbitState, patches: Patch[]) => void
export type PatchBatchListener = (seq: number, patches: Patch[]) => void

interface Change {
  next: OrbitState
  prev: OrbitState
  patches: Patch[]
}

/**
 * The single source of truth for Orbit's state, owned by the main process.
 * Every update produces Immer patches. Synchronous listeners see each update;
 * batch listeners (IPC broadcast) get patches coalesced per microtask.
 *
 * Ordering: an update applies at once (`state` reflects it immediately) and its
 * patches join the pending batch in the order updates were applied. A listener
 * may update the store; that nested change is delivered to every listener after
 * the current change has reached all of them, so each listener sees changes in
 * the order they happened and every broadcast batch replays cleanly on a mirror.
 */
export class Store {
  private current: OrbitState
  private listeners = new Set<StateListener>()
  private batchListeners = new Set<PatchBatchListener>()
  private pending: Patch[] = []
  private flushQueued = false
  private seqNo = 0
  /** Changes waiting for listener delivery (non-empty only while listeners run). */
  private queue: Change[] = []
  private notifying = false

  constructor(initial: OrbitState) {
    this.current = initial
  }

  get state(): OrbitState {
    return this.current
  }

  /** Sequence number of the last broadcast patch batch. */
  get seq(): number {
    return this.seqNo
  }

  update(recipe: (draft: Draft<OrbitState>) => void): void {
    const prev = this.current
    const [next, patches] = produceWithPatches(prev, recipe)
    if (patches.length === 0) return
    this.current = next
    // Queue the patches before any listener runs: a listener's own update must come after this one.
    this.pending.push(...patches)
    if (!this.flushQueued) {
      this.flushQueued = true
      queueMicrotask(() => this.flush())
    }
    this.queue.push({ next, prev, patches })
    if (this.notifying) return // the outer update() delivers it once the current change is done
    this.notifying = true
    try {
      for (let change = this.queue.shift(); change; change = this.queue.shift()) {
        for (const listener of this.listeners) {
          try {
            listener(change.next, change.prev, change.patches)
          } catch (err) {
            // One failing listener must not stop the others (or leave the window manager stale).
            console.error('[store] listener failed:', err)
          }
        }
      }
    } finally {
      this.notifying = false
    }
  }

  /** Flushes pending patches to batch listeners now (also runs automatically each microtask). */
  flush(): void {
    this.flushQueued = false
    if (this.pending.length === 0) return
    const patches = this.pending
    this.pending = []
    this.seqNo += 1
    for (const listener of this.batchListeners) listener(this.seqNo, patches)
  }

  /**
   * Returns a consistent snapshot for a renderer that is (re)syncing. Pending
   * patches are flushed first so the snapshot and sequence number match.
   */
  snapshot(): { state: OrbitState; seq: number } {
    this.flush()
    return { state: this.current, seq: this.seqNo }
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeBatches(listener: PatchBatchListener): () => void {
    this.batchListeners.add(listener)
    return () => this.batchListeners.delete(listener)
  }
}
