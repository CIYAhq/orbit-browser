import { type KeyframeGenerator, spring } from 'motion'
import { SPRING, type Spring } from '../../motion/tokens'

/** FL-01's standard spring (response 0.32 s, damping ratio 0.88): pane layout. */
export const STANDARD = SPRING.standard
/** FL-01's snappy spring (drop indicator moves, small re-flows). */
export const SNAPPY = SPRING.snappy

export type SpringParams = Spring

/**
 * The fastest (px/s) a value may be going where it reaches its target for it to stop there. Panes
 * never bounce (FL-01): from rest, the standard spring reaches its target at about 280 ms, going at
 * about 15 % of its travel a second, and stops there, in place with no overshoot (FL-18, SV-26). A
 * value turned around at speed keeps its momentum, and comes back as a spring does (FL-01).
 */
const STOP_SPEED = 600

/**
 * One animated number driven by motion's spring physics. Retargeting keeps the current
 * value and velocity, so interrupted animations continue smoothly (FL-01).
 */
export class SpringValue {
  value: number
  private target: number
  private velocity = 0
  private gen: KeyframeGenerator<number> | null = null
  private start = 0
  private lastTime = 0
  /** The side of the target the value comes from: +1 below it, -1 above it, 0 at it. */
  private side = 0

  constructor(value: number) {
    this.value = value
    this.target = value
  }

  get animating(): boolean {
    return this.gen !== null
  }

  jump(value: number): void {
    this.value = value
    this.target = value
    this.velocity = 0
    this.gen = null
  }

  to(target: number, now: number, params: SpringParams = STANDARD): void {
    if (target === this.target && (this.gen || this.value === target)) return
    this.target = target
    if (Math.abs(target - this.value) < 0.05 && Math.abs(this.velocity) < 1) {
      this.jump(target)
      return
    }
    this.side = Math.sign(target - this.value)
    this.gen = spring({
      keyframes: [this.value, target],
      velocity: this.velocity,
      ...params,
      restDelta: 0.05,
      restSpeed: 2,
    })
    this.start = now
    this.lastTime = now
  }

  /** Advances to `now` (ms). Returns true while still moving. */
  step(now: number): boolean {
    if (!this.gen) return false
    const next = this.gen.next(Math.max(0, now - this.start))
    const value = next.value
    let done = next.done
    const dt = (now - this.lastTime) / 1000
    if (dt > 0) this.velocity = (value - this.value) / dt
    this.lastTime = now
    this.value = value
    const toGo = this.target - value
    if (this.side !== 0 && Math.sign(toGo) !== this.side) {
      // It reached the target: it stops there, unless it is going too fast to stop at once.
      if (Math.abs(this.velocity) <= STOP_SPEED) done = true
      else this.side = -this.side
    }
    if (done) {
      this.jump(this.target)
      return false
    }
    return true
  }
}
