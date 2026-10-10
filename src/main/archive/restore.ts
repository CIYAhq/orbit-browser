import type { ArchiveRestoreResult } from '../../shared/commands/archive'
import { newId } from '../../shared/ids'
import { routeFor } from '../../shared/link-routing'
import { layoutLeaves, replacePane } from '../../shared/split'
import type { ArchivedTab, OrbitState, SpaceId, SplitId, TabId, WindowId } from '../../shared/state'
import { insertItem, splitOfTab } from '../../shared/tree'
import type { MainContext } from '../context'
import { restoreUnitInDraft, type SplitUnit } from '../split/model'
import { activateInDraft, makeTab, todayInsertIndex } from '../tabs/model'
import type { ArchiveHistory, ArchiveStore } from './store'

export interface RestoreOptions {
  /** The window asking: its current Space is the fallback, and `open` selects the tab there. */
  windowId?: WindowId
  /** Into the window's current Space rather than the Space each tab came from (command bar, CB-19). */
  here?: boolean
  /** Select the first restored tab in the window, switching to its Space when needed… */
  open?: boolean
  /** …unless `stay`: then only when it lands in the window's current Space (no forced jump, CB-19). */
  stay?: boolean
  now?: number
}

/**
 * The Space an archived tab goes back to (AR-05): the Space a link-routing rule names for its URL,
 * else the Space it came from, else the window's current Space (else the first Space).
 */
export function restoreSpace(
  state: OrbitState,
  entry: Pick<ArchivedTab, 'url' | 'spaceId'>,
  windowId?: WindowId,
  here = false,
): SpaceId | undefined {
  const current = windowId ? state.windows[windowId]?.spaceId : undefined
  if (here && current && state.spaces[current]) return current
  const routed = routeFor(state.settings.linkRules ?? [], entry.url)
  if (routed && state.spaces[routed]) return routed
  if (state.spaces[entry.spaceId]) return entry.spaceId
  if (current && state.spaces[current]) return current
  return state.spaceOrder.find((id) => state.spaces[id])
}

interface Plan {
  entry: ArchivedTab
  tabId: TabId
  spaceId: SpaceId
  history?: ArchiveHistory
}

/** An entry by id: from the store, else from the recent window in state (before the log was read). */
function entryOf(state: OrbitState, archive: ArchiveStore, id: string): ArchivedTab | undefined {
  return archive.get(id) ?? state.archive.find((a) => a.id === id)
}

/**
 * The ids asked for, each followed by the other panes of the split it was archived with (one
 * entry per pane, the newest): a split comes back from the Archive as one unit (SV-19, SV-24).
 */
function withSplitPanes(state: OrbitState, archive: ArchiveStore, ids: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (id: string) => {
    if (seen.has(id)) return
    seen.add(id)
    out.push(id)
  }
  for (const id of ids) {
    if (typeof id !== 'string') continue
    add(id)
    const split = entryOf(state, archive, id)?.split
    if (!split) continue
    for (const tabId of layoutLeaves(split.layout)) {
      const ids = new Set([
        ...archive.idsOfTab(tabId),
        ...state.archive.filter((a) => a.tabId === tabId).map((a) => a.id),
      ])
      let pane: ArchivedTab | undefined
      for (const candidate of ids) {
        const e = entryOf(state, archive, candidate)
        if (e?.split?.id === split.id && (!pane || e.archivedAt > pane.archivedAt)) pane = e
      }
      if (pane) add(pane.id)
    }
  }
  return out
}

/**
 * Puts archived tabs back at the top of Today (AR-05), in the order given, and takes their entries
 * out of the Archive in the same step. Entries that are gone (restored already, deleted) are
 * skipped, so a second click restores nothing.
 *
 * A pane of a split archived as one unit brings the split's other panes along, and they come back
 * as that split (same arrangement, sizes, name and focused pane) in the first one's Space: one
 * unit, at the top of Today (SV-19, SV-24). With one pane left in the Archive it is a tab again.
 *
 * A tab takes the profile of the Space it lands in (PR-05). Its back/forward history comes back
 * only when that is the profile it was archived from; history never crosses profiles.
 */
export function restoreEntries(
  ctx: Pick<MainContext, 'store' | 'tabs'>,
  archive: ArchiveStore,
  ids: readonly string[],
  opts: RestoreOptions = {},
): ArchiveRestoreResult {
  const state = ctx.store.state
  const now = opts.now ?? Date.now()
  const plans: Plan[] = []
  const taken = new Set<TabId>()
  /** The Space each split's panes go to: the first pane's. */
  const splitSpaces = new Map<SplitId, SpaceId>()
  for (const id of withSplitPanes(state, archive, ids)) {
    const stored = archive.get(id)
    const entry: ArchivedTab | undefined = stored ?? state.archive.find((a) => a.id === id)
    if (!entry) continue
    const spaceId =
      (entry.split && splitSpaces.get(entry.split.id)) || restoreSpace(state, entry, opts.windowId, opts.here)
    if (entry.split && spaceId && !splitSpaces.has(entry.split.id)) splitSpaces.set(entry.split.id, spaceId)
    const space = spaceId ? state.spaces[spaceId] : undefined
    if (!spaceId || !space) continue
    // The tab keeps its id when it is free (links to it, like its entry's, still point at it).
    const tabId = entry.tabId && !state.tabs[entry.tabId] && !taken.has(entry.tabId) ? entry.tabId : newId('t')
    taken.add(tabId)
    const history =
      space.profileId === entry.profileId && stored?.history && stored.history.entries.length > 0
        ? stored.history
        : undefined
    plans.push({ entry, tabId, spaceId, ...(history ? { history } : {}) })
  }
  if (plans.length === 0) return { ids: [], tabIds: [], spaceIds: [] }

  // History is in place before the tab can wake; none at all for a tab in another profile.
  for (const p of plans) {
    if (p.history) {
      ctx.tabs.savedHistory.set(p.tabId, {
        entries: p.history.entries.map((e) => ({ ...e })),
        index: p.history.index,
      })
    } else ctx.tabs.savedHistory.delete(p.tabId)
  }
  const restored = new Set(plans.map((p) => p.entry.id))
  ctx.store.update((d) => {
    for (const p of plans) {
      const space = d.spaces[p.spaceId]
      if (!space) continue
      d.tabs[p.tabId] = makeTab(
        { id: p.tabId, spaceId: p.spaceId, profileId: space.profileId, url: p.entry.url, title: p.entry.title },
        now,
      )
    }
    const placed = new Map<SpaceId, number>()
    const done = new Set<TabId>()
    for (const p of plans) {
      const space = d.spaces[p.spaceId]
      if (!space || !d.tabs[p.tabId] || done.has(p.tabId)) continue
      // Each next one goes below the one before, so a batch keeps its order at the top.
      const k = placed.get(p.spaceId) ?? 0
      placed.set(p.spaceId, k + 1)
      const at = {
        container: { kind: 'today' as const, spaceId: p.spaceId },
        index: todayInsertIndex(space, 'restore') + k,
      }
      const split = p.entry.split
      const panes = split ? plans.filter((q) => q.entry.split?.id === split.id && q.spaceId === p.spaceId) : []
      if (split && panes.length >= 2) {
        // The saved layout names the panes by their tab ids then; one back under a new id takes its place.
        let layout = split.layout
        for (const q of panes)
          if (q.entry.tabId && q.entry.tabId !== q.tabId) layout = replacePane(layout, q.entry.tabId, q.tabId)
        const focus = panes.find((q) => q.entry.tabId === split.focus)?.tabId
        const unit: SplitUnit = {
          id: split.id,
          layout,
          ...(split.name ? { name: split.name } : {}),
          ...(focus ? { focus } : {}),
          location: at,
          tabIds: panes.map((q) => q.tabId),
        }
        if (restoreUnitInDraft(d, unit, now)) {
          for (const q of panes) done.add(q.tabId)
          continue
        }
      }
      insertItem(d, at.container, at.index, p.tabId)
      done.add(p.tabId)
    }
    if (d.archive.some((a) => restored.has(a.id))) d.archive = d.archive.filter((a) => !restored.has(a.id))
    const first = plans[0]
    const win = opts.windowId ? d.windows[opts.windowId] : undefined
    if (opts.open && opts.windowId && win && first && d.tabs[first.tabId]) {
      // A split shows with the pane it had focused (SV-14).
      const splitId = splitOfTab(d, first.tabId)
      const show = (splitId && d.splits[splitId]?.focus) || first.tabId
      if (!opts.stay || win.spaceId === first.spaceId) activateInDraft(d, opts.windowId, show, now)
    }
  })
  archive.delete(restored)
  return {
    ids: plans.map((p) => p.entry.id),
    tabIds: plans.map((p) => p.tabId),
    spaceIds: plans.map((p) => p.spaceId),
  }
}
