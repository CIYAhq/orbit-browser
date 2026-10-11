import { systemPreferences } from 'electron'
import type { MainContext } from './context'

/**
 * Reduced motion (FL-28, AP-17) as main sees it: on when the OS asks for it or Orbit's own setting
 * forces it. Electron reads the OS setting per platform: Reduce Motion on macOS, animation effects
 * off on Windows, the GTK animation setting on Linux (and Chromium's force switches). Main's own
 * motion (Mini Window fades, the floating player's flights) asks this each time it would animate;
 * renderers follow the same two signals themselves (src/renderer/src/motion/reduced.ts).
 */
export function reducedMotion(ctx: Pick<MainContext, 'store'>): boolean {
  if (ctx.store.state.settings.reduceMotion) return true
  try {
    return systemPreferences.getAnimationSettings().prefersReducedMotion
  } catch {
    return false
  }
}

/** The command bar's "Toggle Reduce Motion" (FL-28): Orbit's setting, on or off. */
export function registerMotion(ctx: MainContext): void {
  const { actions, store } = ctx
  actions.register('app.toggleReduceMotion', () =>
    store.update((d) => {
      d.settings.reduceMotion = !d.settings.reduceMotion
    }),
  )
}
