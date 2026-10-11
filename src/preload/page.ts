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
 * In every page's main frame, it also tells main whether the page used an Esc (D59, `watchEscape`),
 * of a two-finger swipe the page doesn't take (NV-02, `watchSwipe`), and how many of the page's
 * shared-screen tracks are live (D69: for its tab's sharing indicators only, MD-11, TB-15).
 *
 * In a web page's main frame, the page's `alert`, `confirm` and `prompt` ask main, which shows
 * Orbit's dialog over that page only (NV-24): Electron has no `prompt`, and shows the others as
 * app-wide boxes. A frame has no preload (D40), so a dialog a frame asks for itself is the engine's
 * own box (and a frame's `prompt` returns null). Its `window.print()` opens Orbit's print dialog over
 * the page (NV-07), and its `window.close()` waits while that dialog is open (`holdForPrint`); a
 * frame's `print()` is the engine's, the system's own dialog. It also answers main about the
 * leave-page warning (`exposeLeave`).
 */
import { contextBridge, ipcRenderer } from 'electron'
import { isWheelNotch } from '../renderer/src/shell/spaces/physics'
import type { OrbitBridge, StatePatch } from '../shared/rpc'
import { PAGE_CHANNEL } from '../shared/site'
import type { OrbitState } from '../shared/state'
import { HistorySwipe, RELEASE_GAP_MS, type SwipeUpdate, scrollsToward } from './swipe'

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

const screenShared = (count: number) => {
  ipcRenderer.send(PAGE_CHANNEL.screenShare, count)
}

/**
 * Runs in the page's own world before its scripts (serialized: it may use only its arguments and
 * the page's globals). Built-ins are taken up front, so a page that replaces them later can't reach
 * Orbit's functions through them.
 */
function patchPage(
  stateOf: StateOf,
  clicked: () => void,
  ask: AskDialog,
  print: () => void,
  holdClose: () => boolean,
  shared: (count: number) => void,
) {
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
  // The engine shows no dialog while the page is going: in its `beforeunload`, `pagehide` or
  // `unload` handlers. Orbit tells from the event the page's handler runs for, read through the
  // engine's own getters (the page can't hide it), and adds no listener of its own: with a
  // `beforeunload` listener the engine would ask every page before each navigation, so a busy page
  // would hold up Back (D60), and an `unload` one would keep every page out of the back-forward cache.
  const currentEvent = describe(window, 'event')?.get
  const eventType = describe(Event.prototype, 'type')?.get
  const going = (): boolean => {
    if (!currentEvent || !eventType) return false
    try {
      const type: unknown = apply(eventType, apply(currentEvent, window, []), [])
      return type === 'beforeunload' || type === 'pagehide' || type === 'unload'
    } catch {
      // No event: the page isn't in a handler.
      return false
    }
  }
  const askNow: AskDialog = (kind, message, value) => (going() ? null : ask(kind, message, value))
  const answers: Record<'alert' | 'confirm' | 'prompt', (args: unknown[]) => unknown> = {
    alert: (args) => {
      askNow('alert', asText(args, 0, false), '')
      return undefined
    },
    confirm: (args) => askNow('confirm', asText(args, 0, true), '') === true,
    prompt: (args) => {
      const value = askNow('prompt', asText(args, 0, true), asText(args, 1, true))
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

  // window.print(): Orbit's print dialog over this page (NV-07), where the engine's would be the
  // system's own dialog. It returns at once, and the page goes on while the dialog shows; what
  // would take the page away waits for the dialog, as after the engine's `print()`, which returns
  // only once its dialog closes (`holdForPrint`).
  const nativePrint = window.print
  const ownPrint = describe(window, 'print')
  if (typeof nativePrint === 'function' && ownPrint?.configurable) {
    const printNow = () => {
      if (!going()) print()
    }
    define(window, 'print', { ...ownPrint, value: new Proxy(nativePrint, { apply: printNow }) })
  }
  // window.close() while the print dialog the page asked for is open: the page closes once the
  // dialog does (`holdForPrint`). Otherwise it's the engine's.
  const nativeClose = window.close
  const ownClose = describe(window, 'close')
  if (typeof nativeClose === 'function' && ownClose?.configurable) {
    const closeNow = (target: () => void, self: unknown, args: unknown[]) =>
      holdClose() ? undefined : apply(target, self, args)
    define(window, 'close', { ...ownClose, value: new Proxy(nativeClose, { apply: closeNow }) })
  }

  // Screen sharing (D69; MD-11, TB-15): main learns how many of the page's shared-screen tracks are
  // live, for the tab's sharing indicators only. One stops being shared when the page stops it or
  // its source ends (the window closed, or the system's own Stop sharing); a clone of it shares too.
  // Nothing is sent until the page shares. This sees the shares the system's own picker grants
  // (macOS 15 and later), which main never does.
  const Devices = window.MediaDevices
  const Track = window.MediaStreamTrack
  const share = Devices ? describe(Devices.prototype, 'getDisplayMedia') : undefined
  const kindOf = Track ? describe(Track.prototype, 'kind')?.get : undefined
  const stateOfTrack = Track ? describe(Track.prototype, 'readyState')?.get : undefined
  const settingsOf = Track ? describe(Track.prototype, 'getSettings')?.value : undefined
  const stop = Track ? describe(Track.prototype, 'stop') : undefined
  const clone = Track ? describe(Track.prototype, 'clone') : undefined
  const videoTracks = window.MediaStream ? describe(window.MediaStream.prototype, 'getVideoTracks')?.value : undefined
  const size = describe(Set.prototype, 'size')?.get
  const { add, has, forEach } = Set.prototype
  const remove = Set.prototype.delete
  if (
    Track &&
    share?.configurable &&
    typeof share.value === 'function' &&
    kindOf &&
    stateOfTrack &&
    typeof settingsOf === 'function' &&
    stop?.configurable &&
    typeof stop.value === 'function' &&
    clone?.configurable &&
    typeof clone.value === 'function' &&
    typeof videoTracks === 'function' &&
    size
  ) {
    const live = new Set<MediaStreamTrack>()
    let told = 0
    const isShared = (track: MediaStreamTrack) => {
      try {
        if (apply(kindOf, track, []) !== 'video') return false
        return typeof describe(apply(settingsOf, track, []), 'displaySurface')?.value === 'string'
      } catch {
        return false
      }
    }
    const settle = () => {
      apply(forEach, live, [
        (track: MediaStreamTrack) => {
          if (apply(stateOfTrack, track, []) !== 'live') apply(remove, live, [track])
        },
      ])
      const count = apply(size, live, []) as number
      if (count === told) return
      told = count
      shared(count)
    }
    const watch = (track: MediaStreamTrack) => {
      if (!isShared(track) || apply(has, live, [track])) return
      apply(add, live, [track])
      apply(listen, track, ['ended', settle])
      settle()
    }
    // Methods, as the engine's are (no prototype, can't be constructed).
    const methods = {
      getDisplayMedia(this: MediaDevices, ...args: unknown[]) {
        return apply(then, apply(share.value, this, args), [
          (stream: MediaStream) => {
            const tracks = apply(videoTracks, stream, []) as MediaStreamTrack[]
            for (let i = 0; i < tracks.length; i++) watch(tracks[i] as MediaStreamTrack)
            return stream
          },
        ])
      },
      stop(this: MediaStreamTrack) {
        const result = apply(stop.value, this, [])
        if (apply(has, live, [this])) settle()
        return result
      },
      clone(this: MediaStreamTrack) {
        const copy = apply(clone.value, this, []) as MediaStreamTrack
        if (apply(has, live, [this])) watch(copy)
        return copy
      },
    }
    define(Devices.prototype, 'getDisplayMedia', { ...share, value: methods.getDisplayMedia })
    define(Track.prototype, 'stop', { ...stop, value: methods.stop })
    define(Track.prototype, 'clone', { ...clone, value: methods.clone })
  }
}

type AskDialog = (kind: 'alert' | 'confirm' | 'prompt', message: string, value: string) => unknown

/** A navigation the page started, as the Navigation API's `navigate` event told it. */
interface PageNavigation {
  url: string
  type: string
  /** The form a submission came from, and its submit button. */
  form?: WeakRef<HTMLFormElement>
  submitter?: WeakRef<HTMLElement>
}

/**
 * The print dialog the page asked for (NV-07): whether it's open, and what the page started while it
 * was (`holdForPrint`).
 */
const printing: { open: boolean; close: boolean; navigation: PageNavigation | null } = {
  open: false,
  close: false,
  navigation: null,
}

const printDialog = () => {
  try {
    if (ipcRenderer.sendSync(PAGE_CHANNEL.print) === true) printing.open = true
  } catch {
    // No dialog: nothing waits for one.
  }
}

/** The page's `window.close()`: true when it waits for the print dialog. */
const holdClose = (): boolean => {
  if (!printing.open) return false
  printing.close = true
  return true
}

const askDialog: AskDialog = (kind, message, value) => {
  try {
    return ipcRenderer.sendSync(PAGE_CHANNEL.dialog, kind, message, value)
  } catch {
    return null
  }
}

/** Main asks which navigation a warning stopped just after it; one the page started longer ago isn't it. */
const STOPPED_MS = 2_000

/** The Navigation API's `navigate` event, as far as this reads it. */
type NavigateEventLike = Event & {
  destination?: { url?: string; sameDocument?: boolean }
  navigationType?: string
  formData?: FormData | null
  sourceElement?: Element | null
  downloadRequest?: string | null
}

/**
 * Starts a navigation of the page's again, from here: a link or `location` loads its URL (as a new
 * history entry or in place of this one, as it did), a form is submitted again, a reload reloads.
 * False when it can't be: a move through history, or a form that's gone or changed.
 */
function restart(again: PageNavigation): boolean {
  if (again.type === 'traverse') return false
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

/**
 * The leave-page warning (NV-24), asked from main in this preload's own world, where the page can't
 * see or replace it (src/main/pages/leave.ts): `globalThis.__orbitLeave` there.
 *
 * - `stopped()`: what the page's own navigation that a warning just stopped was (`reload`, `push`,
 *   `replace`, `traverse`), or "" when there is none this frame knows of. A navigation is known
 *   here from the Navigation API's `navigate` event, which comes in the same task as the
 *   `beforeunload` the warning comes from; main asks right after the warning, so the page's last
 *   navigation counts if it started within STOPPED_MS. (A `beforeunload` listener of Orbit's
 *   would tell for sure, but would cost every page: see `going` in `patchPage`.)
 * - `redo()`: starts that navigation again (the user chose Leave; main lets the next warning
 *   through): a link or `location` loads its URL, a form is submitted again, a reload reloads.
 *
 * The same `navigate` event tells main when the page sends a form (`PAGE_CHANNEL.formSent`): it may
 * be uploading, so Orbit's time limit for a server's answer leaves that navigation alone (NV-13).
 */
function exposeLeave(): void {
  const nav = (window as { navigation?: EventTarget }).navigation
  /** The last cross-document navigation the page started, its event, and when (`performance.now()`). */
  let starting: (PageNavigation & { event: Event; at: number }) | null = null
  /** The navigation main last asked about: the one a warning stopped. */
  let stopped: PageNavigation | null = null
  nav?.addEventListener('navigate', (event) => {
    const e = event as NavigateEventLike
    if (!e.destination?.url || e.destination.sameDocument) return
    if (e.formData) ipcRenderer.send(PAGE_CHANNEL.formSent, e.destination.url)
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
      event,
      at: performance.now(),
    }
  })
  // The page's own same-document navigation that finished isn't one a warning stops.
  nav?.addEventListener('navigatesuccess', () => {
    starting = null
  })
  const redo = (): boolean => {
    const again = stopped
    stopped = null
    return !!again && restart(again)
  }
  Object.defineProperty(globalThis, '__orbitLeave', {
    value: Object.freeze({
      stopped: () => {
        const last = starting
        starting = null
        // A navigation the page cancelled itself didn't reach its `beforeunload`.
        stopped = last && !last.event.defaultPrevented && performance.now() - last.at <= STOPPED_MS ? last : null
        return stopped?.type ?? ''
      },
      redo,
    }),
  })
}

/**
 * While the print dialog the page asked for is open (NV-07), what would take the page away waits,
 * as it would behind the engine's `print()`, which returns only once its dialog has closed: the
 * page's `window.close()` (patched in `patchPage`), and a navigation it starts that the Navigation
 * API lets this stop and that can start again as it was (a link, `location`, a form that gets its
 * page, a reload: the same address, and the same kind of history entry). Once main says the dialog
 * closed (`PAGE_CHANNEL.printClosed`), the close goes on, or else the page's last such navigation
 * starts again. A form the page posts goes at once (sending it again would run the page's own
 * submit handlers twice), and so does a move through history, which the engine doesn't let a
 * script stop: either takes the dialog with it.
 */
function holdForPrint(): void {
  const nav = (window as { navigation?: EventTarget }).navigation
  nav?.addEventListener('navigate', (event) => {
    const e = event as NavigateEventLike
    if (!printing.open || !e.cancelable || !e.destination?.url || e.destination.sameDocument) return
    // A download leaves the page where it is; a posted form isn't sent twice.
    if (e.downloadRequest != null || e.formData) return
    const type = e.navigationType ?? 'push'
    if (type !== 'push' && type !== 'replace' && type !== 'reload') return
    e.preventDefault()
    printing.navigation = { url: e.destination.url, type }
  })
  ipcRenderer.on(PAGE_CHANNEL.printClosed, () => {
    if (!printing.open) return
    const { close, navigation } = printing
    printing.open = false
    printing.close = false
    printing.navigation = null
    if (close) window.close()
    else if (navigation) restart(navigation)
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

/**
 * Two-finger swipe back and forward over the page (NV-02): a trusted horizontal trackpad scroll that
 * nothing under the pointer can scroll that way, and that no handler of the page used
 * (preventDefault), tells main how far it has gone, then whether it was let go with the arrow fully
 * in (`HistorySwipe`). A mouse wheel's notches and ⌃-scrolls (a pinch) never do. Runs in this
 * preload's own world, after the page's handlers: nothing is added to the page.
 */
function watchSwipe(): void {
  if (window.top !== window) return
  const swipe = new HistorySwipe()
  let lifted: ReturnType<typeof setTimeout> | undefined
  const tell = (update: SwipeUpdate | undefined) => {
    if (!update) return
    const value = update.kind === 'move' ? update.travel : update.commit
    ipcRenderer.send(PAGE_CHANNEL.swipe, update.kind, update.direction, value)
  }
  window.addEventListener(
    'wheel',
    (event) => {
      if (!event.isTrusted || event.ctrlKey || event.deltaMode !== 0) return
      const { deltaX, deltaY, target, timeStamp } = event
      const wheelDeltaX = (event as WheelEvent & { wheelDeltaX?: number }).wheelDeltaX
      if (isWheelNotch({ deltaMode: 0, deltaX, deltaY, wheelDeltaX })) return
      // After the whole dispatch: the page's handlers have all run.
      setTimeout(() => {
        tell(swipe.push(deltaX, deltaY, timeStamp, (side) => event.defaultPrevented || scrollsToward(target, side)))
        clearTimeout(lifted)
        lifted = setTimeout(() => tell(swipe.release()), RELEASE_GAP_MS)
      }, 0)
    },
    { capture: true, passive: true },
  )
}

watchSwipe()

if (location.protocol === 'orbit:') {
  // An internal page. Main says no (null) to anything but a tab's main frame showing one.
  if (window.top === window) {
    const hello: unknown = ipcRenderer.sendSync(PAGE_CHANNEL.internalHello)
    const windowId = (hello as { windowId?: unknown } | null)?.windowId
    if (typeof windowId === 'string') exposeInternalPage(windowId)
  }
} else {
  try {
    contextBridge.executeInMainWorld({
      func: patchPage,
      args: [permissionState, notificationClicked, askDialog, printDialog, holdClose, screenShared],
    })
  } catch {
    // A page without its own world to patch keeps the engine's answers.
  }
  if (window.top === window) {
    exposeLeave()
    holdForPrint()
  }
}
