import { LayoutGroup, motion } from 'motion/react'
import { forwardRef, memo } from 'react'
import { MAX_FAVORITES } from '../../../../shared/defaults'
import { isTabId } from '../../../../shared/ids'
import { isAwayFromPinned, tabTitle } from '../../../../shared/tabs'
import { invoke } from '../../api'
import { activeTabId } from '../../selectors'
import { useOrbit, useOrbitShallow } from '../../store'
import { Favicon } from '../../ui/Favicon'
import { pressItem } from './drag'
import { clearSelection, useDrag } from './ui-state'

/** Most tiles per grid row at the default width (FV-02). */
const MAX_COLUMNS = 4

const TILE_SPRING = { type: 'spring', stiffness: 520, damping: 40, mass: 0.7 } as const

/**
 * The Favorites grid at the top of the sidebar (FV-01, FV-02), shared by every Space of
 * a profile. Tiles fill the width (up to 4 per row, fewer stretch), wrap beyond that, and
 * open a gap while a tab is dragged over the grid.
 */
export const Favorites = memo(
  forwardRef<HTMLDivElement, { profileId: string }>(function Favorites({ profileId }, ref) {
    const favorites = useOrbitShallow((s) => (s.profiles[profileId]?.favorites ?? []).filter(isTabId))
    const dragging = useDrag((s) => s.phase !== 'idle' && s.ghost?.source === 'list')
    const favIndex = useDrag((s) => s.favIndex)
    const hidden = useDrag((s) => s.hidden)
    const visible = favorites.filter((id) => !(hidden[id] && favIndex !== null))
    const tiles: (string | null)[] = [...visible]
    if (favIndex !== null) tiles.splice(Math.min(favIndex, tiles.length), 0, null)
    const full = favorites.length >= MAX_FAVORITES
    const columns = Math.max(1, Math.min(MAX_COLUMNS, tiles.length))
    if (tiles.length === 0) {
      // Empty: nothing, or a slim drop zone while a tab is being dragged (FV-02, FV-03).
      return (
        <div
          ref={ref}
          className={`favorites favorites--empty${dragging ? ' is-drop-zone' : ''}`}
          data-testid="favorites"
        >
          {dragging && <div className="favorites__hint">Drop here to add to Favorites</div>}
        </div>
      )
    }
    return (
      <div
        ref={ref}
        className={`favorites${favIndex !== null && full ? ' is-full' : ''}`}
        data-testid="favorites"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        <LayoutGroup id={`favorites-${profileId}`}>
          {tiles.map((id, i) =>
            id ? (
              <FavoriteTile key={id} tabId={id} />
            ) : (
              <motion.div
                key="placeholder"
                layout
                className="favorite favorite--placeholder"
                data-testid="favorite-placeholder"
                transition={TILE_SPRING}
                data-index={i}
              />
            ),
          )}
        </LayoutGroup>
      </div>
    )
  }),
)

const FavoriteTile = memo(function FavoriteTile({ tabId }: { tabId: string }) {
  const tab = useOrbit((s) => s.tabs[tabId])
  const active = useOrbit((s) => activeTabId(s) === tabId)
  const hidden = useDrag((s) => !!s.hidden[tabId])
  if (!tab) return null
  const away = isAwayFromPinned(tab)
  const title = tabTitle(tab)
  return (
    <motion.button
      layout
      transition={TILE_SPRING}
      type="button"
      className={`favorite${active ? ' is-active' : ''}${tab.asleep ? ' is-asleep' : ''}${away ? ' is-away' : ''}`}
      style={{ opacity: hidden ? 0 : 1 }}
      data-testid="favorite-tile"
      data-tab-id={tabId}
      data-fav-id={tabId}
      title={away ? `${title} — double-click to return to the saved page` : title}
      aria-label={title}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        clearSelection()
        void invoke('tabs.activate', { tabId })
        pressItem(e, tabId, 'favorites')
      }}
      onDoubleClick={() => void invoke('tabs.resetToPinned', { tabId })}
      onAuxClick={(e) => {
        if (e.button === 1) void invoke('tabs.close', { tabId })
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        void invoke('tabs.contextMenu', { id: tabId })
      }}
    >
      {tab.icon ? <span className="favorite__emoji">{tab.icon}</span> : <Favicon src={tab.favicon} size={20} />}
      {tab.audible && <span className="favorite__audio" />}
      {away && <span className="favorite__away" data-testid="favorite-away" />}
    </motion.button>
  )
})
