import { describe, expect, it } from 'vitest'
import { Store } from '../../src/main/store'
import { createInitialState } from '../../src/shared/defaults'

describe('Store', () => {
  it('emits patches synchronously and batches them per microtask', async () => {
    const store = new Store(createInitialState(0))
    const sync: number[] = []
    const batches: { seq: number; n: number }[] = []
    store.subscribe((_n, _p, patches) => sync.push(patches.length))
    store.subscribeBatches((seq, patches) => batches.push({ seq, n: patches.length }))
    store.update((d) => {
      d.settings.searchEngine = 'duckduckgo'
    })
    store.update((d) => {
      d.settings.autoPip = false
    })
    expect(sync).toEqual([1, 1])
    expect(batches).toEqual([])
    await Promise.resolve()
    expect(batches).toEqual([{ seq: 1, n: 2 }])
  })

  it('skips no-op updates and gives snapshots a consistent seq', () => {
    const store = new Store(createInitialState(0))
    const before = store.state
    store.update(() => {})
    expect(store.state).toBe(before)
    store.update((d) => {
      d.settings.onboarded = true
    })
    const snap = store.snapshot()
    expect(snap.seq).toBe(1)
    expect(snap.state.settings.onboarded).toBe(true)
  })
})
