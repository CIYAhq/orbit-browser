import { ChevronRight, Folder, Plus } from 'lucide-react'
import { memo, type ReactNode } from 'react'
import { isFolderId, isSplitId, isTabId } from '../../../../shared/ids'
import type { ItemId, OrbitState, SpaceId } from '../../../../shared/state'
import { splitLeaves } from '../../../../shared/tree'
import { getOrbitState, useOrbit } from '../../store'
import { Favicon } from '../../ui/Favicon'
import { scrollMemory } from './scroll-memory'

/** Approximate row pitch (row height + gap) used to budget preview rows. */
const ROW_PITCH = 33
/** Most Favorites tiles per row (matches the tabs lane's grid, FV-02). */
const MAX_FAVORITE_COLUMNS = 4

/**
 * A light, static picture of a neighbouring Space for the swipe and switch
 * animations (FL-13): same layout and classes as the real page, but only the
 * rows that can be on screen, no handlers, no test ids and no per-row store
 * subscriptions, so mounting one is cheap even for Spaces with hundreds of tabs.
 */
export const SpacePreview = memo(function SpacePreview({
  spaceId,
  windowId,
  height,
  standIn = false,
}: {
  spaceId: SpaceId
  windowId: string
  /** The strip's height, measured once by the strip (no layout read per preview; review M5). */
  height: number
  /** Standing in for the active Space's real page for a moment after a switch. */
  standIn?: boolean
}) {
  const space = useOrbit((s) => s.spaces[spaceId])
  const favorites = useOrbit((s) => (space ? s.profiles[space.profileId]?.favorites : undefined))
  const active = useOrbit((s) => s.windows[windowId]?.activeTab[spaceId] ?? null)
  const single = useOrbit((s) => s.spaceOrder.length === 1)
  if (!space) return null
  const state = getOrbitState()
  const scrollTop = scrollMemory.get(spaceId) ?? 0
  const budget = Math.ceil((scrollTop + (height || 900)) / ROW_PITCH) + 4
  const pinnedRows = collectRows(state, space.pinned, 0, budget, active)
  const todayRows = collectRows(state, space.today, 0, Math.max(0, budget - pinnedRows.length - 2), active)
  return (
    <div className={`space-page space-page--preview${standIn ? ' is-stand-in' : ''}`} aria-hidden={!standIn}>
      <div className="space-page__favorites" data-favorites-layer>
        {favorites && favorites.length > 0 ? (
          // Same grid and tiles as the tabs lane's Favorites, so a stand-in or a cross-fading
          // neighbour never changes the tiles' size or place (PR-06; review V2).
          <div
            className="favorites"
            style={{
              gridTemplateColumns: `repeat(${Math.max(1, Math.min(MAX_FAVORITE_COLUMNS, favorites.filter(isTabId).length))}, minmax(0, 1fr))`,
            }}
          >
            {favorites.filter(isTabId).map((id) => {
              const tab = state.tabs[id]
              return (
                <div
                  key={id}
                  className={`favorite${active === id ? ' is-active' : ''}${tab?.asleep ? ' is-asleep' : ''}`}
                >
                  {tab?.icon ? (
                    <span className="favorite__emoji">{tab.icon}</span>
                  ) : (
                    <Favicon src={tab?.favicon} size={20} />
                  )}
                </div>
              )
            })}
          </div>
        ) : null}
      </div>
      <div className="sidebar__scroll space-page__preview-scroll">
        <div style={scrollTop ? { transform: `translateY(${-scrollTop}px)` } : undefined}>
          {single && space.unnamed ? null : (
            <div className="space-title">
              {space.icon ? <span className="space-title__icon">{space.icon}</span> : null}
              <span className="space-title__name" data-testid={standIn ? 'space-name' : undefined}>
                {space.name}
              </span>
            </div>
          )}
          <div className="item-list">{pinnedRows}</div>
          <div className="sidebar__divider">
            <span className="sidebar__divider-line" />
          </div>
          <div className="new-tab-button">
            <Plus size={16} strokeWidth={2} />
            <span>New Tab</span>
          </div>
          <div className="item-list">{todayRows}</div>
        </div>
      </div>
    </div>
  )
})

function collectRows(state: OrbitState, items: ItemId[], depth: number, budget: number, active: string | null) {
  const rows: ReactNode[] = []
  const visit = (id: ItemId, d: number) => {
    if (rows.length >= budget) return
    if (isTabId(id)) {
      const tab = state.tabs[id]
      if (!tab) return
      rows.push(
        <div
          key={id}
          className={`tab-row${active === id ? ' is-active' : ''}${tab.asleep ? ' is-asleep' : ''}`}
          style={{ paddingLeft: 8 + d * 14 }}
        >
          <span className="tab-row__icon">
            <Favicon src={tab.favicon} />
          </span>
          <span className="tab-row__title">{tab.customTitle ?? tab.title}</span>
        </div>,
      )
    } else if (isFolderId(id)) {
      const folder = state.folders[id]
      if (!folder) return
      rows.push(
        <div key={id} className="folder-row" style={{ paddingLeft: 8 + d * 14 }}>
          <ChevronRight size={13} className={`folder-row__chevron${folder.collapsed ? '' : ' is-open'}`} />
          <Folder size={15} strokeWidth={1.7} />
          <span className="folder-row__title">{folder.name}</span>
        </div>,
      )
      if (!folder.collapsed) for (const child of folder.children) visit(child, d + 1)
    } else if (isSplitId(id)) {
      const split = state.splits[id]
      if (split) for (const tabId of splitLeaves(split.layout)) visit(tabId, d)
    }
  }
  for (const id of items) visit(id, depth)
  return rows
}
