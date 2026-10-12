import { newId } from '../../shared/ids'
import { GUIDE_URL, HELP_URL } from '../../shared/project'
import type { Folder, FolderId, OrbitState, SpaceId } from '../../shared/state'
import { insertItem } from '../../shared/tree'
import { makeTab } from '../tabs/model'

/** The first window's small pinned folder of help pages and tips (OB-09). */
export const BASICS_FOLDER_NAME = 'Orbit basics'

/** What it holds: Orbit's own getting-started guide (OB-10) and help (OB-13). */
export const BASICS_PAGES: readonly { url: string; title: string }[] = [
  { url: GUIDE_URL, title: 'Getting Started' },
  { url: HELP_URL, title: 'Orbit Help' },
]

/**
 * Puts the "Orbit basics" folder at the top of a Space's pinned section (OB-09), open, its pages
 * unloaded until first opened, as an import's are. Pinned items an import adds go below it. Draft
 * helper; returns the folder, or undefined when the Space is gone.
 */
export function addOrbitBasics(d: OrbitState, spaceId: SpaceId, now = Date.now()): FolderId | undefined {
  const space = d.spaces[spaceId]
  if (!space) return undefined
  const folder: Folder = { id: newId('f'), name: BASICS_FOLDER_NAME, children: [], collapsed: false, createdAt: now }
  for (const page of BASICS_PAGES) {
    const tab = makeTab(
      {
        spaceId,
        profileId: space.profileId,
        url: page.url,
        title: page.title,
        pinnedUrl: page.url,
        pinnedResolvedUrl: page.url,
        pinnedTitle: page.title,
        createdAt: now,
        // Not used yet: recent-tab lists and Ctrl+Tab don't start with them.
        lastActiveAt: 0,
      },
      now,
    )
    d.tabs[tab.id] = tab
    folder.children.push(tab.id)
  }
  d.folders[folder.id] = folder
  insertItem(d, { kind: 'pinned', spaceId }, 0, folder.id)
  return folder.id
}
