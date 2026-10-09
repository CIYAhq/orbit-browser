import type { OrbitState, TabId } from '../../shared/state'

export const windowId = (): string => window.orbit.windowId

export function activeTabId(state: OrbitState, winId: string = windowId()): TabId | null {
  const win = state.windows[winId]
  if (!win) return null
  const id = win.activeTab[win.spaceId] ?? null
  return id && state.tabs[id] ? id : null
}
