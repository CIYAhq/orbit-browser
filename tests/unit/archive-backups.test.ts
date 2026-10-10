import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BACKUP_EVERY_MS,
  BackupStore,
  backupsToKeep,
  FIRST_BACKUP_MS,
  parseBackupId,
  scheduleBackups,
} from '../../src/main/archive/backups'
import { sidebarRestored } from '../../src/main/archive/inbox'
import { ArchiveSync } from '../../src/main/archive/service'
import { buildSnapshot, restoreSidebar, sidebarHash } from '../../src/main/archive/snapshot'
import { ArchiveStore } from '../../src/main/archive/store'
import type { MainContext } from '../../src/main/context'
import { floatingTab } from '../../src/main/peek/floating'
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
import type { OrbitState, SpaceId, TabId } from '../../src/shared/state'

const syncs: ArchiveSync[] = []
const dirs: string[] = []
afterEach(() => {
  for (const s of syncs.splice(0)) s.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  vi.useRealTimers()
})

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Local time `days` days before 18:00 on 2026-10-10, at `hour`. */
function at(days: number, hour: number, minute = 0): number {
  return new Date(2026, 9, 10 - days, hour, minute).getTime()
}

/** Space A (window w1, with a kept Today tab) and Space B; TabOps and the Archive as in the app. */
async function world() {
  const state = createInitialState(0)
  const a = state.spaceOrder[0] as SpaceId
  const b = createSpace('Bravo', DEFAULT_PROFILE_ID)
  state.spaces[b.id] = b
  state.spaceOrder.push(b.id)
  const w1 = createWindowState(a)
  state.windows[w1.id] = w1
  const store = new Store(state)
  const savedHistory = new Map<string, { entries: { url: string; title: string }[]; index: number }>()
  const destroyed: TabId[] = []
  const slept: TabId[] = []
  const runtime = {
    contents: () => undefined,
    savedHistory,
    destroy: (id: TabId) => {
      destroyed.push(id)
      savedHistory.delete(id)
    },
    sleep: (id: TabId) => slept.push(id),
    faviconFor: (url: string) => (url.startsWith('https://icon.test') ? 'data:image/png;base64,AAAA' : undefined),
  }
  const ctx = { store, tabs: runtime, toast() {}, windows: { get: () => undefined } } as unknown as MainContext
  const ops = new TabOps(ctx)
  const archive = new ArchiveStore(null)
  await archive.load()
  const sync = new ArchiveSync(ctx, archive)
  syncs.push(sync)
  sync.start()
  /** A Today tab of a Space (selected in w1 when asked). */
  const tab = (spaceId: SpaceId, url: string, select = false): TabId => {
    const space = store.state.spaces[spaceId]
    const t = makeTab({ spaceId, profileId: space?.profileId ?? DEFAULT_PROFILE_ID, url, title: url })
    store.update((d) => {
      d.tabs[t.id] = t
      d.spaces[spaceId]?.today.unshift(t.id)
      if (select) (d.windows[w1.id] as (typeof d.windows)[string]).activeTab[spaceId] = t.id
    })
    return t.id
  }
  const keep = tab(a, 'https://keep.test/', true)
  return { store, ctx, ops, archive, savedHistory, destroyed, slept, a, b: b.id, w1: w1.id, tab, keep }
}

describe('Sidebar backups (AR-11)', () => {
  it('[AR-11] the schedule keeps up to 10 from today, one a day for 10 days, one a week for a month, one a month for a year', () => {
    const now = at(0, 18)
    const list: { id: string; at: number }[] = []
    // Today: 15, every half hour from 18:00 back to 11:00.
    for (let k = 0; k < 15; k++) list.push({ id: `today-${k}`, at: now - k * 30 * MIN })
    // The 10 days before: three a day.
    for (let d = 1; d <= 10; d++) for (const h of [9, 12, 20]) list.push({ id: `day${d}-${h}`, at: at(d, h) })
    // The month before that: one a day.
    for (let d = 11; d <= 41; d++) list.push({ id: `week-day${d}`, at: at(d, 12) })
    // The year before that, and older: one every five days.
    for (let d = 42; d <= 450; d += 5) list.push({ id: `month-day${d}`, at: at(d, 12) })
    const keep = backupsToKeep(list, now)
    const kept = (prefix: string) => [...keep].filter((id) => id.startsWith(prefix)).sort()
    expect(kept('today-')).toEqual([
      'today-0',
      'today-1',
      'today-2',
      'today-3',
      'today-4',
      'today-5',
      'today-6',
      'today-7',
      'today-8',
      'today-9',
    ])
    // Each earlier day keeps its newest (the evening one).
    expect(kept('day').length).toBe(10)
    for (let d = 1; d <= 10; d++) expect(keep.has(`day${d}-20`)).toBe(true)
    // Weeks: the newest of days 11–17, 18–24, 25–31, 32–38, 39–41.
    expect(kept('week-')).toEqual(['week-day11', 'week-day18', 'week-day25', 'week-day32', 'week-day39'])
    // Months: the newest of each 30 days from day 42 to day 406; nothing older.
    const months = [...keep].filter((id) => id.startsWith('month-')).map((id) => Number(id.slice('month-day'.length)))
    expect(months.sort((x, y) => x - y)).toEqual([42, 72, 102, 132, 162, 192, 222, 252, 282, 312, 342, 372, 402])
    expect(keep.size).toBe(10 + 10 + 5 + 13)
    // The newest backup always stays, however old.
    expect([...backupsToKeep([{ id: 'old', at: now - 900 * DAY }], now)]).toEqual(['old'])
  })

  it('[AR-11] a backup holds the sidebar without live state; browsing alone never changes it', async () => {
    const w = await world()
    const s0 = w.store.state
    const work = createProfile('Private')
    // A private profile (no persistent partition) leaves nothing behind.
    const privateSpace = createSpace('Secret', work.id)
    const peek = floatingTab('peek', { spaceId: w.a, profileId: DEFAULT_PROFILE_ID, url: 'https://peek.test/' })
    w.store.update((d) => {
      d.profiles[work.id] = { ...work, partition: 'orbit-memory' }
      d.spaces[privateSpace.id] = privateSpace
      d.spaceOrder.push(privateSpace.id)
      d.tabs[peek.id] = peek
      const t = d.tabs[w.keep]
      if (t) {
        t.favicon = 'data:image/png;base64,AAAA'
        t.loading = true
        t.asleep = false
      }
    })
    const secret = w.tab(privateSpace.id, 'https://secret.test/')
    const snap = buildSnapshot(w.store.state, 1000)
    expect(snap.spaceOrder).toEqual(s0.spaceOrder)
    expect(Object.keys(snap.tabs)).toEqual([w.keep])
    expect(snap.tabs[w.keep]).not.toHaveProperty('favicon')
    expect(snap.tabs[w.keep]).not.toHaveProperty('loading')
    expect(snap.tabs[w.keep]).not.toHaveProperty('asleep')
    expect(snap.tabs).not.toHaveProperty(secret)
    expect(snap.favorites).toEqual({ [DEFAULT_PROFILE_ID]: [] })
    const hash = sidebarHash(snap)
    // A page navigated, a title changed, a folder opened: the same sidebar.
    w.store.update((d) => {
      const t = d.tabs[w.keep]
      if (t) {
        t.url = 'https://keep.test/elsewhere'
        t.title = 'Elsewhere'
        t.loading = false
      }
    })
    expect(sidebarHash(buildSnapshot(w.store.state, 2000))).toBe(hash)
    // A new folder is a new sidebar.
    w.ops.createFolder({ name: 'Box', items: [w.keep], windowId: w.w1 })
    expect(sidebarHash(buildSnapshot(w.store.state, 3000))).not.toBe(hash)
  })

  it('[AR-11] delete a folder, restore the backup from 5 minutes ago, and the folder is back', async () => {
    const w = await world()
    const one = w.tab(w.a, 'https://one.test/2')
    const two = w.tab(w.a, 'https://icon.test/two')
    w.savedHistory.set(one, {
      entries: [
        { url: 'https://one.test/1', title: 'One 1' },
        { url: 'https://one.test/2', title: 'One 2' },
      ],
      index: 1,
    })
    const folderId = w.ops.createFolder({ name: 'Reading', items: [one, two], windowId: w.w1 })
    const pinnedBefore = w.store.state.spaces[w.a]?.pinned
    const snap = buildSnapshot(w.store.state, Date.now() - 5 * MIN)
    // Since then: the folder deleted (its tabs to the Archive, with history) and a tab opened.
    w.ops.deleteFolder(folderId, false)
    expect(w.store.state.folders[folderId]).toBeUndefined()
    expect(w.archive.idsOfTab(one)).toHaveLength(1)
    const late = w.tab(w.a, 'https://late.test/')
    const closedBefore = w.destroyed.length

    const plan = restoreSidebar(w.ctx, w.archive, snap)
    const s = w.store.state
    expect(s.folders[folderId]).toMatchObject({ name: 'Reading', children: [one, two] })
    expect(s.spaces[w.a]?.pinned).toEqual(pinnedBefore)
    expect(s.tabs[one]).toMatchObject({ url: 'https://one.test/2', asleep: true, pinnedUrl: 'https://one.test/2' })
    // Its back/forward history waits for the tab to wake; the icon comes from the icon store.
    expect(w.savedHistory.get(one)?.entries.map((e) => e.url)).toEqual(['https://one.test/1', 'https://one.test/2'])
    expect(s.tabs[two]?.favicon).toBe('data:image/png;base64,AAAA')
    // They left the Archive; the tab opened since went there (and closed its page).
    expect(w.archive.idsOfTab(one)).toEqual([])
    expect(s.archive.some((e) => e.tabId === one || e.tabId === two)).toBe(false)
    expect(s.tabs[late]).toBeUndefined()
    expect(s.archive.at(-1)).toMatchObject({
      tabId: late,
      url: 'https://late.test/',
      reason: 'closed',
      section: 'today',
    })
    expect(w.destroyed.slice(closedBefore)).toEqual([late])
    expect(plan.added.sort()).toEqual([one, two].sort())
    // The window still shows the tab it showed.
    expect(s.windows[w.w1]?.activeTab[w.a]).toBe(w.keep)

    // The sidebar's earlier undo steps are gone; ⌘Z now takes the restore back.
    expect(w.ops.undo.peek()?.label).toBe('Delete Folder')
    let undone = 0
    sidebarRestored(() => {
      undone++
    })
    expect(w.ops.undo.size).toBe(1)
    expect(w.ops.undo.undo()).toBe('Restore Data')
    expect(undone).toBe(1)
  })

  it('[AR-11] a window whose tab left shows a tab that was there before, not one that just came back', async () => {
    const w = await world()
    const back = w.tab(w.a, 'https://back.test/')
    const snap = buildSnapshot(w.store.state, Date.now() - MIN)
    w.ops.closeTabs([back], 'closed', { undoLabel: false })
    const late = w.tab(w.a, 'https://late.test/', true)
    restoreSidebar(w.ctx, w.archive, snap)
    const s = w.store.state
    expect(s.tabs[late]).toBeUndefined()
    expect(s.tabs[back]).toMatchObject({ asleep: true })
    expect(s.windows[w.w1]?.activeTab[w.a]).toBe(w.keep)
  })

  it('[AR-11] Spaces added since go; windows move to a Space that stays; private Spaces and Peeks stay as they are', async () => {
    const w = await world()
    const work = createProfile('Work')
    const c = createSpace('Charlie', work.id)
    w.store.update((d) => {
      d.profiles[work.id] = work
      d.spaces[c.id] = c
      d.spaceOrder.push(c.id)
    })
    const inC = w.tab(c.id, 'https://work.test/')
    const snap = buildSnapshot(w.store.state, Date.now() - MIN)

    // Since: a new Space with a tab, shown in w1; the Work profile and its Space deleted;
    // a private Space; a Peek over the new Space.
    const n = createSpace('New', DEFAULT_PROFILE_ID)
    const secretProfile = { ...createProfile('Private'), partition: 'orbit-memory' }
    const secret = createSpace('Secret', secretProfile.id)
    w.store.update((d) => {
      d.spaces[n.id] = n
      d.spaceOrder.push(n.id)
      d.profiles[secretProfile.id] = secretProfile
      d.spaces[secret.id] = secret
      d.spaceOrder.push(secret.id)
      delete d.spaces[c.id]
      d.spaceOrder = d.spaceOrder.filter((id) => id !== c.id)
      delete d.tabs[inC]
      delete d.profiles[work.id]
      const win = d.windows[w.w1]
      if (win) win.spaceId = n.id
    })
    const fresh = w.tab(n.id, 'https://fresh.test/', true)
    const hidden = w.tab(secret.id, 'https://secret.test/')
    const peek = floatingTab('peek', { spaceId: n.id, profileId: DEFAULT_PROFILE_ID, url: 'https://peek.test/' })
    w.store.update((d) => {
      d.tabs[peek.id] = peek
    })

    restoreSidebar(w.ctx, w.archive, snap)
    const s: OrbitState = w.store.state
    expect(s.spaceOrder).toEqual([w.a, w.b, c.id, secret.id])
    expect(s.spaces[n.id]).toBeUndefined()
    expect(s.tabs[fresh]).toBeUndefined()
    expect(s.archive.at(-1)).toMatchObject({ tabId: fresh, spaceName: 'New' })
    // Work is gone: its Space comes back in the Default profile, with its tab.
    expect(s.spaces[c.id]?.profileId).toBe(DEFAULT_PROFILE_ID)
    expect(s.tabs[inC]).toMatchObject({ spaceId: c.id, profileId: DEFAULT_PROFILE_ID, asleep: true })
    // The window was on the new Space: now on one of the same profile, showing its tab.
    expect(s.windows[w.w1]?.spaceId).toBe(w.a)
    expect(s.windows[w.w1]?.activeTab[w.a]).toBe(w.keep)
    expect(s.windows[w.w1]?.activeTab).not.toHaveProperty(n.id)
    // Untouched: the private Space and its tab, and the Peek (which follows its Space).
    expect(s.spaces[secret.id]?.today).toEqual([hidden])
    expect(s.tabs[hidden]).toBeDefined()
    expect(s.tabs[peek.id]).toMatchObject({ floating: 'peek', spaceId: w.a })
  })

  it('[AR-11] backups on disk: one when the sidebar changed, newest first, read back; a damaged one is not restored', async () => {
    const w = await world()
    const dir = mkdtempSync(join(tmpdir(), 'orbit-backups-'))
    dirs.push(dir)
    const backups = new BackupStore(dir)
    let changes = 0
    backups.onChange = () => changes++
    expect(await backups.list()).toEqual([])
    const first = await backups.take(w.store.state, at(0, 9))
    expect(first).toMatchObject({ at: at(0, 9), spaces: 2, tabs: 1 })
    expect(parseBackupId(first.id)).toEqual(first)
    // The same sidebar again: no new file, the newest is the answer.
    expect(await backups.take(w.store.state, at(0, 9, 5))).toEqual(first)
    w.tab(w.b, 'https://b.test/')
    const second = await backups.take(w.store.state, at(0, 9, 10))
    expect(second.tabs).toBe(2)
    expect((await backups.list()).map((b) => b.id)).toEqual([second.id, first.id])
    expect(changes).toBe(2)
    const snap = await backups.read(first.id)
    expect(snap && Object.keys(snap.tabs)).toEqual([w.keep])
    // Ids that are not backups, and files that are not backups, give nothing.
    expect(await backups.read('../state')).toBeUndefined()
    writeFileSync(join(dir, `${second.id}.json`), '{"v":1,"at":')
    expect(await backups.read(second.id)).toBeUndefined()
    // Old backups past the schedule go when the next one is taken; temp files of a cut write too.
    writeFileSync(join(dir, `${at(500, 9)}-1-1-abcdef12.json`), '{}')
    writeFileSync(join(dir, 'cut.json.tmp'), '')
    w.tab(w.b, 'https://b.test/2')
    const third = await new BackupStore(dir).take(w.store.state, at(0, 9, 20))
    expect(readdirSync(dir).sort()).toEqual([first.id, second.id, third.id].map((id) => `${id}.json`).sort())
  })

  it('[AR-11] backups are taken after launch and within five minutes of a change, only then', () => {
    vi.useFakeTimers()
    const state = createInitialState(0)
    const store = new Store(state)
    const taken: number[] = []
    const take = async (_s: OrbitState, now: number) => {
      taken.push(now)
      return undefined as never
    }
    const stop = scheduleBackups({ store }, { take })
    vi.advanceTimersByTime(FIRST_BACKUP_MS)
    expect(taken).toHaveLength(1)
    vi.advanceTimersByTime(BACKUP_EVERY_MS * 2)
    expect(taken).toHaveLength(1)
    store.update((d) => {
      const space = d.spaces[d.spaceOrder[0] as string]
      if (space) space.name = 'Renamed'
    })
    vi.advanceTimersByTime(BACKUP_EVERY_MS)
    expect(taken).toHaveLength(2)
    stop()
    store.update((d) => {
      const space = d.spaces[d.spaceOrder[0] as string]
      if (space) space.name = 'Again'
    })
    vi.advanceTimersByTime(BACKUP_EVERY_MS * 2)
    expect(taken).toHaveLength(2)
  })
})
