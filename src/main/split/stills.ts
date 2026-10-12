import type { TabId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'

/**
 * Stills of a split's pages (SV-26). A closing pane's card fades and collapses with its page on it,
 * but the page's view leaves the window the moment its tab closes. So each pane of a split on screen
 * keeps a still of its page in its card, under the page's view (the shell's pane engine): taken once
 * the panes are at rest, and again a moment after anything changed the page (a load, a scroll, a
 * key). A capture can cost a frame, so none is taken while the panes move.
 */
const STILL_AFTER_MS = 200
const STILL_INPUTS = new Set(['mouseUp', 'mouseWheel', 'keyUp', 'gestureScrollEnd', 'gestureFlingStart', 'touchEnd'])

interface Shown {
  /** The panes the shell last reported, with the size of each one's view. */
  panes: Map<TabId, string>
  /** Panes whose still is out of date. */
  stale: Set<TabId>
  timer?: ReturnType<typeof setTimeout>
  capturing: boolean
}

/** A rectangle's size as main lays its view out (whole pixels, edges rounded). */
const sizeOf = (r: { x: number; y: number; width: number; height: number }) =>
  `${Math.round(r.x + r.width) - Math.round(r.x)}x${Math.round(r.y + r.height) - Math.round(r.y)}`

export function installPaneStills(ctx: MainContext): void {
  const { windows, tabs } = ctx
  const shown = new Map<WindowId, Shown>()
  /** The size of each pane's still, while it is up to date. */
  const taken = new Map<TabId, string>()

  const soon = (windowId: WindowId, s: Shown) => {
    clearTimeout(s.timer)
    s.timer = setTimeout(() => void capture(windowId, s), STILL_AFTER_MS)
  }

  const capture = async (windowId: WindowId, s: Shown) => {
    s.timer = undefined
    if (s.capturing) return
    s.capturing = true
    try {
      for (const tabId of [...s.stale]) {
        // The panes moved again, or the split left the window: later, or never.
        if (shown.get(windowId) !== s || s.timer) return
        s.stale.delete(tabId)
        const size = s.panes.get(tabId)
        const bounds = windows.tabViewBounds(tabId)
        const contents = tabs.contents(tabId)
        if (!size || !bounds || !contents || contents.isDestroyed() || sizeOf(bounds) !== size) continue
        const image = await contents.capturePage()
        const win = windows.get(windowId)
        if (image.isEmpty() || !win || win.isDestroyed() || s.panes.get(tabId) !== size) continue
        taken.set(tabId, size)
        const url = `data:image/jpeg;base64,${image.toJPEG(85).toString('base64')}`
        win.webContents.send('orbit:split:still', { tabId, url, width: bounds.width, height: bounds.height })
      }
    } catch {
      // The page went while it was being captured: its pane has gone too.
    } finally {
      s.capturing = false
      if (shown.get(windowId) === s && s.stale.size > 0 && !s.timer) soon(windowId, s)
    }
  }

  // The panes the shell lays out: a split's panes get stills once they are at rest.
  ctx.events.on('layout.panes', ({ panes }, { windowId }) => {
    if (!windowId) return
    const before = shown.get(windowId)
    if (panes.length < 2) {
      if (before) clearTimeout(before.timer)
      shown.delete(windowId)
      return
    }
    const s = before ?? { panes: new Map(), stale: new Set<TabId>(), capturing: false }
    s.panes = new Map(panes.map((p) => [p.tabId, sizeOf(p.rect)]))
    for (const [tabId, size] of s.panes) if (taken.get(tabId) !== size) s.stale.add(tabId)
    shown.set(windowId, s)
    soon(windowId, s)
  })

  // Anything that changes a page on screen: its still is taken again a moment later.
  ctx.hooks.tabCreated.push((tabId, contents) => {
    const changed = () => {
      taken.delete(tabId)
      for (const [windowId, s] of shown) {
        if (!s.panes.has(tabId)) continue
        s.stale.add(tabId)
        soon(windowId, s)
      }
    }
    contents.on('did-stop-loading', changed)
    contents.on('did-navigate-in-page', changed)
    contents.on('input-event', (_e, input) => {
      if (STILL_INPUTS.has(input.type)) changed()
    })
    contents.once('destroyed', () => taken.delete(tabId))
  })

  windows.onWindowCreated((windowId, win) => {
    win.once('closed', () => {
      clearTimeout(shown.get(windowId)?.timer)
      shown.delete(windowId)
    })
  })
}
