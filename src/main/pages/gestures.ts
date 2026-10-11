import type { WebContents } from 'electron'

/**
 * A page's user gestures (D77): one count per page, which a press in any of its frames feeds, as
 * Chromium's user activation does. The leave-page warning (NV-24, D73), links to other apps (NV-19)
 * and the pop-up rule (NV-09) all read it.
 *
 * - **A mouse-down.** `before-mouse-event` sees every frame's; `input-event` sees only the main
 *   frame's widget, so never a press in a frame from another site, which has a widget of its own.
 *   One press in the main frame brings both, in the same task: it counts once.
 * - **A key that reaches the page** (`before-input-event`, every frame's). Not a shortcut Orbit takes
 *   first: a listener prevents it (`windows.attachShortcuts`), so ⌘W doesn't count for the page it
 *   closes, unless the user has set ⌘W to go to websites first. A shortcut that goes to the page
 *   first reaches it, so it counts: by default Ctrl+S and Ctrl+Shift+C on Windows and Linux, and
 *   Back and Forward in a text field. Nor, as in Chromium, Esc, a modifier alone, or a key held down.
 * - **A touch's end or a tap** (`input-event`).
 *
 * Orbit's own calls into a page (its scripts, a navigation it starts) are no gesture, and nor is
 * the user activation the engine gives a page it asks to leave (D77 (3)).
 */

/** Keys that never count as a gesture (HTML user activation: Escape, and a modifier alone). */
const NOT_A_GESTURE = new Set(['Escape', 'Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock', 'Fn', 'FnLock'])

interface Gestures {
  count: number
  listeners: Set<() => void>
  /** A mouse-down came this task (`before-mouse-event`): the main frame's `input-event` is the same press. */
  pressing: boolean
}

const pages = new WeakMap<WebContents, Gestures>()

function watched(page: WebContents): Gestures {
  const known = pages.get(page)
  if (known) return known
  const g: Gestures = { count: 0, listeners: new Set(), pressing: false }
  pages.set(page, g)
  const press = () => {
    g.count++
    for (const listener of [...g.listeners]) listener()
  }
  page.on('before-mouse-event', (_event, mouse) => {
    if (mouse.type !== 'mouseDown') return
    if (!g.pressing) {
      g.pressing = true
      setImmediate(() => {
        g.pressing = false
      })
    }
    press()
  })
  page.on('input-event', (_event, input) => {
    if (input.type === 'mouseDown') {
      if (!g.pressing) press()
    } else if (input.type === 'touchEnd' || input.type === 'gestureTap') press()
  })
  page.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat || NOT_A_GESTURE.has(input.key)) return
    // Whether a listener took the key for Orbit is known once every listener has run.
    queueMicrotask(() => {
      if (!event.defaultPrevented && !page.isDestroyed()) press()
    })
  })
  return g
}

/** Counts a page's gestures from now on: as it is created, so that none is missed. */
export function watchGestures(page: WebContents): void {
  watched(page)
}

/** The gestures a page has had since it was watched: it only grows. */
export function gestureCount(page: WebContents): number {
  return pages.get(page)?.count ?? 0
}

/** Calls `listener` on each of the page's gestures from now on. */
export function onGesture(page: WebContents, listener: () => void): void {
  watched(page).listeners.add(listener)
}
