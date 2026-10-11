import { classify, MomentumDetector, RELEASE_GAP_MS } from '../renderer/src/shell/spaces/physics'
import { HISTORY_SWIPE, type SwipeDirection } from '../shared/swipe'

export { RELEASE_GAP_MS }

export type SwipeUpdate =
  | { kind: 'move'; direction: SwipeDirection; travel: number }
  | { kind: 'end'; direction: SwipeDirection; commit: boolean }

/**
 * A two-finger horizontal swipe over the page (NV-02), from its wheel samples (DOM deltas: a negative
 * x scrolls toward the left, which goes back). It recognises a swipe by the Space swipe's own rules
 * (FL-13): the first 9 px decide the axis, and the fingers have lifted when no sample comes for
 * RELEASE_GAP_MS or the OS's momentum starts. A vertical scroll, or one the page takes, is left
 * alone until the fingers lift. While it tracks, `travel` is how far it has gone toward its side,
 * and it goes only if let go with the arrow fully in.
 */
export class HistorySwipe {
  private phase: 'undecided' | 'tracking' | 'ignored' | undefined
  private lastAt = Number.NEGATIVE_INFINITY
  private ax = 0
  private ay = 0
  private direction: SwipeDirection = 'back'
  private travel = 0
  private readonly momentum = new MomentumDetector()

  /** One sample at `t` (ms). `pageTakes(direction)`: the page scrolls that way, or uses the scroll. */
  push(dx: number, dy: number, t: number, pageTakes: (direction: SwipeDirection) => boolean): SwipeUpdate | undefined {
    // A sample after a pause starts a new gesture.
    const ended = t - this.lastAt > RELEASE_GAP_MS ? this.release() : undefined
    this.lastAt = t
    if (ended) return ended
    if (this.phase === 'ignored') return undefined
    if (this.phase === 'tracking') {
      if (this.momentum.push(dx, t)) {
        const end = this.release()
        this.phase = 'ignored'
        return end
      }
      if (pageTakes(this.direction)) {
        this.phase = 'ignored'
        return { kind: 'end', direction: this.direction, commit: false }
      }
      return this.move(dx)
    }
    this.phase = 'undecided'
    this.ax += dx
    this.ay += dy
    const axis = classify(this.ax, this.ay)
    if (!axis) return undefined
    if (axis === 'y') {
      this.phase = 'ignored'
      return undefined
    }
    this.direction = this.ax < 0 ? 'back' : 'forward'
    if (pageTakes(this.direction)) {
      this.phase = 'ignored'
      return undefined
    }
    this.phase = 'tracking'
    this.travel = 0
    return this.move(this.ax)
  }

  /** The fingers lifted: a tracked swipe ends, and goes if its arrow was fully in. */
  release(): SwipeUpdate | undefined {
    const tracked = this.phase === 'tracking'
    this.phase = undefined
    this.ax = 0
    this.ay = 0
    this.momentum.reset()
    if (!tracked) return undefined
    return { kind: 'end', direction: this.direction, commit: this.travel >= HISTORY_SWIPE.distance }
  }

  private move(dx: number): SwipeUpdate {
    this.travel = Math.max(0, this.travel + (this.direction === 'back' ? -dx : dx))
    return { kind: 'move', direction: this.direction, travel: this.travel }
  }
}

/**
 * Whether the page gets a swipe toward `direction`'s side first: the element under the pointer, or
 * one it sits in (its document's scrolling element included), can still scroll that way. The swipe
 * goes back or forward only at the edge, as Chromium's does.
 */
export function scrollsToward(target: EventTarget | null, direction: SwipeDirection): boolean {
  let node: Node | null = target instanceof Node ? target : null
  while (node) {
    if (node instanceof Element && canScrollX(node, direction)) return true
    node = node.parentNode ?? (node instanceof ShadowRoot ? node.host : null)
  }
  return false
}

function canScrollX(el: Element, direction: SwipeDirection): boolean {
  const max = el.scrollWidth - el.clientWidth
  if (max < 1) return false
  const style = getComputedStyle(el)
  const overflow = style.overflowX
  if (el === el.ownerDocument.scrollingElement) {
    if (overflow === 'hidden' || overflow === 'clip') return false
  } else if (overflow !== 'auto' && overflow !== 'scroll') return false
  // Right to left, `scrollLeft` runs from 0 (the start, at the right) down to -max.
  const fromLeft = style.direction === 'rtl' ? el.scrollLeft + max : el.scrollLeft
  return direction === 'back' ? fromLeft > 0.5 : fromLeft < max - 0.5
}
