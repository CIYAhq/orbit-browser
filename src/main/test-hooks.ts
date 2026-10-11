import type { CommandName } from '../shared/rpc'
import type { MainContext } from './context'
import type { Persistence } from './persist'

/**
 * Test-only handle on the main process, exposed as globalThis.__orbit when
 * ORBIT_E2E=1. Playwright reaches it with electronApp.evaluate().
 */
export function exposeTestHooks(ctx: MainContext, persistence: Persistence): void {
  // Playwright's evaluate can run in the middle of other main-process code (the inspector
  // dispatches it by interrupt), even inside a store update whose result would then drop the
  // command's change. The e2e helpers defer every evaluate; this covers the perf and capture scripts.
  const later = <T>(fn: () => T | Promise<T>): Promise<T> => new Promise<void>((r) => setImmediate(r)).then(fn)
  const hooks = {
    ctx,
    state: () => ctx.store.state,
    run: (name: CommandName, args: unknown, windowId?: string) =>
      later(() => ctx.commands.run(name, args as never, { windowId })),
    action: (id: string, windowId?: string) => later(() => ctx.actions.run(id, { windowId })),
    /** Writes the state file in a task of its own: the write clears its timer, never to be done by interrupt. */
    flush: () => later(() => persistence.flush()),
    /** Writes it in the calling task, for a caller already in a task of its own (the e2e evaluate) that checks the state first. */
    flushNow: () => persistence.flush(),
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
