import { createWindowState } from '../../shared/defaults'
import { isPrivateWindow } from '../../shared/private'
import type { SpaceId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import type { TabOps, TabPage } from '../tabs/ops'

/**
 * A normal window showing `url` in a new tab at the top of Today (⇧-click, "Open Link in New
 * Window"; NV-08, NV-12). It shows the Space of the window the link came from, a step down and
 * right of it, in full screen when that one is (NV-10). Every normal window lists the same tabs
 * (TB-17), so the tab is in the other windows' sidebars too, shown only here. `page` is how the tab
 * gets its page, when not by loading the URL as typed (review B-F1).
 */
export function openUrlInNewWindow(
  ctx: MainContext,
  ops: TabOps,
  url: string,
  fromWindowId: WindowId | undefined,
  page: TabPage = {},
): WindowId | null {
  const { store, windows } = ctx
  const state = store.state
  const from = fromWindowId ? state.windows[fromWindowId] : undefined
  const spaceId: SpaceId | undefined =
    from && from.kind === 'main' && !isPrivateWindow(state, from.id) && state.spaces[from.spaceId]
      ? from.spaceId
      : (Object.values(state.windows).find((w) => w.kind === 'main' && !isPrivateWindow(state, w.id))?.spaceId ??
        state.spaceOrder[0])
  if (!spaceId) return null
  const winState = createWindowState(spaceId)
  winState.bounds = windows.cascadeFrom(fromWindowId)
  store.update((d) => {
    d.windows[winState.id] = winState
  })
  ops.createTab({ url, spaceId, windowId: winState.id, activate: true, ...page })
  const created = store.state.windows[winState.id]
  if (!created) return null
  const id = windows.open(created)
  const source = fromWindowId ? windows.get(fromWindowId) : undefined
  if (source && !source.isDestroyed() && source.isFullScreen()) windows.get(id)?.setFullScreen(true)
  return id
}
