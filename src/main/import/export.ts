import type { ItemId, OrbitState, ProfileId } from '../../shared/state'
import { splitLeaves } from '../../shared/tree'
import type { ExportNode } from './netscape'

/** Addresses another browser can open: web pages and files. */
const OPENABLE = /^(https?|file|ftp):/i

/**
 * Orbit's pinned items as a bookmarks tree (IM-17): the Favorites first, as a folder, then each
 * Space as a folder of its pinned section, with its folders nested as they are. Today's tabs only
 * when asked, as a "Today" folder in their Space. Private windows' profiles are left out.
 */
export function pinnedExport(
  state: OrbitState,
  opts: { profileId?: ProfileId; includeToday?: boolean } = {},
): ExportNode[] {
  const profiles = Object.values(state.profiles).filter(
    (p) => p.partition.startsWith('persist:') && (!opts.profileId || p.id === opts.profileId),
  )
  const out: ExportNode[] = []
  for (const p of profiles) {
    const favorites = exportItems(state, p.favorites)
    const title = profiles.length > 1 ? `Favorites (${p.name})` : 'Favorites'
    if (favorites.length) out.push({ title, children: favorites })
  }
  for (const id of state.spaceOrder) {
    const space = state.spaces[id]
    if (!space || !profiles.some((p) => p.id === space.profileId)) continue
    const children = exportItems(state, space.pinned)
    const today = opts.includeToday ? exportItems(state, space.today) : []
    if (today.length) children.push({ title: 'Today', children: today })
    out.push({ title: space.name, children, addDate: space.createdAt })
  }
  return out
}

/** Folders keep their nesting; a split's tabs stand in its place; a tab is its pinned address. */
function exportItems(state: OrbitState, ids: readonly ItemId[]): ExportNode[] {
  return ids.flatMap((id): ExportNode[] => {
    const folder = state.folders[id]
    if (folder)
      return [{ title: folder.name, children: exportItems(state, folder.children), addDate: folder.createdAt }]
    const split = state.splits[id]
    if (split) return exportItems(state, splitLeaves(split.layout))
    const tab = state.tabs[id]
    const url = tab?.pinnedUrl ?? tab?.url ?? ''
    if (!tab || !OPENABLE.test(url)) return []
    return [{ title: tab.customTitle || tab.pinnedTitle || tab.title || url, url, addDate: tab.createdAt }]
  })
}
