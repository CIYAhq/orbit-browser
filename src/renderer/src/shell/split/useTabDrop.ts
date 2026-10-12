import { useEffect } from 'react'
import { flushSync } from 'react-dom'
import { type DropTarget, leaf, type PaneBox } from '../../../../shared/split'
import type { TabId } from '../../../../shared/state'
import { splitOfTab } from '../../../../shared/tree'
import { invoke } from '../../api'
import { activeTabId } from '../../selectors'
import { getOrbitState } from '../../store'
import { type LinkDropMode, type PageLinks, pageLinks } from '../sidebar/page-link-drop'
import type { DropPreview, PaneEngine } from './engine'

const DRAG_THRESHOLD = 6
const SOURCE = '[data-testid="tab-row"][data-tab-id], [data-testid="favorite-tile"][data-tab-id]'

interface TabDrag {
  tabId: TabId
  x: number
  y: number
  /** Selection when the press started (pressing a row selects it, FL-05). */
  before: TabId | null
  active: boolean
  reverted: boolean
  /** Where the page under the row takes its link, the link goes there instead (TB-09). */
  links?: PageLinks
  /** What the row does where it is now. */
  mode: LinkDropMode
  at?: { x: number; y: number }
}

const sameZone = (a: DropTarget | null, b: DropTarget | null) => a?.target === b?.target && a?.side === b?.side

/**
 * Drag a tab row from the sidebar over the page to make a split (SV-04). The sidebar's own
 * drag-and-drop keeps handling reordering; this only watches the same pointer stream and,
 * while the pointer is over the content frame, shows where the tab would go. Releasing there
 * adds it as a pane. Escape or leaving the frame cancels.
 */
export function useTabDrop(engine: PaneEngine, setDrop: (preview: DropPreview | null) => void): void {
  useEffect(() => {
    let drag: TabDrag | null = null
    let zone: (DropTarget & { full?: boolean }) | null = null
    const reset = () => {
      drag?.links?.end()
      drag = null
      zone = null
      setDrop(null)
    }
    // The split the row would make here, unless the page there takes its link, or is still saying
    // where it does (TB-09).
    const show = (d: TabDrag, target = d.at ? engine.dropTargetFor(d.at.x, d.at.y, d.tabId) : null) => {
      const next = d.mode === 'split' ? target : null
      if (sameZone(next, zone) && !!next?.full === !!zone?.full) return
      zone = next
      const tabId = d.tabId
      // Drawn in the frame after the move, not after a render of its own (FL-18: the zone shows
      // within a frame or two and moves to a new half at once).
      flushSync(() => setDrop(next && !next.full ? { ...next, tabId } : null))
    }
    // Over the page, once the page the drag began on is back (FL-05), its pages say where they take
    // the row's link, as they are drawn before any preview makes room.
    const follow = (d: TabDrag) => {
      const at = d.at
      if (!at || !d.links) return
      if (!engine.contains(at.x, at.y)) {
        d.links.away()
        d.mode = 'split'
        return
      }
      const panes = engine.paneBoxes()
      const back = !d.reverted || !panes.some((p) => p.tabId === d.tabId)
      if (back) d.links.panes(panes)
      d.mode = back ? d.links.at(at.x, at.y) : 'split'
    }
    const startPanes = (d: TabDrag): PaneBox[] => {
      if (!d.before || d.before === d.tabId) return engine.paneBoxes()
      const s = getOrbitState()
      const splitId = splitOfTab(s, d.before)
      return engine.boxesOf((splitId && s.splits[splitId]?.layout) || leaf(d.before))
    }
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      const el = (e.target as Element | null)?.closest?.(SOURCE) as HTMLElement | null
      const tabId = el?.dataset.tabId
      if (!el || !tabId || !el.closest('[data-testid="sidebar"]')) return
      drag = {
        tabId,
        x: e.clientX,
        y: e.clientY,
        before: activeTabId(getOrbitState()),
        active: false,
        reverted: false,
        mode: 'split',
      }
    }
    const onMove = (e: PointerEvent) => {
      if (!drag) return
      if ((e.buttons & 1) === 0) {
        reset()
        return
      }
      if (!drag.active) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_THRESHOLD) return
        drag.active = true
        const d = drag
        d.links = pageLinks(d.tabId, () => {
          if (drag !== d || !d.at || !d.links || !engine.contains(d.at.x, d.at.y)) return
          d.mode = d.links.at(d.at.x, d.at.y)
          show(d)
        })
        // Asked at once, before the row reaches the page: the pages it will be over are those of the
        // page the drag began on, which comes back then (FL-05).
        d.links?.panes(startPanes(d))
      }
      drag.at = { x: e.clientX, y: e.clientY }
      const next = engine.dropTargetFor(e.clientX, e.clientY, drag.tabId)
      if (
        !next &&
        !drag.reverted &&
        engine.contains(e.clientX, e.clientY) &&
        drag.before &&
        drag.before !== drag.tabId &&
        activeTabId(getOrbitState()) === drag.tabId
      ) {
        // The press selected the dragged tab; over the page, show the page the drag started from.
        drag.reverted = true
        void invoke('tabs.activate', { tabId: drag.before })
        return
      }
      follow(drag)
      show(drag, next)
    }
    const onUp = (e: PointerEvent) => {
      const d = drag
      const z = zone
      drag = null
      zone = null
      if (d?.active && d.links && d.mode === 'link') {
        // The page takes the row's link where it was released (TB-09).
        void d.links.drop(e.clientX, e.clientY)
        setDrop(null)
        return
      }
      d?.links?.end()
      if (!d?.active || !z) {
        setDrop(null)
        return
      }
      // A full split refuses the tab with a toast (SV-25); otherwise the tab joins the page.
      void invoke('split.addTab', { tabId: d.tabId, target: z.target, side: z.side }).finally(() => setDrop(null))
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && drag?.active) reset()
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('pointermove', onMove, true)
    document.addEventListener('pointerup', onUp, true)
    document.addEventListener('pointercancel', reset, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', reset)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('pointermove', onMove, true)
      document.removeEventListener('pointerup', onUp, true)
      document.removeEventListener('pointercancel', reset, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', reset)
    }
  }, [engine, setDrop])
}

interface PaneDragMessage {
  phase: 'start' | 'move' | 'end' | 'cancel'
  tabId: TabId
  x: number
  y: number
}

/**
 * Drag a pane by its strip onto another pane (SV-20): the centre swaps the two, an edge
 * moves the pane to that side. The strip is its own view, so main relays its pointer
 * (in window coordinates) here; the frame previews the result live.
 */
export function usePaneDrag(engine: PaneEngine, setDrop: (preview: DropPreview | null) => void): void {
  useEffect(() => {
    let zone: { target: TabId; side: DropPreview['side'] } | null = null
    return window.orbit.on('split:paneDrag', (payload) => {
      const { phase, tabId, x, y } = payload as PaneDragMessage
      if (phase === 'move') {
        const next = engine.paneDropTargetFor(x, y, tabId)
        if (next?.target === zone?.target && next?.side === zone?.side) return
        zone = next
        flushSync(() => setDrop(next ? { tabId, target: next.target, side: next.side, move: true } : null))
        return
      }
      const z = zone
      zone = null
      if (phase !== 'end' || !z) {
        setDrop(null)
        return
      }
      const done =
        z.side === 'center'
          ? invoke('split.swap', { a: tabId, b: z.target })
          : invoke('split.addTab', { tabId, target: z.target, side: z.side })
      void done.finally(() => setDrop(null))
    })
  }, [engine, setDrop])
}
