import { motion } from 'motion/react'
import { memo, useState } from 'react'
import { isAwayFromPinned } from '../../../../shared/tabs'
import { invoke } from '../../api'
import { getOrbitState, useOrbit } from '../../store'
import { Favicon } from '../../ui/Favicon'
import { pressItem } from '../sidebar/drag'
import { POP, SNAPPY } from '../sidebar/motion-tokens'
import { clearSelection, useDrag } from '../sidebar/ui-state'
import { focusedPaneOf, lastFocusedPane, paneOrderKey } from './selectors'

/**
 * A Favorite that is a split view (SV-23): one tile with the panes' favicons side by side (or
 * its icon, SV-21), behaving like the Favorites grid's tab tiles (press selects, drags like a
 * tile, pops in).
 * Pressing it shows the split with the pane focused last. When a pane has left its pinned page,
 * the tile shows so, and a double-click brings every pane back (SV-23), as a tab tile's does.
 */
export const SplitFavoriteTile = memo(function SplitFavoriteTile({ splitId }: { splitId: string }) {
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
  const icon = useOrbit((s) => s.splits[splitId]?.icon ?? '')
  const away = useOrbit((s) =>
    order.split(',').some((id) => {
      const tab = s.tabs[id]
      return !!tab && isAwayFromPinned(tab)
    }),
  )
  const hidden = useDrag((s) => !!s.hidden[splitId])
  // Tiles that arrive by drag appear at once under the ghost; others pop in (FL-20).
  const [instant] = useState(() => hidden)
  if (!order) return null
  const panes = order.split(',')
  return (
    <motion.button
      layout
      transition={SNAPPY}
      initial={instant ? false : { scale: 0.85, opacity: 0 }}
      animate={{ scale: 1, opacity: hidden ? 0 : 1, transition: hidden ? { duration: 0 } : POP }}
      exit={{ scale: 0.85, opacity: 0, transition: { duration: 0.15 } }}
      whileTap={{ scale: 0.94 }}
      type="button"
      className={`favorite split-favorite${active ? ' is-active' : ''}${away ? ' is-away' : ''}`}
      data-testid="favorite-tile"
      data-split-id={splitId}
      data-fav-id={splitId}
      title={away ? `${title} — double-click to return to the saved pages` : title}
      aria-label={title}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        clearSelection()
        const tabId = lastFocusedPane(getOrbitState(), splitId)
        if (tabId) void invoke('tabs.activate', { tabId })
        pressItem(e, splitId, 'favorites')
      }}
      onDoubleClick={() => void invoke('split.reset', { splitId })}
      onAuxClick={(e) => {
        if (e.button === 1) void invoke('split.close', { splitId })
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        void invoke('split.contextMenu', { splitId })
      }}
    >
      {icon ? (
        // Its icon replaces the panes' favicons (SV-21, TB-12).
        <span className="favorite__emoji" data-testid="split-icon">
          {icon}
        </span>
      ) : (
        <span className="split-favorite__icons">
          {panes.map((id) => (
            <TileIcon key={id} tabId={id} />
          ))}
        </span>
      )}
      {away && <span className="favorite__away" data-testid="favorite-away" />}
    </motion.button>
  )
})

function TileIcon({ tabId }: { tabId: string }) {
  const favicon = useOrbit((s) => s.tabs[tabId]?.favicon)
  return <Favicon src={favicon} size={14} />
}
