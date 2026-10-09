/**
 * Peek card geometry, shared by the overlay (which draws and animates the card) and the main
 * process (which places the page view before the overlay's first frame arrives). All rects are in
 * page-area coordinates: the area the overlay covers while a Peek shows (the content frame).
 */

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
