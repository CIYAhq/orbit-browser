import type { PageReferrer } from '../nav'
import type { LayoutPath, PaneSide, SplitAxis } from '../split'
import type { ContainerRef, SplitId, TabId } from '../state'

/** Owned by the split lane (Split View, spec split-view.md SV-*). */
export interface SplitCommands {
  /**
   * Makes a split from 2–4 tabs (e.g. a multi-selection, SV-06). Panes are ordered as the
   * tabs appear in the sidebar; the split takes the first tab's place. Returns null (with a
   * toast) when more than 4 tabs are given.
   */
  'split.create': {
    args: { tabIds: TabId[]; orientation?: SplitAxis; focus?: TabId }
    result: SplitId | null
  }
  /**
   * Puts a tab beside a pane (drop on the page or on a tab row, SV-04/SV-05): joins the
   * target's split or makes a new split in the target's place. Null when refused (full).
   */
  'split.addTab': { args: { tabId: TabId; target: TabId; side?: PaneSide; focus?: boolean }; result: SplitId | null }
  /** New empty pane beside the focused pane, with the command bar open to fill it (SV-02/SV-03). */
  'split.addPane': { args: { side?: PaneSide }; result: void }
  /**
   * Opens a URL in a new pane beside a tab (link → split, SV-08); `referrer` is the page the link
   * was on, sent as its referrer (review B-F1).
   */
  'split.openUrl': {
    args: { url: string; target: TabId; side?: PaneSide; referrer?: PageReferrer }
    result: SplitId | null
  }
  /** Closes one pane; its tab is archived like a closed Today tab (SV-17). */
  'split.closePane': { args: { tabId: TabId }; result: void }
  /** Closes the whole split as one unit (SV-19). */
  'split.close': { args: { splitId: SplitId }; result: void }
  /** Every pane becomes an ordinary tab in the split's place (SV-18). */
  'split.separate': { args: { splitId: SplitId }; result: void }
  /** Takes one pane out as an ordinary tab after the split. */
  'split.popOut': { args: { tabId: TabId }; result: void }
  'split.flip': { args: { splitId: SplitId }; result: void }
  /** Sets the sizes of the container at `path` (end of a divider drag, SV-13). */
  'split.resize': { args: { splitId: SplitId; path: LayoutPath; sizes: number[] }; result: void }
  /** Equal sizes around one divider (double-click), or everywhere. */
  'split.equalize': { args: { splitId: SplitId; path?: LayoutPath; index?: number }; result: void }
  'split.focusPane': { args: { tabId: TabId }; result: void }
  /** Swaps two panes of one split (SV-20). */
  'split.swap': { args: { a: TabId; b: TabId }; result: void }
  /** Moves a pane past its neighbour in a direction (SV-20). */
  'split.movePane': { args: { tabId: TabId; direction: PaneSide }; result: void }
  'split.duplicate': { args: { splitId: SplitId }; result: SplitId | null }
  /** Moves a whole split (pin/unpin, Favorites, another Space), keeping panes, sizes and orientation (SV-23). */
  'split.move': { args: { splitId: SplitId; to: ContainerRef; index?: number }; result: boolean }
  /** Names a split (null or blank clears it, showing the pane titles again) (SV-22). */
  'split.rename': { args: { splitId: SplitId; name: string | null }; result: void }
  /** Gives a split an emoji icon in place of its panes' favicons; null removes it (SV-21, SV-22). */
  'split.setIcon': { args: { splitId: SplitId; icon: string | null }; result: void }
  /** Brings every pane of a pinned or Favorite split back to its own pinned page (SV-23). */
  'split.reset': { args: { splitId: SplitId }; result: void }
  /** Right-click menu of a split row (SV-22). */
  'split.contextMenu': { args: { splitId: SplitId }; result: void }
  /** The split-controls menu of a pane (SV-12). */
  'split.paneMenu': { args: { tabId: TabId }; result: void }
  /** The pane the strip currently belongs to (the strip asks once its page has loaded). */
  'split.stripTarget': { args: Record<string, never>; result: { tabId: TabId | null } }
  /** The pane strip relays a drag of its pane (strip-view coordinates) to the frame (SV-20). */
  'split.paneDrag': {
    args: { tabId: TabId; phase: 'start' | 'move' | 'end' | 'cancel'; x: number; y: number }
    result: void
  }
  /** The pane strip reports pointer hover so it stays while used (SV-12). */
  'split.stripHover': { args: { hovered: boolean }; result: void }
}
