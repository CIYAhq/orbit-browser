import { AnimatePresence, LayoutGroup, motion } from 'motion/react'
import { forwardRef, memo, type Ref, useMemo, useState } from 'react'
import { MAX_FAVORITES } from '../../../../shared/defaults'
import { isSplitId, isTabId } from '../../../../shared/ids'
import { isAwayFromPinned, tabTitle } from '../../../../shared/tabs'
import { invoke, isMac } from '../../api'
import { AT_ONCE, POP, REDUCED_FADE, SNAPPY, useReducedMotion } from '../../motion'
import { activeTabId } from '../../selectors'
import { useOrbit } from '../../store'
import { Favicon } from '../../ui/Favicon'
import { SplitFavoriteTile } from '../split/SplitFavoriteTile'
import { pressItem } from './drag'
import { menuAt } from './menu-at'
import { clearSelection, useDrag } from './ui-state'

/** Stable empty list (a fresh [] per call would re-render forever). */
const NO_ITEMS: string[] = []

/** Most tiles per grid row at the default width (FV-02). */
const MAX_COLUMNS = 4

const TILE_SPRING = SNAPPY

/**
 * With reduced motion (FL-28) a tile only fades, in and out, where it rests and at its size; the
 * grid re-flows at once and a press doesn't nudge it. Each tile and the grid ask
 * `useReducedMotion()`, as motion reads OrbitMotionConfig only as an element mounts and the tiles stay
 * on screen while the setting changes.
 */
const TILE_FADE = { opacity: 0, scale: 1 }

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
    const reduced = useReducedMotion()
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
        {/* Between Spaces of two profiles the whole grid swaps: no tile leaves, arrives or moves, and
            the Space switcher's cross-fade alone carries it (PR-06, SP-10). */}
        <LayoutGroup key={profileId} id={`favorites-${profileId}`}>
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
                  layout={!reduced}
                  className="favorite favorite--placeholder"
                  data-testid="favorite-placeholder"
                  initial={reduced ? TILE_FADE : { opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={reduced ? REDUCED_FADE : TILE_SPRING}
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

/**
 * `ref` reaches the tile's element so the grid's AnimatePresence can take a leaving tile out of the
 * flow at its size (popLayout): it shrinks and fades where it was while the grid closes up (FL-20).
 */
const FavoriteTile = memo(function FavoriteTile({ tabId, ref }: { tabId: string; ref?: Ref<HTMLButtonElement> }) {
  const tab = useOrbit((s) => s.tabs[tabId])
  const active = useOrbit((s) => activeTabId(s) === tabId)
  const hidden = useDrag((s) => !!s.hidden[tabId])
  // Tiles that arrive by drag appear at once under the ghost; others pop in (FL-20).
  const [instant] = useState(() => hidden)
  const reduced = useReducedMotion()
  if (!tab) return null
  const away = isAwayFromPinned(tab)
  const title = tabTitle(tab)
  return (
    <motion.button
      ref={ref}
      layout={!reduced}
      transition={TILE_SPRING}
      initial={instant ? false : reduced ? TILE_FADE : { scale: 0.85, opacity: 0 }}
      animate={{ scale: 1, opacity: hidden ? 0 : 1, transition: hidden ? AT_ONCE : reduced ? REDUCED_FADE : POP }}
      exit={
        reduced
          ? { ...TILE_FADE, transition: REDUCED_FADE }
          : { scale: 0.85, opacity: 0, transition: { duration: 0.15 } }
      }
      whileTap={reduced ? undefined : { scale: 0.94 }}
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
        void invoke('tabs.contextMenu', { id: tabId, at: menuAt(e, tabId) })
      }}
    >
      {tab.icon ? <span className="favorite__emoji">{tab.icon}</span> : <Favicon src={tab.favicon} size={20} />}
      {/* Playing: small notes rise over the tile (TB-15); muted, a still dot. */}
      {tab.audible && !tab.muted && (
        <span className="favorite__notes" data-testid="favorite-notes" aria-hidden="true">
          <span className="favorite__note">♪</span>
          <span className="favorite__note">♫</span>
        </span>
      )}
      {tab.audible && tab.muted && <span className="favorite__audio" />}
      {away && <span className="favorite__away" data-testid="favorite-away" />}
    </motion.button>
  )
})
