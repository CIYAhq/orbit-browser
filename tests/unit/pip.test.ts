import { describe, expect, it } from 'vitest'
import {
  anchoredResize,
  clampPipSize,
  cornerRect,
  cubicBezier,
  draggedSize,
  keepInside,
  maxPipSize,
  mixRect,
  nearestCorner,
  normalizePlacement,
  PIP_MARGIN,
  PIP_MIN_SIZE,
  pipAspect,
  pipDimensions,
  resizeWithResistance,
  roundedShape,
  rubberBand,
  STANDARD_CURVE,
  settleCorner,
  springStep,
} from '../../src/shared/pip'
import type { Rect } from '../../src/shared/rpc'

const AREA: Rect = { x: 0, y: 25, width: 1440, height: 875 }

describe('floating player size and place (MD-03)', () => {
  it('[MD-03] opens 320 × 180 for a 16:9 video, bottom-right, 16 px from the work area edges', () => {
    const { width, height } = pipDimensions(pipAspect(1920, 1080), 320)
    expect({ width, height }).toEqual({ width: 320, height: 180 })
    const r = cornerRect(AREA, 'bottom-right', width, height)
    expect(PIP_MARGIN).toBe(16)
    expect(r).toEqual({ x: 1440 - 16 - 320, y: 25 + 875 - 16 - 180, width: 320, height: 180 })
    expect(cornerRect(AREA, 'top-left', width, height)).toEqual({ x: 16, y: 41, width: 320, height: 180 })
  })

  it('[MD-03] keeps the video shape: portrait videos stand up, unknown or extreme shapes are tamed', () => {
    expect(pipDimensions(pipAspect(1080, 1920), 320)).toEqual({ width: 180, height: 320 })
    expect(pipAspect(0, 0)).toBeCloseTo(16 / 9)
    expect(pipAspect(Number.NaN, 5)).toBeCloseTo(16 / 9)
    expect(pipAspect(10_000, 10)).toBe(3)
    expect(pipAspect(10, 10_000)).toBe(0.4)
    expect(pipDimensions(0, 320)).toEqual({ width: 320, height: 180 })
  })

  it('[MD-03] rounded corners where the system cannot round a window: a shape without the corner curves', () => {
    const w = 320
    const h = 180
    const shape = roundedShape(w, h, 10)
    // Rows run top to bottom without gaps or overlaps and stay inside the window.
    let y = 0
    for (const r of shape) {
      expect(r.y).toBe(y)
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.x + r.width).toBeLessThanOrEqual(w)
      expect(r.width).toBe(w - 2 * r.x)
      y += r.height
    }
    expect(y).toBe(h)
    // The very corners are cut, the curve widens row by row, the middle is full width.
    const first = shape[0] as Rect
    expect(first.x).toBeGreaterThanOrEqual(5)
    expect(shape.find((r) => r.y <= h / 2 && r.y + r.height > h / 2)?.width).toBe(w)
    const insets = shape.slice(0, shape.length / 2).map((r) => r.x)
    for (let i = 1; i < insets.length; i++) expect(insets[i] as number).toBeLessThan(insets[i - 1] as number)
    // Top and bottom are mirror images.
    const top = shape.filter((r) => r.y < 10)
    const bottom = shape.filter((r) => r.y >= h - 10)
    expect(bottom.map((r) => [r.x, r.height]).reverse()).toEqual(top.map((r) => [r.x, r.height]))
    // About the area of a rounded rectangle: (4 − π)·r² cut away.
    const area = shape.reduce((sum, r) => sum + r.width * r.height, 0)
    expect(w * h - area).toBeGreaterThan(60)
    expect(w * h - area).toBeLessThan(110)
  })

  it('[MD-03] a tiny window still gets a valid shape, and radius 0 is the plain rectangle', () => {
    expect(roundedShape(320, 180, 0)).toEqual([{ x: 0, y: 0, width: 320, height: 180 }])
    const tiny = roundedShape(6, 4, 10)
    expect(tiny.reduce((sum, r) => sum + r.height, 0)).toBe(4)
    for (const r of tiny) expect(r.width).toBeGreaterThan(0)
  })
})

describe('moving and resizing the player (MD-06, FL-32)', () => {
  it('[MD-06] sizes stay between about 200 px and half the screen width', () => {
    expect(PIP_MIN_SIZE).toBe(200)
    expect(maxPipSize(AREA)).toBe(720)
    expect(clampPipSize(100, AREA)).toBe(200)
    expect(clampPipSize(5000, AREA)).toBe(720)
    expect(clampPipSize(Number.NaN, AREA)).toBe(320)
    // A small screen still allows the smallest player.
    expect(maxPipSize({ x: 0, y: 0, width: 300, height: 300 })).toBe(200)
  })

  it('[MD-06][FL-32] a released player snaps to the nearest corner; a fling heads for the corner in its direction', () => {
    const near = { x: 300, y: 200, width: 320, height: 180 }
    expect(nearestCorner(AREA, 460, 290)).toBe('top-left')
    expect(settleCorner(AREA, near, { x: 0, y: 0 })).toBe('top-left')
    // A quick flick to the bottom right carries it over the middle.
    expect(settleCorner(AREA, near, { x: 2500, y: 2000 })).toBe('bottom-right')
    expect(settleCorner(AREA, near, { x: 2500, y: 0 })).toBe('top-right')
    // A slow drift doesn't.
    expect(settleCorner(AREA, near, { x: 200, y: 100 })).toBe('top-left')
    // Nonsense velocities count as none; huge ones reach at most one screen further.
    expect(settleCorner(AREA, near, { x: Number.NaN, y: Number.POSITIVE_INFINITY })).toBe('top-left')
    expect(settleCorner(AREA, near, { x: -1e9, y: 1e9 })).toBe('bottom-left')
  })

  it('[MD-06][FL-32] past a size limit the player resists more the further it goes, and never runs away', () => {
    expect(rubberBand(0, 100)).toBe(0)
    expect(rubberBand(-5, 100)).toBe(0)
    let last = 0
    for (const excess of [10, 50, 100, 400, 2000, 1e6]) {
      const r = rubberBand(excess, 100)
      expect(r).toBeGreaterThan(last)
      expect(r).toBeLessThan(Math.min(excess, 100))
      last = r
    }
    const max = maxPipSize(AREA)
    expect(resizeWithResistance(500, AREA)).toBe(500)
    const over = resizeWithResistance(max + 200, AREA)
    expect(over).toBeGreaterThan(max)
    expect(over).toBeLessThan(max + 200)
    expect(resizeWithResistance(max + 1e5, AREA)).toBeLessThan(max * 1.25)
    const under = resizeWithResistance(100, AREA)
    expect(under).toBeLessThan(PIP_MIN_SIZE)
    expect(under).toBeGreaterThan(PIP_MIN_SIZE * 0.75)
  })

  it('[MD-06] a corner drag keeps the video shape and the opposite corner in place', () => {
    const start = { x: 1104, y: 41, width: 320, height: 180 }
    // Dragging the bottom-left corner out to the left (and a bit down) grows it.
    const size = draggedSize(start, 'bottom-left', -200, 100)
    expect(size).toBe(520)
    const { width, height } = pipDimensions(16 / 9, size)
    const r = anchoredResize(start, 'bottom-left', width, height)
    expect(r).toEqual({ x: 1104 + 320 - 520, y: 41, width: 520, height: 293 })
    // Inwards shrinks; the top-left handle keeps the bottom-right corner.
    expect(draggedSize(start, 'top-left', 60, 10)).toBeCloseTo(260)
    const s = anchoredResize(start, 'top-left', 260, 146)
    expect(s.x + s.width).toBe(start.x + start.width)
    expect(s.y + s.height).toBe(start.y + start.height)
  })

  it('[MD-06] a player moved off screen comes back inside the work area', () => {
    expect(keepInside(AREA, { x: -100, y: 2000, width: 320, height: 180 })).toEqual({
      x: 0,
      y: 25 + 875 - 180,
      width: 320,
      height: 180,
    })
    expect(keepInside(AREA, { x: 50, y: 60, width: 320, height: 180 })).toEqual({
      x: 50,
      y: 60,
      width: 320,
      height: 180,
    })
  })

  it('[MD-06] the remembered corner and size are cleaned when read back', () => {
    expect(normalizePlacement(undefined)).toBeUndefined()
    expect(normalizePlacement('top-left')).toBeUndefined()
    expect(normalizePlacement({ corner: 'top-left', size: 480 })).toEqual({ corner: 'top-left', size: 480 })
    expect(normalizePlacement({ corner: 'middle', size: 'big' })).toEqual({ corner: 'bottom-right', size: 320 })
    expect(normalizePlacement({ corner: 'top-right', size: 12 })).toEqual({ corner: 'top-right', size: 200 })
    expect(normalizePlacement({ corner: 'top-right', size: 1e9 })).toEqual({ corner: 'top-right', size: 4000 })
  })
})

describe('player motion (MD-01, MD-16, FL-01, FL-32)', () => {
  it('[MD-16][FL-01] the enter motion follows the standard curve: starts fast, settles gently', () => {
    // CSS "ease" at its midpoint, a well-known value: the solver matches the browser's curves.
    expect(cubicBezier(0.25, 0.1, 0.25, 1)(0.5)).toBeCloseTo(0.8024, 3)
    const ease = cubicBezier(...STANDARD_CURVE)
    expect(ease(0)).toBe(0)
    expect(ease(1)).toBe(1)
    expect(ease(-1)).toBe(0)
    expect(ease(2)).toBe(1)
    let last = 0
    for (let t = 0.05; t < 1; t += 0.05) {
      const v = ease(t)
      expect(v).toBeGreaterThanOrEqual(last)
      last = v
    }
    // Most of the way there by a third of the time (it doesn't crawl at the end of the motion).
    expect(ease(1 / 3)).toBeGreaterThan(0.75)
  })

  it('[MD-16] the player grows between two rects in step', () => {
    const a = { x: 0, y: 0, width: 480, height: 270 }
    const b = { x: 1104, y: 704, width: 320, height: 180 }
    expect(mixRect(a, b, 0)).toEqual(a)
    expect(mixRect(a, b, 1)).toEqual(b)
    expect(mixRect(a, b, 0.5)).toEqual({ x: 552, y: 352, width: 400, height: 225 })
  })

  it('[FL-32] the glide into a corner settles within about half a second without bouncing far, at any frame rate', () => {
    for (const dt of [1 / 120, 1 / 60, 1 / 20]) {
      let s = { offset: 300, velocity: -2000 }
      let overshoot = 0
      for (let t = 0; t < 0.6; t += dt) {
        s = springStep(s.offset, s.velocity, dt)
        overshoot = Math.min(overshoot, s.offset)
      }
      expect(Math.abs(s.offset)).toBeLessThan(1)
      expect(overshoot).toBeGreaterThan(-60)
    }
    // A very long frame doesn't blow up.
    const big = springStep(300, 0, 0.5)
    expect(Number.isFinite(big.offset)).toBe(true)
    expect(Math.abs(big.offset)).toBeLessThan(300)
  })
})
