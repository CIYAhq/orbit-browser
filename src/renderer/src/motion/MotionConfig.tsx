import { MotionConfig } from 'motion/react'
import type { ReactNode } from 'react'
import { useReducedMotion } from './reduced'

/**
 * motion's components under Orbit's reduced-motion rule (FL-28): the OS setting or Orbit's own
 * (`settings.reduceMotion`). With it, motion skips transform and layout animations (they land at
 * once) and keeps fades and colour changes. motion's own "user" mode reads only the OS setting.
 */
export function OrbitMotionConfig({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion()
  return <MotionConfig reducedMotion={reduced ? 'always' : 'never'}>{children}</MotionConfig>
}
