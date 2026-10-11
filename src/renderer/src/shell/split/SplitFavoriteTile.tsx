import { motion } from 'motion/react'
import { memo, type Ref, useState } from 'react'
import { invoke } from '../../api'
import { AT_ONCE, POP, REDUCED_FADE, SNAPPY, useReducedMotion } from '../../motion'
import { getOrbitState, useOrbit } from '../../store'
import { Favicon } from '../../ui/Favicon'
import { pressItem } from '../sidebar/drag'
import { menuAt } from '../sidebar/menu-at'
import { clearSelection, useDrag } from '../sidebar/ui-state'
import { focusedPaneOf, lastFocusedPane, paneOrderKey } from './selectors'

/** With reduced motion a tile only fades, where it rests and at its size (FL-28, as Favorites' tiles). */
const TILE_FADE = { opacity: 0, scale: 1 }

/**
 * A Favorite that is a split view (SV-23): one tile with the panes' favicons side by side,
 * behaving like the Favorites grid's tab tiles (press selects, drags like a tile, pops in).
 * Pressing it shows the split with the pane focused last.
 */
export const SplitFavoriteTile = memo(function SplitFavoriteTile({
  splitId,
  ref,
}: {
  splitId: string
  /** The tile's element, for the grid's AnimatePresence (popLayout, FL-20). */
  ref?: Ref<HTMLButtonElement>
}) {
  const order = useOrbit((s) => paneOrderKey(s, splitId))
  const active = useOrbit((s) => focusedPaneOf(s, splitId) !== '')
  const title = useOrbit((s) => {
    const split = s.splits[splitId]
    if (!split) return ''
    return (
      split.name ??
      order
        .split(',')
        .map((id) => s.tabs[id]?.customTitle ?? s.tabs[id]?.title ?? '')
        .join(' | ')
    )
  })
  const hidden = useDrag((s) => !!s.hidden[splitId])
  // Tiles that arrive by drag appear at once under the ghost; others pop in (FL-20).
  const [instant] = useState(() => hidden)
  // Reduced motion as it is now, not as the tile mounted (FL-28).
  const reduced = useReducedMotion()
  if (!order) return null
  const panes = order.split(',')
  return (
    <motion.button
      ref={ref}
      layout={!reduced}
      transition={SNAPPY}
      initial={instant ? false : reduced ? TILE_FADE : { scale: 0.85, opacity: 0 }}
      animate={{ scale: 1, opacity: hidden ? 0 : 1, transition: hidden ? AT_ONCE : reduced ? REDUCED_FADE : POP }}
      exit={
        reduced
          ? { ...TILE_FADE, transition: REDUCED_FADE }
          : { scale: 0.85, opacity: 0, transition: { duration: 0.15 } }
      }
      whileTap={reduced ? undefined : { scale: 0.94 }}
      type="button"
      className={`favorite split-favorite${active ? ' is-active' : ''}`}
      data-testid="favorite-tile"
      data-split-id={splitId}
      data-fav-id={splitId}
      title={title}
      aria-label={title}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        clearSelection()
        const tabId = lastFocusedPane(getOrbitState(), splitId)
        if (tabId) void invoke('tabs.activate', { tabId })
        pressItem(e, splitId, 'favorites')
      }}
      onAuxClick={(e) => {
        if (e.button === 1) void invoke('split.close', { splitId })
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        void invoke('split.contextMenu', { splitId, at: menuAt(e, splitId) })
      }}
    >
      <span className="split-favorite__icons">
        {panes.map((id) => (
          <TileIcon key={id} tabId={id} />
        ))}
      </span>
    </motion.button>
  )
})

function TileIcon({ tabId }: { tabId: string }) {
  const favicon = useOrbit((s) => s.tabs[tabId]?.favicon)
  return <Favicon src={favicon} size={14} />
}
