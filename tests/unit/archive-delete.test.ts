import { describe, expect, it } from 'vitest'
import { DELETE_UNDO_MS, DeleteUndo } from '../../src/main/archive/delete-undo'
import { ArchiveStore, type StoredEntry } from '../../src/main/archive/store'
import type { MainContext } from '../../src/main/context'
import { Store } from '../../src/main/store'
import { makeTab } from '../../src/main/tabs/model'
import { createInitialState, createProfile, DEFAULT_PROFILE_ID } from '../../src/shared/defaults'
import type { ArchivedTab } from '../../src/shared/state'

const NOW = new Date(2026, 9, 9, 15, 0, 0).getTime()

async function world() {
  const state = createInitialState(0)
  const spaceId = state.spaceOrder[0] as string
  const work = createProfile('Work', 'p-work')
  state.profiles[work.id] = work
  const store = new Store(state)
  const archive = new ArchiveStore(null)
  await archive.load()
  let now = NOW
  const undo = new DeleteUndo({ store } as unknown as MainContext, archive, () => now)
  const entry = (n: number, extra: Partial<ArchivedTab> = {}): ArchivedTab => ({
    id: `a-${n}`,
    tabId: `t-${n}`,
    url: `https://site${n}.test/`,
    title: `Page ${n}`,
    spaceId,
    profileId: DEFAULT_PROFILE_ID,
    archivedAt: NOW - n * 60_000,
    reason: 'closed',
    section: 'today',
    ...extra,
  })
  const history = { entries: [{ url: 'https://site1.test/', title: 'Page 1' }], index: 0 }
  archive.add([entry(1), entry(2), entry(3, { profileId: work.id })], new Map([['a-1', history]]))
  /** Deletes as the Library does: the entries are kept for Undo first. */
  const del = (ids: string[]): number => {
    const kept = ids.map((id) => archive.get(id)).filter((e): e is StoredEntry => !!e)
    archive.delete(ids)
    return undo.keep(kept)
  }
  /** Every entry, newest first. */
  const listed = () => [...archive.newestFirst()].map((i) => i.e.id)
  return { store, archive, undo, del, history, listed, later: (ms: number) => (now += ms) }
}

describe('Delete from the Archive has an Undo (AR-07, review F5)', () => {
  it('[AR-07] Undo puts the deleted entries back in their place, with their history, once', async () => {
    const w = await world()
    const step = w.del(['a-1', 'a-3'])
    expect(w.listed()).toEqual(['a-2'])
    expect(w.undo.undo(step)).toBe(2)
    expect(w.listed()).toEqual(['a-1', 'a-2', 'a-3'])
    expect(w.archive.get('a-1')?.history).toEqual(w.history)
    // Once only.
    expect(w.undo.undo(step)).toBe(0)
    expect(w.listed()).toEqual(['a-1', 'a-2', 'a-3'])
  })

  it('[AR-07] a minute after the delete, Undo puts nothing back; nor entries whose tab or profile changed since', async () => {
    const w = await world()
    const late = w.del(['a-1'])
    w.later(DELETE_UNDO_MS + 1)
    expect(w.undo.undo(late)).toBe(0)
    expect(w.listed()).toEqual(['a-2', 'a-3'])
    // Since the delete, a-2's tab came back to the sidebar and a-3's profile was deleted.
    const step = w.del(['a-2', 'a-3'])
    w.store.update((d) => {
      d.tabs['t-2'] = makeTab({
        id: 't-2',
        url: 'https://site2.test/',
        spaceId: d.spaceOrder[0] as string,
        profileId: DEFAULT_PROFILE_ID,
      })
      delete d.profiles['p-work']
    })
    expect(w.undo.undo(step)).toBe(0)
    expect(w.listed()).toEqual([])
    // Unknown steps put nothing back.
    expect(w.undo.undo(99)).toBe(0)
    expect(w.undo.undo('1')).toBe(0)
  })
})
