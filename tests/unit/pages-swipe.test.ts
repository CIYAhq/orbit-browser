import { describe, expect, it } from 'vitest'
import { HistorySwipe, RELEASE_GAP_MS, type SwipeUpdate } from '../../src/preload/swipe'
import { HISTORY_SWIPE } from '../../src/shared/swipe'

/** Feeds `deltas` (x, or [x, y]) 16 ms apart from `t0`; returns every update and the last time. */
function feed(
  swipe: HistorySwipe,
  deltas: (number | [number, number])[],
  pageTakes: () => boolean = () => false,
  t0 = 1000,
) {
  const updates: SwipeUpdate[] = []
  let t = t0
  for (const d of deltas) {
    const [dx, dy] = typeof d === 'number' ? [d, 0] : d
    const update = swipe.push(dx, dy, t, pageTakes)
    if (update) updates.push(update)
    t += 16
  }
  return { updates, t }
}

const { distance } = HISTORY_SWIPE

describe('[NV-02] a two-finger swipe over the page', () => {
  it('is a swipe back once it has gone 9 px toward the left, and follows the fingers 1:1', () => {
    const swipe = new HistorySwipe()
    const { updates } = feed(swipe, [-4, -4, -4, -10])
    expect(updates).toEqual([
      { kind: 'move', direction: 'back', travel: 12 },
      { kind: 'move', direction: 'back', travel: 22 },
    ])
  })

  it('goes only if let go with the arrow fully in', () => {
    const short = new HistorySwipe()
    feed(short, Array(5).fill(-20))
    expect(short.release()).toEqual({ kind: 'end', direction: 'back', commit: false })

    const full = new HistorySwipe()
    const { updates } = feed(full, Array(6).fill(-20))
    expect(updates.at(-1)).toEqual({ kind: 'move', direction: 'back', travel: 120 })
    expect(120).toBeGreaterThanOrEqual(distance)
    expect(full.release()).toEqual({ kind: 'end', direction: 'back', commit: true })
  })

  it('toward the right is forward; turning back takes the arrow back, never past its edge', () => {
    const swipe = new HistorySwipe()
    const { updates } = feed(swipe, [10, 30, -50, 5])
    expect(updates.map((u) => (u.kind === 'move' ? u.travel : u))).toEqual([10, 40, 0, 5])
    expect(updates[0]).toMatchObject({ direction: 'forward' })
  })

  it('leaves a vertical scroll alone until the fingers lift', () => {
    const swipe = new HistorySwipe()
    const { updates } = feed(swipe, [
      [0, 6],
      [-2, 6],
      [-40, 0],
      [-40, 0],
    ])
    expect(updates).toEqual([])
    expect(swipe.release()).toBeUndefined()
  })

  it('leaves the page a swipe it takes: from the start, or as soon as it does', () => {
    const taken = new HistorySwipe()
    expect(feed(taken, Array(6).fill(-20), () => true).updates).toEqual([])
    expect(taken.release()).toBeUndefined()

    let takes = false
    const later = new HistorySwipe()
    const first = feed(later, Array(3).fill(-20), () => takes)
    expect(first.updates.at(-1)).toEqual({ kind: 'move', direction: 'back', travel: 60 })
    takes = true
    expect(feed(later, Array(4).fill(-20), () => takes, first.t).updates).toEqual([
      { kind: 'end', direction: 'back', commit: false },
    ])
  })

  it('ends when the OS momentum starts after the fingers lift; the rest of it moves nothing', () => {
    const swipe = new HistorySwipe()
    const fingers = feed(swipe, Array(4).fill(-20))
    // Momentum: deltas that fall by the same share at the display's pace.
    const momentum = Array.from({ length: 12 }, (_, i) => -Math.round(30 * 0.9 ** i * 100) / 100)
    const { updates } = feed(swipe, momentum, () => false, fingers.t)
    const end = updates.findIndex((u) => u.kind === 'end')
    expect(end).toBeGreaterThan(0)
    expect(updates[end]).toEqual({ kind: 'end', direction: 'back', commit: true })
    expect(updates.slice(end + 1)).toEqual([])
  })

  it('a sample after a pause starts a new swipe, ending one the fingers left', () => {
    const swipe = new HistorySwipe()
    const { t } = feed(swipe, Array(3).fill(-20))
    expect(swipe.push(-20, 0, t + RELEASE_GAP_MS + 1, () => false)).toEqual({
      kind: 'end',
      direction: 'back',
      commit: false,
    })
    expect(feed(swipe, [20, 20], () => false, t + RELEASE_GAP_MS + 20).updates).toEqual([
      { kind: 'move', direction: 'forward', travel: 20 },
      { kind: 'move', direction: 'forward', travel: 40 },
    ])
  })
})
