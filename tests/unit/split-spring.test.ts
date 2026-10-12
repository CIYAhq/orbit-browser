import { describe, expect, it } from 'vitest'
import { SNAPPY, type SpringParams, SpringValue, STANDARD } from '../../src/renderer/src/shell/split/spring'

const FRAME = 1000 / 60

/** Runs a value from `from` to `to` at 60 Hz, from rest: each frame's value, and when it stopped (ms). */
function run(from: number, to: number, params: SpringParams = STANDARD) {
  const value = new SpringValue(from)
  value.to(to, 0, params)
  const frames: { t: number; v: number }[] = []
  let t = 0
  while (value.animating && t < 3000) {
    t += FRAME
    value.step(t)
    frames.push({ t, v: value.value })
  }
  const placed = frames.findIndex((_f, i) => frames.slice(i).every((g) => Math.abs(g.v - to) <= 0.5))
  return { frames, stopped: t, placed: frames[placed]?.t ?? Number.POSITIVE_INFINITY }
}

describe('split panes: the spring (FL-01, FL-18, SV-26)', () => {
  it('a pane growing or shrinking from rest is in place by 300 ms, and never passes its place', () => {
    for (const travel of [120, 600, 1400]) {
      for (const [from, to] of [
        [0, travel],
        [travel, 0],
      ] as const) {
        const { frames, stopped, placed } = run(from, to)
        const past = frames.map((f) => (to > from ? f.v - to : to - f.v))
        expect(Math.max(...past), `${from} → ${to}: no overshoot`).toBeLessThanOrEqual(0)
        // FL-18: the standard spring, about 260–300 ms; in place within 350 ms.
        expect(placed, `${from} → ${to}: in place`).toBeGreaterThanOrEqual(250)
        expect(placed, `${from} → ${to}: in place`).toBeLessThanOrEqual(300)
        expect(stopped, `${from} → ${to}: stopped`).toBeLessThanOrEqual(300 + 1)
      }
    }
  })

  it('the snappy spring stops at its target too', () => {
    const { frames, placed } = run(0, 500, SNAPPY)
    expect(Math.max(...frames.map((f) => f.v))).toBeLessThanOrEqual(500)
    expect(placed).toBeLessThanOrEqual(270)
  })

  it('a value turned around at speed keeps its momentum, as a spring does (FL-01)', () => {
    const value = new SpringValue(0)
    value.to(1000, 0)
    let t = 0
    let speed = 0
    for (let i = 0; i < 4; i++) {
      const before = value.value
      t += FRAME
      value.step(t)
      speed = value.value - before
    }
    // Going fast, it is sent to a place just ahead: it goes past it, and comes back.
    const target = value.value + 20
    value.to(target, t)
    const seen: number[] = []
    let last = value.value
    let biggest = 0
    while (value.animating && t < 3000) {
      t += FRAME
      value.step(t)
      seen.push(value.value)
      biggest = Math.max(biggest, Math.abs(value.value - last))
      last = value.value
    }
    expect(Math.max(...seen)).toBeGreaterThan(target + 1)
    expect(value.value).toBe(target)
    // No frame moves faster than it was going, and none snaps back from the far side to the target.
    expect(biggest).toBeLessThanOrEqual(speed)
    expect(Math.abs((seen.at(-2) ?? target) - target)).toBeLessThan(10)
  })
})
