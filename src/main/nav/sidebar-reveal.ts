import type { MouseInputEvent } from 'electron'
import type { TabId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import type { CallContext } from '../registry'

/** The pointer this close to the window's left edge reveals the hidden sidebar (FL-03: a 4–8 px band). */
export const REVEAL_EDGE = 6
/** The floating sidebar stays this long after the pointer has left it (FL-03: 300–500 ms). */
export const HIDE_GRACE_MS = 400

/** What keeps the floating sidebar out. */
export interface RevealHold {
  /** The pointer is over the card, or just beside it. */
  over: boolean
  /** A text field in the card has focus (a rename, the new-Space flow). */
  editing: boolean
  /** Something opened over the window while the card was out (the command bar, a panel). */
  overlay: boolean
}

interface Hold extends RevealHold {
  timer?: NodeJS.Timeout
}

/** A window's hold as tests see it: `hiding` while the card's grace delay runs. */
export interface RevealHoldInfo extends RevealHold {
  hiding: boolean
}

const buttonDown = (mouse: MouseInputEvent) => (mouse.modifiers ?? []).some((m) => /buttondown$/i.test(m))

/**
 * The hidden sidebar's hover reveal (SB-12, FL-03). When the pointer reaches the window's left edge
 * the sidebar slides in over the page as a floating card (`sidebar.peeking`; the window manager
 * places its view and the page never moves). It stays while the pointer is over it, a text field in
 * it is being edited or something it opened floats over the window, and slides away shortly after
 * the pointer moves on; a click into the page sends it away at once.
 *
 * Where the pointer is comes from the card itself (it enters, or leaves through the window's edge)
 * and from the pages (it moves or clicks there). A native menu opened from the card holds the
 * pointer, so nothing arrives from the pages and the card stays while the menu is up.
 */
export function registerSidebarReveal(ctx: MainContext): {
  hold: (windowId: WindowId) => RevealHoldInfo | undefined
} {
  const { store, commands, windows } = ctx
  const holds = new Map<WindowId, Hold>()
  const windowOf = (c: CallContext): WindowId | undefined => c.windowId ?? windows.focusedWindowId()

  const holdOf = (windowId: WindowId): Hold => {
    let hold = holds.get(windowId)
    if (!hold) {
      hold = { over: true, editing: false, overlay: false }
      holds.set(windowId, hold)
    }
    return hold
  }

  const setPeeking = (windowId: WindowId, peeking: boolean) =>
    store.update((d) => {
      const w = d.windows[windowId]
      if (w && !w.sidebar.visible && w.sidebar.peeking !== peeking) w.sidebar.peeking = peeking
    })

  const reveal = (windowId: WindowId) => {
    const win = store.state.windows[windowId]
    if (!win || win.kind === 'mini' || win.sidebar.visible) return
    if (win.sidebar.peeking) {
      const hold = holdOf(windowId)
      hold.over = true
      settle(windowId)
      return
    }
    // Nothing summons it while something else floats over the window (the command bar, the site
    // controls) or a video fills it.
    if (win.overlay.kind !== 'none' || windows.inHtmlFullscreen(windowId)) return
    clearTimeout(holds.get(windowId)?.timer)
    holds.set(windowId, { over: true, editing: false, overlay: false })
    setPeeking(windowId, true)
  }

  const hideNow = (windowId: WindowId) => {
    clearTimeout(holds.get(windowId)?.timer)
    holds.delete(windowId)
    setPeeking(windowId, false)
  }

  /** Once nothing holds the card, it slides away after the grace delay. */
  const settle = (windowId: WindowId) => {
    const hold = holdOf(windowId)
    clearTimeout(hold.timer)
    hold.timer = undefined
    if (!store.state.windows[windowId]?.sidebar.peeking || hold.over || hold.editing || hold.overlay) return
    hold.timer = setTimeout(() => {
      hold.timer = undefined
      if (!hold.over && !hold.editing && !hold.overlay) setPeeking(windowId, false)
    }, HIDE_GRACE_MS)
  }

  store.subscribe((next) => {
    for (const [windowId, win] of Object.entries(next.windows)) {
      if (!win.sidebar.peeking || win.sidebar.visible) {
        const hold = holds.get(windowId)
        if (hold) {
          clearTimeout(hold.timer)
          holds.delete(windowId)
        }
        continue
      }
      // Opening the command bar or a panel from the card keeps it out until that closes (SB-12).
      const hold = holdOf(windowId)
      const floating = win.overlay.kind !== 'none'
      if (floating !== hold.overlay) {
        hold.overlay = floating
        settle(windowId)
      }
    }
    for (const windowId of holds.keys()) if (!next.windows[windowId]) holds.delete(windowId)
  })

  /** Pointer input over a page: it left the card, clicked into the page, or (full screen) reached the edge. */
  const onPageMouse = (tabId: TabId, mouse: MouseInputEvent) => {
    if (mouse.type !== 'mouseMove' && mouse.type !== 'mouseDown') return
    const windowId = windows.windowOfTab(tabId)
    const win = windowId ? store.state.windows[windowId] : undefined
    if (!windowId || !win || win.sidebar.visible) return
    if (win.sidebar.peeking) {
      if (mouse.type === 'mouseDown') {
        hideNow(windowId)
        return
      }
      const hold = holdOf(windowId)
      if (hold.over) {
        hold.over = false
        settle(windowId)
      }
      return
    }
    // In full screen the page reaches the window's left edge, so the edge is in the page.
    if (mouse.type !== 'mouseMove' || buttonDown(mouse)) return
    const bounds = windows.tabViewBounds(tabId)
    if (bounds && bounds.x + mouse.x < REVEAL_EDGE) reveal(windowId)
  }
  ctx.hooks.tabCreated.push((tabId, contents) => {
    contents.on('before-mouse-event', (_event, mouse) => onPageMouse(tabId, mouse))
  })

  commands.register('sidebar.reveal', (_args, c) => {
    const windowId = windowOf(c)
    if (windowId) reveal(windowId)
  })
  commands.register('sidebar.peekState', ({ over, editing }, c) => {
    const windowId = windowOf(c)
    if (!windowId || !store.state.windows[windowId]?.sidebar.peeking) return
    const hold = holdOf(windowId)
    if (typeof over === 'boolean') hold.over = over
    if (typeof editing === 'boolean') hold.editing = editing
    settle(windowId)
  })
  commands.register('sidebar.peekDismiss', ({ x, y, button }, c) => {
    const windowId = windowOf(c)
    if (!windowId) return
    hideNow(windowId)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !['left', 'middle', 'right'].includes(button)) return
    const page = windows.pageAt(windowId, x, y)
    if (!page || page.contents.isDestroyed()) return
    const at = { x: Math.round(page.x), y: Math.round(page.y) }
    page.contents.sendInputEvent({ type: 'mouseMove', ...at })
    page.contents.sendInputEvent({ type: 'mouseDown', ...at, button, clickCount: 1 })
    page.contents.sendInputEvent({ type: 'mouseUp', ...at, button, clickCount: 1 })
  })

  return {
    hold: (windowId) => {
      const hold = holds.get(windowId)
      return hold
        ? { over: hold.over, editing: hold.editing, overlay: hold.overlay, hiding: hold.timer !== undefined }
        : undefined
    },
  }
}
