/**
 * Pointer-driven drag and drop for the sidebar (TB-08, TB-09, FD-05, FV-03…05).
 *
 * Rows are measured once when a drag starts (layout offsets, so transforms don't
 * disturb them). While dragging, a ghost follows the pointer and rows slide apart
 * (springs) to show where the drop lands. On drop the move is committed to main;
 * when the new state arrives the row offsets are cleared in the same render, so
 * nothing flickers, and the ghost settles into the row's new place.
 */
import { animate, motionValue } from 'motion/react'
import { isFolderId, isTabId } from '../../../../shared/ids'
import type { ItemId, OrbitState, SpaceId } from '../../../../shared/state'
import { locate, parseContainerKey, visibleTabOrder } from '../../../../shared/tree'
import { invoke } from '../../api'
import { activeTabId } from '../../selectors'
import { getOrbitState, getSeq, useMirror } from '../../store'
import { computeDropTarget, type DropTarget, gridDropIndex, ROW_GAP, rowShifts, type Slot } from './dnd-model'
import { reducedMotion, STANDARD } from './motion-tokens'
import { IDLE_DRAG, useDrag, useSelection } from './ui-state'

/** Movement before a press becomes a drag (TB-08: no long-press, a few pixels). */
export const DRAG_THRESHOLD = 4
/** Edge band that auto-scrolls the list, and its top speed in px per frame (≈1,200 px/s, FL-10). */
const SCROLL_EDGE = 40
const SCROLL_MAX = 20
/** A drop slot only changes once the pointer is this far past the boundary (no flicker, FL-10). */
const HYSTERESIS = 4
/** Hold near the sidebar's left/right edge this long to slide to the neighbouring Space (SP-21). */
const SPACE_DWELL_MS = 500
/** Distance outside the window before a drop opens a new window (TB-09). */
const OUTSIDE_MARGIN = 32

export const ghostX = motionValue(0)
export const ghostY = motionValue(0)
export const ghostScale = motionValue(1)
export const ghostOpacity = motionValue(1)

const SPRING = STANDARD
const SETTLE = STANDARD

interface Context {
  scroll: HTMLElement | null
  favorites: HTMLElement | null
  sidebar: HTMLElement | null
  spaceId: SpaceId
  profileId: string
}

const ctx: Context = { scroll: null, favorites: null, sidebar: null, spaceId: '', profileId: '' }

/** SidebarItems registers the elements and the Space it shows. */
export function setDragContext(next: Partial<Context>): void {
  Object.assign(ctx, next)
}

interface Session {
  ids: ItemId[]
  dragged: Set<string>
  source: 'list' | 'favorites'
  pointerId: number
  el: HTMLElement
  startX: number
  startY: number
  grabX: number
  grabY: number
  originX: number
  originY: number
  started: boolean
  slots: Slot[]
  blockHeight: number
  lastX: number
  lastY: number
  prevY: number
  measuredSeq: number
  measuredAt: number
  raf: number
  dwell: { side: 'left' | 'right'; since: number } | null
  spaceAtStart: SpaceId
  cleanup: () => void
}

let session: Session | null = null

export function isDragging(): boolean {
  return !!session?.started
}

/** Layout offset of `el` inside `container` (ignores transforms). */
function offsetTopWithin(el: HTMLElement, container: HTMLElement): number {
  let top = 0
  let node: HTMLElement | null = el
  while (node && node !== container) {
    top += node.offsetTop
    const parent = node.offsetParent as HTMLElement | null
    if (parent && !container.contains(parent) && parent !== container) {
      // Container isn't an offsetParent: fall back to rects.
      return el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
    }
    node = parent
  }
  return top
}

function measureSlots(): Slot[] {
  const scroll = ctx.scroll
  if (!scroll) return []
  const out: Slot[] = []
  for (const el of scroll.querySelectorAll<HTMLElement>('[data-slot]')) {
    if (el.dataset.exiting) continue
    out.push({
      key: el.dataset.key ?? '',
      kind: el.dataset.slot === 'divider' ? 'divider' : 'item',
      container: el.dataset.container ?? '',
      index: Number(el.dataset.index ?? 0),
      depth: Number(el.dataset.depth ?? 0),
      folder: (el.dataset.folder as Slot['folder']) || undefined,
      ancestors: el.dataset.ancestors ? el.dataset.ancestors.split(',') : [],
      top: offsetTopWithin(el, scroll),
      height: el.offsetHeight,
      splitAt: el.dataset.slot === 'divider' ? dividerSplit(el) : undefined,
    })
  }
  return out
}

/** The divider line's offset inside the divider block: above it pins, below it is Today. */
function dividerSplit(block: HTMLElement): number | undefined {
  const line = block.querySelector<HTMLElement>('.sidebar__divider')
  if (!line) return undefined
  return line.offsetTop + line.offsetHeight / 2
}

/** Selected tabs in sidebar order, when the pressed row is part of a multi-selection. */
function dragIds(id: ItemId): ItemId[] {
  if (!isTabId(id)) return [id]
  const sel = useSelection.getState().ids
  if (sel.length < 2 || !sel.includes(id)) return [id]
  const state = getOrbitState()
  const order = visibleTabOrder(state, ctx.spaceId, { activeTabId: activeTabId(state) })
  return [...sel].sort((a, b) => order.indexOf(a) - order.indexOf(b))
}

/** Starts tracking a press on a row or Favorite tile; it becomes a drag after a few pixels. */
export function pressItem(
  e: PointerEvent | React.PointerEvent,
  id: ItemId,
  source: 'list' | 'favorites',
  onTap?: () => void,
): void {
  if (e.button !== 0 || session) return
  const el = e.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  const s: Session = {
    ids: [id],
    dragged: new Set([id]),
    source,
    pointerId: e.pointerId,
    el,
    startX: e.clientX,
    startY: e.clientY,
    grabX: e.clientX - rect.left,
    grabY: e.clientY - rect.top,
    originX: rect.left,
    originY: rect.top,
    started: false,
    slots: [],
    blockHeight: 0,
    lastX: e.clientX,
    lastY: e.clientY,
    prevY: e.clientY,
    measuredSeq: -1,
    measuredAt: 0,
    raf: 0,
    dwell: null,
    spaceAtStart: ctx.spaceId,
    cleanup: () => {},
  }
  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== s.pointerId) return
    s.prevY = s.lastY
    s.lastX = ev.clientX
    s.lastY = ev.clientY
    if (!s.started) {
      if (Math.hypot(ev.clientX - s.startX, ev.clientY - s.startY) < DRAG_THRESHOLD) return
      begin(s, rect)
    }
    update(s)
  }
  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== s.pointerId) return
    s.cleanup()
    if (s.started) void drop(s, ev)
    else {
      session = null
      onTap?.()
    }
  }
  const onCancel = (ev: PointerEvent) => {
    if (ev.pointerId !== s.pointerId) return
    s.cleanup()
    if (s.started) cancel(s)
    else session = null
  }
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape' || !s.started) return
    ev.preventDefault()
    ev.stopPropagation()
    s.cleanup()
    cancel(s)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onCancel)
  window.addEventListener('keydown', onKey, true)
  try {
    el.setPointerCapture(e.pointerId)
  } catch {
    // Synthetic events may not support capture.
  }
  s.cleanup = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    window.removeEventListener('keydown', onKey, true)
    if (s.raf) cancelAnimationFrame(s.raf)
    s.raf = 0
    try {
      el.releasePointerCapture(s.pointerId)
    } catch {
      // ignore
    }
  }
  session = s
}

function begin(s: Session, rect: DOMRect): void {
  s.started = true
  s.ids = dragIds(s.ids[0] as ItemId)
  s.dragged = new Set(s.ids)
  s.slots = measureSlots()
  s.measuredSeq = getSeq()
  s.measuredAt = performance.now()
  s.blockHeight = s.slots
    .filter((sl) => s.dragged.has(sl.key) || sl.ancestors.some((a) => s.dragged.has(a)))
    .reduce((h, sl) => h + sl.height + ROW_GAP, 0)
  ghostX.jump(rect.left)
  ghostY.jump(rect.top)
  ghostOpacity.jump(1)
  ghostScale.jump(1)
  // Lift (FL-10): a slight scale-up and a touch of transparency over ~110 ms.
  if (!reducedMotion()) {
    animate(ghostScale, 1.03, { duration: 0.11 })
    animate(ghostOpacity, 0.95, { duration: 0.11 })
  }
  const hidden: Record<string, true> = {}
  for (const id of s.ids) hidden[id] = true
  useDrag.setState({
    ...IDLE_DRAG,
    phase: 'dragging',
    ghost: { ids: s.ids, source: s.source, width: rect.width, height: rect.height },
    hidden,
  })
  document.documentElement.classList.add('is-dragging-tab')
  // Keep keyboard focus in Orbit's UI so Escape cancels the drag.
  void invoke('tabs.focusSidebar', {})
  tick(s)
}

type Zone =
  | { kind: 'list' }
  | { kind: 'favorites' }
  | { kind: 'space'; spaceId: SpaceId }
  | { kind: 'outside' }
  | { kind: 'none' }

function zoneAt(x: number, y: number): Zone {
  if (
    x < -OUTSIDE_MARGIN ||
    y < -OUTSIDE_MARGIN ||
    x > window.innerWidth + OUTSIDE_MARGIN ||
    y > window.innerHeight + OUTSIDE_MARGIN
  ) {
    return { kind: 'outside' }
  }
  const hit = document.elementFromPoint(x, y) as HTMLElement | null
  const dot = hit?.closest<HTMLElement>('[data-space-id]')
  if (dot?.dataset.spaceId) return { kind: 'space', spaceId: dot.dataset.spaceId }
  const sidebar = ctx.sidebar?.getBoundingClientRect()
  if (!sidebar || x > sidebar.right + 4) return { kind: 'none' }
  const list = ctx.scroll?.getBoundingClientRect()
  // Anything above the list (the grid, or the top of the sidebar when there are no Favorites) (FV-03).
  if (list && y < list.top) return { kind: 'favorites' }
  if (list && y >= list.top && y <= list.bottom) return { kind: 'list' }
  return { kind: 'none' }
}

function listTarget(s: Session, prev: DropTarget | null): DropTarget | null {
  const scroll = ctx.scroll
  if (!scroll) return null
  const y = s.lastY - scroll.getBoundingClientRect().top + scroll.scrollTop
  const space = getOrbitState().spaces[ctx.spaceId]
  const count = (list: string[] | undefined) => ({
    length: list?.length ?? 0,
    dragged: (list ?? []).filter((id) => s.dragged.has(id)).length,
  })
  const counts = {
    [`pinned:${ctx.spaceId}`]: count(space?.pinned),
    [`today:${ctx.spaceId}`]: count(space?.today),
  }
  const at = (yy: number) =>
    computeDropTarget(s.slots, yy, s.dragged, {
      pinnedContainer: `pinned:${ctx.spaceId}`,
      todayContainer: `today:${ctx.spaceId}`,
      counts,
    })
  let target = at(y)
  // Hysteresis: keep the current slot until the pointer is a few pixels past the boundary.
  if (prev && !sameTarget(prev, target)) {
    const back = y - Math.sign(s.lastY - s.prevY || 1) * HYSTERESIS
    if (sameTarget(prev, at(back))) target = prev
  }
  const hasFolder = s.ids.some(isFolderId)
  if (hasFolder && target.type === 'between' && target.container.startsWith('today:')) return null
  return target
}

function sameTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (!a || !b) return a === b
  if (a.type === 'into' || b.type === 'into') return a.type === b.type && a.at === b.at
  return a.container === b.container && a.index === b.index && a.at === b.at
}

function update(s: Session): void {
  // Re-measure when the list may have changed under the drag (new state, rows still growing in
  // right after the drag began); otherwise reuse the slots. Offsets ignore the drag transforms.
  const now = performance.now()
  if (ctx.spaceId === s.spaceAtStart && (getSeq() !== s.measuredSeq || now - s.measuredAt < 400)) {
    s.slots = measureSlots()
    s.measuredSeq = getSeq()
  }
  const zone = zoneAt(s.lastX, s.lastY)
  // The row stays in the sidebar's column (FL-10) unless it heads for the grid, a Space or out of the window.
  const free = zone.kind === 'favorites' || zone.kind === 'space' || zone.kind === 'outside'
  ghostX.set(free ? s.lastX - s.grabX : s.originX)
  ghostY.set(s.lastY - s.grabY)
  const patch: Partial<typeof IDLE_DRAG> = {
    target: null,
    favIndex: null,
    intoFolder: null,
    spaceTarget: null,
    outside: false,
  }
  let target: DropTarget | null = null
  if (zone.kind === 'list') {
    target = listTarget(s, useDrag.getState().target)
    patch.target = target
    patch.intoFolder = target?.type === 'into' ? target.folderId : null
  } else if (zone.kind === 'favorites' && s.ids.every(isTabId)) {
    patch.favIndex = favoritesIndex(s)
  } else if (zone.kind === 'space') {
    patch.spaceTarget = zone.spaceId
  } else if (zone.kind === 'outside') {
    patch.outside = s.ids.length === 1 && isTabId(s.ids[0] as string)
  }
  patch.shifts = shiftsFor(s, target)
  const prev = useDrag.getState()
  if (prev.spaceTarget !== (patch.spaceTarget ?? null)) markSpaceTarget(patch.spaceTarget ?? null)
  if (
    !sameTarget(prev.target, target) ||
    prev.target?.gapTop !== target?.gapTop ||
    prev.favIndex !== patch.favIndex ||
    prev.spaceTarget !== patch.spaceTarget ||
    prev.outside !== patch.outside ||
    prev.intoFolder !== patch.intoFolder
  ) {
    useDrag.setState(patch)
  }
  // Space dwell near the sidebar's left/right edge (SP-21).
  const sidebar = ctx.sidebar?.getBoundingClientRect()
  const side =
    sidebar && zone.kind !== 'outside'
      ? s.lastX < sidebar.left + 10
        ? 'left'
        : s.lastX > sidebar.right - 6 && s.lastX < sidebar.right + 24
          ? 'right'
          : null
      : null
  if (!side) s.dwell = null
  else if (!s.dwell || s.dwell.side !== side) s.dwell = { side, since: performance.now() }
}

/** Highlights the Space switcher target under the pointer (SP-21); SpaceBar stays untouched. */
function markSpaceTarget(spaceId: string | null): void {
  for (const el of document.querySelectorAll('.is-drop-target[data-space-id]')) el.classList.remove('is-drop-target')
  if (spaceId) document.querySelector(`[data-space-id="${spaceId}"]`)?.classList.add('is-drop-target')
}

function shiftsFor(s: Session, target: DropTarget | null): Record<string, number> {
  if (ctx.spaceId !== s.spaceAtStart) {
    // Rows of another Space: only open the gap (the dragged rows aren't here).
    const shifts: Record<string, number> = {}
    if (target?.type === 'between') {
      s.slots.forEach((sl, i) => {
        if (i >= target.at) shifts[sl.key] = s.blockHeight
      })
    }
    return shifts
  }
  return rowShifts(s.slots, s.dragged, target ?? undefined)
}

/** Grid slot under the pointer; `withDragged` counts the dragged tile too (an ⌥-copy leaves it). */
function favoritesIndex(s: Session, withDragged = false): number {
  const fav = ctx.favorites
  if (!fav) return 0
  const tiles = [...fav.querySelectorAll<HTMLElement>('[data-fav-id]')].filter(
    (el) => withDragged || !s.dragged.has(el.dataset.favId ?? ''),
  )
  return gridDropIndex(
    tiles.map((el) => el.getBoundingClientRect()),
    s.lastX,
    s.lastY,
  )
}

/** Per-frame work while dragging: edge auto-scroll and Space dwell. */
function tick(s: Session): void {
  s.raf = requestAnimationFrame(() => {
    if (!s.started || session !== s) return
    const scroll = ctx.scroll
    if (scroll) {
      const r = scroll.getBoundingClientRect()
      let dy = 0
      if (s.lastY < r.top + SCROLL_EDGE && s.lastY > r.top - SCROLL_EDGE) {
        dy = -Math.ceil(((r.top + SCROLL_EDGE - s.lastY) / SCROLL_EDGE) * SCROLL_MAX)
      } else if (s.lastY > r.bottom - SCROLL_EDGE && s.lastY < r.bottom + SCROLL_EDGE) {
        dy = Math.ceil(((s.lastY - (r.bottom - SCROLL_EDGE)) / SCROLL_EDGE) * SCROLL_MAX)
      }
      if (dy !== 0) {
        const before = scroll.scrollTop
        scroll.scrollTop = before + dy
        if (scroll.scrollTop !== before) update(s)
      }
    }
    if (s.dwell && performance.now() - s.dwell.since > SPACE_DWELL_MS) {
      const order = getOrbitState().spaceOrder
      const i = order.indexOf(ctx.spaceId)
      const next = order[i + (s.dwell.side === 'left' ? -1 : 1)]
      s.dwell = { side: s.dwell.side, since: performance.now() }
      if (next) {
        void invoke('spaces.switch', { spaceId: next }).then(() => remeasure(s))
      }
    }
    tick(s)
  })
}

/** After the sidebar shows another Space mid-drag, measure its rows. */
function remeasure(s: Session): void {
  requestAnimationFrame(() => {
    if (session !== s || !s.started) return
    useDrag.setState({ shifts: {} })
    requestAnimationFrame(() => {
      if (session !== s) return
      s.slots = measureSlots()
      update(s)
    })
  })
}

/** Ends a drag: idle state, and keyboard focus back to the page (it moved to the sidebar for Escape). */
function endSession(s: Session): void {
  if (session === s) session = null
  document.documentElement.classList.remove('is-dragging-tab')
  markSpaceTarget(null)
  useDrag.setState(IDLE_DRAG)
  void invoke('tabs.focusPage', {})
}

/** Commits a drop, then lets the ghost settle into the row's new place. */
async function drop(s: Session, ev: PointerEvent): Promise<void> {
  const zone = zoneAt(ev.clientX, ev.clientY)
  const state = useDrag.getState()
  const first = s.ids[0] as ItemId
  let commit: (() => Promise<unknown>) | null = null
  let landing: 'row' | 'tile' | 'into' | 'away' = 'row'
  if (zone.kind === 'outside' && state.outside) {
    commit = () => invoke('tabs.toNewWindow', { tabId: first, x: ev.screenX, y: ev.screenY })
    landing = 'away'
  } else if (zone.kind === 'space') {
    commit = () => invoke('tabs.moveToSpace', { ids: s.ids, spaceId: zone.spaceId, section: 'today' })
    landing = 'away'
  } else if (zone.kind === 'favorites' && state.favIndex !== null) {
    const index = state.favIndex
    commit = () =>
      invoke('tabs.move', { id: first, ids: s.ids, to: { kind: 'favorites', profileId: ctx.profileId }, index })
    landing = 'tile'
  } else if (zone.kind === 'list' && state.target) {
    const target = state.target
    if (target.type === 'into') {
      commit = () =>
        invoke('tabs.move', {
          id: first,
          ids: s.ids,
          to: { kind: 'folder', folderId: target.folderId },
          index: Number.MAX_SAFE_INTEGER,
        })
      landing = 'into'
    } else {
      const to = parseContainerKey(target.container)
      if (to) commit = () => invoke('tabs.move', { id: first, ids: s.ids, to, index: target.index })
    }
  }
  if (!commit) {
    cancel(s)
    return
  }
  // ⌥-drag drops a copy (with history) and leaves the original in place (TB-09, TB-10).
  const copy = ev.altKey && s.ids.length === 1 && isTabId(first) && (zone.kind === 'list' || zone.kind === 'favorites')
  if (copy) {
    const target = state.target
    const to =
      zone.kind === 'favorites'
        ? { kind: 'favorites' as const, profileId: ctx.profileId }
        : target?.type === 'into'
          ? { kind: 'folder' as const, folderId: target.folderId }
          : target
            ? parseContainerKey(target.container)
            : undefined
    // The original stays where it is, so a copy uses the index of the list as it is now.
    const index =
      zone.kind === 'favorites'
        ? favoritesIndex(s, true)
        : target?.type === 'between'
          ? target.rawIndex
          : Number.MAX_SAFE_INTEGER
    commit = to ? () => invoke('tabs.duplicate', { tabId: first, to, index }) : null
    landing = 'away'
    if (!commit) {
      cancel(s)
      return
    }
  }
  const seqAtDrop = getSeq()
  // Land when the dropped item actually moved (not on an unrelated title or loading patch).
  const locKey = (st: OrbitState) => JSON.stringify(locate(st, first) ?? null)
  const locAtDrop = locKey(getOrbitState())
  useDrag.setState({ phase: 'committing' })
  let landed = false
  const land = () => {
    if (landed) return
    landed = true
    unsubscribe()
    // Same render as the new order: rows drop their offsets, the moved row stays hidden under the ghost.
    useDrag.setState({
      phase: 'landing',
      shifts: {},
      target: null,
      favIndex: null,
      intoFolder: null,
      spaceTarget: null,
      // A copy lands as a new row; the original reappears in place.
      ...(copy ? { hidden: {} } : {}),
    })
    requestAnimationFrame(() => settle(s, landing, state.intoFolder))
  }
  const unsubscribe = useMirror.subscribe((m) => {
    // A copy leaves the original in place: any newer state (with the copy) lands it.
    if (m.seq > seqAtDrop && (copy || locKey(m.state) !== locAtDrop)) land()
  })
  let ok: unknown = false
  try {
    ok = await commit()
  } catch {
    ok = false
  }
  if (ok === false && !landed) {
    unsubscribe()
    cancel(s)
    return
  }
  land()
}

function settle(s: Session, landing: 'row' | 'tile' | 'into' | 'away', folderId: string | null): void {
  const finish = () => endSession(s)
  if (reducedMotion()) {
    finish()
    return
  }
  const first = s.ids[0] as string
  let el: HTMLElement | null = null
  if (landing === 'tile') el = ctx.favorites?.querySelector<HTMLElement>(`[data-fav-id="${first}"]`) ?? null
  else if (landing === 'row') el = ctx.scroll?.querySelector<HTMLElement>(`[data-slot][data-key="${first}"]`) ?? null
  else if (landing === 'into' && folderId)
    el = ctx.scroll?.querySelector<HTMLElement>(`[data-slot][data-key="${folderId}"]`) ?? null
  if (!el || landing === 'away') {
    void Promise.all([animate(ghostOpacity, 0, { duration: 0.14 }), animate(ghostScale, 0.9, { duration: 0.14 })]).then(
      finish,
    )
    return
  }
  const r = el.getBoundingClientRect()
  if (landing === 'into') {
    // Absorbed into the folder (FL-10): shrink to half size and fade into the folder icon, which pulses.
    const icon = el.querySelector<HTMLElement>('.folder-row__icon')
    const target = icon?.getBoundingClientRect() ?? r
    void Promise.all([
      animate(ghostX, target.left - 4, { duration: 0.18, ease: [0.4, 0, 0.2, 1] }),
      animate(ghostY, target.top - r.height / 4, { duration: 0.18, ease: [0.4, 0, 0.2, 1] }),
      animate(ghostScale, 0.5, { duration: 0.18 }),
      animate(ghostOpacity, 0, { duration: 0.18 }),
    ]).then(() => {
      if (icon) {
        icon.classList.remove('is-absorbing')
        void icon.offsetWidth
        icon.classList.add('is-absorbing')
        setTimeout(() => icon.classList.remove('is-absorbing'), 260)
      }
      finish()
    })
    return
  }
  // The shadow eases off as the row settles (FL-10).
  void animate(ghostOpacity, 1, { duration: 0.15 })
  void Promise.all([
    animate(ghostX, r.left, SETTLE),
    animate(ghostY, r.top, SETTLE),
    animate(ghostScale, 1, SETTLE),
  ]).then(finish)
}

function cancel(s: Session): void {
  useDrag.setState({
    phase: 'cancelling',
    shifts: {},
    target: null,
    favIndex: null,
    intoFolder: null,
    spaceTarget: null,
  })
  const finish = () => endSession(s)
  if (reducedMotion() || ctx.spaceId !== s.spaceAtStart) {
    finish()
    return
  }
  void Promise.all([
    animate(ghostX, s.originX, SPRING),
    animate(ghostY, s.originY, SPRING),
    animate(ghostScale, 1, SPRING),
  ]).then(finish)
}
