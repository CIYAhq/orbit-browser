import { useSyncExternalStore } from 'react'
import type { SpaceId } from '../../../../shared/state'

/**
 * A pending "rename this Space" request (Space menu → Rename, command bar →
 * Rename Space). Kept until the title row of that Space consumes it, so a
 * request that arrives together with a switch to that Space is never lost
 * (review M7).
 */
let pending: SpaceId | null = null
const listeners = new Set<() => void>()

export function requestRename(spaceId: SpaceId): void {
  pending = spaceId
  for (const listener of listeners) listener()
}

export function consumeRename(spaceId: SpaceId): boolean {
  if (pending !== spaceId) return false
  pending = null
  return true
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The Space whose rename is pending, if any. */
export function usePendingRename(): SpaceId | null {
  return useSyncExternalStore(subscribe, () => pending)
}
