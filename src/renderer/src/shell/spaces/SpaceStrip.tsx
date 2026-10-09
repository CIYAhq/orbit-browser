import { Plus } from 'lucide-react'
import { memo, useDeferredValue, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { SpaceId } from '../../../../shared/state'
import { useOrbit } from '../../store'
import { NewSpaceFlow } from './NewSpaceFlow'
import { requestRename } from './rename-request'
import { SpaceContent } from './SpaceContent'
import { SpacePreview } from './SpacePreview'
import { switcher } from './switcher'
import './spaces.css'

/**
 * The per-Space part of the sidebar as a horizontal strip of pages (FL-13):
 * slot 0 is the active Space's real content, neighbours are light previews
 * that exist only while a swipe or switch animation needs them. Two-finger
 * swipes (wheel deltaX) and touch drags anywhere over the sidebar move it.
 */
export const SpaceStrip = memo(function SpaceStrip({ windowId, spaceId }: { windowId: string; spaceId: SpaceId }) {
  const order = useOrbit((s) => s.spaceOrder)
  const { slots, newPage } = useSyncExternalStore(switcher.subscribe, switcher.getSnapshot)
  const viewportRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  // The real page follows a deferred Space id: after a switch a light stand-in paints the
  // destination at once and the full list (hundreds of rows) renders concurrently while the
  // strip slides, so a switch never blocks a frame on mounting rows (review M5).
  const shownSpace = useDeferredValue(spaceId)
  const standIn = shownSpace !== spaceId
  useLayoutEffect(() => {
    switcher.setStandIn(standIn)
  }, [standIn])

  useLayoutEffect(() => {
    switcher.syncActive(spaceId, order)
  }, [spaceId, order])

  // Pages were added or removed: repaint Favorites layers and emphasis for the new DOM.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after every slot change
  useLayoutEffect(() => {
    switcher.refresh()
  }, [slots])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    switcher.attach(trackRef.current, () =>
      viewport.querySelector<HTMLElement>('[data-slot="0"] .space-slot__real .sidebar__scroll'),
    )
    switcher.setSize(viewport.clientWidth, viewport.clientHeight)
    const observer = new ResizeObserver(() => switcher.setSize(viewport.clientWidth, viewport.clientHeight))
    observer.observe(viewport)
    const sidebar = viewport.closest<HTMLElement>('.sidebar') ?? viewport
    sidebar.addEventListener('wheel', switcher.onWheel, { passive: false })
    sidebar.addEventListener('pointerdown', switcher.onPointerDown)
    sidebar.addEventListener('pointermove', switcher.onPointerMove)
    sidebar.addEventListener('pointerup', switcher.onPointerUp)
    sidebar.addEventListener('pointercancel', switcher.onPointerUp)
    return () => {
      observer.disconnect()
      sidebar.removeEventListener('wheel', switcher.onWheel)
      sidebar.removeEventListener('pointerdown', switcher.onPointerDown)
      sidebar.removeEventListener('pointermove', switcher.onPointerMove)
      sidebar.removeEventListener('pointerup', switcher.onPointerUp)
      sidebar.removeEventListener('pointercancel', switcher.onPointerUp)
      switcher.attach(null, () => null)
    }
  }, [])

  // Messages from main: key presses at the ends, and the new-Space flow.
  useEffect(() => {
    const offNudge = window.orbit.on('spaces:nudge', (p) => switcher.nudge((p as { direction: number }).direction))
    const offFlow = window.orbit.on('spaces:new-flow', () => switcher.openFlow())
    const offRename = window.orbit.on('spaces:rename', (p) => requestRename((p as { spaceId: string }).spaceId))
    return () => {
      offNudge()
      offFlow()
      offRename()
    }
  }, [])

  const flowOpen = newPage === 'flow'
  return (
    <div className={`space-strip${flowOpen ? ' is-flow' : ''}`} ref={viewportRef} data-testid="space-strip">
      <div className="space-strip__track" ref={trackRef}>
        <div className="space-slot" data-slot="0" inert={flowOpen}>
          {standIn ? <SpacePreview spaceId={spaceId} windowId={windowId} height={switcher.height} standIn /> : null}
          <div className="space-slot__real" hidden={standIn}>
            <SpaceContent spaceId={shownSpace} stale={standIn} />
          </div>
        </div>
        {slots
          .filter((s) => s.k !== 0)
          .map((s) =>
            s.id === 'new' ? (
              <div
                key="new"
                className="space-slot space-slot--new"
                data-slot={s.k}
                data-testid="new-space-page"
                style={{ left: `${s.k * 100}%` }}
                inert={!flowOpen}
              >
                {flowOpen ? <NewSpaceFlow windowId={windowId} /> : <NewSpaceHint />}
              </div>
            ) : (
              <div
                key={s.id}
                className="space-slot space-slot--preview"
                data-slot={s.k}
                data-preview-space={s.id}
                style={{ left: `${s.k * 100}%` }}
                inert
              >
                <SpacePreview spaceId={s.id} windowId={windowId} height={switcher.height} />
              </div>
            ),
          )}
      </div>
    </div>
  )
})

/** What shows past the last Space while over-swiping: a faint "+" (SP-08). */
function NewSpaceHint() {
  return (
    <div className="new-space-hint" ref={switcher.registerNewHint} data-testid="new-space-hint">
      <span className="new-space-hint__plus">
        <Plus size={22} strokeWidth={2} />
      </span>
      <span>New Space</span>
    </div>
  )
}
