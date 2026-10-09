import { invoke } from '../../api'
import { getOrbitState, useOrbit } from '../../store'
import { Favicon } from '../../ui/Favicon'
import { focusedPaneOf, lastFocusedPane, paneOrderKey } from './selectors'

/**
 * A Favorite that is a split view (SV-23): one tile with the panes' favicons side by side.
 * For the Favorites grid to render for `v-` ids (it lists tabs only today).
 */
export function SplitFavoriteTile({ splitId }: { splitId: string }) {
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
  if (!order) return null
  const panes = order.split(',')
  return (
    <button
      type="button"
      className={`favorite split-favorite${active ? ' is-active' : ''}`}
      data-testid="favorite-tile"
      data-split-id={splitId}
      title={title}
      onClick={() => {
        const tabId = lastFocusedPane(getOrbitState(), panes)
        if (tabId) void invoke('tabs.activate', { tabId })
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        void invoke('split.contextMenu', { splitId })
      }}
    >
      <span className="split-favorite__icons">
        {panes.map((id) => (
          <TileIcon key={id} tabId={id} />
        ))}
      </span>
    </button>
  )
}

function TileIcon({ tabId }: { tabId: string }) {
  const favicon = useOrbit((s) => s.tabs[tabId]?.favicon)
  return <Favicon src={favicon} size={14} />
}
