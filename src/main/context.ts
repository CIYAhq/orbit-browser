import type {
  ContextMenuParams,
  HandlerDetails,
  MenuItemConstructorOptions,
  WebContents,
  WebFrameMain,
  WindowOpenHandlerResponse,
} from 'electron'
import type { OrbitState, TabId, WindowId } from '../shared/state'
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
  /** Extra items at the top of a page's right-click menu (e.g. Picture in Picture on a video, MD-02). */
  pageContextMenu?: ((tabId: TabId, contents: WebContents, params: ContextMenuParams) => MenuItemConstructorOptions[])[]
  /**
   * A tab's frame is about to get the screen or window the user chose to share (MD-11). The stream
   * goes to the page once these have settled.
   */
  screenShare?: ((tabId: TabId, contents: WebContents, frame: WebFrameMain) => Promise<void>)[]
  /**
   * The command bar chose an open tab to switch to. A hook that takes the choice (a pane being filled,
   * SV-02) carries it out in one store update that also runs `closeBar`, and returns true; the bar
   * then does nothing more. Otherwise the bar closes and selects the tab.
   */
  barChoice?: ((windowId: WindowId, tabId: TabId, closeBar: (d: OrbitState) => void) => boolean)[]
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
