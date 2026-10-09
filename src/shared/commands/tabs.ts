import type { ContainerRef, FolderId, ItemId, SpaceId, TabId, WindowId } from '../state'

/** Owned by the sidebar/tabs lane. */
export interface TabCommands {
  'tabs.create': {
    args: { url?: string; spaceId?: SpaceId; container?: ContainerRef; index?: number; activate?: boolean }
    result: TabId
  }
  'tabs.activate': { args: { tabId: TabId }; result: void }
  /** Close (TB-06): Today tabs go to the Archive; pinned tabs and Favorites unload and reset. */
  'tabs.close': { args: { tabId?: TabId; tabIds?: TabId[] }; result: void }
  /** Reopen the most recently closed tab with its history (TB-07). */
  'tabs.reopenClosed': { args: Record<string, never>; result: TabId | null }
  /** Undo the last sidebar change (TB-18). Returns what was undone. */
  'tabs.undo': { args: Record<string, never>; result: string | null }
  'tabs.navigate': { args: { tabId: TabId; url: string }; result: void }
  'tabs.back': { args: { tabId: TabId }; result: void }
  'tabs.forward': { args: { tabId: TabId }; result: void }
  'tabs.reload': { args: { tabId: TabId; ignoreCache?: boolean }; result: void }
  'tabs.stop': { args: { tabId: TabId }; result: void }
  /**
   * Move items into a container (TB-08, TB-09, FD-05, FV-03…05). `index` is a position in the
   * target list without the moving items. `ids` moves several (multi-selection) in order.
   */
  'tabs.move': { args: { id: ItemId; ids?: ItemId[]; to: ContainerRef; index: number }; result: boolean }
  /** Move to another Space's pinned or Today section (TB-11). */
  'tabs.moveToSpace': { args: { ids: ItemId[]; spaceId: SpaceId; section: 'pinned' | 'today' }; result: boolean }
  /** Drag a tab out of the window: a new window shows it (TB-09). `x`/`y` are screen coordinates. */
  'tabs.toNewWindow': { args: { tabId: TabId; x?: number; y?: number }; result: WindowId | null }
  /** Pin into the tab's Space, or into `spaceId` ("Pin to [Space]") (PN-02). */
  'tabs.pin': { args: { tabId: TabId; spaceId?: SpaceId }; result: void }
  'tabs.unpin': { args: { tabId: TabId }; result: void }
  /** Add to Favorites; false when the profile already has 12 (FV-02, FV-03). */
  'tabs.favorite': { args: { tabId: TabId }; result: boolean }
  'tabs.unfavorite': { args: { tabId: TabId; section?: 'pinned' | 'today' }; result: boolean }
  /** Back to the pinned URL; `keepCurrent` also opens the current page as a Today tab (PN-04). */
  'tabs.resetToPinned': { args: { tabId: TabId; keepCurrent?: boolean }; result: void }
  /** Pinned URL ▸ Replace with Current (no `url`) or Edit (PN-07). */
  'tabs.setPinnedUrl': { args: { tabId: TabId; url?: string }; result: void }
  'tabs.rename': { args: { tabId: TabId; title: string | null }; result: void }
  'tabs.setIcon': { args: { tabId: TabId; icon: string | null }; result: void }
  /** Remove a pinned item or Favorite from the sidebar (into the Archive) (PN-06). */
  'tabs.delete': { args: { id: ItemId }; result: void }
  'tabs.archiveBelow': { args: { tabId: TabId }; result: void }
  'tabs.copyLinks': { args: { tabIds: TabId[]; markdown?: boolean }; result: string }
  'tabs.duplicate': { args: { tabId: TabId }; result: TabId }
  'tabs.setMuted': { args: { tabId: TabId; muted: boolean }; result: void }
  'tabs.clearToday': { args: { spaceId?: SpaceId }; result: void }
  /** Collapse or expand a Space's pinned section (PN-09). */
  'tabs.setPinnedCollapsed': { args: { spaceId?: SpaceId; collapsed: boolean }; result: void }
  /** Right-click menu for a tab or folder; `selection` is the multi-selection (TB-13, TB-14). */
  'tabs.contextMenu': { args: { id: ItemId; selection?: TabId[] }; result: void }
  /** Give keyboard focus to the window's sidebar (drag cancel with Escape, SB-22). */
  'tabs.focusSidebar': { args: Record<string, never>; result: void }
  /** Return keyboard focus to the selected tab's page (SB-22). */
  'tabs.focusPage': { args: Record<string, never>; result: void }
  'folders.create': {
    args: { container?: ContainerRef; index?: number; name?: string; items?: ItemId[] }
    result: FolderId
  }
  'folders.rename': { args: { folderId: FolderId; name: string }; result: void }
  'folders.setIcon': { args: { folderId: FolderId; icon: string | null }; result: void }
  'folders.setCollapsed': { args: { folderId: FolderId; collapsed: boolean }; result: void }
  /** Delete a folder: contents go to the Archive (FD-10), or stay in place with `keepChildren`. */
  'folders.delete': { args: { folderId: FolderId; keepChildren?: boolean }; result: void }
}
