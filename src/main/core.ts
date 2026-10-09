import { app } from 'electron'
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from '../shared/defaults'
import type { OverlayState, WindowId } from '../shared/state'
import type { MainContext } from './context'
import type { CallContext } from './registry'
import { activeTabOf } from './windows'

let overlayNonce = 0

/** Core window/overlay/sidebar commands and actions (owned by the lead). */
export function registerCore(ctx: MainContext): void {
  const { store, commands, actions, windows } = ctx
  const windowOf = (c: CallContext): WindowId | undefined => c.windowId ?? windows.focusedWindowId()

  const setOverlay = (windowId: WindowId | undefined, overlay: OverlayState) => {
    if (!windowId) return
    store.update((d) => {
      const win = d.windows[windowId]
      if (win) win.overlay = overlay
    })
  }

  commands.register('action.run', ({ id }, c) => actions.run(id, { windowId: windowOf(c) }))
  commands.register('overlay.open', ({ overlay }, c) => {
    setOverlay(windowOf(c), { ...overlay, nonce: ++overlayNonce } as OverlayState)
  })
  commands.register('overlay.close', (_args, c) => setOverlay(windowOf(c), { kind: 'none' }))
  commands.register('window.setSidebar', ({ visible, width, peeking }, c) => {
    const windowId = windowOf(c)
    if (!windowId) return
    store.update((d) => {
      const win = d.windows[windowId]
      if (!win) return
      if (visible !== undefined) {
        win.sidebar.visible = visible
        if (visible) win.sidebar.peeking = false
      }
      if (width !== undefined)
        win.sidebar.width = Math.round(Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width)))
      if (peeking !== undefined && !win.sidebar.visible) win.sidebar.peeking = peeking
    })
  })
  commands.register('window.control', ({ op }, c) => {
    const win = windows.get(windowOf(c) ?? '')
    if (!win) return
    if (op === 'minimize') win.minimize()
    else if (op === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize()
    else win.close()
  })
  commands.register('app.info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    e2e: ctx.e2e,
  }))

  const openCommandBar = (mode: 'new-tab' | 'edit-url' | 'search-tabs') => (c: CallContext) => {
    const windowId = windowOf(c)
    if (!windowId) return
    const win = store.state.windows[windowId]
    if (win?.overlay.kind === 'commandbar' && win.overlay.mode === mode) {
      setOverlay(windowId, { kind: 'none' })
      return
    }
    const tabId = activeTabOf(store.state, windowId)
    const query = mode === 'edit-url' && tabId ? (store.state.tabs[tabId]?.url ?? '') : ''
    ctx.perf.mark('commandbar:open:start')
    setOverlay(windowId, {
      kind: 'commandbar',
      mode,
      query: query === 'about:blank' ? '' : query,
      nonce: ++overlayNonce,
    })
  }
  actions.register('tab.new', openCommandBar('new-tab'))
  actions.register('url.edit', openCommandBar('edit-url'))
  actions.register('page.find', (c) => {
    // Placeholder until the find-in-page bar lands: forward to the command bar lane's find UI when present.
    ctx.toast(windowOf(c), 'Find in page is coming soon')
  })

  actions.register('sidebar.toggle', (c) => {
    const windowId = windowOf(c)
    const win = windowId ? store.state.windows[windowId] : undefined
    if (!win) return
    void commands.run('window.setSidebar', { visible: !win.sidebar.visible }, { windowId })
  })
  actions.register('window.new', () => {
    windows.open()
  })
  actions.register('app.settings', (c) => ctx.toast(windowOf(c), 'Settings are coming soon'))
}
