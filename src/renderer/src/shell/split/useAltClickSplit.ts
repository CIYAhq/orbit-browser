import { useEffect } from 'react'
import { invoke } from '../../api'
import { activeTabId } from '../../selectors'
import { getOrbitState } from '../../store'

const ROW = '[data-testid="tab-row"][data-tab-id]'
/** More movement than this is a drag (the sidebar's own Alt-drag copies a tab), not a click. */
const CLICK_SLOP = 4

/**
 * ⌥-click (Alt-click on Windows/Linux) a tab row (SV-09): another tab joins the current one
 * as a split on the right; the selected tab opens a copy of itself beside it. It acts on a
 * click without movement, leaving the press and any drag to the sidebar. ⌘⌥ / Ctrl+Alt
 * stays free for the Mini Window. (⌥-click on a split row separates it; see SplitRow.)
 */
export function useAltClickSplit(): void {
  useEffect(() => {
    let press: { tabId: string; x: number; y: number; current: string | null } | null = null
    const rowOf = (target: EventTarget | null) => {
      const row = (target as Element | null)?.closest?.(ROW) as HTMLElement | null
      return row?.closest('[data-testid="sidebar"]') ? row : null
    }
    const onDown = (e: PointerEvent) => {
      press = null
      if (e.button !== 0 || !e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return
      const tabId = rowOf(e.target)?.dataset.tabId
      // The selection before the press (pressing a row selects it).
      if (tabId) press = { tabId, x: e.clientX, y: e.clientY, current: activeTabId(getOrbitState()) }
    }
    const onUp = (e: PointerEvent) => {
      const p = press
      press = null
      if (!p || !e.altKey || Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_SLOP) return
      if (rowOf(e.target)?.dataset.tabId !== p.tabId || !p.current) return
      if (p.tabId === p.current) {
        const url = getOrbitState().tabs[p.tabId]?.url
        if (url && url !== 'about:blank') void invoke('split.openUrl', { url, target: p.tabId })
      } else void invoke('split.addTab', { tabId: p.tabId, target: p.current, side: 'right' })
    }
    const cancel = () => {
      press = null
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('pointerup', onUp, true)
    document.addEventListener('pointercancel', cancel, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('pointerup', onUp, true)
      document.removeEventListener('pointercancel', cancel, true)
    }
  }, [])
}
