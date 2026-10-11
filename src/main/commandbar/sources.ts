/**
 * Search documents derived from OrbitState for the ranking engine. Everything
 * is cached by object identity (Immer structural sharing): a keystroke reuses
 * the previous documents, and a state change only rebuilds what changed.
 */
import { ACTIONS, formatAccelerator, shortcutsFor } from '../../shared/actions'
import { isFolderId, isSplitId, isTabId } from '../../shared/ids'
import type { ArchivedTab, FolderId, ItemId, OrbitState, ProfileId, SpaceId, Tab, TabId } from '../../shared/state'
import { splitLeaves } from '../../shared/tree'
import { type ArchiveSource, archiveSource } from '../archive/inbox'
import { hostOf, urlKeyOf } from '../history/store'
import { isUnplacedImportTab, unplacedImportVersion } from '../import/unplaced'
import { initials } from './match'
import type { ActionDoc, ArchiveDoc, FolderDoc, SpaceDoc, TabDoc } from './rank'

type Section = 'favorite' | 'pinned' | 'today'

interface Layout {
  section: Map<TabId, Section>
  split: Map<TabId, TabId[]>
  folders: FolderDoc[]
}

/** Archived tabs the bar ranks per profile, newest first (main's cap before the Archive store). */
export const ARCHIVE_DOCS_MAX = 5000

/** Actions the bar never lists (they open the bar itself). */
const NOT_IN_BAR = new Set(['tab.new', 'url.edit'])
/** Actions that work without a current tab even though their id says otherwise. */
const NO_TAB_NEEDED = new Set([
  'tab.reopenClosed',
  'tab.next',
  'tab.previous',
  'tab.recent',
  'tab.recentBack',
  'tab.pasteAsNewTab',
  'tab.undo',
])

export function actionNeedsTab(id: string, category: string): boolean {
  if (NO_TAB_NEEDED.has(id)) return false
  return (
    category === 'Page' ||
    category === 'Developer' ||
    id.startsWith('tab.') ||
    id.startsWith('nav.') ||
    id.startsWith('split.')
  )
}

export class SourceCache {
  private layoutRefs: unknown[] = []
  private layout: Layout = { section: new Map(), split: new Map(), folders: [] }
  private tabDocCache = new WeakMap<Tab, TabDoc>()
  private tabsRef: unknown[] = []
  private tabDocs: TabDoc[] = []
  private archiveRef: { list?: ArchivedTab[]; source?: ArchiveSource; version?: number; profileId?: ProfileId } = {}
  private archiveDocs: ArchiveDoc[] = []
  private spacesRef: unknown[] = []
  private spaceDocs: SpaceDoc[] = []
  private names: Record<SpaceId, string> = {}
  private actionDocs: ActionDoc[] | undefined

  /**
   * Every tab in every Space (pinned, Favorites, Today, folders, splits), and a Peek's or a mini window's. Not an import's
   * tabs that no section shows yet: nothing may reach them until their folder is shown (D65 (1)).
   */
  tabs(state: OrbitState): TabDoc[] {
    const layout = this.layoutOf(state)
    const refs = [state.tabs, layout, unplacedImportVersion()]
    if (sameRefs(refs, this.tabsRef)) return this.tabDocs
    this.tabsRef = refs
    const docs: TabDoc[] = []
    for (const tab of Object.values(state.tabs)) {
      if (isUnplacedImportTab(tab.id) && !layout.section.has(tab.id)) continue
      let doc = this.tabDocCache.get(tab)
      if (!doc) {
        doc = makeTabDoc(tab, layout.section.get(tab.id))
        this.tabDocCache.set(tab, doc)
      }
      const leaves = layout.split.get(tab.id)
      if (leaves) {
        doc = { ...doc, splitFavicons: leaves.map((id) => state.tabs[id]?.favicon ?? null) }
      }
      docs.push(doc)
    }
    this.tabDocs = docs
    return docs
  }

  /**
   * Archived tabs of one profile, newest first so ties go to the most recent entry (CB-05 item 3):
   * the whole Archive (AR-04), up to ARCHIVE_DOCS_MAX. `state.archive` only holds the recent ones;
   * it is the source until the Archive log has been read.
   */
  archive(state: OrbitState, profileId: ProfileId): ArchiveDoc[] {
    const source = archiveSource()
    if (source?.ready) {
      const ref = this.archiveRef
      if (ref.source === source && ref.version === source.version && ref.profileId === profileId)
        return this.archiveDocs
      this.archiveRef = { source, version: source.version, profileId }
      const docs: ArchiveDoc[] = []
      for (const { e, titleLower, urlKey } of source.newestFirst(profileId)) {
        if (!e.url || e.url === 'about:blank') continue
        docs.push({
          id: e.id,
          title: e.title,
          url: e.url,
          spaceId: e.spaceId,
          archivedAt: e.archivedAt,
          titleLower,
          urlKey,
        })
        if (docs.length >= ARCHIVE_DOCS_MAX) break
      }
      this.archiveDocs = docs
      return docs
    }
    if (this.archiveRef.list === state.archive && this.archiveRef.profileId === profileId) return this.archiveDocs
    this.archiveRef = { list: state.archive, profileId }
    // The archive is oldest-first; newest first here so ties go to the most recent entry.
    this.archiveDocs = [...state.archive]
      .reverse()
      .filter((a) => a.profileId === profileId && a.url && a.url !== 'about:blank')
      .map((a) => ({
        id: a.id,
        title: a.title,
        url: a.url,
        favicon: a.favicon,
        spaceId: a.spaceId,
        archivedAt: a.archivedAt,
        titleLower: a.title.toLowerCase(),
        urlKey: urlKeyOf(a.url),
      }))
    return this.archiveDocs
  }

  /** Folders by name, with the Space that shows them (FD-09 "Open [Folder]"). */
  folders(state: OrbitState): FolderDoc[] {
    return this.layoutOf(state).folders
  }

  spaces(state: OrbitState): SpaceDoc[] {
    this.refreshSpaces(state)
    return this.spaceDocs
  }

  spaceNames(state: OrbitState): Record<SpaceId, string> {
    this.refreshSpaces(state)
    return this.names
  }

  /** Visible actions that have a handler, with their shortcut for this platform (CB-13). */
  actions(has: (id: string) => boolean, platform: string): ActionDoc[] {
    if (this.actionDocs) return this.actionDocs
    this.actionDocs = ACTIONS.filter((a) => !a.hidden && !NOT_IN_BAR.has(a.id) && has(a.id)).map((a) => {
      const accel = shortcutsFor(a, platform)[0]
      const titleLower = a.title.toLowerCase()
      return {
        id: a.id,
        title: a.title,
        ...(accel ? { shortcut: formatAccelerator(accel, platform) } : {}),
        titleLower,
        keywords: [a.category.toLowerCase(), ...(a.keywords ?? []).map((k) => k.toLowerCase())],
        initials: initials(titleLower),
        needsTab: actionNeedsTab(a.id, a.category),
      }
    })
    return this.actionDocs
  }

  private refreshSpaces(state: OrbitState): void {
    const refs = [state.spaces, state.spaceOrder]
    if (sameRefs(refs, this.spacesRef)) return
    this.spacesRef = refs
    this.spaceDocs = []
    this.names = {}
    for (const id of state.spaceOrder) {
      const s = state.spaces[id]
      if (!s) continue
      this.names[id] = s.name
      this.spaceDocs.push({ id, name: s.name, icon: s.icon, nameLower: s.name.toLowerCase() })
    }
  }

  private layoutOf(state: OrbitState): Layout {
    const refs = [state.profiles, state.spaces, state.folders, state.splits]
    if (sameRefs(refs, this.layoutRefs)) return this.layout
    this.layoutRefs = refs
    const section = new Map<TabId, Section>()
    const split = new Map<TabId, TabId[]>()
    const folders: FolderDoc[] = []
    const seenFolders = new Set<FolderId>()
    const visit = (id: ItemId, sec: Section, depth: number, spaceId?: SpaceId) => {
      if (depth > 32) return
      if (isTabId(id)) section.set(id, sec)
      else if (isFolderId(id)) {
        const folder = state.folders[id]
        if (!folder) return
        if (!seenFolders.has(id)) {
          seenFolders.add(id)
          folders.push({ id, name: folder.name, nameLower: folder.name.toLowerCase(), spaceId })
        }
        for (const child of folder.children) visit(child, sec, depth + 1, spaceId)
      } else if (isSplitId(id)) {
        const s = state.splits[id]
        if (!s) return
        const leaves = splitLeaves(s.layout)
        for (const tabId of leaves) {
          section.set(tabId, sec)
          split.set(tabId, leaves)
        }
      }
    }
    for (const p of Object.values(state.profiles)) for (const id of p.favorites) visit(id, 'favorite', 0)
    for (const s of Object.values(state.spaces)) {
      for (const id of s.pinned) visit(id, 'pinned', 0, s.id)
      for (const id of s.today) visit(id, 'today', 0, s.id)
    }
    this.layout = { section, split, folders }
    // Section is part of each cached doc: start over.
    this.tabDocCache = new WeakMap()
    return this.layout
  }
}

function makeTabDoc(tab: Tab, section: Section | undefined): TabDoc {
  const title = tab.customTitle ?? tab.title
  const pinnedKey = tab.pinnedUrl && tab.pinnedUrl !== tab.url ? urlKeyOf(tab.pinnedUrl) : undefined
  return {
    id: tab.id,
    title,
    url: tab.url,
    favicon: tab.favicon,
    spaceId: tab.spaceId,
    lastActiveAt: tab.lastActiveAt,
    section,
    titleLower: title.toLowerCase(),
    urlKey: tab.url === 'about:blank' ? '' : urlKeyOf(tab.url),
    ...(pinnedKey ? { pinnedKey } : {}),
    host: hostOf(tab.url)?.host ?? '',
  }
}

function sameRefs(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}
