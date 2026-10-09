/**
 * Sidebar context menus (TB-14, FV-07, FD-09). Pure template builders: they take the
 * state and a set of callbacks and return Electron menu templates (types only), so
 * the item set per tab type is unit-testable.
 */
import type { MenuItemConstructorOptions } from 'electron'
import { isFolderId } from '../../shared/ids'
import type { ContainerRef, FolderId, ItemId, OrbitState, SpaceId, TabId } from '../../shared/state'
import { isAwayFromPinned } from '../../shared/tabs'
import { sectionOf, splitOfTab, tabsInItem } from '../../shared/tree'

export interface MenuOps {
  rename(id: ItemId): void
  changeIcon(id: ItemId): void
  copyLinks(tabIds: TabId[], markdown: boolean): void
  duplicate(tabId: TabId): void
  setMuted(tabId: TabId, muted: boolean): void
  moveTo(ids: ItemId[], to: ContainerRef): void
  pin(tabIds: TabId[]): void
  unpin(tabIds: TabId[]): void
  favorite(tabId: TabId): void
  archiveBelow(tabId: TabId): void
  resetToPinned(tabId: TabId): void
  replacePinnedUrl(tabId: TabId): void
  editPinnedUrl(tabId: TabId): void
  close(tabIds: TabId[]): void
  remove(id: ItemId): void
  newFolder(items: ItemId[]): void
  setCollapsed(folderId: FolderId, collapsed: boolean): void
  duplicateFolder(folderId: FolderId): void
  pasteUrlInto(folderId: FolderId): void
  deleteFolder(folderId: FolderId): void
}

/** Folders of a Space's pinned area, depth-first, with indentation for the Move to menu. */
function foldersOf(state: OrbitState, spaceId: SpaceId): { id: FolderId; label: string }[] {
  const out: { id: FolderId; label: string }[] = []
  const walk = (items: ItemId[], depth: number) => {
    for (const id of items) {
      if (!isFolderId(id)) continue
      const folder = state.folders[id]
      if (!folder) continue
      out.push({ id, label: `${'    '.repeat(depth)}${folder.name}` })
      walk(folder.children, depth + 1)
    }
  }
  walk(state.spaces[spaceId]?.pinned ?? [], 0)
  return out
}

/** "Move to ▸" submenu: Favorites, then each Space with Pinned, Today and its folders (TB-11). */
export function moveToMenu(
  state: OrbitState,
  ids: ItemId[],
  ops: MenuOps,
  opts: { favoritesProfileId?: string; excludeFolder?: FolderId } = {},
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []
  const hasFolder = ids.some(isFolderId)
  if (opts.favoritesProfileId && !hasFolder) {
    items.push({
      label: 'Favorites',
      click: () => ops.moveTo(ids, { kind: 'favorites', profileId: opts.favoritesProfileId as string }),
    })
    items.push({ type: 'separator' })
  }
  for (const spaceId of state.spaceOrder) {
    const space = state.spaces[spaceId]
    if (!space) continue
    const submenu: MenuItemConstructorOptions[] = [
      { label: 'Pinned', click: () => ops.moveTo(ids, { kind: 'pinned', spaceId }) },
    ]
    if (!hasFolder) submenu.push({ label: 'Today', click: () => ops.moveTo(ids, { kind: 'today', spaceId }) })
    const folders = foldersOf(state, spaceId).filter((f) => f.id !== opts.excludeFolder && !ids.includes(f.id))
    if (folders.length > 0) {
      submenu.push({ type: 'separator' })
      for (const f of folders)
        submenu.push({ label: f.label, click: () => ops.moveTo(ids, { kind: 'folder', folderId: f.id }) })
    }
    items.push({ label: space.name || 'Space', submenu })
  }
  return items
}

/** Right-click menu for one tab, or for the multi-selection it belongs to (TB-13, TB-14). */
export function tabMenu(
  state: OrbitState,
  tabId: TabId,
  selection: TabId[],
  ops: MenuOps,
): MenuItemConstructorOptions[] {
  const tab = state.tabs[tabId]
  if (!tab) return []
  const multi = selection.length > 1 && selection.includes(tabId) ? selection.filter((id) => state.tabs[id]) : [tabId]
  const profileId = state.spaces[tab.spaceId]?.profileId ?? tab.profileId
  if (multi.length > 1) {
    const sections = new Set(multi.map((id) => sectionOf(state, id)))
    const items: MenuItemConstructorOptions[] = []
    if (sections.has('today')) items.push({ label: `Pin ${multi.length} Tabs`, click: () => ops.pin(multi) })
    if (sections.has('pinned') && !sections.has('today'))
      items.push({ label: `Unpin ${multi.length} Tabs`, click: () => ops.unpin(multi) })
    items.push(
      { label: 'New Folder with Tabs', click: () => ops.newFolder(multi.map((id) => splitOfTab(state, id) ?? id)) },
      { label: 'Copy Links', click: () => ops.copyLinks(multi, false) },
      { label: 'Copy Links as Markdown', click: () => ops.copyLinks(multi, true) },
      { type: 'separator' },
      { label: 'Move to', submenu: moveToMenu(state, multi, ops, { favoritesProfileId: profileId }) },
      { type: 'separator' },
      { label: `Close ${multi.length} Tabs`, click: () => ops.close(multi) },
    )
    return items
  }
  const section = sectionOf(state, tabId)
  const item = splitOfTab(state, tabId) ?? tabId
  const items: MenuItemConstructorOptions[] = []
  if (section === 'today') {
    items.push(
      { label: 'Pin Tab', click: () => ops.pin([tabId]) },
      { label: 'Add to Favorites', click: () => ops.favorite(tabId) },
      { type: 'separator' },
    )
  } else if (section === 'pinned' || section === 'favorite') {
    items.push(
      section === 'favorite'
        ? { label: 'Remove from Favorites', click: () => ops.unpin([tabId]) }
        : { label: 'Unpin Tab', click: () => ops.unpin([tabId]) },
      { label: 'Reset to Pinned URL', enabled: isAwayFromPinned(tab), click: () => ops.resetToPinned(tabId) },
      {
        label: 'Pinned URL',
        submenu: [
          {
            label: 'Replace with Current URL',
            enabled: isAwayFromPinned(tab),
            click: () => ops.replacePinnedUrl(tabId),
          },
          { label: 'Edit…', click: () => ops.editPinnedUrl(tabId) },
        ],
      },
      { type: 'separator' },
    )
  }
  items.push(
    { label: 'Rename…', click: () => ops.rename(tabId) },
    { label: 'Change Icon…', click: () => ops.changeIcon(tabId) },
    { type: 'separator' },
    { label: 'Copy Link', click: () => ops.copyLinks([tabId], false) },
    { label: 'Copy Link as Markdown', click: () => ops.copyLinks([tabId], true) },
    { label: 'Duplicate', click: () => ops.duplicate(tabId) },
    { label: tab.muted ? 'Unmute Tab' : 'Mute Tab', click: () => ops.setMuted(tabId, !tab.muted) },
    {
      label: 'Move to',
      submenu: moveToMenu(state, [item], ops, { favoritesProfileId: section === 'favorite' ? undefined : profileId }),
    },
  )
  if (section === 'today') {
    const space = state.spaces[tab.spaceId]
    const index = space?.today.indexOf(item) ?? -1
    items.push({
      label: 'Archive Tabs Below',
      enabled: !!space && index >= 0 && index < space.today.length - 1,
      click: () => ops.archiveBelow(tabId),
    })
  }
  items.push({ type: 'separator' })
  if (section === 'pinned' || section === 'favorite') {
    items.push(
      { label: 'Close Tab', enabled: !tab.asleep, click: () => ops.close([tabId]) },
      {
        label: section === 'favorite' ? 'Delete Favorite' : 'Delete from Sidebar',
        click: () => ops.remove(tabId),
      },
    )
  } else {
    items.push({ label: 'Close Tab', click: () => ops.close([tabId]) })
  }
  return items
}

/** Right-click menu for a folder (FD-09). */
export function folderMenu(state: OrbitState, folderId: FolderId, ops: MenuOps): MenuItemConstructorOptions[] {
  const folder = state.folders[folderId]
  if (!folder) return []
  const tabs = tabsInItem(state, folderId)
  return [
    { label: 'Rename…', click: () => ops.rename(folderId) },
    { label: 'Change Icon…', click: () => ops.changeIcon(folderId) },
    {
      label: folder.collapsed ? 'Expand Folder' : 'Collapse Folder',
      click: () => ops.setCollapsed(folderId, !folder.collapsed),
    },
    { type: 'separator' },
    { label: 'Duplicate Folder', click: () => ops.duplicateFolder(folderId) },
    { label: 'Copy All Links', enabled: tabs.length > 0, click: () => ops.copyLinks(tabs, false) },
    { label: 'Paste URL as New Tab', click: () => ops.pasteUrlInto(folderId) },
    { type: 'separator' },
    { label: 'Move to', submenu: moveToMenu(state, [folderId], ops, { excludeFolder: folderId }) },
    { type: 'separator' },
    { label: 'Delete Folder…', click: () => ops.deleteFolder(folderId) },
  ]
}

/** Labels of a menu template (for tests and debugging), submenus as "Parent > Child". */
export function menuLabels(items: MenuItemConstructorOptions[], prefix = ''): string[] {
  const out: string[] = []
  for (const item of items) {
    if (item.type === 'separator' || !item.label) continue
    out.push(`${prefix}${item.label}`)
    if (Array.isArray(item.submenu)) out.push(...menuLabels(item.submenu, `${prefix}${item.label} > `))
  }
  return out
}

/** Finds an item by its label path ("Move to > Work > Pinned"). */
export function findMenuItem(
  items: MenuItemConstructorOptions[],
  path: string,
): MenuItemConstructorOptions | undefined {
  const [head, ...rest] = path.split(' > ')
  const item = items.find((i) => i.label === head)
  if (!item || rest.length === 0) return item
  return Array.isArray(item.submenu) ? findMenuItem(item.submenu, rest.join(' > ')) : undefined
}
