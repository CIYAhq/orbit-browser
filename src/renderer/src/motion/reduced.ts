import { useSyncExternalStore } from 'react'
import { useMirror } from '../store'

/**
 * Reduced motion (FL-28, AP-17): on when the OS asks for it (Reduce Motion on macOS, animation
 * effects off on Windows, the GTK/desktop animation setting on Linux; pages see it as
 * `prefers-reduced-motion: reduce`) or when Orbit's own setting forces it (`settings.reduceMotion`).
 *
 * Every renderer follows both from start-up (`installReducedMotion`, called by main.tsx): scripts
 * ask `reducedMotion()` or `useReducedMotion()`, and CSS keys its reduced rules off the
 * `reduce-motion` class this puts on the root element, never off the media query alone.
 */
const query = typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)') : undefined
let forced = false
let current = !!query?.matches
const listeners = new Set<() => void>()

/** Reduced motion is on now. */
export function reducedMotion(): boolean {
  return forced || !!query?.matches
}

/** Calls `fn` whenever reduced motion turns on or off. Returns the unsubscribe. */
export function onReducedMotion(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Reduced motion, re-rendering when it changes (the OS setting or Orbit's). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(onReducedMotion, reducedMotion)
}

function refresh(): void {
  const now = reducedMotion()
  document.documentElement.classList.toggle('reduce-motion', now)
  if (now === current) return
  current = now
  for (const fn of listeners) fn()
}

let installed = false

/** Follows the OS setting and `settings.reduceMotion` in this renderer. Idempotent. */
export function installReducedMotion(): void {
  if (installed) return
  installed = true
  query?.addEventListener('change', refresh)
  const read = () => !!useMirror.getState().state?.settings?.reduceMotion
  forced = read()
  useMirror.subscribe(() => {
    const next = read()
    if (next === forced) return
    forced = next
    refresh()
  })
  refresh()
}
