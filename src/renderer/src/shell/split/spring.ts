import { type KeyframeGenerator, spring } from 'motion'
import { reducedMotion } from '../../motion/reduced'
import { SPRING, type Spring } from '../../motion/tokens'

/** FL-01's standard spring (response 0.32 s, damping ratio 0.88): pane layout. */
export const STANDARD = SPRING.standard
/** FL-01's snappy spring (drop indicator moves, small re-flows). */
export const SNAPPY = SPRING.snappy

export type SpringParams = Spring

/** Reduced motion: the OS setting or Orbit's own (FL-28). */
export const prefersReducedMotion = reducedMotion

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
    const { value, done } = this.gen.next(Math.max(0, now - this.start))
    const dt = (now - this.lastTime) / 1000
    if (dt > 0) this.velocity = (value - this.value) / dt
    this.lastTime = now
    this.value = value
    if (done) {
      this.jump(this.target)
      return false
    }
    return true
  }
}
