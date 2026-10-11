import { createContext, startTransition, useContext, useLayoutEffect, useState } from 'react'
import { flushSync } from 'react-dom'

/** Rows within this much of the list's visible band are always drawn, in screens (FL-21). */
const MARGIN_SCREENS = 1.5
const MIN_MARGIN_PX = 600
/**
 * Rows this close to the visible band (px) are drawn before the next frame; the others of the margin
 * render in the background, in slices between frames, as they are not on screen yet.
 */
const URGENT_PX = 120
/**
 * Once the band reaches rows not drawn yet, the rows this much further on are drawn with them, and
 * rows left behind are dropped only this much further out (in screens): the drawn rows change in
 * batches every few frames of a scroll, not by a row or two in every frame, and each change lays
 * the list out again.
 */
const BATCH_SCREENS = 0.5
/** A row's height and the list's gap: places a row that has not been laid out yet. */
const ROW_PITCH = 33
/** Rows drawn either side of the band a guess places: a row the guess draws in vain costs less than one it misses. */
const GUESS_SLACK_ROWS = 5

/**
 * Which tab rows of one sidebar scroller are drawn (FL-21): those near its visible band. The others
 * keep their slot, at a row's height, and draw nothing, so the list's DOM, layout, paint and hit
 * testing grow with the screen and not with the number of tabs. Slots stay for every item, so drag
 * and drop, keyboard selection and scrolling a row into view work on all of them.
 *
 * The band is measured on scroll, when the scroller or a list in it changes size, and whenever the
 * sidebar renders (SidebarItems), each before the frame is drawn, so no row on screen is ever a blank.
 * Rows mounting with a list (a Space shown, a folder opened) are placed by their order until then.
 */
export class RowWindow {
  private scroll: HTMLElement | null = null
  /** Rows drawn because they are near the band. */
  private near = new Set<string>()
  /** Rows mounted since the band was last measured. */
  private pending = new Set<string>()
  /** Rows drawn by the window now, as they report it. */
  private shown = new Set<string>()
  /** Rows near the band whose drawing is still rendering in the background. */
  private queued = new Set<string>()
  private listeners = new Map<string, Set<() => void>>()
  // Lists register as they mount, before the scroller is attached (children's effects run first).
  private sizes = new ResizeObserver(() => this.update(true))
  private height = 0
  private mounted = 0
  private expected: readonly [number, number] = [0, Number.POSITIVE_INFINITY]
  private leaving = new Set<string>()
  private dropTimer: ReturnType<typeof setTimeout> | undefined

  /** Drawn (near the band), not drawn (measured, away from it), or undefined: not measured yet. */
  get(key: string): boolean | undefined {
    if (this.near.has(key)) return true
    return this.listeners.has(key) && !this.pending.has(key) ? false : undefined
  }

  subscribe(key: string, fn: () => void): () => void {
    let set = this.listeners.get(key)
    if (!set) {
      set = new Set()
      this.listeners.set(key, set)
      this.pending.add(key)
    }
    set.add(fn)
    return () => {
      set.delete(fn)
      if (set.size > 0) return
      this.listeners.delete(key)
      this.pending.delete(key)
      this.shown.delete(key)
      this.queued.delete(key)
      this.near.delete(key)
    }
  }

  /** The row `key` has rendered, drawn or not. */
  report(key: string, drawn: boolean): void {
    if (!drawn) this.shown.delete(key)
    else {
      this.shown.add(key)
      this.queued.delete(key)
    }
  }

  /**
   * The sidebar is rendering with the list scrolled to `scrollTop`: rows that mount in this render
   * are counted in document order, and those that will be on screen are drawn in the render itself,
   * so showing a Space draws the rows it shows in the frame it shows them, and the rest of the
   * margin after it.
   */
  expect(scrollTop: number): void {
    const height = this.height || window.innerHeight
    this.mounted = 0
    this.expected = [
      (scrollTop - URGENT_PX) / ROW_PITCH - GUESS_SLACK_ROWS,
      (scrollTop + height + URGENT_PX) / ROW_PITCH + GUESS_SLACK_ROWS,
    ]
  }

  /** Whether the next row mounting in this render will be on screen (see `expect`). */
  guess(): boolean {
    const index = this.mounted++
    return index >= this.expected[0] && index <= this.expected[1]
  }

  /** Follows a scroller; returns the detach. */
  attach(scroll: HTMLElement): () => void {
    this.scroll = scroll
    const onScroll = () => this.update(true)
    scroll.addEventListener('scroll', onScroll, { passive: true })
    this.sizes.observe(scroll)
    return () => {
      scroll.removeEventListener('scroll', onScroll)
      this.sizes.unobserve(scroll)
      if (this.scroll === scroll) this.scroll = null
    }
  }

  /** A list in the scroller: when its height changes, rows below it move, so the band is measured again. */
  watch(list: HTMLElement): () => void {
    this.sizes.observe(list)
    return () => this.sizes.unobserve(list)
  }

  /**
   * Measures the band now and tells the rows whose state changed. Rows coming on screen are drawn
   * before this frame: `sync` renders them at once from a scroll or resize, outside React's own
   * commit, where they would otherwise wait for a later task. Rows coming into the margin render in
   * the background, and rows leaving it go in a task of their own after the frame: both are out of
   * sight, and the frame waits only for what it shows.
   */
  update(sync = false): void {
    const scroll = this.scroll
    if (!scroll?.isConnected) return
    const view = scroll.getBoundingClientRect()
    // Not laid out (a hidden window or view): keep what is drawn.
    if (view.height === 0) return
    this.height = view.height
    const margin = Math.max(MIN_MARGIN_PX, view.height * MARGIN_SCREENS)
    const batch = view.height * BATCH_SCREENS
    const reach = margin + 2 * batch
    const slots = scroll.querySelectorAll<HTMLElement>('[data-slot="item"]')
    // Slots only go down the list in document order (a folder's rows follow its own), so the first
    // slot within reach is found by bisection; a dragged row's shift can bend that by a row, well
    // inside the margin.
    let lo = 0
    let hi = slots.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((slots[mid] as HTMLElement).getBoundingClientRect().bottom < view.top - reach) lo = mid + 1
      else hi = mid
    }
    // Rows in the band (always drawn), one batch beyond it, and within reach (drawn rows stay).
    const band: string[] = []
    const beyond: string[] = []
    const inReach = new Set<string>()
    const onScreen = new Set<string>()
    let missing = false
    let drawn = false
    for (let i = Math.max(0, lo - 1); i < slots.length; i++) {
      const el = slots[i] as HTMLElement
      const r = el.getBoundingClientRect()
      if (r.top > view.bottom + reach) break
      const key = el.dataset.key
      if (!key) continue
      inReach.add(key)
      const away = r.bottom < view.top ? view.top - r.bottom : r.top > view.bottom ? r.top - view.bottom : 0
      if (away <= URGENT_PX) onScreen.add(key)
      if (away <= margin) {
        band.push(key)
        if (this.near.has(key)) drawn = true
        else missing = true
      } else if (away <= margin + batch) beyond.push(key)
    }
    const next = new Set<string>()
    for (const key of this.near) if (inReach.has(key)) next.add(key)
    if (missing) {
      for (const key of band) next.add(key)
      // Scrolled on to rows not drawn yet: draw the next batch with them. (A list just shown, or a
      // jump, draws the band alone, so the frame that shows it does no more than it needs.)
      if (drawn) for (const key of beyond) next.add(key)
    }
    // On screen and not drawn yet (also a row still rendering in the background): before this frame.
    const entering: string[] = []
    const later: string[] = []
    for (const key of next) {
      if (this.shown.has(key)) continue
      if (onScreen.has(key)) entering.push(key)
      else if (!this.queued.has(key)) later.push(key)
    }
    for (const key of entering) this.queued.delete(key)
    for (const key of later) this.queued.add(key)
    // Drawn rows away from the band, among them rows that mounted drawn by their order.
    for (const key of this.shown) if (!next.has(key)) this.leaving.add(key)
    // Rows still rendering in the background that have left the margin meanwhile: dropped once drawn.
    for (const key of this.queued)
      if (!next.has(key)) {
        this.queued.delete(key)
        this.leaving.add(key)
      }
    this.pending.clear()
    this.near = next
    if (entering.length > 0) {
      if (sync) flushSync(() => this.notify(entering))
      else this.notify(entering)
    }
    if (later.length > 0) startTransition(() => this.notify(later))
    if (this.leaving.size > 0 && this.dropTimer === undefined)
      this.dropTimer = setTimeout(() => {
        this.dropTimer = undefined
        const keys = [...this.leaving]
        this.leaving.clear()
        this.notify(keys)
      })
  }

  private notify(keys: readonly string[]): void {
    for (const key of keys) for (const fn of this.listeners.get(key) ?? []) fn()
  }
}

export const RowWindowContext = createContext<RowWindow | null>(null)

/**
 * Whether the row `key` is drawn: near the band; until it has been measured, if it is `late` (added
 * to a list already on screen) or its order places it in the band. It follows the band from its
 * layout effect, so a row measured in the frame it mounts is drawn or dropped before that frame.
 */
export function useInRowWindow(key: string, late: boolean): boolean {
  const win = useContext(RowWindowContext)
  const [fallback] = useState(() => late || !win || win.guess())
  const [near, setNear] = useState(() => win?.get(key) ?? fallback)
  useLayoutEffect(() => {
    if (!win) return
    const follow = () => setNear(win.get(key) ?? fallback)
    follow()
    return win.subscribe(key, follow)
  }, [win, key, fallback])
  useLayoutEffect(() => win?.report(key, near), [win, key, near])
  return !win || near
}
