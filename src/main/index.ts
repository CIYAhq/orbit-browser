import { join } from 'node:path'
import { app } from 'electron'
import type { MainContext } from './context'
import { registerInternalScheme } from './devtools/internal-pages'
import { captureExternalLinks, registerExternalLinks } from './external-links'
import { registerFeatures } from './features'
import { registerIpc } from './ipc'
import { installMenu } from './menu'
import { Perf } from './perf'
import { loadState, Persistence } from './persist'
import { ActionRegistry, CommandRegistry, EventRegistry } from './registry'
import { Sessions } from './sessions'
import { startOnboarding } from './settings/onboarding'
import { applyStartupSwitches } from './settings/system'
import { Store } from './store'
import { TabRuntime } from './tabs/runtime'
import { exposeTestHooks } from './test-hooks'
import { WindowManager } from './windows'

const perf = new Perf()
perf.mark('main:start')

// An exception nothing caught is logged, and Orbit carries on. Electron's default shows it in a modal
// box that blocks the main thread until someone dismisses it: until then Orbit can't even quit (D28).
process.on('uncaughtException', (err) => console.error('[orbit] uncaught exception:', err))
// A promise rejection nothing handled is logged with the same marker, so the e2e quit check fails
// the test that caused it. Electron's default only prints a warning (PR #11 review F3).
process.on('unhandledRejection', (reason) =>
  console.error('[orbit] uncaught exception: (a promise rejection nothing handled)', reason),
)

// Tests and perf runs isolate their profile data.
if (process.env.ORBIT_USER_DATA) app.setPath('userData', process.env.ORBIT_USER_DATA)
const e2e = process.env.ORBIT_E2E === '1'
// Settings that only apply from start-up, such as graphics acceleration (ST-12).
applyStartupSwitches()

app.setName('Orbit')

if (!e2e && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  captureExternalLinks()
  // Before ready, and the app's only call to protocol.registerSchemesAsPrivileged (DT-13).
  registerInternalScheme()
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  void app.whenReady().then(start)
}

function start(): void {
  perf.mark('app:ready')
  const userData = app.getPath('userData')
  const stateFile = join(userData, 'orbit-state.json')
  const { state, firstRun } = loadState(stateFile)
  // Installs from before onboarding existed never set `onboarded`: they are not first runs (OB-01).
  // A first run records its step as soon as onboarding opens, so one quit part-way still resumes.
  if (!firstRun && !state.settings.onboarded && state.settings.onboardingStep === undefined) {
    state.settings.onboarded = true
  }
  perf.mark('state:loaded')
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
    toast: (windowId, message, action) => {
      const target = windowId ?? windows.focusedWindowId()
      if (target) windows.sendToWindow(target, 'toast', action ? { message, action } : { message })
    },
  }
  ctx.tabs.init(ctx)
  // PERF.md cold-start metric: when each tab's page first finishes loading.
  ctx.hooks.tabCreated.push((tabId, contents) => {
    contents.once('did-finish-load', () => perf.mark(`tab:${tabId}:loaded`))
  })
  windows.init(ctx)
  registerIpc(ctx)
  registerFeatures(ctx)
  perf.mark('features:registered')
  installMenu(ctx)
  perf.mark('menu:installed')
  if (e2e) exposeTestHooks(ctx, persistence)

  // Mini windows are transient; restore only main windows.
  const saved = Object.values(store.state.windows).filter((w) => w.kind === 'main')
  store.update((d) => {
    for (const w of Object.values(d.windows)) if (w.kind !== 'main') delete d.windows[w.id]
  })
  if (saved.length > 0) for (const w of saved) windows.open(store.state.windows[w.id])
  // A first run shows onboarding, which opens the first window when it is done (OB-01).
  else if (!startOnboarding()) windows.open()
  perf.mark('windows:opened')
  registerExternalLinks(ctx)

  app.on('activate', () => {
    if (windows.ids().length === 0 && !startOnboarding()) windows.open()
  })
  app.on('before-quit', (event) => {
    // A feature asking first (downloads in progress, DL-01) stopped this quit: nothing is quitting.
    if (event.defaultPrevented) return
    // The e2e harness times a quit from here: Playwright does work of its own before it asks (D28).
    if (e2e) console.error('[orbit] quit requested')
    windows.quitting = true
    persistence.flush()
  })
  app.on('will-quit', () => {
    persistence.dispose()
    if (process.env.ORBIT_PERF_LOG) perf.writeTo(process.env.ORBIT_PERF_LOG)
  })
}
