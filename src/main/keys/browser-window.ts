import type { WindowId } from '../../shared/state'
import type { MainContext } from '../context'

/**
 * The browser window an action asked from `from` acts in (OB-12, KS-12): that window, or for
 * Settings or a Mini Window the browser window they belong to or the last one used; with none
 * open, a new one.
 */
export function browserWindowFor(ctx: MainContext, from: WindowId | undefined): WindowId {
  const { store, windows } = ctx
  const isBrowser = (id: WindowId | undefined): id is WindowId =>
    !!id && !!windows.get(id) && !!store.state.windows[id] && store.state.windows[id]?.kind !== 'mini'
  return isBrowser(from) ? from : (windows.ids().filter(isBrowser).at(-1) ?? windows.open())
}
