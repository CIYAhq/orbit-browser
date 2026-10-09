import { useEffect } from 'react'
import { invoke } from '../../api'
import { activeTabId } from '../../selectors'
import { getOrbitState } from '../../store'

/**
 * ⌥-click (Alt-click on Windows/Linux) a tab row (SV-09): another tab joins the current one
 * as a split on the right; the selected tab opens a copy of itself beside it. ⌘⌥ / Ctrl+Alt
 * stays free for the Mini Window. (⌥-click on a split row separates it; see SplitRow.)
 */
export function useAltClickSplit(): void {
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || !e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return
      const row = (e.target as Element | null)?.closest?.('[data-testid="tab-row"][data-tab-id]') as HTMLElement | null
      const tabId = row?.dataset.tabId
      if (!row || !tabId || !row.closest('[data-testid="sidebar"]')) return
      const state = getOrbitState()
      const current = activeTabId(state)
      if (!current) return
      // Keep the row's own press handling (select, drag) out of it.
      e.preventDefault()
      e.stopPropagation()
      if (tabId === current) {
        const url = state.tabs[tabId]?.url
        if (url && url !== 'about:blank') void invoke('split.openUrl', { url, target: tabId })
      } else void invoke('split.addTab', { tabId, target: current, side: 'right' })
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [])
}
