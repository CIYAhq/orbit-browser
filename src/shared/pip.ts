/**
 * Geometry of Orbit's floating video player (media lane; media.md MD-03, MD-06, feel.md FL-32).
 * Pure functions in screen DIPs: the main process places, resizes and snaps the player window with
 * them. No Electron or DOM here, so it is unit-tested.
 */
import { type Bezier, EASE, SPRING } from './motion'
import type { Rect } from './rpc'
import type { PipCorner, PipPlacement } from './state'

export type { PipCorner, PipPlacement }
export const PIP_CORNERS: readonly PipCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']

/** Space between the player and the edges of the screen's work area (MD-03: about 16 px). */
export const PIP_MARGIN = 16
/** Default longer side: 320 × 180 for a 16:9 video (MD-03). */
export const PIP_DEFAULT_SIZE = 320
/** Smallest width (MD-06: about 200 px wide). */
export const PIP_MIN_SIZE = 200
export const DEFAULT_PIP_PLACEMENT: PipPlacement = { corner: 'bottom-right', size: PIP_DEFAULT_SIZE }

// Sizes below are the player's longer side, for a video's shape (width / height; 16:9 if unknown).

/** Smallest longer side: the player is at least about 200 px wide, a tall video too (MD-06). */
export function minPipSize(aspect = 16 / 9): number {
  const a = pipAspect(aspect, 1)
  return a >= 1 ? PIP_MIN_SIZE : Math.ceil(PIP_MIN_SIZE / a)
}

/**
 * Largest longer side on a work area: about half the screen's width (MD-06), and never taller than
 * the work area inside its margins, so a square or tall video still fits on the screen. A small
 * screen still allows the smallest player.
 */
export function maxPipSize(area: Rect, aspect = 16 / 9): number {
  const a = pipAspect(aspect, 1)
  const tall = Math.max(1, area.height - 2 * PIP_MARGIN)
  const fits = a >= 1 ? Math.floor(tall * a) : tall
  return Math.max(PIP_MIN_SIZE, Math.min(Math.floor(area.width / 2), fits))
}

export function clampPipSize(size: number, area: Rect, aspect = 16 / 9): number {
  const n = Number.isFinite(size) ? size : PIP_DEFAULT_SIZE
  // Where the two limits cross (a tall video on a small screen), fitting on the screen wins.
  return Math.round(Math.min(Math.max(n, minPipSize(aspect)), maxPipSize(area, aspect)))
}

/** A usable aspect ratio (width / height); odd or unknown ones fall back to 16:9. */
export function pipAspect(width: number, height: number): number {
  const a = width > 0 && height > 0 ? width / height : 16 / 9
  return Number.isFinite(a) ? Math.min(Math.max(a, 0.4), 3) : 16 / 9
}

/** The player's width and height for a video's aspect ratio, with `size` as its longer side. */
export function pipDimensions(aspect: number, size: number): { width: number; height: number } {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 16 / 9
  return a >= 1
    ? { width: Math.round(size), height: Math.round(size / a) }
    : { width: Math.round(size * a), height: Math.round(size) }
}

/** The player's rect in a corner of the work area, `margin` from its edges. */
export function cornerRect(area: Rect, corner: PipCorner, width: number, height: number, margin = PIP_MARGIN): Rect {
  const left = corner === 'top-left' || corner === 'bottom-left'
  const top = corner === 'top-left' || corner === 'top-right'
  return {
    x: Math.round(left ? area.x + margin : area.x + area.width - margin - width),
    y: Math.round(top ? area.y + margin : area.y + area.height - margin - height),
    width: Math.round(width),
    height: Math.round(height),
  }
}

/** The corner of the work area nearest to a point. */
export function nearestCorner(area: Rect, x: number, y: number): PipCorner {
  const left = x < area.x + area.width / 2
  const top = y < area.y + area.height / 2
  return top ? (left ? 'top-left' : 'top-right') : left ? 'bottom-left' : 'bottom-right'
}

/** Seconds of travel a release velocity carries the player before it settles (a flick goes further). */
export const PIP_PROJECTION = 0.2

/**
 * Where a released player settles (MD-06, FL-32): its centre is carried along the release velocity
 * (px/s), so a fling heads for the corner in its direction, then it snaps to the nearest corner.
 */
export function settleCorner(area: Rect, rect: Rect, velocity: { x: number; y: number }): PipCorner {
  const reach = (v: number, span: number) =>
    Math.max(-span, Math.min(span, (Number.isFinite(v) ? v : 0) * PIP_PROJECTION))
  const cx = rect.x + rect.width / 2 + reach(velocity.x, area.width)
  const cy = rect.y + rect.height / 2 + reach(velocity.y, area.height)
  return nearestCorner(area, cx, cy)
}

/**
 * Rubber band past a size limit (feel.md FL-13's formula, FL-32): the further the pointer goes
 * past the limit, the less the player follows. `excess` is how far past (px); `span` scales the
 * resistance. The result never exceeds `span`.
 */
export function rubberBand(excess: number, span: number): number {
  if (excess <= 0 || span <= 0) return 0
  return (1 - 1 / ((excess * 0.55) / span + 1)) * span
}

/**
 * The player's longer side while a corner is dragged: follows the pointer between the limits and
 * resists beyond them (it springs back to the limit on release).
 */
export function resizeWithResistance(wanted: number, area: Rect, aspect = 16 / 9): number {
  const max = maxPipSize(area, aspect)
  const min = Math.min(minPipSize(aspect), max)
  if (wanted < min) return min - rubberBand(min - wanted, min * 0.25)
  if (wanted > max) return max + rubberBand(wanted - max, max * 0.25)
  return wanted
}

/** The corner opposite the one being dragged stays put while resizing. */
export function anchoredResize(start: Rect, handle: PipCorner, width: number, height: number): Rect {
  const right = start.x + start.width
  const bottom = start.y + start.height
  const left = handle === 'top-left' || handle === 'bottom-left'
  const top = handle === 'top-left' || handle === 'top-right'
  return {
    x: Math.round(left ? right - width : start.x),
    y: Math.round(top ? bottom - height : start.y),
    width: Math.round(width),
    height: Math.round(height),
  }
}

/**
 * The longer side a corner drag asks for: the pointer's travel along the handle's diagonal,
 * projected on the player's aspect, so the ratio is kept (MD-06).
 */
export function draggedSize(start: Rect, handle: PipCorner, dx: number, dy: number): number {
  const sx = handle === 'top-left' || handle === 'bottom-left' ? -1 : 1
  const sy = handle === 'top-left' || handle === 'top-right' ? -1 : 1
  const longer = Math.max(start.width, start.height)
  const growX = (sx * dx) / Math.max(1, start.width)
  const growY = (sy * dy) / Math.max(1, start.height)
  // Follow whichever axis moved further (relative to the player's size).
  const grow = Math.abs(growX) >= Math.abs(growY) ? growX : growY
  return longer * (1 + grow)
}

/** Keeps a rect inside the work area (a player dragged off-screen comes back). */
export function keepInside(area: Rect, rect: Rect): Rect {
  const x = Math.min(Math.max(rect.x, area.x), area.x + area.width - rect.width)
  const y = Math.min(Math.max(rect.y, area.y), area.y + area.height - rect.height)
  return { ...rect, x: Math.round(x), y: Math.round(y) }
}

// Orbit's alerts and dialogs (MD-06: the player never covers them).

/**
 * The most room a dialog takes: a file picker (alerts are smaller). Where it shows over its window
 * isn't known exactly, so the player keeps clear of this much of it.
 */
export const PIP_DIALOG_ROOM = { width: 900, height: 620 } as const

/**
 * Where a dialog over a window can be (MD-06): the dialog room centered on the window, or hanging
 * from its top where dialogs are sheets (macOS); within the work area of the window's screen.
 */
export function dialogZone(window: Rect, area: Rect, sheet: boolean): Rect {
  const { width, height } = PIP_DIALOG_ROOM
  const x = window.x + (window.width - width) / 2
  const y = sheet ? window.y : window.y + (window.height - height) / 2
  const left = Math.max(area.x, x)
  const top = Math.max(area.y, y)
  const right = Math.min(area.x + area.width, x + width)
  const bottom = Math.min(area.y + area.height, y + height)
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.max(0, Math.round(right - left)),
    height: Math.max(0, Math.round(bottom - top)),
  }
}

/** Whether two rects are the same. */
export function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** Whether two rects share some area (rects that only touch don't). */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/**
 * Where the player goes while dialogs show in `zones` (MD-06): `undefined` when it is clear of them
 * all where it is; else the corner of the work area nearest to it that is clear of them all, at the
 * same size; else `null` (no corner is clear: it hides until they close).
 */
export function asideRect(area: Rect, player: Rect, zones: readonly Rect[]): Rect | null | undefined {
  if (!zones.some((zone) => rectsOverlap(player, zone))) return undefined
  const cx = player.x + player.width / 2
  const cy = player.y + player.height / 2
  let best: Rect | null = null
  let nearest = Number.POSITIVE_INFINITY
  for (const corner of PIP_CORNERS) {
    const rect = cornerRect(area, corner, player.width, player.height)
    if (zones.some((zone) => rectsOverlap(rect, zone))) continue
    const distance = Math.hypot(rect.x + rect.width / 2 - cx, rect.y + rect.height / 2 - cy)
    if (distance < nearest) {
      best = rect
      nearest = distance
    }
  }
  return best
}

/** Normalizes a stored placement (persisted settings may be old or hand-edited). */
export function normalizePlacement(value: unknown): PipPlacement | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as { corner?: unknown; size?: unknown }
  const corner = PIP_CORNERS.includes(v.corner as PipCorner) ? (v.corner as PipCorner) : 'bottom-right'
  const size =
    typeof v.size === 'number' && Number.isFinite(v.size)
      ? Math.round(Math.min(Math.max(v.size, PIP_MIN_SIZE), 4000))
      : PIP_DEFAULT_SIZE
  return { corner, size }
}

/** Cubic-bezier easing (x1, y1, x2, y2), as in CSS, for animations driven from the main process. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx
  return (x: number) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x
      if (Math.abs(err) < 1e-5) break
      const d = slopeX(t)
      if (Math.abs(d) < 1e-6) break
      t -= err / d
    }
    t = Math.min(Math.max(t, 0), 1)
    return sampleY(t)
  }
}

/** feel.md FL-01 "standard" CSS curve (sidebar, Space settle, preview open), used to enter PiP. */
export const STANDARD_CURVE: Bezier = EASE.standard
/** CSS `ease-out` (FL-01's instant curve): with reduced motion a released player settles on it, with no overshoot (FL-28). */
export const EASE_OUT_CURVE: Bezier = EASE.instant

/** Interpolates two rects. */
export function mixRect(a: Rect, b: Rect, t: number): Rect {
  const m = (p: number, q: number) => p + (q - p) * t
  return {
    x: Math.round(m(a.x, b.x)),
    y: Math.round(m(a.y, b.y)),
    width: Math.round(m(a.width, b.width)),
    height: Math.round(m(a.height, b.height)),
  }
}

/**
 * One step of a damped spring (mass 1) toward 0, for gliding the player to its corner with the
 * release velocity (FL-01 "standard"). Returns the new offset and velocity.
 */
export function springStep(
  offset: number,
  velocity: number,
  dt: number,
  stiffness = SPRING.standard.stiffness,
  damping = SPRING.standard.damping,
): { offset: number; velocity: number } {
  // Semi-implicit Euler in small sub-steps: stable at frame-sized dt.
  let x = offset
  let v = velocity
  const steps = Math.max(1, Math.ceil(dt / 0.004))
  const h = dt / steps
  for (let i = 0; i < steps; i++) {
    v += (-stiffness * x - damping * v) * h
    x += v * h
  }
  return { offset: x, velocity: v }
}

/**
 * The player's rounded outline as rectangles, for a window shape where the system can't round a
 * window's corners (MD-03 on Windows and Linux): one-pixel rows for each corner's curve, then the
 * middle. Rows of the same width are merged.
 */
export function roundedShape(width: number, height: number, radius: number): Rect[] {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const r = Math.max(0, Math.min(Math.round(radius), Math.floor(w / 2), Math.floor(h / 2)))
  const top: Rect[] = []
  for (let y = 0; y < r; y++) {
    const dy = r - y - 0.5
    const inset = Math.round(r - Math.sqrt(r * r - dy * dy))
    const last = top[top.length - 1]
    if (last && last.x === inset) last.height++
    else top.push({ x: inset, y, width: w - 2 * inset, height: 1 })
  }
  const bottom = top.map((row) => ({ ...row, y: h - row.y - row.height })).reverse()
  return [...top, { x: 0, y: r, width: w, height: h - 2 * r }, ...bottom]
}
