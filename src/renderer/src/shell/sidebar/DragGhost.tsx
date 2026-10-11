import { Folder } from 'lucide-react'
import { motion } from 'motion/react'
import { createPortal } from 'react-dom'
import { isFolderId, isTabId } from '../../../../shared/ids'
import { rowTitle } from '../../../../shared/tabs'
import { AT_ONCE, tween, useReducedMotion } from '../../motion'
import { useOrbit } from '../../store'
import { Favicon } from '../../ui/Favicon'
import { ghostOpacity, ghostScale, ghostX, ghostY } from './drag'
import { useDrag } from './ui-state'

const SHADOW_LIFT = '0px 6px 16px rgba(0, 0, 0, 0.22), 0px 0px 0px 0.5px rgba(0, 0, 0, 0.08)'
const SHADOW_STACK =
  '0px 6px 16px rgba(0, 0, 0, 0.22), 0px 0px 0px 0.5px rgba(0, 0, 0, 0.08), 3px 4px 0px -1px rgba(255, 255, 255, 0.7), 6px 8px 0px -2px rgba(255, 255, 255, 0.5)'
const SHADOW_REST = '0px 0px 0px 0px rgba(0, 0, 0, 0), 0px 0px 0px 0.5px rgba(0, 0, 0, 0.06)'

/** FL-10: the row ⇄ tile morph takes about 200 ms (snappy); the shadow fades over about 150 ms. */
const MORPH = { ...tween('snappy'), boxShadow: { duration: 0.15 } }
/** With reduced motion (FL-28) the ghost's size changes at once. */
const MORPH_REDUCED = { ...MORPH, width: AT_ONCE, height: AT_ONCE }

/**
 * The lifted copy of the dragged row or tile that follows the pointer (TB-08, FL-10):
 * a slight scale-up and shadow, morphing into a tile over the Favorites grid.
 */
export function DragGhost() {
  const ghost = useDrag((s) => s.ghost)
  const overFavorites = useDrag((s) => s.favIndex !== null)
  const outside = useDrag((s) => s.outside)
  const phase = useDrag((s) => s.phase)
  // Reduced motion as it is now, also when it turns on during a drag (FL-28).
  const reduced = useReducedMotion()
  if (!ghost) return null
  const first = ghost.ids[0] as string
  const asTile = ghost.source === 'favorites' || overFavorites
  const settling = phase === 'landing' || phase === 'cancelling'
  // Drawn in the shell's root, which carries the Space theme, rather than here in the Space strip:
  // the strip's track is a containing block for fixed elements (it is composited for swipes), so a
  // ghost in it sat lower than the pointer by the strip's offset and slid with the Space pages
  // (FL-10: the row stays exactly under the pointer, also while the Spaces slide).
  const host = document.querySelector<HTMLElement>('.shell') ?? document.body
  return createPortal(
    <motion.div
      className={`drag-ghost${asTile ? ' drag-ghost--tile' : ''}${outside ? ' drag-ghost--outside' : ''}${ghost.ids.length > 1 ? ' drag-ghost--stack' : ''}${settling ? ' is-settling' : ''}`}
      data-testid="drag-ghost"
      style={{ x: ghostX, y: ghostY, scale: ghostScale, opacity: ghostOpacity }}
      initial={false}
      // Row ⇄ tile morph over the Favorites grid (FL-10): size and corner radius.
      animate={{
        width: asTile ? 48 : ghost.width,
        height: asTile ? 44 : ghost.height,
        borderRadius: asTile ? 10 : 8,
        // The lifted shadow eases off while the row settles (FL-10).
        boxShadow: settling ? SHADOW_REST : ghost.ids.length > 1 ? SHADOW_STACK : SHADOW_LIFT,
      }}
      transition={reduced ? MORPH_REDUCED : MORPH}
    >
      <GhostContent id={first} tile={asTile} />
      {ghost.ids.length > 1 && <span className="drag-ghost__count">{ghost.ids.length}</span>}
    </motion.div>,
    host,
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
