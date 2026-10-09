import { type Draft, enablePatches, type Patch, produceWithPatches, setAutoFreeze } from 'immer'
import type { OrbitState } from '../shared/state'

enablePatches()
// State is replaced, never mutated, so freezing only costs time in hot paths.
setAutoFreeze(false)

export type StateListener = (next: OrbitState, prev: OrbitState, patches: Patch[]) => void
export type PatchBatchListener = (seq: number, patches: Patch[]) => void

/**
 * The single source of truth for Orbit's state, owned by the main process.
 * Every update produces Immer patches. Synchronous listeners see each update;
 * batch listeners (IPC broadcast) get patches coalesced per microtask.
 */
export class Store {
  private current: OrbitState
  private listeners = new Set<StateListener>()
  private batchListeners = new Set<PatchBatchListener>()
  private pending: Patch[] = []
  private flushQueued = false
  private seqNo = 0

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
    for (const listener of this.listeners) listener(next, prev, patches)
    this.pending.push(...patches)
    if (!this.flushQueued) {
      this.flushQueued = true
      queueMicrotask(() => this.flush())
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
