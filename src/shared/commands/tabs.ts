import type { ContainerRef, FolderId, ItemId, SpaceId, TabId } from '../state'

/** Owned by the sidebar/tabs lane. */
export interface TabCommands {
  'tabs.create': {
    args: { url?: string; spaceId?: SpaceId; container?: ContainerRef; index?: number; activate?: boolean }
    result: TabId
  }
  'tabs.activate': { args: { tabId: TabId }; result: void }
  'tabs.close': { args: { tabId: TabId }; result: void }
  'tabs.navigate': { args: { tabId: TabId; url: string }; result: void }
  'tabs.back': { args: { tabId: TabId }; result: void }
  'tabs.forward': { args: { tabId: TabId }; result: void }
  'tabs.reload': { args: { tabId: TabId; ignoreCache?: boolean }; result: void }
  'tabs.stop': { args: { tabId: TabId }; result: void }
  'tabs.move': { args: { id: ItemId; to: ContainerRef; index: number }; result: boolean }
  'tabs.pin': { args: { tabId: TabId }; result: void }
  'tabs.unpin': { args: { tabId: TabId }; result: void }
  'tabs.resetToPinned': { args: { tabId: TabId }; result: void }
  'tabs.rename': { args: { tabId: TabId; title: string | null }; result: void }
  'tabs.duplicate': { args: { tabId: TabId }; result: TabId }
  'tabs.setMuted': { args: { tabId: TabId; muted: boolean }; result: void }
  'tabs.clearToday': { args: { spaceId?: SpaceId }; result: void }
  'tabs.contextMenu': { args: { id: ItemId }; result: void }
  'folders.create': {
    args: { container?: ContainerRef; index?: number; name?: string; items?: ItemId[] }
    result: FolderId
  }
  'folders.rename': { args: { folderId: FolderId; name: string }; result: void }
  'folders.setCollapsed': { args: { folderId: FolderId; collapsed: boolean }; result: void }
  'folders.delete': { args: { folderId: FolderId; keepChildren?: boolean }; result: void }
}
