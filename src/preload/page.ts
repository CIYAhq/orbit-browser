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
 *
 * Orbit's internal pages (`orbit://<page>/`, DT-13) are Orbit's UI in a tab, not web pages: in the
 * main frame of one, and only there, this gives the bridge Orbit's UI has (D53), and patches
 * nothing. See `exposeInternalPage`.
 *
 * In every page's main frame, it also tells main whether the page used an Esc (D59, `watchEscape`).
 *
 * In a web page's main frame, the page's `alert`, `confirm` and `prompt` ask main, which shows
 * Orbit's dialog over that page only (NV-24): Electron has no `prompt`, and shows the others as
 * app-wide boxes. A frame has no preload (D40), so a dialog a frame asks for itself is the engine's
 * own box (and a frame's `prompt` returns null). It also answers main about the leave-page warning
 * (`exposeLeave`).
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { OrbitBridge, StatePatch } from '../shared/rpc'
import { PAGE_CHANNEL } from '../shared/site'
import type { OrbitState } from '../shared/state'

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
function patchPage(stateOf: StateOf, clicked: () => void, ask: AskDialog) {
  // Calls go through the captured `apply`, never a function's own `.call`: a page that replaces
  // `Function.prototype.call` (or `Reflect.apply`) would otherwise receive Orbit's functions.
  const apply = Reflect.apply
  const define = Object.defineProperty
  const describe = Object.getOwnPropertyDescriptor
  const construct = Reflect.construct
  const listen = EventTarget.prototype.addEventListener
  const then = Promise.prototype.then
  const text = String

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
          return undecided(apply(read, NativeNotification, []))
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
        // The callback comes as a rest argument, so the function declares none (`length` 0), as the
        // engine's (review B-F11).
        value: function requestPermission(...args: unknown[]) {
          const callback = args[0]
          return apply(then, apply(ask, NativeNotification, []), [
            (value: NotificationPermission) => {
              const answer = undecided(value)
              if (typeof callback === 'function') callback(answer)
              return answer
            },
          ])
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
        apply(listen, notification, ['click', onClick])
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
      // A notification's `constructor` is the Notification the page sees (review B-F11).
      const made = describe(NativeNotification.prototype, 'constructor')
      if (made?.configurable) define(NativeNotification.prototype, 'constructor', { ...made, value: Notification })
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
          const value = apply(readState, this, [])
          return value === 'denied' && stateOf(text(apply(readName, this, []))) === 'prompt' ? 'prompt' : value
        },
      })
    }
  }

  // alert, confirm and prompt: Orbit's dialog over this page (NV-24). The arguments convert as the
  // engine's do (a template literal throws on a Symbol, as DOMString does); `confirm` and `prompt`
  // take "" for a missing or undefined argument, `alert` only for a missing one.
  const asText = (args: unknown[], at: number, optional: boolean): string =>
    args.length <= at || (optional && args[at] === undefined) ? '' : `${args[at]}`
  const answers: Record<'alert' | 'confirm' | 'prompt', (args: unknown[]) => unknown> = {
    alert: (args) => {
      ask('alert', asText(args, 0, false), '')
      return undefined
    },
    confirm: (args) => ask('confirm', asText(args, 0, true), '') === true,
    prompt: (args) => {
      const value = ask('prompt', asText(args, 0, true), asText(args, 1, true))
      return typeof value === 'string' ? value : null
    },
  }
  for (const name of ['alert', 'confirm', 'prompt'] as const) {
    const native = window[name]
    const own = describe(window, name)
    if (typeof native !== 'function' || !own?.configurable) continue
    const answer = answers[name]
    // A Proxy keeps the engine's name, length and toString.
    define(window, name, { ...own, value: new Proxy(native, { apply: (_target, _self, args) => answer(args) }) })
  }
}

type AskDialog = (kind: 'alert' | 'confirm' | 'prompt', message: string, value: string) => unknown

/** Set while the page is going (beforeunload, pagehide, unload): the engine shows no dialog then. */
let dismissing = false

const askDialog: AskDialog = (kind, message, value) => {
  if (dismissing) return null
  try {
    return ipcRenderer.sendSync(PAGE_CHANNEL.dialog, kind, message, value)
  } catch {
    return null
  }
}

/**
 * The engine ignores `alert`, `confirm` and `prompt` while a page is going: so does Orbit's dialog.
 * These listeners come before the page's, so the flag is up for all of its handlers.
 */
function watchDismissal(): void {
  for (const type of ['beforeunload', 'pagehide', 'unload']) {
    window.addEventListener(
      type,
      (event) => {
        if (!event.isTrusted) return
        dismissing = true
        // A navigation the warning stopped leaves the page as it was.
        setTimeout(() => {
          dismissing = false
        }, 0)
      },
      true,
    )
  }
  window.addEventListener('pageshow', () => {
    dismissing = false
  })
}

interface StoppedNavigation {
  url: string
  type: string
  /** The form a submission came from, and its submit button. */
  form?: WeakRef<HTMLFormElement>
  submitter?: WeakRef<HTMLElement>
}

/**
 * The leave-page warning (NV-24), asked from main in this preload's own world, where the page can't
 * see or replace it (src/main/pages/leave.ts): `globalThis.__orbitLeave` there.
 *
 * - `probe()`: whether the page would warn before it goes, where Orbit closes or discards a page
 *   itself (closing a tab or a window, auto-archive), since the engine runs the real `beforeunload`
 *   only for navigations. As Chromium, only a page that has had a user gesture warns, and only if
 *   its handlers cancel the event or set a `returnValue`. The handlers see an untrusted event, and
 *   their dialogs are ignored, as during the real one.
 * - `stopped()`: what the page's own navigation that a warning just stopped was (`reload`, `push`,
 *   `replace`, `traverse`), or "" when there is none this frame knows of: a navigation is known
 *   here from the Navigation API's `navigate` event, which comes just before `beforeunload`.
 * - `redo()`: starts that navigation again (the user chose Leave; main lets the next warning
 *   through): a link or `location` loads its URL, a form is submitted again, a reload reloads.
 */
function exposeLeave(): void {
  const nav = (window as { navigation?: EventTarget }).navigation
  /** The last cross-document navigation the page started, until its task ends. */
  let starting: StoppedNavigation | null = null
  /** The navigation the last real `beforeunload` was for. */
  let stopped: StoppedNavigation | null = null
  nav?.addEventListener('navigate', (event) => {
    const e = event as Event & {
      destination?: { url?: string; sameDocument?: boolean }
      navigationType?: string
      formData?: FormData | null
      sourceElement?: Element | null
    }
    if (!e.destination?.url || e.destination.sameDocument) return
    const source = e.sourceElement ?? null
    const form = e.formData
      ? source instanceof HTMLFormElement
        ? source
        : (source as HTMLButtonElement | null)?.form
      : null
    starting = {
      url: e.destination.url,
      type: e.navigationType ?? 'push',
      ...(form ? { form: new WeakRef(form) } : {}),
      ...(form && source instanceof HTMLElement && source !== form ? { submitter: new WeakRef(source) } : {}),
    }
    setTimeout(() => {
      starting = null
    }, 0)
  })
  window.addEventListener(
    'beforeunload',
    (event) => {
      if (event.isTrusted) stopped = starting
    },
    true,
  )
  const probe = (): boolean => {
    if (!navigator.userActivation?.hasBeenActive) return false
    const event = document.createEvent('BeforeUnloadEvent')
    event.initEvent('beforeunload', false, true)
    const was = dismissing
    dismissing = true
    try {
      window.dispatchEvent(event)
    } finally {
      dismissing = was
    }
    return event.defaultPrevented || (typeof event.returnValue === 'string' && event.returnValue !== '')
  }
  const redo = (): boolean => {
    const again = stopped
    stopped = null
    if (!again || again.type === 'traverse') return false
    if (again.type === 'reload') location.reload()
    else if (again.form) {
      const form = again.form.deref()
      const submitter = again.submitter?.deref()
      if (!form?.isConnected) return false
      try {
        form.requestSubmit((submitter as HTMLButtonElement | undefined)?.form === form ? submitter : null)
      } catch {
        // The form changed: the user submits it again.
        return false
      }
    } else if (again.type === 'replace') location.replace(again.url)
    else location.assign(again.url)
    return true
  }
  Object.defineProperty(globalThis, '__orbitLeave', {
    value: Object.freeze({ probe, stopped: () => stopped?.type ?? '', redo }),
  })
}

type PatchListener = (seq: number, patches: StatePatch[]) => void

/**
 * An internal page's bridge (DT-13): the one Orbit's UI has (src/preload/shell.ts), on this
 * preload's own channels (D40, D53). Main answers it only from a tab's main frame showing an
 * `orbit:` page, runs only the commands listed for that page, and takes no events from it
 * (src/main/devtools/internal-pages.ts). `windowId` is the window the tab was in when it loaded.
 */
function exposeInternalPage(windowId: string): void {
  // As in the shell's preload: the state is on its way, and changes are kept, before the page runs.
  const patchListeners = new Set<PatchListener>()
  const earlyPatches: [number, StatePatch[]][] = []
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  ipcRenderer.on(PAGE_CHANNEL.internalEvent, (_event, channel: string, ...args: unknown[]) => {
    if (channel !== 'orbit:patches') {
      for (const listener of listeners.get(channel) ?? []) listener(args[0])
      return
    }
    const [seq, patches] = args as [number, StatePatch[]]
    if (patchListeners.size === 0) {
      if (earlyPatches.length < 2000) earlyPatches.push([seq, patches])
      return
    }
    for (const listener of patchListeners) listener(seq, patches)
  })
  let prefetched: Promise<{ state: OrbitState; seq: number }> | undefined = ipcRenderer.invoke(
    PAGE_CHANNEL.internalState,
  )

  const bridge: OrbitBridge = {
    windowId,
    view: 'internal',
    platform: process.platform,
    invoke: (name, args) => ipcRenderer.invoke(PAGE_CHANNEL.internalInvoke, name, args),
    // Events are for Orbit's own UI (D53).
    send: () => {},
    getState: () => {
      const pending = prefetched ?? ipcRenderer.invoke(PAGE_CHANNEL.internalState)
      prefetched = undefined
      return pending
    },
    onPatches: (listener) => {
      patchListeners.add(listener)
      for (const [seq, patches] of earlyPatches.splice(0)) listener(seq, patches)
      return () => patchListeners.delete(listener)
    },
    on: (channel, listener) => {
      const key = `orbit:${channel}`
      const set = listeners.get(key) ?? new Set()
      listeners.set(key, set)
      const handler = (payload: unknown) => listener(payload)
      set.add(handler)
      return () => set.delete(handler)
    },
  }
  contextBridge.exposeInMainWorld('orbit', bridge)
}

/**
 * Esc on a loading page (KS-19, D59): once every handler of the page has had a trusted Esc, main
 * learns one bit, whether the page used it (preventDefault). Main stops the load only if it didn't.
 * Runs in this preload's own world: nothing is added to the page, and nothing else is sent.
 */
function watchEscape(): void {
  if (window.top !== window) return
  window.addEventListener(
    'keydown',
    (event) => {
      if (!event.isTrusted || event.key !== 'Escape') return
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      // After the whole dispatch: the page's handlers have all run.
      setTimeout(() => ipcRenderer.send(PAGE_CHANNEL.escape, event.defaultPrevented === true), 0)
    },
    true,
  )
}

watchEscape()

if (location.protocol === 'orbit:') {
  // An internal page. Main says no (null) to anything but a tab's main frame showing one.
  if (window.top === window) {
    const hello: unknown = ipcRenderer.sendSync(PAGE_CHANNEL.internalHello)
    const windowId = (hello as { windowId?: unknown } | null)?.windowId
    if (typeof windowId === 'string') exposeInternalPage(windowId)
  }
} else {
  try {
    contextBridge.executeInMainWorld({ func: patchPage, args: [permissionState, notificationClicked, askDialog] })
  } catch {
    // A page without its own world to patch keeps the engine's answers.
  }
  if (window.top === window) {
    watchDismissal()
    exposeLeave()
  }
}
