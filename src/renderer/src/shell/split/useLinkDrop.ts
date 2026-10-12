import { useEffect } from 'react'
import { flushSync } from 'react-dom'
import { carriesLink, droppedLink, LINK_DROP_ID, type LinkDragMessage } from '../../../../shared/link-drop'
import type { DropTarget } from '../../../../shared/split'
import { invoke } from '../../api'
import type { DropPreview, PaneEngine } from './engine'

/**
 * How long a dragged link rests before the drop indicator shows. A drag that only passes over the
 * page, on its way to a text field, the sidebar or another app, leaves the panes where they are.
 */
const REST_MS = 250
/** Moving less than this (DIP) still counts as resting. */
const REST_RADIUS = 12
/** A drag that leaves the page or Orbit's surface without coming back this soon has gone. */
const GONE_MS = 120

/**
 * A link dragged out of a page onto a pane shows the drop indicator where it would open once it
 * rests there, and dropping it while the indicator shows opens it in a new pane there (SV-08), with
 * the zones of a dragged tab (SV-04). Over a page main relays the drag (`split:linkDrag`); over
 * Orbit's own surface inside the frame (the indicator, the gaps) the shell hears it itself. A full
 * split shows nothing and takes no drop.
 */
export function useLinkDrop(engine: PaneEngine, setDrop: (preview: DropPreview | null) => void): void {
  useEffect(() => {
    /** The indicator's zone while it shows. */
    let zone: DropTarget | null = null
    /** Where the drag started resting, and where it is now, until the indicator shows. */
    let resting: { x: number; y: number; at: { x: number; y: number } } | null = null
    /** The page under the pointer has the drag (main says so). */
    let overPage = false
    /** Orbit's own surface has the drag. */
    let overShell = false
    let rest = 0
    let gone = 0

    const zoneAt = (x: number, y: number): DropTarget | null => {
      const t = engine.dropTargetFor(x, y, LINK_DROP_ID)
      return t && !t.full ? { target: t.target, side: t.side } : null
    }
    const show = (z: DropTarget | null) => {
      if (z?.target === zone?.target && z?.side === zone?.side) return
      zone = z
      // Drawn in the next frame, as a dragged tab's zone is (FL-18).
      flushSync(() => setDrop(z ? { tabId: LINK_DROP_ID, target: z.target, side: z.side, link: true } : null))
    }
    const over = (x: number, y: number) => {
      window.clearTimeout(gone)
      if (zone) {
        show(zoneAt(x, y))
        return
      }
      if (resting && Math.hypot(x - resting.x, y - resting.y) <= REST_RADIUS) {
        resting.at = { x, y }
        return
      }
      resting = { x, y, at: { x, y } }
      window.clearTimeout(rest)
      rest = window.setTimeout(() => {
        const r = resting
        resting = null
        if (r && (overPage || overShell)) show(zoneAt(r.at.x, r.at.y))
      }, REST_MS)
    }
    const reset = () => {
      window.clearTimeout(rest)
      window.clearTimeout(gone)
      resting = null
    }
    const leave = () => {
      window.clearTimeout(gone)
      gone = window.setTimeout(() => {
        if (overPage || overShell) return
        reset()
        show(null)
      }, GONE_MS)
    }
    const drop = (x: number, y: number, url: string | null) => {
      // Only a drop the indicator showed opens a pane.
      const at = zone && url ? zoneAt(x, y) : null
      reset()
      overPage = false
      overShell = false
      zone = null
      if (!at || !url) {
        setDrop(null)
        return
      }
      void invoke('split.openUrl', { url, target: at.target, side: at.side }).finally(() => setDrop(null))
    }

    const off = window.orbit.on('split:linkDrag', (payload) => {
      const { phase, x, y, url } = payload as LinkDragMessage
      if (phase === 'over') {
        overPage = true
        over(x, y)
      } else if (phase === 'leave') {
        overPage = false
        leave()
      } else drop(x, y, url ?? null)
    })

    // A link over the frame, where a pane can still open.
    const ours = (e: DragEvent) =>
      !e.defaultPrevented &&
      !!e.dataTransfer &&
      carriesLink([...e.dataTransfer.types]) &&
      zoneAt(e.clientX, e.clientY) !== null
    // Entering another element (the indicator appearing under the pointer, say) must accept the
    // link too, or the drop that follows is refused.
    const onEnter = (e: DragEvent) => {
      if (!ours(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onOver = (e: DragEvent) => {
      if (!ours(e)) {
        if (overShell) {
          overShell = false
          leave()
        }
        return
      }
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      overShell = true
      over(e.clientX, e.clientY)
    }
    const onLeave = () => {
      if (!overShell) return
      // Moving onto another element of the shell comes with a dragover at once.
      overShell = false
      leave()
    }
    const onDrop = (e: DragEvent) => {
      if (!ours(e)) return
      e.preventDefault()
      drop(e.clientX, e.clientY, droppedLink(e.dataTransfer?.getData('text/uri-list') ?? ''))
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      off()
      reset()
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [engine, setDrop])
}
