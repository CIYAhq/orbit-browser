import { describe, expect, it } from 'vitest'
import {
  classify,
  MomentumDetector,
  RUBBER_SPRING,
  releaseDecision,
  rubberBand,
  SETTLE_SPRING,
  STANDARD_SPRING,
  springFrom,
  swipeOffset,
  VelocityTracker,
  viewportPosition,
} from '../../src/renderer/src/shell/spaces/physics'

const W = 240

describe('[FL-13][SP-08] swipe physics', () => {
  it('springs come from FL-01 response/damping ratio (standard ≈ 386 / 35)', () => {
    expect(STANDARD_SPRING.stiffness).toBeCloseTo(385.6, 0)
    expect(STANDARD_SPRING.damping).toBeCloseTo(34.6, 0)
    expect(SETTLE_SPRING.damping / (2 * Math.sqrt(SETTLE_SPRING.stiffness))).toBeCloseTo(0.95, 2)
    expect(RUBBER_SPRING.damping / (2 * Math.sqrt(RUBBER_SPRING.stiffness))).toBeCloseTo(1, 2)
    expect(springFrom(0.3, 1).stiffness).toBeCloseTo(438.6, 0)
  })

  it('recognises a horizontal gesture after ~9 px within 30° of horizontal', () => {
    expect(classify(5, 0)).toBeUndefined()
    expect(classify(10, 0)).toBe('x')
    expect(classify(10, 5)).toBe('x')
    expect(classify(10, 6)).toBe('y')
    expect(classify(2, 12)).toBe('y')
  })

  it('tracks 1:1 between Spaces and at most one page per gesture', () => {
    expect(swipeOffset(73, W, true, true)).toBe(73)
    expect(swipeOffset(-50, W, true, true)).toBe(-50)
    expect(swipeOffset(1000, W, true, true)).toBe(W)
  })

  it('rubber-bands past the first or last Space with growing resistance', () => {
    expect(rubberBand(0, W)).toBe(0)
    // Resistance starts at once (slope 0.55) and grows with travel.
    expect(rubberBand(20, W)).toBeCloseTo(10.5, 1)
    expect(rubberBand(120, W) - rubberBand(100, W)).toBeLessThan(rubberBand(20, W))
    // One sidebar width of travel shows about a third of the width.
    expect(rubberBand(W, W) / W).toBeCloseTo(0.355, 2)
    expect(rubberBand(-W, W)).toBeCloseTo(-rubberBand(W, W))
    expect(swipeOffset(W, W, true, false)).toBeCloseTo(rubberBand(W, W))
    expect(swipeOffset(-W, W, false, true)).toBeCloseTo(-rubberBand(W, W))
  })

  it('commits past a third, by projected distance or by a flick; otherwise returns', () => {
    expect(releaseDecision(W * 0.34, 0, W, true, false)).toBe('commit')
    expect(releaseDecision(W * 0.2, 0, W, true, false)).toBe('return')
    expect(releaseDecision(W * 0.2, 600, W, true, false)).toBe('commit')
    expect(releaseDecision(W * 0.3, 400, W, true, false)).toBe('commit')
    expect(releaseDecision(W * 0.3, 300, W, true, false)).toBe('return')
    expect(releaseDecision(-W * 0.2, -600, W, true, false)).toBe('commit')
    // A flick back toward the start cancels.
    expect(releaseDecision(W * 0.3, -800, W, true, false)).toBe('return')
    expect(releaseDecision(W * 0.45, -900, W, true, false)).toBe('return')
  })

  it('at the last Space only a long or hard over-swipe adds a Space', () => {
    expect(releaseDecision(W * 0.15, 100, W, false, true)).toBe('return')
    expect(releaseDecision(W * 0.27, 0, W, false, true)).toBe('new-space')
    expect(releaseDecision(W * 0.12, 900, W, false, true)).toBe('new-space')
    expect(releaseDecision(W * 0.3, 0, W, false, false)).toBe('return')
    expect(releaseDecision(-W * 0.3, -900, W, false, true)).toBe('return')
  })

  it('estimates release velocity from recent samples', () => {
    const v = new VelocityTracker()
    v.add(0, 0)
    v.add(16, 8)
    v.add(32, 16)
    expect(v.velocity()).toBeCloseTo(500, 0)
    v.add(400, 16)
    expect(v.velocity()).toBeLessThan(100)
  })

  it('detects OS momentum (steady decay) but not a finger that keeps moving', () => {
    const m = new MomentumDetector()
    expect([20, 22, 19, 23, 21, 24].map((d) => m.push(d)).some(Boolean)).toBe(false)
    m.reset()
    const decays = [30, 27, 24.3, 21.9, 19.7, 17.7].map((d) => m.push(d))
    expect(decays.at(-1)).toBe(true)
  })

  it('maps the strip offset to the pair of pages on screen', () => {
    expect(viewportPosition(0, W)).toEqual({ slot: 0, t: 0 })
    expect(viewportPosition(-W / 4, W)).toEqual({ slot: 0, t: 0.25 })
    expect(viewportPosition(W / 4, W)).toEqual({ slot: -1, t: 0.75 })
  })
})
