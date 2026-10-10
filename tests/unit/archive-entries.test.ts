import { afterEach, describe, expect, it } from 'vitest'
import { ArchiveSync, HOT_KEEP, HOT_MAX, MIN_HOT_AGE_MS } from '../../src/main/archive/service'
import { ArchiveStore } from '../../src/main/archive/store'
import type { MainContext } from '../../src/main/context'
import { Store } from '../../src/main/store'
import { makeTab } from '../../src/main/tabs/model'
import { TabOps } from '../../src/main/tabs/ops'
import {
  createInitialState,
  createProfile,
  createSpace,
  createWindowState,
  DEFAULT_PROFILE_ID,
} from '../../src/shared/defaults'
import type { ArchivedTab, OrbitState, TabId } from '../../src/shared/state'

const syncs: ArchiveSync[] = []
afterEach(() => {
  for (const s of syncs.splice(0)) s.stop()
})

/** A real store, TabOps with a fake runtime (no Electron) and the Archive sync on a memory store. */
function world(opts: { now?: () => number } = {}) {
  const state = createInitialState(0)
  const spaceId = state.spaceOrder[0] as string
  const w1 = createWindowState(spaceId)
  state.windows[w1.id] = w1
  const store = new Store(state)
  const savedHistory = new Map<string, { entries: { url: string; title: string }[]; index: number }>()
  const runtime = { contents: () => undefined, savedHistory, destroy() {}, sleep() {} }
  const ctx = { store, tabs: runtime, toast() {}, windows: { get: () => undefined } } as unknown as MainContext
  const ops = new TabOps(ctx)
  const archive = new ArchiveStore(null)
  const sync = new ArchiveSync(ctx, archive, opts.now)
  syncs.push(sync)
  sync.start()
  const add = (where: 'today' | 'pinned' = 'today', url = 'https://x.test/', title = 'X') => {
    const tab = makeTab({ spaceId, profileId: DEFAULT_PROFILE_ID, url, title })
    store.update((d) => {
      d.tabs[tab.id] = tab
      d.spaces[spaceId]?.[where].push(tab.id)
    })
    return tab.id
  }
  const withHistory = (tabId: TabId, ...urls: string[]) =>
    savedHistory.set(tabId, { entries: urls.map((url) => ({ url, title: url })), index: urls.length - 1 })
  const last = (): ArchivedTab | undefined => store.state.archive[store.state.archive.length - 1]
  return { store, ops, archive, sync, spaceId, w1: w1.id, add, withHistory, last, savedHistory }
}

describe('what goes into the Archive (AR-01)', () => {
  it('[AR-01] a closed Today tab is the newest entry: closed, from Today, with its Space, tab and history', () => {
    const { store, ops, archive, spaceId, add, withHistory, last } = world()
    const id = add('today', 'https://b.test/', 'Bee')
    withHistory(id, 'https://a.test/', 'https://b.test/')
    ops.closeTabs([id], 'closed')
    const entry = last()
    expect(entry).toMatchObject({
      url: 'https://b.test/',
      title: 'Bee',
      reason: 'closed',
      section: 'today',
      spaceId,
      spaceName: store.state.spaces[spaceId]?.name,
      profileId: DEFAULT_PROFILE_ID,
      tabId: id,
    })
    expect(entry?.favicon).toBeUndefined()
    // The history stays out of OrbitState and reaches the Archive store.
    expect(JSON.stringify(store.state.archive)).not.toContain('a.test')
    expect(archive.get(entry?.id ?? '')?.history?.entries.map((e) => e.url)).toEqual([
      'https://a.test/',
      'https://b.test/',
    ])
  })

  it('[AR-01] auto-archive, Clear and archive-below are tagged; a deleted pinned tab comes from Pinned', () => {
    const { store, ops, add } = world()
    const auto = add('today', 'https://auto.test/')
    ops.closeTabs([auto], 'auto', { undoLabel: false })
    const [c1, c2] = [add('today', 'https://c1.test/'), add('today', 'https://c2.test/')]
    ops.clearToday(store.state.spaceOrder[0] as string)
    const pinned = add('pinned', 'https://pin.test/')
    ops.deleteItem(pinned)
    const by = (url: string) => store.state.archive.find((a) => a.url === url)
    expect(by('https://auto.test/')).toMatchObject({ reason: 'auto', section: 'today' })
    expect(by('https://c1.test/')).toMatchObject({ reason: 'cleared' })
    expect(by('https://c2.test/')).toMatchObject({ reason: 'cleared' })
    expect(by('https://pin.test/')).toMatchObject({ reason: 'closed', section: 'pinned' })
    expect([c1, c2].every((t) => !store.state.tabs[t])).toBe(true)
  })

  it('[AR-01] an empty, never-used new tab is not archived', () => {
    const { store, ops, add } = world()
    const blank = add('today', 'about:blank')
    ops.closeTabs([blank], 'closed')
    expect(store.state.archive).toHaveLength(0)
  })

  it('[AR-01] tabs of a private profile leave nothing in the Archive', () => {
    const { store, ops, archive, spaceId } = world()
    const priv = createProfile('Private', 'private-1')
    priv.partition = 'private-1'
    const space = createSpace('Private', priv.id)
    const tab = makeTab({ spaceId: space.id, profileId: priv.id, url: 'https://secret.test/' })
    store.update((d) => {
      d.profiles[priv.id] = priv
      d.spaces[space.id] = space
      d.spaceOrder.push(space.id)
      d.tabs[tab.id] = tab
      space.today.push(tab.id)
      d.spaces[space.id] = { ...space, today: [tab.id] }
    })
    ops.closeTabs([tab.id], 'closed')
    expect(store.state.archive.some((a) => a.url === 'https://secret.test/')).toBe(false)
    expect(archive.size).toBe(0)
    expect(spaceId).toBeTruthy()
  })

  it('[AR-01] undo of a close takes the entry out of the Archive again', () => {
    const { store, ops, archive, add } = world()
    const id = add('today', 'https://undo.test/')
    ops.closeTabs([id], 'closed')
    expect(archive.size).toBe(1)
    ops.undo.undo()
    expect(store.state.tabs[id]).toBeDefined()
    expect(store.state.archive).toHaveLength(0)
    expect(archive.size).toBe(0)
  })
})

describe('the recent window in OrbitState (ARCHITECTURE §2)', () => {
  const fill = (state: OrbitState, n: number, at: number): ArchivedTab[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `a-old-${i}`,
      tabId: `t-old-${i}`,
      url: `https://old${i}.test/`,
      title: `Old ${i}`,
      spaceId: state.spaceOrder[0] as string,
      profileId: DEFAULT_PROFILE_ID,
      archivedAt: at + i,
      reason: 'closed' as const,
    }))

  it('[AR-01] past the limit, old entries leave state but stay in the Archive store', () => {
    let now = 10 * MIN_HOT_AGE_MS
    const { store, archive } = world({ now: () => now })
    store.update((d) => {
      d.archive.push(...fill(d, HOT_MAX + 1, 0))
    })
    expect(store.state.archive.length).toBe(HOT_KEEP)
    expect(archive.size).toBe(HOT_MAX + 1)
    // The newest stay in state, oldest first.
    expect(store.state.archive[0]?.id).toBe(`a-old-${HOT_MAX + 1 - HOT_KEEP}`)
    // Young entries never leave state (an undo may still want them there).
    now = 0
    store.update((d) => {
      d.archive.push(...fill(d, HOT_MAX, 1).map((a) => ({ ...a, id: `${a.id}-young` })))
    })
    expect(store.state.archive.length).toBeGreaterThan(HOT_MAX)
  })

  it('[AR-01] a tab that comes back after its entry left state takes the entry out of the store', () => {
    const now = 10 * MIN_HOT_AGE_MS
    const { store, archive, spaceId } = world({ now: () => now })
    store.update((d) => {
      d.archive.push(...fill(d, HOT_MAX + 1, 0))
    })
    expect(archive.has('a-old-0')).toBe(true)
    expect(store.state.archive.some((a) => a.id === 'a-old-0')).toBe(false)
    const tab = makeTab({ spaceId, profileId: DEFAULT_PROFILE_ID, url: 'https://old0.test/' })
    store.update((d) => {
      d.tabs['t-old-0'] = { ...tab, id: 't-old-0' }
      d.spaces[spaceId]?.today.unshift('t-old-0')
    })
    expect(archive.has('a-old-0')).toBe(false)
    expect(archive.has('a-old-1')).toBe(true)
  })

  it('[AR-01] a deleted profile takes its Archive with it', () => {
    const { store, archive, add, ops } = world()
    const work = createProfile('Work', 'p-work')
    const space = createSpace('Work', work.id)
    store.update((d) => {
      d.profiles[work.id] = work
      d.spaces[space.id] = space
      d.spaceOrder.push(space.id)
    })
    const t = makeTab({ spaceId: space.id, profileId: work.id, url: 'https://work.test/' })
    store.update((d) => {
      d.tabs[t.id] = t
      d.spaces[space.id]?.today.push(t.id)
    })
    ops.closeTabs([t.id], 'closed')
    const mine = add('today', 'https://mine.test/')
    ops.closeTabs([mine], 'closed')
    expect(archive.size).toBe(2)
    store.update((d) => {
      delete d.spaces[space.id]
      d.spaceOrder = d.spaceOrder.filter((s) => s !== space.id)
      delete d.profiles[work.id]
    })
    expect(archive.all().map((e) => e.url)).toEqual(['https://mine.test/'])
    expect(store.state.archive.map((e) => e.url)).toEqual(['https://mine.test/'])
  })
})
