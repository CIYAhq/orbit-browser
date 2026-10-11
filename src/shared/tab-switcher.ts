import type { OverlayState, TabId } from './state'

/** The recent-tab switcher's overlay panel (TB-05): the tabs it lists and the highlighted one. */
export const TAB_SWITCHER_PANEL = 'tab-switcher'

/**
 * What the switcher shows: its tabs, the one shown when it opened first, and the highlighted one.
 * The panel opens at the first Tab, with the keyboard; the list is drawn (`shown`) after a hold or
 * at the second Tab (FL-26).
 */
export interface SwitcherList {
  tabs: TabId[]
  index: number
  shown: boolean
}

/** The panel's params for a list (tab ids have no spaces). */
export function switcherParams(tabs: readonly TabId[], index: number, shown: boolean): Record<string, string | number> {
  return { tabs: tabs.join(' '), index, shown: shown ? 1 : 0 }
}

/** The switcher an overlay shows; null when it shows something else. */
export function switcherOf(overlay: OverlayState | undefined): SwitcherList | null {
  if (overlay?.kind !== 'panel' || overlay.panel !== TAB_SWITCHER_PANEL) return null
  const tabs = typeof overlay.params?.tabs === 'string' ? overlay.params.tabs.split(' ').filter(Boolean) : []
  const index = typeof overlay.params?.index === 'number' ? overlay.params.index : 0
  return { tabs, index, shown: overlay.params?.shown === 1 }
}
