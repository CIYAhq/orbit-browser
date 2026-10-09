import { AnimatePresence, LayoutGroup, motion } from 'motion/react'
import { forwardRef, memo, useMemo, useState } from 'react'
import { MAX_FAVORITES } from '../../../../shared/defaults'
import { isSplitId, isTabId } from '../../../../shared/ids'
import { isAwayFromPinned, tabTitle } from '../../../../shared/tabs'
import { invoke, isMac } from '../../api'
import { activeTabId } from '../../selectors'
import { useOrbit } from '../../store'
import { Favicon } from '../../ui/Favicon'
import { SplitFavoriteTile } from '../split/SplitFavoriteTile'
import { pressItem } from './drag'
import { POP, SNAPPY } from './motion-tokens'
import { clearSelection, useDrag } from './ui-state'

/** Stable empty list (a fresh [] per call would re-render forever). */
const NO_ITEMS: string[] = []

/** Most tiles per grid row at the default width (FV-02). */
const MAX_COLUMNS = 4

const TILE_SPRING = SNAPPY

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
    // Tabs and split views (a Favorite split shows its panes' icons in one tile, SV-23).
    const favorites = useMemo(() => ids.filter((id) => isTabId(id) || isSplitId(id)), [ids])
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
          <AnimatePresence initial={false} mode="popLayout">
            {tiles.map((id) =>
              id ? (
                isSplitId(id) ? (
                  <SplitFavoriteTile key={id} splitId={id} />
                ) : (
                  <FavoriteTile key={id} tabId={id} />
                )
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
          </AnimatePresence>
        </LayoutGroup>
      </div>
    )
  }),
)

const FavoriteTile = memo(function FavoriteTile({ tabId }: { tabId: string }) {
  const tab = useOrbit((s) => s.tabs[tabId])
  const active = useOrbit((s) => activeTabId(s) === tabId)
  const hidden = useDrag((s) => !!s.hidden[tabId])
  // Tiles that arrive by drag appear at once under the ghost; others pop in (FL-20).
  const [instant] = useState(() => hidden)
  if (!tab) return null
  const away = isAwayFromPinned(tab)
  const title = tabTitle(tab)
  return (
    <motion.button
      layout
      transition={TILE_SPRING}
      initial={instant ? false : { scale: 0.85, opacity: 0 }}
      animate={{ scale: 1, opacity: hidden ? 0 : 1, transition: hidden ? { duration: 0 } : POP }}
      exit={{ scale: 0.85, opacity: 0, transition: { duration: 0.15 } }}
      whileTap={{ scale: 0.94 }}
      type="button"
      className={`favorite${active ? ' is-active' : ''}${tab.asleep ? ' is-asleep' : ''}${away ? ' is-away' : ''}`}
      data-testid="favorite-tile"
      data-tab-id={tabId}
      data-fav-id={tabId}
      title={away ? `${title} — double-click to return to the saved page` : title}
      aria-label={title}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        if ((isMac ? e.metaKey : e.ctrlKey) && e.altKey && !e.shiftKey) {
          // ⌘⌥-click opens a copy in a Mini Window (MW-07; owned by the peek lane).
          e.preventDefault()
          void invoke('mini.fromTab', { tabId })
          return
        }
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
