import { useCallback, useEffect, useReducer, useState } from 'react'

type Read = () => Promise<unknown>

/** The reads Settings does before its first paint (`readEarly`), and the last value each gave. */
const earlyReads = new Set<Read>()
const lastRead = new Map<Read, unknown>()
/** How long Settings' first paint waits for its early reads, at most: then it paints without them. */
const EARLY_WAIT_MS = 200

/**
 * Marks a read of something main doesn't keep in state as one Settings does before its first paint
 * (boot.tsx): the row that shows it draws it in its first frame, so nothing below the row moves when
 * it comes (ST-03's default browser line). Quick reads only: the window waits for them, up to
 * EARLY_WAIT_MS.
 */
export function readEarly<T>(read: () => Promise<T>): () => Promise<T> {
  earlyReads.add(read)
  return read
}

function remember(read: Read, value: unknown): void {
  if (earlyReads.has(read)) lastRead.set(read, value)
}

/** Settings' early reads (`readEarly`), all at once; one that fails or is late is read by its row. */
export async function readEarlyValues(): Promise<void> {
  const reads = [...earlyReads].map((read) =>
    read().then(
      (value) => remember(read, value),
      () => {},
    ),
  )
  await Promise.race([Promise.all(reads), new Promise((done) => setTimeout(done, EARLY_WAIT_MS))])
}

/**
 * Reads something main doesn't keep in state when its row mounts, and again whenever Settings comes
 * to the front or main says it changed (`settings.refresh`): the user may have changed it outside
 * Orbit. An early read's row starts from its last value (`readEarly`), including one the row set.
 */
export function useMainValue<T>(read: () => Promise<T>): [T | undefined, (value: T) => void] {
  const [value, setValue] = useState<T | undefined>(() => lastRead.get(read) as T | undefined)
  const set = useCallback(
    (v: T) => {
      remember(read, v)
      setValue(v)
    },
    [read],
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: `read` is fixed per caller
  useEffect(() => {
    let live = true
    const load = () =>
      void read().then((v) => {
        remember(read, v)
        if (live) setValue(v)
      })
    load()
    const off = window.orbit.on('settings.refresh', load)
    window.addEventListener('focus', load)
    return () => {
      live = false
      off()
      window.removeEventListener('focus', load)
    }
  }, [])
  return [value, set]
}

/** Draws the component again whenever Settings comes to the front (for texts like "5 minutes ago"). */
export function useRedrawOnFocus(): void {
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    window.addEventListener('focus', redraw)
    return () => window.removeEventListener('focus', redraw)
  }, [])
}
