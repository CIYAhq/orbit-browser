import { join } from 'node:path'
import { app } from 'electron'
import type { MainContext } from './context'
import { registerFeatures } from './features'
import { registerIpc } from './ipc'
import { installMenu } from './menu'
import { Perf } from './perf'
import { loadState, Persistence } from './persist'
import { ActionRegistry, CommandRegistry, EventRegistry } from './registry'
import { Sessions } from './sessions'
import { Store } from './store'
import { TabRuntime } from './tabs/runtime'
import { exposeTestHooks } from './test-hooks'
import { WindowManager } from './windows'

const perf = new Perf()
perf.mark('main:start')

// Tests and perf runs isolate their profile data.
if (process.env.ORBIT_USER_DATA) app.setPath('userData', process.env.ORBIT_USER_DATA)
const e2e = process.env.ORBIT_E2E === '1'

app.setName('Orbit')

if (!e2e && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  void app.whenReady().then(start)
}

function start(): void {
  perf.mark('app:ready')
  const userData = app.getPath('userData')
  const stateFile = join(userData, 'orbit-state.json')
  const { state } = loadState(stateFile)
  const store = new Store(state)
  const persistence = new Persistence(store, stateFile)
  const windows = new WindowManager()
  const ctx: MainContext = {
    store,
    commands: new CommandRegistry(),
    events: new EventRegistry(),
    actions: new ActionRegistry(),
    sessions: new Sessions(store),
    tabs: new TabRuntime(),
    windows,
    hooks: { windowOpen: [], tabCreated: [], tabNavigated: [] },
    perf,
    paths: { userData, stateFile },
    e2e,
    toast: (windowId, message) => {
      const target = windowId ?? windows.focusedWindowId()
      if (target) windows.sendToWindow(target, 'toast', { message })
    },
  }
  ctx.tabs.init(ctx)
  windows.init(ctx)
  registerIpc(ctx)
  registerFeatures(ctx)
  installMenu(ctx)
  if (e2e) exposeTestHooks(ctx, persistence)

  // Mini windows are transient; restore only main windows.
  const saved = Object.values(store.state.windows).filter((w) => w.kind === 'main')
  store.update((d) => {
    for (const w of Object.values(d.windows)) if (w.kind !== 'main') delete d.windows[w.id]
  })
  if (saved.length > 0) for (const w of saved) windows.open(store.state.windows[w.id])
  else windows.open()
  perf.mark('windows:opened')

  app.on('activate', () => {
    if (windows.ids().length === 0) windows.open()
  })
  app.on('before-quit', () => {
    windows.quitting = true
    persistence.flush()
  })
  app.on('will-quit', () => {
    persistence.dispose()
    if (process.env.ORBIT_PERF_LOG) perf.writeTo(process.env.ORBIT_PERF_LOG)
  })
}
