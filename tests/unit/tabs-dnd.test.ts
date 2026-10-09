import { describe, expect, it } from 'vitest'
import {
  computeDropTarget,
  gridDropIndex,
  ROW_GAP,
  rowShifts,
  type Slot,
} from '../../src/renderer/src/shell/sidebar/dnd-model'

const H = 32
const P = H + ROW_GAP

/** Builds a measured list: pinned rows, the divider block, then Today rows. */
function layout(spec: { pinned: (string | { folder: string; open: boolean; children: string[] })[]; today: string[] }) {
  const slots: Slot[] = []
  let top = 26
  const push = (s: Omit<Slot, 'top' | 'height'> & { height?: number }) => {
    const height = s.height ?? H
    slots.push({ ...s, top, height })
    top += height + ROW_GAP
  }
  spec.pinned.forEach((item, index) => {
    if (typeof item === 'string') {
      push({ key: item, kind: 'item', container: 'pinned:s', index, depth: 0, ancestors: [] })
      return
    }
    push({
      key: item.folder,
      kind: 'item',
      container: 'pinned:s',
      index,
      depth: 0,
      folder: item.open ? 'open' : 'closed',
      ancestors: [],
    })
    if (item.open) {
      item.children.forEach((child, ci) =>
        push({
          key: child,
          kind: 'item',
          container: `folder:${item.folder}`,
          index: ci,
          depth: 1,
          ancestors: [item.folder],
        }),
      )
    }
  })
  push({ key: 'divider', kind: 'divider', container: 'today:s', index: 0, depth: 0, ancestors: [], height: 58 })
  spec.today.forEach((id, index) => {
    push({ key: id, kind: 'item', container: 'today:s', index, depth: 0, ancestors: [] })
  })
  return slots
}

const opts = { pinnedContainer: 'pinned:s', todayContainer: 'today:s' }
const center = (slots: Slot[], key: string, rel = 0.5) => {
  const s = slots.find((x) => x.key === key) as Slot
  return s.top + s.height * rel
}

describe('[TB-08][FD-05] drop targets', () => {
  it('reorders within Today by row halves (indices without the dragged row)', () => {
    const slots = layout({ pinned: [], today: ['a', 'b', 'c', 'd', 'e'] })
    const dragged = new Set(['e'])
    expect(computeDropTarget(slots, center(slots, 'a', 0.2), dragged, opts)).toMatchObject({
      type: 'between',
      container: 'today:s',
      index: 0,
    })
    expect(computeDropTarget(slots, center(slots, 'b', 0.8), dragged, opts)).toMatchObject({
      container: 'today:s',
      index: 2,
    })
    // Dragging the first row down past the third: index counts rows without it.
    expect(computeDropTarget(slots, center(slots, 'c', 0.8), new Set(['a']), opts)).toMatchObject({ index: 2 })
  })

  it('upper half of the divider is the end of pinned, lower half the top of Today', () => {
    const slots = layout({ pinned: ['p1', 'p2'], today: ['a', 'b'] })
    const dragged = new Set(['b'])
    expect(computeDropTarget(slots, center(slots, 'divider', 0.2), dragged, opts)).toMatchObject({
      container: 'pinned:s',
      index: 2,
    })
    expect(computeDropTarget(slots, center(slots, 'divider', 0.8), dragged, opts)).toMatchObject({
      container: 'today:s',
      index: 0,
    })
    // Below everything: the end of Today.
    expect(computeDropTarget(slots, 2000, new Set(['p1']), opts)).toMatchObject({ container: 'today:s', index: 2 })
  })

  it('drops into a closed folder through its middle band and among children of an open one', () => {
    const slots = layout({
      pinned: [
        { folder: 'f-closed', open: false, children: [] },
        { folder: 'f-open', open: true, children: ['x', 'y'] },
      ],
      today: ['a'],
    })
    const dragged = new Set(['a'])
    expect(computeDropTarget(slots, center(slots, 'f-closed', 0.5), dragged, opts)).toMatchObject({
      type: 'into',
      folderId: 'f-closed',
    })
    expect(computeDropTarget(slots, center(slots, 'f-closed', 0.1), dragged, opts)).toMatchObject({
      type: 'between',
      container: 'pinned:s',
      index: 0,
    })
    expect(computeDropTarget(slots, center(slots, 'f-open', 0.8), dragged, opts)).toMatchObject({
      container: 'folder:f-open',
      index: 0,
      depth: 1,
    })
    expect(computeDropTarget(slots, center(slots, 'y', 0.8), dragged, opts)).toMatchObject({
      container: 'folder:f-open',
      index: 2,
    })
  })

  it('never targets the dragged folder or its own children', () => {
    const slots = layout({ pinned: [{ folder: 'f', open: true, children: ['x'] }, 'p'], today: [] })
    const t = computeDropTarget(slots, center(slots, 'x', 0.5), new Set(['f']), opts)
    expect(t.type === 'between' && t.container).not.toBe('folder:f')
  })
})

describe('[TB-08] rows move apart to show the gap', () => {
  it('opens a gap at the target and closes the one the dragged row left', () => {
    const slots = layout({ pinned: [], today: ['a', 'b', 'c', 'd', 'e'] })
    const dragged = new Set(['e'])
    const target = computeDropTarget(slots, center(slots, 'a', 0.2), dragged, opts)
    const shifts = rowShifts(slots, dragged, target)
    expect(shifts.a).toBe(P)
    expect(shifts.d).toBe(P)
    expect(shifts.divider).toBeUndefined()
    // Leaving the list (e.g. to Favorites): rows below the source slide up.
    const away = rowShifts(slots, new Set(['b']), undefined)
    expect(away.c).toBe(-P)
    expect(away.a).toBeUndefined()
  })
})

describe('[FV-05] Favorites grid drop index', () => {
  it('uses the nearest tile and which half the pointer is on', () => {
    const tiles = [0, 1, 2, 3].map((i) => ({ left: i * 60, top: 0, width: 54, height: 44 }))
    expect(gridDropIndex(tiles, 5, 20)).toBe(0)
    expect(gridDropIndex(tiles, 50, 20)).toBe(1)
    expect(gridDropIndex(tiles, 230, 20)).toBe(4)
    expect(gridDropIndex([], 0, 0)).toBe(0)
  })
})
