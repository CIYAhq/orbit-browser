/**
 * The two-finger swipe over a page (NV-02): its arrow follows the fingers 1:1 from the page card's
 * edge, and a swipe let go once the arrow is fully in goes back or forward.
 */
export const HISTORY_SWIPE = {
  /** Travel (px of scroll) that brings the arrow fully in. */
  distance: 112,
  /** The arrow's view: its circle and the room around it for the shadow. */
  size: 56,
  /** After a swipe ends, its arrow fades this long before main takes it away. */
  fadeMs: 160,
} as const

export type SwipeDirection = 'back' | 'forward'

/** What the arrow's view shows. */
export interface SwipeArrow {
  direction: SwipeDirection
  /** Fully in: letting go now goes. */
  armed: boolean
  /** The swipe ended: the arrow fades out. */
  done: boolean
}
