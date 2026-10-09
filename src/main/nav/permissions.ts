import { basename } from 'node:path'
import {
  webContents as allContents,
  BrowserWindow,
  type DesktopCapturerSource,
  desktopCapturer,
  dialog,
  type Rectangle,
  type WebContents,
} from 'electron'
import { peekShown } from '../../shared/nav'
import {
  type DeviceKind,
  deviceKey,
  deviceLabel,
  type EngineDevice,
  kindsOf,
  ONE_TIME_KINDS,
  PERMISSION_ASK,
  type PermissionKind,
  type PermissionPrompt,
  type PromptChoice,
  permissionOrigin,
  type SitePermissionRow,
  siteLabel,
  sortKinds,
} from '../../shared/site'
import type { ProfileId, TabId, WindowId } from '../../shared/state'
import { locate } from '../../shared/tree'
import type { MainContext } from '../context'
import type { PermissionHandler, PermissionRequestDetails } from '../sessions'
import { activeTabOf } from '../windows'
import type { SitePrefs } from './site-prefs'

/**
 * Granted without asking, as in Chrome: harmless, or started by the user (full screen, writing the
 * clipboard…). Everything else that isn't a permission Orbit asks about (`kindsOf`) is refused.
 */
const ALWAYS_ALLOW = new Set([
  'fullscreen',
  'clipboard-sanitized-write',
  'pointerLock',
  'keyboardLock',
  'speaker-selection',
  'mediaKeySystem',
  'screen-wake-lock',
  'sensors',
  'background-sync',
  'background-fetch',
  'periodic-background-sync',
])

/** Device APIs: a site may ask, and the chooser asks the user for each device. */
const DEVICE_APIS = new Set(['serial', 'usb', 'hid'])

/** The prompt's card in its own view (sidebar hidden): width, and the shadow's margin around it. */
export const PROMPT_VIEW = { width: 320, margin: 12, inset: 10, estimate: 168 }

interface Pending {
  prompt: PermissionPrompt
  tabId: TabId
  profileId: ProfileId
  /** The tab's navigation count when asked: a request from a page that was since left is dropped. */
  nav: number
  /** Ends the request with the user's answer (dismiss when the page went away). */
  settle: (choice: PromptChoice, pick?: string) => void
  /** Identical permission requests while one waits share its prompt (permission prompts only). */
  key?: string
  callbacks?: ((granted: boolean) => void)[]
  /** Updates a chooser's list as devices come and go. */
  updateDevices?: (change: (devices: EngineDevice[]) => EngineDevice[]) => void
}

export interface Permissions {
  /** What the site controls panel lists for a site: permissions it was given, refused or asked for. */
  rows(profileId: ProfileId, origin: string): SitePermissionRow[]
  /** A switch in the site controls panel: allow or block a permission (NV-16). */
  set(profileId: ProfileId, origin: string, kind: PermissionKind, allowed: boolean): void
  /** Forgets every permission choice of a site (it asks again). */
  reset(profileId: ProfileId, origin: string): void
  /** Test hooks. */
  info(windowId: WindowId): { placed: boolean; bounds?: Rectangle }
}

/**
 * Permission prompts (NV-15). A site asking for the camera, microphone, location, notifications,
 * clipboard, MIDI, device use, a device (serial, USB, HID) or a screen to share gets a small prompt
 * under the address display, at the top of the sidebar (in a view over the page's top-left corner
 * while the sidebar is hidden). Choices are kept per profile and site (`SitePrefs`; private
 * windows' in memory only) and the site controls panel shows and changes them (NV-16). "Allow this
 * time" lasts while a page of the site stays open. Leaving the page or closing the tab drops its
 * prompts; switching tabs hides them until the tab is back. Requests from pages without a sidebar
 * (pop-up windows, Mini Windows, Peek) get a plain dialog.
 */
export function registerPermissions(ctx: MainContext, prefs: SitePrefs): Permissions {
  const { store, commands, tabs, windows } = ctx
  const queues = new Map<TabId, Pending[]>()
  const navCount = new Map<TabId, number>()
  /** "Allow this time": `profile|origin|kind` → pages of that site that keep it. */
  const once = new Map<string, Set<number>>()
  /** Which pages hold which one-time grants (dropped as they leave the site or close). */
  const onceByContents = new Map<number, Set<string>>()
  /** Permissions sites asked for since launch, so the panel lists them even without a choice. */
  const asked = new Map<string, Set<PermissionKind>>()
  /** Screen pickers' previews, by prompt. */
  const thumbnails = new Map<number, Record<string, string>>()
  /** Heights the prompt view's card reported, per window. */
  const promptHeights = new Map<WindowId, number>()
  let nextId = 0

  const siteKey = (profileId: ProfileId, origin: string) => `${profileId}|${origin}`
  const onceKey = (profileId: ProfileId, origin: string, kind: PermissionKind) => `${profileId}|${origin}|${kind}`

  const noteAsked = (profileId: ProfileId, origin: string, kinds: PermissionKind[]) => {
    const key = siteKey(profileId, origin)
    let set = asked.get(key)
    if (!set) {
      set = new Set()
      asked.set(key, set)
    }
    for (const k of kinds) set.add(k)
  }

  const hasOnce = (profileId: ProfileId, origin: string, kind: PermissionKind) =>
    (once.get(onceKey(profileId, origin, kind))?.size ?? 0) > 0

  const grantOnce = (profileId: ProfileId, origin: string, kind: PermissionKind, contents: WebContents) => {
    const key = onceKey(profileId, origin, kind)
    let holders = once.get(key)
    if (!holders) {
      holders = new Set()
      once.set(key, holders)
    }
    holders.add(contents.id)
    let keys = onceByContents.get(contents.id)
    if (!keys) {
      keys = new Set()
      onceByContents.set(contents.id, keys)
    }
    keys.add(key)
  }

  /** A page left its site or closed: the one-time grants it held go (`keep` names the site it is on now). */
  const releaseOnce = (contentsId: number, keepOrigin?: string | null) => {
    const keys = onceByContents.get(contentsId)
    if (!keys) return
    for (const key of [...keys]) {
      const origin = key.split('|')[1]
      if (keepOrigin && origin === keepOrigin) continue
      keys.delete(key)
      const holders = once.get(key)
      holders?.delete(contentsId)
      if (holders && holders.size === 0) once.delete(key)
    }
    if (keys.size === 0) onceByContents.delete(contentsId)
  }

  const clearOnce = (profileId: ProfileId, origin: string, kind?: PermissionKind) => {
    const prefix = kind ? onceKey(profileId, origin, kind) : `${profileId}|${origin}|`
    for (const key of [...once.keys()]) {
      if (kind ? key !== prefix : !key.startsWith(prefix)) continue
      for (const id of once.get(key) ?? []) onceByContents.get(id)?.delete(key)
      once.delete(key)
    }
  }

  /** Whether a permission is granted right now: allowed, or allowed this time. */
  const allowedNow = (profileId: ProfileId, origin: string, kind: PermissionKind) =>
    prefs.permission(profileId, origin, kind) === 'allow' || hasOnce(profileId, origin, kind)

  /** The site a request belongs to: the top page's, as in Chromium (a frame uses what its page was given). */
  const requestOrigin = (contents: WebContents, details: { isMainFrame?: boolean; requestingUrl?: string }) => {
    const top = contents.isDestroyed() ? '' : contents.getURL()
    return permissionOrigin(
      details.isMainFrame && details.requestingUrl ? details.requestingUrl : top || details.requestingUrl,
    )
  }

  /** A tab that shows its prompt in a window's sidebar (or the page's corner): one in a Space, not Peek or a Mini Window. */
  const promptable = (tabId: TabId | undefined): tabId is TabId => {
    if (!tabId) return false
    const state = store.state
    return !!state.tabs[tabId] && !!locate(state, tabId)
  }

  // ---------- The queue on each tab ----------

  const syncTab = (tabId: TabId) => {
    const head = queues.get(tabId)?.[0]
    const tab = store.state.tabs[tabId]
    if (!tab) return
    const current = tab.permissionPrompt
    if (head ? JSON.stringify(current) === JSON.stringify(head.prompt) : current === undefined) return
    store.update((d) => {
      const t = d.tabs[tabId]
      if (!t) return
      if (head) t.permissionPrompt = head.prompt
      else delete t.permissionPrompt
    })
  }

  const enqueue = (pending: Pending) => {
    let queue = queues.get(pending.tabId)
    if (!queue) {
      queue = []
      queues.set(pending.tabId, queue)
    }
    queue.push(pending)
    syncTab(pending.tabId)
  }

  /** Ends a request: out of its queue, then the next one shows. */
  const finish = (pending: Pending, choice: PromptChoice, pick?: string) => {
    const queue = queues.get(pending.tabId)
    const at = queue ? queue.indexOf(pending) : -1
    if (at < 0) return
    queue?.splice(at, 1)
    if (queue && queue.length === 0) queues.delete(pending.tabId)
    thumbnails.delete(pending.prompt.id)
    try {
      pending.settle(choice, pick)
    } catch (err) {
      console.error('[permissions] answer failed', err)
    }
    syncTab(pending.tabId)
  }

  /** Drops a tab's prompts (its page went away), or only those asked before navigation `before`. */
  const dropTab = (tabId: TabId, before?: number) => {
    const queue = queues.get(tabId)
    if (!queue) return
    for (const pending of [...queue]) if (before === undefined || pending.nav < before) finish(pending, 'dismiss')
  }

  // ---------- Permission requests ----------

  const askPermission = (
    profileId: ProfileId,
    contents: WebContents,
    tabId: TabId,
    origin: string,
    kinds: PermissionKind[],
    callback: (granted: boolean) => void,
  ) => {
    const key = `${origin}|${kinds.join(',')}`
    const waiting = queues.get(tabId)?.find((p) => p.key === key && p.prompt.type === 'permission')
    if (waiting) {
      waiting.callbacks?.push(callback)
      return
    }
    const callbacks = [callback]
    const pending: Pending = {
      prompt: {
        id: ++nextId,
        type: 'permission',
        origin,
        kinds,
        oneTime: kinds.every((k) => ONE_TIME_KINDS.has(k)),
      },
      tabId,
      profileId,
      nav: navCount.get(tabId) ?? 0,
      key,
      callbacks,
      settle: (choice) => {
        if (choice === 'allow' || choice === 'block') {
          for (const k of kinds) prefs.setPermission(profileId, origin, k, choice)
        } else if (choice === 'once' && !contents.isDestroyed()) {
          for (const k of kinds) grantOnce(profileId, origin, k, contents)
        }
        const granted = choice === 'allow' || choice === 'once'
        for (const cb of callbacks) cb(granted)
      },
    }
    enqueue(pending)
  }

  /** Pages without a sidebar (pop-up windows, Mini Windows, Peek): a plain dialog asks instead. */
  const askInDialog = (
    profileId: ProfileId,
    contents: WebContents,
    origin: string,
    kinds: PermissionKind[],
    callback: (granted: boolean) => void,
  ) => {
    if (ctx.e2e) return callback(false)
    const parent = BrowserWindow.getFocusedWindow()
    const options = {
      type: 'question' as const,
      buttons: ['Allow', 'Block'],
      defaultId: 1,
      cancelId: 1,
      message: `${siteLabel(origin)} wants to:`,
      detail: kinds.map((k) => PERMISSION_ASK[k]).join('\n'),
    }
    void (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)).then(({ response }) => {
      const allowed = response === 0
      for (const k of kinds) prefs.setPermission(profileId, origin, k, allowed ? 'allow' : 'block')
      if (!contents.isDestroyed()) callback(allowed)
    })
  }

  /** Saving to (or reading) a file the page was given: asked each time, never remembered. */
  const askFile = (
    profileId: ProfileId,
    contents: WebContents,
    details: PermissionRequestDetails,
    callback: (granted: boolean) => void,
  ) => {
    const tabId = tabs.tabIdFor(contents)
    const origin = requestOrigin(contents, details)
    const file = details as { filePath?: string; isDirectory?: boolean; fileAccessType?: string }
    if (!origin || !promptable(tabId)) return callback(false)
    enqueue({
      prompt: {
        id: ++nextId,
        type: 'file',
        origin,
        name: file.filePath ? basename(file.filePath) : '',
        directory: !!file.isDirectory,
        write: file.fileAccessType === 'writable',
      },
      tabId,
      profileId,
      nav: navCount.get(tabId) ?? 0,
      settle: (choice) => callback(choice === 'allow' || choice === 'once'),
    })
  }

  const handler: PermissionHandler = {
    check: (profileId, _contents, permission, requestingOrigin, details) => {
      if (ALWAYS_ALLOW.has(permission)) return true
      const origin = permissionOrigin(details.embeddingOrigin || requestingOrigin)
      if (!origin) return false
      if (DEVICE_APIS.has(permission)) return true
      const kinds = kindsOf(permission, details.mediaType ? [details.mediaType] : undefined)
      if (!kinds) return false
      return kinds.every((k) => allowedNow(profileId, origin, k))
    },
    request: (profileId, contents, permission, callback, details) => {
      if (ALWAYS_ALLOW.has(permission)) return callback(true)
      if (permission === 'fileSystem') return askFile(profileId, contents, details, callback)
      const media = 'mediaTypes' in details ? details.mediaTypes : undefined
      const kinds = kindsOf(permission, media)
      const origin = requestOrigin(contents, details)
      if (!kinds || !origin) return callback(false)
      noteAsked(profileId, origin, kinds)
      if (kinds.some((k) => prefs.permission(profileId, origin, k) === 'block')) return callback(false)
      const undecided = sortKinds(kinds.filter((k) => !allowedNow(profileId, origin, k)))
      if (undecided.length === 0) return callback(true)
      const tabId = tabs.tabIdFor(contents)
      if (!promptable(tabId)) return askInDialog(profileId, contents, origin, undecided, callback)
      askPermission(profileId, contents, tabId, origin, undecided, callback)
    },
    decision: (profileId, origin, permission) => {
      const kinds = kindsOf(permission)
      const site = permissionOrigin(origin)
      if (!kinds || !site) return undefined
      const choices = kinds.map((k) => prefs.permission(profileId, site, k))
      if (choices.some((c) => c === 'block')) return false
      return choices.every((c) => c === 'allow') ? true : undefined
    },
    decide: (profileId, origin, permission, allowed) => {
      const kinds = kindsOf(permission)
      const site = permissionOrigin(origin)
      if (!kinds || !site) return
      for (const k of kinds) prefs.setPermission(profileId, site, k, allowed ? 'allow' : 'block')
    },
  }
  ctx.sessions.setPermissionHandler(handler)

  // ---------- Device choosers (Web Serial, WebUSB, WebHID) ----------

  const askDevice = (
    profileId: ProfileId,
    contents: WebContents | undefined,
    type: DeviceKind,
    list: EngineDevice[],
    idOf: (d: EngineDevice) => string | undefined,
    choose: (id: string | undefined) => void,
  ): Pending | undefined => {
    const tabId = contents ? tabs.tabIdFor(contents) : undefined
    const origin = contents && !contents.isDestroyed() ? permissionOrigin(contents.getURL()) : null
    if (!origin || !promptable(tabId)) {
      choose(undefined)
      return undefined
    }
    let devices = list
    const options = () =>
      devices.flatMap((d) => {
        const id = idOf(d)
        return id ? [{ id, name: deviceLabel(type, d) }] : []
      })
    const prompt: PermissionPrompt = { id: ++nextId, type: 'device', origin, device: type, devices: options() }
    const pending: Pending = {
      prompt,
      tabId,
      profileId,
      nav: navCount.get(tabId) ?? 0,
      settle: (choice, pick) => {
        const device = choice === 'allow' && pick ? devices.find((d) => idOf(d) === pick) : undefined
        if (device) {
          prefs.grantDevice(profileId, origin, { type, key: deviceKey(type, device), name: deviceLabel(type, device) })
        }
        choose(device ? pick : undefined)
      },
      updateDevices: (change) => {
        devices = change(devices)
        pending.prompt = { ...prompt, devices: options() }
        syncTab(tabId)
      },
    }
    enqueue(pending)
    return pending
  }

  /** The chooser waiting for a page, to update its list as devices come and go. */
  const chooserFor = (contents: WebContents | undefined, type: DeviceKind): Pending | undefined => {
    const tabId = contents ? tabs.tabIdFor(contents) : undefined
    return tabId
      ? queues.get(tabId)?.find((p) => p.prompt.type === 'device' && p.prompt.device === type && !!p.updateDevices)
      : undefined
  }

  const contentsOfFrame = (frame: Electron.WebFrameMain | null | undefined): WebContents | undefined => {
    if (!frame) return undefined
    try {
      return allContents.fromFrame(frame)
    } catch {
      return undefined
    }
  }

  // ---------- Screen sharing (getDisplayMedia) ----------

  const askScreen = (
    profileId: ProfileId,
    contents: WebContents | undefined,
    origin: string | null,
    audio: boolean,
    callback: (streams: { video: DesktopCapturerSource; audio?: 'loopback' } | null) => void,
  ) => {
    const tabId = contents ? tabs.tabIdFor(contents) : undefined
    if (!origin || !promptable(tabId)) return callback(null)
    const navAtAsk = navCount.get(tabId) ?? 0
    desktopCapturer
      .getSources({ types: ['screen', 'window'], thumbnailSize: { width: 240, height: 150 }, fetchWindowIcons: false })
      .then((sources) => {
        if (!contents || contents.isDestroyed() || (navCount.get(tabId) ?? 0) !== navAtAsk) return callback(null)
        const prompt: PermissionPrompt = {
          id: ++nextId,
          type: 'screen',
          origin,
          sources: sources.map((s) => ({ id: s.id, name: s.name, screen: s.id.startsWith('screen:') })),
        }
        const previews: Record<string, string> = {}
        for (const s of sources) if (!s.thumbnail.isEmpty()) previews[s.id] = s.thumbnail.toDataURL()
        thumbnails.set(prompt.id, previews)
        enqueue({
          prompt,
          tabId,
          profileId,
          nav: navAtAsk,
          settle: (choice, pick) => {
            const source = choice === 'allow' && pick ? sources.find((s) => s.id === pick) : undefined
            if (!source) return callback(null)
            // Sound comes along only where the system can share it (Windows).
            callback(audio && process.platform === 'win32' ? { video: source, audio: 'loopback' } : { video: source })
          },
        })
      })
      .catch(() => callback(null))
  }

  ctx.sessions.onSessionCreated((ses, profileId) => {
    ses.on('select-serial-port', (event, portList, contents, callback) => {
      event.preventDefault()
      askDevice(
        profileId,
        contents,
        'serial',
        portList as EngineDevice[],
        (d) => d.portId,
        (id) => callback(id ?? ''),
      )
    })
    ses.on('serial-port-added', (_event, port, contents) => {
      chooserFor(contents, 'serial')?.updateDevices?.((list) => [
        ...list.filter((d) => d.portId !== port.portId),
        port as EngineDevice,
      ])
    })
    ses.on('serial-port-removed', (_event, port, contents) => {
      chooserFor(contents, 'serial')?.updateDevices?.((list) => list.filter((d) => d.portId !== port.portId))
    })
    ses.on('select-usb-device', (event, details, callback) => {
      event.preventDefault()
      askDevice(
        profileId,
        contentsOfFrame(details.frame),
        'usb',
        details.deviceList as EngineDevice[],
        (d) => d.deviceId,
        (id) => callback(id),
      )
    })
    ses.on('usb-device-added', (_event, device, contents) => {
      chooserFor(contents, 'usb')?.updateDevices?.((list) => [
        ...list.filter((d) => d.deviceId !== device.deviceId),
        device as EngineDevice,
      ])
    })
    ses.on('usb-device-removed', (_event, device, contents) => {
      chooserFor(contents, 'usb')?.updateDevices?.((list) => list.filter((d) => d.deviceId !== device.deviceId))
    })
    ses.on('select-hid-device', (event, details, callback) => {
      event.preventDefault()
      askDevice(
        profileId,
        contentsOfFrame(details.frame),
        'hid',
        details.deviceList as EngineDevice[],
        (d) => d.deviceId,
        (id) => callback(id ?? null),
      )
    })
    ses.setDevicePermissionHandler((details) => {
      const origin = permissionOrigin(details.origin)
      const type = details.deviceType as DeviceKind
      if (!origin || !DEVICE_APIS.has(type)) return false
      const key = deviceKey(type, details.device as EngineDevice)
      return prefs.devicesFor(profileId, origin).some((g) => g.key === key)
    })
    ses.setDisplayMediaRequestHandler(
      (request, callback) => {
        const contents = contentsOfFrame(request.frame)
        const origin = contents && !contents.isDestroyed() ? permissionOrigin(contents.getURL()) : null
        if (!request.videoRequested) return callback(null)
        askScreen(profileId, contents, origin, request.audioRequested, callback)
      },
      // macOS 15 and later show the system's own picker.
      { useSystemPicker: true },
    )
  })

  // ---------- Answers from the prompt ----------

  const findPending = (id: number): Pending | undefined => {
    for (const queue of queues.values()) {
      const found = queue.find((p) => p.prompt.id === id)
      if (found) return found
    }
    return undefined
  }

  commands.register('permissions.answer', ({ id, choice, pick }) => {
    const pending = findPending(id)
    if (pending) finish(pending, choice, pick)
  })
  commands.register('permissions.thumbnails', ({ id }) => thumbnails.get(id) ?? {})
  commands.register('permissions.promptSize', ({ height }, c) => {
    const windowId = c.windowId
    if (!windowId || !(height > 0)) return
    const rounded = Math.ceil(height)
    if (promptHeights.get(windowId) === rounded) return
    promptHeights.set(windowId, rounded)
    place(windowId)
  })

  // ---------- The prompt over the page while the sidebar is hidden ----------

  const place = (windowId: WindowId) => {
    const state = store.state
    const win = state.windows[windowId]
    const tabId = activeTabOf(state, windowId)
    const prompt = tabId ? state.tabs[tabId]?.permissionPrompt : undefined
    const page = tabId ? windows.tabViewBounds(tabId) : undefined
    // The sidebar shows it (docked, or the floating card while that is out over the corner); a
    // Peek covers the page and its page's own requests ask in a dialog.
    const inSidebar = win?.sidebar.visible || win?.sidebar.peeking
    const covered = peekShown(state, windowId) || windows.inHtmlFullscreen(windowId)
    if (!win || !prompt || !page || inSidebar || covered) {
      windows.hidePrompt(windowId)
      return
    }
    const { width, margin, inset, estimate } = PROMPT_VIEW
    const height = Math.min(promptHeights.get(windowId) ?? estimate, Math.max(80, page.height - 2 * inset))
    windows.showPrompt(windowId, {
      x: page.x + inset - margin,
      y: page.y + inset - margin,
      width: Math.min(width, Math.max(160, page.width - 2 * inset)) + 2 * margin,
      height: height + 2 * margin,
    })
  }

  const placeAll = () => {
    for (const windowId of windows.ids()) place(windowId)
  }
  store.subscribe((next, prev) => {
    if (next.windows === prev.windows && next.tabs === prev.tabs) return
    placeAll()
  })
  windows.onLayout((windowId) => place(windowId))

  // ---------- Pages come and go ----------

  ctx.hooks.tabCreated.push((tabId, contents) => {
    const contentsId = contents.id
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) navCount.set(tabId, (navCount.get(tabId) ?? 0) + 1)
    })
    contents.on('did-navigate', (_event, url) => {
      // Prompts of the page that was left go; "Allow this time" goes with the site.
      dropTab(tabId, navCount.get(tabId) ?? 0)
      releaseOnce(contentsId, permissionOrigin(url))
    })
    contents.once('destroyed', () => {
      dropTab(tabId)
      releaseOnce(contentsId)
      navCount.delete(tabId)
    })
  })
  // A tab that went away entirely.
  store.subscribe((next, prev) => {
    if (next.tabs === prev.tabs) return
    for (const tabId of queues.keys()) if (!next.tabs[tabId]) dropTab(tabId)
  })

  return {
    rows: (profileId, origin) => {
      const choices = prefs.permissionsFor(profileId, origin)
      const kinds = new Set<PermissionKind>(Object.keys(choices) as PermissionKind[])
      for (const k of asked.get(siteKey(profileId, origin)) ?? []) kinds.add(k)
      for (const key of once.keys()) {
        const [p, o, k] = key.split('|')
        if (p === profileId && o === origin) kinds.add(k as PermissionKind)
      }
      kinds.delete('popups')
      return sortKinds(kinds).map((kind) => {
        const choice = choices[kind]
        const state = choice ?? (hasOnce(profileId, origin, kind) ? 'once' : 'ask')
        return { kind, state }
      })
    },
    set: (profileId, origin, kind, allowed) => {
      clearOnce(profileId, origin, kind)
      noteAsked(profileId, origin, [kind])
      prefs.setPermission(profileId, origin, kind, allowed ? 'allow' : 'block')
    },
    reset: (profileId, origin) => {
      clearOnce(profileId, origin)
      for (const kind of Object.keys(prefs.permissionsFor(profileId, origin)) as PermissionKind[]) {
        prefs.setPermission(profileId, origin, kind, undefined)
      }
      for (const grant of prefs.devicesFor(profileId, origin)) prefs.revokeDevice(profileId, origin, grant.key)
    },
    info: (windowId) => {
      const placed = windows.promptInfo(windowId)
      return { placed: placed.placed, bounds: placed.placed ? placed.bounds : undefined }
    },
  }
}
