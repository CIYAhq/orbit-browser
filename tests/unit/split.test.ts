import { describe, expect, it } from 'vitest'
import { fastSwitchPanes } from '../../src/main/split/layout'
import {
  addPaneInDraft,
  createSplitInDraft,
  detachTab,
  dropBlankPanes,
  popOutInDraft,
  separateInDraft,
  swapIntoPaneInDraft,
} from '../../src/main/split/model'
import { makeTab } from '../../src/main/tabs/model'
import { createInitialState, createWindowState, DEFAULT_PROFILE_ID } from '../../src/shared/defaults'
import {
  anchorOf,
  dragSizes,
  dropTargetAt,
  equalizeLayout,
  flipLayout,
  insertPane,
  layoutBoxes,
  layoutLeaves,
  MAX_PANES,
  MIN_PANE_WIDTH,
  makeLayout,
  neighborPane,
  normalizeLayout,
  PANE_GAP,
  paneDropZone,
  paneOrder,
  removePane,
  rowDropSide,
  setSizesAt,
  siblingOf,
  swapPanes,
} from '../../src/shared/split'
import type { OrbitState, SplitLayout } from '../../src/shared/state'
import { locate, sectionOf, splitOfTab } from '../../src/shared/tree'

const row = (children: SplitLayout[], sizes?: number[]): SplitLayout => ({
  type: 'row',
  children,
  sizes: sizes ?? children.map(() => 1 / children.length),
})
const col = (children: SplitLayout[], sizes?: number[]): SplitLayout => ({
  type: 'column',
  children,
  sizes: sizes ?? children.map(() => 1 / children.length),
})
const L = (tabId: string): SplitLayout => ({ type: 'leaf', tabId })

describe('split layout tree', () => {
  it('adds a pane beside the target, halving its space', () => {
    const two = insertPane(L('a'), 'a', 'b', 'right')
    expect(two).toEqual(row([L('a'), L('b')], [0.5, 0.5]))
    const three = insertPane(two, 'b', 'c', 'right')
    expect(three).toEqual(row([L('a'), L('b'), L('c')], [0.5, 0.25, 0.25]))
    const stacked = insertPane(two, 'b', 'c', 'bottom')
    expect(stacked).toEqual(row([L('a'), col([L('b'), L('c')], [0.5, 0.5])], [0.5, 0.5]))
    expect(insertPane(L('a'), 'a', 'b', 'left')).toEqual(row([L('b'), L('a')]))
    expect(insertPane(L('a'), 'a', 'b', 'top')).toEqual(col([L('b'), L('a')]))
  })

  it('[SV-01][SV-25] never holds more than four panes or the same tab twice', () => {
    let layout: SplitLayout = L('a')
    for (const id of ['b', 'c', 'd', 'e']) layout = insertPane(layout, 'a', id, 'right')
    expect(layoutLeaves(layout)).toHaveLength(MAX_PANES)
    expect(layoutLeaves(insertPane(layout, 'a', 'b', 'top'))).toHaveLength(MAX_PANES)
    expect(layoutLeaves(insertPane(row([L('a'), L('b')]), 'a', 'b', 'top'))).toEqual(['a', 'b'])
  })

  it('removes panes, giving their space to the rest and collapsing containers', () => {
    const layout = row([L('a'), col([L('b'), L('c')])], [0.5, 0.5])
    expect(removePane(layout, 'c')).toEqual(row([L('a'), L('b')], [0.5, 0.5]))
    expect(removePane(row([L('a'), L('b')]), 'a')).toEqual(L('b'))
    expect(removePane(L('a'), 'a')).toBeNull()
    const sized = removePane(row([L('a'), L('b'), L('c')], [0.25, 0.25, 0.5]), 'a')
    expect(sized).toEqual(row([L('b'), L('c')], [1 / 3, 2 / 3]))
  })

  it('normalizes nested same-direction containers and broken sizes', () => {
    const nested = row([L('a'), row([L('b'), L('c')], [0.5, 0.5])], [0.5, 0.5])
    expect(normalizeLayout(nested)).toEqual(row([L('a'), L('b'), L('c')], [0.5, 0.25, 0.25]))
    expect(normalizeLayout(row([L('a'), L('b')], [Number.NaN, 2]))).toEqual(row([L('a'), L('b')], [0.5, 0.5]))
    expect(normalizeLayout(row([L('a')]))).toEqual(L('a'))
  })

  it('[SV-11][SV-20] swaps panes and flips orientation keeping order and ratios', () => {
    const layout = row([L('a'), col([L('b'), L('c')], [0.3, 0.7])], [0.6, 0.4])
    expect(layoutLeaves(swapPanes(layout, 'a', 'c'))).toEqual(['c', 'b', 'a'])
    expect(flipLayout(layout)).toEqual(col([L('a'), row([L('b'), L('c')], [0.3, 0.7])], [0.6, 0.4]))
    expect(flipLayout(flipLayout(layout))).toEqual(layout)
  })

  it('equalizes all panes or the two around one divider', () => {
    const layout = row([L('a'), L('b'), L('c')], [0.5, 0.3, 0.2])
    expect(equalizeLayout(layout)).toEqual(row([L('a'), L('b'), L('c')]))
    const pair = equalizeLayout(layout, [], 1)
    expect(pair.type === 'row' && pair.sizes).toEqual([0.5, 0.25, 0.25])
    expect(setSizesAt(layout, [], [1, 1, 2])).toEqual(row([L('a'), L('b'), L('c')], [0.25, 0.25, 0.5]))
  })

  it('lays panes out with 8 px gaps and finds the dividers', () => {
    const { panes, dividers } = layoutBoxes(row([L('a'), L('b')]), { x: 0, y: 0, width: 1008, height: 600 })
    expect(panes.map((p) => p.rect)).toEqual([
      { x: 0, y: 0, width: 500, height: 600 },
      { x: 508, y: 0, width: 500, height: 600 },
    ])
    expect(dividers).toHaveLength(1)
    expect(dividers[0]?.rect).toEqual({ x: 500, y: 0, width: PANE_GAP, height: 600 })
  })

  it('[SV-13] drags a divider 1:1, stops at the minimum width and snaps to the middle', () => {
    const layout = row([L('a'), L('b')])
    const free = 1008 - PANE_GAP
    const moved = dragSizes(layout, [0.5, 0.5], 0, 100, 1008)
    expect((moved.sizes[0] ?? 0) * free).toBeCloseTo(600)
    const clamped = dragSizes(layout, [0.5, 0.5], 0, 10_000, 1008)
    expect((clamped.sizes[1] ?? 0) * free).toBeCloseTo(MIN_PANE_WIDTH)
    const snapped = dragSizes(layout, [0.5, 0.5], 0, 5, 1008)
    expect(snapped.snapped).toBe(0.5)
    expect(snapped.sizes[0]).toBeCloseTo(0.5)
    const free3 = dragSizes(layout, [0.5, 0.5], 0, 5, 1008, { snap: false })
    expect(free3.snapped).toBeNull()
  })

  it('orders panes for reading and finds neighbours and siblings', () => {
    const grid = col([row([L('a'), L('b')]), row([L('c'), L('d')])])
    expect(paneOrder(grid)).toEqual(['a', 'b', 'c', 'd'])
    expect(paneOrder(row([col([L('a'), L('c')]), col([L('b'), L('d')])]))).toEqual(['a', 'b', 'c', 'd'])
    expect(neighborPane(grid, 'a', 'right')).toBe('b')
    expect(neighborPane(grid, 'a', 'bottom')).toBe('c')
    expect(neighborPane(grid, 'a', 'left')).toBeUndefined()
    expect(siblingOf(row([L('a'), col([L('b'), L('c')])]), 'a')).toBe('b')
  })

  it('[SV-04] picks drop zones on a page and on panes', () => {
    const single = [{ tabId: 'a', rect: { x: 0, y: 0, width: 1000, height: 800 } }]
    expect(dropTargetAt(single, 500, 400)).toEqual({ target: 'a', side: 'right' })
    expect(dropTargetAt(single, 500, 50)).toEqual({ target: 'a', side: 'top' })
    expect(dropTargetAt(single, 500, 780)).toEqual({ target: 'a', side: 'bottom' })
    expect(dropTargetAt(single, 50, 400)).toEqual({ target: 'a', side: 'left' })
    const { panes } = layoutBoxes(row([L('a'), L('b')]), { x: 0, y: 0, width: 1008, height: 800 })
    expect(dropTargetAt(panes, 900, 400)).toEqual({ target: 'b', side: 'right' })
    expect(dropTargetAt(panes, 750, 20)).toEqual({ target: 'b', side: 'top' })
  })

  it('remembers where a pane sat so it can be put back', () => {
    const layout = row([L('a'), col([L('b'), L('c')])])
    expect(anchorOf(layout, 'a')).toEqual({ target: 'b', side: 'left' })
    expect(anchorOf(layout, 'c')).toEqual({ target: 'b', side: 'bottom' })
    expect(anchorOf(layout, 'b')).toEqual({ target: 'c', side: 'top' })
    const back = insertPane(removePane(layout, 'c') as SplitLayout, 'b', 'c', 'bottom')
    expect(back).toEqual(layout)
  })

  it('[SV-05] splits a sidebar row drop into left/right halves, leaving edges for reordering', () => {
    const r = { x: 0, y: 0, width: 200, height: 32 }
    expect(rowDropSide(r, 50, 16)).toBe('left')
    expect(rowDropSide(r, 150, 16)).toBe('right')
    expect(rowDropSide(r, 150, 2)).toBeNull()
    expect(rowDropSide(r, 150, 30)).toBeNull()
  })

  it('[SV-20] picks swap or move zones when a pane is dragged onto another', () => {
    const r = { x: 0, y: 0, width: 400, height: 300 }
    expect(paneDropZone(r, 200, 150)).toBe('center')
    expect(paneDropZone(r, 20, 150)).toBe('left')
    expect(paneDropZone(r, 390, 150)).toBe('right')
    expect(paneDropZone(r, 200, 10)).toBe('top')
    expect(paneDropZone(r, 200, 295)).toBe('bottom')
  })

  it('builds even layouts', () => {
    expect(makeLayout(['a', 'b', 'c'])).toEqual(row([L('a'), L('b'), L('c')]))
    expect(makeLayout(['a'])).toEqual(L('a'))
  })
})

function world() {
  const state = createInitialState(0)
  const spaceId = state.spaceOrder[0] as string
  const win = createWindowState(spaceId)
  state.windows[win.id] = win
  const add = (where: 'today' | 'pinned' = 'today', url = 'https://x.test/') => {
    const tab = makeTab({ spaceId, profileId: DEFAULT_PROFILE_ID, url })
    state.tabs[tab.id] = tab
    state.spaces[spaceId]?.[where].push(tab.id)
    return tab.id
  }
  return { state, spaceId, win: win.id, add }
}

const today = (state: OrbitState, spaceId: string) => state.spaces[spaceId]?.today ?? []

describe('split model', () => {
  it('makes one sidebar item from 2–4 tabs in the first tab’s place', () => {
    const { state, spaceId, add } = world()
    const [a, b, c, d] = [add(), add(), add(), add()]
    const id = createSplitInDraft(state, [b, c], { id: 'v-1' })
    expect(id).toBe('v-1')
    expect(today(state, spaceId)).toEqual([a, 'v-1', d])
    expect(splitOfTab(state, c)).toBe('v-1')
    expect(createSplitInDraft(state, [a])).toBe('invalid')
  })

  it('refuses a fifth pane', () => {
    const { state, add } = world()
    const ids = [add(), add(), add(), add(), add()]
    expect(createSplitInDraft(state, ids)).toBe('full')
    const four = createSplitInDraft(state, ids.slice(0, 4)) as string
    expect(addPaneInDraft(state, ids[4] as string, ids[0] as string, 'right')).toBe('full')
    expect(layoutLeaves(state.splits[four]?.layout as SplitLayout)).toHaveLength(4)
  })

  it('drops a tab next to a standalone tab or into an existing split', () => {
    const { state, spaceId, add } = world()
    const [a, b, c] = [add(), add(), add()]
    const id = addPaneInDraft(state, a, b, 'right') as string
    expect(today(state, spaceId)).toEqual([id, c])
    expect(state.splits[id]?.layout).toEqual(row([L(b), L(a)]))
    expect(addPaneInDraft(state, c, b, 'bottom')).toBe(id)
    expect(state.splits[id]?.layout).toEqual(row([col([L(b), L(c)]), L(a)]))
    expect(today(state, spaceId)).toEqual([id])
  })

  it('keeps a split made in the pinned section pinned', () => {
    const { state, spaceId, add } = world()
    const pinned = add('pinned', 'https://pinned.test/')
    const loose = add('today', 'https://loose.test/')
    const id = addPaneInDraft(state, loose, pinned, 'left') as string
    expect(state.spaces[spaceId]?.pinned).toEqual([id])
    expect(sectionOf(state, loose)).toBe('pinned')
    expect(state.tabs[loose]?.pinnedUrl).toBe('https://loose.test/')
  })

  it('dissolves a split into an ordinary tab when one pane is left', () => {
    const { state, spaceId, add } = world()
    const [a, b, c] = [add(), add(), add()]
    const id = createSplitInDraft(state, [a, b]) as string
    detachTab(state, a)
    expect(state.splits[id]).toBeUndefined()
    expect(today(state, spaceId)).toEqual([b, c])
  })

  it('separates panes into tabs in reading order and pops one pane out', () => {
    const { state, spaceId, add } = world()
    const [a, b, c] = [add(), add(), add()]
    const id = createSplitInDraft(state, [a, b, c]) as string
    popOutInDraft(state, b)
    expect(today(state, spaceId)).toEqual([id, b])
    separateInDraft(state, id)
    expect(today(state, spaceId)).toEqual([a, c, b])
    expect(Object.keys(state.splits)).toHaveLength(0)
  })

  it('swaps an open tab into a pane, sending the old page to Today', () => {
    const { state, spaceId, add } = world()
    const [a, b, c] = [add(), add(), add()]
    const id = createSplitInDraft(state, [a, b]) as string
    expect(swapIntoPaneInDraft(state, b, c)).toBe(true)
    expect(layoutLeaves(state.splits[id]?.layout as SplitLayout)).toEqual([a, c])
    expect(locate(state, b)?.container).toEqual({ kind: 'today', spaceId })
  })

  it('[SV-24] drops panes still waiting for a page when state loads', () => {
    const { state, spaceId, add } = world()
    const [a, b] = [add(), add('today', 'about:blank')]
    const c = add()
    const id = createSplitInDraft(state, [a, b, c]) as string
    expect(dropBlankPanes(state)).toEqual([b])
    expect(layoutLeaves(state.splits[id]?.layout as SplitLayout)).toEqual([a, c])
    expect(state.tabs[b]).toBeUndefined()
    createSplitInDraft(state, [a, add('today', 'about:blank')])
    dropBlankPanes(state)
    expect(today(state, spaceId)).toContain(a)
  })

  it('lays out splits on the fast path only for unrelated selections', () => {
    const { state, add } = world()
    const [a, b, c] = [add(), add(), add()]
    const prev = structuredClone(state)
    createSplitInDraft(state, [a, b])
    const frame = { x: 0, y: 0, width: 1008, height: 600 }
    // c → split: views placed right away.
    expect(fastSwitchPanes(state, prev, a, c, frame)?.map((p) => p.tabId)).toEqual([a, b])
    // a (single) → split containing a: the shell animates it.
    expect(fastSwitchPanes(state, prev, b, a, frame)).toBeNull()
  })
})
