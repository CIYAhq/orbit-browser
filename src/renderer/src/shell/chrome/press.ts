import { prefersReducedMotion } from '../../theme'

/** "snappy" curve from FL-01 (CSS fallback). */
const SNAPPY_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

/**
 * A button glyph's small press animation (FL-15): Back nudges about 3 px left, Forward right
 * (180 ms); Reload's glyph turns once (260 ms). Runs alongside the action, never before it, and a
 * repeated press restarts it instead of queueing. Decorative, so off with reduced motion.
 */
export function playPress(button: HTMLElement | null, kind: 'back' | 'forward' | 'reload'): void {
  const glyph = button?.querySelector('svg')
  if (!glyph || prefersReducedMotion()) return
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
