import { useEffect } from 'react'
import type { DropTarget } from '../../../../shared/split'
import type { TabId } from '../../../../shared/state'
import { invoke } from '../../api'
import { activeTabId } from '../../selectors'
import { getOrbitState } from '../../store'
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
      drag = null
      zone = null
      setDrop(null)
    }
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      const el = (e.target as Element | null)?.closest?.(SOURCE) as HTMLElement | null
      const tabId = el?.dataset.tabId
      if (!el || !tabId || !el.closest('[data-testid="sidebar"]')) return
      drag = { tabId, x: e.clientX, y: e.clientY, before: activeTabId(getOrbitState()), active: false, reverted: false }
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
      }
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
      if (sameZone(next, zone) && !!next?.full === !!zone?.full) return
      zone = next
      setDrop(next && !next.full ? { ...next, tabId: drag.tabId } : null)
    }
    const onUp = () => {
      const d = drag
      const z = zone
      drag = null
      zone = null
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
