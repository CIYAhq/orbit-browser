import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInitialState, DEFAULT_SETTINGS, DEFAULT_SITE_SEARCH } from '../shared/defaults'
import type { OrbitState } from '../shared/state'
import { STATE_SCHEMA } from '../shared/state'
import type { Store } from './store'

/**
 * Loads persisted state, filling defaults for missing fields and resetting
 * runtime-only fields. Falls back to first-run state if the file is missing
 * or unreadable (a corrupt file is kept aside as *.corrupt).
 */
export function loadState(file: string): { state: OrbitState; firstRun: boolean } {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { state: createInitialState(), firstRun: true }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<OrbitState>
    return { state: normalizeState(parsed), firstRun: false }
  } catch (err) {
    console.error('[persist] state file unreadable, starting fresh:', err)
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      // ignore
    }
    return { state: createInitialState(), firstRun: true }
  }
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
  // Site searches: keep well-formed entries; a missing list gets the defaults.
  const sites = Array.isArray(state.settings.siteSearch) ? state.settings.siteSearch : DEFAULT_SITE_SEARCH
  state.settings.siteSearch = sites
    .filter((s) => s && typeof s.keyword === 'string' && typeof s.url === 'string' && s.url.includes('%s'))
    .map((s) => ({ id: String(s.id || s.keyword), name: String(s.name || s.keyword), keyword: s.keyword, url: s.url }))
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

/** Fields that only make sense while running are written anyway (they are small) and reset on load. */
function serialize(state: OrbitState): string {
  return JSON.stringify(state)
}

export function writeFileAtomic(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, file)
}

/** Saves state to disk shortly after changes (debounced) and on demand. */
export class Persistence {
  private timer: NodeJS.Timeout | undefined
  private dirty = false
  private unsubscribe: () => void

  constructor(
    private store: Store,
    private file: string,
    private delayMs = 400,
  ) {
    this.unsubscribe = store.subscribe(() => this.schedule())
  }

  private schedule(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, this.delayMs)
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (!this.dirty) return
    this.dirty = false
    try {
      writeFileAtomic(this.file, serialize(this.store.state))
    } catch (err) {
      console.error('[persist] failed to save state:', err)
    }
  }

  dispose(): void {
    this.flush()
    this.unsubscribe()
  }
}
