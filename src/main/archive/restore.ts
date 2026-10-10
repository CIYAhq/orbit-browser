import type { ArchiveRestoreResult } from '../../shared/commands/archive'
import { newId } from '../../shared/ids'
import { routeFor } from '../../shared/link-routing'
import type { ArchivedTab, OrbitState, SpaceId, TabId, WindowId } from '../../shared/state'
import { insertItem } from '../../shared/tree'
import type { MainContext } from '../context'
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

/**
 * Puts archived tabs back at the top of Today (AR-05), in the order given, and takes their entries
 * out of the Archive in the same step. Entries that are gone (restored already, deleted) are
 * skipped, so a second click restores nothing.
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
  const seen = new Set<string>()
  const taken = new Set<TabId>()
  for (const id of ids) {
    if (typeof id !== 'string' || seen.has(id)) continue
    seen.add(id)
    const stored = archive.get(id)
    const entry: ArchivedTab | undefined = stored ?? state.archive.find((a) => a.id === id)
    if (!entry) continue
    const spaceId = restoreSpace(state, entry, opts.windowId, opts.here)
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
    const placed = new Map<SpaceId, number>()
    for (const p of plans) {
      const space = d.spaces[p.spaceId]
      if (!space) continue
      d.tabs[p.tabId] = makeTab(
        { id: p.tabId, spaceId: p.spaceId, profileId: space.profileId, url: p.entry.url, title: p.entry.title },
        now,
      )
      // Each next one goes below the one before, so a batch keeps its order at the top.
      const k = placed.get(p.spaceId) ?? 0
      placed.set(p.spaceId, k + 1)
      insertItem(d, { kind: 'today', spaceId: p.spaceId }, todayInsertIndex(space, 'restore') + k, p.tabId)
    }
    if (d.archive.some((a) => restored.has(a.id))) d.archive = d.archive.filter((a) => !restored.has(a.id))
    const first = plans[0]
    const win = opts.windowId ? d.windows[opts.windowId] : undefined
    if (opts.open && opts.windowId && win && first && d.tabs[first.tabId]) {
      if (!opts.stay || win.spaceId === first.spaceId) activateInDraft(d, opts.windowId, first.tabId, now)
    }
  })
  archive.delete(restored)
  return {
    ids: plans.map((p) => p.entry.id),
    tabIds: plans.map((p) => p.tabId),
    spaceIds: plans.map((p) => p.spaceId),
  }
}
