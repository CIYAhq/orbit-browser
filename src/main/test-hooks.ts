import type { CommandName } from '../shared/rpc'
import type { MainContext } from './context'
import type { Persistence } from './persist'

/**
 * Test-only handle on the main process, exposed as globalThis.__orbit when
 * ORBIT_E2E=1. Playwright reaches it with electronApp.evaluate().
 */
export function exposeTestHooks(ctx: MainContext, persistence: Persistence): void {
  const hooks = {
    ctx,
    state: () => ctx.store.state,
    run: (name: CommandName, args: unknown, windowId?: string) => ctx.commands.run(name, args as never, { windowId }),
    action: (id: string, windowId?: string) => ctx.actions.run(id, { windowId }),
    flush: () => persistence.flush(),
    marks: () => ctx.perf.marks,
    windowIds: () => ctx.windows.ids(),
    liveTabs: () => ctx.tabs.liveTabIds(),
    tabView: (tabId: string) => {
      const view = ctx.tabs.get(tabId)
      if (!view?.webContents || view.webContents.isDestroyed()) return null
      return { bounds: view.getBounds(), visible: view.getVisible(), url: view.webContents.getURL() }
    },
  }
  ;(globalThis as unknown as { __orbit: typeof hooks }).__orbit = hooks
}
