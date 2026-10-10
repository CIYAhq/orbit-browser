import { ipcMain } from 'electron'
import type { CommandName, EventName, OrbitEvents } from '../shared/rpc'
import type { MainContext } from './context'

/**
 * Wires renderer IPC to the command/event registries and broadcasts state
 * patches. Only Orbit's own UI web contents may call in; web pages have no
 * preload and are rejected here as well.
 */
export function registerIpc(ctx: MainContext): void {
  ipcMain.handle('orbit:invoke', async (event, name: CommandName, args: unknown) => {
    if (!ctx.windows.isUi(event.sender)) throw new Error('Forbidden')
    const windowId = ctx.windows.windowIdFor(event.sender)
    return ctx.commands.run(name, args as never, { windowId, sender: event.sender })
  })

  ipcMain.on('orbit:send', (event, name: EventName, payload: OrbitEvents[EventName]) => {
    if (!ctx.windows.isUi(event.sender)) return
    const windowId = ctx.windows.windowIdFor(event.sender)
    if (name === 'perf.mark') ctx.perf.mark((payload as OrbitEvents['perf.mark']).name)
    ctx.events.emit(name, payload, { windowId })
  })

  ipcMain.handle('orbit:getState', (event) => {
    if (!ctx.windows.isUi(event.sender)) throw new Error('Forbidden')
    return ctx.store.snapshot()
  })

  ctx.store.subscribeBatches((seq, patches) => ctx.windows.broadcast('orbit:patches', seq, patches))
}
