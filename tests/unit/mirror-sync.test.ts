import { enablePatches, type Patch, produceWithPatches } from 'immer'
import { describe, expect, it } from 'vitest'
import { MirrorSync, type Snapshot } from '../../src/renderer/src/mirror-sync'

enablePatches()

type S = { n: number; list: string[] }

/** A main-process stand-in: numbered patch batches plus snapshots on request. */
function harness(initial: S = { n: 0, list: [] }) {
  let main: Snapshot<S> = { state: initial, seq: 0 }
  const batches: { seq: number; patches: Patch[] }[] = []
  const update = (recipe: (d: S) => void) => {
    const [state, patches] = produceWithPatches(main.state, recipe)
    main = { state, seq: main.seq + 1 }
    batches.push({ seq: main.seq, patches })
    return batches[batches.length - 1] as { seq: number; patches: Patch[] }
  }
  let mirror: Snapshot<S> | undefined
  const fetches: Array<(s: Snapshot<S>) => void> = []
  const errors: string[] = []
  const sync = new MirrorSync<S>(
    () => mirror,
    (s) => {
      mirror = s
    },
    () => new Promise((resolve) => fetches.push(resolve)),
    (m) => errors.push(m),
  )
  /** Answers every pending snapshot request with main's current state. */
  const answer = async () => {
    for (const resolve of fetches.splice(0)) resolve(main)
    await new Promise((r) => setTimeout(r, 0))
  }
  return { sync, update, answer, fetches, errors, mirror: () => mirror, main: () => main }
}

describe('MirrorSync (review F4)', () => {
  it('loads a snapshot, replays early batches and applies later ones in order', async () => {
    const h = harness()
    const started = h.sync.start()
    const early = h.update((d) => {
      d.n = 1
    })
    h.sync.receive(early.seq, early.patches)
    await h.answer()
    await started
    expect(h.mirror()).toEqual(h.main())
    const b = h.update((d) => {
      d.list.push('a')
    })
    h.sync.receive(b.seq, b.patches)
    h.sync.receive(b.seq, b.patches) // duplicate: ignored
    expect(h.mirror()).toEqual(h.main())
    expect(h.sync.resyncs).toBe(1)
  })

  it('fetches one snapshot for a gap and replays newer batches that arrive meanwhile', async () => {
    const h = harness()
    const started = h.sync.start()
    await h.answer()
    await started
    h.update((d) => {
      d.n = 1
    }) // lost
    const b2 = h.update((d) => {
      d.n = 2
    })
    h.sync.receive(b2.seq, b2.patches) // gap → resync
    const snapshotAt = h.main()
    const b3 = h.update((d) => {
      d.list.push('x')
    })
    h.sync.receive(b3.seq, b3.patches) // buffered, no second fetch
    expect(h.fetches).toHaveLength(1)
    // The snapshot reflects seq 2; batch 3 is replayed on top of it.
    for (const resolve of h.fetches.splice(0)) resolve(snapshotAt)
    await new Promise((r) => setTimeout(r, 0))
    expect(h.mirror()).toEqual(h.main())
    expect(h.sync.resyncs).toBe(2)
  })

  it('resyncs when a batch does not apply', async () => {
    const h = harness({ n: 0, list: [] })
    const started = h.sync.start()
    await h.answer()
    await started
    const bad: Patch[] = [{ op: 'replace', path: ['missing', 'deep'], value: 1 }]
    h.sync.receive(1, bad)
    expect(h.errors).toHaveLength(1)
    expect(h.fetches).toHaveLength(1)
    h.update((d) => {
      d.n = 5
    })
    await h.answer()
    expect(h.mirror()).toEqual(h.main())
  })

  it('retries a failed snapshot request', async () => {
    let calls = 0
    let mirror: Snapshot<S> | undefined
    const sync = new MirrorSync<S>(
      () => mirror,
      (s) => {
        mirror = s
      },
      async () => {
        calls += 1
        if (calls === 1) throw new Error('ipc down')
        return { state: { n: 9, list: [] }, seq: 4 }
      },
      () => {},
    )
    await sync.start()
    expect(calls).toBe(2)
    expect(mirror).toEqual({ state: { n: 9, list: [] }, seq: 4 })
  })
})
