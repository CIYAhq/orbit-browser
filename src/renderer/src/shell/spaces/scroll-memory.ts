import type { SpaceId } from '../../../../shared/state'

/** Last scroll position of each Space's list in this window (SP-10), shared with the swipe previews. */
export const scrollMemory = new Map<SpaceId, number>()
