/**
 * Preload for web pages: registered on every profile session (src/main/nav/page-bridge.ts), so it
 * runs in the main frame of each page, Peek and Mini Window included, and never in Orbit's own views.
 *
 * Electron's permission check can only say yes or no, so a permission the user hasn't decided would
 * read as "denied", and sites that look before they ask would never ask. This keeps Chromium's
 * answers without adding anything to the page's globals (NV-15):
 * - `Notification.permission` is "default", and a PermissionStatus's `state` "prompt", until the
 *   user decides;
 * - clicking one of the page's notifications brings its tab forward.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { PAGE_CHANNEL } from '../shared/site'

type StateOf = (name: string) => string | null

const permissionState: StateOf = (name) => {
  try {
    const value: unknown = ipcRenderer.sendSync(PAGE_CHANNEL.permission, String(name))
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

const notificationClicked = () => {
  ipcRenderer.send(PAGE_CHANNEL.notificationClick)
}

/**
 * Runs in the page's own world before its scripts (serialized: it may use only its arguments and
 * the page's globals). Built-ins are taken up front, so a page that replaces them later can't reach
 * Orbit's functions through them.
 */
function patchPage(stateOf: StateOf, clicked: () => void) {
  const define = Object.defineProperty
  const describe = Object.getOwnPropertyDescriptor
  const construct = Reflect.construct
  const listen = EventTarget.prototype.addEventListener
  const then = Promise.prototype.then

  const NativeNotification = window.Notification
  if (typeof NativeNotification === 'function') {
    /** "denied" from the engine is "default" while the user hasn't decided (or dismissed the prompt). */
    const undecided = (value: NotificationPermission): NotificationPermission =>
      value === 'denied' && stateOf('notifications') === 'prompt' ? 'default' : value
    const permission = describe(NativeNotification, 'permission')
    const read = permission?.get
    if (permission?.configurable && read) {
      define(NativeNotification, 'permission', {
        configurable: true,
        enumerable: permission.enumerable,
        get() {
          return undecided(read.call(NativeNotification))
        },
      })
    }
    // Notification.requestPermission(): a dismissed prompt answers "default", as in Chromium.
    const request = describe(NativeNotification, 'requestPermission')
    const ask = request?.value
    if (request?.configurable && typeof ask === 'function') {
      define(NativeNotification, 'requestPermission', {
        configurable: true,
        enumerable: request.enumerable,
        writable: true,
        value: function requestPermission(callback?: (value: NotificationPermission) => void) {
          return then.call(ask.call(NativeNotification), (value: NotificationPermission) => {
            const answer = undecided(value)
            if (typeof callback === 'function') callback(answer)
            return answer
          })
        },
      })
    }
    // A click on one of the page's notifications (only a real one) brings its tab forward.
    const onClick = (event: Event) => {
      if (event.isTrusted) clicked()
    }
    const Notification = new Proxy(NativeNotification, {
      construct(target, args, newTarget) {
        const notification = construct(target, args, newTarget)
        listen.call(notification, 'click', onClick)
        return notification
      },
    })
    const own = describe(window, 'Notification')
    if (own?.configurable) {
      define(window, 'Notification', {
        configurable: true,
        enumerable: own.enumerable,
        writable: true,
        value: Notification,
      })
    }
  }

  // navigator.permissions.query(): a PermissionStatus says "prompt" while the user hasn't decided.
  const Status = window.PermissionStatus
  if (typeof Status === 'function') {
    const state = describe(Status.prototype, 'state')
    const name = describe(Status.prototype, 'name')
    const readState = state?.get
    const readName = name?.get
    if (state?.configurable && readState && readName) {
      define(Status.prototype, 'state', {
        configurable: true,
        enumerable: state.enumerable,
        get() {
          const value = readState.call(this)
          return value === 'denied' && stateOf(String(readName.call(this))) === 'prompt' ? 'prompt' : value
        },
      })
    }
  }
}

try {
  contextBridge.executeInMainWorld({ func: patchPage, args: [permissionState, notificationClicked] })
} catch {
  // A page without its own world to patch keeps the engine's answers.
}
