import { ChevronRight, Folder, Volume2, VolumeX, X } from 'lucide-react'
import { isFolderId, isSplitId, isTabId } from '../../../../shared/ids'
import type { ContainerRef, ItemId } from '../../../../shared/state'
import { invoke } from '../../api'
import { activeTabId } from '../../selectors'
import { useOrbit } from '../../store'
import { Favicon } from '../../ui/Favicon'
import { SplitRow } from './SplitRow'

/** A list of sidebar items (tabs, folders, split views) in one container. */
export function ItemList({
  container,
  items,
  depth = 0,
  testId,
}: {
  container: ContainerRef
  items: ItemId[]
  depth?: number
  testId?: string
}) {
  return (
    <div className="item-list" data-testid={testId} data-container={container.kind}>
      {items.map((id) => {
        if (isTabId(id)) return <TabRow key={id} tabId={id} depth={depth} />
        if (isFolderId(id)) return <FolderRow key={id} folderId={id} depth={depth} />
        if (isSplitId(id)) return <SplitRow key={id} splitId={id} depth={depth} />
        return null
      })}
    </div>
  )
}

export function TabRow({ tabId, depth }: { tabId: string; depth: number }) {
  const tab = useOrbit((s) => s.tabs[tabId])
  const active = useOrbit((s) => activeTabId(s) === tabId)
  if (!tab) return null
  const title = tab.customTitle ?? tab.title
  const awayFromPin = !!tab.pinnedUrl && tab.url !== tab.pinnedUrl && !tab.asleep
  return (
    <div
      role="button"
      tabIndex={-1}
      className={`tab-row${active ? ' is-active' : ''}${tab.asleep ? ' is-asleep' : ''}${tab.loading ? ' is-loading' : ''}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      data-testid="tab-row"
      data-tab-id={tabId}
      onMouseDown={(e) => {
        if (e.button === 0) void invoke('tabs.activate', { tabId })
      }}
      onAuxClick={(e) => {
        if (e.button === 1) void invoke('tabs.close', { tabId })
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        void invoke('tabs.contextMenu', { id: tabId })
      }}
    >
      <span className="tab-row__icon">
        <Favicon src={tab.favicon} />
      </span>
      <span className="tab-row__title">{title}</span>
      {(tab.audible || tab.muted) && (
        <button
          type="button"
          className="tab-row__audio"
          aria-label={tab.muted ? 'Unmute tab' : 'Mute tab'}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => void invoke('tabs.setMuted', { tabId, muted: !tab.muted })}
        >
          {tab.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
        </button>
      )}
      {awayFromPin && (
        <button
          type="button"
          className="tab-row__reset"
          data-testid="reset-pinned"
          title="Go back to pinned URL"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => void invoke('tabs.resetToPinned', { tabId })}
        >
          ↩
        </button>
      )}
      <button
        type="button"
        className="tab-row__close"
        aria-label="Close tab"
        data-testid="tab-close"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => void invoke('tabs.close', { tabId })}
      >
        <X size={13} strokeWidth={2.2} />
      </button>
    </div>
  )
}

function FolderRow({ folderId, depth }: { folderId: string; depth: number }) {
  const folder = useOrbit((s) => s.folders[folderId])
  if (!folder) return null
  return (
    <div className="folder" data-testid="folder" data-folder-id={folderId}>
      <div
        role="button"
        tabIndex={-1}
        className="folder-row"
        style={{ paddingLeft: 8 + depth * 14 }}
        onMouseDown={(e) => {
          if (e.button === 0) void invoke('folders.setCollapsed', { folderId, collapsed: !folder.collapsed })
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          void invoke('tabs.contextMenu', { id: folderId })
        }}
      >
        <ChevronRight size={13} className={`folder-row__chevron${folder.collapsed ? '' : ' is-open'}`} />
        <Folder size={15} strokeWidth={1.7} />
        <span className="folder-row__title">{folder.name}</span>
      </div>
      {!folder.collapsed && (
        <ItemList container={{ kind: 'folder', folderId }} items={folder.children} depth={depth + 1} />
      )}
    </div>
  )
}
