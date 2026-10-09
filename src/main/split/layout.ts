/**
 * Main-side pane geometry for the window manager's fast path: when the selection moves
 * to an unrelated item (another tab or another split), main places the views at once
 * from the last known frame rect, without waiting for the shell to re-report.
 * Pure (no Electron imports).
 */
import type { Rect } from '../../shared/rpc'
import { layoutBoxes, layoutLeaves, PANE_GAP } from '../../shared/split'
import type { OrbitState, TabId } from '../../shared/state'
import { splitOfTab } from '../../shared/tree'
import { isBlankPane } from './model'

export interface PlacedPane {
  tabId: TabId
  rect: Rect
}

/** Panes with a page to draw for the item that holds `tabId` (blank panes are drawn by the shell). */
export function panesFor(state: OrbitState, tabId: TabId, frame: Rect): PlacedPane[] {
  const splitId = splitOfTab(state, tabId)
  const split = splitId ? state.splits[splitId] : undefined
  if (!split) return [{ tabId, rect: frame }]
  return layoutBoxes(split.layout, frame, PANE_GAP).panes.filter((p) => !isBlankPane(state.tabs[p.tabId]))
}

function groupOf(state: OrbitState, tabId: TabId | null): TabId[] {
  if (!tabId) return []
  const splitId = splitOfTab(state, tabId)
  const split = splitId ? state.splits[splitId] : undefined
  return split ? layoutLeaves(split.layout) : [tabId]
}

/**
 * Panes to show right away after the selection changed from `before` (in `prev`) to
 * `tabId` (in `state`), or null when the shell should lay them out itself: a focus
 * change inside one split, or a split that grew from or shrank to the previous
 * selection (those changes animate in the shell).
 */
export function fastSwitchPanes(
  state: OrbitState,
  prev: OrbitState,
  tabId: TabId,
  before: TabId | null,
  frame: Rect,
): PlacedPane[] | null {
  const next = groupOf(state, tabId)
  const old = groupOf(prev, before)
  if (next.some((id) => old.includes(id))) return null
  return panesFor(state, tabId, frame)
}
