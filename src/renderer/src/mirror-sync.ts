import { applyPatches, type Patch } from 'immer'

export interface Snapshot<S> {
  state: S
  seq: number
}

interface Batch {
  seq: number
  patches: Patch[]
}

const RETRY_MS = 250

/**
 * Keeps a renderer's read-only mirror in step with main's numbered patch batches.
 * Batches apply in sequence order. On a gap, or a batch that fails to apply, it fetches
 * one snapshot (never several at once), buffers batches that arrive meanwhile and replays
 * the ones newer than the snapshot. Pure logic: the mirror store and IPC are passed in.
 */
export class MirrorSync<S> {
  private resyncing: Promise<void> | undefined
  private buffered: Batch[] = []
  /** Snapshots fetched so far (the first load included). */
  resyncs = 0

  constructor(
    private readonly current: () => Snapshot<S> | undefined,
    private readonly set: (snapshot: Snapshot<S>) => void,
    private readonly fetch: () => Promise<Snapshot<S>>,
    private readonly report: (message: string, error: unknown) => void = (m, e) => console.error(m, e),
  ) {}

  /** Loads the first snapshot; batches that arrive before it are buffered and replayed. */
  start(): Promise<void> {
    return this.resync()
  }

  receive(seq: number, patches: Patch[]): void {
    const mirror = this.current()
    if (this.resyncing || !mirror) {
      this.buffered.push({ seq, patches })
      if (!this.resyncing) void this.resync()
      return
    }
    if (seq <= mirror.seq) return
    if (seq !== mirror.seq + 1) {
      this.buffered.push({ seq, patches })
      void this.resync()
      return
    }
    let state: S
    try {
      state = applyPatches(mirror.state as object, patches) as S
    } catch (error) {
      this.report('[store] patch batch did not apply; resyncing', error)
      void this.resync()
      return
    }
    this.set({ state, seq })
  }

  /** Fetches a fresh snapshot unless one is already on its way; retries until it arrives. */
  resync(): Promise<void> {
    if (this.resyncing) return this.resyncing
    this.resyncs += 1
    const load = async (): Promise<void> => {
      for (;;) {
        try {
          this.set(await this.fetch())
          return
        } catch (error) {
          this.report('[store] state snapshot failed; retrying', error)
          await new Promise((r) => setTimeout(r, RETRY_MS))
        }
      }
    }
    this.resyncing = load().finally(() => {
      this.resyncing = undefined
      const batches = this.buffered.splice(0).sort((a, b) => a.seq - b.seq)
      for (const batch of batches) this.receive(batch.seq, batch.patches)
    })
    return this.resyncing
  }
}
