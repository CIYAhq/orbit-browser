import { monitorEventLoopDelay } from 'node:perf_hooks'
import {
  type BookmarkNode,
  type ImportJob,
  type ImportPlan,
  type ImportProgressItem,
  type ImportSkip,
  type ImportTarget,
  STOPPED_BY_RESTORE,
} from '../../shared/commands/import'
import { DEFAULT_PROFILE_ID } from '../../shared/defaults'
import { newId } from '../../shared/ids'
import type { FolderId, ItemId, OrbitState, ProfileId, SpaceId, TabId, WindowId } from '../../shared/state'
import { containerItems, insertItem, locate, removeItem, splitLeaves } from '../../shared/tree'
import { sidebarUndo } from '../archive/inbox'
import type { MainContext } from '../context'
import type { CallContext } from '../registry'
import { detachFromSplit, reselectAway } from '../tabs/model'
import {
  addUnplacedTabs,
  attachFolders,
  DetachedFolder,
  freeFolderName,
  planPlacement,
  skippedLines,
} from './bookmarks'
import { hideImportTabs, releaseImportTabs } from './unplaced'

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
  /**
   * Tabs added that no section shows yet (D62 (3)), listed nowhere (D65 (1)): a quit, a failure or a restore part-way
   * takes back exactly these.
   */
  unplaced: TabId[]
  /** Everything was added: only its numbers are still to come. */
  finished: boolean
}

/** An import that has ended: only what its summary and Done need are kept (F8). */
export interface EndedJob {
  status: ImportJob
  opener: WindowId | undefined
}

export const IMPORT_UNDO_LABEL = 'Import Bookmarks'
const PROGRESS_EVERY_MS = 100
/**
 * Tabs added per store update while an import's folder is out of sight (D62 (3)). Every Orbit window takes each part
 * in tens of milliseconds, so none freezes for long (N3); one update of 20,000 froze the browser window for a second.
 */
const PART_TABS = 1000
/** After each part, main waits this many times as long as the part took it (at least MIN_PAUSE_MS): windows keep up. */
const PAUSE_FACTOR = 2.5
const MIN_PAUSE_MS = 20
/** Why bookmarks made for a Space didn't go in: it was deleted while they were added. */
export const SPACE_GONE = 'Their Space was deleted while they were added'

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
  /** e2e only: awaited as bookmarks are made, with how many are, so a test can quit part-way (D62). */
  testPause: ((made: number) => Promise<void> | undefined) | undefined

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
      unplaced: [],
      finished: false,
    }
    this.jobs.set(id, job)
    this.latest = id
    const run = this.queue.then(() => this.run(job, tasks))
    this.queue = run.catch(() => undefined)
    run.catch((err: unknown) => {
      console.error('[import] failed:', err)
      // Bookmarks are shown whole or not at all (D62): the tabs added out of sight go.
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
   * Quit: every import stops where it is (nothing more is read, D58), and the tabs of bookmarks being added out of sight
   * are taken back, so the next launch shows nothing of them (D62). Runs before the state's last write.
   */
  quit(): void {
    for (const job of this.jobs.values()) {
      job.cancelled = true
      this.release.get(job.status.id)?.()
      this.takeBack(job)
    }
  }

  /**
   * Restore Data (or its undo or redo) is about to replace the sidebar (D65 (3)): each import still reading or adding
   * stops where it is. Its unfinished tabs are taken back, not archived (the user never had them), and its window says
   * why it stopped. A held import (onboarding's) has added nothing, and waits.
   */
  stopForRestore(): void {
    for (const job of this.jobs.values()) {
      const { phase } = job.status
      if (job.cancelled || job.finished || (phase !== 'reading' && phase !== 'adding')) continue
      job.cancelled = true
      this.takeBack(job)
      job.status.phase = 'failed'
      job.status.error = STOPPED_BY_RESTORE
      for (const item of job.status.items) if (item.state === 'running') item.state = 'failed'
      this.changed(job, true)
    }
  }

  /**
   * Takes back the tabs an import added that no section shows yet: exactly its own, by id (D62 (1)). Nothing of the
   * user's can be among them. Nothing lists them (D65 (1)); one the user reached anyway goes from where it is now
   * (D62 (2), D65 (2)).
   */
  private takeBack(job: Job): void {
    const made = job.unplaced.splice(0)
    const state = this.ctx.store.state
    const ids = made.filter((id) => state.tabs[id])
    if (ids.length > 0) {
      const placed = placedItems(state)
      const gone = new Set(ids)
      this.ctx.store.update((d) => {
        reselectAway(d, gone)
        for (const id of ids) {
          if (placed.has(id)) {
            detachFromSplit(d, id)
            removeItem(d, id)
          }
          delete d.tabs[id]
        }
      })
      for (const id of ids) this.ctx.tabs.destroy(id)
    }
    releaseImportTabs(made)
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
      // Stopped while its last task ran (Restore Data, D65 (3)): it says so, and adds nothing more.
      if (job.cancelled) return
      await this.addSuggestions(job)
      // Or while it added the starter suggestions: it stays stopped, never done.
      if (job.cancelled) return
      job.finished = true
    } finally {
      // One more turn of the event loop, so the histogram sees the last stretch of work end.
      await new Promise((resolve) => setTimeout(resolve, 20))
      lag.disable()
      job.status.stats = { ms: Math.round(performance.now() - started), longestTaskMs: Math.round(lag.max / 1e6) }
      // Done once its numbers are in: whoever sees it done sees them too (fix check 2 N7).
      if (job.finished) job.status.phase = 'done'
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
      // Stopped meanwhile (Restore Data, D65 (3)): nothing more.
      if (job.cancelled) return
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
   * Adds the bookmarks read: one pinned folder per Space (IM-05), with a sub-folder per source profile when several go
   * to the same Space. Each folder is made out of sight (D62 (3)): its tabs go into the state a part at a time, where no
   * section shows them, paced so every window keeps up (N3); then one store update adds the folders and shows them
   * whole. Until then the sidebar shows none of it, and no list of open tabs lists its tabs (D65 (1)). One the user
   * reached anyway and placed stays where they put it: its folder leaves it out (D65 (2)). One undo step takes the
   * import back (D62 (4)).
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
    const built: DetachedFolder[] = []
    for (const [spaceId, perProfile] of bySpace) {
      const space = this.ctx.store.state.spaces[spaceId]
      if (!space) continue
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
      const plan = planPlacement(job.folderName, nodes)
      for (const [reason, n] of plan.skipped) skipped.set(reason, (skipped.get(reason) ?? 0) + n)
      if (plan.tabs > 0) built.push(new DetachedFolder(plan, spaceId, space.profileId, now))
    }
    let pause = 0
    for (const folder of built) {
      while (!folder.whole && this.ctx.store.state.spaces[folder.spaceId]) {
        await new Promise((resolve) => setTimeout(resolve, pause))
        if (job.cancelled) return
        const started = performance.now()
        const tabs = folder.build(PART_TABS)
        const ids = tabs.map((t) => t.id)
        // Listed nowhere from the moment they're in the state (D65 (1)).
        hideImportTabs(ids)
        job.unplaced.push(...ids)
        this.ctx.store.update((d) => addUnplacedTabs(d, tabs))
        // Sent to the windows now, so the pause counts their share of the work.
        this.ctx.store.flush()
        pause = Math.max(MIN_PAUSE_MS, PAUSE_FACTOR * (performance.now() - started))
        item.done += tabs.length
        this.changed(job)
        await this.testPause?.(item.done)
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pause))
    if (job.cancelled) return
    const state = this.ctx.store.state
    // Each named now: another folder may have taken the name meanwhile (IM-15).
    const names = built.map((b) => freeFolderName(state, b.spaceId, job.folderName))
    // A tab gone meanwhile leaves its folder. So does one a section holds: the user reached it anyway and placed it, and
    // it stays where they put it (D65 (2)).
    const placed = placedItems(state)
    const kept = job.unplaced.filter((id) => placed.has(id) && state.tabs[id]).length
    for (const b of built) b.keepOnly((id) => !!state.tabs[id] && !placed.has(id))
    let added: ReturnType<typeof attachFolders> = []
    this.ctx.store.update((d) => {
      added = attachFolders(d, built, names)
    })
    // Shown: from now on they are the user's (undo takes them back). A Space deleted meanwhile gets none.
    const shown = new Set(added.map((a) => a.spaceId))
    const left = built.filter((b) => !shown.has(b.spaceId))
    const made = job.unplaced
    job.unplaced = left.flatMap((b) => b.tabs.map((t) => t.id))
    this.takeBack(job)
    releaseImportTabs(made)
    const lost = left.filter((b) => !this.ctx.store.state.spaces[b.spaceId]).reduce((n, b) => n + b.total, 0)
    if (lost > 0) skipped.set(SPACE_GONE, lost)
    item.done = added.reduce((n, a) => n + a.tabs, kept)
    for (const { folderId, spaceId } of added) job.status.folders.push({ folderId, spaceId })
    this.recordUndo(added.map((a) => a.folderId))
    job.status.skipped.push(...skippedLines(skipped, item.type === 'links' ? ['link', 'links'] : undefined))
  }

  /** Adds summary lines: those with a count of none are left out. */
  addSkips(job: Job, skips: ImportSkip[]): void {
    job.status.skipped.push(...skips.filter((s) => s.count === undefined || s.count > 0))
  }

  /** ⌘Z takes an import back: its folders go, with every tab in them; ⌘⇧Z puts them back (TB-18, D62 (4)). */
  private recordUndo(rootIds: FolderId[]): void {
    const stack = sidebarUndo()
    if (!stack || rootIds.length === 0) return
    const store = this.ctx.store
    const undo = () => {
      const state = store.state
      const parts = rootIds.flatMap((rootId) => {
        const loc = locate(state, rootId)
        return loc ? [{ rootId, loc, ...subtree(state, rootId) }] : []
      })
      if (parts.length === 0) return undefined
      const tabSet = new Set<TabId>(parts.flatMap((p) => p.tabs.map((t) => t.id)))
      store.update((d) => {
        reselectAway(d, tabSet)
        for (const p of parts) {
          removeItem(d, p.rootId)
          for (const f of p.folders) delete d.folders[f.id]
          for (const t of p.tabs) delete d.tabs[t.id]
        }
      })
      for (const id of tabSet) this.ctx.tabs.destroy(id)
      return () => {
        store.update((d) => {
          for (const p of parts) {
            if (!containerItems(d, p.loc.container)) continue
            for (const f of p.folders) d.folders[f.id] = structuredClone(f)
            for (const t of p.tabs) d.tabs[t.id] = { ...structuredClone(t), asleep: true, loading: false }
            insertItem(d, p.loc.container, p.loc.index, p.rootId)
          }
        })
        this.recordUndo(parts.map((p) => p.rootId))
      }
    }
    stack.push(IMPORT_UNDO_LABEL, undo, Date.now(), () => rootIds.every((id) => !store.state.folders[id]))
  }
}

/** Every item a section holds, tabs among them: Favorites, pinned and Today, in folders and split views. */
function placedItems(state: OrbitState): Set<ItemId> {
  const placed = new Set<ItemId>()
  for (const p of Object.values(state.profiles)) for (const id of p.favorites) placed.add(id)
  for (const sp of Object.values(state.spaces)) for (const id of [...sp.pinned, ...sp.today]) placed.add(id)
  for (const f of Object.values(state.folders)) for (const id of f.children) placed.add(id)
  for (const split of Object.values(state.splits)) for (const id of splitLeaves(split.layout)) placed.add(id)
  return placed
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
