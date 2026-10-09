/**
 * Tab and sidebar operations (owned by the tabs lane). Commands, actions, menus,
 * drag-and-drop and the maintenance timers all go through these so the rules
 * (selection after close, archive, undo, pinned URL bookkeeping) live in one place.
 */
import { createWindowState, FAVORITES_FULL_MESSAGE, MAX_FAVORITES } from '../../shared/defaults'
import { isFolderId, isTabId, newId } from '../../shared/ids'
import { isPendingPane, layoutLeaves, paneAfterClose, SPLIT_FULL_MESSAGE } from '../../shared/split'
import type {
  ArchivedTab,
  ContainerRef,
  Folder,
  FolderId,
  ItemId,
  OrbitState,
  SpaceId,
  SplitId,
  Tab,
  TabId,
  WindowId,
} from '../../shared/state'
import { cleanUrl, isAwayFromPinned, markdownLink, tabTitle } from '../../shared/tabs'
import {
  canMoveTo,
  containerItems,
  containerKey,
  type ItemLocation,
  insertItem,
  locate,
  profileOfContainer,
  removeItem,
  rootContainerOf,
  sectionOf,
  setContainerItems,
  spaceOfContainer,
  splitOfTab,
  tabsInItem,
} from '../../shared/tree'
import type { MainContext } from '../context'
import {
  addPaneInDraft,
  isFailure,
  type PaneAnchor,
  restorePaneInDraft,
  restoreUnitInDraft,
  type SplitUnit,
  splitAnchor,
  splitCloseInfo,
} from '../split/model'
import {
  activateInDraft,
  dedupeDisplayed,
  detachFromSplit,
  makeTab,
  mostRecentTab,
  nextAfterClose,
  reselectAway,
  shownElsewhere,
  todayInsertIndex,
} from './model'
import type { SavedHistory } from './runtime'
import { UndoStack } from './undo'

export interface ClosedTab {
  tab: Tab
  location?: ItemLocation
  history?: SavedHistory
  archiveId?: string
  closedAt?: number
  /** A split pane closed on its own: reopening puts it back beside its neighbours (SV-17). */
  pane?: PaneAnchor
  /** Closed with every other pane of its split: reopening brings the whole split back (SV-19). */
  unit?: SplitUnit
}

/** Tab fields that moving between sections changes (restored by undo). */
type TabPlacement = Pick<
  Tab,
  'spaceId' | 'profileId' | 'pinnedUrl' | 'pinnedTitle' | 'pinnedResolvedUrl' | 'lastActiveAt'
>
/** Where an item sat and how its tabs were placed. */
type Placement = { id: ItemId; loc: ItemLocation; tabs: Record<TabId, TabPlacement> }

const MAX_RECENTLY_CLOSED = 50
const MAX_ARCHIVE = 5000
const ARCHIVE_TRIM_CHUNK = 500

export class TabOps {
  readonly recentlyClosed: ClosedTab[] = []
  readonly undo = new UndoStack()

  constructor(
    private ctx: MainContext,
    private now: () => number = Date.now,
  ) {}

  private get state(): OrbitState {
    return this.ctx.store.state
  }

  // ---- Queries ----

  spaceOfWindow(windowId: WindowId | undefined): SpaceId {
    return (windowId && this.state.windows[windowId]?.spaceId) || (this.state.spaceOrder[0] as string)
  }

  activeTab(windowId: WindowId | undefined): TabId | null {
    if (!windowId) return null
    const win = this.state.windows[windowId]
    const id = win?.activeTab[win.spaceId]
    return id && this.state.tabs[id] ? id : null
  }

  historyOf(tabId: TabId): SavedHistory | undefined {
    const contents = this.ctx.tabs.contents(tabId)
    if (contents && contents.navigationHistory.length() > 0) {
      return {
        entries: contents.navigationHistory.getAllEntries(),
        index: contents.navigationHistory.getActiveIndex(),
      }
    }
    const saved = this.ctx.tabs.savedHistory.get(tabId)
    return saved ? { entries: [...saved.entries], index: saved.index } : undefined
  }

  /** Pinned area or Favorites (anything that keeps a pinned URL). */
  isPinnedArea(ref: ContainerRef, state: OrbitState = this.state): boolean {
    const root = rootContainerOf(state, ref)
    return root?.kind === 'pinned' || root?.kind === 'favorites'
  }

  // ---- Create / activate ----

  createTab(opts: {
    url?: string
    spaceId?: SpaceId
    container?: ContainerRef
    index?: number
    activate?: boolean
    windowId?: WindowId
    openerTabId?: TabId
    history?: SavedHistory
    title?: string
    favicon?: string
  }): TabId {
    const state = this.state
    const url = opts.url ?? 'about:blank'
    const space =
      opts.spaceId ?? (opts.container && spaceOfContainer(state, opts.container)) ?? this.spaceOfWindow(opts.windowId)
    const spaceObj = state.spaces[space]
    if (!spaceObj) throw new Error(`Unknown space ${space}`)
    const target: ContainerRef = opts.container ?? { kind: 'today', spaceId: space }
    if (target.kind === 'favorites' && this.favoriteCount(target.profileId) >= MAX_FAVORITES) {
      this.ctx.toast(opts.windowId, FAVORITES_FULL_MESSAGE)
      throw new Error('Favorites are full')
    }
    const profileId = profileOfContainer(state, target) ?? spaceObj.profileId
    const tab = makeTab(
      { spaceId: space, profileId, url, openerTabId: opts.openerTabId, favicon: opts.favicon },
      this.now(),
    )
    if (opts.title) tab.title = opts.title
    if (this.isPinnedArea(target, state)) {
      tab.pinnedUrl = url
      tab.pinnedResolvedUrl = url
      tab.pinnedTitle = tab.title
    }
    if (opts.history) this.ctx.tabs.savedHistory.set(tab.id, opts.history)
    const index =
      opts.index ??
      (target.kind === 'today'
        ? todayInsertIndex(spaceObj, opts.activate === false ? 'background' : 'new')
        : Number.MAX_SAFE_INTEGER)
    this.ctx.store.update((d) => {
      d.tabs[tab.id] = tab
      insertItem(d, target, index, tab.id)
      if (opts.activate !== false && opts.windowId) activateInDraft(d, opts.windowId, tab.id, this.now())
    })
    return tab.id
  }

  activate(windowId: WindowId, tabId: TabId): void {
    if (!this.state.tabs[tabId]) return
    this.ctx.store.update((d) => activateInDraft(d, windowId, tabId, this.now()))
  }

  /** Favorites in use, one per tile: a Favorite split counts once, however many panes it has (FV-02, SV-23, D19). */
  favoriteCount(profileId: string, state: OrbitState = this.state): number {
    return (state.profiles[profileId]?.favorites ?? []).length
  }

  // ---- Close, archive, reopen ----

  private archiveEntry(
    d: OrbitState,
    tab: Tab,
    reason: ArchivedTab['reason'],
    section: 'today' | 'pinned',
  ): string | undefined {
    if (!tab.url || tab.url === 'about:blank') return undefined
    const id = newId('a')
    // Appended (newest last): an unshift would rewrite every entry's patch path.
    d.archive.push({
      id,
      url: tab.url,
      title: tabTitle(tab),
      // No favicon copy in OrbitState (lane review MF-2): look it up with tabs.favicon(url).
      spaceId: tab.spaceId,
      profileId: tab.profileId,
      archivedAt: this.now(),
      reason,
      section,
    })
    // Trim the oldest entries in chunks so the full-list rewrite happens rarely.
    if (d.archive.length > MAX_ARCHIVE + ARCHIVE_TRIM_CHUNK) d.archive.splice(0, d.archive.length - MAX_ARCHIVE)
    return id
  }

  /**
   * Closes tabs (TB-06). Today tabs leave the sidebar and go to the Archive; pinned tabs
   * and Favorites stay and unload, resetting to their pinned URL (PN-06, FV-06).
   * `remove` also removes pinned tabs (delete from sidebar).
   */
  closeTabs(
    tabIds: TabId[],
    reason: ArchivedTab['reason'],
    opts: { remove?: boolean; reselect?: 'neighbor' | 'pinned'; undoLabel?: string | false } = {},
  ): void {
    const state = this.state
    const removing: TabId[] = []
    const unloading: TabId[] = []
    // A split pane closed on its own leaves its split, even a pinned or Favorite one (SV-17);
    // closing every pane of a split closes the split as one unit (SV-19).
    const splitInfo = splitCloseInfo(state, new Set(tabIds))
    for (const id of new Set(tabIds)) {
      if (!state.tabs[id]) continue
      const section = sectionOf(state, id)
      const ownPane = !!splitInfo.get(id)?.pane || isPendingPane(state, id)
      if (!opts.remove && !ownPane && (section === 'pinned' || section === 'favorite')) unloading.push(id)
      else removing.push(id)
    }
    if (removing.length === 0 && unloading.length === 0) return
    const all = new Set([...removing, ...unloading])
    const closedAt = this.now()
    const records: ClosedTab[] = removing.map((id) => ({
      tab: { ...(state.tabs[id] as Tab) },
      location: locate(state, splitOfTab(state, id) ?? id),
      history: this.historyOf(id),
      closedAt,
      ...splitInfo.get(id),
    }))
    const todayTabs = (spaceId: SpaceId) =>
      new Set((state.spaces[spaceId]?.today ?? []).flatMap((id) => tabsInItem(state, id)))
    const pick =
      opts.reselect === 'pinned'
        ? (spaceId: SpaceId, _current: TabId, excluding: Set<TabId>) => {
            const today = todayTabs(spaceId)
            return mostRecentTab(state, spaceId, excluding, (t) => !today.has(t.id))
          }
        : // A closing pane hands focus to a pane of its split, so the split stays on screen (SV-17).
          (spaceId: SpaceId, current: TabId, excluding: Set<TabId>) =>
            paneAfterClose(state, current, excluding) ?? nextAfterClose(state, spaceId, current, excluding)
    this.ctx.store.update((d) => {
      reselectAway(d, all, pick, this.now())
      // Archive bottom-up so the first tab of a batch ends up newest (the top of the Archive list).
      for (const rec of [...records].reverse()) {
        const tab = d.tabs[rec.tab.id]
        if (!tab) continue
        const section = sectionOf(d, tab.id) === 'today' ? 'today' : 'pinned'
        rec.archiveId = this.archiveEntry(d, tab, reason, section)
      }
      for (const rec of records) {
        detachFromSplit(d, rec.tab.id)
        removeItem(d, rec.tab.id)
        delete d.tabs[rec.tab.id]
      }
      for (const id of unloading) {
        const tab = d.tabs[id]
        if (!tab?.pinnedUrl) continue
        tab.url = tab.pinnedUrl
        tab.title = tab.pinnedTitle ?? tab.title
        tab.loading = false
        tab.canGoBack = false
        tab.canGoForward = false
        delete tab.error
      }
    })
    for (const rec of records) this.ctx.tabs.destroy(rec.tab.id)
    for (const id of unloading) {
      this.ctx.tabs.sleep(id)
      this.ctx.tabs.savedHistory.delete(id)
    }
    // An empty split pane still waiting for its first page is not worth reopening.
    for (let i = records.length - 1; i >= 0; i--) {
      if (isPendingPane(state, (records[i] as ClosedTab).tab.id)) records.splice(i, 1)
    }
    if (records.length === 0) return
    if (reason !== 'auto') {
      this.recentlyClosed.push(...records)
      if (this.recentlyClosed.length > MAX_RECENTLY_CLOSED) {
        this.recentlyClosed.splice(0, this.recentlyClosed.length - MAX_RECENTLY_CLOSED)
      }
    }
    if (opts.undoLabel !== false) {
      const label = opts.undoLabel ?? (records.length > 1 ? 'Close Tabs' : 'Close Tab')
      this.undo.push(
        label,
        () => {
          const back = this.restoreClosed(records, { select: false })
          return () => this.closeTabs(back, reason, { remove: opts.remove, reselect: opts.reselect, undoLabel: label })
        },
        this.now(),
        () => records.every((r) => !!this.state.tabs[r.tab.id]),
      )
    }
  }

  /** Puts closed tabs back where they were (or at the top of Today), with their history (TB-07). */
  restoreClosed(records: ClosedTab[], opts: { windowId?: WindowId; select: boolean }): TabId[] {
    const live = records.filter((r) => !this.state.tabs[r.tab.id])
    if (live.length === 0) return []
    const ids = new Set(live.map((r) => r.tab.id))
    for (let i = this.recentlyClosed.length - 1; i >= 0; i--) {
      if (ids.has(this.recentlyClosed[i]?.tab.id as string)) this.recentlyClosed.splice(i, 1)
    }
    // History must be in place before activation wakes the tab.
    for (const rec of live) if (rec.history) this.ctx.tabs.savedHistory.set(rec.tab.id, rec.history)
    const now = this.now()
    const sorted = [...live].sort((a, b) => (a.location?.index ?? 0) - (b.location?.index ?? 0))
    let select = live[live.length - 1]?.tab.id
    this.ctx.store.update((d) => {
      // Tabs of whole splits first go into state; their splits come back as units below.
      const units = new Map<string, SplitUnit>()
      for (const rec of sorted) {
        if (!rec.unit) continue
        const tab: Tab = { ...rec.tab, asleep: true, loading: false, audible: false, lastActiveAt: now }
        if (!d.spaces[tab.spaceId]) tab.spaceId = d.spaceOrder[0] as string
        d.tabs[tab.id] = tab
        units.set(rec.unit.id, rec.unit)
      }
      const placedByUnit = new Set<TabId>()
      for (const unit of units.values()) {
        const landed = restoreUnitInDraft(d, unit, now)
        if (!landed) continue
        for (const id of unit.tabIds) {
          if (!d.tabs[id]) continue
          placedByUnit.add(id)
          for (const moved of this.fixupTabs(d, [id], landed)) this.ctx.tabs.savedHistory.delete(moved)
        }
        if (unit.focus && placedByUnit.has(unit.focus)) select = unit.focus
      }
      for (const rec of sorted) {
        if (placedByUnit.has(rec.tab.id)) {
          if (rec.archiveId) {
            const i = d.archive.findIndex((a) => a.id === rec.archiveId)
            if (i >= 0) d.archive.splice(i, 1)
          }
          continue
        }
        const tab: Tab = d.tabs[rec.tab.id] ?? {
          ...rec.tab,
          asleep: true,
          loading: false,
          audible: false,
          lastActiveAt: now,
        }
        if (!d.spaces[tab.spaceId]) tab.spaceId = d.spaceOrder[0] as string
        d.tabs[tab.id] = tab
        const where = rec.location && containerItems(d, rec.location.container) ? rec.location : undefined
        let landed: ContainerRef | undefined
        // A pane goes back into its split, in this same update (no frame shows it on its own).
        const intoSplit = rec.pane ? restorePaneInDraft(d, tab.id, rec.pane) : undefined
        if (intoSplit) {
          landed = intoSplit
        } else if (where) {
          insertItem(d, where.container, where.index, tab.id)
          landed = where.container
        } else {
          const space = d.spaces[tab.spaceId]
          if (space) {
            landed = { kind: 'today', spaceId: space.id }
            insertItem(d, landed, todayInsertIndex(space, 'reopen'), tab.id)
          }
        }
        // Where it lands decides its Space, profile and pinned fields (the folder may have moved).
        // History from another profile's session stays behind (PR-05) — dropped here, before
        // selecting it lets the layout pass wake the tab.
        if (landed) for (const moved of this.fixupTabs(d, [tab.id], landed)) this.ctx.tabs.savedHistory.delete(moved)
        if (rec.archiveId) {
          const i = d.archive.findIndex((a) => a.id === rec.archiveId)
          if (i >= 0) d.archive.splice(i, 1)
        }
      }
      // A tab that came back under another profile (its split or folder moved to another
      // profile's Space) starts afresh in that session: the old session's history stays behind (PR-05).
      for (const rec of live) {
        const placed = d.tabs[rec.tab.id]
        if (placed && placed.profileId !== rec.tab.profileId) this.ctx.tabs.savedHistory.delete(rec.tab.id)
      }
      if (opts.select && opts.windowId && select && d.tabs[select]) activateInDraft(d, opts.windowId, select, now)
    })
    return live.map((r) => r.tab.id)
  }

  /** Reopens one specific recently closed tab (from the command bar). */
  reopen(tabId: TabId, windowId: WindowId | undefined): TabId | null {
    const i = this.recentlyClosed.findIndex((r) => r.tab.id === tabId)
    const rec = i >= 0 ? this.recentlyClosed[i] : undefined
    if (!rec) return null
    this.recentlyClosed.splice(i, 1)
    const [id] = this.restoreClosed(this.withUnit(rec), { windowId, select: true })
    return id ?? null
  }

  /** A record of a split closed as one unit comes back with every other tab of that split (SV-19). */
  private withUnit(rec: ClosedTab): ClosedTab[] {
    const unitId = rec.unit?.id
    if (!unitId) return [rec]
    const rest: ClosedTab[] = []
    for (let i = this.recentlyClosed.length - 1; i >= 0; i--) {
      const r = this.recentlyClosed[i] as ClosedTab
      if (r.unit?.id !== unitId) continue
      rest.unshift(r)
      this.recentlyClosed.splice(i, 1)
    }
    return [...rest, rec]
  }

  /** ⌘⇧T: reopens the most recently closed tab (a stack). */
  reopenLast(windowId: WindowId | undefined): TabId | null {
    while (this.recentlyClosed.length > 0) {
      const rec = this.recentlyClosed.pop() as ClosedTab
      if (this.state.tabs[rec.tab.id]) continue
      const restored = this.restoreClosed(this.withUnit(rec), { windowId, select: true })
      return restored[restored.length - 1] ?? null
    }
    return null
  }

  /** Clear (TD-04): archives the Space's Today tabs, keeping tabs that play media. */
  clearToday(spaceId: SpaceId): void {
    const space = this.state.spaces[spaceId]
    if (!space) return
    const tabs = space.today.flatMap((id) => tabsInItem(this.state, id)).filter((id) => !this.state.tabs[id]?.audible)
    this.closeTabs(tabs, 'cleared', { reselect: 'pinned', undoLabel: 'Clear Today' })
  }

  /** Archive tabs below (TD-05): every Today item listed after the one holding `tabId`. */
  archiveBelow(tabId: TabId): void {
    const state = this.state
    const item = splitOfTab(state, tabId) ?? tabId
    const loc = locate(state, item)
    if (loc?.container.kind !== 'today') return
    const space = state.spaces[loc.container.spaceId]
    if (!space) return
    const tabs = space.today
      .slice(loc.index + 1)
      .flatMap((id) => tabsInItem(state, id))
      .filter((id) => !state.tabs[id]?.audible)
    this.closeTabs(tabs, 'cleared', { undoLabel: 'Archive Tabs Below' })
  }

  /** Removes a pinned item, Favorite or folder from the sidebar into the Archive (PN-06, FD-10). */
  deleteItem(id: ItemId): void {
    const state = this.state
    if (isFolderId(id)) {
      this.deleteFolder(id as FolderId, false)
      return
    }
    const tabs = tabsInItem(state, splitOfTab(state, id) ?? id)
    this.closeTabs(tabs, 'closed', { remove: true, undoLabel: 'Remove from Sidebar' })
  }

  /** Deletes a folder (FD-10). Contents go to the Archive, or stay in place with `keepChildren`. */
  deleteFolder(folderId: FolderId, keepChildren: boolean): void {
    const state = this.state
    const folder = state.folders[folderId]
    const loc = locate(state, folderId)
    if (!folder || !loc) return
    if (keepChildren) {
      const before = this.capture([folderId, ...folder.children])
      const snapshot = structuredClone(folder) as Folder
      this.ctx.store.update((d) => {
        const f = d.folders[folderId]
        const at = removeItem(d, folderId)
        const list = at ? containerItems(d, at.container) : undefined
        if (f && at && list) {
          setContainerItems(d, at.container, [...list.slice(0, at.index), ...f.children, ...list.slice(at.index)])
        }
        delete d.folders[folderId]
      })
      this.undo.push('Delete Folder', () => {
        this.ctx.store.update((d) => {
          if (d.folders[folderId]) return
          d.folders[folderId] = { ...structuredClone(snapshot), children: [] }
          if (containerItems(d, loc.container)) insertItem(d, loc.container, loc.index, folderId)
        })
        this.restorePlacement(before.filter((b) => b.id !== folderId))
      })
      return
    }
    // Remove the whole subtree; tabs go to the Archive.
    const folders: Folder[] = []
    const walk = (fid: FolderId) => {
      const f = state.folders[fid]
      if (!f) return
      folders.push(structuredClone(f) as Folder)
      for (const child of f.children) if (isFolderId(child)) walk(child)
    }
    walk(folderId)
    const tabIds = tabsInItem(state, folderId)
    const records: ClosedTab[] = tabIds.map((tid) => ({
      tab: { ...(state.tabs[tid] as Tab) },
      history: this.historyOf(tid),
    }))
    const splits = folders
      .flatMap((f) => f.children)
      .filter((c) => !isTabId(c) && !isFolderId(c))
      .map((sid) => state.splits[sid])
      .filter((s) => !!s)
      .map((s) => structuredClone(s))
    const all = new Set(tabIds)
    this.ctx.store.update((d) => {
      reselectAway(
        d,
        all,
        (spaceId, current, excluding) => nextAfterClose(state, spaceId, current, excluding),
        this.now(),
      )
      for (const rec of [...records].reverse()) {
        const tab = d.tabs[rec.tab.id]
        if (tab) rec.archiveId = this.archiveEntry(d, tab, 'closed', 'pinned')
      }
      removeItem(d, folderId)
      for (const f of folders) delete d.folders[f.id]
      for (const s of splits) delete d.splits[s.id]
      for (const tid of tabIds) delete d.tabs[tid]
    })
    for (const tid of tabIds) this.ctx.tabs.destroy(tid)
    this.undo.push('Delete Folder', () => {
      for (const rec of records) if (rec.history) this.ctx.tabs.savedHistory.set(rec.tab.id, rec.history)
      this.ctx.store.update((d) => {
        if (!containerItems(d, loc.container)) return
        for (const f of folders) d.folders[f.id] = structuredClone(f)
        for (const s of splits) d.splits[s.id] = structuredClone(s)
        for (const rec of records) {
          d.tabs[rec.tab.id] = { ...rec.tab, asleep: true, loading: false, audible: false }
          if (rec.archiveId) {
            const i = d.archive.findIndex((a) => a.id === rec.archiveId)
            if (i >= 0) d.archive.splice(i, 1)
          }
        }
        insertItem(d, loc.container, loc.index, folderId)
      })
    })
  }

  // ---- Folders ----

  /**
   * New Folder (FD-02): at the end of the pinned section, or — with selected items — in the
   * first item's place, holding them (Today tabs get pinned). Undo puts the items back where
   * they were and removes the folder.
   */
  createFolder(opts: {
    container?: ContainerRef
    index?: number
    name?: string
    items?: ItemId[]
    windowId?: WindowId
  }): FolderId {
    const state = this.state
    // Panes stand for their split view; each item once.
    const items = [...new Set((opts.items ?? []).map((i) => (isTabId(i) ? (splitOfTab(state, i) ?? i) : i)))]
    const spaceId = this.spaceOfWindow(opts.windowId)
    const first = items.map((i) => locate(state, i)).find((l) => !!l)
    let target: ContainerRef = opts.container ?? { kind: 'pinned', spaceId }
    let at = opts.index ?? state.spaces[spaceId]?.pinned.length ?? 0
    if (!opts.container && first && (first.container.kind === 'pinned' || first.container.kind === 'folder')) {
      target = first.container
      at = first.index
    }
    const id = newId('f')
    this.ctx.store.update((d) => {
      d.folders[id] = { id, name: opts.name ?? 'New Folder', children: [], collapsed: false, createdAt: this.now() }
      insertItem(d, target, at, id)
    })
    // Positions with the folder already in its slot, so undo puts items back before removing it.
    const before = this.capture(items)
    if (items.length > 0)
      this.moveItems(items, { kind: 'folder', folderId: id }, 0, { windowId: opts.windowId, undoLabel: false })
    this.undo.push('New Folder', () => {
      this.restorePlacement(before)
      this.ctx.store.update((d) => {
        const f = d.folders[id]
        if (!f || f.children.length > 0) return
        removeItem(d, id)
        delete d.folders[id]
      })
    })
    return id
  }

  // ---- Moves ----

  /** Records where items are and how their tabs are placed, for undo. */
  private capture(ids: ItemId[]): Placement[] {
    const state = this.state
    const out: Placement[] = []
    for (const id of ids) {
      const loc = locate(state, id)
      if (!loc) continue
      const tabs: Record<TabId, TabPlacement> = {}
      for (const tid of tabsInItem(state, id)) {
        const t = state.tabs[tid]
        if (t) {
          tabs[tid] = {
            spaceId: t.spaceId,
            profileId: t.profileId,
            pinnedUrl: t.pinnedUrl,
            pinnedTitle: t.pinnedTitle,
            pinnedResolvedUrl: t.pinnedResolvedUrl,
            lastActiveAt: t.lastActiveAt,
          }
        }
      }
      out.push({ id, loc, tabs })
    }
    return out
  }

  private restorePlacement(before: Placement[]): void {
    const reload: TabId[] = []
    const state = this.state
    // Windows keep their Space: a selected tab going back elsewhere hands over selection (TB-11).
    const moving = new Set(before.flatMap((b) => Object.keys(b.tabs)))
    const placementOf = (tabId: TabId) => before.find((x) => tabId in x.tabs)
    const picks = this.selectionPicks(
      state,
      moving,
      (tabId) => {
        const b = placementOf(tabId)
        return b ? spaceOfContainer(state, b.loc.container) : undefined
      },
      (tabId) => {
        const b = placementOf(tabId)
        return b ? profileOfContainer(state, b.loc.container) : undefined
      },
    )
    this.ctx.store.update((d) => {
      const present = before.filter((b) => (isTabId(b.id) ? d.tabs[b.id] : true) && locate(d, b.id))
      for (const b of present) removeItem(d, b.id)
      // Same container: ascending index, so each item lands where it was.
      const sorted = [...present].sort((a, b) => {
        const ka = containerKey(a.loc.container)
        const kb = containerKey(b.loc.container)
        return ka < kb ? -1 : ka > kb ? 1 : a.loc.index - b.loc.index
      })
      for (const b of sorted) {
        if (containerItems(d, b.loc.container)) insertItem(d, b.loc.container, b.loc.index, b.id)
        else {
          const first = d.spaceOrder[0]
          if (first) insertItem(d, { kind: 'today', spaceId: first }, 0, b.id)
        }
        for (const [tid, placement] of Object.entries(b.tabs)) {
          const tab = d.tabs[tid]
          if (!tab) continue
          if (tab.profileId !== placement.profileId) reload.push(tid)
          tab.spaceId = placement.spaceId
          tab.profileId = placement.profileId
          tab.lastActiveAt = placement.lastActiveAt
          if (placement.pinnedUrl) {
            tab.pinnedUrl = placement.pinnedUrl
            tab.pinnedTitle = placement.pinnedTitle
            tab.pinnedResolvedUrl = placement.pinnedResolvedUrl
          } else {
            delete tab.pinnedUrl
            delete tab.pinnedTitle
            delete tab.pinnedResolvedUrl
          }
        }
      }
      for (const p of picks) {
        const w = d.windows[p.windowId]
        if (w) w.activeTab[p.spaceId] = p.next
      }
      dedupeDisplayed(d)
    })
    for (const tid of reload) {
      this.ctx.tabs.sleep(tid)
      this.ctx.tabs.savedHistory.delete(tid)
    }
  }

  /**
   * For tabs about to move, the windows/Spaces whose selection must move on: a selected tab
   * leaving the Space a window remembers it in hands selection to its neighbour (TB-11).
   */
  private selectionPicks(
    state: OrbitState,
    moving: Set<TabId>,
    destSpace: (tabId: TabId) => SpaceId | undefined,
    destProfile: (tabId: TabId) => string | undefined,
  ): { windowId: WindowId; spaceId: SpaceId; next: TabId | null }[] {
    const picks: { windowId: WindowId; spaceId: SpaceId; next: TabId | null }[] = []
    for (const win of Object.values(state.windows)) {
      for (const [spaceId, active] of Object.entries(win.activeTab)) {
        if (!active || !moving.has(active)) continue
        const space = destSpace(active)
        const staysVisible = space ? space === spaceId : state.spaces[spaceId]?.profileId === destProfile(active)
        if (!staysVisible) {
          const excluding = new Set<TabId>([...moving, ...shownElsewhere(state, win.id)])
          picks.push({ windowId: win.id, spaceId, next: nextAfterClose(state, spaceId, active, excluding) })
        }
      }
    }
    return picks
  }

  /** Keeps pinned URL, Space and profile consistent after tabs moved into `to`. Returns tabs to reload. */
  private fixupTabs(d: OrbitState, tabIds: TabId[], to: ContainerRef): TabId[] {
    const pinned = this.isPinnedArea(to, d)
    const spaceId = spaceOfContainer(d, to)
    const profileId = profileOfContainer(d, to)
    const reload: TabId[] = []
    for (const tabId of tabIds) {
      const tab = d.tabs[tabId]
      if (!tab) continue
      if (pinned && !tab.pinnedUrl) {
        tab.pinnedUrl = tab.url
        tab.pinnedTitle = tab.title
        tab.pinnedResolvedUrl = tab.url
      }
      if (!pinned && tab.pinnedUrl) {
        delete tab.pinnedUrl
        delete tab.pinnedTitle
        delete tab.pinnedResolvedUrl
        // A tab that just became a Today tab starts its idle timer now (TD-02).
        tab.lastActiveAt = this.now()
      }
      if (spaceId) tab.spaceId = spaceId
      if (profileId && profileId !== tab.profileId) {
        tab.profileId = profileId
        reload.push(tabId)
      }
    }
    return reload
  }

  /**
   * Moves items into a container at `index` (an index into the target list without the
   * moving items). Handles pin/unpin semantics, Favorites capacity, cross-Space selection
   * and undo (TB-08, TB-09, TB-11, PN-02, FV-03…05, FD-05).
   */
  moveItems(
    ids: ItemId[],
    to: ContainerRef,
    index: number,
    opts: { windowId?: WindowId; undoLabel?: string | false } = {},
  ): boolean {
    const state = this.state
    const items = [...new Set(ids.map((id) => (isTabId(id) ? (splitOfTab(state, id) ?? id) : id)))].filter(
      (id) => !!locate(state, id),
    )
    if (items.length === 0) return false
    if (!items.every((id) => canMoveTo(state, id, to))) return false
    // Never move a folder into one of the other moving folders' subtrees.
    if (to.kind === 'folder' && items.includes(to.folderId)) return false
    if (to.kind === 'favorites') {
      const target = containerKey(to)
      // Tiles, not tabs: a split coming in takes one Favorite (D19).
      const incoming = items.filter((id) => {
        const from = locate(state, id)
        return !from || containerKey(from.container) !== target
      }).length
      if (incoming > 0 && this.favoriteCount(to.profileId) + incoming > MAX_FAVORITES) {
        this.ctx.toast(opts.windowId, FAVORITES_FULL_MESSAGE)
        return false
      }
    }
    const before = this.capture(items)
    const moving = new Set(items.flatMap((id) => tabsInItem(state, id)))
    const destSpace = spaceOfContainer(state, to)
    const destProfile = profileOfContainer(state, to)
    // Windows keep their Space; a selected tab that leaves it hands selection to its neighbour (TB-11).
    const picks = this.selectionPicks(
      state,
      moving,
      () => destSpace,
      () => destProfile,
    )
    let reload: TabId[] = []
    this.ctx.store.update((d) => {
      for (const id of items) removeItem(d, id)
      items.forEach((id, i) => {
        insertItem(d, to, index + i, id)
      })
      reload = this.fixupTabs(d, [...moving], to)
      for (const p of picks) {
        const w = d.windows[p.windowId]
        if (w) w.activeTab[p.spaceId] = p.next
      }
      dedupeDisplayed(d)
    })
    // A different profile means a different session: the tab reloads there from its URL. Its old
    // history (with form state) stays behind so nothing leaks between profiles (PR-05).
    for (const id of reload) {
      this.ctx.tabs.sleep(id)
      this.ctx.tabs.savedHistory.delete(id)
    }
    if (opts.undoLabel !== false) this.pushMoveUndo(opts.undoLabel ?? 'Move', before, this.capture(items))
    return true
  }

  /** Undo restores where the items were; redo puts them back where they went. */
  private pushMoveUndo(label: string, before: Placement[], after: Placement[]): void {
    this.undo.push(
      label,
      () => {
        this.restorePlacement(before)
        return () => {
          this.restorePlacement(after)
          this.pushMoveUndo(label, before, after)
        }
      },
      this.now(),
    )
  }

  /** ⌘D / Pin: to the end of the pinned section of `spaceId` (default: the tab's Space) (PN-02). */
  pin(tabId: TabId, spaceId?: SpaceId, windowId?: WindowId): boolean {
    const tab = this.state.tabs[tabId]
    const space = this.state.spaces[spaceId ?? tab?.spaceId ?? '']
    if (!tab || !space) return false
    return this.moveItems([tabId], { kind: 'pinned', spaceId: space.id }, space.pinned.length, {
      windowId,
      undoLabel: 'Pin Tab',
    })
  }

  /** Unpin: to the top of Today (PN-02, TB-03). Favorites go to the window's current Space. */
  unpin(tabId: TabId, windowId?: WindowId): boolean {
    const state = this.state
    const tab = state.tabs[tabId]
    if (!tab) return false
    const fav = sectionOf(state, tabId) === 'favorite'
    const spaceId = fav && windowId ? this.spaceOfWindow(windowId) : tab.spaceId
    const space = state.spaces[spaceId]
    if (!space) return false
    return this.moveItems([tabId], { kind: 'today', spaceId }, todayInsertIndex(space, 'unpin'), {
      windowId,
      undoLabel: fav ? 'Remove from Favorites' : 'Unpin Tab',
    })
  }

  /** Add to Favorites (FV-03): the end of the profile's grid. Refuses a 13th Favorite (FV-02). */
  favorite(tabId: TabId, windowId?: WindowId): boolean {
    const state = this.state
    const tab = state.tabs[tabId]
    const space = this.state.spaces[windowId ? this.spaceOfWindow(windowId) : (tab?.spaceId ?? '')]
    const profileId = space?.profileId ?? tab?.profileId
    if (!tab || !profileId) return false
    return this.moveItems([tabId], { kind: 'favorites', profileId }, Number.MAX_SAFE_INTEGER, {
      windowId,
      undoLabel: 'Add to Favorites',
    })
  }

  /** Remove from Favorites (FV-04): into the current Space's pinned or Today section. */
  unfavorite(tabId: TabId, section: 'pinned' | 'today', windowId?: WindowId): boolean {
    const spaceId = this.spaceOfWindow(windowId)
    const space = this.state.spaces[spaceId]
    if (!space) return false
    const to: ContainerRef = { kind: section, spaceId }
    const index = section === 'pinned' ? space.pinned.length : todayInsertIndex(space, 'unpin')
    return this.moveItems([tabId], to, index, { windowId, undoLabel: 'Remove from Favorites' })
  }

  /** Move to another Space's pinned or Today section (TB-11). */
  /**
   * A tab dropped onto a row's half joins that tab or split as a pane (SV-05). Undoable (TB-18):
   * ⌘Z puts the rows back as they were, ⌘⇧Z makes the split again.
   */
  splitWith(tabId: TabId, target: ItemId, side: 'left' | 'right', windowId?: WindowId): SplitId | null {
    const state = this.state
    const anchor = splitAnchor(state, target, side)
    if (!anchor || anchor === tabId || !state.tabs[tabId]) return null
    const fromRow = splitOfTab(state, tabId) ? undefined : locate(state, tabId)
    const joined = splitOfTab(state, anchor)
    const anchorRow = joined ? undefined : locate(state, anchor)
    const joinedLayout = joined ? structuredClone(state.splits[joined]?.layout) : undefined
    const placement = this.capture([tabId, ...(anchorRow ? [anchor] : [])])
    const profiles = new Map([tabId, anchor].map((id) => [id, state.tabs[id]?.profileId]))
    let result: ReturnType<typeof addPaneInDraft> = 'invalid'
    this.ctx.store.update((d) => {
      result = addPaneInDraft(d, tabId, anchor, side, this.now())
      if (!isFailure(result) && windowId) activateInDraft(d, windowId, tabId, this.now())
    })
    if (isFailure(result)) {
      if (result === 'full') this.ctx.toast(windowId, SPLIT_FULL_MESSAGE)
      return null
    }
    const splitId: SplitId = result
    // A tab now in another profile's session reloads there, without the old session's history.
    for (const [id, before] of profiles) {
      if (this.state.tabs[id]?.profileId === before) continue
      this.ctx.tabs.sleep(id)
      this.ctx.tabs.savedHistory.delete(id)
    }
    if (!fromRow) return splitId
    const isPaneHere = () => {
      const split = this.state.splits[splitId]
      return !!split && layoutLeaves(split.layout).includes(tabId)
    }
    this.undo.push(
      'Split View',
      () => {
        if (!isPaneHere()) return undefined
        this.ctx.store.update((d) => {
          const split = d.splits[splitId]
          if (!split) return
          if (joined === splitId && joinedLayout) split.layout = joinedLayout
          else {
            removeItem(d, splitId)
            delete d.splits[splitId]
          }
          const rows = [
            { id: tabId, loc: fromRow },
            ...(anchorRow && joined !== splitId ? [{ id: anchor, loc: anchorRow }] : []),
          ].sort((a, b) => a.loc.index - b.loc.index)
          for (const row of rows) {
            if (!locate(d, row.id) && !splitOfTab(d, row.id) && containerItems(d, row.loc.container)) {
              insertItem(d, row.loc.container, row.loc.index, row.id)
            }
          }
          for (const p of placement) {
            for (const [id, fields] of Object.entries(p.tabs)) {
              const tab = d.tabs[id]
              if (!tab) continue
              tab.spaceId = fields.spaceId
              tab.profileId = fields.profileId
              if (fields.pinnedUrl) {
                tab.pinnedUrl = fields.pinnedUrl
                tab.pinnedTitle = fields.pinnedTitle
                tab.pinnedResolvedUrl = fields.pinnedResolvedUrl
              } else {
                delete tab.pinnedUrl
                delete tab.pinnedTitle
                delete tab.pinnedResolvedUrl
              }
            }
          }
        })
        return () => this.splitWith(tabId, target, side, windowId)
      },
      this.now(),
      () => !isPaneHere(),
    )
    return splitId
  }

  moveToSpace(ids: ItemId[], spaceId: SpaceId, section: 'pinned' | 'today', windowId?: WindowId): boolean {
    const space = this.state.spaces[spaceId]
    if (!space) return false
    const index = section === 'pinned' ? space.pinned.length : todayInsertIndex(space, 'move')
    return this.moveItems(ids, { kind: section, spaceId }, index, { windowId, undoLabel: 'Move to Space' })
  }

  /** Drag out of the window (TB-09): a new window showing the tab exactly as it was. */
  toNewWindow(tabId: TabId, fromWindowId: WindowId | undefined, at?: { x: number; y: number }): WindowId | null {
    const state = this.state
    const tab = state.tabs[tabId]
    if (!tab) return null
    const spaceId = fromWindowId ? this.spaceOfWindow(fromWindowId) : tab.spaceId
    const win = createWindowState(spaceId)
    win.activeTab[spaceId] = tabId
    const source = fromWindowId ? this.ctx.windows.get(fromWindowId) : undefined
    const size = source && !source.isDestroyed() ? source.getBounds() : { width: 1100, height: 760 }
    if (at) {
      const width = Math.max(640, Math.round(size.width * 0.8))
      const height = Math.max(480, Math.round(size.height * 0.8))
      win.bounds = { x: Math.round(at.x - 120), y: Math.round(at.y - 24), width, height }
    }
    const moving = new Set([tabId])
    this.ctx.store.update((d) => {
      if (fromWindowId) {
        const from = d.windows[fromWindowId]
        if (from && from.activeTab[from.spaceId] === tabId) {
          const excluding = new Set<TabId>([...moving, ...shownElsewhere(state, fromWindowId)])
          from.activeTab[from.spaceId] = nextAfterClose(state, from.spaceId, tabId, excluding)
        }
      }
      d.windows[win.id] = win
      const t = d.tabs[tabId]
      if (t) t.lastActiveAt = this.now()
      dedupeDisplayed(d, win.id)
    })
    const created = this.state.windows[win.id]
    if (created) this.ctx.windows.open(created)
    return win.id
  }

  // ---- Pinned URL ----

  /** Reset to the pinned URL (PN-04). With `keepCurrent` the current page also opens as a new Today tab. */
  resetToPinned(tabId: TabId, opts: { keepCurrent?: boolean; windowId?: WindowId } = {}): void {
    const tab = this.state.tabs[tabId]
    if (!tab?.pinnedUrl) return
    if (opts.keepCurrent && isAwayFromPinned(tab)) {
      const space = this.state.spaces[opts.windowId ? this.spaceOfWindow(opts.windowId) : tab.spaceId]
      this.createTab({
        url: tab.url,
        title: tab.title,
        favicon: tab.favicon,
        spaceId: space?.id ?? tab.spaceId,
        activate: false,
        windowId: opts.windowId,
        history: this.historyOf(tabId),
      })
    }
    this.ctx.tabs.markHomeLoad(tabId)
    this.ctx.tabs.navigate(tabId, tab.pinnedUrl)
  }

  /** Pinned URL ▸ Replace with Current / Edit (PN-07). */
  setPinnedUrl(tabId: TabId, url?: string): void {
    this.ctx.store.update((d) => {
      const tab = d.tabs[tabId]
      if (!tab?.pinnedUrl) return
      const next = url?.trim() || tab.url
      tab.pinnedUrl = next
      tab.pinnedResolvedUrl = next
      if (next === tab.url) tab.pinnedTitle = tab.title
    })
  }

  // ---- Names and icons ----

  /** Rename (TB-12): an empty name reverts to the page's own title. */
  rename(tabId: TabId, title: string | null): void {
    const tab = this.state.tabs[tabId]
    if (!tab) return
    const old = tab.customTitle
    const next = title?.trim() ? title.trim() : undefined
    if (old === next) return
    this.setCustomTitle(tabId, next)
    this.undo.push('Rename', () => {
      this.setCustomTitle(tabId, old)
      return () => this.rename(tabId, next ?? null)
    })
  }

  private setCustomTitle(tabId: TabId, value: string | undefined): void {
    this.ctx.store.update((d) => {
      const t = d.tabs[tabId]
      if (!t) return
      if (value) t.customTitle = value
      else delete t.customTitle
    })
  }

  setIcon(tabId: TabId, icon: string | null): void {
    const tab = this.state.tabs[tabId]
    if (!tab) return
    const old = tab.icon
    this.ctx.store.update((d) => {
      const t = d.tabs[tabId]
      if (!t) return
      if (icon) t.icon = icon
      else delete t.icon
    })
    this.undo.push('Change Icon', () => {
      this.ctx.store.update((d) => {
        const t = d.tabs[tabId]
        if (!t) return
        if (old) t.icon = old
        else delete t.icon
      })
    })
  }

  // ---- Copy ----

  linkText(tabIds: TabId[], markdown: boolean): string {
    return tabIds
      .map((id) => this.state.tabs[id])
      .filter((t): t is Tab => !!t && !!t.url && t.url !== 'about:blank')
      .map((t) => {
        const url = cleanUrl(this.ctx.tabs.contents(t.id)?.getURL() || t.url)
        return markdown ? markdownLink(tabTitle(t), url) : url
      })
      .join('\n')
  }
}
