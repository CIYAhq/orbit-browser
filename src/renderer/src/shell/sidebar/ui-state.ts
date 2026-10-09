/**
 * Sidebar-local UI state (not part of OrbitState): inline rename, multi-selection,
 * keyboard focus and the drag session. Small zustand stores so rows subscribe to
 * exactly the bit they draw.
 */
import { create } from 'zustand'
import type { ItemId, TabId } from '../../../../shared/state'
import type { DropTarget } from './dnd-model'

/** Inline rename field (TB-12, FD-03) or pinned-URL editor (PN-07). */
export const useRename = create<{ id: ItemId | null; isNew: boolean; mode: 'name' | 'url' }>(() => ({
  id: null,
  isNew: false,
  mode: 'name',
}))

export function startRename(id: ItemId, opts: { isNew?: boolean; mode?: 'name' | 'url' } = {}): void {
  useRename.setState({ id, isNew: !!opts.isNew, mode: opts.mode ?? 'name' })
}

export function stopRename(): void {
  useRename.setState({ id: null, isNew: false, mode: 'name' })
}

/** Folder whose search popover is open (FD-08). */
export const useFolderSearch = create<{ id: ItemId | null }>(() => ({ id: null }))

/** Emoji picker target (TB-12, FD-07). */
export const useIconPicker = create<{ id: ItemId | null }>(() => ({ id: null }))

/** Multi-selection (TB-13): ordered tab ids plus the range anchor. Main hears about it for ⌘W and ⌘⇧C. */
export const useSelection = create<{ ids: TabId[]; anchor: TabId | null }>(() => ({ ids: [], anchor: null }))

useSelection.subscribe((next, prev) => {
  if (next.ids !== prev.ids) void window.orbit.invoke('tabs.setSelection', { tabIds: next.ids })
})

export function clearSelection(): void {
  if (useSelection.getState().ids.length > 0) useSelection.setState({ ids: [], anchor: null })
}

/** Keyboard focus inside the sidebar (SB-22): the row that has the focus ring. */
export const useKeyboardFocus = create<{ id: ItemId | null }>(() => ({ id: null }))

export type DragPhase = 'idle' | 'dragging' | 'committing' | 'landing' | 'cancelling'

export interface GhostInfo {
  /** Dragged ids (first is the grabbed one). */
  ids: ItemId[]
  source: 'list' | 'favorites'
  width: number
  height: number
}

export interface DragState {
  phase: DragPhase
  ghost: GhostInfo | null
  /** Items drawn invisible (being dragged or landing under the ghost). */
  hidden: Record<string, true>
  /** Vertical offset per row key while dragging. */
  shifts: Record<string, number>
  target: DropTarget | null
  /** Favorites grid insertion index while hovering the grid. */
  favIndex: number | null
  /** Folder row highlighted for a drop-into. */
  intoFolder: string | null
  /** Space switcher target under the pointer. */
  spaceTarget: string | null
  /** Pointer is outside the window (drop makes a new window). */
  outside: boolean
}

export const IDLE_DRAG: DragState = {
  phase: 'idle',
  ghost: null,
  hidden: {},
  shifts: {},
  target: null,
  favIndex: null,
  intoFolder: null,
  spaceTarget: null,
  outside: false,
}

export const useDrag = create<DragState>(() => IDLE_DRAG)
