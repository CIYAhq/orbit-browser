import { app, type WebContents, webContents } from 'electron'
import { ACTIONS_BY_ID, formatAccelerator, shortcutsFor } from '../../shared/actions'
import { archivePeriodText, HINT_LIMITS, type HintKind } from '../../shared/hints'
import type { ArchivedTab, OrbitState, WindowId } from '../../shared/state'
import type { ToastAction, ToastPayload } from '../../shared/toast'
import type { MainContext } from '../context'

interface Hint {
  message: string
  action?: ToastAction
}

/** The browser window in front, if Orbit is: a hint shown anywhere else would go unread. */
function focusedBrowserWindow(state: OrbitState): WindowId | undefined {
  return Object.values(state.windows).find((w) => w.kind === 'main' && w.focused)?.id
}

/** The action's first key as this platform shows it, following the user's keymap (KS-18), or ''. */
function keyOf(actionId: string): string {
  const action = ACTIONS_BY_ID[actionId]
  const accel = action ? shortcutsFor(action, process.platform)[0] : undefined
  return accel ? formatAccelerator(accel, process.platform) : ''
}

/** Today tabs archived on their own (TD-03): what happened, and how to get them back (OB-11). */
export function archiveHint(state: OrbitState, archived: readonly ArchivedTab[]): Hint {
  const first = archived[0]
  const profile = first ? state.profiles[first.profileId] : undefined
  const period = archivePeriodText(profile?.archiveAfterMs ?? state.settings.archiveAfterMs)
  const one = archived.length === 1
  const what = one ? 'A Today tab' : `${archived.length} Today tabs`
  return {
    message: `${what} you hadn’t used for ${period} moved to the Archive. You can restore ${one ? 'it' : 'them'} from there.`,
    action: { label: 'View Archive', command: 'library.open', args: { section: 'archive' } },
  }
}

/** The sidebar was hidden: how to bring it back (OB-11, SB-12). */
export function sidebarHint(key: string): Hint {
  return {
    message: key
      ? `The sidebar is hidden. ${key} brings it back, or point at the window’s left edge.`
      : 'The sidebar is hidden. Point at the window’s left edge to see it.',
    action: { label: 'Show', command: 'window.setSidebar', args: { visible: true } },
  }
}

/**
 * Contextual hints (OB-11): a note at the moment Orbit does something that can surprise.
 * - `archive`, once: the first time Today tabs are archived on their own, what happened and where
 *   they are. Shown in the browser window in front; when Orbit isn't (tabs archived at launch, or
 *   while away), as soon as one of its browser windows is.
 * - `sidebar`, three times: when a window's sidebar is hidden, how to bring it back.
 *
 * They show as toasts (Toasts.tsx; over the page while the sidebar is hidden, SB-13): about 6 s,
 * longer while the pointer is on one, and ✕ or Esc dismisses them. Esc is heard wherever the
 * keyboard is in that window and still goes where it was going: a hint never blocks the page. How
 * many times each has shown is kept in the state file. Test runs show none unless ORBIT_HINTS=1,
 * so no other test meets one.
 */
export function registerHints(ctx: MainContext): void {
  const { store, windows, commands } = ctx
  /** The toasts (by web contents) showing a hint now, and the window each is in. */
  const showing = new Map<number, WindowId>()
  commands.register('hints.showing', ({ showing: on }, c) => {
    const sender = c.sender
    if (!sender || !c.windowId) return
    if (on !== true) {
      showing.delete(sender.id)
      return
    }
    if (!showing.has(sender.id)) sender.once('destroyed', () => showing.delete(sender.id))
    showing.set(sender.id, c.windowId)
  })
  if (ctx.e2e && process.env.ORBIT_HINTS !== '1') return

  const due = (kind: HintKind) => (store.state.settings.hintsShown?.[kind] ?? 0) < HINT_LIMITS[kind]
  const show = (kind: HintKind, windowId: WindowId, hint: Hint) => {
    if (!due(kind) || !store.state.windows[windowId]) return
    store.update((d) => {
      d.settings.hintsShown = { ...d.settings.hintsShown, [kind]: (d.settings.hintsShown?.[kind] ?? 0) + 1 }
    })
    const payload: ToastPayload = { message: hint.message, ...(hint.action ? { action: hint.action } : {}), hint: true }
    windows.sendToWindow(windowId, 'toast', payload)
  }

  /** The archive hint, waiting for a browser window to come to the front. */
  let waiting: Hint | undefined
  store.subscribe((next, prev) => {
    // Shown after the change that called for it is done: never in the middle of another update.
    if (next.archive !== prev.archive && due('archive') && !waiting) {
      const before = new Set(prev.archive.map((entry) => entry.id))
      const archived = next.archive.filter((entry) => entry.reason === 'auto' && !before.has(entry.id))
      if (archived.length > 0) waiting = archiveHint(next, archived)
    }
    if (waiting) {
      const windowId = focusedBrowserWindow(next)
      const hint = waiting
      if (windowId) {
        waiting = undefined
        queueMicrotask(() => show('archive', windowId, hint))
      }
    }
    if (next.windows !== prev.windows && due('sidebar')) {
      for (const [id, win] of Object.entries(next.windows)) {
        if (win.kind !== 'main' || win.sidebar.visible || !prev.windows[id]?.sidebar.visible) continue
        queueMicrotask(() => show('sidebar', id, sidebarHint(keyOf('sidebar.toggle'))))
      }
    }
  })

  // Esc dismisses the hints of the window it was pressed in, wherever the keyboard is there.
  const listen = (contents: WebContents) =>
    contents.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'Escape' || showing.size === 0) return
      const windowId = windows.windowIdFor(contents)
      if (windowId && [...showing.values()].includes(windowId)) windows.broadcast('orbit:hints.dismiss', { windowId })
    })
  for (const contents of webContents.getAllWebContents()) listen(contents)
  app.on('web-contents-created', (_event, contents) => listen(contents))
}
