import { applyPatches, type Patch } from 'immer'
import { describe, expect, it, vi } from 'vitest'
import { Store } from '../../src/main/store'
import { makeTab } from '../../src/main/tabs/model'
import { createInitialState, DEFAULT_PROFILE_ID } from '../../src/shared/defaults'
import type { OrbitState } from '../../src/shared/state'

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

  // Review M2: a listener that updates inside an update (WindowManager → ensure → adopt) used to
  // put its patches before the outer update's, so mirrors failed to apply the batch.
  it('broadcasts nested updates after the update that triggered them', async () => {
    const initial = createInitialState(0)
    const store = new Store(initial)
    const spaceId = initial.spaceOrder[0] as string
    const tab = makeTab({ spaceId, profileId: DEFAULT_PROFILE_ID, url: 'https://a.test/' }, 0)
    // Like WindowManager: when a tab is added, wake it (a nested update of the same tab).
    store.subscribe((next, prev) => {
      for (const id of Object.keys(next.tabs)) {
        if (!prev.tabs[id] && next.tabs[id]?.asleep) {
          store.update((d) => {
            const t = d.tabs[id]
            if (t) t.asleep = false
          })
        }
      }
    })
    const batches: Patch[][] = []
    store.subscribeBatches((_seq, patches) => batches.push(patches))
    store.update((d) => {
      d.tabs[tab.id] = tab
      d.spaces[spaceId]?.today.unshift(tab.id)
    })
    expect(store.state.tabs[tab.id]?.asleep).toBe(false)
    await Promise.resolve()
    expect(batches).toHaveLength(1)
    const mirrored = applyPatches(initial, batches[0] as Patch[])
    expect(mirrored).toEqual(store.state)
  })

  it('delivers nested changes to every listener in the order they were applied', () => {
    const store = new Store(createInitialState(0))
    const seen: string[] = []
    store.subscribe((next, prev) => {
      seen.push(`a:${prev.settings.searchEngine}->${next.settings.searchEngine}`)
      if (next.settings.searchEngine === 'bing') {
        store.update((d) => {
          d.settings.searchEngine = 'kagi'
        })
        // The nested update applies at once even though listeners hear about it later.
        expect(store.state.settings.searchEngine).toBe('kagi')
      }
    })
    store.subscribe((next, prev) => seen.push(`b:${prev.settings.searchEngine}->${next.settings.searchEngine}`))
    store.update((d) => {
      d.settings.searchEngine = 'bing'
    })
    expect(seen).toEqual(['a:google->bing', 'b:google->bing', 'a:bing->kagi', 'b:bing->kagi'])
  })

  it('keeps notifying and broadcasting when a listener throws', async () => {
    const store = new Store(createInitialState(0))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const later: OrbitState[] = []
    store.subscribe(() => {
      throw new Error('boom')
    })
    store.subscribe((next) => later.push(next))
    const batches: number[] = []
    store.subscribeBatches((seq) => batches.push(seq))
    store.update((d) => {
      d.settings.autoPip = false
    })
    expect(later).toHaveLength(1)
    await Promise.resolve()
    expect(batches).toEqual([1])
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})
