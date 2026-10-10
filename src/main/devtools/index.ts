import { BrowserWindow, type WebContents, webContents } from 'electron'
import type { TabId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import type { CallContext } from '../registry'
import { activeTabOf, shownTabs } from '../windows'
import { DEVTOOLS_ACTIONS, devtoolsState, installKeys, openDevtools, runDevtoolsAction } from './control'
import { inFrontend, SYNC_DOCKED_SIZE, showPanel } from './frontend'

/**
 * DevTools (DT-01 to DT-03): the engine's DevTools for the selected tab or focused split pane,
 * docked inside the page's view or undocked; Inspect from the page's menu (the engine's
 * `inspectElement`) and the element picker. Hard reload (DT-14) is the navigation action
 * `nav.hardReload`. Peeks and Mini Windows run the same actions on their own page (page-actions).
 */
export function registerDevtools(ctx: MainContext): void {
  const { actions, commands, hooks, store, tabs, windows } = ctx

  /** The page a command or key is about: the given tab, else the window's selected tab or pane. */
  const pageOf = (c: CallContext, tabId?: TabId): WebContents | undefined => {
    const windowId: WindowId | undefined = c.windowId ?? windows.focusedWindowId()
    const id = tabId ?? (windowId ? activeTabOf(store.state, windowId) : null)
    const contents = id ? tabs.contents(id) : undefined
    return contents && !contents.isDestroyed() ? contents : undefined
  }

  // A key held down acts once: holding F12 opens DevTools and nothing more (DT-01). This runs
  // before Peeks and Mini Windows take these keys for their own page.
  actions.intercept((id, c) => c.repeat === true && DEVTOOLS_ACTIONS.has(id))
  for (const id of DEVTOOLS_ACTIONS) {
    actions.register(id, (c) => {
      const contents = pageOf(c)
      if (contents) runDevtoolsAction(id, contents)
    })
  }

  commands.register('devtools.open', async ({ tabId, panel }, c) => {
    const contents = pageOf(c, tabId)
    const devtools = contents ? await openDevtools(contents) : undefined
    if (!devtools) return false
    if (panel) await inFrontend(devtools, showPanel(panel))
    if (!devtools.isDestroyed()) devtools.focus()
    return true
  })
  commands.register('devtools.close', ({ tabId }, c) => {
    const contents = pageOf(c, tabId)
    if (contents?.isDevToolsOpened()) contents.closeDevTools()
  })
  commands.register('devtools.state', async ({ tabId }, c) => {
    const contents = pageOf(c, tabId)
    return contents ? devtoolsState(contents) : { open: false, focused: false }
  })

  hooks.tabCreated.push((tabId, contents) => {
    // Every opening loads a new DevTools page, however it was opened (keys, Inspect, the picker).
    contents.on('devtools-opened', () => {
      const devtools = contents.devToolsWebContents
      if (devtools) void installKeys(devtools)
    })
    // Links DevTools open (a request's URL, "Open in new tab") open as a tab beside the page's.
    contents.on('devtools-open-url', (_event, url) => {
      if (!/^(https?|file):/i.test(url)) return
      const spaceId = store.state.tabs[tabId]?.spaceId
      void commands.run('tabs.create', { url, spaceId, activate: true }, {})
    })
    // A page that crashes takes the keyboard with it, and Orbit's keys go nowhere. The window's own
    // UI takes it instead, so ⇧⌘R (Ctrl+Shift+R) brings the page back (DT-14).
    contents.on('render-process-gone', (_event, details) => {
      if (details.reason !== 'clean-exit') setImmediate(() => keepKeyboard(contents))
    })
  })

  // A tab shown again with docked DevTools takes the size last chosen in any of them (DT-03).
  store.subscribe((next, prev) => {
    if (next.windows === prev.windows && next.splits === prev.splits) return
    for (const windowId of Object.keys(next.windows)) {
      const before = prev.windows[windowId] ? shownTabs(prev, windowId) : new Set<TabId>()
      for (const tabId of shownTabs(next, windowId)) {
        if (before.has(tabId)) continue
        const devtools = tabs.contents(tabId)?.devToolsWebContents
        if (devtools && !devtools.isDestroyed()) void inFrontend(devtools, SYNC_DOCKED_SIZE)
      }
    }
  })
}

/** Gives the focused window's own UI the keyboard if nothing has it (the page that had it crashed). */
function keepKeyboard(crashed: WebContents): void {
  const focused = webContents.getFocusedWebContents()
  if (focused && !focused.isDestroyed() && focused !== crashed) return
  const win = BrowserWindow.getFocusedWindow()
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.focus()
}
