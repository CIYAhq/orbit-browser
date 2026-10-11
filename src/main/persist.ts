import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, open, rm } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import type { Patch } from 'immer'
import {
  createInitialState,
  createProfile,
  DEFAULT_PROFILE_ID,
  DEFAULT_SETTINGS,
  DEFAULT_SIDEBAR_WIDTH,
  DEFAULT_SITE_SEARCH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
} from '../shared/defaults'
import { isFolderId, isSplitId, isTabId } from '../shared/ids'
import { normalizeMediaSettings } from '../shared/media'
import { withoutPrivate } from '../shared/private'
import type { ItemId, OrbitState, ProfileId, Space, SpaceId, SplitLayout, TabId } from '../shared/state'
import { STATE_SCHEMA } from '../shared/state'
import { normalizeSpaceTheme } from '../shared/theme'
import { fallbackTitle } from '../shared/url'
import { normalizeKeySettings } from './keys/bindings'
import { normalizeSettingsPrefs } from './settings/normalize'
import type { Store } from './store'

type ReadResult =
  | { kind: 'ok'; state: OrbitState }
  | { kind: 'missing' }
  | { kind: 'corrupt'; error: unknown }
  | { kind: 'newer'; schema: number }

function readStateFile(file: string): ReadResult {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { kind: 'missing' }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) throw new Error('not a state object')
    // Written by a newer Orbit: loading (and later overwriting) it would lose what this version can't read.
    if (typeof parsed.schema === 'number' && parsed.schema > STATE_SCHEMA)
      return { kind: 'newer', schema: parsed.schema }
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
 * runtime-only fields. An unreadable file is kept aside as *.corrupt-<time>, and a
 * file from a newer Orbit (higher schema) as *.schema<N>-<time>; the previous good
 * copy (*.bak, see Persistence) is used instead. With neither, Orbit starts fresh.
 */
export function loadState(file: string): { state: OrbitState; firstRun: boolean } {
  const primary = readStateFile(file)
  if (primary.kind === 'ok') return { state: primary.state, firstRun: false }
  if (primary.kind === 'corrupt') {
    console.error('[persist] state file unreadable, trying the backup:', primary.error)
    moveAside(file, 'corrupt')
  }
  if (primary.kind === 'newer') {
    console.error(`[persist] state file is from a newer Orbit (schema ${primary.schema}); keeping it aside`)
    moveAside(file, `schema${primary.schema}`)
  }
  const backup = readStateFile(backupOf(file))
  if (backup.kind === 'newer') moveAside(backupOf(file), `schema${backup.schema}`)
  if (backup.kind === 'ok') {
    if (primary.kind === 'missing') console.warn('[persist] state file missing, restored the backup')
    return { state: backup.state, firstRun: false }
  }
  return { state: createInitialState(), firstRun: true }
}

/**
 * Makes loaded state safe to run: every entity gets its fields (defaults where missing or
 * malformed), runtime-only fields are reset, references to missing items are dropped, each
 * sidebar item sits in exactly one place, and items that sit nowhere (orphans) are removed.
 * Migrations from older schemas go here too.
 */
export function normalizeState(input: Partial<OrbitState>): OrbitState {
  const base = createInitialState()
  const state: OrbitState = {
    schema: STATE_SCHEMA,
    windows: record(input.windows),
    spaces: record(input.spaces),
    spaceOrder: ids(input.spaceOrder),
    profiles: record(input.profiles),
    tabs: record(input.tabs),
    folders: record(input.folders),
    splits: record(input.splits),
    archive: Array.isArray(input.archive) ? input.archive.filter(isRecord) : [],
    settings: { ...DEFAULT_SETTINGS, ...(isRecord(input.settings) ? input.settings : {}) },
    downloads: record(input.downloads),
    tweaks: record(input.tweaks),
  }
  if (!['system', 'light', 'dark'].includes(state.settings.appearance)) state.settings.appearance = 'system'
  normalizeMediaSettings(state.settings, Date.now())
  seedAppearanceFromOldThemes(state)
  normalizeEntities(state, base)
  // Site searches (CB-11): keep well-formed http(s) entries; a missing list gets the defaults.
  const sites = Array.isArray(state.settings.siteSearch) ? state.settings.siteSearch : DEFAULT_SITE_SEARCH
  state.settings.siteSearch = sites
    .filter(
      (s) =>
        isRecord(s) &&
        typeof s.keyword === 'string' &&
        s.keyword.trim() !== '' &&
        typeof s.url === 'string' &&
        /^https?:\/\//i.test(s.url) &&
        s.url.includes('%s'),
    )
    .map((s) => ({ id: String(s.id || s.keyword), name: String(s.name || s.keyword), keyword: s.keyword, url: s.url }))
  if (typeof state.settings.searchSuggestions !== 'boolean') state.settings.searchSuggestions = false
  if (typeof state.settings.searchTopResult !== 'boolean') state.settings.searchTopResult = false
  // Reduced motion forced on (FL-28): off unless set.
  if (typeof state.settings.reduceMotion !== 'boolean') state.settings.reduceMotion = false
  // The Library section used last (AR-02): a section id, else the Archive.
  const section = state.settings.librarySection
  if (!(typeof section === 'string' && /^[\w.-]{1,64}$/.test(section))) state.settings.librarySection = 'archive'
  // Archive retention in days (AR-08): a whole number, 0 for forever; else the default.
  const keep = state.settings.archiveKeepDays
  if (!(Number.isInteger(keep) && keep >= 0 && keep <= 36_500)) state.settings.archiveKeepDays = 30
  // What the Library button's popover and the Media section show (DL-05, DL-11).
  const recent: Record<string, unknown> = isRecord(state.settings.recentFiles) ? state.settings.recentFiles : {}
  state.settings.recentFiles = {
    downloads: typeof recent.downloads === 'boolean' ? recent.downloads : DEFAULT_SETTINGS.recentFiles.downloads,
    screenshots:
      typeof recent.screenshots === 'boolean' ? recent.screenshots : DEFAULT_SETTINGS.recentFiles.screenshots,
  }
  if (typeof state.settings.libraryScreenshots !== 'boolean') {
    state.settings.libraryScreenshots = DEFAULT_SETTINGS.libraryScreenshots
  }
  // A blank window's Space (TB-17) stays out of the Space order; one no window shows any more is
  // gone, and its tabs with it (nothing else places them).
  for (const [id, space] of Object.entries(state.spaces)) {
    if (space.blank !== true) delete space.blank
    else if (!Object.values(state.windows).some((w) => w.spaceId === id)) delete state.spaces[id]
  }
  // spaceOrder must list exactly the existing spaces.
  state.spaceOrder = [...new Set(state.spaceOrder)].filter((id) => state.spaces[id] && !state.spaces[id].blank)
  for (const [id, space] of Object.entries(state.spaces)) {
    if (!space.blank && !state.spaceOrder.includes(id)) state.spaceOrder.push(id)
  }
  if (state.spaceOrder.length === 0) {
    const first = base.spaceOrder[0] as SpaceId
    state.spaces[first] = base.spaces[first] as Space
    state.spaceOrder = [first]
  }
  repairReferences(state)
  normalizeLinkSettings(state)
  for (const tab of Object.values(state.tabs)) {
    tab.loading = false
    tab.audible = false
    tab.asleep = true
    tab.progress = undefined
    tab.error = undefined
    tab.blockedPopups = undefined
    tab.permissionPrompt = undefined
    tab.pendingUrl = undefined
    tab.canGoBack = tab.canGoBack ?? false
    tab.canGoForward = tab.canGoForward ?? false
    tab.muted = tab.muted ?? false
    delete tab.media
  }
  for (const win of Object.values(state.windows)) {
    win.focused = false
    win.fullscreen = false
    win.overlay = { kind: 'none' }
    win.sidebar = { ...win.sidebar, peeking: false }
    if (!state.spaces[win.spaceId]) win.spaceId = state.spaceOrder[0] as string
  }
  normalizeDownloads(state)
  normalizeSettingsPrefs(state)
  normalizeKeySettings(state.settings, process.platform)
  return state
}

/**
 * Downloads the sidebar shows (DL-01, DL-03). One that was running or paused at quit comes back
 * interrupted, so it can be resumed or retried; one held back as possibly harmful stays held (DL-12);
 * finished, cancelled and private ones are dropped (the downloads list keeps the rest), and so are
 * malformed entries.
 */
function normalizeDownloads(state: OrbitState): void {
  // Download locations (DL-07): folders are absolute paths.
  const isFolder = (value: unknown) => typeof value === 'string' && isAbsolute(value)
  for (const profile of Object.values(state.profiles)) {
    if (!isFolder(profile.downloadFolder)) delete profile.downloadFolder
    if (profile.downloadAsk !== true) delete profile.downloadAsk
    if (!isFolder(profile.downloadAskFolder)) delete profile.downloadAskFolder
  }
  for (const [id, d] of Object.entries(state.downloads)) {
    const named = typeof d.url === 'string' && typeof d.filename === 'string' && typeof d.savePath === 'string'
    // A complete download held back as possibly harmful (DL-12) waits for Keep or Discard.
    const held = d.state === 'completed' && d.danger === 'file-type'
    if (!named || d.private === true || (d.state === 'completed' && !held) || d.state === 'cancelled') {
      delete state.downloads[id]
      continue
    }
    d.id = id
    if (!held) d.state = 'interrupted'
    d.receivedBytes = time(d.receivedBytes)
    d.totalBytes = time(d.totalBytes)
    d.startedAt = time(d.startedAt)
    if (!state.profiles[d.profileId]) d.profileId = DEFAULT_PROFILE_ID
    delete d.speed
  }
}

/**
 * Peek and Mini Window settings (PK-12, MW-04, MW-09, MW-10, MW-13, ST-09): a malformed value falls back
 * to its default, and a rule, choice or remembered profile whose Space or profile is gone is dropped.
 */
function normalizeLinkSettings(state: OrbitState): void {
  const s = state.settings
  if (typeof s.peekShiftClick !== 'boolean') s.peekShiftClick = DEFAULT_SETTINGS.peekShiftClick
  if (typeof s.miniWindowTrayButton !== 'boolean') s.miniWindowTrayButton = DEFAULT_SETTINGS.miniWindowTrayButton
  const rules: unknown[] = Array.isArray(s.linkRules) ? s.linkRules : []
  s.linkRules = rules.filter(
    (r): r is OrbitState['settings']['linkRules'][number] =>
      isRecord(r) &&
      (r.match === 'contains' || r.match === 'exact') &&
      typeof r.value === 'string' &&
      typeof r.spaceId === 'string' &&
      !!state.spaces[r.spaceId],
  )
  const space = s.externalLinksSpace
  if (!(typeof space === 'string' && state.spaces[space])) s.externalLinksSpace = null
  const after = s.miniWindowArchiveAfterMs
  if (!(typeof after === 'number' && Number.isFinite(after) && after >= 0)) {
    s.miniWindowArchiveAfterMs = DEFAULT_SETTINGS.miniWindowArchiveAfterMs
  }
  const profiles: Record<string, unknown> = isRecord(s.miniWindowProfiles) ? s.miniWindowProfiles : {}
  s.miniWindowProfiles = Object.fromEntries(
    Object.entries(profiles).filter(
      (e): e is [string, ProfileId] => typeof e[1] === 'string' && !!state.profiles[e[1]],
    ),
  )
  const b: unknown = s.miniWindowBounds
  const sane =
    isRecord(b) &&
    [b.x, b.y, b.width, b.height].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    (b.width as number) > 0 &&
    (b.height as number) > 0
  if (!sane) delete s.miniWindowBounds
  for (const entry of state.archive) if (entry.from !== 'mini' && entry.from !== 'peek') delete entry.from
}

/**
 * Light/dark used to be stored per Space (`theme.mode`); it is now the one global
 * `settings.appearance` (D12). When an older file left the global setting on
 * Automatic but its Spaces all chose Light or all chose Dark, keep that choice.
 */
function seedAppearanceFromOldThemes(state: OrbitState): void {
  if (state.settings.appearance !== 'system') return
  const modes = new Set<unknown>()
  for (const sp of Object.values(state.spaces)) {
    const theme = (sp as { theme?: unknown }).theme
    if (isRecord(theme) && 'mode' in theme) modes.add(theme.mode)
  }
  const [only] = [...modes]
  if (modes.size === 1 && (only === 'light' || only === 'dark')) state.settings.appearance = only
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** A keyed collection whose entries are objects (anything else is dropped). */
function record<T>(value: unknown): Record<string, T> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([, v]) => isRecord(v))) as Record<string, T>
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

const text = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback)
const time = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** Fills each entity's required fields (they may be missing in files written by older builds). */
function normalizeEntities(state: OrbitState, base: OrbitState): void {
  for (const [id, p] of Object.entries(state.profiles)) {
    p.id = id
    p.name = text(p.name, 'Profile') || 'Profile'
    p.partition = text(p.partition, '') || `persist:orbit-${id}`
    p.favorites = ids(p.favorites)
    p.createdAt = time(p.createdAt)
  }
  // Commands fall back to the default profile, so it always exists.
  if (!state.profiles[DEFAULT_PROFILE_ID])
    state.profiles[DEFAULT_PROFILE_ID] = createProfile('Default', DEFAULT_PROFILE_ID, 0)
  for (const [id, sp] of Object.entries(state.spaces)) {
    sp.id = id
    sp.name = text(sp.name, 'Space') || 'Space'
    sp.icon = text(sp.icon, '')
    // Any stored shape (current, the old { color, color2, mode }, or corrupt) becomes a valid theme.
    sp.theme = normalizeSpaceTheme(sp.theme)
    if (!state.profiles[sp.profileId]) sp.profileId = DEFAULT_PROFILE_ID
    sp.pinned = ids(sp.pinned)
    sp.today = ids(sp.today)
    sp.createdAt = time(sp.createdAt)
  }
  if (Object.keys(state.spaces).length === 0) {
    state.spaces = base.spaces
    state.spaceOrder = [...base.spaceOrder]
  }
  for (const [id, f] of Object.entries(state.folders)) {
    f.id = id
    f.name = text(f.name, 'Folder') || 'Folder'
    f.children = ids(f.children)
    f.collapsed = f.collapsed === true
    f.createdAt = time(f.createdAt)
  }
  for (const [id, split] of Object.entries(state.splits)) {
    const layout = validLayout(split.layout)
    if (!layout) delete state.splits[id]
    else {
      split.id = id
      split.layout = layout
      split.createdAt = time(split.createdAt)
      if (typeof split.icon !== 'string' || !split.icon) delete split.icon
    }
  }
  for (const [id, t] of Object.entries(state.tabs)) {
    t.id = id
    t.url = text(t.url, 'about:blank')
    t.title = text(t.title, fallbackTitle(t.url))
    t.createdAt = time(t.createdAt)
    t.lastActiveAt = time(t.lastActiveAt)
    if (typeof t.pageColor !== 'string' || !/^#[0-9a-f]{6}$/.test(t.pageColor)) delete t.pageColor
  }
  for (const [id, w] of Object.entries(state.windows)) {
    w.id = id
    w.kind = w.kind === 'mini' ? 'mini' : 'main'
    w.activeTab = isRecord(w.activeTab) ? w.activeTab : {}
    const sidebar: Partial<typeof w.sidebar> = isRecord(w.sidebar) ? w.sidebar : {}
    const width =
      typeof sidebar.width === 'number' && Number.isFinite(sidebar.width) ? sidebar.width : DEFAULT_SIDEBAR_WIDTH
    w.sidebar = {
      visible: sidebar.visible !== false,
      width: Math.round(Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width))),
      peeking: false,
    }
    const b = w.bounds
    const sane = isRecord(b) && [b.x, b.y, b.width, b.height].every((n) => typeof n === 'number' && Number.isFinite(n))
    if (!sane || b.width < 100 || b.height < 100) delete w.bounds
    if (typeof w.maximized !== 'boolean') delete w.maximized
  }
}

/** A split layout with only well-formed nodes, or undefined. Sizes are made to match children. */
function validLayout(node: unknown): SplitLayout | undefined {
  if (!isRecord(node)) return undefined
  if (node.type === 'leaf') return typeof node.tabId === 'string' ? { type: 'leaf', tabId: node.tabId } : undefined
  if ((node.type !== 'row' && node.type !== 'column') || !Array.isArray(node.children)) return undefined
  const children = node.children.map(validLayout)
  if (children.some((c) => !c) || children.length === 0) return undefined
  const sizes = Array.isArray(node.sizes) ? node.sizes : []
  const ok = sizes.length === children.length && sizes.every((n) => typeof n === 'number' && n > 0)
  return {
    type: node.type,
    children: children as SplitLayout[],
    sizes: ok ? (sizes as number[]) : children.map(() => 1 / children.length),
  }
}

/** The layout without the leaves `keep` rejects; undefined when nothing is left. */
function pruneLayout(node: SplitLayout, keep: (tabId: TabId) => boolean): SplitLayout | undefined {
  if (node.type === 'leaf') return keep(node.tabId) ? node : undefined
  const kept: { child: SplitLayout; size: number }[] = []
  node.children.forEach((child, i) => {
    const pruned = pruneLayout(child, keep)
    if (pruned) kept.push({ child: pruned, size: node.sizes[i] ?? 1 })
  })
  if (kept.length === 0) return undefined
  if (kept.length === 1) return kept[0]?.child
  const total = kept.reduce((sum, k) => sum + k.size, 0)
  return { type: node.type, children: kept.map((k) => k.child), sizes: kept.map((k) => k.size / total) }
}

function leavesOf(node: SplitLayout): TabId[] {
  return node.type === 'leaf' ? [node.tabId] : node.children.flatMap(leavesOf)
}

/**
 * Sidebar integrity: containers keep only existing items, each item in one place (the first),
 * splits keep at least two existing tabs (else they dissolve into the tab left), tabs follow the
 * Space or profile they sit in, orphans are removed and windows only point at tabs they can show.
 */
function repairReferences(state: OrbitState): void {
  const placed = new Set<ItemId>()
  /** Where each placed tab sits: its Space (pinned/today) or profile (favorites). */
  const home = new Map<TabId, { spaceId?: SpaceId; profileId: ProfileId }>()
  const clean = (list: ItemId[], where: { spaceId?: SpaceId; profileId: ProfileId }): ItemId[] => {
    const out: ItemId[] = []
    for (const id of list) {
      if (placed.has(id)) continue
      if (isTabId(id) && state.tabs[id]) {
        placed.add(id)
        home.set(id, where)
        out.push(id)
      } else if (isFolderId(id) && state.folders[id]) {
        placed.add(id)
        const folder = state.folders[id]
        folder.children = clean(folder.children, where)
        out.push(id)
      } else if (isSplitId(id) && state.splits[id]) {
        const split = state.splits[id]
        const layout = pruneLayout(split.layout, (t) => !!state.tabs[t] && !placed.has(t))
        const leaves = layout ? [...new Set(leavesOf(layout))] : []
        if (layout && leaves.length >= 2 && leaves.length === leavesOf(layout).length) {
          split.layout = layout
          placed.add(id)
          for (const t of leaves) {
            placed.add(t)
            home.set(t, where)
          }
          out.push(id)
        } else {
          // Fewer than two distinct panes left: the split dissolves into the tabs it still had.
          delete state.splits[id]
          out.push(...clean(leaves, where))
        }
      }
    }
    return out
  }
  for (const profile of Object.values(state.profiles)) {
    profile.favorites = clean(profile.favorites, { profileId: profile.id })
  }
  // The Space list's, then blank windows' (TB-17).
  const blank = Object.keys(state.spaces).filter((id) => state.spaces[id]?.blank)
  for (const spaceId of [...state.spaceOrder, ...blank]) {
    const space = state.spaces[spaceId]
    if (!space) continue
    const where = { spaceId, profileId: space.profileId }
    space.pinned = clean(space.pinned, where)
    space.today = clean(space.today, where)
  }
  // Orphans: nothing in the sidebar points at them, so nobody could ever see or close them.
  for (const id of Object.keys(state.tabs)) if (!placed.has(id)) delete state.tabs[id]
  for (const id of Object.keys(state.folders)) if (!placed.has(id)) delete state.folders[id]
  for (const id of Object.keys(state.splits)) if (!placed.has(id)) delete state.splits[id]
  for (const [tabId, where] of home) {
    const tab = state.tabs[tabId]
    if (!tab) continue
    tab.profileId = where.profileId
    if (where.spaceId) tab.spaceId = where.spaceId
    else if (state.spaces[tab.spaceId]?.profileId !== where.profileId) {
      // A favorite remembers a Space of its own profile.
      tab.spaceId =
        state.spaceOrder.find((s) => state.spaces[s]?.profileId === where.profileId) ??
        (state.spaces[tab.spaceId] ? tab.spaceId : (state.spaceOrder[0] as string))
    }
  }
  for (const win of Object.values(state.windows)) {
    if (!state.spaces[win.spaceId]) win.spaceId = state.spaceOrder[0] as string
    const active: Record<SpaceId, TabId | null> = {}
    for (const [spaceId, tabId] of Object.entries(win.activeTab)) {
      const space = state.spaces[spaceId]
      if (!space) continue
      const where = typeof tabId === 'string' ? home.get(tabId) : undefined
      const shows = !!where && (where.spaceId ? where.spaceId === spaceId : where.profileId === space.profileId)
      active[spaceId] = shows ? (tabId as TabId) : null
    }
    win.activeTab = active
  }
}

/**
 * Fields that only matter while Orbit runs (normalizeState resets them on load). Updates that
 * touch nothing else (loading flips, focus, audio, download progress…) don't cause a write.
 */
const RUNTIME_ONLY: Record<string, ReadonlySet<string>> = {
  tabs: new Set([
    'loading',
    'audible',
    'asleep',
    'progress',
    'error',
    'canGoBack',
    'canGoForward',
    'blockedPopups',
    'permissionPrompt',
    'pendingUrl',
    'media',
  ]),
  windows: new Set(['focused', 'fullscreen', 'overlay']),
  downloads: new Set(['receivedBytes', 'speed']),
}

/** True when a patch only changes runtime-only fields, so the saved file stays the same. */
export function isRuntimeOnlyPatch(patch: Patch): boolean {
  const [root, , field, sub] = patch.path
  // Update check status (UP-01) is runtime only: normalizeState drops it on load.
  if (root === 'updates') return true
  if (patch.path.length < 3) return false
  if (root === 'windows' && field === 'sidebar') return sub === 'peeking'
  return RUNTIME_ONLY[String(root)]?.has(String(field)) ?? false
}

/**
 * Runtime-only fields are written too (they are small) and reset on load. Private windows and
 * everything in them never are (NV-11), nor a private session's downloads (DL-16).
 */
function serialize(state: OrbitState): string {
  return JSON.stringify(withoutPrivate(state))
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
