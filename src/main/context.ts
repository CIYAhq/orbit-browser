import type { HandlerDetails, WebContents, WindowOpenHandlerResponse } from 'electron'
import type { TabId } from '../shared/state'
import type { Perf } from './perf'
import type { ActionRegistry, CommandRegistry, EventRegistry } from './registry'
import type { Sessions } from './sessions'
import type { Store } from './store'
import type { TabRuntime } from './tabs/runtime'
import type { WindowManager } from './windows'

/**
 * Hook points that later features plug into without editing core files.
 * Return a response to take over a window.open/link; return undefined to pass.
 */
export interface Hooks {
  windowOpen: ((openerTabId: TabId, details: HandlerDetails) => WindowOpenHandlerResponse | undefined)[]
  /** Called once per live tab web contents after Orbit wires its own listeners. */
  tabCreated: ((tabId: TabId, contents: WebContents) => void)[]
  /** Called when a tab's main frame finished a navigation (url committed). */
  tabNavigated: ((tabId: TabId, contents: WebContents, url: string) => void)[]
}

/** Everything a feature module needs. Passed to each module's register(). */
export interface MainContext {
  store: Store
  commands: CommandRegistry
  events: EventRegistry
  actions: ActionRegistry
  sessions: Sessions
  tabs: TabRuntime
  windows: WindowManager
  hooks: Hooks
  perf: Perf
  paths: { userData: string; stateFile: string }
  /** True when running under the end-to-end test harness. */
  e2e: boolean
  /** Shows a short confirmation message in a window (e.g. "Copied URL"). */
  toast(windowId: string | undefined, message: string): void
}
