/**
 * Pure drag-and-drop geometry for the sidebar list (TB-08, FD-05). No DOM access:
 * the controller measures rows into `Slot`s and asks this module where a drop lands
 * and how far each row must move to open the gap.
 *
 * Coordinates are "content" coordinates of the scroll container (scrollTop included),
 * so measurements stay valid while the list auto-scrolls.
 */

export interface Slot {
  /** Item id, or "divider" for the divider + New Tab block. */
  key: string
  kind: 'item' | 'divider'
  /** Container key of the list that holds the item (see tree.containerKey). */
  container: string
  /** Index of the item in its container (including items being dragged). */
  index: number
  depth: number
  /** Folder header rows. */
  folder?: 'open' | 'closed'
  /** Key of the folder whose (visible) children this slot belongs to, recursively (for exclusion). */
  ancestors: string[]
  top: number
  height: number
  /** Divider block: offset of the divider line from the slot top (above it = pinned). */
  splitAt?: number
}

export type DropTarget =
  | {
      type: 'between'
      container: string
      /** Index in the target list without the dragged items (what tabs.move expects). */
      index: number
      /** Index in the target list as it is now, dragged items included (for an ⌥-drag copy). */
      rawIndex: number
      depth: number
      /** Position in the remaining slots where the gap opens. */
      at: number
      /** Content-y where the dragged block's top lands. */
      gapTop: number
    }
  | { type: 'into'; folderId: string; at: number; gapTop: number }

/** Spacing between rows (matches the list's CSS gap). */
export const ROW_GAP = 1

export function isDragged(slot: Slot, dragged: Set<string>): boolean {
  return dragged.has(slot.key) || slot.ancestors.some((a) => dragged.has(a))
}

/** Total height of the dragged rows (folders include their visible children). */
export function draggedHeight(slots: Slot[], dragged: Set<string>): number {
  return slots.filter((s) => isDragged(s, dragged)).reduce((sum, s) => sum + s.height + ROW_GAP, 0)
}

/** How many dragged items sit before `index` in `container` (to convert to a post-removal index). */
function draggedBefore(slots: Slot[], dragged: Set<string>, container: string, index: number): number {
  return slots.filter((s) => s.kind === 'item' && dragged.has(s.key) && s.container === container && s.index < index)
    .length
}

/**
 * Where a drop at content-y `y` lands. Rows split in halves (before / after); closed
 * folders have a middle band that drops *into* the folder; an open folder's lower half
 * drops at the top of its children; the divider's upper half is the end of the pinned
 * section and its lower half the top of Today.
 */
export function computeDropTarget(
  slots: Slot[],
  y: number,
  dragged: Set<string>,
  opts: {
    pinnedContainer: string
    todayContainer: string
    /** Real list lengths and how many dragged items they hold (rows of a collapsed section aren't measured). */
    counts?: Record<string, { length: number; dragged: number }>
  },
): DropTarget {
  const remaining = slots.filter((s) => !isDragged(s, dragged))
  const between = (container: string, rawIndex: number, depth: number, at: number): DropTarget => ({
    type: 'between',
    container,
    index: rawIndex - draggedBefore(slots, dragged, container, rawIndex),
    rawIndex,
    depth,
    at,
    gapTop: gapTopAt(slots, remaining, at, dragged),
  })
  const endOf = (container: string, at: number): DropTarget => {
    const known = opts.counts?.[container]
    const measuredRaw = slots.filter((s) => s.kind === 'item' && s.depth === 0 && s.container === container).length
    const raw = known?.length ?? measuredRaw
    const draggedHere =
      known?.dragged ??
      slots.filter((s) => s.kind === 'item' && s.depth === 0 && s.container === container && dragged.has(s.key)).length
    return {
      type: 'between',
      container,
      index: raw - draggedHere,
      rawIndex: raw,
      depth: 0,
      at,
      gapTop: gapTopAt(slots, remaining, at, dragged),
    }
  }
  const i = remaining.findIndex((s) => y < s.top + s.height + ROW_GAP)
  if (i < 0) return endOf(opts.todayContainer, remaining.length)
  const s = remaining[i] as Slot
  const rel = (y - s.top) / Math.max(1, s.height)
  if (s.kind === 'divider') {
    const split = s.splitAt ?? s.height / 2
    return y - s.top < split ? endOf(opts.pinnedContainer, i) : between(opts.todayContainer, 0, 0, i + 1)
  }
  if (s.folder === 'closed') {
    if (rel < 0.25) return between(s.container, s.index, s.depth, i)
    if (rel <= 0.75) return { type: 'into', folderId: s.key, at: i, gapTop: s.top - heightAbove(slots, s, dragged) }
    return between(s.container, s.index + 1, s.depth, i + 1)
  }
  if (s.folder === 'open') {
    if (rel < 0.5) return between(s.container, s.index, s.depth, i)
    return between(`folder:${s.key}`, 0, s.depth + 1, i + 1)
  }
  if (rel < 0.5) return between(s.container, s.index, s.depth, i)
  return between(s.container, s.index + 1, s.depth, i + 1)
}

/** Content-y of the gap that opens before remaining slot `at`. */
function gapTopAt(slots: Slot[], remaining: Slot[], at: number, dragged: Set<string>): number {
  const next = remaining[at]
  if (next) return next.top - heightAbove(slots, next, dragged)
  const last = remaining[remaining.length - 1]
  if (!last) return 0
  return last.top - heightAbove(slots, last, dragged) + last.height + ROW_GAP
}

/** Height of dragged rows above a slot in the original layout. */
function heightAbove(slots: Slot[], slot: Slot, dragged: Set<string>): number {
  let h = 0
  for (const s of slots) {
    if (s === slot) break
    if (isDragged(s, dragged)) h += s.height + ROW_GAP
  }
  return h
}

/**
 * Vertical offset per remaining row so the list shows the gap at the drop target
 * (and closes the gap the dragged rows left). `target` undefined means the rows leave
 * this list (Favorites, another Space or window).
 */
export function rowShifts(slots: Slot[], dragged: Set<string>, target: DropTarget | undefined): Record<string, number> {
  const H = draggedHeight(slots, dragged)
  const remaining = slots.filter((s) => !isDragged(s, dragged))
  const out: Record<string, number> = {}
  remaining.forEach((s, i) => {
    let shift = -heightAbove(slots, s, dragged)
    if (target && target.type === 'between' && i >= target.at) shift += H
    if (shift !== 0) out[s.key] = shift
  })
  return out
}

/** Favorites grid drop index from tile centres (row-major). */
export function gridDropIndex(
  tiles: { left: number; top: number; width: number; height: number }[],
  x: number,
  y: number,
): number {
  if (tiles.length === 0) return 0
  let best = 0
  let bestDist = Number.POSITIVE_INFINITY
  tiles.forEach((t, i) => {
    const cx = t.left + t.width / 2
    const cy = t.top + t.height / 2
    const d = (cx - x) ** 2 + ((cy - y) * 1.5) ** 2
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  })
  const t = tiles[best] as { left: number; top: number; width: number; height: number }
  return x > t.left + t.width / 2 ? best + 1 : best
}
