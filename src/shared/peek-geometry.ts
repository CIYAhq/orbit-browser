/**
 * Peek card geometry, shared by the overlay (which draws and animates the card) and the main
 * process (which places the page view before the overlay's first frame arrives). All rects are in
 * page-area coordinates: the area the overlay covers while a Peek shows (the content frame).
 */
import { SPRING, springFrom } from './motion'

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** Corner radius of the Peek card (the frame's is 10; the floating card reads a touch rounder). */
export const PEEK_RADIUS = 12
/** Corner radius of the page frame, which the card morphs into when it expands (SB-19). */
export const FRAME_RADIUS = 10
/** Scale the card starts from when no link position is known (PK-06). */
export const PEEK_START_SCALE = 0.94
/** Scale of the small card that grows out of the clicked link. */
export const PEEK_ORIGIN_SCALE = 0.14

/** A unit spring (mass 1) of feel.md FL-01. */
export interface Spring {
  stiffness: number
  damping: number
}
/**
 * Open: grows into place in about 280–320 ms with no visible overshoot (FL-19). FL-19's own numbers:
 * response 0.275 s, ratio 0.92, a little quicker and stiller than the standard token, which takes
 * longer than 320 ms to come to rest over a card's travel.
 */
export const PEEK_OPEN_SPRING: Spring = springFrom(0.275, 0.92)
/** Expand to a tab: the card meets the page frame in about 220–260 ms (FL-19): the snappy token. */
export const PEEK_EXPAND_SPRING: Spring = SPRING.snappy
/** Close: a slight shrink (to about 0.96) and a fade over about 150–180 ms (FL-19's own timing). */
export const PEEK_CLOSE_MS = 160
export const PEEK_CLOSE_SCALE = 0.96

/**
 * Advances a unit spring (0 → 1) by `dt` seconds. Fixed sub-steps keep it stable on slow
 * frames, and a long stall counts as at most 50 ms so the card never jumps.
 */
export function advanceSpring(cfg: Spring, x: number, v: number, dt: number): { x: number; v: number } {
  let left = Math.min(0.05, Math.max(0, dt))
  while (left > 0) {
    const h = Math.min(left, 1 / 240)
    v += (cfg.stiffness * (1 - x) - cfg.damping * v) * h
    x += v * h
    left -= h
  }
  return { x, v }
}

/** Close enough to rest that snapping to the end is invisible. */
export function springResting(x: number, v: number): boolean {
  return Math.abs(1 - x) < 0.002 && Math.abs(v) < 0.02
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** The card, centred and inset from the page area's edges so the page shows around it (PK-05). */
export function peekCard(area: { width: number; height: number }): Box {
  // Room on the right for the three buttons beside the card's top corner.
  const insetX = Math.round(clamp(area.width * 0.05, 44, 64))
  const insetY = Math.round(clamp(area.height * 0.05, 22, 48))
  return {
    x: insetX,
    y: insetY,
    width: Math.max(80, area.width - insetX * 2),
    height: Math.max(80, area.height - insetY * 2),
  }
}

/** Where the open animation starts: a small card at the clicked link, or the card slightly scaled down. */
export function peekStart(card: Box, area: { width: number; height: number }, origin?: { x: number; y: number }): Box {
  if (!origin) return scaleBox(card, PEEK_START_SCALE)
  const width = card.width * PEEK_ORIGIN_SCALE
  const height = card.height * PEEK_ORIGIN_SCALE
  return {
    x: clamp(origin.x - width / 2, 0, Math.max(0, area.width - width)),
    y: clamp(origin.y - height / 2, 0, Math.max(0, area.height - height)),
    width,
    height,
  }
}

/** A box scaled about its centre. */
export function scaleBox(box: Box, scale: number): Box {
  const width = box.width * scale
  const height = box.height * scale
  return { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height }
}

/** Linear interpolation between two boxes (t may overshoot 1 slightly for springs). */
export function lerpBox(a: Box, b: Box, t: number): Box {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    width: a.width + (b.width - a.width) * t,
    height: a.height + (b.height - a.height) * t,
  }
}

/** The right half of the area, where the page lands when a Peek becomes a split (PK-08, FL-19). */
export function splitTarget(area: { width: number; height: number }, gap = 8): Box {
  const width = (area.width - gap) / 2
  return { x: area.width - width, y: 0, width, height: area.height }
}

// ---- Interactive dismiss (PK-06, FL-19) ----

/** How much the card shrinks when dragged down by its whole height ("shrinks a little"). */
export const PEEK_DRAG_SHRINK = 0.1
/** Dragged upward, the card gives at most this many pixels (rubber band). */
export const PEEK_DRAG_UP_MAX = 24
/** Releasing past this fraction of the card's height dismisses it. */
export const PEEK_DISMISS_FRACTION = 0.25
/** A downward flick faster than this (px/s) dismisses it wherever it is. */
export const PEEK_DISMISS_VELOCITY = 500

/** How far the card travels for a drag of `offset` px: 1:1 downward, resisting upward (FL-01). */
export function dragTravel(offset: number): number {
  if (offset >= 0) return offset
  return -PEEK_DRAG_UP_MAX * (1 - Math.exp(offset / (2 * PEEK_DRAG_UP_MAX)))
}

/** The card dragged by `offset` px from `base`: it follows the input and shrinks a little. */
export function draggedCard(base: Box, offset: number, restHeight: number): Box {
  const travel = dragTravel(offset)
  const progress = clamp(travel / Math.max(1, restHeight), 0, 1)
  const box = scaleBox(base, 1 - PEEK_DRAG_SHRINK * progress)
  return { ...box, y: box.y + travel }
}

/**
 * Whether letting go of a drag dismisses the card (FL-19): past about a quarter of its height
 * (unless it is being pushed back up quickly), or flicked down faster than about 500 px/s.
 * `velocity` is in px/s, positive downward.
 */
export function dismissesOnRelease(offset: number, restHeight: number, velocity: number): boolean {
  if (velocity > PEEK_DISMISS_VELOCITY) return true
  return offset > restHeight * PEEK_DISMISS_FRACTION && velocity > -PEEK_DISMISS_VELOCITY
}

/**
 * Release velocity (px/s, positive downward) from pointer samples: the movement over the last
 * ~100 ms before `now`. Holding still before letting go gives zero.
 */
export function releaseVelocity(samples: readonly { t: number; y: number }[], now: number, windowMs = 100): number {
  const last = samples[samples.length - 1]
  if (!last) return 0
  // Where the pointer was when the window began: the last sample at or before its start.
  let from = samples[0] as { t: number; y: number }
  for (const s of samples) {
    if (s.t <= now - windowMs) from = s
    else break
  }
  // Events delivered together can share a timestamp: moving in no time is a flick, not a stop.
  const dt = Math.max(1, now - from.t)
  return ((last.y - from.y) / dt) * 1000
}
