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
 * and how many of the page's shared-screen tracks are live (D69: for its tab's sharing indicators
 * only, MD-11, TB-15).
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

const screenShared = (count: number) => {
  ipcRenderer.send(PAGE_CHANNEL.screenShare, count)
}

/**
 * Runs in the page's own world before its scripts (serialized: it may use only its arguments and
 * the page's globals). Built-ins are taken up front, so a page that replaces them later can't reach
 * Orbit's functions through them.
 */
function patchPage(stateOf: StateOf, clicked: () => void, shared: (count: number) => void) {
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
    contextBridge.executeInMainWorld({ func: patchPage, args: [permissionState, notificationClicked, screenShared] })
  } catch {
    // A page without its own world to patch keeps the engine's answers.
  }
}
