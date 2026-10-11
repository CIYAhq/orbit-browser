import { useCallback, useEffect, useRef, useState } from 'react'
import type { TweakStyle } from '../../../shared/state'
import type { TweakPatch } from '../../../shared/tweaks'
import { invoke } from '../api'

/** Sends an edit of a Tweak to main, which saves it and applies it to the page at once (BO-02). */
export function updateTweak(id: string, patch: TweakPatch): void {
  void invoke('tweaks.update', { id, patch })
}

/** Edits still waiting to be sent (typed code, BO-11), by whoever holds them. */
const waiting = new Set<() => void>()

/** Lets an editor's waiting edits be sent on demand; returns the way to stop. */
export function holdEdits(flush: () => void): () => void {
  waiting.add(flush)
  return () => waiting.delete(flush)
}

/**
 * Sends every edit still waiting, first: main handles the panel's messages in order, so the
 * close or the run that follows sees the code as typed.
 */
export function flushTweakEdits(): void {
  for (const flush of waiting) flush()
}

export type StyleEdit = Partial<Omit<TweakStyle, 'hidden'>>

/**
 * Style edits made at pointer speed (the wheel and sliders, BO-03, BO-05), sent at most once a frame:
 * the page recolours as the control moves, and main gets no more than it can show.
 */
export function useStyleEdits(id: string): (style: StyleEdit) => void {
  const pending = useRef<StyleEdit | null>(null)
  const frame = useRef(0)
  const flush = useCallback(() => {
    if (frame.current) cancelAnimationFrame(frame.current)
    frame.current = 0
    const style = pending.current
    pending.current = null
    if (style) updateTweak(id, { style })
  }, [id])
  useEffect(() => {
    const release = holdEdits(flush)
    return () => {
      release()
      flush()
    }
  }, [flush])
  return useCallback(
    (style: StyleEdit) => {
      pending.current = { ...pending.current, ...style }
      if (!frame.current) frame.current = requestAnimationFrame(flush)
    },
    [flush],
  )
}

/** How long a control keeps showing its own value when main never says it back (clamped, or changed elsewhere). */
const LIVE_HOLD_MS = 600

/**
 * A control's value while the user moves it: its own, until the saved value catches up, so the
 * control never steps back to an older value on its way.
 */
export function useLiveValue<T>(saved: T, same: (a: T, b: T) => boolean): [T, (value: T) => void] {
  const [local, setLocal] = useState<{ value: T } | null>(null)
  useEffect(() => {
    if (local && same(local.value, saved)) setLocal(null)
  }, [local, saved, same])
  useEffect(() => {
    if (!local) return
    const timer = window.setTimeout(() => setLocal(null), LIVE_HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [local])
  return [local ? local.value : saved, useCallback((value: T) => setLocal({ value }), [])]
}
