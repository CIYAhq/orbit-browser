/**
 * Imported bookmarks become pinned items (IM-05): one new pinned folder at the end of the target
 * Space's pinned section, holding a pinned tab per bookmark and a sub-folder per bookmark folder,
 * in their order. Pure state helpers (draft in, ids out), unit-tested directly.
 */
import { freeze } from 'immer'
import type { BookmarkNode } from '../../shared/commands/import'
import { newId } from '../../shared/ids'
import type { Folder, FolderId, OrbitState, ProfileId, SpaceId, Tab, TabId } from '../../shared/state'
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

/**
 * Plans folder `name` holding `nodes` (IM-05). Bookmarks that can't be pinned tabs are only counted,
 * and a folder with no tab under it (one that held only those) isn't added (F3).
 */
export function planPlacement(name: string, nodes: readonly BookmarkNode[]): Placement {
  const plan: Placement = {
    steps: [{ kind: 'folder', key: 0, parent: -1, name }],
    tabs: 0,
    folders: 0,
    skipped: new Map(),
  }
  const empty = new Set<PlaceStep>()
  let keys = 0
  /** Plans `list` into folder `parent`; returns how many tabs it holds. */
  const walk = (list: readonly BookmarkNode[], parent: number): number => {
    let tabs = 0
    for (const node of list) {
      if (node.children) {
        const key = ++keys
        const step: PlaceStep = {
          kind: 'folder',
          key,
          parent,
          name: node.title.trim().slice(0, 200) || 'Untitled folder',
        }
        plan.steps.push(step)
        const inside = walk(node.children, key)
        if (inside === 0) empty.add(step)
        else plan.folders++
        tabs += inside
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
        tabs++
      }
    }
    return tabs
  }
  walk(nodes, 0)
  // A folder with no tab under it has only such folders under it: they all go.
  if (empty.size > 0) plan.steps = plan.steps.filter((step) => !empty.has(step))
  return plan
}

/**
 * One Space's folder of an import, made out of sight (D62 (3)). `build` makes the plan's steps a part at a time, and
 * each part's tabs go into the state where no section shows them (`addUnplacedTabs`); `attachFolders` then adds the
 * folders and shows the whole folder at once. Until then the sidebar shows none of it, so nothing can be moved into or
 * out of it, and a quit or a failure takes back exactly the tabs added. Tabs are asleep, have no favicon (it comes when
 * the page first loads) and count as never used.
 */
export class DetachedFolder {
  /** The top folder first, then its folders in the plan's order. */
  readonly folders: Folder[] = []
  readonly tabs: Tab[] = []
  private readonly byKey = new Map<number, Folder>()
  private made = 0

  constructor(
    private readonly plan: Placement,
    readonly spaceId: SpaceId,
    /** The profile its tabs are made in: the Space's when the import started. */
    readonly profileId: ProfileId,
    private readonly now: number,
  ) {}

  /** Every step is made. */
  get whole(): boolean {
    return this.made >= this.plan.steps.length
  }

  /** The tabs it holds when whole. */
  get total(): number {
    return this.plan.tabs
  }

  /** Makes steps until `tabs` more tabs are made, or the plan ends; returns those tabs. */
  build(tabs: number): Tab[] {
    const { plan, now } = this
    const out: Tab[] = []
    for (; this.made < plan.steps.length && out.length < tabs; this.made++) {
      const step = plan.steps[this.made] as PlaceStep
      if (step.kind === 'folder') {
        // Sub-folders start closed; the top folder too when it holds more than COLLAPSE_OVER items.
        const top = step.parent === -1
        const folder: Folder = {
          id: newId('f'),
          name: step.name,
          children: [],
          collapsed: top ? plan.tabs + plan.folders > COLLAPSE_OVER : true,
          createdAt: now,
        }
        this.folders.push(folder)
        this.byKey.set(step.key, folder)
        if (!top) this.byKey.get(step.parent)?.children.push(folder.id)
        continue
      }
      const tab: Tab = makeTab(
        {
          spaceId: this.spaceId,
          profileId: this.profileId,
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
      out.push(tab)
      this.byKey.get(step.parent)?.children.push(tab.id)
    }
    this.tabs.push(...out)
    return out
  }

  /** Leaves out tabs no longer in the state (Restore Data while it was made, say); returns how many are left. */
  keepOnly(present: (id: TabId) => boolean): number {
    const gone = new Set(this.tabs.filter((t) => !present(t.id)).map((t) => t.id))
    if (gone.size > 0) {
      for (const f of this.folders) f.children = f.children.filter((id) => !gone.has(id))
      this.tabs.splice(0, this.tabs.length, ...this.tabs.filter((t) => !gone.has(t.id)))
    }
    return this.tabs.length
  }
}

/** Adds tabs an import made where no section shows them, frozen first (Immer then skips walking each one). Draft helper. */
export function addUnplacedTabs(d: OrbitState, tabs: readonly Tab[]): void {
  for (const t of tabs) d.tabs[t.id] = freeze(t)
}

/**
 * Shows whole folders at once (D62 (3)): each one's folders are added, its top folder named `names[i]` and put at the
 * end of its Space's pinned section. Their tabs are in the state already (`addUnplacedTabs`). A Space deleted meanwhile
 * gets nothing. Returns the folders shown. Draft helper.
 */
export function attachFolders(
  d: OrbitState,
  built: readonly DetachedFolder[],
  names: readonly string[],
): { folderId: FolderId; spaceId: SpaceId; tabs: number }[] {
  const added: { folderId: FolderId; spaceId: SpaceId; tabs: number }[] = []
  built.forEach((b, i) => {
    const space = d.spaces[b.spaceId]
    const root = b.folders[0]
    if (!space || !root || !b.whole || b.tabs.length === 0) return
    root.name = names[i] ?? root.name
    for (const f of b.folders) d.folders[f.id] = freeze(f)
    // The Space moved to another profile meanwhile (PR-03): its new tabs go with it.
    if (space.profileId !== b.profileId) {
      for (const t of b.tabs) {
        const tab = d.tabs[t.id]
        if (tab) tab.profileId = space.profileId
      }
    }
    insertItem(d, { kind: 'pinned', spaceId: b.spaceId }, space.pinned.length, root.id)
    added.push({ folderId: root.id, spaceId: b.spaceId, tabs: b.tabs.length })
  })
  return added
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
  const space = d.spaces[spaceId]
  if (!space) return undefined
  const plan = planPlacement(name, nodes)
  const placed: PlacedFolder = { folderId: '', tabIds: [], folderIds: [], skipped: plan.skipped }
  if (plan.tabs === 0) return placed
  const folder = new DetachedFolder(plan, spaceId, space.profileId, now)
  addUnplacedTabs(d, folder.build(plan.tabs))
  attachFolders(d, [folder], [name])
  placed.folderId = folder.folders[0]?.id ?? ''
  placed.folderIds = folder.folders.map((f) => f.id)
  placed.tabIds = folder.tabs.map((t) => t.id)
  return placed
}

/** Reasons for left-out bookmarks (or links), as summary lines. */
export function skippedLines(
  skipped: Map<string, number>,
  [one, many]: readonly [string, string] = ['bookmark', 'bookmarks'],
): { what: string; count: number; reason: string }[] {
  return [...skipped].map(([reason, count]) => ({ what: count === 1 ? one : many, count, reason }))
}
