/**
 * Motion tokens for the sidebar, from feel.md FL-01 (response / damping ratio, mass 1):
 * snappy 0.25 s / 0.90, standard 0.32 s / 0.88, pop 0.30 s / 0.70.
 */
export const SNAPPY = { type: 'spring', stiffness: 632, damping: 45, mass: 1 } as const
export const STANDARD = { type: 'spring', stiffness: 386, damping: 35, mass: 1 } as const
export const POP = { type: 'spring', stiffness: 439, damping: 29, mass: 1 } as const
/** "quick" timing curve for exits and small fades (120–150 ms). */
export const QUICK_EASE: [number, number, number, number] = [0.2, 0, 0, 1]
/** "snappy" CSS-style fallback curve. */
export const SNAPPY_EASE: [number, number, number, number] = [0.2, 0.8, 0.2, 1]

export const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches
