import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, open, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Patch } from 'immer'
import { createInitialState, DEFAULT_SETTINGS } from '../shared/defaults'
import type { OrbitState } from '../shared/state'
import { STATE_SCHEMA } from '../shared/state'
import type { Store } from './store'

type ReadResult = { kind: 'ok'; state: OrbitState } | { kind: 'missing' } | { kind: 'corrupt'; error: unknown }

function readStateFile(file: string): ReadResult {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { kind: 'missing' }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a state object')
    return { kind: 'ok', state: normalizeState(parsed as Partial<OrbitState>) }
  } catch (error) {
    return { kind: 'corrupt', error }
  }
}

/** Moves a file aside (`<file>.<tag>-<time>`) so it is kept but never loaded again. */
function moveAside(file: string, tag: string): void {
  try {
    renameSync(file, `${file}.${tag}-${Date.now()}`)
  } catch {
    // ignore: nothing to keep
  }
}

/**
 * Loads persisted state, filling defaults for missing fields and resetting
 * runtime-only fields. An unreadable file is kept aside as *.corrupt-<time> and
 * the previous good copy (*.bak, see Persistence) is used instead; with neither,
 * Orbit starts fresh.
 */
export function loadState(file: string): { state: OrbitState; firstRun: boolean } {
  const primary = readStateFile(file)
  if (primary.kind === 'ok') return { state: primary.state, firstRun: false }
  if (primary.kind === 'corrupt') {
    console.error('[persist] state file unreadable, trying the backup:', primary.error)
    moveAside(file, 'corrupt')
  }
  const backup = readStateFile(backupOf(file))
  if (backup.kind === 'ok') {
    if (primary.kind === 'missing') console.warn('[persist] state file missing, restored the backup')
    return { state: backup.state, firstRun: false }
  }
  return { state: createInitialState(), firstRun: true }
}

export function normalizeState(input: Partial<OrbitState>): OrbitState {
  const base = createInitialState()
  const state: OrbitState = {
    schema: STATE_SCHEMA,
    windows: input.windows ?? {},
    spaces: input.spaces && Object.keys(input.spaces).length ? input.spaces : base.spaces,
    spaceOrder: input.spaceOrder?.length ? input.spaceOrder : base.spaceOrder,
    profiles: input.profiles && Object.keys(input.profiles).length ? input.profiles : base.profiles,
    tabs: input.tabs ?? {},
    folders: input.folders ?? {},
    splits: input.splits ?? {},
    archive: input.archive ?? [],
    settings: { ...DEFAULT_SETTINGS, ...(input.settings ?? {}) },
    downloads: input.downloads ?? {},
    tweaks: input.tweaks ?? {},
  }
  // spaceOrder must list exactly the existing spaces.
  state.spaceOrder = state.spaceOrder.filter((id) => state.spaces[id])
  for (const id of Object.keys(state.spaces)) if (!state.spaceOrder.includes(id)) state.spaceOrder.push(id)
  for (const tab of Object.values(state.tabs)) {
    tab.loading = false
    tab.audible = false
    tab.asleep = true
    tab.progress = undefined
    tab.error = undefined
    tab.canGoBack = tab.canGoBack ?? false
    tab.canGoForward = tab.canGoForward ?? false
    tab.muted = tab.muted ?? false
  }
  for (const win of Object.values(state.windows)) {
    win.focused = false
    win.fullscreen = false
    win.overlay = { kind: 'none' }
    win.sidebar = { ...win.sidebar, peeking: false }
    if (!state.spaces[win.spaceId]) win.spaceId = state.spaceOrder[0] as string
  }
  for (const d of Object.values(state.downloads)) {
    if (d.state === 'progressing' || d.state === 'paused') d.state = 'interrupted'
  }
  return state
}

/**
 * Fields that only matter while Orbit runs (normalizeState resets them on load). Updates that
 * touch nothing else (loading flips, focus, audio, download progress…) don't cause a write.
 */
const RUNTIME_ONLY: Record<string, ReadonlySet<string>> = {
  tabs: new Set(['loading', 'audible', 'asleep', 'progress', 'error', 'canGoBack', 'canGoForward']),
  windows: new Set(['focused', 'fullscreen', 'overlay']),
  downloads: new Set(['receivedBytes']),
}

/** True when a patch only changes runtime-only fields, so the saved file stays the same. */
export function isRuntimeOnlyPatch(patch: Patch): boolean {
  const [root, , field, sub] = patch.path
  if (patch.path.length < 3) return false
  if (root === 'windows' && field === 'sidebar') return sub === 'peeking'
  return RUNTIME_ONLY[String(root)]?.has(String(field)) ?? false
}

/** Runtime-only fields are written too (they are small) and reset on load. */
function serialize(state: OrbitState): string {
  return JSON.stringify(state)
}

export const backupOf = (file: string): string => `${file}.bak`

/** Replaces the state file with a fully written temp file, keeping the previous one as *.bak. */
function commit(tmp: string, file: string): void {
  try {
    renameSync(file, backupOf(file))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  renameSync(tmp, file)
}

/** Makes renames in a directory durable (no-op where directories can't be opened, e.g. Windows). */
function syncDirSync(dir: string): void {
  try {
    const fd = openSync(dir, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // not supported here
  }
}

async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // not supported here
  }
}

/** Synchronous durable write (quit, tests): temp file, fsync, keep *.bak, rename, fsync the directory. */
export function writeFileAtomic(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.sync.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  commit(tmp, file)
  syncDirSync(dirname(file))
}

/**
 * Background durable write. The data is written and fsynced off the main thread; the final
 * renames run synchronously only if `stillCurrent()` (no newer synchronous flush happened).
 */
async function writeFileAtomicAsync(file: string, data: string, stillCurrent: () => boolean): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const handle = await open(tmp, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  if (!stillCurrent()) {
    await rm(tmp, { force: true })
    return
  }
  commit(tmp, file)
  await syncDir(dirname(file))
}

/**
 * Saves state to disk shortly after changes (debounced, written in the background) and on
 * demand (synchronously, e.g. on quit). Each write is fsynced and the previous file is kept
 * as *.bak, which loadState falls back to.
 */
export class Persistence {
  private timer: NodeJS.Timeout | undefined
  private dirty = false
  private writing: Promise<void> | undefined
  /** Bumped by each synchronous flush, so an older background write never lands after it. */
  private generation = 0
  private disposed = false
  private unsubscribe: () => void

  constructor(
    private store: Store,
    private file: string,
    private delayMs = 400,
  ) {
    this.unsubscribe = store.subscribe((_next, _prev, patches) => {
      if (!patches.every(isRuntimeOnlyPatch)) this.schedule()
    })
  }

  private schedule(): void {
    this.dirty = true
    if (this.timer || this.writing || this.disposed) return // a running write reschedules when done
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.save()
    }, this.delayMs)
  }

  /** Writes pending changes in the background. Resolves when that write is done. */
  save(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.writing) return this.writing
    if (!this.dirty) return Promise.resolve()
    this.dirty = false
    const generation = this.generation
    const data = serialize(this.store.state)
    this.writing = writeFileAtomicAsync(this.file, data, () => generation === this.generation)
      .catch((err) => console.error('[persist] failed to save state:', err))
      .finally(() => {
        this.writing = undefined
        if (this.dirty) {
          this.dirty = false
          this.schedule()
        }
      })
    return this.writing
  }

  /** Writes the current state now, synchronously (quit, tests). Supersedes a background write. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (!this.dirty && !this.writing) return
    this.dirty = false
    this.generation += 1
    try {
      writeFileAtomic(this.file, serialize(this.store.state))
    } catch (err) {
      console.error('[persist] failed to save state:', err)
    }
  }

  dispose(): void {
    this.flush()
    this.disposed = true
    this.unsubscribe()
  }
}
