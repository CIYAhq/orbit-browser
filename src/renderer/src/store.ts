import { applyPatches, enablePatches, type Patch } from 'immer'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type { OrbitState } from '../../shared/state'

enablePatches()

interface Mirror {
  state: OrbitState
  seq: number
}

/**
 * Read-only mirror of the main process state. Updated by patch batches; on a
 * sequence gap it refetches a full snapshot.
 */
export const useMirror = create<Mirror>(() => ({ state: undefined as unknown as OrbitState, seq: 0 }))

export async function initStore(): Promise<void> {
  const early: { seq: number; patches: Patch[] }[] = []
  let ready = false
  window.orbit.onPatches((seq, patches) => {
    if (!ready) {
      early.push({ seq, patches: patches as Patch[] })
      return
    }
    applyBatch(seq, patches as Patch[])
  })
  const snap = await window.orbit.getState()
  useMirror.setState({ state: snap.state, seq: snap.seq })
  ready = true
  for (const batch of early) applyBatch(batch.seq, batch.patches)
}

function applyBatch(seq: number, patches: Patch[]): void {
  const current = useMirror.getState()
  if (seq <= current.seq) return
  if (seq !== current.seq + 1) {
    void resync()
    return
  }
  useMirror.setState({ state: applyPatches(current.state, patches), seq })
}

async function resync(): Promise<void> {
  const snap = await window.orbit.getState()
  useMirror.setState({ state: snap.state, seq: snap.seq })
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
