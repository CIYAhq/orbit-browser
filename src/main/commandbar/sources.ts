/**
 * Search documents derived from OrbitState for the ranking engine. Everything
 * is cached by object identity (Immer structural sharing): a keystroke reuses
 * the previous documents, and a state change only rebuilds what changed.
 */
import { ACTIONS, formatAccelerator, shortcutsFor } from '../../shared/actions'
import { isFolderId, isSplitId, isTabId } from '../../shared/ids'
import type { ArchivedTab, ItemId, OrbitState, ProfileId, SpaceId, Tab, TabId } from '../../shared/state'
import { splitLeaves } from '../../shared/tree'
import { hostOf, urlKeyOf } from '../history/store'
import { initials } from './match'
import type { ActionDoc, ArchiveDoc, SpaceDoc, TabDoc } from './rank'

type Section = 'favorite' | 'pinned' | 'today'

interface Layout {
  section: Map<TabId, Section>
  split: Map<TabId, TabId[]>
}

/** Actions the bar never lists (they open the bar itself). */
const NOT_IN_BAR = new Set(['tab.new', 'url.edit'])
/** Actions that work without a current tab even though their id says otherwise. */
const NO_TAB_NEEDED = new Set(['tab.reopenClosed', 'tab.next', 'tab.previous'])

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
  private layout: Layout = { section: new Map(), split: new Map() }
  private tabDocCache = new WeakMap<Tab, TabDoc>()
  private tabsRef: unknown[] = []
  private tabDocs: TabDoc[] = []
  private archiveRef: { list?: ArchivedTab[]; profileId?: ProfileId } = {}
  private archiveDocs: ArchiveDoc[] = []
  private spacesRef: unknown[] = []
  private spaceDocs: SpaceDoc[] = []
  private names: Record<SpaceId, string> = {}
  private actionDocs: ActionDoc[] | undefined

  /** Every tab in every Space (pinned, Favorites, Today, folders, splits). */
  tabs(state: OrbitState): TabDoc[] {
    const layout = this.layoutOf(state)
    const refs = [state.tabs, layout]
    if (sameRefs(refs, this.tabsRef)) return this.tabDocs
    this.tabsRef = refs
    const docs: TabDoc[] = []
    for (const tab of Object.values(state.tabs)) {
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

  /** Archived tabs of one profile (CB-05 item 3). */
  archive(state: OrbitState, profileId: ProfileId): ArchiveDoc[] {
    if (this.archiveRef.list === state.archive && this.archiveRef.profileId === profileId) return this.archiveDocs
    this.archiveRef = { list: state.archive, profileId }
    this.archiveDocs = state.archive
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
    const visit = (id: ItemId, sec: Section, depth: number) => {
      if (depth > 32) return
      if (isTabId(id)) section.set(id, sec)
      else if (isFolderId(id)) for (const child of state.folders[id]?.children ?? []) visit(child, sec, depth + 1)
      else if (isSplitId(id)) {
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
      for (const id of s.pinned) visit(id, 'pinned', 0)
      for (const id of s.today) visit(id, 'today', 0)
    }
    this.layout = { section, split }
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
