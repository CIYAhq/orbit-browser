import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DURATION,
  durationMs,
  EASE,
  EXIT_FACTOR,
  ONE_FRAME_S,
  REDUCED,
  SPRING,
  springFrom,
  tween,
  waapi,
} from '../../src/shared/motion'

/** Where a unit spring released from 0 toward 1 overshoots the most (0 when it doesn't). */
function springOvershoot(s: { stiffness: number; damping: number }): number {
  let x = 0
  let v = 0
  let most = 0
  for (let t = 0; t < 2; t += 1 / 2000) {
    v += (s.stiffness * (1 - x) - s.damping * v) / 2000
    x += v / 2000
    most = Math.max(most, x - 1)
  }
  return most
}

/** The highest point of a CSS cubic-bezier curve's output (> 1 means it overshoots). */
function bezierPeak([, y1, , y2]: [number, number, number, number]): number {
  let peak = 0
  for (let s = 0; s <= 1; s += 1 / 4000)
    peak = Math.max(peak, 3 * (1 - s) ** 2 * s * y1 + 3 * (1 - s) * s ** 2 * y2 + s ** 3)
  return peak
}

describe('motion tokens (FL-01)', () => {
  it('turns response and damping ratio into the stiffness and damping FL-01 lists for mass 1', () => {
    // FL-01: snappy ≈ 632 / 45, standard ≈ 386 / 35, pop ≈ 439 / 29.
    expect(SPRING.snappy.stiffness).toBeCloseTo(632, -1)
    expect(SPRING.snappy.damping).toBeCloseTo(45, 0)
    expect(SPRING.standard.stiffness).toBeCloseTo(386, -1)
    expect(SPRING.standard.damping).toBeCloseTo(35, 0)
    expect(SPRING.pop.stiffness).toBeCloseTo(439, -1)
    expect(SPRING.pop.damping).toBeCloseTo(29, 0)
    expect(springFrom(0.5, 1)).toEqual({ stiffness: (4 * Math.PI) ** 2, damping: 8 * Math.PI, mass: 1 })
  })

  it('keeps structure from bouncing and lets small things overshoot by about 4 %', () => {
    expect(springOvershoot(SPRING.snappy)).toBeLessThan(0.005)
    expect(springOvershoot(SPRING.standard)).toBeLessThan(0.01)
    const pop = springOvershoot(SPRING.pop)
    expect(pop).toBeGreaterThan(0.03)
    expect(pop).toBeLessThan(0.05)
    // The CSS fallback for pop overshoots about as much; the others not at all.
    expect(bezierPeak(EASE.pop) - 1).toBeGreaterThan(0.03)
    expect(bezierPeak(EASE.pop) - 1).toBeLessThan(0.05)
    for (const k of ['instant', 'quick', 'snappy', 'standard', 'gentle'] as const) {
      expect(bezierPeak(EASE[k])).toBeLessThanOrEqual(1)
    }
  })

  it('times each CSS fallback inside the range FL-01 gives it, and exits at 0.7×', () => {
    const ranges = {
      instant: [80, 100],
      quick: [120, 150],
      snappy: [180, 220],
      standard: [250, 300],
      pop: [220, 260],
      gentle: [200, 300],
    } as const
    for (const [k, [lo, hi]] of Object.entries(ranges)) {
      const ms = DURATION[k as keyof typeof DURATION]
      expect(ms, k).toBeGreaterThanOrEqual(lo)
      expect(ms, k).toBeLessThanOrEqual(hi)
    }
    expect(EXIT_FACTOR).toBe(0.7)
    expect(durationMs('snappy', true)).toBe(140)
    expect(tween('quick')).toEqual({ duration: 0.13, ease: [0.2, 0, 0, 1] })
    expect(tween('quick', { exit: true, delay: 0.05 })).toEqual({ duration: 0.091, ease: [0.2, 0, 0, 1], delay: 0.05 })
    expect(waapi('snappy')).toEqual({ duration: 200, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' })
    // FL-28: a reduced cross-fade is about 100–150 ms; a released drag settles in about 120 ms.
    expect(REDUCED.fadeMs).toBeGreaterThanOrEqual(100)
    expect(REDUCED.fadeMs).toBeLessThanOrEqual(150)
    expect(REDUCED.settleMs).toBe(120)
  })

  it('motion.css holds the same values as the shared tokens', () => {
    const css = readFileSync(resolve(__dirname, '../../src/renderer/src/motion/motion.css'), 'utf8')
    const prop = (name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(css)?.[1]?.trim()
    for (const [k, ms] of Object.entries(DURATION)) expect(prop(`motion-${k}`), k).toBe(`${ms}ms`)
    for (const [k, b] of Object.entries(EASE)) expect(prop(`ease-${k}`), k).toBe(`cubic-bezier(${b.join(', ')})`)
    expect(prop('motion-exit')).toBe(String(EXIT_FACTOR))
    expect(prop('motion-fade')).toBe(`${REDUCED.fadeMs}ms`)
    expect(prop('motion-lead')).toBe(`calc(-1000ms / ${1 / ONE_FRAME_S})`)
  })
})
