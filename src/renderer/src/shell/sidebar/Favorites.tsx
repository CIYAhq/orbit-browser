import { isTabId } from '../../../../shared/ids'
import { invoke } from '../../api'
import { activeTabId } from '../../selectors'
import { useOrbit } from '../../store'
import { Favicon } from '../../ui/Favicon'

/** The favorites grid at the top of the sidebar (shared by all Spaces of a profile). */
export function Favorites({ profileId }: { profileId: string }) {
  const favorites = useOrbit((s) => s.profiles[profileId]?.favorites ?? [])
  if (favorites.length === 0) return null
  return (
    <div className="favorites" data-testid="favorites">
      {favorites.filter(isTabId).map((id) => (
        <FavoriteTile key={id} tabId={id} />
      ))}
    </div>
  )
}

function FavoriteTile({ tabId }: { tabId: string }) {
  const tab = useOrbit((s) => s.tabs[tabId])
  const active = useOrbit((s) => activeTabId(s) === tabId)
  if (!tab) return null
  return (
    <button
      type="button"
      className={`favorite${active ? ' is-active' : ''}${tab.asleep ? ' is-asleep' : ''}`}
      data-testid="favorite-tile"
      data-tab-id={tabId}
      title={tab.customTitle ?? tab.title}
      onClick={() => void invoke('tabs.activate', { tabId })}
      onContextMenu={(e) => {
        e.preventDefault()
        void invoke('tabs.contextMenu', { id: tabId })
      }}
    >
      <Favicon src={tab.favicon} size={18} />
      {tab.audible && <span className="favorite__audio" />}
    </button>
  )
}
