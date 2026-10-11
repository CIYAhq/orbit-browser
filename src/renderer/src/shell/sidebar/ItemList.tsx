import { ChevronRight, Search, Undo2, Volume2, VolumeX, X } from 'lucide-react'
import { AnimatePresence, animate, motion, useIsPresent, useMotionValue, type Variants } from 'motion/react'
import {
  createContext,
  memo,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { isFolderId, isSplitId, isTabId } from '../../../../shared/ids'
import { ROW_MENU_PANEL } from '../../../../shared/row-menu'
import type { ItemId, OrbitState, TabId } from '../../../../shared/state'
import { isAwayFromPinned, rowTitle } from '../../../../shared/tabs'
import { splitOfTab, tabsInItem, visibleTabOrder } from '../../../../shared/tree'
import { invoke, isMac } from '../../api'
import {
  AT_ONCE,
  EASE,
  REDUCED,
  reducedMotion,
  SNAPPY,
  SNAPPY_EXIT,
  STANDARD,
  tween,
  useReducedMotion,
  waapi,
} from '../../motion'
import { activeTabId } from '../../selectors'
import { getOrbitState, useMirror, useOrbit } from '../../store'
import { Favicon } from '../../ui/Favicon'
import { CaptureIndicator } from '../media/CaptureIndicator'
import { pressItem } from './drag'
import { FolderGlyph } from './FolderGlyph'
import { menuAt } from './menu-at'
import { RenameField } from './RenameField'
import { RowWindowContext, useInRowWindow } from './row-window'
import { SplitRow } from './SplitRow'
import {
  appearsAtOnce,
  clearSelection,
  startRename,
  useDrag,
  useFolderSearch,
  useKeyboardFocus,
  usePressedTab,
  useRename,
  useSelection,
} from './ui-state'

/** Indent per folder level (FD-06). */
export const INDENT = 14

const ROW_SPRING = SNAPPY
/**
 * FL-12: a chevron turns over about 150–180 ms; a folder or the pinned section opens with the
 * snappy spring and closes a little quicker (its exit spring). Springs, so a click mid-way turns the
 * height around from its current speed (FL-01).
 */
export const CHEVRON = { duration: 0.16, ease: EASE.snappy }
export const REVEAL = { height: SNAPPY, opacity: tween('quick') }
export const CONCEAL = { height: SNAPPY_EXIT, opacity: tween('quick', { exit: true }) }

/**
 * A folder's children or the pinned section, opening and closing (FL-12): the box grows with the
 * snappy spring while its rows fade in one after another (`.is-revealing`), and shrinks a little
 * quicker as it fades. Only a box the user opens staggers (`stagger`, decided as it mounts), not one
 * drawn open with the sidebar. With reduced motion (FL-28) the box opens and closes at once, also
 * one opened before the setting turned on: it asks `useReducedMotion()`, as motion reads
 * OrbitMotionConfig only as an element mounts.
 */
export function RevealBox({
  className,
  stagger,
  children,
}: {
  className: string
  stagger: boolean
  children: React.ReactNode
}) {
  const reduced = useReducedMotion()
  const [revealing, setRevealing] = useState(() => stagger && !reduced)
  return (
    <motion.div
      className={`${className}${revealing ? ' is-revealing' : ''}`}
      initial={reduced ? false : { height: 0, opacity: revealing ? 1 : 0 }}
      animate={{ height: 'auto', opacity: 1, transition: REVEAL }}
      exit={{ height: 0, opacity: 0, transition: reduced ? AT_ONCE : CONCEAL }}
      onAnimationComplete={() => setRevealing(false)}
    >
      {children}
    </motion.div>
  )
}
/** The gap between rows in a list (`.item-list`'s `gap`). */
const LIST_GAP = 1
/** A tab row's height (`--row-h`). */
const ROW_HEIGHT = 32
/** Rows beyond this many in a batch leave together (FL-11 caps the sweep at about 450 ms). */
const MAX_STAGGER_ROWS = 12

/** What a row slot's enter and exit depend on. */
type SlotMotion = { stagger?: boolean; index?: number; travel?: boolean; spring?: boolean; merge?: boolean } | undefined

/**
 * A row travelling to another section (FL-07) moves with the standard spring, and the room it
 * leaves and the room it takes close and open with that spring too: the rows around re-flow with
 * it, and rows below both places stay put. The copy left behind is never drawn.
 */
const TRAVEL_ROOM = { height: STANDARD, marginBottom: STANDARD, opacity: { duration: 0 } }
/** Where a travelling row's room starts: none, the row itself drawn (it is on its way). */
const TRAVEL_FROM = { height: 0, marginBottom: -LIST_GAP, opacity: 1 }
/** A row sliding out of a split row it was a pane of opens its room with the reorder spring (SV-26). */
const REORDER_ROOM = { height: ROW_SPRING, marginBottom: ROW_SPRING, opacity: { duration: 0 } }

/**
 * Row enter/exit (FL-06, FL-09, FL-11): the row's height grows or collapses with the snappy
 * spring so neighbours glide; content fades in over the last part of the growth; a closing
 * row slides left 12 px as it fades; a Clear batch sweeps 24 px, 25 ms apart.
 */
const rowVariants: Variants = {
  // A row with no height also gives back the list's 1 px gap beside it (`marginBottom`), so the rows
  // below move by its whole room with the spring, never by a last pixel when it leaves the DOM.
  hidden: { height: 0, marginBottom: -LIST_GAP, opacity: 0 },
  shown: (c: SlotMotion) => ({
    height: 'auto',
    marginBottom: 0,
    opacity: 1,
    // FL-06: the content fades in over the last 60 % of the growth.
    transition: c?.travel
      ? c.spring
        ? REORDER_ROOM
        : TRAVEL_ROOM
      : { height: ROW_SPRING, marginBottom: ROW_SPRING, opacity: tween('quick', { delay: 0.07 }) },
  }),
  exit: (c: SlotMotion) => {
    if (reducedMotion()) {
      // FL-28: no slide and no stagger. Closing rows, or a whole Clear, fade out together, then
      // their room closes at once.
      const fade = REDUCED.fadeMs / 1000
      const close = { duration: 0, delay: fade }
      return {
        height: 0,
        marginBottom: -LIST_GAP,
        opacity: 0,
        transition: { opacity: { duration: fade }, height: close, marginBottom: close },
      }
    }
    if (c?.travel) return { height: 0, marginBottom: -LIST_GAP, opacity: 0, transition: TRAVEL_ROOM }
    // SV-26: a row joining a split row fades in place as its room closes up into it.
    if (c?.merge) {
      const close = { height: ROW_SPRING, marginBottom: ROW_SPRING, opacity: tween('quick', { exit: true }) }
      return { height: 0, marginBottom: -LIST_GAP, opacity: 0, transition: close }
    }
    // FL-09: a closing row collapses while it fades and slides; a Clear's rows (FL-11) start
    // collapsing a moment after their slide.
    const delay = c?.stagger ? Math.min(c.index ?? 0, MAX_STAGGER_ROWS) * 0.025 : 0
    const collapse = { ...ROW_SPRING, delay: c?.stagger ? delay + 0.04 : 0 }
    return {
      height: 0,
      marginBottom: -LIST_GAP,
      opacity: 0,
      x: c?.stagger ? -24 : -12,
      transition: {
        height: collapse,
        marginBottom: collapse,
        opacity: { duration: c?.stagger ? 0.16 : 0.13, ease: EASE.quick, delay },
        x: { duration: c?.stagger ? 0.16 : 0.13, ease: EASE.quick, delay },
      },
    }
  },
}

/**
 * Bulk inserts (open all, import, restore) animate only their first rows: at most a dozen
 * rows grow in per 300 ms burst, the rest appear in place (FL-06 caps a burst at ~300 ms).
 */
let enterBurstStart = 0
let enterBurstCount = 0
function claimEnterAnimation(): boolean {
  const now = performance.now()
  if (now - enterBurstStart > 300) {
    enterBurstStart = now
    enterBurstCount = 0
  }
  enterBurstCount += 1
  return enterBurstCount <= 12
}

/**
 * Rows that change section without a drag (⌘D, Move to, undo) travel from where they were
 * (FL-07). Before the new state renders, remember where each arriving row is drawn now; the
 * row mounted in its new list starts there and springs into place.
 */
const departed = new Map<string, { top: number; left: number; at: number; spring?: boolean }>()

/**
 * Rows of a list becoming one split row there, or a split row becoming rows again (SV-26), move with
 * the reorder spring (TB-08): the row taking the others' place is drawn whole from its first frame
 * (`whole`), the row whose room it takes goes at once (`gone`), and the others fade as their room
 * closes up into it (`into`), or slide out from under it (`departed`, with `spring`).
 */
const splitMotion = new Map<string, { kind: 'whole' | 'gone' | 'into'; at: number }>()

/** Whether the row `id` mounting or leaving now moves this way (taken once). */
function takeSplitMotion(id: string, kind: 'whole' | 'gone' | 'into'): boolean {
  const m = splitMotion.get(id)
  if (m?.kind !== kind) return false
  splitMotion.delete(id)
  return performance.now() - m.at < 250
}

/** Two rows or more of a list becoming a split row there, or one becoming them (SV-26). */
function noteSplitRows(prev: OrbitState, next: OrbitState, old: ItemId[], items: ItemId[], now: number): void {
  for (const id of items) {
    if (!isSplitId(id) || old.includes(id)) continue
    const rows = tabsInItem(next, id).filter((t) => old.includes(t) && !items.includes(t))
    if (rows.length < 2) continue
    // The split row is drawn where the lowest of them was; the ones above close up into it.
    rows.sort((a, b) => old.indexOf(a) - old.indexOf(b))
    splitMotion.set(id, { kind: 'whole', at: now })
    for (const t of rows) splitMotion.set(t, { kind: t === rows.at(-1) ? 'gone' : 'into', at: now })
  }
  for (const id of old) {
    if (!isSplitId(id) || items.includes(id)) continue
    const rows = tabsInItem(prev, id).filter((t) => items.includes(t) && !old.includes(t))
    const el = document.querySelector<HTMLElement>(`[data-slot][data-key="${id}"]:not([data-exiting])`)
    if (rows.length < 2 || !el) continue
    // The first is drawn in the split row's place; the others slide out from under it.
    rows.sort((a, b) => items.indexOf(a) - items.indexOf(b))
    const r = el.getBoundingClientRect()
    splitMotion.set(id, { kind: 'gone', at: now })
    for (const [i, t] of rows.entries()) {
      if (i === 0) splitMotion.set(t, { kind: 'whole', at: now })
      else departed.set(t, { top: r.top, left: r.left, at: now, spring: true })
    }
  }
}
/**
 * Rows moving to a place scrolled out of sight (FL-07): they appear there at once, since nothing
 * there is seen, and the list's scroll anchoring keeps the rows in sight still in that same frame.
 * A link's row landing in the room opened for it appears at once too (NV-08).
 */
const arrivesUnseen = appearsAtOnce

/** Whether the row `id` mounting now arrives out of sight (taken once). */
function takeUnseenArrival(id: string): boolean {
  const at = arrivesUnseen.get(id)
  arrivesUnseen.delete(id)
  return at !== undefined && performance.now() - at < 250
}

function listsOf(state: OrbitState): Map<string, ItemId[]> {
  const lists = new Map<string, ItemId[]>()
  for (const space of Object.values(state.spaces)) {
    lists.set(`pinned:${space.id}`, space.pinned)
    lists.set(`today:${space.id}`, space.today)
  }
  for (const folder of Object.values(state.folders)) lists.set(`folder:${folder.id}`, folder.children)
  return lists
}

useMirror.subscribe((next, prev) => {
  if (!prev.state || !next.state || next.state === prev.state) return
  if (next.state.spaces === prev.state.spaces && next.state.folders === prev.state.folders) return
  if (useDrag.getState().phase !== 'idle') return
  const before = listsOf(prev.state)
  const now = performance.now()
  for (const [id, d] of departed) if (now - d.at > 1000) departed.delete(id)
  for (const [id, at] of arrivesUnseen) if (now - at > 1000) arrivesUnseen.delete(id)
  for (const [id, m] of splitMotion) if (now - m.at > 1000) splitMotion.delete(id)
  for (const [key, items] of listsOf(next.state)) {
    const old = before.get(key)
    if (old === items) continue
    // Only lists on screen: a row moving somewhere not drawn (a collapsed folder, another Space)
    // or scrolled out of sight just leaves (FL-07: it collapses out in place, and nothing scrolls).
    const list = document.querySelector<HTMLElement>(`[data-list="${key}"]`)
    if (!list) continue
    if (old && !reducedMotion()) noteSplitRows(prev.state, next.state, old, items, now)
    for (const id of items) {
      if (old?.includes(id)) continue
      const el = document.querySelector<HTMLElement>(`[data-slot][data-key="${id}"]:not([data-exiting])`)
      if (!el || el.dataset.container === key) continue
      if (!arrivesInSight(list, items, id)) {
        arrivesUnseen.set(id, now)
        continue
      }
      const r = el.getBoundingClientRect()
      departed.set(id, { top: r.top, left: r.left, at: now })
    }
  }
})

/** Whether the row `id`, arriving in `list` (to be `items`), will be drawn within the sidebar's visible band. */
function arrivesInSight(list: HTMLElement, items: ItemId[], id: ItemId): boolean {
  const view = list.closest('[data-testid="sidebar-scroll"]')?.getBoundingClientRect()
  if (!view) return true
  const i = items.indexOf(id)
  const slot = (k: ItemId | undefined) =>
    k === undefined ? null : list.querySelector<HTMLElement>(`:scope > [data-slot][data-key="${k}"]`)
  // Its top: the bottom of the row it follows, the top of the row it comes before, or the list's top.
  const top =
    slot(items[i - 1])?.getBoundingClientRect().bottom ??
    slot(items[i + 1])?.getBoundingClientRect().top ??
    list.getBoundingClientRect().top
  return top + ROW_HEIGHT / 2 >= view.top && top + ROW_HEIGHT / 2 <= view.bottom
}

/** Rows leaving together, in list order (drives the cascade delay). */
const exitOrder = new Map<string, number>()

/** A list of sidebar items (tabs, folders, split views) in one container. */
export const ItemList = memo(function ItemList({
  containerKey,
  items,
  depth = 0,
  ancestors = '',
  testId,
}: {
  containerKey: string
  items: ItemId[]
  depth?: number
  ancestors?: string
  testId?: string
}) {
  // Several rows leaving at once (Clear, archive below) sweep out in a cascade (TD-04).
  const prev = useRef(items)
  if (prev.current !== items) {
    const removed = prev.current.filter((id) => !items.includes(id))
    if (removed.length > 1) {
      for (const [k, id] of removed.entries()) exitOrder.set(id, k)
    }
    prev.current = items
  }
  // Its height moves the rows below it: the row window measures again when it changes (FL-21).
  const win = useContext(RowWindowContext)
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => (win && ref.current ? win.watch(ref.current) : undefined), [win])
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
  }, [])
  return (
    <div className="item-list" ref={ref} data-testid={testId} data-list={containerKey}>
      <ListMounted.Provider value={mounted}>
        <AnimatePresence initial={false}>
          {items.map((id, index) => {
            if (isTabId(id))
              return (
                <TabRow
                  key={id}
                  tabId={id}
                  depth={depth}
                  containerKey={containerKey}
                  index={index}
                  size={items.length}
                  ancestors={ancestors}
                />
              )
            if (isFolderId(id))
              return (
                <FolderRow
                  key={id}
                  folderId={id}
                  depth={depth}
                  containerKey={containerKey}
                  index={index}
                  size={items.length}
                  ancestors={ancestors}
                />
              )
            if (isSplitId(id))
              return (
                <SplitSlot
                  key={id}
                  splitId={id}
                  depth={depth}
                  containerKey={containerKey}
                  index={index}
                  size={items.length}
                  ancestors={ancestors}
                />
              )
            return null
          })}
        </AnimatePresence>
      </ListMounted.Provider>
    </div>
  )
})

/** Whether the list had been drawn before: a row added to it later is drawn before it is measured. */
const ListMounted = createContext<{ readonly current: boolean }>({ current: true })

/** Row offset while a drag opens a gap; jumps (no animation) when the drop commits. */
export function useRowShift(key: string) {
  const shift = useDrag((s) => s.shifts[key] ?? 0)
  const animated = useDrag((s) => s.phase === 'dragging' || s.phase === 'cancelling')
  const y = useMotionValue(0)
  useLayoutEffect(() => {
    if (animated && !reducedMotion()) {
      const controls = animate(y, shift, ROW_SPRING)
      return () => controls.stop()
    }
    y.jump(shift)
    return undefined
  }, [shift, animated, y])
  return y
}

interface SlotProps {
  depth: number
  containerKey: string
  /** The item's place in its list (0 = the first). */
  index: number
  /** How many items its list has. */
  size: number
  ancestors: string
}

/** Wrapper that animates a row in and out and carries its drag-and-drop slot data. */
function RowSlot({
  id,
  folder,
  children,
  depth,
  containerKey,
  index,
  ancestors,
  className = 'row-slot',
  far = false,
  whole = false,
  onPointerDown,
}: SlotProps & {
  id: string
  folder?: 'open' | 'closed'
  children: React.ReactNode
  className?: string
  /** Far from the visible band, drawing nothing (FL-21). */
  far?: boolean
  /** Drawn whole from its first frame, never growing in (a folder that arrives with its tabs, AR-11). */
  whole?: boolean
  onPointerDown?: (e: ReactPointerEvent<HTMLDivElement>) => void
}) {
  const y = useRowShift(id)
  const x = useMotionValue(0)
  const ref = useRef<HTMLDivElement>(null)
  const hidden = useDrag((s) => !!s.hidden[id])
  // A tab dragged onto this row's half joins it as a split on that side (SV-05).
  const splitSide = useDrag((s) => (s.target?.type === 'split' && s.target.key === id ? s.target.side : null))
  const present = useIsPresent()
  // A row arriving from another section travels instead of growing in (FL-07).
  const [travel] = useState(() => {
    const d = departed.get(id)
    return d && !hidden && !reducedMotion() && performance.now() - d.at < 250 ? d : null
  })
  const [flying, setFlying] = useState(!!travel)
  // Rows that arrive or leave through a drag appear/disappear at once (the ghost covers them). A
  // travelling row's room opens as it travels; the row itself is drawn whole all along.
  const [instant] = useState(
    () =>
      whole ||
      takeSplitMotion(id, 'whole') ||
      hidden ||
      reducedMotion() ||
      takeUnseenArrival(id) ||
      (!travel && !claimEnterAnimation()),
  )
  const [growing, setGrowing] = useState(!instant && !travel)
  useLayoutEffect(() => {
    if (!travel) return
    departed.delete(id)
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const dy = travel.top - r.top
    const dx = travel.left - r.left
    if (Math.abs(dy) < 1 && Math.abs(dx) < 1) return
    y.jump(dy)
    x.jump(dx)
    const a = animate(y, 0, travel.spring ? ROW_SPRING : STANDARD)
    const b = animate(x, 0, travel.spring ? ROW_SPRING : STANDARD)
    void Promise.all([a, b]).then(() => setFlying(false))
    return () => {
      a.stop()
      b.stop()
    }
  }, [travel, id, x, y])
  // The copy left behind only makes room; the row itself is already travelling. Decided as it
  // starts leaving: the row's arrival takes the record of where it was.
  const leaving = useMemo(() => {
    if (present) return false
    const gone = departed.get(id)
    return !!gone && performance.now() - gone.at < 250
  }, [present, id])
  // Leaving into a split row (SV-26): its room goes at once, or closes up into it.
  const merge = useMemo(
    () => (present ? null : takeSplitMotion(id, 'gone') ? 'gone' : takeSplitMotion(id, 'into') ? 'into' : null),
    [present, id],
  )
  if (!present && (hidden || merge === 'gone')) return null
  const order = present ? undefined : exitOrder.get(id)
  return (
    <motion.div
      ref={ref}
      className={`${className}${far ? ' is-far' : ''}${hidden || leaving ? ' is-drag-hidden' : ''}${flying ? ' is-travelling' : ''}${growing ? ' is-growing' : ''}${present ? '' : ' is-exiting'}${splitSide ? ` is-split-target is-split-${splitSide}` : ''}`}
      style={{ y, x }}
      variants={rowVariants}
      custom={{
        stagger: order !== undefined,
        index: order,
        travel: present ? !!travel : leaving,
        spring: present && !!travel?.spring,
        merge: merge === 'into',
      }}
      onAnimationComplete={(definition) => {
        if (!present) exitOrder.delete(id)
        else if (definition === 'shown' && growing) setGrowing(false)
      }}
      initial={travel ? TRAVEL_FROM : instant ? false : 'hidden'}
      animate="shown"
      exit="exit"
      onPointerDown={onPointerDown}
      data-slot="item"
      data-key={id}
      data-container={containerKey}
      data-index={index}
      data-depth={depth}
      data-folder={folder}
      data-ancestors={ancestors || undefined}
      data-exiting={present ? undefined : '1'}
    >
      {children}
    </motion.div>
  )
}

function onRowPointerDown(e: ReactPointerEvent<HTMLElement>, tabId: TabId) {
  if (e.button !== 0) return
  const sel = useSelection.getState()
  if ((isMac ? e.metaKey : e.ctrlKey) && e.altKey && !e.shiftKey) {
    // ⌘⌥-click opens the tab in a Mini Window (MW-07; owned by the peek lane).
    e.preventDefault()
    void invoke('mini.fromTab', { tabId })
    return
  }
  if ((isMac ? e.metaKey : e.ctrlKey) && !e.altKey) {
    // ⌘-click toggles a row in the multi-selection (TB-13).
    e.preventDefault()
    const active = activeTabId(getOrbitState())
    const base = sel.ids.length > 0 ? sel.ids : active && active !== tabId ? [active] : []
    const ids = base.includes(tabId) ? base.filter((id) => id !== tabId) : [...base, tabId]
    useSelection.setState({ ids, anchor: tabId })
    return
  }
  if (e.shiftKey) {
    // ⇧-click selects a contiguous range in sidebar order (TB-13).
    e.preventDefault()
    const state = getOrbitState()
    const win = state.windows[window.orbit.windowId]
    const active = activeTabId(state)
    const order = win ? visibleTabOrder(state, win.spaceId, { activeTabId: active, includeFavorites: false }) : []
    const anchor = sel.anchor ?? active ?? tabId
    const a = order.indexOf(anchor)
    const b = order.indexOf(tabId)
    if (a >= 0 && b >= 0) {
      // The range joins what is already selected (⌘-clicked rows stay).
      const range = order.slice(Math.min(a, b), Math.max(a, b) + 1)
      const base = sel.ids.length > 0 ? sel.ids : active ? [active] : []
      useSelection.setState({ ids: [...new Set([...base, ...range])], anchor })
    }
    return
  }
  // A press on a selected row keeps the selection (to drag the group); a plain click clears it.
  const inSelection = useSelection.getState().ids.includes(tabId)
  if (!inSelection) clearSelection()
  pressSelect(tabId)
  void invoke('tabs.activate', { tabId })
  // A pane of a split view drags the whole split row.
  const item = splitOfTab(getOrbitState(), tabId) ?? tabId
  pressItem(e, item, 'list', inSelection ? clearSelection : undefined)
}

let pressTimer = 0

/**
 * FL-05: the pressed row is drawn selected in the frame after the press, and the row selected before
 * loses its highlight in that frame too, without waiting for main's round trip. Main's state takes
 * over as soon as it shows a different active tab; should it not (the press was refused), the real
 * selection shows again after a moment.
 */
function pressSelect(tabId: TabId): void {
  const was = activeTabId(getOrbitState())
  if (was === tabId) return
  usePressedTab.setState({ id: tabId, was })
  clearTimeout(pressTimer)
  pressTimer = window.setTimeout(() => usePressedTab.setState({ id: null, was: null }), 1000)
}

useMirror.subscribe((next, prev) => {
  const pressed = usePressedTab.getState()
  if (!pressed.id || next.state === prev.state || !next.state) return
  if (activeTabId(next.state) === pressed.was) return
  clearTimeout(pressTimer)
  usePressedTab.setState({ id: null, was: null })
})

/** A row's selected look: the pressed row's, until main's state catches up; otherwise the state's. */
function useShownActive(tabId: TabId): boolean {
  const real = useOrbit((s) => activeTabId(s) === tabId)
  const pressed = usePressedTab((p) => (p.id === tabId ? true : p.was === tabId ? false : undefined))
  return pressed ?? real
}

/** Each row's running hover fade. */
const hoverFades = new WeakMap<HTMLElement, Animation>()

/**
 * Hover fades (FL-04): in with the instant timing, out with the quick one. Uses the Web Animations
 * API on top of the CSS :hover background, so nothing waits on it and no transition events are
 * fired. A fade still running when the pointer turns round goes back from what the row shows (FL-01:
 * a quick sweep never flashes a row up to full before it fades), and starts in the frame it is made.
 */
function fadeHover(el: HTMLElement, entering: boolean) {
  if (reducedMotion() || useDrag.getState().phase !== 'idle') return
  if (el.classList.contains('is-active') || el.classList.contains('is-selected')) return
  // The theme's hover colour by reference: no style read for each row the pointer crosses, which
  // during a scroll under a still pointer is a row or two every frame (FL-21).
  const hover = 'var(--hover)'
  const running = hoverFades.get(el)
  const from = running?.playState === 'running' ? getComputedStyle(el).backgroundColor : null
  running?.cancel()
  const fade = el.animate(
    [
      { backgroundColor: from ?? (entering ? 'transparent' : hover) },
      { backgroundColor: entering ? hover : 'transparent' },
    ],
    entering ? waapi('instant') : waapi('quick'),
  )
  const now = document.timeline.currentTime
  if (typeof now === 'number') fade.startTime = now
  hoverFades.set(el, fade)
}

function openContextMenu(e: ReactMouseEvent, id: ItemId) {
  e.preventDefault()
  const sel = useSelection.getState().ids
  void invoke('tabs.contextMenu', { id, selection: sel.includes(id) ? sel : [], at: menuAt(e, id) })
}

export const TabRow = memo(function TabRow({
  tabId,
  depth,
  containerKey,
  index,
  size,
  ancestors,
}: { tabId: string } & SlotProps) {
  // Drawn near the list's visible band only (FL-21); a row added to a list already on screen is drawn
  // at once, and the selected, focused, selected-for-a-group or renamed row always is.
  const listMounted = useContext(ListMounted)
  const near = useInRowWindow(tabId, listMounted.current)
  const drawn = useKeptRow(tabId) || near
  return (
    <RowSlot
      id={tabId}
      far={!drawn}
      depth={depth}
      containerKey={containerKey}
      index={index}
      size={size}
      ancestors={ancestors}
      onPointerDown={(e) => {
        // A press the slot itself hears (its edge, or a row not drawn yet) is a press on its row
        // (PR #10 review F1).
        if (e.target === e.currentTarget || !drawn) onRowPointerDown(e, tabId)
      }}
    >
      {drawn ? (
        <TabRowBody tabId={tabId} depth={depth} index={index} size={size} />
      ) : (
        <div className="row-placeholder" />
      )}
    </RowSlot>
  )
})

/**
 * Rows drawn wherever they are: the selected one, the keyboard's, those in a group selection, one
 * being renamed, one whose menu is open (TB-14: its items act on it however far the list scrolls).
 */
function useKeptRow(tabId: TabId): boolean {
  const active = useShownActive(tabId)
  const focused = useKeyboardFocus((s) => s.id === tabId)
  const selected = useSelection((s) => s.ids.includes(tabId))
  const renaming = useRename((s) => s.id === tabId)
  const menu = useRowMenuOpen(tabId)
  return active || focused || selected || renaming || menu
}

/** The row's right-click menu is open in this window's overlay (TB-14). */
export function useRowMenuOpen(key: string): boolean {
  return useOrbit((s) => {
    const overlay = s.windows[window.orbit.windowId]?.overlay
    return overlay?.kind === 'panel' && overlay.panel === ROW_MENU_PANEL && overlay.params?.key === key
  })
}

/**
 * The row itself (TB-01): icon, title (or breadcrumb, PN-03), audio, close. It tells assistive
 * technology its place in its list, as rows away from the visible band draw nothing (FL-21).
 */
export const TabRowBody = memo(function TabRowBody({
  tabId,
  depth,
  index,
  size,
}: {
  tabId: string
  depth: number
  /** Its place in its list (0 = the first); -1 when it isn't in it (a peek under a closed folder). */
  index: number
  size: number
}) {
  const live = useOrbit((s) => s.tabs[tabId])
  // A closed tab's row keeps drawing its last look while it animates out (FL-09).
  const last = useRef(live)
  if (live) last.current = live
  const tab = live ?? last.current
  const active = useShownActive(tabId)
  const selected = useSelection((s) => s.ids.includes(tabId))
  const focused = useKeyboardFocus((s) => s.id === tabId)
  const renaming = useRename((s) => (s.id === tabId ? s.mode : null))
  const menuOpen = useRowMenuOpen(tabId)
  const [iconHover, setIconHover] = useState(false)
  // A tab that just opened in the background glows once so the eye finds it (FL-06).
  const [fresh] = useState(() => !!tab && !active && Date.now() - tab.createdAt < 1500)
  const rowRef = useRef<HTMLDivElement>(null)
  // Selected: the highlight shows in this frame, not after a hover fade still running over it (FL-05).
  useLayoutEffect(() => {
    if (active && rowRef.current) hoverFades.get(rowRef.current)?.cancel()
  }, [active])
  if (!tab) return null
  const { prefix, title } = rowTitle(tab)
  const away = isAwayFromPinned(tab)
  const showReset = away && iconHover
  return (
    <div
      ref={rowRef}
      role="treeitem"
      tabIndex={-1}
      aria-selected={active}
      aria-level={depth + 1}
      aria-posinset={index >= 0 ? index + 1 : undefined}
      aria-setsize={index >= 0 ? size : undefined}
      aria-label={prefix ? `${prefix} / ${title}` : title}
      className={`tab-row${active ? ' is-active' : ''}${selected ? ' is-selected' : ''}${tab.asleep ? ' is-asleep' : ''}${tab.loading ? ' is-loading' : ''}${away ? ' is-away' : ''}${focused ? ' is-focused' : ''}${fresh ? ' is-new-background' : ''}${menuOpen ? ' is-menu-open' : ''}`}
      style={{ paddingLeft: 8 + depth * INDENT }}
      data-testid="tab-row"
      data-tab-id={tabId}
      onPointerDown={(e) => onRowPointerDown(e, tabId)}
      onPointerEnter={(e) => fadeHover(e.currentTarget, true)}
      onPointerLeave={(e) => fadeHover(e.currentTarget, false)}
      onAuxClick={(e) => {
        if (e.button === 1) void invoke('tabs.close', { tabId })
      }}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('button')) return
        startRename(tabId)
      }}
      onContextMenu={(e) => openContextMenu(e, tabId)}
    >
      <span
        className={`tab-row__icon${away ? ' tab-row__icon--resettable' : ''}`}
        data-testid="tab-icon"
        onMouseEnter={() => setIconHover(true)}
        onMouseLeave={() => setIconHover(false)}
        onPointerDown={(e) => {
          if (!away || e.button !== 0) return
          // Click the favicon of a pinned tab that wandered off: back to its pinned page (PN-04).
          e.stopPropagation()
          void invoke('tabs.activate', { tabId })
          void invoke('tabs.resetToPinned', { tabId, keepCurrent: isMac ? e.metaKey : e.ctrlKey })
        }}
      >
        {showReset ? (
          <Undo2 size={14} strokeWidth={2.2} className="tab-row__reset-glyph" data-testid="reset-pinned" />
        ) : tab.icon ? (
          <span className="tab-row__emoji">{tab.icon}</span>
        ) : (
          <Favicon src={tab.favicon} />
        )}
      </span>
      {renaming ? (
        <RenameField
          id={tabId}
          mode={renaming}
          initial={renaming === 'url' ? (tab.pinnedUrl ?? tab.url) : (tab.customTitle ?? tab.title)}
        />
      ) : (
        <span className="tab-row__title" data-testid="tab-title">
          {showReset ? (
            <span className="tab-row__hint">Return to pinned page</span>
          ) : (
            <>
              {prefix && (
                <span className="tab-row__crumb" data-testid="tab-crumb">
                  {prefix}
                  <span className="tab-row__slash"> / </span>
                </span>
              )}
              {title}
            </>
          )}
        </span>
      )}
      {/* Media lane: camera / microphone in use (TB-15). */}
      <CaptureIndicator media={tab.media} />
      {(tab.audible || tab.muted) && (
        <button
          type="button"
          className="tab-row__audio"
          data-testid="tab-audio"
          aria-label={tab.muted ? 'Unmute tab' : 'Mute tab'}
          title={tab.muted ? 'Unmute' : 'Mute'}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => void invoke('tabs.setMuted', { tabId, muted: !tab.muted })}
        >
          {tab.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
        </button>
      )}
      <button
        type="button"
        className="tab-row__close"
        aria-label="Close tab"
        title="Close"
        data-testid="tab-close"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => void invoke('tabs.close', { tabId })}
      >
        <X size={13} strokeWidth={2.2} />
      </button>
    </div>
  )
})

const FolderRow = memo(function FolderRow({
  folderId,
  depth,
  containerKey,
  index,
  size,
  ancestors,
}: { folderId: string } & SlotProps) {
  const liveFolder = useOrbit((s) => s.folders[folderId])
  const lastFolder = useRef(liveFolder)
  if (liveFolder) lastFolder.current = liveFolder
  const folder = liveFolder ?? lastFolder.current
  // FD-04: the selected tab stays visible under a closed folder ("peeking").
  const peek = useOrbit((s) => {
    const f = s.folders[folderId]
    if (!f?.collapsed) return null
    const active = activeTabId(s)
    return active && tabsInItem(s, folderId).includes(active) ? active : null
  })
  const into = useDrag((s) => s.intoFolder === folderId)
  const focused = useKeyboardFocus((s) => s.id === folderId)
  const menuOpen = useRowMenuOpen(folderId)
  const renaming = useRename((s) => s.id === folderId)
  const hidden = useDrag((s) => !!s.hidden[folderId])
  const collapsedBefore = useRef<boolean | null>(null)
  // Drawn before: children shown from now on were opened by the user (FL-12).
  const shown = useRef(false)
  useEffect(() => {
    shown.current = true
  }, [])
  // The chevron turns at once with reduced motion, also after the folder was drawn (FL-28).
  const reduced = useReducedMotion()
  // A folder that arrives open with its tabs (Restore Data, undo, a new folder from tabs) draws its
  // row in the frame they show: they appear at once (its children's list mounts with it), so a row
  // growing in would show them for a moment without it, then push them down (AR-11).
  const [arrivesWhole] = useState(() => !!liveFolder && !liveFolder.collapsed && liveFolder.children.length > 0)
  if (!folder) return null
  const childAncestors = ancestors ? `${ancestors},${folderId}` : folderId
  // A deleted folder animating out draws no children (they're gone or moved on).
  const open = !!liveFolder && !folder.collapsed
  return (
    <div className={`folder${hidden ? ' is-drag-hidden' : ''}`} data-testid="folder" data-folder-id={folderId}>
      <RowSlot
        id={folderId}
        folder={open ? 'open' : 'closed'}
        whole={arrivesWhole}
        depth={depth}
        containerKey={containerKey}
        index={index}
        size={size}
        ancestors={ancestors}
      >
        <div
          role="treeitem"
          tabIndex={-1}
          aria-expanded={open}
          aria-level={depth + 1}
          aria-posinset={index + 1}
          aria-setsize={size}
          className={`folder-row${into ? ' is-drop-into' : ''}${focused ? ' is-focused' : ''}${menuOpen ? ' is-menu-open' : ''}`}
          style={{ paddingLeft: 8 + depth * INDENT }}
          data-testid="folder-row"
          onPointerEnter={(e) => fadeHover(e.currentTarget, true)}
          onPointerLeave={(e) => fadeHover(e.currentTarget, false)}
          onPointerDown={(e) => {
            if (e.button !== 0 || renaming) return
            clearSelection()
            pressItem(e, folderId, 'list')
          }}
          onClick={(e) => {
            if (renaming || e.detail > 1) return
            collapsedBefore.current = folder.collapsed
            void invoke('folders.setCollapsed', { folderId, collapsed: open })
          }}
          onDoubleClick={() => {
            // A double-click renames (FD-03); undo the toggle its first click made.
            const before = collapsedBefore.current
            if (before !== null) void invoke('folders.setCollapsed', { folderId, collapsed: before })
            collapsedBefore.current = null
            startRename(folderId)
          }}
          onContextMenu={(e) => openContextMenu(e, folderId)}
        >
          <motion.span
            className="folder-row__chevron-wrap"
            initial={false}
            animate={{ rotate: open ? 90 : 0 }}
            transition={reduced ? AT_ONCE : CHEVRON}
          >
            <ChevronRight size={13} />
          </motion.span>
          <span className="folder-row__icon">
            {folder.icon ? <span className="tab-row__emoji">{folder.icon}</span> : <FolderGlyph open={open} />}
          </span>
          {renaming ? (
            <RenameField id={folderId} mode="name" initial={folder.name} />
          ) : (
            <span className="folder-row__title" data-testid="folder-title">
              {folder.name}
            </span>
          )}
          {!renaming && (
            <button
              type="button"
              className="folder-row__search"
              data-testid="folder-search-button"
              aria-label={`Search ${folder.name}`}
              title="Search this folder"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                useFolderSearch.setState({ id: folderId })
              }}
            >
              <Search size={12} strokeWidth={2.2} />
            </button>
          )}
        </div>
      </RowSlot>
      <AnimatePresence initial={false}>
        {open && (
          <RevealBox key="children" className="folder__children" stagger={shown.current}>
            <ItemList
              containerKey={`folder:${folderId}`}
              items={folder.children}
              depth={depth + 1}
              ancestors={childAncestors}
            />
          </RevealBox>
        )}
      </AnimatePresence>
      {!open && peek && (
        <div className="folder__peek" data-testid="folder-peek">
          <TabRow
            tabId={peek}
            depth={depth + 1}
            containerKey={`folder:${folderId}`}
            index={folder.children.indexOf(peek)}
            size={folder.children.length}
            ancestors={childAncestors}
          />
        </div>
      )}
    </div>
  )
})

/** A split view: one slot (dragged and animated as one item) around the split row. */
const SplitSlot = memo(function SplitSlot({
  splitId,
  depth,
  containerKey,
  index,
  size,
  ancestors,
}: { splitId: string } & SlotProps) {
  const exists = useOrbit((s) => !!s.splits[splitId])
  if (!exists) return null
  return (
    <RowSlot
      id={splitId}
      depth={depth}
      containerKey={containerKey}
      index={index}
      size={size}
      ancestors={ancestors}
      className="row-slot row-slot--split"
      onPointerDown={(e) => {
        // The split row selects its panes itself; the slot turns a press into a drag of the split.
        if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) pressItem(e, splitId, 'list')
      }}
    >
      <SplitRow splitId={splitId} depth={depth} index={index} size={size} />
    </RowSlot>
  )
})
