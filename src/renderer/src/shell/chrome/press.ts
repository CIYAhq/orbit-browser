import { cubicBezier, EASE, reducedMotion } from '../../motion'

const SNAPPY_EASE = cubicBezier(EASE.snappy)

/**
 * A button glyph's small press animation (FL-15): Back nudges about 3 px left, Forward right
 * (180 ms); Reload's glyph turns once (260 ms). FL-15's own timings, on the snappy curve. Runs
 * alongside the action, never before it, and a repeated press restarts it instead of queueing.
 * Decorative, so off with reduced motion.
 */
export function playPress(button: HTMLElement | null, kind: 'back' | 'forward' | 'reload'): void {
  const glyph = button?.querySelector('svg')
  if (!glyph || reducedMotion()) return
  for (const running of glyph.getAnimations()) running.cancel()
  if (kind === 'reload') {
    glyph.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], {
      duration: 260,
      easing: SNAPPY_EASE,
    })
    return
  }
  const dx = kind === 'back' ? -3 : 3
  glyph.animate(
    [{ transform: 'translateX(0)' }, { transform: `translateX(${dx}px)`, offset: 0.4 }, { transform: 'translateX(0)' }],
    { duration: 180, easing: SNAPPY_EASE },
  )
}
