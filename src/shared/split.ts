/**
 * Split View layout tree: pure operations and geometry shared by the main
 * process (state changes, fast layout) and the shell (rendering, dividers,
 * drop zones). Owned by the split lane.
 *
 * A layout is a tree of `row` (children side by side, left → right) and
 * `column` (children stacked, top → bottom) containers whose leaves are tabs.
 * `sizes` are fractions of the container's free length (gaps excluded) and sum
 * to 1. Canonical form: no single-child containers, no container directly
 * inside a container of the same type, at most MAX_PANES leaves.
 */
import type { SplitLayout, TabId } from './state'

export const MAX_PANES = 4
/** Gap between panes in px (matches the frame gutter). */
export const PANE_GAP = 8
export const MIN_PANE_WIDTH = 240
export const MIN_PANE_HEIGHT = 160
/** Dividers snap to these fractions of their container when within SNAP_DISTANCE px. */
export const SNAP_FRACTIONS = [1 / 3, 1 / 2, 2 / 3]
export const SNAP_DISTANCE = 8
export const SPLIT_FULL_MESSAGE = 'Split View holds up to 4 tabs'

export type PaneSide = 'left' | 'right' | 'top' | 'bottom'
export type SplitAxis = 'row' | 'column'
/** Child indexes from the root to a node. */
export type LayoutPath = number[]

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

type Container = Extract<SplitLayout, { type: 'row' | 'column' }>

export const leaf = (tabId: TabId): SplitLayout => ({ type: 'leaf', tabId })

export const axisOfSide = (side: PaneSide): SplitAxis => (side === 'left' || side === 'right' ? 'row' : 'column')
const sideIsBefore = (side: PaneSide) => side === 'left' || side === 'top'

export function layoutLeaves(layout: SplitLayout): TabId[] {
  if (layout.type === 'leaf') return [layout.tabId]
  return layout.children.flatMap(layoutLeaves)
}

export function makeLayout(tabIds: TabId[], axis: SplitAxis = 'row'): SplitLayout {
  if (tabIds.length === 1) return leaf(tabIds[0] as TabId)
  return { type: axis, children: tabIds.map(leaf), sizes: tabIds.map(() => 1 / tabIds.length) }
}

function evenSizes(n: number): number[] {
  return Array.from({ length: n }, () => 1 / n)
}

/** Sizes made finite, positive and summing to 1 (equal sizes when unusable). */
export function fixSizes(sizes: number[] | undefined, n: number): number[] {
  if (!sizes || sizes.length !== n) return evenSizes(n)
  const clean = sizes.map((s) => (Number.isFinite(s) && s > 0 ? s : 0))
  const total = clean.reduce((a, b) => a + b, 0)
  if (!(total > 0) || clean.some((s) => s === 0)) return evenSizes(n)
  return clean.map((s) => s / total)
}

/** Canonical form (see file comment). Returns null for an empty tree. */
export function normalizeLayout(layout: SplitLayout | null | undefined): SplitLayout | null {
  if (!layout) return null
  if (layout.type === 'leaf') return typeof layout.tabId === 'string' && layout.tabId ? layout : null
  const sizes = fixSizes(layout.sizes, layout.children?.length ?? 0)
  const children: SplitLayout[] = []
  const out: number[] = []
  layout.children?.forEach((child, i) => {
    const c = normalizeLayout(child)
    if (!c) return
    const s = sizes[i] ?? 0
    if (c.type === layout.type) {
      // Same direction nested: merge into this container.
      c.children.forEach((g, j) => {
        children.push(g)
        out.push(s * (c.sizes[j] ?? 0))
      })
    } else {
      children.push(c)
      out.push(s)
    }
  })
  if (children.length === 0) return null
  if (children.length === 1) return children[0] as SplitLayout
  return { type: layout.type, children, sizes: fixSizes(out, children.length) }
}

export function leafPath(layout: SplitLayout, tabId: TabId, path: LayoutPath = []): LayoutPath | undefined {
  if (layout.type === 'leaf') return layout.tabId === tabId ? path : undefined
  for (let i = 0; i < layout.children.length; i++) {
    const found = leafPath(layout.children[i] as SplitLayout, tabId, [...path, i])
    if (found) return found
  }
  return undefined
}

export function nodeAt(layout: SplitLayout, path: LayoutPath): SplitLayout | undefined {
  let node: SplitLayout | undefined = layout
  for (const i of path) {
    if (!node || node.type === 'leaf') return undefined
    node = node.children[i]
  }
  return node
}

/** Immutable replacement of the node at `path`. */
function replaceAt(
  layout: SplitLayout,
  path: LayoutPath,
  fn: (node: SplitLayout) => SplitLayout | null,
): SplitLayout | null {
  if (path.length === 0) return fn(layout)
  if (layout.type === 'leaf') return layout
  const [head, ...rest] = path as [number, ...number[]]
  const child = layout.children[head]
  if (!child) return layout
  const next = replaceAt(child, rest, fn)
  const children = [...layout.children]
  const sizes = [...layout.sizes]
  if (next) children[head] = next
  else {
    children.splice(head, 1)
    sizes.splice(head, 1)
  }
  return { ...layout, children, sizes }
}

/**
 * Adds `newTabId` on `side` of the pane showing `targetTabId`. The new pane takes
 * half of the target's space. Returns the layout unchanged if the target is missing,
 * the new tab is already a pane or the split is full.
 */
export function insertPane(layout: SplitLayout, targetTabId: TabId, newTabId: TabId, side: PaneSide): SplitLayout {
  const leaves = layoutLeaves(layout)
  if (leaves.includes(newTabId) || leaves.length >= MAX_PANES) return layout
  const path = leafPath(layout, targetTabId)
  if (!path) return layout
  const axis = axisOfSide(side)
  const before = sideIsBefore(side)
  const parentPath = path.slice(0, -1)
  const index = path[path.length - 1]
  const parent = path.length > 0 ? nodeAt(layout, parentPath) : undefined
  let next: SplitLayout | null
  if (parent && parent.type === axis && index !== undefined) {
    next = replaceAt(layout, parentPath, (node) => {
      const c = node as Container
      const half = (c.sizes[index] ?? 0) / 2
      const children = [...c.children]
      const sizes = [...c.sizes]
      sizes[index] = half
      const at = before ? index : index + 1
      children.splice(at, 0, leaf(newTabId))
      sizes.splice(at, 0, half)
      return { ...c, children, sizes }
    })
  } else {
    next = replaceAt(layout, path, (node) => ({
      type: axis,
      children: before ? [leaf(newTabId), node] : [node, leaf(newTabId)],
      sizes: [0.5, 0.5],
    }))
  }
  return normalizeLayout(next) ?? layout
}

/** Removes a pane; the remaining panes share its space. Null when nothing is left. */
export function removePane(layout: SplitLayout, tabId: TabId): SplitLayout | null {
  const path = leafPath(layout, tabId)
  if (!path) return layout
  return normalizeLayout(replaceAt(layout, path, () => null))
}

export function replacePane(layout: SplitLayout, oldTabId: TabId, newTabId: TabId): SplitLayout {
  if (layout.type === 'leaf') return layout.tabId === oldTabId ? leaf(newTabId) : layout
  return { ...layout, children: layout.children.map((c) => replacePane(c, oldTabId, newTabId)) }
}

export function swapPanes(layout: SplitLayout, a: TabId, b: TabId): SplitLayout {
  if (layout.type === 'leaf') {
    if (layout.tabId === a) return leaf(b)
    if (layout.tabId === b) return leaf(a)
    return layout
  }
  return { ...layout, children: layout.children.map((c) => swapPanes(c, a, b)) }
}

/** Flip orientation: side by side ↔ stacked at every level, keeping order and ratios. */
export function flipLayout(layout: SplitLayout): SplitLayout {
  if (layout.type === 'leaf') return layout
  return {
    type: layout.type === 'row' ? 'column' : 'row',
    children: layout.children.map(flipLayout),
    sizes: [...layout.sizes],
  }
}

/** Equal sizes everywhere, or only for the two children around one divider. */
export function equalizeLayout(layout: SplitLayout, path?: LayoutPath, index?: number): SplitLayout {
  if (path && index !== undefined) {
    return (
      replaceAt(layout, path, (node) => {
        if (node.type === 'leaf') return node
        const sizes = [...node.sizes]
        const a = sizes[index]
        const b = sizes[index + 1]
        if (a === undefined || b === undefined) return node
        sizes[index] = (a + b) / 2
        sizes[index + 1] = (a + b) / 2
        return { ...node, sizes }
      }) ?? layout
    )
  }
  if (layout.type === 'leaf') return layout
  return {
    ...layout,
    children: layout.children.map((c) => equalizeLayout(c)),
    sizes: evenSizes(layout.children.length),
  }
}

export function setSizesAt(layout: SplitLayout, path: LayoutPath, sizes: number[]): SplitLayout {
  return (
    replaceAt(layout, path, (node) =>
      node.type === 'leaf' ? node : { ...node, sizes: fixSizes(sizes, node.children.length) },
    ) ?? layout
  )
}

export function sameLayout(a: SplitLayout | null | undefined, b: SplitLayout | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

// ---- Geometry ----

export interface PaneBox {
  tabId: TabId
  rect: Box
}

export interface DividerBox {
  /** Container path and the index of the child before the divider. */
  path: LayoutPath
  index: number
  /** Container direction: 'row' → vertical bar dragged horizontally. */
  axis: SplitAxis
  rect: Box
  /** The container's rect (for snapping and min sizes). */
  container: Box
}

/** Pane and divider rectangles for a layout drawn inside `rect` with `gap` between panes. */
export function layoutBoxes(
  layout: SplitLayout,
  rect: Box,
  gap = PANE_GAP,
): { panes: PaneBox[]; dividers: DividerBox[] } {
  const panes: PaneBox[] = []
  const dividers: DividerBox[] = []
  const walk = (node: SplitLayout, r: Box, path: LayoutPath) => {
    if (node.type === 'leaf') {
      panes.push({ tabId: node.tabId, rect: r })
      return
    }
    const n = node.children.length
    const horizontal = node.type === 'row'
    const total = horizontal ? r.width : r.height
    const free = Math.max(0, total - gap * (n - 1))
    let offset = horizontal ? r.x : r.y
    node.children.forEach((child, i) => {
      const len = free * (node.sizes[i] ?? 1 / n)
      const childRect = horizontal
        ? { x: offset, y: r.y, width: len, height: r.height }
        : { x: r.x, y: offset, width: r.width, height: len }
      walk(child, childRect, [...path, i])
      offset += len
      if (i < n - 1) {
        dividers.push({
          path,
          index: i,
          axis: node.type,
          rect: horizontal
            ? { x: offset, y: r.y, width: gap, height: r.height }
            : { x: r.x, y: offset, width: r.width, height: gap },
          container: r,
        })
        offset += gap
      }
    })
  }
  walk(layout, rect, [])
  return { panes, dividers }
}

/** Smallest size (px) a subtree can take along an axis. */
export function minLength(node: SplitLayout, horizontal: boolean, gap = PANE_GAP): number {
  if (node.type === 'leaf') return horizontal ? MIN_PANE_WIDTH : MIN_PANE_HEIGHT
  const mins = node.children.map((c) => minLength(c, horizontal, gap))
  const along = (node.type === 'row') === horizontal
  return along ? mins.reduce((a, b) => a + b, 0) + gap * (node.children.length - 1) : Math.max(...mins)
}

/**
 * New sizes for a container while its divider `index` is dragged by `delta` px from
 * `startSizes`. The two neighbours trade space, stop at their minimum size and snap
 * to 1/3, 1/2 and 2/3 of the container.
 */
export function dragSizes(
  container: SplitLayout,
  startSizes: number[],
  index: number,
  delta: number,
  containerLength: number,
  opts: { gap?: number; snap?: boolean } = {},
): { sizes: number[]; snapped: number | null } {
  const gap = opts.gap ?? PANE_GAP
  if (container.type === 'leaf') return { sizes: startSizes, snapped: null }
  const n = container.children.length
  const horizontal = container.type === 'row'
  const free = Math.max(1, containerLength - gap * (n - 1))
  const px = startSizes.map((s) => s * free)
  const a0 = px[index] ?? 0
  const b0 = px[index + 1] ?? 0
  const pair = a0 + b0
  const minA = minLength(container.children[index] as SplitLayout, horizontal, gap)
  const minB = minLength(container.children[index + 1] as SplitLayout, horizontal, gap)
  let a = a0 + delta
  let snapped: number | null = null
  if (opts.snap !== false) {
    // Divider centre measured from the container start.
    const before = px.slice(0, index).reduce((x, y) => x + y, 0) + gap * index
    for (const f of SNAP_FRACTIONS) {
      const target = f * containerLength - gap / 2 - before
      if (Math.abs(a - target) <= SNAP_DISTANCE) {
        a = target
        snapped = f
        break
      }
    }
  }
  if (pair >= minA + minB) a = Math.min(Math.max(a, minA), pair - minB)
  else a = a0
  if (snapped !== null && Math.abs(a - (a0 + delta)) > SNAP_DISTANCE) snapped = null
  const next = [...px]
  next[index] = a
  next[index + 1] = pair - a
  return { sizes: next.map((v) => v / free), snapped }
}

/** Panes in reading order: top to bottom by row, left to right within a row. */
export function paneOrder(layout: SplitLayout): TabId[] {
  const { panes } = layoutBoxes(layout, { x: 0, y: 0, width: 1000, height: 1000 }, 0)
  return panes
    .map((p, i) => ({ ...p, i }))
    .sort((a, b) => {
      if (Math.abs(a.rect.y - b.rect.y) > 1) return a.rect.y - b.rect.y
      if (Math.abs(a.rect.x - b.rect.x) > 1) return a.rect.x - b.rect.x
      return a.i - b.i
    })
    .map((p) => p.tabId)
}

/** The pane next to `tabId` in a direction (by geometry), if any. */
export function neighborPane(layout: SplitLayout, tabId: TabId, side: PaneSide): TabId | undefined {
  const { panes } = layoutBoxes(layout, { x: 0, y: 0, width: 1000, height: 1000 }, 0)
  const from = panes.find((p) => p.tabId === tabId)
  if (!from) return undefined
  const cx = from.rect.x + from.rect.width / 2
  const cy = from.rect.y + from.rect.height / 2
  let best: { tabId: TabId; d: number } | undefined
  for (const p of panes) {
    if (p.tabId === tabId) continue
    const px = p.rect.x + p.rect.width / 2
    const py = p.rect.y + p.rect.height / 2
    const ok =
      (side === 'left' && p.rect.x + p.rect.width <= from.rect.x + 1) ||
      (side === 'right' && p.rect.x >= from.rect.x + from.rect.width - 1) ||
      (side === 'top' && p.rect.y + p.rect.height <= from.rect.y + 1) ||
      (side === 'bottom' && p.rect.y >= from.rect.y + from.rect.height - 1)
    if (!ok) continue
    const d = Math.hypot(px - cx, py - cy)
    if (!best || d < best.d) best = { tabId: p.tabId, d }
  }
  return best?.tabId
}

/** The pane to focus after `tabId` closes: its nearest sibling in the tree. */
export function siblingOf(layout: SplitLayout, tabId: TabId): TabId | undefined {
  const path = leafPath(layout, tabId)
  if (!path || path.length === 0) return undefined
  const parent = nodeAt(layout, path.slice(0, -1))
  const index = path[path.length - 1] as number
  if (!parent || parent.type === 'leaf') return undefined
  const neighbor = parent.children[index + 1] ?? parent.children[index - 1]
  return neighbor ? layoutLeaves(neighbor)[0] : undefined
}

/**
 * Where a pane sits relative to a neighbour, so it can be put back after closing:
 * e.g. { target: 'b', side: 'left' } means "left of b". Prefers the next sibling.
 */
export function anchorOf(
  layout: SplitLayout,
  tabId: TabId,
): { target: TabId; targets: TabId[]; side: PaneSide } | undefined {
  const path = leafPath(layout, tabId)
  if (!path || path.length === 0) return undefined
  const parent = nodeAt(layout, path.slice(0, -1))
  const index = path[path.length - 1] as number
  if (!parent || parent.type === 'leaf') return undefined
  const row = parent.type === 'row'
  const next = parent.children[index + 1]
  if (next) {
    const targets = layoutLeaves(next)
    return { target: targets[0] as TabId, targets, side: row ? 'left' : 'top' }
  }
  const prev = parent.children[index - 1]
  if (prev) {
    const targets = layoutLeaves(prev)
    return { target: targets.at(-1) as TabId, targets, side: row ? 'right' : 'bottom' }
  }
  return undefined
}

/** Path of the node whose leaves are exactly `tabIds` (in any order). */
function pathOfGroup(layout: SplitLayout, tabIds: TabId[], path: LayoutPath = []): LayoutPath | undefined {
  const leaves = layoutLeaves(layout)
  if (leaves.length === tabIds.length && leaves.every((id) => tabIds.includes(id))) return path
  if (layout.type === 'leaf') return undefined
  for (let i = 0; i < layout.children.length; i++) {
    const found = pathOfGroup(layout.children[i] as SplitLayout, tabIds, [...path, i])
    if (found) return found
  }
  return undefined
}

/**
 * Puts `newTabId` on `side` of the group of panes `targets` (e.g. the neighbour a closed pane sat
 * beside), so reopening restores the old arrangement. Falls back to the first target's pane.
 */
export function insertBeside(layout: SplitLayout, targets: TabId[], newTabId: TabId, side: PaneSide): SplitLayout {
  const leaves = layoutLeaves(layout)
  if (leaves.includes(newTabId) || leaves.length >= MAX_PANES) return layout
  const path = targets.length > 0 ? pathOfGroup(layout, targets) : undefined
  if (!path) return targets[0] ? insertPane(layout, targets[0], newTabId, side) : layout
  const axis = axisOfSide(side)
  const before = sideIsBefore(side)
  const parent = path.length > 0 ? nodeAt(layout, path.slice(0, -1)) : undefined
  const index = path[path.length - 1]
  let next: SplitLayout | null
  if (parent && parent.type === axis && index !== undefined) {
    next = replaceAt(layout, path.slice(0, -1), (node) => {
      const c = node as Container
      const half = (c.sizes[index] ?? 0) / 2
      const children = [...c.children]
      const sizes = [...c.sizes]
      sizes[index] = half
      const at = before ? index : index + 1
      children.splice(at, 0, leaf(newTabId))
      sizes.splice(at, 0, half)
      return { ...c, children, sizes }
    })
  } else {
    next = replaceAt(layout, path, (node) => ({
      type: axis,
      children: before ? [leaf(newTabId), node] : [node, leaf(newTabId)],
      sizes: [0.5, 0.5],
    }))
  }
  return normalizeLayout(next) ?? layout
}

/**
 * Which half of a sidebar row a dragged tab is over (SV-05): the middle band of the row
 * (by height) combines into a split on that side; the top and bottom quarters are left for
 * reordering. Returns null outside the band.
 */
export function rowDropSide(row: Box, x: number, y: number): 'left' | 'right' | null {
  if (x < row.x || x > row.x + row.width) return null
  const fy = row.height > 0 ? (y - row.y) / row.height : 0
  if (fy < 0.25 || fy > 0.75) return null
  return x < row.x + row.width / 2 ? 'left' : 'right'
}

/**
 * Zone of a pane under the pointer when another pane of the same split is dragged onto it
 * (SV-20): the centre swaps the two, an edge half moves the dragged pane to that side.
 */
export function paneDropZone(r: Box, x: number, y: number): PaneSide | 'center' {
  const fx = r.width > 0 ? (x - r.x) / r.width : 0.5
  const fy = r.height > 0 ? (y - r.y) / r.height : 0.5
  if (fx > 0.3 && fx < 0.7 && fy > 0.3 && fy < 0.7) return 'center'
  const dx = fx - 0.5
  const dy = fy - 0.5
  if (Math.abs(dx) * r.width >= Math.abs(dy) * r.height) return dx < 0 ? 'left' : 'right'
  return dy < 0 ? 'top' : 'bottom'
}

export interface DropTarget {
  /** Pane the new tab goes next to. */
  target: TabId
  side: PaneSide
}

/**
 * Where a tab dropped at (x, y) goes. On a single page: the top or bottom centre
 * band stacks, the left or right edge band (20 %) picks that side, anything else
 * puts the dropped tab on the right. On a split: the nearest half of the pane under
 * the pointer.
 */
export function dropTargetAt(panes: PaneBox[], x: number, y: number): DropTarget | null {
  if (panes.length === 0) return null
  let pane = panes.find(
    (p) => x >= p.rect.x && x <= p.rect.x + p.rect.width && y >= p.rect.y && y <= p.rect.y + p.rect.height,
  )
  if (!pane) {
    // In a gap: the nearest pane.
    let best = Number.POSITIVE_INFINITY
    for (const p of panes) {
      const dx = Math.max(p.rect.x - x, 0, x - (p.rect.x + p.rect.width))
      const dy = Math.max(p.rect.y - y, 0, y - (p.rect.y + p.rect.height))
      const d = Math.hypot(dx, dy)
      if (d < best) {
        best = d
        pane = p
      }
    }
  }
  if (!pane) return null
  const r = pane.rect
  const fx = r.width > 0 ? (x - r.x) / r.width : 0.5
  const fy = r.height > 0 ? (y - r.y) / r.height : 0.5
  if (panes.length === 1) {
    const middle = fx > 0.25 && fx < 0.75
    if (fy < 0.25 && middle) return { target: pane.tabId, side: 'top' }
    if (fy > 0.75 && middle) return { target: pane.tabId, side: 'bottom' }
    if (fx < 0.2) return { target: pane.tabId, side: 'left' }
    return { target: pane.tabId, side: 'right' }
  }
  const dx = fx - 0.5
  const dy = fy - 0.5
  if (Math.abs(dx) * r.width >= Math.abs(dy) * r.height) return { target: pane.tabId, side: dx < 0 ? 'left' : 'right' }
  return { target: pane.tabId, side: dy < 0 ? 'top' : 'bottom' }
}

export function intersect(a: Box, b: Box): Box {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) }
}
