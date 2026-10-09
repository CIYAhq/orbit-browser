import { focusedPaneOfSplit, layoutLeaves, paneOrder } from '../../../../shared/split'
import type { OrbitState } from '../../../../shared/state'
import { activeTabId } from '../../selectors'

/** Pane ids of a split in reading order, joined (a stable string for selectors). */
export function paneOrderKey(s: OrbitState, splitId: string): string {
  const split = s.splits[splitId]
  return split ? paneOrder(split.layout).join(',') : ''
}

/** The pane of a split the window currently focuses, or '' when the split isn't shown. */
export function focusedPaneOf(s: OrbitState, splitId: string): string {
  const active = activeTabId(s)
  const split = s.splits[splitId]
  return active && split && layoutLeaves(split.layout).includes(active) ? active : ''
}

/** The pane focused last (selecting the split returns to it, SV-14). */
export function lastFocusedPane(s: OrbitState, splitId: string): string | undefined {
  return focusedPaneOfSplit(s, splitId)
}
