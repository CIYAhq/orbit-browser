/**
 * Space-switch physics (FL-13). Pure functions, unit-tested; the strip
 * controller (switcher.ts) feeds them gesture samples and runs the springs.
 */

/** Spring as stiffness/damping for mass 1, from FL-01's response (s) and damping ratio. */
export interface SpringParams {
  stiffness: number
  damping: number
}

export function springFrom(response: number, ratio: number): SpringParams {
  return { stiffness: (2 * Math.PI) ** 2 / response ** 2, damping: (4 * Math.PI * ratio) / response }
}

/** Settle after a swipe: response 0.32 s, ratio 0.95 (≤ 1 % overshoot). */
export const SETTLE_SPRING = springFrom(0.32, 0.95)
/** Rubber-band release: response 0.3 s, ratio 1.0. */
export const RUBBER_SPRING = springFrom(0.3, 1)
/** Clicks and shortcuts: FL-01 "standard" token (0.32 s / 0.88 ≈ stiffness 386, damping 35). */
export const STANDARD_SPRING = springFrom(0.32, 0.88)

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
 * after the fingers lift, deltas keep coming but decay geometrically. Four
 * consecutive steady decays mean the fingers are off the trackpad.
 */
export class MomentumDetector {
  private deltas: number[] = []

  reset(): void {
    this.deltas = []
  }

  /** Feeds one wheel delta along the gesture axis; returns true once momentum is detected. */
  push(delta: number): boolean {
    this.deltas.push(Math.abs(delta))
    if (this.deltas.length > 6) this.deltas.shift()
    if (this.deltas.length < 5) return false
    for (let i = this.deltas.length - 4; i < this.deltas.length; i++) {
      const prev = this.deltas[i - 1] as number
      const cur = this.deltas[i] as number
      if (prev < 1.5) return false
      const ratio = cur / prev
      if (ratio < 0.5 || ratio > 0.97) return false
    }
    return true
  }
}

/** Which page slot the viewport mostly shows, and how far it is toward the next one. */
export function viewportPosition(x: number, width: number): { slot: number; t: number } {
  if (width <= 0) return { slot: 0, t: 0 }
  const f = -x / width
  const slot = Math.floor(f)
  return { slot, t: f - slot }
}
