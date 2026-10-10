import { createHash } from 'node:crypto'
import { isFolderId, isSplitId, isTabId, newId } from '../../shared/ids'
import type {
  ArchivedTab,
  Folder,
  FolderId,
  ItemId,
  OrbitState,
  ProfileId,
  Space,
  SpaceId,
  Split,
  SplitId,
  Tab,
  TabId,
  WindowId,
} from '../../shared/state'
import { tabTitle } from '../../shared/tabs'
import { sectionOf, sidebarTabOrder, splitLeaves } from '../../shared/tree'
import type { MainContext } from '../context'
import { normalizeState } from '../persist'
import { dedupeDisplayed, mostRecentTab, shownElsewhere } from '../tabs/model'
import type { SavedHistory } from '../tabs/runtime'
import { noteArchiveHistory } from './inbox'
import { isPrivateOrGone } from './service'
import type { ArchiveHistory, ArchiveStore } from './store'

/** Backup file format. */
export const SNAPSHOT_VERSION = 1

/** Tab fields that only matter while Orbit runs, and the icon (large; looked up again on restore). */
const LIVE_TAB_FIELDS = [
  'loading',
  'audible',
  'asleep',
  'progress',
  'error',
  'canGoBack',
  'canGoForward',
  'favicon',
  'floating',
] as const

/** A tab as a backup keeps it. */
export type SnapshotTab = Omit<Tab, (typeof LIVE_TAB_FIELDS)[number]>

/**
 * The whole sidebar at one moment (AR-11): every Space with its pinned and Today items, each
 * profile's Favorites, and the folders, split views and tabs they hold. Private profiles leave
 * nothing behind, so their Spaces and Favorites are not in it.
 */
export interface SidebarSnapshot {
  v: number
  /** When it was taken (ms). */
  at: number
  spaceOrder: SpaceId[]
  spaces: Record<SpaceId, Space>
  /** Each profile's Favorites. */
  favorites: Record<ProfileId, ItemId[]>
  folders: Record<FolderId, Folder>
  splits: Record<SplitId, Split>
  tabs: Record<TabId, SnapshotTab>
}

/** The sidebar of `state` as a backup holds it. */
export function buildSnapshot(state: OrbitState, at: number): SidebarSnapshot {
  const snap: SidebarSnapshot = {
    v: SNAPSHOT_VERSION,
    at,
    spaceOrder: [],
    spaces: {},
    favorites: {},
    folders: {},
    splits: {},
    tabs: {},
  }
  const add = (id: ItemId): void => {
    if (isTabId(id)) {
      const tab = state.tabs[id]
      if (tab && !tab.floating) snap.tabs[id] = snapshotTab(tab)
    } else if (isFolderId(id)) {
      const folder = state.folders[id]
      if (!folder) return
      snap.folders[id] = structuredClone(folder)
      for (const child of folder.children) add(child)
    } else if (isSplitId(id)) {
      const split = state.splits[id]
      if (!split) return
      // A pane waiting for its first page is a passing state, not part of the sidebar.
      const { pending: _pending, ...rest } = split
      snap.splits[id] = structuredClone(rest)
      for (const tabId of splitLeaves(split.layout)) add(tabId)
    }
  }
  for (const [profileId, profile] of Object.entries(state.profiles)) {
    if (isPrivateOrGone(state, profileId)) continue
    snap.favorites[profileId] = [...profile.favorites]
    for (const id of profile.favorites) add(id)
  }
  for (const spaceId of state.spaceOrder) {
    const space = state.spaces[spaceId]
    if (!space || isPrivateOrGone(state, space.profileId)) continue
    snap.spaceOrder.push(spaceId)
    snap.spaces[spaceId] = structuredClone(space)
    for (const id of [...space.pinned, ...space.today]) add(id)
  }
  return snap
}

function snapshotTab(tab: Tab): SnapshotTab {
  const copy: Partial<Tab> = { ...tab }
  for (const field of LIVE_TAB_FIELDS) delete copy[field]
  return copy as SnapshotTab
}

/** How many Spaces and tabs a backup holds (its list row says so). */
export function snapshotCounts(snap: SidebarSnapshot): { spaces: number; tabs: number } {
  return { spaces: snap.spaceOrder.length, tabs: Object.keys(snap.tabs).length }
}

/**
 * A short fingerprint of what a restore would put back: the sidebar's shape and names. Pages a tab
 * moved on to, titles, and folders or sections opened or closed leave it unchanged, so browsing
 * alone never takes a new backup.
 */
export function sidebarHash(snap: SidebarSnapshot): string {
  const tabs = Object.values(snap.tabs)
    .map((t) => [t.id, t.spaceId, t.profileId, t.pinnedUrl ?? '', t.customTitle ?? '', t.icon ?? ''])
    .sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1))
  const spaces = Object.values(snap.spaces).map(({ pinnedCollapsed: _c, ...s }) => s)
  const folders = Object.values(snap.folders).map(({ collapsed: _c, ...f }) => f)
  const splits = Object.values(snap.splits).map(({ focus: _f, ...s }) => s)
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1)
  const key = stableJson({
    order: snap.spaceOrder,
    spaces: spaces.sort(byId),
    favorites: snap.favorites,
    folders: folders.sort(byId),
    splits: splits.sort(byId),
    tabs,
  })
  return createHash('sha1').update(key).digest('hex').slice(0, 8)
}

/** JSON with object keys sorted (the same data always gives the same text). */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** A keyed collection whose entries are objects (anything else is dropped). */
function records<T>(value: unknown): Record<string, T> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([, v]) => isRecord(v))) as Record<string, T>
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** A backup read from disk, checked; undefined when it is not one Orbit can restore. */
export function parseSnapshot(input: unknown): SidebarSnapshot | undefined {
  if (!isRecord(input) || input.v !== SNAPSHOT_VERSION) return undefined
  const at = input.at
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined
  const spaces = records<Space>(input.spaces)
  const spaceOrder = strings(input.spaceOrder).filter((id) => spaces[id])
  if (spaceOrder.length === 0) return undefined
  const favorites: Record<ProfileId, ItemId[]> = {}
  if (isRecord(input.favorites)) {
    for (const [profileId, list] of Object.entries(input.favorites)) favorites[profileId] = strings(list)
  }
  return {
    v: SNAPSHOT_VERSION,
    at,
    spaceOrder,
    spaces,
    favorites,
    folders: records<Folder>(input.folders),
    splits: records<Split>(input.splits),
    tabs: records<SnapshotTab>(input.tabs),
  }
}

// ---- Restore ----

/** What a restore needs to know beyond the state. */
export interface RestoreLookups {
  /**
   * The Archive's entries of a tab (a tab that comes back takes them along), and the newest one
   * with its back/forward history.
   */
  archived(tabId: TabId): { ids: string[]; newest?: ArchivedTab & { history?: ArchiveHistory } }
  /** The remembered icon for a page. */
  favicon?(url: string): string | undefined
  /** A live tab's back/forward history (kept with the Archive entry it becomes). */
  history?(tabId: TabId): SavedHistory | undefined
}

/** A restore worked out against the current state; `applyRestore` makes it so in one update. */
export interface RestorePlan {
  spaceOrder: SpaceId[]
  spaces: Record<SpaceId, Space>
  /** Favorites of each profile the backup knows (other profiles keep theirs). */
  favorites: Record<ProfileId, ItemId[]>
  folders: Record<FolderId, Folder>
  splits: Record<SplitId, Split>
  /** Every tab of the restored sidebar: tabs there now keep their page, the others come back asleep. */
  tabs: Record<TabId, Tab>
  /** Tabs that come back (not in the sidebar now). */
  added: TabId[]
  /** Tabs that leave the sidebar, and the Archive entries they become. */
  removed: { tab: Tab; entry?: ArchivedTab; history?: SavedHistory }[]
  /** Archive entries of tabs that come back. */
  unarchived: string[]
  /** The back/forward history each returning tab gets back. */
  histories: Map<TabId, ArchiveHistory>
  /** Tabs now in a Space of another profile: their page starts again in that profile's session. */
  reload: TabId[]
}

/** Tab fields that say how a tab sits in the sidebar; a restore puts them back on tabs that stay. */
const SIDEBAR_TAB_FIELDS = ['pinnedUrl', 'pinnedTitle', 'pinnedResolvedUrl', 'customTitle', 'icon'] as const

/** Items a container holds, all the way down (folders and split views included). */
function reachable(state: OrbitState, roots: readonly ItemId[], out: Set<ItemId>): void {
  for (const id of roots) {
    if (out.has(id)) continue
    out.add(id)
    if (isFolderId(id)) reachable(state, state.folders[id]?.children ?? [], out)
    else if (isSplitId(id)) {
      const split = state.splits[id]
      if (split) reachable(state, splitLeaves(split.layout), out)
    }
  }
}

/**
 * Works out how the sidebar goes back to a backup (AR-11). Spaces, their pinned and Today items and
 * the Favorites of each profile the backup knows become what they were; Spaces added since go.
 * Tabs in both stay as they are (their page, history and selection), back in their old place.
 * Tabs that are in the backup only come back asleep: at the page they last showed when the Archive
 * still has them (with their history, which the Archive entry hands back), else at the backup's
 * address. Tabs that are not in the backup go to the Archive like closed tabs.
 *
 * Left alone: Spaces and Favorites of private profiles, Favorites of profiles the backup does not
 * know, and pages in a Peek or Mini Window. A Space whose profile was deleted comes back in the
 * Default profile.
 */
export function planRestore(state: OrbitState, snap: SidebarSnapshot, look: RestoreLookups, now: number): RestorePlan {
  // Containers the restore leaves as they are, and everything in them.
  const keptSpaces = state.spaceOrder.filter((id) => {
    const space = state.spaces[id]
    return !!space && isPrivateOrGone(state, space.profileId)
  })
  const restoredProfiles = Object.keys(state.profiles).filter(
    (id) => !isPrivateOrGone(state, id) && Array.isArray(snap.favorites[id]),
  )
  const kept = new Set<ItemId>()
  for (const id of keptSpaces) {
    const space = state.spaces[id]
    if (space) reachable(state, [...space.pinned, ...space.today], kept)
  }
  for (const [id, profile] of Object.entries(state.profiles)) {
    if (!restoredProfiles.includes(id)) reachable(state, profile.favorites, kept)
  }
  for (const tab of Object.values(state.tabs)) if (tab.floating) kept.add(tab.id)

  // The backup made whole the way a state file is on load: references to missing items dropped,
  // each item in one place, split views with two panes or more, tabs in their container's profile.
  const without = <T>(list: Record<string, T>) =>
    Object.fromEntries(Object.entries(list).filter(([id]) => !kept.has(id)))
  const n = normalizeState(
    structuredClone({
      spaces: snap.spaces,
      spaceOrder: snap.spaceOrder,
      profiles: Object.fromEntries(
        restoredProfiles.map((id) => [id, { ...state.profiles[id], favorites: snap.favorites[id] ?? [] }]),
      ),
      tabs: without(snap.tabs),
      folders: without(snap.folders),
      splits: without(snap.splits),
    }) as Partial<OrbitState>,
  )

  const tabs: Record<TabId, Tab> = {}
  const added: TabId[] = []
  const unarchived: string[] = []
  const histories = new Map<TabId, ArchiveHistory>()
  const reload: TabId[] = []
  for (const [id, saved] of Object.entries(n.tabs)) {
    const live = state.tabs[id]
    if (live) {
      const next: Tab = { ...live, spaceId: saved.spaceId, profileId: saved.profileId }
      for (const field of SIDEBAR_TAB_FIELDS) {
        if (saved[field] === undefined) delete next[field]
        else next[field] = saved[field]
      }
      // A tab that becomes a Today tab starts its idle time now (TD-02).
      if (live.pinnedUrl && !next.pinnedUrl) next.lastActiveAt = now
      if (next.profileId !== live.profileId) reload.push(id)
      tabs[id] = next
      continue
    }
    const { ids, newest } = look.archived(id)
    unarchived.push(...ids)
    // The Archive knows where the tab was when it left, if that was after the backup.
    const last = newest && newest.archivedAt >= snap.at ? newest : undefined
    const url = last?.url || saved.url
    const next: Tab = {
      ...saved,
      url,
      title: last?.title || saved.title,
      // Back in Today means just used: the idle timer must not archive it again at once (TD-02).
      lastActiveAt: now,
      loading: false,
      audible: false,
      asleep: true,
      canGoBack: false,
      canGoForward: false,
    }
    delete next.progress
    delete next.error
    delete next.floating
    delete next.favicon
    const icon = look.favicon?.(url)
    if (icon) next.favicon = icon
    // History never crosses profiles (PR-05).
    if (last?.history && last.history.entries.length > 0 && last.profileId === next.profileId) {
      histories.set(id, last.history)
    }
    tabs[id] = next
    added.push(id)
  }

  const removed: RestorePlan['removed'] = []
  for (const tab of Object.values(state.tabs)) {
    if (tab.floating || kept.has(tab.id) || tabs[tab.id]) continue
    const url = tab.url
    const entry: ArchivedTab | undefined =
      url && url !== 'about:blank'
        ? {
            id: newId('a'),
            url,
            title: tabTitle(tab),
            spaceId: tab.spaceId,
            profileId: tab.profileId,
            archivedAt: now,
            reason: 'closed',
            section: sectionOf(state, tab.id) === 'today' ? 'today' : 'pinned',
            tabId: tab.id,
            spaceName: state.spaces[tab.spaceId]?.name,
          }
        : undefined
    const history = entry ? look.history?.(tab.id) : undefined
    removed.push({ tab, ...(entry ? { entry } : {}), ...(history ? { history } : {}) })
  }

  const spaces: Record<SpaceId, Space> = { ...n.spaces }
  const folders: Record<FolderId, Folder> = { ...n.folders }
  const splits: Record<SplitId, Split> = { ...n.splits }
  // A split view returns to the pane it had focused, while that pane is still in it (SV-14).
  for (const split of Object.values(splits)) {
    if (split.focus && !splitLeaves(split.layout).includes(split.focus)) delete split.focus
  }
  for (const id of keptSpaces) {
    const space = state.spaces[id]
    if (space) spaces[id] = space
  }
  for (const id of kept) {
    const folder = state.folders[id]
    if (folder) folders[id] = folder
    const split = state.splits[id]
    if (split) splits[id] = split
  }
  return {
    spaceOrder: [...n.spaceOrder, ...keptSpaces],
    spaces,
    favorites: Object.fromEntries(restoredProfiles.map((id) => [id, n.profiles[id]?.favorites ?? []])),
    folders,
    splits,
    tabs,
    added,
    removed,
    unarchived,
    histories,
    reload,
  }
}

/** Same data (plain JSON values, in any key order). */
function same(a: unknown, b: unknown): boolean {
  return a === b || stableJson(a) === stableJson(b)
}

/** Sets the fields of `target` (an Immer draft) that differ from `next`, so unchanged ones make no patch. */
function assignChanged<T extends object>(target: T, next: T): void {
  const t = target as Record<string, unknown>
  const n = next as Record<string, unknown>
  for (const key of new Set([...Object.keys(t), ...Object.keys(n)])) {
    if (n[key] === undefined) {
      if (key in t) delete t[key]
    } else if (!same(t[key], n[key])) t[key] = n[key]
  }
}

/** Records keyed by id: removes what `next` lacks and replaces what differs. Draft helper. */
function replaceRecords<T>(target: Record<string, T>, before: Record<string, T>, next: Record<string, T>): void {
  for (const id of Object.keys(target)) if (!next[id]) delete target[id]
  for (const [id, value] of Object.entries(next)) if (!same(before[id], value)) target[id] = value
}

/**
 * Makes a planned restore so (inside `store.update`). `before` is the state the plan was made
 * against. Windows on a Space that went move to a Space of the same profile (else the first one);
 * a window whose tab left shows the most recent tab of its Space, as after a close.
 */
export function applyRestore(d: OrbitState, before: OrbitState, plan: RestorePlan): void {
  for (const r of plan.removed) delete d.tabs[r.tab.id]
  for (const [id, next] of Object.entries(plan.tabs)) {
    const tab = d.tabs[id]
    if (tab) assignChanged(tab, next)
    else d.tabs[id] = next
  }
  if (!same(before.spaceOrder, plan.spaceOrder)) d.spaceOrder = plan.spaceOrder
  replaceRecords(d.spaces, before.spaces, plan.spaces)
  replaceRecords(d.folders, before.folders, plan.folders)
  replaceRecords(d.splits, before.splits, plan.splits)
  for (const [profileId, favorites] of Object.entries(plan.favorites)) {
    const profile = d.profiles[profileId]
    if (profile && !same(before.profiles[profileId]?.favorites, favorites)) profile.favorites = favorites
  }
  const out = new Set(plan.unarchived)
  if (d.archive.some((a) => out.has(a.id))) d.archive = d.archive.filter((a) => !out.has(a.id))
  for (const r of plan.removed) if (r.entry) d.archive.push(r.entry)

  const spaceFor = (old: SpaceId): SpaceId => {
    if (d.spaces[old]) return old
    const profileId = before.spaces[old]?.profileId
    return d.spaceOrder.find((id) => d.spaces[id]?.profileId === profileId) ?? (d.spaceOrder[0] as SpaceId)
  }
  // Pages in a Peek or Mini Window stay; they only follow their Space if it went.
  for (const tab of Object.values(d.tabs))
    if (tab.floating && !d.spaces[tab.spaceId]) tab.spaceId = spaceFor(tab.spaceId)
  const lost: WindowId[] = []
  for (const win of Object.values(d.windows)) {
    const shown = win.activeTab[win.spaceId]
    if (!d.spaces[win.spaceId]) {
      const old = win.spaceId
      win.spaceId = spaceFor(old)
      // A Mini Window's page is its window's selection: it moves along.
      if (win.kind !== 'main') win.activeTab = { [win.spaceId]: win.activeTab[old] ?? null }
    }
    if (win.kind !== 'main') continue
    for (const spaceId of Object.keys(win.activeTab)) {
      if (!d.spaces[spaceId]) {
        delete win.activeTab[spaceId]
        continue
      }
      const id = win.activeTab[spaceId]
      if (id && !sidebarTabOrder(d, spaceId).includes(id)) win.activeTab[spaceId] = null
    }
    if (shown && !win.activeTab[win.spaceId]) lost.push(win.id)
  }
  // Tabs that were there already come first: a tab that just came back waits asleep until chosen.
  const back = new Set(plan.added)
  for (const id of lost) {
    const win = d.windows[id]
    if (!win) continue
    const elsewhere = shownElsewhere(d, id)
    win.activeTab[win.spaceId] =
      mostRecentTab(d, win.spaceId, new Set([...elsewhere, ...back])) ?? mostRecentTab(d, win.spaceId, elsewhere)
  }
  dedupeDisplayed(d)
}

/** A live tab's back/forward history: from its page, else what it saved going to sleep. */
function historyOf(ctx: Pick<MainContext, 'tabs'>, tabId: TabId): SavedHistory | undefined {
  const contents = ctx.tabs.contents(tabId)
  if (contents && !contents.isDestroyed() && contents.navigationHistory.length() > 0) {
    return { entries: contents.navigationHistory.getAllEntries(), index: contents.navigationHistory.getActiveIndex() }
  }
  const saved = ctx.tabs.savedHistory.get(tabId)
  return saved ? { entries: [...saved.entries], index: saved.index } : undefined
}

/**
 * Puts the sidebar back as a backup has it (AR-11): one state update (`planRestore`,
 * `applyRestore`), then what follows outside the state. Returning tabs get their history before
 * they can wake; tabs that left hand theirs to the Archive and close their page; tabs now in
 * another profile start again in its session.
 */
export function restoreSidebar(
  ctx: Pick<MainContext, 'store' | 'tabs'>,
  archive: Pick<ArchiveStore, 'get' | 'idsOfTab' | 'delete'>,
  snap: SidebarSnapshot,
  now = Date.now(),
): RestorePlan {
  const state = ctx.store.state
  const hot = new Map<TabId, ArchivedTab[]>()
  for (const a of state.archive) if (a.tabId) hot.set(a.tabId, [...(hot.get(a.tabId) ?? []), a])
  const plan = planRestore(
    state,
    snap,
    {
      archived: (tabId) => {
        const ids = new Set(archive.idsOfTab(tabId))
        for (const a of hot.get(tabId) ?? []) ids.add(a.id)
        let newest: (ArchivedTab & { history?: ArchiveHistory }) | undefined
        for (const id of ids) {
          const e = archive.get(id) ?? hot.get(tabId)?.find((a) => a.id === id)
          if (e && (!newest || e.archivedAt > newest.archivedAt)) newest = e
        }
        return { ids: [...ids], ...(newest ? { newest } : {}) }
      },
      favicon: (url) => ctx.tabs.faviconFor(url),
      history: (tabId) => historyOf(ctx, tabId),
    },
    now,
  )
  for (const id of plan.added) {
    const h = plan.histories.get(id)
    if (h) ctx.tabs.savedHistory.set(id, { entries: h.entries.map((e) => ({ ...e })), index: h.index })
    else ctx.tabs.savedHistory.delete(id)
  }
  ctx.store.update((d) => applyRestore(d, state, plan))
  // Entries in state went with the update; the Archive store lets go of the rest.
  if (plan.unarchived.length > 0) archive.delete(plan.unarchived)
  for (const r of plan.removed) if (r.entry) noteArchiveHistory(r.entry.id, r.history)
  for (const r of plan.removed) ctx.tabs.destroy(r.tab.id)
  for (const id of plan.reload) {
    ctx.tabs.sleep(id)
    ctx.tabs.savedHistory.delete(id)
  }
  return plan
}
