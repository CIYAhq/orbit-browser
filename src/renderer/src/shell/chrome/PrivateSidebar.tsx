import { HatGlasses } from 'lucide-react'
import { PRIVATE_NOTE } from '../../../../shared/private'
import type { SpaceId } from '../../../../shared/state'
import { SidebarItems } from '../sidebar/SidebarItems'

/**
 * A private window's sidebar below the top bar (SB-25, AP-05): a "Private" label with what it does
 * and doesn't hide, then the window's own tabs. No Spaces, pinned tabs or Favorites.
 */
export function PrivateSidebar({ spaceId }: { spaceId: SpaceId }) {
  return <SidebarItems spaceId={spaceId} simple header={<PrivateHeader />} />
}

function PrivateHeader() {
  return (
    <div className="private-header" data-testid="private-label">
      <div className="private-header__label">
        <HatGlasses size={15} aria-hidden />
        <span>Private</span>
      </div>
      <p className="private-header__note">{PRIVATE_NOTE}</p>
    </div>
  )
}
