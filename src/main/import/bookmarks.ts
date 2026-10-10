/**
 * Imported bookmarks become pinned items (IM-05): one new pinned folder at the end of the target
 * Space's pinned section, holding a pinned tab per bookmark and a sub-folder per bookmark folder,
 * in their order. Pure state helpers (draft in, ids out), unit-tested directly.
 */
import { freeze } from 'immer'
import type { BookmarkNode } from '../../shared/commands/import'
import { newId } from '../../shared/ids'
import type { Folder, FolderId, OrbitState, SpaceId, Tab, TabId } from '../../shared/state'
import { insertItem } from '../../shared/tree'
import { fallbackTitle } from '../../shared/url'
import { makeTab } from '../tabs/model'

/** An import holding more items than this shows its folder collapsed (IM-05). */
export const COLLAPSE_OVER = 1000

export interface PlacedFolder {
  /** The new top folder ('' when nothing was added). */
  folderId: FolderId
  tabIds: TabId[]
  folderIds: FolderId[]
  /** Bookmarks left out, by reason. */
  skipped: Map<string, number>
}

/** The name, or "name (2)", "name (3)"… when a top-level pinned folder of the Space has it (IM-15). */
export function freeFolderName(state: OrbitState, spaceId: SpaceId, base: string): string {
  const taken = new Set((state.spaces[spaceId]?.pinned ?? []).map((id) => state.folders[id]?.name))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base} (${n})`)) return `${base} (${n})`
}

/** One step of placing an import, in order: a folder or a pinned tab, under its parent's key. */
export type PlaceStep =
  | { kind: 'folder'; key: number; parent: number; name: string }
  | { kind: 'tab'; parent: number; url: string; title: string }

/** Where an import's bookmarks go, worked out before anything is added. */
export interface Placement {
  /** The new top folder (key 0, parent -1) first, then folders and tabs in the file's order. */
  steps: PlaceStep[]
  tabs: number
  folders: number
  /** Bookmarks left out, by reason. */
  skipped: Map<string, number>
}

/** Plans folder `name` holding `nodes` (IM-05). Bookmarks that can't be pinned tabs are only counted. */
export function planPlacement(name: string, nodes: readonly BookmarkNode[]): Placement {
  const plan: Placement = {
    steps: [{ kind: 'folder', key: 0, parent: -1, name }],
    tabs: 0,
    folders: 0,
    skipped: new Map(),
  }
  let keys = 0
  const walk = (list: readonly BookmarkNode[], parent: number) => {
    for (const node of list) {
      if (node.children) {
        const key = ++keys
        plan.steps.push({ kind: 'folder', key, parent, name: node.title.trim().slice(0, 200) || 'Untitled folder' })
        plan.folders++
        walk(node.children, key)
      } else if (node.url) {
        if (node.skip) {
          plan.skipped.set(node.skip, (plan.skipped.get(node.skip) ?? 0) + 1)
          continue
        }
        plan.steps.push({
          kind: 'tab',
          parent,
          url: node.url,
          title: node.title.trim().slice(0, 400) || fallbackTitle(node.url),
        })
        plan.tabs++
      }
    }
  }
  walk(nodes, 0)
  return plan
}

/**
 * Adds steps `from` to `to` of a plan to the draft: the top folder at the end of the Space's pinned
 * section, the rest at the end of their parent folder. Large imports go in several store updates, so
 * no single one holds up the windows (IM-14). Tabs are asleep, have no favicon (it comes when the
 * page first loads) and count as never used. Returns false once there is nowhere left to add to
 * (the Space or the new folder was deleted part-way). Draft helper.
 */
export function applyPlacement(
  d: OrbitState,
  spaceId: SpaceId,
  plan: Placement,
  from: number,
  to: number,
  placed: PlacedFolder,
  ids: Map<number, FolderId>,
  now: number,
): boolean {
  const space = d.spaces[spaceId]
  if (!space || (placed.folderId && !d.folders[placed.folderId])) return false
  for (const step of plan.steps.slice(from, to)) {
    if (step.kind === 'folder' && step.parent === -1) {
      // Sub-folders start closed; the top folder too when it holds more than COLLAPSE_OVER items.
      const root: Folder = {
        id: newId('f'),
        name: step.name,
        children: [],
        collapsed: plan.tabs + plan.folders > COLLAPSE_OVER,
        createdAt: now,
      }
      d.folders[root.id] = root
      insertItem(d, { kind: 'pinned', spaceId }, space.pinned.length, root.id)
      ids.set(0, root.id)
      placed.folderId = root.id
      placed.folderIds.push(root.id)
      continue
    }
    // A folder deleted part-way: what was to go in it is left out.
    const parent = d.folders[ids.get(step.parent) ?? '']
    if (!parent) continue
    if (step.kind === 'folder') {
      const folder: Folder = { id: newId('f'), name: step.name, children: [], collapsed: true, createdAt: now }
      d.folders[folder.id] = folder
      parent.children.push(folder.id)
      ids.set(step.key, folder.id)
      placed.folderIds.push(folder.id)
    } else {
      const tab: Tab = makeTab(
        {
          spaceId,
          profileId: space.profileId,
          url: step.url,
          title: step.title,
          pinnedUrl: step.url,
          pinnedResolvedUrl: step.url,
          pinnedTitle: step.title,
          createdAt: now,
          // Never used in Orbit: recent-tab lists and Ctrl+Tab don't fill up with them.
          lastActiveAt: 0,
        },
        now,
      )
      // Frozen first, as Immer advises for data added in bulk: it then skips walking each new tab.
      d.tabs[tab.id] = freeze(tab)
      parent.children.push(tab.id)
      placed.tabIds.push(tab.id)
    }
  }
  return true
}

/**
 * Adds folder `name` with `nodes` to the end of the Space's pinned section in one go (IM-05). When
 * every bookmark is left out, nothing is added, not even an empty folder. Draft helper.
 */
export function placeBookmarks(
  d: OrbitState,
  spaceId: SpaceId,
  name: string,
  nodes: readonly BookmarkNode[],
  now: number,
): PlacedFolder | undefined {
  if (!d.spaces[spaceId]) return undefined
  const plan = planPlacement(name, nodes)
  const placed: PlacedFolder = { folderId: '', tabIds: [], folderIds: [], skipped: plan.skipped }
  if (plan.tabs === 0) return placed
  applyPlacement(d, spaceId, plan, 0, plan.steps.length, placed, new Map(), now)
  return placed
}

/** Reasons for left-out bookmarks, as summary lines. */
export function skippedLines(skipped: Map<string, number>): { what: string; count: number; reason: string }[] {
  return [...skipped].map(([reason, count]) => ({ what: count === 1 ? 'bookmark' : 'bookmarks', count, reason }))
}
