/**
 * Orbit's motion tokens (feel.md FL-01): one set of springs and timing curves for every surface, so
 * the whole app moves like one object and a change here moves all of it. Springs drive motion's
 * animations and the hand-run ones (Space strip, split panes, drags, Peek, the media player); the
 * CSS fallbacks drive transitions and WAAPI. They live in shared code so main (window fades, the
 * player's glide) uses the same numbers; the renderer imports them through `renderer/src/motion`,
 * whose `motion.css` has them as custom properties (`--motion-*`, `--ease-*`). motion-tokens.test.ts
 * keeps the two in step.
 *
 * Springs are given as FL-01 does: response (s, the undamped period) and damping ratio, for mass 1.
 */

/** A spring for mass 1. */
export interface Spring {
  stiffness: number
  damping: number
  mass: 1
}

/** stiffness = (2π / response)², damping = 4π × ratio / response (FL-01). */
export function springFrom(response: number, ratio: number): Spring {
  return { stiffness: ((2 * Math.PI) / response) ** 2, damping: (4 * Math.PI * ratio) / response, mass: 1 }
}

/**
 * FL-01's springs.
 * - snappy (0.25 s / 0.90): list re-flow, row insert and remove, menus, folder reveal.
 * - standard (0.32 s / 0.88): sidebar show and hide, Space settle, split create, preview open.
 * - pop (0.30 s / 0.70): button release, tile add, toast in, badges. Small things only: it
 *   overshoots by about 4 %; structure (sidebar, card, panes, Space pages) never bounces.
 */
export const SPRING = {
  snappy: springFrom(0.25, 0.9),
  standard: springFrom(0.32, 0.88),
  pop: springFrom(0.3, 0.7),
} as const

/** The springs as motion transitions. */
export const SNAPPY = { type: 'spring', ...SPRING.snappy } as const
export const STANDARD = { type: 'spring', ...SPRING.standard } as const
export const POP = { type: 'spring', ...SPRING.pop } as const

export type Bezier = [number, number, number, number]

/** FL-01's CSS fallback curves. */
export const EASE = {
  /** Hover in, highlight on: ease-out. */
  instant: [0, 0, 0.58, 1] as Bezier,
  /** Hover out, small fades, most exits. */
  quick: [0.2, 0, 0, 1] as Bezier,
  snappy: [0.2, 0.8, 0.2, 1] as Bezier,
  standard: [0.2, 0.9, 0.1, 1] as Bezier,
  /** About 4 % overshoot, like the pop spring. */
  pop: [0.3, 1.35, 0.55, 1] as Bezier,
  /** Theme colour, mode cross-fades: ease-in-out. */
  gentle: [0.42, 0, 0.58, 1] as Bezier,
} as const

/** FL-01's CSS fallback durations (ms), each inside the spec's range. */
export const DURATION = {
  instant: 90, // 80–100 ms
  quick: 130, // 120–150 ms
  snappy: 200, // 180–220 ms
  standard: 270, // 250–300 ms
  pop: 240, // 220–260 ms
  gentle: 250, // 200–300 ms
} as const

export type Token = keyof typeof DURATION

/** Exits take about 0.7× their entrance (FL-01). */
export const EXIT_FACTOR = 0.7

/**
 * The snappy spring for exits: 0.7× its response, so a collapse settles about 0.7× as fast as the
 * expand (FL-12: about 150–180 ms). A spring rather than a curve, so collapsing mid-expand turns
 * around from the current speed (FL-01).
 */
export const SNAPPY_EXIT = { type: 'spring', ...springFrom(0.25 * EXIT_FACTOR, 0.9) } as const

/** A token's duration (ms), or its exit's. */
export function durationMs(token: Token, exit = false): number {
  return exit ? Math.round(DURATION[token] * EXIT_FACTOR) : DURATION[token]
}

/** `cubic-bezier(…)` for CSS and WAAPI. */
export const cubicBezier = (b: Bezier): string => `cubic-bezier(${b.join(', ')})`

/** A token as a motion tween (seconds). */
export function tween(token: Token, opts: { exit?: boolean; delay?: number } = {}) {
  return {
    duration: durationMs(token, opts.exit) / 1000,
    ease: [...EASE[token]] as Bezier,
    ...(opts.delay ? { delay: opts.delay } : {}),
  }
}

/**
 * One 60 Hz frame (s). An entrance timed from its first frame shows nothing in that frame when it
 * fades up from 0; starting it this far in shows it at once (FL-29: the first frame after the key).
 */
export const ONE_FRAME_S = 1 / 60

/**
 * Popovers (FL-25): open on the snappy curve in about 150 ms (fade and 0.97 → 1), a frame along so the
 * first frame drawn already shows them (ONE_FRAME_S); close with quick.
 */
export const POPOVER = {
  in: { duration: 0.15, ease: EASE.snappy, delay: -ONE_FRAME_S },
  out: tween('quick', { exit: true }),
} as const

/** A token as WAAPI timing (`element.animate(frames, waapi('quick'))`). */
export function waapi(token: Token, opts: { exit?: boolean } = {}): { duration: number; easing: string } {
  return { duration: durationMs(token, opts.exit), easing: cubicBezier(EASE[token]) }
}

/**
 * Reduced motion (FL-28): slides, flights and springs become a cross-fade of about 100–150 ms, and a
 * released drag or swipe settles with an ease-out of about 120 ms and no overshoot.
 */
export const REDUCED = {
  fadeMs: 120,
  settleMs: 120,
  settleEase: EASE.instant,
} as const

/** Reduced motion's settle for a released drag or swipe, as a motion tween. */
export const REDUCED_SETTLE = { duration: REDUCED.settleMs / 1000, ease: REDUCED.settleEase }
