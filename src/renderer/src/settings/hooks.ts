import { useEffect, useReducer, useState } from 'react'

/**
 * Reads something main doesn't keep in state again whenever Settings comes to the front or main says
 * it changed (`settings.refresh`): the user may have changed it outside Orbit.
 */
export function useMainValue<T>(read: () => Promise<T>): [T | undefined, (value: T) => void] {
  const [value, setValue] = useState<T>()
  // biome-ignore lint/correctness/useExhaustiveDependencies: `read` is fixed per caller
  useEffect(() => {
    let live = true
    const load = () => void read().then((v) => live && setValue(v))
    load()
    const off = window.orbit.on('settings.refresh', load)
    window.addEventListener('focus', load)
    return () => {
      live = false
      off()
      window.removeEventListener('focus', load)
    }
  }, [])
  return [value, setValue]
}

/** Draws the component again whenever Settings comes to the front (for texts like "5 minutes ago"). */
export function useRedrawOnFocus(): void {
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    window.addEventListener('focus', redraw)
    return () => window.removeEventListener('focus', redraw)
  }, [])
}
