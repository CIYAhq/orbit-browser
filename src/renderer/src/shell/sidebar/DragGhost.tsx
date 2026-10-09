import { Folder } from 'lucide-react'
import { motion } from 'motion/react'
import { isFolderId, isTabId } from '../../../../shared/ids'
import { rowTitle } from '../../../../shared/tabs'
import { useOrbit } from '../../store'
import { Favicon } from '../../ui/Favicon'
import { ghostOpacity, ghostScale, ghostX, ghostY } from './drag'
import { useDrag } from './ui-state'

/**
 * The lifted copy of the dragged row or tile that follows the pointer (TB-08, FL-10):
 * a slight scale-up and shadow, morphing into a tile over the Favorites grid.
 */
export function DragGhost() {
  const ghost = useDrag((s) => s.ghost)
  const overFavorites = useDrag((s) => s.favIndex !== null)
  const outside = useDrag((s) => s.outside)
  if (!ghost) return null
  const first = ghost.ids[0] as string
  const asTile = ghost.source === 'favorites' || overFavorites
  return (
    <motion.div
      className={`drag-ghost${asTile ? ' drag-ghost--tile' : ''}${outside ? ' drag-ghost--outside' : ''}`}
      data-testid="drag-ghost"
      style={{
        x: ghostX,
        y: ghostY,
        scale: ghostScale,
        opacity: ghostOpacity,
        width: asTile ? 48 : ghost.width,
        height: asTile ? 44 : ghost.height,
      }}
    >
      <GhostContent id={first} tile={asTile} />
      {ghost.ids.length > 1 && <span className="drag-ghost__count">{ghost.ids.length}</span>}
    </motion.div>
  )
}

function GhostContent({ id, tile }: { id: string; tile: boolean }) {
  const tab = useOrbit((s) => (isTabId(id) ? s.tabs[id] : undefined))
  const folder = useOrbit((s) => (isFolderId(id) ? s.folders[id] : undefined))
  if (tab) {
    const icon = tab.icon ? (
      <span className="tab-row__emoji">{tab.icon}</span>
    ) : (
      <Favicon src={tab.favicon} size={tile ? 20 : 16} />
    )
    if (tile) return icon
    const { prefix, title } = rowTitle(tab)
    return (
      <>
        <span className="tab-row__icon">{icon}</span>
        <span className="tab-row__title">{prefix ? `${prefix} / ${title}` : title}</span>
      </>
    )
  }
  if (folder) {
    return (
      <>
        <span className="tab-row__icon">
          {folder.icon ? <span className="tab-row__emoji">{folder.icon}</span> : <Folder size={15} strokeWidth={1.7} />}
        </span>
        <span className="tab-row__title">{folder.name}</span>
      </>
    )
  }
  return null
}
