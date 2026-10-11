import { windowMayShow } from '../../shared/private'
import type { OrbitState, TabId, WindowId } from '../../shared/state'
import { switcherOf, switcherParams, TAB_SWITCHER_PANEL } from '../../shared/tab-switcher'
import { sidebarTabOrder } from '../../shared/tree'
import type { MainContext } from '../context'
import type { CallContext } from '../registry'
import type { TabOps } from './ops'

/** A held ⌃Tab shows the list after this long; a second Tab shows it at once (FL-26: about 150 ms). */
export const SWITCHER_HOLD_MS = 150
/** The switcher lists this many tabs (TB-05). */
const SWITCHER_SIZE = 5

/**
 * The switcher's tabs (TB-05): the one shown first, then the ones used most recently, five in all.
 * Only tabs of this window's sidebar that it may show: a private or blank window's own, and no
 * tab an unfinished import keeps out of sight, since no section holds one (D65, D66).
 */
export function recentOrder(state: OrbitState, windowId: WindowId, active: TabId | null): TabId[] {
  const win = state.windows[windowId]
  if (!win) return []
  const others = [...new Set(sidebarTabOrder(state, win.spaceId))]
    .filter((id) => id !== active && windowMayShow(state, windowId, id))
    .flatMap((id) => {
      const tab = state.tabs[id]
      return tab ? [tab] : []
    })
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .map((t) => t.id)
  return (active ? [active, ...others] : others).slice(0, SWITCHER_SIZE)
}

interface Switch {
  windowId: WindowId
  order: TabId[]
  index: number
  /** The overlay panel's nonce: it opens at the first Tab. */
  nonce?: number
  /** The list is drawn (after the hold, or at the second Tab). */
  shown: boolean
  timer?: NodeJS.Timeout
}

/**
 * The recent-tab switcher (TB-05, FL-26). Holding Control, Tab highlights the next of the five most
 * recently used tabs (the second at first), ⇧Tab and ⌃` the one before, and W closes the highlighted
 * one (keys lane, KS-06); letting go of Control switches to the highlighted tab. A quick tap and
 * release goes straight to the previous tab and shows nothing; held, the list shows after
 * SWITCHER_HOLD_MS, or at once at the second Tab. The page behind stays as it is until the release:
 * then the list goes and the page changes in the same frame (`windows.ts` hides the overlay at once).
 * Esc, a click outside the list, another action or the window losing focus ends it without a switch.
 *
 * The overlay opens at the first Tab, before its list is drawn, and has the keyboard from then on.
 * The engine holds back every key-up on a view after a key Orbit takes from it, until another key
 * goes down there: the release of Control would never come from the page the first Tab was taken
 * from. In the overlay, Orbit runs the switcher's keys without taking them (`windows.ts`).
 */
export function registerTabSwitcher(ctx: MainContext, ops: TabOps): void {
  const { store, actions, commands, windows, tabs } = ctx
  const windowOf = (c: CallContext): WindowId | undefined => c.windowId ?? windows.focusedWindowId()
  let current: Switch | null = null

  const isOurs = (s: Switch, state: OrbitState) => {
    const overlay = state.windows[s.windowId]?.overlay
    return overlay?.kind === 'panel' && overlay.panel === TAB_SWITCHER_PANEL && overlay.nonce === s.nonce
  }

  /** Opens the panel, with the keyboard; its list is drawn later (`reveal`). */
  const open = (s: Switch) => {
    void commands.run(
      'overlay.open',
      { overlay: { kind: 'panel', panel: TAB_SWITCHER_PANEL, params: switcherParams(s.order, s.index, s.shown) } },
      { windowId: s.windowId },
    )
    const overlay = store.state.windows[s.windowId]?.overlay
    s.nonce = overlay?.kind === 'panel' && switcherOf(overlay) ? overlay.nonce : -1
  }

  /** Puts the list as it is now on screen (the highlight, or the tabs after a close). */
  const redraw = (s: Switch) => {
    if (s.nonce === undefined) return
    store.update((d) => {
      const overlay = d.windows[s.windowId]?.overlay
      if (overlay?.kind === 'panel' && overlay.panel === TAB_SWITCHER_PANEL && overlay.nonce === s.nonce) {
        overlay.params = switcherParams(s.order, s.index, s.shown)
      }
    })
  }

  /** Draws the list: after the hold, or at once at the second Tab (FL-26). */
  const reveal = (s: Switch) => {
    clearTimeout(s.timer)
    s.timer = undefined
    s.shown = true
    redraw(s)
  }

  /** Ends the switch on `target` (null: no switch). The page changes first, then the list goes. */
  const finish = (target: TabId | null) => {
    const s = current
    if (!s) return
    current = null
    clearTimeout(s.timer)
    if (target && store.state.tabs[target] && target !== ops.activeTab(s.windowId)) ops.activate(s.windowId, target)
    if (s.nonce === undefined) return
    store.update((d) => {
      const win = d.windows[s.windowId]
      if (win && isOurs(s, d)) win.overlay = { kind: 'none' }
    })
  }
  const settle = () => finish(current ? (current.order[current.index] ?? null) : null)

  const start = (windowId: WindowId): Switch | null => {
    const order = recentOrder(store.state, windowId, ops.activeTab(windowId))
    if (order.length < 2) return null
    const s: Switch = { windowId, order, index: 0, shown: false }
    s.timer = setTimeout(() => {
      if (current === s) reveal(s)
    }, SWITCHER_HOLD_MS)
    return s
  }

  const step = (delta: 1 | -1) => (c: CallContext) => {
    const windowId = windowOf(c)
    if (!windowId) return
    if (current && current.windowId !== windowId) finish(null)
    const first = !current
    const s = current ?? start(windowId)
    if (!s) return
    current = s
    s.index = (s.index + delta + s.order.length) % s.order.length
    // The first Tab opens the panel; the second shows the list at once (FL-26: within a frame of it).
    if (first) open(s)
    else if (!s.shown) reveal(s)
    else redraw(s)
  }
  actions.register('tab.recent', step(1))
  actions.register('tab.recentBack', step(-1))

  tabs.onControlUp = settle
  tabs.recentSwitch = {
    active: (windowId) => current?.windowId === windowId,
    // W, with Control still held, closes the highlighted tab; the next takes its place (KS-06).
    closeHighlighted: (windowId) => {
      const s = current
      if (!s || s.windowId !== windowId) return
      const closing = s.order[s.index]
      if (!closing) return
      s.order.splice(s.index, 1)
      if (s.index >= s.order.length) s.index = 0
      ops.closeTabs([closing], 'closed')
      if (s.order.length === 0) finish(null)
      else redraw(s)
    },
    cancel: (windowId) => {
      if (!windowId || current?.windowId !== windowId) return false
      finish(null)
      return true
    },
  }
  commands.register('tabs.endRecentSwitch', ({ cancel, tabId }) => {
    if (cancel) finish(null)
    else if (tabId) finish(current?.order.includes(tabId) ? tabId : null)
    else settle()
  })

  // The list closed some other way (a click outside it, another overlay over it), or its window
  // went or lost focus: no switch.
  store.subscribe((next, prev) => {
    const s = current
    if (!s || next.windows === prev.windows) return
    const win = next.windows[s.windowId]
    // Not under the e2e harness: parallel test apps share one display and take focus from each other.
    const blurred = !ctx.e2e && !!prev.windows[s.windowId]?.focused && win?.focused === false
    if (!win || blurred || (s.nonce !== undefined && !isOurs(s, next))) finish(null)
  })
  // Any other action ends the switch where it is, then runs (KS-19): the list never outlives a key.
  actions.intercept((id, c) => {
    const s = current
    if (s && id !== 'tab.recent' && id !== 'tab.recentBack' && windowOf(c) === s.windowId) finish(null)
    return false
  })
}
