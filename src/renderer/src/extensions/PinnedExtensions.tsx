import { pinnedExtensions } from '../../../shared/extensions'
import { useOrbit, useOrbitShallow } from '../store'
import { ExtensionIcon } from './ExtensionIcon'
import { runExtension } from './run'
import './pins.css'

/**
 * The pinned extensions' icons in the sidebar's address field (EX-04), in pin order: the profile of
 * the window's Space (EX-09). They show while the pointer is over the sidebar (or the keyboard is in
 * it), and a click opens the extension's popup under its icon (EX-05). Every extension, pinned or
 * not, is in the site controls panel (EX-03).
 */
export function PinnedExtensions({ windowId }: { windowId: string }) {
  const profileId = useOrbit((s) => {
    const spaceId = s.windows[windowId]?.spaceId
    return spaceId ? s.spaces[spaceId]?.profileId : undefined
  })
  const pinned = useOrbitShallow((s) => (profileId ? pinnedExtensions(s.extensions, profileId) : []))
  if (!profileId || pinned.length === 0) return null
  return (
    <div className="ext-pins" data-testid="ext-pins">
      {pinned.map((ext) => (
        <button
          key={ext.id}
          type="button"
          className="address__button ext-pins__button"
          data-testid="ext-pinned"
          data-ext={ext.id}
          aria-label={ext.name}
          title={ext.name}
          onClick={(e) => runExtension(ext.id, profileId, e.currentTarget)}
        >
          <ExtensionIcon icon={ext.icon} size={16} />
        </button>
      ))}
    </div>
  )
}
