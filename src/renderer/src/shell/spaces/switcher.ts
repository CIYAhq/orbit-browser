import { type AnimationPlaybackControlsWithThen, animate, motionValue } from 'motion'
import { THEME_PRESETS } from '../../../../shared/defaults'
import type { SpaceId, SpaceTheme } from '../../../../shared/state'
import { mixPalettes, type Palette } from '../../../../shared/theme'
import { invoke, perfMark } from '../../api'
import { getOrbitState } from '../../store'
import { cachedPalette, isDarkNow, prefersReducedMotion, themeDriver } from '../../theme'
import {
  classify,
  isWheelNotch,
  MomentumDetector,
  NEW_SPACE_FRACTION,
  NEW_SPACE_HINT_FRACTION,
  RELEASE_GAP_MS,
  RUBBER_SPRING,
  releaseDecision,
  SETTLE_SPRING,
  type SpringParams,
  STANDARD_SPRING,
  swipeOffset,
  VelocityTracker,
  viewportPosition,
} from './physics'

/** What a page slot shows: a Space, or the "new Space" page past the last one. */
export type SlotContent = SpaceId | 'new'

export interface Slot {
  /** Position in pages relative to the active Space (0 = the real, interactive page). */
  k: number
  id: SlotContent
}

export interface StripSnapshot {
  slots: Slot[]
  newPage: 'hint' | 'flow' | undefined
}

type Phase = 'undecided' | 'tracking' | 'vertical' | 'swallow'

interface Gesture {
  phase: Phase
  lastAt: number
  lastDelta: number
  ax: number
  ay: number
  travel: number
  /** Vertical pixels held back while the gesture was undecided (given back if it turns out vertical). */
  held: number
  hasPrev: boolean
  hasNext: boolean
  canCreate: boolean
  releaseTimer: ReturnType<typeof setTimeout> | undefined
  source: 'wheel' | 'pointer'
}

/**
 * The Space strip controller (FL-13, SP-08). The per-Space part of the sidebar
 * is a horizontal strip of pages; `x` is the strip offset in px. Slot 0 is
 * always the active Space's real page; other slots hold light previews.
 *
 * State first, motion second: a committed swipe, a click or a shortcut changes
 * the window's Space immediately; when the new active Space arrives from main,
 * `syncActive` re-bases the strip (the destination becomes slot 0 and `x` is
 * shifted by whole pages, so nothing moves on screen) and springs `x` to 0.
 *
 * Everything per frame (strip transform, theme blend, switcher emphasis,
 * Favorites cross-fade) is written straight to the DOM: no React renders.
 */
export class SpaceSwitcher {
  readonly x = motionValue(0)
  private width = 0
  private slots: Slot[] = []
  private active: SpaceId = ''
  private order: SpaceId[] = []
  private listeners = new Set<() => void>()
  private anim: AnimationPlaybackControlsWithThen | undefined
  private gesture: Gesture | undefined
  private velocity = new VelocityTracker()
  private momentum = new MomentumDetector()
  private track: HTMLElement | null = null
  private scroller: () => HTMLElement | null = () => null
  private dots = new Map<SpaceId, HTMLElement>()
  private pill: HTMLElement | null = null
  private newHint: HTMLElement | null = null
  private stuckTimer: ReturnType<typeof setTimeout> | undefined
  /** A released swipe asked main to switch; the strip may rest a page over until the Space arrives. */
  private pendingCommit = false
  /** Theme shown for the "new Space" page (follows the creation flow's choice). */
  private newTheme: SpaceTheme | undefined
  /** "hint": the faint + while over-swiping; "flow": the creation flow is open on it. */
  newPage: 'hint' | 'flow' | undefined
  /** Spaces that existed before the creation flow opened (to recognise the one it creates). */
  private orderAtFlowStart: SpaceId[] = []

  constructor() {
    this.x.on('change', () => this.paint())
  }

  // ---- React integration ----

  private snapshot: StripSnapshot = { slots: [], newPage: undefined }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): StripSnapshot => this.snapshot

  private emit(): void {
    this.snapshot = { slots: this.slots, newPage: this.newPage }
    for (const listener of this.listeners) listener()
  }

  private setSlots(slots: Slot[]): void {
    const sorted = [...slots].sort((a, b) => a.k - b.k)
    const same =
      sorted.length === this.slots.length &&
      sorted.every((s, i) => s.k === this.slots[i]?.k && s.id === this.slots[i]?.id)
    if (!same) this.slots = sorted
    if (!same || this.snapshot.newPage !== this.newPage) this.emit()
  }

  attach(track: HTMLElement | null, scroller: () => HTMLElement | null): void {
    this.track = track
    this.scroller = scroller
    this.paint()
  }

  /** Height of the strip's pages (previews size their row budget from it). */
  height = 0

  setSize(width: number, height: number): void {
    if (height > 0) this.height = height
    this.setWidth(width)
  }

  setWidth(width: number): void {
    if (width === this.width || width <= 0) return
    const ratio = this.width > 0 ? width / this.width : 1
    this.width = width
    if (this.x.get() !== 0) this.x.jump(this.x.get() * ratio)
    this.paint()
  }

  registerDot = (spaceId: SpaceId, el: HTMLElement | null): void => {
    if (el) this.dots.set(spaceId, el)
    else this.dots.delete(spaceId)
    this.schedulePaint()
  }

  registerPill = (el: HTMLElement | null): void => {
    this.pill = el
    this.schedulePaint()
  }

  registerNewHint = (el: HTMLElement | null): void => {
    this.newHint = el
    this.schedulePaint()
  }

  private paintQueued = false
  private measureQueued = false
  /** Switcher target positions, measured after layout so painting never forces a layout. */
  private geometry = new Map<SpaceId, { left: number; width: number }>()

  /** Repaints once after a batch of element registrations (React attaches refs one by one). */
  private schedulePaint(): void {
    this.scheduleMeasure()
    if (this.paintQueued) return
    this.paintQueued = true
    queueMicrotask(() => {
      this.paintQueued = false
      this.paint()
    })
  }

  private scheduleMeasure(): void {
    if (this.measureQueued) return
    this.measureQueued = true
    requestAnimationFrame(() => {
      this.measureQueued = false
      this.geometry.clear()
      for (const [id, el] of this.dots) this.geometry.set(id, { left: el.offsetLeft, width: el.offsetWidth })
      this.paint()
    })
  }

  /** Repaints derived visuals (e.g. after the switcher row re-rendered). */
  refresh(): void {
    this.scheduleMeasure()
    this.paint()
  }

  isMoving(): boolean {
    return !!this.anim || this.x.get() !== 0 || this.gesture?.phase === 'tracking'
  }

  private settleWaiters: (() => void)[] = []

  /**
   * Resolves once the strip rests on the active Space (at once if it already does).
   * The tab drag waits for this before measuring the rows of a Space it slid to.
   */
  whenSettled(): Promise<void> {
    if (!this.isMoving() && !this.standIn) return Promise.resolve()
    return new Promise((resolve) => this.settleWaiters.push(resolve))
  }

  /** True while slot 0 shows the stand-in and the real page is still rendering. */
  private standIn = false

  setStandIn(on: boolean): void {
    this.standIn = on
    // Slot 0's content changed (stand-in shown or replaced): hold its Favorites in place now,
    // before the browser paints the new DOM.
    this.paint()
    if (!on && !this.isMoving()) this.flushSettled()
  }

  private flushSettled(): void {
    if (this.standIn) return
    for (const resolve of this.settleWaiters.splice(0)) resolve()
  }

  // ---- Active Space changes (clicks, keys, commits, other code) ----

  /**
   * Called (in a layout effect) whenever the window's active Space or the Space
   * order changes. Re-bases the strip on the new active Space and animates.
   */
  syncActive(active: SpaceId, order: SpaceId[]): void {
    const prevOrder = this.order
    this.order = order
    const prev = this.active
    if (active === prev) {
      // Drop previews of Spaces that no longer exist.
      const live = this.slots.filter((s) => s.id === 'new' || s.k === 0 || order.includes(s.id))
      if (live.length !== this.slots.length) this.setSlots(live)
      this.paint()
      return
    }
    this.active = active
    this.pendingCommit = false
    // A switch from elsewhere (keys, click, another window) during a swipe ends the swipe
    // first, so the strip is never re-based under the fingers (review F9).
    const g = this.gesture
    if (g?.phase === 'tracking') {
      if (g.releaseTimer) clearTimeout(g.releaseTimer)
      g.releaseTimer = undefined
      g.phase = 'swallow'
    }
    if (!prev || this.width <= 0) {
      this.stopAnim()
      this.x.jump(0)
      this.setSlots([{ k: 0, id: active }])
      return
    }
    perfMark('space:switch:shell')
    if (prefersReducedMotion()) {
      this.crossFadeTo(active)
      return
    }
    const x = this.x.get()
    let target = this.slots.find((s) => s.id === active)?.k
    if (target === undefined && this.newPage === 'flow' && !this.orderAtFlowStart.includes(active)) {
      // The creation flow just made this Space: it takes the flow page's place.
      target = this.slots.find((s) => s.id === 'new')?.k
      this.newPage = undefined
      this.newTheme = undefined
    }
    if (this.newPage) {
      // Switched to an existing Space (keys, click, another window) while the flow or the
      // over-swipe hint was showing: abandon it.
      this.newPage = undefined
      this.newTheme = undefined
    }
    let slots = this.slots.filter((s) => s.id !== active && s.id !== 'new')
    if (target === undefined) {
      const dir =
        Math.sign(order.indexOf(active) - (order.indexOf(prev) >= 0 ? order.indexOf(prev) : prevOrder.indexOf(prev))) ||
        1
      const f = -x / this.width
      const ks = slots.map((s) => s.k)
      target =
        dir > 0
          ? Math.max(Math.floor(f + 1e-6) + 1, Math.max(0, ...ks) + 1)
          : Math.min(Math.ceil(f - 1e-6) - 1, Math.min(0, ...ks) - 1)
    }
    const shift = target
    slots = slots.filter((s) => s.k !== shift).map((s) => ({ k: s.k - shift, id: s.id }))
    slots.push({ k: 0, id: active })
    const velocity = this.anim ? this.x.getVelocity() : 0
    this.stopAnim()
    this.x.jump(x + shift * this.width)
    this.setSlots(slots)
    // A swipe that already let go keeps its momentum; clicks and keys start from rest.
    this.springTo(0, velocity, velocity ? SETTLE_SPRING : STANDARD_SPRING)
  }

  /** Small bounce at the first/last Space when a key asks to go further (SP-09). */
  nudge(direction: number): void {
    if (this.gesture?.phase === 'tracking' || prefersReducedMotion() || this.width <= 0) return
    this.stopAnim()
    const out = -Math.sign(direction) * this.width * 0.05
    this.anim = animate(this.x, [this.x.get(), out, 0], { duration: 0.3, ease: ['easeOut', 'easeInOut'] })
    void this.anim.then(() => this.settled())
  }

  // ---- The new-Space page (SP-02, SP-08) ----

  /** Slides the "new Space" page in and opens the creation flow on it. */
  openFlow(): void {
    if (this.newPage === 'flow') return
    this.orderAtFlowStart = [...this.order]
    this.newPage = 'flow'
    this.newTheme = THEME_PRESETS[this.order.length % 8]
    const slots = this.slots.filter((s) => s.id !== 'new' && s.k <= 0)
    slots.push({ k: 1, id: 'new' })
    this.setSlots(slots)
    void invoke('spaces.focusShell', {})
    if (prefersReducedMotion()) {
      this.stopAnim()
      this.x.jump(-this.width)
      this.settled()
      return
    }
    this.springTo(-this.width, this.anim ? this.x.getVelocity() : 0, STANDARD_SPRING)
  }

  /** Abandons the creation flow and slides back to the active Space. */
  cancelFlow(): void {
    if (!this.newPage) return
    this.newPage = undefined
    this.newTheme = undefined
    this.emit()
    this.springTo(0, 0, STANDARD_SPRING, prefersReducedMotion())
  }

  /** The flow's current theme choice, previewed live on the window (SP-02 step 3). */
  setFlowTheme(theme: SpaceTheme): void {
    this.newTheme = theme
    this.paint()
  }

  // ---- Gestures (SP-08) ----

  /** Wheel events over the sidebar. Must be attached as a non-passive listener. */
  onWheel = (e: WheelEvent): void => {
    if (e.ctrlKey || this.width <= 0) return // pinch-zoom
    const now = e.timeStamp || performance.now()
    // Mouse wheels scroll as usual. Only a gesture's first event can be a notch: trackpads may
    // report notch-like values mid-flick (wheelDeltaX = 3 × deltaX on macOS; review V4).
    const starting = !this.gesture || now - this.gesture.lastAt > RELEASE_GAP_MS
    if (starting && isWheelNotch(e as WheelEvent & { wheelDeltaX?: number })) return
    const dx = e.deltaX
    const dy = e.deltaY
    // Mainly vertical input always scrolls the list natively and is never held back (SB-23, review M2).
    const vertical = Math.abs(dy) >= Math.abs(dx)
    let g = this.gesture
    if (!g || now - g.lastAt > RELEASE_GAP_MS) g = this.startGesture(now, 'wheel')
    if (g.phase === 'swallow') {
      // OS momentum after a lifted swipe never scrolls the list or switches again. Anything
      // else is new input: a vertical scroll, a reversal, or growing deltas (fingers back on),
      // which picks the strip up where it is (review M4).
      const reversing = !vertical && Math.abs(dx) > 1 && Math.sign(dx) !== Math.sign(g.lastDelta)
      const growing = !vertical && Math.abs(dx) > Math.abs(g.lastDelta) * 1.05 + 0.5
      if (!vertical && !reversing && !growing) {
        e.preventDefault()
        g.lastAt = now
        g.lastDelta = dx
        return
      }
      g = this.startGesture(now, 'wheel')
      if (!vertical) {
        e.preventDefault()
        g.lastAt = now
        g.lastDelta = dx
        this.beginTracking(g, dx, now)
        return
      }
    }
    g.lastAt = now
    g.lastDelta = vertical ? dy : dx
    if (g.phase === 'vertical') return
    if (g.phase === 'undecided') {
      g.ax += dx
      g.ay += dy
      const axis = classify(g.ax, g.ay)
      if (axis === 'x') {
        e.preventDefault()
        this.beginTracking(g, g.ax, now)
        return
      }
      if (!vertical) {
        // A mostly horizontal start: hold its small vertical part until the direction is known.
        e.preventDefault()
        g.held += dy
      }
      if (axis === 'y') {
        g.phase = 'vertical'
        this.giveBack(g)
      }
      return
    }
    e.preventDefault()
    this.track1to1(g, g.travel + dx, now)
    if (this.momentum.push(dx, now)) this.release()
    else this.armRelease(g)
  }

  private pointer: { id: number; x0: number; y0: number; lastX: number } | undefined

  /** Touch and pen drags across the sidebar (pointer fallback for the swipe). */
  onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' || !e.isPrimary || this.width <= 0) return
    this.pointer = { id: e.pointerId, x0: e.clientX, y0: e.clientY, lastX: e.clientX }
    this.startGesture(e.timeStamp, 'pointer')
  }

  onPointerMove = (e: PointerEvent): void => {
    const p = this.pointer
    const g = this.gesture
    if (!p || !g || e.pointerId !== p.id || g.source !== 'pointer') return
    // Dragging the content left moves toward the next Space, as with two fingers.
    const dx = p.lastX - e.clientX
    p.lastX = e.clientX
    if (g.phase === 'undecided') {
      const axis = classify(p.x0 - e.clientX, p.y0 - e.clientY)
      if (axis === 'y') g.phase = 'vertical'
      if (axis === 'x') {
        ;(e.currentTarget as Element | null)?.setPointerCapture?.(e.pointerId)
        this.beginTracking(g, p.x0 - e.clientX, e.timeStamp)
      }
      return
    }
    if (g.phase === 'tracking') this.track1to1(g, g.travel + dx, e.timeStamp)
  }

  onPointerUp = (e: PointerEvent): void => {
    if (!this.pointer || e.pointerId !== this.pointer.id) return
    this.pointer = undefined
    if (this.gesture?.source === 'pointer' && this.gesture.phase === 'tracking') this.release(false)
    else this.gesture = undefined
  }

  private startGesture(now: number, source: Gesture['source']): Gesture {
    const old = this.gesture
    if (old) {
      if (old.releaseTimer) clearTimeout(old.releaseTimer)
      old.releaseTimer = undefined
      // A gesture whose release timer was starved (e.g. by a long task) still releases (review M3).
      if (old.phase === 'tracking') this.release(true)
      // An undecided start gives back the vertical pixels it held (review M2).
      else if (old.phase === 'undecided') this.giveBack(old)
    }
    const order = this.order
    const i = order.indexOf(this.active)
    this.gesture = {
      phase: 'undecided',
      lastAt: now,
      lastDelta: 0,
      ax: 0,
      ay: 0,
      held: 0,
      travel: 0,
      hasPrev: i > 0,
      hasNext: i >= 0 && i < order.length - 1,
      canCreate: i === order.length - 1 && !this.newPage,
      releaseTimer: undefined,
      source,
    }
    this.velocity.reset()
    this.momentum.reset()
    return this.gesture
  }

  private giveBack(g: Gesture): void {
    if (g.held) this.scroller()?.scrollBy({ top: g.held, behavior: 'instant' })
    g.held = 0
  }

  private beginTracking(g: Gesture, travel: number, now: number): void {
    // The new-Space page owns the strip while it is open or sliding in: leave it be (review M3).
    if (this.newPage === 'flow') {
      g.phase = 'vertical'
      return
    }
    g.phase = 'tracking'
    this.pendingCommit = false
    // Interrupt a running settle from where it is (FL-01).
    const current = -this.x.get()
    this.stopAnim()
    const i = this.order.indexOf(this.active)
    const prev = this.order[i - 1]
    const next = this.order[i + 1]
    const slots: Slot[] = [{ k: 0, id: this.active }]
    if (prev) slots.push({ k: -1, id: prev })
    if (next) slots.push({ k: 1, id: next })
    else if (g.canCreate) slots.push({ k: 1, id: 'new' })
    this.newPage = !next && g.canCreate ? 'hint' : undefined
    this.setSlots(slots)
    g.travel = Math.abs(current) < this.width ? current : 0
    this.track1to1(g, g.travel + travel, now)
  }

  private track1to1(g: Gesture, travel: number, now: number): void {
    g.travel = travel
    const offset = swipeOffset(travel, this.width, g.hasPrev, g.hasNext)
    this.velocity.add(now, travel)
    this.x.set(-offset)
  }

  private armRelease(g: Gesture): void {
    if (g.releaseTimer) clearTimeout(g.releaseTimer)
    g.releaseTimer = setTimeout(() => this.release(true), RELEASE_GAP_MS)
  }

  /**
   * The fingers lifted. `stillSince`: released because events stopped, so the
   * fingers had stopped too: the velocity is measured up to now, not up to the
   * last motion (a held-still lift is not a flick; review F3).
   */
  private release(stillSince = false): void {
    const g = this.gesture
    if (g?.phase !== 'tracking') return
    if (g.releaseTimer) clearTimeout(g.releaseTimer)
    g.releaseTimer = undefined
    g.phase = 'swallow'
    if (stillSince) this.velocity.add(Math.max(performance.now(), g.lastAt), g.travel)
    const offset = -this.x.get()
    const v = this.velocity.velocity()
    const dir = Math.sign(offset) || Math.sign(v)
    const target =
      dir > 0 ? this.order[this.order.indexOf(this.active) + 1] : this.order[this.order.indexOf(this.active) - 1]
    const decision = releaseDecision(offset, v, this.width, !!target, g.canCreate)
    const reduced = prefersReducedMotion()
    if (decision === 'commit' && target) {
      this.pendingCommit = true
      void invoke('spaces.switch', { spaceId: target })
      this.springTo(-dir * this.width, -v, SETTLE_SPRING, reduced)
      this.watchStuck()
    } else if (decision === 'new-space') {
      this.openFlowFromSwipe(-v)
    } else {
      const banded = (dir > 0 && !g.hasNext) || (dir < 0 && !g.hasPrev)
      this.springTo(0, banded ? 0 : -v, banded ? RUBBER_SPRING : SETTLE_SPRING, reduced)
    }
  }

  private openFlowFromSwipe(velocity: number): void {
    this.orderAtFlowStart = [...this.order]
    this.newPage = 'flow'
    this.newTheme = THEME_PRESETS[this.order.length % 8]
    this.emit()
    void invoke('spaces.focusShell', {})
    this.springTo(-this.width, velocity, STANDARD_SPRING, prefersReducedMotion())
  }

  /** If a committed switch never arrives from main, slide back instead of showing a preview forever. */
  private watchStuck(): void {
    if (this.stuckTimer) clearTimeout(this.stuckTimer)
    const expected = this.active
    this.stuckTimer = setTimeout(() => {
      this.stuckTimer = undefined
      if (this.active !== expected || !this.pendingCommit) return
      this.pendingCommit = false
      if (this.x.get() !== 0 && !this.newPage && this.gesture?.phase !== 'tracking') {
        this.springTo(0, 0, STANDARD_SPRING)
      }
    }, 700)
  }

  // ---- Animation ----

  private springTo(target: number, velocity: number, spring: SpringParams, reduced = false): void {
    this.stopAnim()
    if (reduced) {
      this.anim = animate(this.x, target, { duration: 0.12, ease: 'easeOut' })
    } else {
      this.anim = animate(this.x, target, {
        type: 'spring',
        stiffness: spring.stiffness,
        damping: spring.damping,
        mass: 1,
        velocity,
        restDelta: 0.4,
        restSpeed: 8,
      })
    }
    const anim = this.anim
    void anim.then(() => {
      if (this.anim === anim) this.settled()
    })
  }

  private stopAnim(): void {
    const anim = this.anim
    this.anim = undefined
    anim?.stop()
  }

  /** At rest: drop previews that are off screen and hand the theme back. */
  private settled(): void {
    this.anim = undefined
    const x = this.x.get()
    if (Math.abs(x) < 0.5 && x !== 0) this.x.jump(0)
    if (this.gesture?.phase === 'tracking') return
    // Never rest between pages (review M3): only the active page, the open new-Space page,
    // or a page whose switch is on its way from main are valid resting places.
    const rest = this.newPage === 'flow' ? -this.width : 0
    const atRest = Math.abs(this.x.get() - rest) < 0.5
    const awaitingSwitch = this.pendingCommit && Math.abs(Math.abs(this.x.get()) - this.width) < 0.5
    if (!atRest && !awaitingSwitch) {
      this.springTo(rest, 0, STANDARD_SPRING, prefersReducedMotion())
      return
    }
    if (atRest && rest !== 0) this.x.jump(rest)
    if (this.x.get() === 0) {
      if (this.newPage === 'hint') this.newPage = undefined
      this.setSlots(this.slots.filter((s) => s.k === 0))
      perfMark('space:switch:settled')
      this.flushSettled()
    }
    this.paint()
  }

  private crossFadeTo(active: SpaceId): void {
    this.stopAnim()
    this.x.jump(0)
    this.newPage = undefined
    this.setSlots([{ k: 0, id: active }])
    const el = this.track
    if (el) {
      el.animate([{ opacity: 0.15 }, { opacity: 1 }], { duration: 140, easing: 'ease-out' })
    }
    const theme = getOrbitState().spaces[active]?.theme
    if (theme) themeDriver.fadeTo(cachedPalette(theme, isDarkNow()), 140)
  }

  // ---- Per-frame painting ----

  private paletteOf(id: SlotContent | undefined, dark: boolean): Palette | undefined {
    if (id === 'new') {
      const theme = this.newTheme ?? (THEME_PRESETS[this.order.length % 8] as SpaceTheme)
      return cachedPalette(theme, dark)
    }
    const theme = id ? getOrbitState().spaces[id]?.theme : undefined
    return theme ? cachedPalette(theme, dark) : undefined
  }

  private slotAt(k: number): Slot | undefined {
    return this.slots.find((s) => s.k === k)
  }

  private paint(): void {
    const x = this.x.get()
    const width = this.width
    if (this.track) this.track.style.transform = x === 0 ? '' : `translate3d(${x}px,0,0)`
    if (width <= 0) return
    const { slot, t } = viewportPosition(x, width)
    const a = this.slotAt(slot) ?? (t > 0.5 ? this.slotAt(slot + 1) : undefined) ?? this.slotAt(0)
    const b = this.slotAt(slot + 1) ?? a
    const moving = x !== 0 || !!this.anim
    const dark = isDarkNow()

    // Theme colour follows the position (FL-14). At rest the resting palette takes over.
    if (moving) {
      const pa = this.paletteOf(a?.id, dark)
      const pb = this.paletteOf(b?.id, dark) ?? pa
      if (pa && pb) themeDriver.drive(mixPalettes(pa, pb, t), t < 0.5 ? pa : pb)
    } else {
      themeDriver.release()
    }

    // Switcher emphasis slides with the progress (SP-06, FL-13).
    const weights = new Map<SpaceId, number>()
    if (a && a.id !== 'new') weights.set(a.id, (weights.get(a.id) ?? 0) + (1 - t))
    if (b && b.id !== 'new' && b !== a) weights.set(b.id, (weights.get(b.id) ?? 0) + t)
    if (!moving) {
      weights.clear()
      weights.set(this.active, 1)
    }
    let pillX: number | undefined
    let pillW: number | undefined
    for (const [id, el] of this.dots) {
      const w = Math.max(0, Math.min(1, weights.get(id) ?? 0))
      el.style.setProperty('--p', w.toFixed(3))
    }
    const ga = a && a.id !== 'new' ? this.geometry.get(a.id) : undefined
    const gb = b && b.id !== 'new' ? this.geometry.get(b.id) : undefined
    const from = moving ? ga : this.geometry.get(this.active)
    const to = moving ? (gb ?? ga) : from
    if (from && to) {
      const tt = moving ? t : 0
      pillX = from.left + (to.left - from.left) * tt
      pillW = from.width + (to.width - from.width) * tt
    }
    if (this.pill) {
      if (pillX === undefined || pillW === undefined) this.pill.style.opacity = '0'
      else {
        const fade = moving && (a?.id === 'new' || b?.id === 'new') ? 1 - t : 1
        this.pill.style.opacity = String(fade)
        this.pill.style.transform = `translate3d(${pillX}px,0,0)`
        this.pill.style.width = `${pillW}px`
      }
    }

    // The faint "+" past the last Space appears from about 10 % (SP-08).
    if (this.newHint) {
      const shown = -x / width
      const o = (shown - NEW_SPACE_HINT_FRACTION) / (NEW_SPACE_FRACTION - NEW_SPACE_HINT_FRACTION)
      this.newHint.style.opacity = String(Math.max(0, Math.min(1, o)))
    }

    this.paintFavorites(x, moving, a, b, t)
  }

  /**
   * Favorites sit at the top of every page. While the strip moves they are held
   * in place; between Spaces of one profile only one grid shows (perfectly
   * still), between profiles the two grids cross-fade (PR-06).
   */
  private paintFavorites(x: number, moving: boolean, a: Slot | undefined, b: Slot | undefined, t: number): void {
    const track = this.track
    if (!track) return
    const pages = track.querySelectorAll<HTMLElement>(':scope > [data-slot]')
    if (!moving) {
      for (const page of pages) {
        for (const fav of favoritesLayers(page)) {
          fav.style.transform = ''
          fav.style.opacity = ''
        }
      }
      return
    }
    const state = getOrbitState()
    const profileOf = (s: Slot | undefined) =>
      !s ? undefined : s.id === 'new' ? `new` : (state.spaces[s.id]?.profileId ?? undefined)
    const same = profileOf(a) === profileOf(b) || profileOf(b) === 'new' || profileOf(a) === 'new'
    for (const page of pages) {
      const k = Number(page.dataset.slot)
      const layers = favoritesLayers(page)
      if (layers.length === 0) continue
      const transform = `translate3d(${-(k * this.width + x)}px,0,0)`
      let opacity = 0
      if (same) {
        const lead = (t < 0.5 ? a : b) ?? a
        opacity = lead?.k === k ? 1 : 0
        if (profileOf(lead) === 'new' && (a?.k === k || b?.k === k)) opacity = profileOf(a) === 'new' ? 0 : 1
      } else if (a?.k === k) opacity = 1 - t
      else if (b?.k === k) opacity = t
      // Slot 0 may hold the stand-in and the real page (hidden) at once: both get the same.
      for (const fav of layers) {
        fav.style.transform = transform
        fav.style.opacity = String(opacity)
      }
    }
  }
}

/**
 * The Favorites grids of a page: the `data-favorites-layer` wrappers, or else a
 * Favorites root rendered by other sidebar code. Never both (they nest).
 */
function favoritesLayers(page: HTMLElement): HTMLElement[] {
  const layers = page.querySelectorAll<HTMLElement>('[data-favorites-layer]')
  return [...(layers.length ? layers : page.querySelectorAll<HTMLElement>('[data-testid="favorites"]'))]
}

/** The shell's Space switcher (one sidebar per shell renderer). */
export const switcher = new SpaceSwitcher()

/**
 * For the tab drag (TB-09, SP-21): slide to the neighbouring Space while a tab
 * is held at the sidebar edge. The window switches; the strip animates. Resolves
 * once the strip rests on the new Space, so its rows can be measured.
 */
export async function slideToNeighbour(direction: 1 | -1): Promise<void> {
  await invoke('spaces.step', { delta: direction })
  await stripSettled()
}

/** Resolves when the Space strip rests (after the state change reached this renderer). */
export function stripSettled(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => void switcher.whenSettled().then(resolve)))
}
