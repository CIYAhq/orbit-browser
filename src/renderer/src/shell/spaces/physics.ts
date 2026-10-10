/**
 * Space-switch physics (FL-13). Pure functions, unit-tested; the strip
 * controller (switcher.ts) feeds them gesture samples and runs the springs.
 */

import { SPRING, type Spring, springFrom } from '../../motion/tokens'

/** A spring for mass 1 (FL-01's motion tokens, src/renderer/src/motion). */
export type SpringParams = Spring

/**
 * Settle after a swipe (FL-13: response 0.30–0.35 s, ratio 0.9–1.0, ≤ 1 % overshoot, a typical settle
 * 200–320 ms after the fingers lift): response 0.30 s, ratio 0.90 comes to rest in 250–280 ms from
 * rest over a third to three quarters of the width (0.32 s / 0.95 took 315–360 ms).
 */
export const SETTLE_SPRING = springFrom(0.3, 0.9)
/** Rubber-band release: response 0.3 s, ratio 1.0 (FL-13). */
export const RUBBER_SPRING = springFrom(0.3, 1)
/** Clicks and shortcuts: FL-01's standard token (0.32 s / 0.88 ≈ stiffness 386, damping 35). */
export const STANDARD_SPRING = SPRING.standard

/** Movement before a gesture is classified (FL-13: 8–10 px). */
export const RECOGNIZE_PX = 9
/** A gesture is horizontal when it is within 30° of horizontal. */
export const MAX_ANGLE_DEG = 30
/** Without platform scroll phases, this long without wheel events means the fingers lifted. */
export const RELEASE_GAP_MS = 90
/** Release projection time and thresholds (FL-13). */
export const PROJECTION_S = 0.15
export const COMMIT_VELOCITY = 500
export const NEW_SPACE_VELOCITY = 800
export const NEW_SPACE_FRACTION = 0.25
export const NEW_SPACE_HINT_FRACTION = 0.1

export type Axis = 'x' | 'y' | undefined

/** Classifies accumulated movement: undefined until it passes the recognition distance. */
export function classify(dx: number, dy: number): Axis {
  if (Math.hypot(dx, dy) < RECOGNIZE_PX) return undefined
  return Math.abs(dy) <= Math.abs(dx) * Math.tan((MAX_ANGLE_DEG * Math.PI) / 180) ? 'x' : 'y'
}

/**
 * Resisted offset for `travel` px of finger travel past the first/last Space:
 * (1 − 1 / (travel × 0.55 / width + 1)) × width, so resistance grows with
 * travel (about a third of the width after a full width of travel).
 */
export function rubberBand(travel: number, width: number): number {
  if (width <= 0) return 0
  const t = Math.abs(travel)
  return Math.sign(travel) * (1 - 1 / ((t * 0.55) / width + 1)) * width
}

/**
 * Offset shown for a swipe of `travel` px (positive = toward the next Space).
 * Moving toward a missing neighbour rubber-bands; one gesture moves at most one Space.
 */
export function swipeOffset(travel: number, width: number, hasPrev: boolean, hasNext: boolean): number {
  if (travel > 0 && !hasNext) return rubberBand(travel, width)
  if (travel < 0 && !hasPrev) return rubberBand(travel, width)
  return Math.max(-width, Math.min(width, travel))
}

export type Release = 'commit' | 'return' | 'new-space'

/**
 * What a released swipe does (FL-13). `offset` is the shown offset toward the
 * next Space (positive) or previous (negative); `velocity` is px/s in the same sense.
 * `hasTarget`: a real neighbour exists in that direction. `canCreate`: moving past
 * the last Space may add one (SP-08).
 */
export function releaseDecision(
  offset: number,
  velocity: number,
  width: number,
  hasTarget: boolean,
  canCreate: boolean,
): Release {
  const dir = Math.sign(offset) || Math.sign(velocity)
  if (dir === 0 || width <= 0) return 'return'
  if (!hasTarget) {
    if (!canCreate || dir < 0) return 'return'
    const outward = velocity * dir
    return offset * dir > NEW_SPACE_FRACTION * width || outward > NEW_SPACE_VELOCITY ? 'new-space' : 'return'
  }
  const projected = offset + velocity * PROJECTION_S
  const towards = velocity * dir
  // A flick back toward where it started cancels, however far the content had moved.
  if (towards < -COMMIT_VELOCITY) return 'return'
  if (Math.abs(projected) > width / 2 && Math.sign(projected) === dir) return 'commit'
  if (Math.abs(offset) > width / 3) return 'commit'
  if (towards > COMMIT_VELOCITY) return 'commit'
  return 'return'
}

/** Rolling velocity estimate (px/s) from recent samples. */
export class VelocityTracker {
  private samples: { t: number; v: number }[] = []

  constructor(private windowMs = 100) {}

  reset(): void {
    this.samples = []
  }

  add(t: number, value: number): void {
    this.samples.push({ t, v: value })
    const cutoff = t - this.windowMs
    while (this.samples.length > 2 && (this.samples[0] as { t: number }).t < cutoff) this.samples.shift()
  }

  /** Velocity over the samples in the window ending at the latest sample. */
  velocity(): number {
    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    if (!first || !last || last.t - first.t < 1) return 0
    return ((last.v - first.v) / (last.t - first.t)) * 1000
  }
}

/**
 * Detects the start of OS momentum (inertial) scrolling in a wheel stream:
 * after the fingers lift, deltas keep coming at the display's cadence but
 * decay by an almost constant factor. A finger easing off is irregular, so
 * this needs six samples whose ratios sit in a narrow band (0.82–0.98) with
 * little spread, at a regular pace (review M4).
 */
export class MomentumDetector {
  private samples: { d: number; t: number }[] = []

  reset(): void {
    this.samples = []
  }

  /** Feeds one wheel delta along the gesture axis (and its time); true once momentum is detected. */
  push(delta: number, t: number): boolean {
    this.samples.push({ d: Math.abs(delta), t })
    if (this.samples.length > 6) this.samples.shift()
    if (this.samples.length < 6) return false
    const ratios: number[] = []
    const gaps: number[] = []
    for (let i = 1; i < this.samples.length; i++) {
      const prev = this.samples[i - 1] as { d: number; t: number }
      const cur = this.samples[i] as { d: number; t: number }
      if (prev.d < 1) return false
      ratios.push(cur.d / prev.d)
      gaps.push(cur.t - prev.t)
    }
    if ((this.samples[0]?.d ?? 0) < 3) return false
    if (ratios.some((r) => r < 0.82 || r > 0.98)) return false
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length
    const spread = Math.sqrt(ratios.reduce((a, r) => a + (r - mean) ** 2, 0) / ratios.length)
    if (spread > 0.04) return false
    const minGap = Math.min(...gaps)
    const maxGap = Math.max(...gaps)
    return minGap >= 2 && maxGap <= 40 && maxGap <= minGap * 2.5
  }
}

/**
 * Mouse wheels move in notches (lines or pages, or Chromium's 120-unit
 * wheelDelta). They keep their normal meaning over the sidebar and never
 * page between Spaces (SP-08: mouse paging is off by default; review F4).
 */
export function isWheelNotch(e: { deltaMode: number; deltaX: number; deltaY: number; wheelDeltaX?: number }): boolean {
  if (e.deltaMode !== 0) return true
  const wx = e.wheelDeltaX ?? 0
  return wx !== 0 && wx % 120 === 0 && Math.abs(e.deltaX) >= 40
}

/** Which page slot the viewport mostly shows, and how far it is toward the next one. */
export function viewportPosition(x: number, width: number): { slot: number; t: number } {
  if (width <= 0) return { slot: 0, t: 0 }
  const f = -x / width || 0
  const slot = Math.floor(f) || 0
  return { slot, t: f - slot }
}
