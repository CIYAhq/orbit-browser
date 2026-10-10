import { afterEach, describe, expect, it } from 'vitest'
import { restoreEntries, restoreSpace } from '../../src/main/archive/restore'
import { ArchiveSync } from '../../src/main/archive/service'
import { ArchiveStore } from '../../src/main/archive/store'
import type { MainContext } from '../../src/main/context'
import { createSplitInDraft } from '../../src/main/split/model'
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
import { layoutLeaves, leaf } from '../../src/shared/split'
import type { ArchivedTab, SpaceId, SplitId, TabId } from '../../src/shared/state'

const syncs: ArchiveSync[] = []
afterEach(() => {
  for (const s of syncs.splice(0)) s.stop()
})

/**
 * Spaces A and B on the default profile, C on a second profile; window w1 shows A.
 * TabOps closes tabs into the Archive (with history, through the sync) like the app does.
 */
function world() {
  const state = createInitialState(0)
  const a = state.spaceOrder[0] as SpaceId
  const b = createSpace('Bravo', DEFAULT_PROFILE_ID)
  const work = createProfile('Work')
  const c = createSpace('Charlie', work.id)
  state.spaces[b.id] = b
  state.spaces[c.id] = c
  state.profiles[work.id] = work
  state.spaceOrder.push(b.id, c.id)
  const w1 = createWindowState(a)
  state.windows[w1.id] = w1
  const store = new Store(state)
  const savedHistory = new Map<string, { entries: { url: string; title: string }[]; index: number }>()
  const runtime = { contents: () => undefined, savedHistory, destroy() {}, sleep() {} }
  const ctx = { store, tabs: runtime, toast() {}, windows: { get: () => undefined } } as unknown as MainContext
  const ops = new TabOps(ctx)
  const archive = new ArchiveStore(null)
  const sync = new ArchiveSync(ctx, archive)
  syncs.push(sync)
  sync.start()
  /** Opens a Today tab in a Space, with back/forward history, and closes it into the Archive. */
  const archived = (spaceId: SpaceId, url: string, history: string[] = []): ArchivedTab => {
    const space = store.state.spaces[spaceId]
    const tab = makeTab({ spaceId, profileId: space?.profileId ?? DEFAULT_PROFILE_ID, url, title: url })
    store.update((d) => {
      d.tabs[tab.id] = tab
      d.spaces[spaceId]?.today.push(tab.id)
    })
    if (history.length) {
      savedHistory.set(tab.id, { entries: [...history, url].map((u) => ({ url: u, title: u })), index: history.length })
    }
    ops.closeTabs([tab.id], 'closed', { undoLabel: false })
    savedHistory.delete(tab.id)
    const entry = store.state.archive[store.state.archive.length - 1] as ArchivedTab
    expect(entry.url).toBe(url)
    return entry
  }
  const today = (spaceId: SpaceId) => store.state.spaces[spaceId]?.today ?? []
  return { store, archive, savedHistory, ctx, ops, a, b: b.id, c: c.id, work: work.id, w1: w1.id, archived, today }
}

describe('Restore from the Archive (AR-05)', () => {
  it('[AR-05] a tab goes back to the top of Today in the Space it came from, with its id and history', () => {
    const { store, archive, savedHistory, ctx, a, b, w1, archived, today } = world()
    const entry = archived(b, 'https://b.test/2', ['https://b.test/1'])
    expect(archive.get(entry.id)?.history?.entries).toHaveLength(2)
    const result = restoreEntries(ctx, archive, [entry.id], { windowId: w1 })
    expect(result).toEqual({ ids: [entry.id], tabIds: [entry.tabId], spaceIds: [b] })
    const tab = store.state.tabs[entry.tabId as TabId]
    expect(tab).toMatchObject({ url: 'https://b.test/2', spaceId: b, profileId: DEFAULT_PROFILE_ID, asleep: true })
    expect(today(b)[0]).toBe(entry.tabId)
    // Back/forward history is ready for when the tab wakes.
    expect(savedHistory.get(entry.tabId as TabId)?.entries.map((e) => e.url)).toEqual([
      'https://b.test/1',
      'https://b.test/2',
    ])
    // The entry left the Archive; the window still shows Space A (no jump).
    expect(store.state.archive.some((x) => x.id === entry.id)).toBe(false)
    expect(archive.has(entry.id)).toBe(false)
    expect(store.state.windows[w1]?.spaceId).toBe(a)
  })

  it('[AR-05] repeated restores of the same entry restore nothing more (rapid clicks)', () => {
    const { store, archive, ctx, b, w1, archived, today } = world()
    const entry = archived(b, 'https://b.test/')
    const first = restoreEntries(ctx, archive, [entry.id, entry.id], { windowId: w1 })
    const second = restoreEntries(ctx, archive, [entry.id], { windowId: w1 })
    expect(first.tabIds).toHaveLength(1)
    expect(second).toEqual({ ids: [], tabIds: [], spaceIds: [] })
    expect(today(b).filter((id) => store.state.tabs[id]?.url === 'https://b.test/')).toHaveLength(1)
  })

  it('[AR-05] several entries keep their order at the top of Today', () => {
    const { archive, ctx, b, w1, archived, today } = world()
    const one = archived(b, 'https://one.test/')
    const two = archived(b, 'https://two.test/')
    const three = archived(b, 'https://three.test/')
    // The Library lists newest first: three, two, one.
    const result = restoreEntries(ctx, archive, [three.id, two.id, one.id], { windowId: w1 })
    expect(today(b).slice(0, 3)).toEqual(result.tabIds)
    expect(result.tabIds).toEqual([three.tabId, two.tabId, one.tabId])
  })

  it('[AR-05][PR-05] a Space that changed profile gets the tab in its new profile, without the old history', () => {
    const { store, archive, savedHistory, ctx, b, work, w1, archived } = world()
    const entry = archived(b, 'https://b.test/2', ['https://b.test/1'])
    store.update((d) => {
      const space = d.spaces[b]
      if (space) space.profileId = work
    })
    const { tabIds } = restoreEntries(ctx, archive, [entry.id], { windowId: w1 })
    const tabId = tabIds[0] as TabId
    expect(store.state.tabs[tabId]).toMatchObject({ spaceId: b, profileId: work, url: 'https://b.test/2' })
    expect(savedHistory.has(tabId)).toBe(false)
  })

  it('[AR-05] when its Space is gone the tab goes to the current Space; a routing rule wins over both', () => {
    const { store, archive, ctx, a, b, c, w1, archived, today } = world()
    const gone = archived(b, 'https://gone.test/')
    const routed = archived(b, 'https://docs.example/page')
    store.update((d) => {
      d.settings.linkRules = [{ match: 'contains', value: 'docs.example', spaceId: c }]
      delete d.spaces[b]
      d.spaceOrder = d.spaceOrder.filter((id) => id !== b)
    })
    expect(restoreSpace(store.state, gone, w1)).toBe(a)
    expect(restoreSpace(store.state, routed, w1)).toBe(c)
    const result = restoreEntries(ctx, archive, [gone.id, routed.id], { windowId: w1 })
    expect(result.spaceIds).toEqual([a, c])
    expect(today(a)[0]).toBe(result.tabIds[0])
    expect(today(c)[0]).toBe(result.tabIds[1])
    // Space C is on another profile: the tab is loaded there in C's profile.
    expect(store.state.tabs[result.tabIds[1] as TabId]?.profileId).toBe(store.state.spaces[c]?.profileId)
  })

  it('[AR-05] open selects the tab (switching Space); with stay it is selected only in the current Space', () => {
    const { store, archive, ctx, a, b, w1, archived } = world()
    const inB = archived(b, 'https://b.test/')
    const inA = archived(a, 'https://a.test/')
    restoreEntries(ctx, archive, [inB.id], { windowId: w1, open: true, stay: true })
    expect(store.state.windows[w1]?.spaceId).toBe(a)
    expect(store.state.windows[w1]?.activeTab[a]).not.toBe(inB.tabId)
    restoreEntries(ctx, archive, [inA.id], { windowId: w1, open: true, stay: true })
    expect(store.state.windows[w1]?.activeTab[a]).toBe(inA.tabId)
    const again = archived(b, 'https://b2.test/')
    restoreEntries(ctx, archive, [again.id], { windowId: w1, open: true })
    expect(store.state.windows[w1]?.spaceId).toBe(b)
    expect(store.state.windows[w1]?.activeTab[b]).toBe(again.tabId)
  })

  it('[AR-05][PR-05] undoing Delete Folder after the Space changed profile brings its tabs back in the new profile, without the old history (W3)', () => {
    const { store, savedHistory, ops, b, work } = world()
    // A pinned tab that went from Fa to Fa2, in a folder in Space B.
    const tab = makeTab({ spaceId: b, profileId: DEFAULT_PROFILE_ID, url: 'https://fa2.test/', title: 'Fa2' })
    store.update((d) => {
      d.tabs[tab.id] = { ...tab, pinnedUrl: tab.url, pinnedTitle: tab.title, pinnedResolvedUrl: tab.url }
      d.spaces[b]?.pinned.push(tab.id)
    })
    const fa = { url: 'https://fa.test/', title: 'Fa' }
    savedHistory.set(tab.id, { entries: [fa, { url: tab.url, title: 'Fa2' }], index: 1 })
    const folderId = ops.createFolder({ container: { kind: 'pinned', spaceId: b }, items: [tab.id] })
    expect(store.state.folders[folderId]?.children).toEqual([tab.id])
    ops.deleteFolder(folderId, false)
    expect(store.state.tabs[tab.id]).toBeUndefined()
    // Its view and runtime history went with it.
    savedHistory.delete(tab.id)
    // The Space moves to the Work profile.
    store.update((d) => {
      const space = d.spaces[b]
      if (space) space.profileId = work
    })
    expect(ops.undo.undo()).toBe('Delete Folder')
    expect(store.state.folders[folderId]?.children).toEqual([tab.id])
    expect(store.state.tabs[tab.id]).toMatchObject({ spaceId: b, profileId: work, url: tab.url })
    expect(savedHistory.has(tab.id)).toBe(false)
  })

  it('[AR-05] here puts the tab in the current Space (the command bar); a used tab id is not taken', () => {
    const { store, archive, ctx, a, b, w1, archived, today } = world()
    const entry = archived(b, 'https://b.test/')
    // Something else took the tab's id meanwhile (an undo that restored the tab, say).
    store.update((d) => {
      d.tabs[entry.tabId as TabId] = makeTab({
        id: entry.tabId as TabId,
        spaceId: b,
        profileId: DEFAULT_PROFILE_ID,
        url: 'x:',
      })
    })
    const { tabIds, spaceIds } = restoreEntries(ctx, archive, [entry.id], { windowId: w1, here: true })
    expect(spaceIds).toEqual([a])
    expect(tabIds[0]).not.toBe(entry.tabId)
    expect(today(a)[0]).toBe(tabIds[0])
  })
})

describe('Splits in the Archive (SV-19, SV-24)', () => {
  /** Today tabs in Space B, the first two made a split (30/70, named, the right pane focused). */
  function splitWorld() {
    const w = world()
    const open = (url: string): TabId => {
      const tab = makeTab({ spaceId: w.b, profileId: DEFAULT_PROFILE_ID, url, title: url })
      w.store.update((d) => {
        d.tabs[tab.id] = tab
        d.spaces[w.b]?.today.push(tab.id)
      })
      return tab.id
    }
    const left = open('https://left.test/')
    const right = open('https://right.test/')
    const other = open('https://other.test/')
    let splitId = '' as SplitId
    w.store.update((d) => {
      const layout = { type: 'row' as const, children: [leaf(left), leaf(right)], sizes: [0.3, 0.7] }
      splitId = createSplitInDraft(d, [left, right], { at: left, layout }) as SplitId
      const split = d.splits[splitId]
      if (split) {
        split.name = 'Pair'
        split.focus = right
      }
    })
    const entriesOf = () => w.store.state.archive.filter((e) => e.tabId === left || e.tabId === right)
    return { ...w, left, right, other, splitId, entriesOf }
  }

  for (const reason of ['closed', 'auto'] as const) {
    it(`[SV-19][SV-24] a Today split ${reason === 'auto' ? 'archived when idle' : 'closed with ×'} restores from the Archive as one unit: one row brings back both panes as the split, at the top of Today`, () => {
      const w = splitWorld()
      w.ops.closeTabs([w.left, w.right], reason, { undoLabel: false })
      expect(w.store.state.splits[w.splitId]).toBeUndefined()
      const entries = w.entriesOf()
      expect(entries).toHaveLength(2)
      for (const e of entries) expect(e.split).toMatchObject({ id: w.splitId, name: 'Pair', focus: w.right })
      // The Archive lists one row per pane, each marked as part of a split.
      expect(w.archive.query({ profileId: DEFAULT_PROFILE_ID }).rows.filter((r) => r.split)).toHaveLength(2)

      const right = entries.find((e) => e.tabId === w.right) as ArchivedTab
      const result = restoreEntries(w.ctx, w.archive, [right.id], { windowId: w.w1 })
      expect(result.ids.toSorted()).toEqual(entries.map((e) => e.id).toSorted())
      const s = w.store.state
      expect(s.spaces[w.b]?.today).toEqual([w.splitId, w.other])
      const split = s.splits[w.splitId]
      expect(split).toMatchObject({ name: 'Pair', focus: w.right, layout: { type: 'row', sizes: [0.3, 0.7] } })
      expect(split && layoutLeaves(split.layout)).toEqual([w.left, w.right])
      expect(s.tabs[w.left]).toMatchObject({ url: 'https://left.test/', spaceId: w.b })
      // Both rows left the Archive.
      expect(w.archive.idsOfTab(w.left)).toEqual([])
      expect(w.archive.idsOfTab(w.right)).toEqual([])
      expect(w.entriesOf()).toEqual([])
    })
  }

  it('[SV-19] a pane closed on its own is an ordinary row; a split with one pane left in the Archive comes back as a tab', () => {
    const w = splitWorld()
    w.ops.closeTabs([w.left], 'closed', { undoLabel: false })
    expect(w.entriesOf()[0]?.split).toBeUndefined()
    w.ops.closeTabs([w.right], 'closed', { undoLabel: false })
    const w2 = splitWorld()
    w2.ops.closeTabs([w2.left, w2.right], 'closed', { undoLabel: false })
    const [first, second] = w2.entriesOf() as [ArchivedTab, ArchivedTab]
    w2.archive.delete([first.id])
    w2.store.update((d) => {
      d.archive = d.archive.filter((e) => e.id !== first.id)
    })
    const result = restoreEntries(w2.ctx, w2.archive, [second.id], { windowId: w2.w1 })
    expect(result.tabIds).toEqual([second.tabId])
    expect(w2.store.state.spaces[w2.b]?.today).toEqual([second.tabId, w2.other])
    expect(Object.keys(w2.store.state.splits)).toEqual([])
  })
})
