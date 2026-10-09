import type { OrbitState, SpaceId } from './state'

/** "Space N", where N is the Space's position or the next number no other Space uses (SP-02). */
export function placeholderName(state: OrbitState, position: number, exceptId?: SpaceId): string {
  const taken = new Set(
    Object.values(state.spaces)
      .filter((s) => s.id !== exceptId)
      .map((s) => s.name),
  )
  let n = Math.max(1, Math.round(position))
  while (taken.has(`Space ${n}`)) n++
  return `Space ${n}`
}
