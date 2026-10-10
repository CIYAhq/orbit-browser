import { monitorEventLoopDelay } from 'node:perf_hooks'
import type {
  BookmarkNode,
  ImportJob,
  ImportPlan,
  ImportProgressItem,
  ImportSkip,
  ImportTarget,
} from '../../shared/commands/import'
import { DEFAULT_PROFILE_ID } from '../../shared/defaults'
import { newId } from '../../shared/ids'
import type { FolderId, OrbitState, ProfileId, SpaceId, TabId, WindowId } from '../../shared/state'
import { containerItems, insertItem, locate, removeItem } from '../../shared/tree'
import { sidebarUndo } from '../archive/inbox'
import type { MainContext } from '../context'
import type { CallContext } from '../registry'
import { reselectAway } from '../tabs/model'
import { applyPlacement, freeFolderName, type PlacedFolder, planPlacement, skippedLines } from './bookmarks'

/** Where one part of an import goes: bookmarks to the Space, the rest to its profile (IM-06). */
export interface Destination {
  spaceId: SpaceId
  profileId: ProfileId
}

/** One line of the progress view: read first (nothing added yet), then add. */
export interface Task {
  item: ImportProgressItem
  read?: (job: Job) => Promise<void>
  add: (job: Job) => Promise<void>
}

/** A running import. Tasks read everything first, so Cancel before adding imports nothing (IM-01). */
export interface Job {
  status: ImportJob
  plan: ImportPlan
  opener: WindowId | undefined
  cancelled: boolean
  /** Bookmarks to add, per destination key (a source profile, or '' for a single target). */
  bookmarks: Map<string, { title: string; nodes: BookmarkNode[] }[]>
  destinations: Map<string, Destination>
  /** The root folder's base name, e.g. "Imported from Chrome" (IM-05) or "Imported bookmarks" (IM-13). */
  folderName: string
  /** Source profiles' names by key: sub-folder names, and 'matching' destinations' names. */
  profileNames: Map<string, string>
  /** The folders of the bookmarks being added: a quit or a failure part-way takes them all back (F6). */
  placing: PlacedFolder[]
}

/** An import that has ended: only what its summary and Done need are kept (F8). */
export interface EndedJob {
  status: ImportJob
  opener: WindowId | undefined
}

export const IMPORT_UNDO_LABEL = 'Import Bookmarks'
const PROGRESS_EVERY_MS = 100
/** Pinned items added per store update: a few milliseconds of work each. */
const PLACE_CHUNK = 250

/** Runs imports one after another; tells every Orbit UI how they go (`import.progress`). */
export class ImportJobs {
  /** Imports running, then ended ones as their status only (F8). */
  private jobs = new Map<string, Job>()
  private ended = new Map<string, EndedJob>()
  private latest: string | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private sent = 0
  private sendTimer: NodeJS.Timeout | undefined
  private release = new Map<string, () => void>()

  constructor(private readonly ctx: MainContext) {}

  /** A running import; undefined once it has ended. */
  get(jobId?: string): Job | undefined {
    const id = jobId ?? this.latest
    return id ? this.jobs.get(id) : undefined
  }

  /** An import, running or ended: its status and the window it was started from. */
  find(jobId?: string): EndedJob | undefined {
    const id = jobId ?? this.latest
    return id ? (this.jobs.get(id) ?? this.ended.get(id)) : undefined
  }

  status(jobId?: string): ImportJob | null {
    return this.find(jobId)?.status ?? null
  }

  /** Starts an import made of `tasks`; returns its id. `profileNames`: the source profiles chosen, by key. */
  start(
    plan: ImportPlan,
    source: string,
    folderName: string,
    tasks: Task[],
    c: CallContext,
    profileNames = new Map<string, string>(),
  ): string {
    const id = newId('x').replace(/^x-/, 'import-')
    const job: Job = {
      status: { id, phase: 'reading', source, items: tasks.map((t) => t.item), skipped: [], folders: [] },
      plan,
      opener: c.windowId,
      cancelled: false,
      bookmarks: new Map(),
      destinations: new Map(),
      folderName,
      profileNames,
      placing: [],
    }
    this.jobs.set(id, job)
    this.latest = id
    const run = this.queue.then(() => this.run(job, tasks))
    this.queue = run.catch(() => undefined)
    run.catch((err: unknown) => {
      console.error('[import] failed:', err)
      // Bookmarks are all or nothing: a part-filled folder goes (F6).
      this.takeBack(job)
      job.status.phase = 'failed'
      job.status.error = err instanceof Error ? err.message : String(err)
      this.changed(job, true)
    })
    this.changed(job, true)
    return id
  }

  /** Cancel: only while nothing has been added (reading, or held for onboarding). */
  cancel(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (!job || (job.status.phase !== 'reading' && job.status.phase !== 'held')) return
    job.cancelled = true
    job.status.phase = 'cancelled'
    this.release.get(jobId)?.()
    this.changed(job, true)
  }

  /** Adds a held import (onboarding's Start browsing). */
  commit(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (!job || job.cancelled) return
    job.plan.hold = false
    this.release.get(jobId)?.()
  }

  /** Accepts or declines a held import's starter suggestion (IM-16); without a url, Dismiss all. */
  suggest(jobId: string, url: string | undefined, accepted: boolean): void {
    const job = this.jobs.get(jobId)
    if (!job?.status.suggestions || (job.status.phase !== 'held' && job.status.phase !== 'reading')) return
    if (url === undefined) job.status.suggestions = []
    for (const s of job.status.suggestions) if (s.url === url) s.accepted = accepted
    this.changed(job, true)
  }

  /**
   * Quit: every import stops where it is (nothing more is read, D58), and the bookmarks being added
   * are taken back, so the next launch shows no part-filled folder (F6). Runs before the state's last write.
   */
  quit(): void {
    for (const job of this.jobs.values()) {
      job.cancelled = true
      this.release.get(job.status.id)?.()
      this.takeBack(job)
    }
  }

  /** Removes the folders of bookmarks still being added, with everything in them, in one store update (F6). */
  private takeBack(job: Job): void {
    const placing = job.placing.splice(0)
    const state = this.ctx.store.state
    // Walked in the state, not the draft: a draft would wrap each of the (up to 200,000) tabs it reads.
    const parts = placing.flatMap((p) =>
      p.folderId && state.folders[p.folderId] ? [itemsUnder(state, p.folderId)] : [],
    )
    if (parts.length === 0) return
    this.ctx.store.update((d) => {
      for (const { rootId, folders, tabs } of parts) {
        reselectAway(d, new Set(tabs))
        removeItem(d, rootId)
        for (const id of folders) delete d.folders[id]
        for (const id of tabs) delete d.tabs[id]
      }
    })
    for (const { tabs } of parts) for (const id of tabs) this.ctx.tabs.destroy(id)
  }

  /** Held imports nobody committed are dropped (onboarding ended with Skip setup, OB-14). */
  dropHeld(): void {
    for (const job of this.jobs.values()) if (job.plan.hold && !job.cancelled) this.cancel(job.status.id)
  }

  changed(job: Job, now = false): void {
    if (job.status.id !== this.latest && !now) return
    const send = () => {
      this.sendTimer = undefined
      this.sent = Date.now()
      this.ctx.windows.broadcast('orbit:import.progress', job.status)
    }
    if (now || Date.now() - this.sent >= PROGRESS_EVERY_MS) {
      clearTimeout(this.sendTimer)
      send()
    } else if (!this.sendTimer) {
      this.sendTimer = setTimeout(send, PROGRESS_EVERY_MS)
    }
  }

  private async run(job: Job, tasks: Task[]): Promise<void> {
    const started = performance.now()
    const lag = monitorEventLoopDelay({ resolution: 5 })
    lag.enable()
    try {
      for (const task of tasks) {
        if (job.cancelled) return
        if (!task.read) continue
        task.item.state = 'running'
        this.changed(job)
        await task.read(job)
        if (task.item.state === 'running') task.item.state = 'waiting'
      }
      if (job.cancelled) return
      if (job.plan.hold) {
        job.status.phase = 'held'
        this.changed(job, true)
        await new Promise<void>((resolve) => this.release.set(job.status.id, resolve))
        this.release.delete(job.status.id)
        if (job.cancelled) return
      }
      job.status.phase = 'adding'
      this.changed(job, true)
      await this.resolveDestinations(job)
      for (const task of tasks) {
        if (job.cancelled) return
        if (task.item.state === 'failed' || task.item.state === 'skipped') continue
        task.item.state = 'running'
        this.changed(job)
        await task.add(job)
        if (task.item.state === 'running') task.item.state = 'done'
        this.changed(job)
      }
      await this.addSuggestions(job)
      job.status.phase = 'done'
    } finally {
      // One more turn of the event loop, so the histogram sees the last stretch of work end.
      await new Promise((resolve) => setTimeout(resolve, 20))
      lag.disable()
      job.status.stats = { ms: Math.round(performance.now() - started), longestTaskMs: Math.round(lag.max / 1e6) }
      this.changed(job, true)
      this.end(job)
    }
  }

  /** An import that has ended keeps only its status: its plan and the bookmarks read are let go (F8). */
  private end(job: Job): void {
    const id = job.status.id
    this.jobs.delete(id)
    this.release.delete(id)
    this.ended.set(id, { status: job.status, opener: job.opener })
  }

  /** The starter suggestions accepted (IM-16): Favorites of the target profile, pinned tabs of its Space, unloaded. */
  private async addSuggestions(job: Job): Promise<void> {
    const dest = [...job.destinations.values()][0]
    const run = this.ctx.commands.run.bind(this.ctx.commands) as unknown as (
      n: string,
      a: unknown,
      c: CallContext,
    ) => Promise<unknown>
    for (const s of job.status.suggestions ?? []) {
      if (!s.accepted || !dest) continue
      const container =
        s.kind === 'favorite'
          ? { kind: 'favorites', profileId: dest.profileId }
          : { kind: 'pinned', spaceId: dest.spaceId }
      // Favorites already full: that one is left out (the tabs code says so).
      await run('tabs.create', { url: s.url, container, activate: false }, { windowId: job.opener }).catch(() => {})
    }
  }

  /** Makes the Spaces and profiles the plan asks for (IM-06). */
  private async resolveDestinations(job: Job): Promise<void> {
    const target: ImportTarget = job.plan.target
    const state = this.ctx.store.state
    const keys = new Set<string>([...job.profileNames.keys(), ...job.bookmarks.keys(), ...job.destinations.keys()])
    if (keys.size === 0) keys.add('')
    const run = this.ctx.commands.run.bind(this.ctx.commands) as unknown as (
      n: string,
      a: unknown,
      c: CallContext,
    ) => Promise<unknown>
    const c: CallContext = { windowId: job.opener }
    if (target.kind === 'matching') {
      // In the source's order, after the last Space.
      let afterSpaceId = state.spaceOrder.at(-1)
      for (const key of keys) {
        const name = job.profileNames.get(key) || 'Imported'
        const profileId = (await run('profiles.create', { name }, c)) as ProfileId
        const spaceId = (await run('spaces.create', { name, profileId, activate: false, afterSpaceId }, c)) as SpaceId
        job.destinations.set(key, { spaceId, profileId })
        afterSpaceId = spaceId
      }
      return
    }
    let dest: Destination | undefined
    if (target.kind === 'new-space') {
      const firstSpace = state.spaces[state.spaceOrder[0] ?? '']
      const profileId = state.profiles[target.profileId]
        ? target.profileId
        : (firstSpace?.profileId ?? DEFAULT_PROFILE_ID)
      const spaceId = (await run(
        'spaces.create',
        { name: target.name.trim() || 'Imported', profileId, activate: false },
        c,
      )) as SpaceId
      dest = { spaceId, profileId: this.ctx.store.state.spaces[spaceId]?.profileId ?? profileId }
    } else {
      const space = state.spaces[target.spaceId] ?? state.spaces[state.spaceOrder[0] ?? '']
      if (!space) throw new Error('No Space to import into')
      dest = { spaceId: space.id, profileId: space.profileId }
    }
    for (const key of keys) job.destinations.set(key, dest)
  }

  /**
   * Adds the bookmarks read: one pinned folder per Space (IM-05), with a sub-folder per source profile
   * when several go to the same Space. They go in store updates of PLACE_CHUNK items, with a turn of
   * the event loop between, so the windows keep answering (IM-14). One undo step takes it all back.
   */
  async addBookmarks(job: Job, item: ImportProgressItem): Promise<void> {
    const bySpace = new Map<SpaceId, { key: string; groups: { title: string; nodes: BookmarkNode[] }[] }[]>()
    for (const [key, groups] of job.bookmarks) {
      const dest = job.destinations.get(key)
      if (!dest) continue
      const list = bySpace.get(dest.spaceId) ?? []
      list.push({ key, groups })
      bySpace.set(dest.spaceId, list)
    }
    const now = Date.now()
    const skipped = new Map<string, number>()
    let added = 0
    for (const [spaceId, perProfile] of bySpace) {
      const asNodes = (groups: { title: string; nodes: BookmarkNode[] }[]): BookmarkNode[] =>
        groups.flatMap((g) => (g.title ? [{ id: g.title, title: g.title, children: g.nodes }] : g.nodes))
      const nodes: BookmarkNode[] =
        perProfile.length === 1
          ? asNodes(perProfile[0]?.groups ?? [])
          : perProfile.map(({ key, groups }, i) => ({
              id: `p${i}`,
              title: job.profileNames.get(key) || `Profile ${i + 1}`,
              children: asNodes(groups),
            }))
      const plan = planPlacement(freeFolderName(this.ctx.store.state, spaceId, job.folderName), nodes)
      for (const [reason, n] of plan.skipped) skipped.set(reason, (skipped.get(reason) ?? 0) + n)
      if (plan.tabs === 0) continue
      const placed: PlacedFolder = { folderId: '', tabIds: [], folderIds: [], skipped: plan.skipped }
      job.placing.push(placed)
      const ids = new Map<number, FolderId>()
      for (let from = 0; from < plan.steps.length; from += PLACE_CHUNK) {
        await new Promise((resolve) => setImmediate(resolve))
        if (job.cancelled) return
        let more = true
        this.ctx.store.update((d) => {
          more = applyPlacement(d, spaceId, plan, from, from + PLACE_CHUNK, placed, ids, now)
        })
        item.done = added + placed.tabIds.length
        this.changed(job)
        if (!more) break
      }
      added += placed.tabIds.length
      if (!placed.folderId || !this.ctx.store.state.folders[placed.folderId]) continue
      job.status.folders.push({ folderId: placed.folderId, spaceId })
      this.recordUndo(placed.folderId)
    }
    // Every folder is filled: they stay.
    job.placing = []
    item.done = added
    job.status.skipped.push(...skippedLines(skipped, item.type === 'links' ? ['link', 'links'] : undefined))
  }

  addSkips(job: Job, skips: ImportSkip[]): void {
    job.status.skipped.push(...skips.filter((s) => s.count > 0))
  }

  /** ⌘Z takes an import back: its folder goes, with every tab in it; ⌘⇧Z puts it back (TB-18). */
  private recordUndo(rootId: FolderId): void {
    const stack = sidebarUndo()
    if (!stack) return
    const store = this.ctx.store
    const undo = () => {
      const state = store.state
      const loc = locate(state, rootId)
      if (!loc) return undefined
      const snap = subtree(state, rootId)
      const tabSet = new Set<TabId>(snap.tabs.map((t) => t.id))
      store.update((d) => {
        reselectAway(d, tabSet)
        removeItem(d, rootId)
        for (const f of snap.folders) delete d.folders[f.id]
        for (const t of snap.tabs) delete d.tabs[t.id]
      })
      for (const id of tabSet) this.ctx.tabs.destroy(id)
      return () => {
        store.update((d) => {
          if (!containerItems(d, loc.container)) return
          for (const f of snap.folders) d.folders[f.id] = structuredClone(f)
          for (const t of snap.tabs) d.tabs[t.id] = { ...structuredClone(t), asleep: true, loading: false }
          insertItem(d, loc.container, loc.index, rootId)
        })
        this.recordUndo(rootId)
      }
    }
    stack.push(IMPORT_UNDO_LABEL, undo, Date.now(), () => !store.state.folders[rootId])
  }
}

/** The ids of a folder's folders (itself included) and tabs, at any depth. */
function itemsUnder(state: OrbitState, rootId: FolderId): { rootId: FolderId; folders: FolderId[]; tabs: TabId[] } {
  const folders: FolderId[] = []
  const tabs: TabId[] = []
  const stack: string[] = [rootId]
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    const f = state.folders[id]
    if (f) {
      folders.push(id)
      for (const child of f.children) stack.push(child)
    } else if (state.tabs[id]) tabs.push(id)
  }
  return { rootId, folders, tabs }
}

/** A folder's own folders and tabs, copied (for undo). */
function subtree(state: OrbitState, rootId: FolderId) {
  const folders: OrbitState['folders'][string][] = []
  const tabs: OrbitState['tabs'][string][] = []
  const walk = (id: string) => {
    const f = state.folders[id]
    if (f) {
      folders.push(structuredClone(f))
      for (const child of f.children) walk(child)
      return
    }
    const t = state.tabs[id]
    if (t) tabs.push(structuredClone(t))
  }
  walk(rootId)
  return { folders, tabs }
}
