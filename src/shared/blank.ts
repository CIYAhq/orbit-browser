/**
 * Blank windows (TB-17, NV-10, SP-24): a window with a sidebar of its own that starts empty, for
 * throwaway browsing. Like a private window it shows a Space of its own, kept out of the Space
 * order (`Space.blank`), so it lists no other Space, pinned tab or Favorite and no other window
 * lists its tabs. Unlike one, its profile is an ordinary one and it is kept: open at quit, it comes
 * back after a relaunch. When it closes, its Space goes and its tabs go to the Archive.
 */
import type { OrbitState, SpaceId, WindowId } from './state'

export function isBlankSpace(state: OrbitState, spaceId: SpaceId | undefined): boolean {
  return !!spaceId && state.spaces[spaceId]?.blank === true
}

export function isBlankWindow(state: OrbitState, windowId: WindowId | undefined): boolean {
  const win = windowId ? state.windows[windowId] : undefined
  return !!win && isBlankSpace(state, win.spaceId)
}
