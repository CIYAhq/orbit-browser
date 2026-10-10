import { afterEach, describe, expect, it, vi } from 'vitest'

// The command bar's module reads the clipboard and fetches suggestions; neither is used here.
vi.mock('electron', () => ({
  clipboard: { readText: () => Promise.resolve('') },
  net: { fetch: () => Promise.reject(new Error('offline')) },
}))

import { provideArchiveSource } from '../../src/main/archive/inbox'
import { ArchiveSync, HOT_KEEP } from '../../src/main/archive/service'
import { ArchiveStore } from '../../src/main/archive/store'
import { registerSearch } from '../../src/main/commandbar/search'
import type { MainContext } from '../../src/main/context'
import type { HistoryService } from '../../src/main/history'
import { HistoryStore } from '../../src/main/history/store'
import { ActionRegistry, CommandRegistry } from '../../src/main/registry'
import { Store } from '../../src/main/store'
import { createInitialState, createWindowState, DEFAULT_PROFILE_ID } from '../../src/shared/defaults'
import type { ArchivedTab } from '../../src/shared/state'

const DAY = 24 * 3600_000
const syncs: ArchiveSync[] = []
afterEach(() => {
  for (const s of syncs.splice(0)) s.stop()
  provideArchiveSource(undefined)
})

/** A window, the Archive (store and sync, as the Archive module wires them) and the command bar's search. */
async function world() {
  const state = createInitialState(0)
  const spaceId = state.spaceOrder[0] as string
  const win = createWindowState(spaceId)
  state.windows[win.id] = win
  const store = new Store(state)
  const archive = new ArchiveStore(null)
  await archive.load()
  const sync = new ArchiveSync({ store }, archive)
  syncs.push(sync)
  sync.start()
  provideArchiveSource(archive)
  const commands = new CommandRegistry()
  const history = new HistoryStore('/nonexistent/never-written.jsonl')
  const ctx = {
    store,
    commands,
    actions: new ActionRegistry(),
    windows: { focusedWindowId: () => win.id },
  } as unknown as MainContext
  registerSearch(ctx, { store: () => history } as unknown as HistoryService)
  const search = async (query: string) =>
    (await commands.run('search.query', { query, mode: 'new-tab' }, { windowId: win.id })).results
  return { store, archive, spaceId, search }
}

describe('Archived tabs in the command bar search the whole Archive (AR-04, review M1)', () => {
  it('[AR-04] the oldest of 350 tabs archived two days ago is found, after the recent window in state moved it to the store', async () => {
    const w = await world()
    const at = Date.now() - 2 * DAY
    const entries: ArchivedTab[] = Array.from({ length: 350 }, (_, i) => ({
      id: `a-${i}`,
      url: `http://localhost:3300/quokka/${i}`,
      title: `Quokka ${String(i).padStart(4, '0')}`,
      spaceId: w.spaceId,
      profileId: DEFAULT_PROFILE_ID,
      archivedAt: at + i,
      reason: 'closed',
    }))
    w.store.update((d) => {
      d.archive.push(...entries)
    })
    // The recent window in state keeps the newest; the store has them all.
    expect(w.store.state.archive).toHaveLength(HOT_KEEP)
    expect(w.store.state.archive.some((a) => a.id === 'a-3')).toBe(false)
    expect(w.archive.size).toBe(350)

    const oldest = (await w.search('Quokka 0003')).filter((r) => r.kind === 'archived')
    expect(oldest[0]).toMatchObject({ archiveId: 'a-3', title: 'Quokka 0003' })
    const newest = (await w.search('Quokka 0349')).filter((r) => r.kind === 'archived')
    expect(newest[0]).toMatchObject({ archiveId: 'a-349' })
    // An entry that left the Archive is no longer offered.
    w.archive.delete(['a-3'])
    expect((await w.search('Quokka 0003')).filter((r) => r.kind === 'archived')).toEqual([])
  })
})
