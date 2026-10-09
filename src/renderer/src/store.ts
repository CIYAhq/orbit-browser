import { enablePatches, type Patch } from 'immer'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type { OrbitState } from '../../shared/state'
import { MirrorSync } from './mirror-sync'

enablePatches()

interface Mirror {
  state: OrbitState
  seq: number
}

/**
 * Read-only mirror of the main process state. Updated by patch batches; on a
 * sequence gap or a batch that fails to apply it refetches one snapshot and
 * replays the batches that arrived meanwhile (see MirrorSync).
 */
export const useMirror = create<Mirror>(() => ({ state: undefined as unknown as OrbitState, seq: 0 }))

const sync = new MirrorSync<OrbitState>(
  () => {
    const m = useMirror.getState()
    return m.state ? m : undefined
  },
  (snap) => useMirror.setState({ state: snap.state, seq: snap.seq }),
  () => window.orbit.getState(),
)

// Read-only diagnostics for tests and debugging (Orbit UI pages only; web pages never load this).
;(globalThis as unknown as { __orbitMirror: unknown }).__orbitMirror = {
  resyncs: () => sync.resyncs,
  seq: () => useMirror.getState().seq,
}

export async function initStore(): Promise<void> {
  const first = sync.start()
  window.orbit.onPatches((seq, patches) => sync.receive(seq, patches as Patch[]))
  await first
}

/** Subscribe to a slice of state (re-renders when the selected value changes by identity). */
export function useOrbit<T>(selector: (state: OrbitState) => T): T {
  return useMirror((m) => selector(m.state))
}

/** Like useOrbit but compares arrays/objects shallowly (for derived lists). */
export function useOrbitShallow<T>(selector: (state: OrbitState) => T): T {
  return useMirror(useShallow((m: Mirror) => selector(m.state)))
}

export const getOrbitState = (): OrbitState => useMirror.getState().state
export const getSeq = (): number => useMirror.getState().seq

/** The window this renderer belongs to. */
export function useWindow() {
  return useOrbit((s) => s.windows[window.orbit.windowId])
}
