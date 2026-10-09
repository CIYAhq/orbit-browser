import { LayoutGroup, motion } from 'motion/react'
import { forwardRef, memo, useMemo } from 'react'
import { MAX_FAVORITES } from '../../../../shared/defaults'
import { isTabId } from '../../../../shared/ids'
import { isAwayFromPinned, tabTitle } from '../../../../shared/tabs'
import { invoke } from '../../api'
import { activeTabId } from '../../selectors'
import { useOrbit } from '../../store'
import { Favicon } from '../../ui/Favicon'
import { pressItem } from './drag'
import { clearSelection, useDrag } from './ui-state'

/** Stable empty list (a fresh [] per call would re-render forever). */
const NO_ITEMS: string[] = []

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
    const ids = useOrbit((s) => s.profiles[profileId]?.favorites ?? NO_ITEMS)
    const favIndex = useDrag((s) => s.favIndex)
    const hidden = useDrag((s) => s.hidden)
    const favorites = useMemo(() => ids.filter(isTabId), [ids])
    const visible = favorites.filter((id) => !(hidden[id] && favIndex !== null))
    const tiles: (string | null)[] = [...visible]
    if (favIndex !== null) tiles.splice(Math.min(favIndex, tiles.length), 0, null)
    const full = favorites.length >= MAX_FAVORITES && !favorites.some((id) => hidden[id])
    const columns = Math.max(1, Math.min(MAX_COLUMNS, tiles.length))
    return (
      <div
        ref={ref}
        className={`favorites${tiles.length === 0 ? ' favorites--empty' : ''}${favIndex !== null && full ? ' is-full' : ''}`}
        data-testid="favorites"
        style={tiles.length > 0 ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}
      >
        <LayoutGroup id={`favorites-${profileId}`}>
          {tiles.map((id) =>
            id ? (
              <FavoriteTile key={id} tabId={id} />
            ) : (
              <motion.div
                key="placeholder"
                layout
                className="favorite favorite--placeholder"
                data-testid="favorite-placeholder"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={TILE_SPRING}
              >
                {visible.length === 0 && <span className="favorites__hint">Drop to add to Favorites</span>}
              </motion.div>
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
