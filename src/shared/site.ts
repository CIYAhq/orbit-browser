/**
 * What sites may ask for and what Orbit shows about a site (NV-15, NV-16): the permission prompt
 * under the address display and the site controls panel. Shared by main and the renderers.
 */
import type { Connection } from './nav'
import type { TabId } from './state'

/** Permissions a site asks for. Camera and microphone are separate choices, as in Chromium. */
export type PermissionKind =
  | 'camera'
  | 'microphone'
  | 'location'
  | 'notifications'
  | 'clipboard'
  | 'midi'
  | 'idle'
  | 'windows'
  | 'fonts'
  | 'network'
  | 'popups'

/** The user's lasting choice for a permission on a site. */
export type PermissionChoice = 'allow' | 'block'

/** Devices a site connects to through a chooser (Web Serial, WebUSB, WebHID). */
export type DeviceKind = 'serial' | 'usb' | 'hid'

/** The order permissions are listed in, in the prompt and the panel. */
export const PERMISSION_ORDER: readonly PermissionKind[] = [
  'camera',
  'microphone',
  'location',
  'notifications',
  'clipboard',
  'midi',
  'idle',
  'windows',
  'fonts',
  'network',
  'popups',
]

/** The prompt's line for each permission: "<site> wants to" … (NV-15). */
export const PERMISSION_ASK: Record<PermissionKind, string> = {
  camera: 'Use your camera',
  microphone: 'Use your microphone',
  location: 'Know your location',
  notifications: 'Show notifications',
  clipboard: 'See text and images copied to the clipboard',
  midi: 'Use your MIDI devices',
  idle: 'Know when you’re actively using this device',
  windows: 'Manage windows on all your displays',
  fonts: 'Use the fonts on your computer',
  network: 'Look for and connect to any device on your local network',
  popups: 'Open pop-ups',
}

/** The site controls panel's name for each permission (NV-16). */
export const PERMISSION_NAME: Record<PermissionKind, string> = {
  camera: 'Camera',
  microphone: 'Microphone',
  location: 'Location',
  notifications: 'Notifications',
  clipboard: 'Clipboard',
  midi: 'MIDI devices',
  idle: 'Device use',
  windows: 'Window management',
  fonts: 'Fonts',
  network: 'Local network access',
  popups: 'Pop-ups',
}

/** What a device chooser asks: "<site> wants to" … */
export const DEVICE_ASK: Record<DeviceKind, string> = {
  serial: 'Connect to a serial port',
  usb: 'Connect to a USB device',
  hid: 'Connect to a HID device',
}

export const DEVICE_NAME: Record<DeviceKind, string> = {
  serial: 'Serial port',
  usb: 'USB device',
  hid: 'HID device',
}

/** Permissions whose prompt offers "Allow this time", as Chromium's does. */
export const ONE_TIME_KINDS: ReadonlySet<PermissionKind> = new Set(['camera', 'microphone', 'location'])

export function isPermissionKind(value: unknown): value is PermissionKind {
  return typeof value === 'string' && (PERMISSION_ORDER as readonly string[]).includes(value)
}

/**
 * The permissions an engine permission request or check is about, or null for one Orbit doesn't
 * ask the user about. `media` names the camera and/or the microphone; when the engine doesn't say
 * which, it is both.
 */
export function kindsOf(permission: string, mediaTypes?: readonly string[]): PermissionKind[] | null {
  switch (permission) {
    case 'media': {
      const known = (mediaTypes ?? []).filter((t) => t === 'video' || t === 'audio')
      if (known.length === 0) return ['camera', 'microphone']
      const kinds: PermissionKind[] = []
      if (known.includes('video')) kinds.push('camera')
      if (known.includes('audio')) kinds.push('microphone')
      return kinds
    }
    case 'geolocation':
    case 'geolocation-approximate':
      return ['location']
    case 'notifications':
      return ['notifications']
    case 'clipboard-read':
      return ['clipboard']
    case 'midi':
    case 'midiSysex':
      return ['midi']
    case 'idle-detection':
      return ['idle']
    case 'window-management':
      return ['windows']
    case 'local-fonts':
      return ['fonts']
    case 'local-network-access':
    case 'local-network':
    case 'loopback-network':
      return ['network']
    default:
      return null
  }
}

/**
 * The permissions a page reads through `navigator.permissions.query()` (PermissionStatus.name) and
 * `Notification.permission`, as Orbit's kinds; null for one Orbit doesn't ask about. Chromium names
 * some differently on PermissionStatus ("video_capture" for the camera, underscores for hyphens).
 */
export function pagePermissionKinds(name: string): PermissionKind[] | null {
  switch (name.replaceAll('_', '-')) {
    case 'geolocation':
      return ['location']
    case 'notifications':
    case 'push':
      return ['notifications']
    case 'camera':
    case 'video-capture':
      return ['camera']
    case 'microphone':
    case 'audio-capture':
      return ['microphone']
    case 'midi':
    case 'midi-sysex':
      return ['midi']
    case 'clipboard-read':
      return ['clipboard']
    case 'idle-detection':
      return ['idle']
    case 'window-management':
      return ['windows']
    case 'local-fonts':
      return ['fonts']
    case 'local-network-access':
    case 'local-network':
    case 'loopback-network':
      return ['network']
    default:
      return null
  }
}

/** A permission's state as a page sees it: "prompt" until the user decides, as in Chromium. */
export type PagePermissionState = 'granted' | 'denied' | 'prompt'

/** Messages between the web page preload (src/preload/page.ts) and main (src/main/nav/page-bridge.ts). */
export const PAGE_CHANNEL = {
  /** sendSync(name): the PagePermissionState for a permission name, or null for the engine's answer. */
  permission: 'orbit-page:permission',
  /**
   * send(): the user clicked one of the page's notifications (NV-15). Main acts on it only for a
   * site with the notification permission, and at most once per NOTIFICATION_CLICK_GAP_MS per tab.
   */
  notificationClick: 'orbit-page:notification-click',
  /**
   * Internal pages only (DT-13, D53; main side: src/main/devtools/internal-pages.ts). Main answers
   * these only from a tab's main frame showing an `orbit:` page.
   * sendSync(): `{ windowId }` for such a frame, the window its tab is in; null for any other.
   */
  internalHello: 'orbit-page:internal-hello',
  /** invoke(): the store's state; its changes then come on `internalEvent`. */
  internalState: 'orbit-page:internal-state',
  /** invoke(name, args): a command, only one of those listed for the page (INTERNAL_PAGE_COMMANDS). */
  internalInvoke: 'orbit-page:internal-invoke',
  /** Main → page: (channel, ...args) of a state change or broadcast Orbit's UI gets. */
  internalEvent: 'orbit-page:internal-event',
  /**
   * send(used): a trusted Esc reached the page's main frame and every handler of the page has had
   * it: whether one called preventDefault (KS-19, D59). Main reads it only while it waits after an
   * Esc in a loading tab, and only from that tab's main frame (src/main/keys/escape.ts).
   */
  escape: 'orbit-page:escape',
  /**
   * send(url): the page's main frame is about to send a form (POST) to `url`, from the Navigation
   * API's `navigate` event. It may be a large upload, so Orbit's time limit for a server's answer
   * leaves that navigation alone (NV-13; main side: src/main/pages/screens.ts). Main reads it only
   * from a tab's or a pop-up's main frame.
   */
  formSent: 'orbit-page:form-sent',
  /**
   * sendSync(kind, message, value): the page called `alert`, `confirm` or `prompt` (NV-24). Main
   * shows Orbit's dialog over that page, answers only a tab's or a pop-up's main frame, and replies
   * when the user does: the page waits meanwhile, as it would for the engine's dialog
   * (src/main/pages/dialogs.ts).
   */
  dialog: 'orbit-page:dialog',
  /**
   * sendSync(): the page called `window.print()` (NV-07). Main shows Orbit's print dialog over that
   * page, for a tab's or a pop-up's main frame only, and replies at once whether the page has one
   * open now (src/main/pages/print.ts). While it does, the page's `window.close()` and the
   * navigations it starts wait (src/preload/page.ts).
   */
  print: 'orbit-page:print',
  /** Main → page: the page's print dialog closed (NV-07); what waited on it goes on. */
  printClosed: 'orbit-page:print-closed',
  /**
   * send('move', direction, travel) and send('end', direction, commit): a two-finger swipe over the
   * page that the page doesn't take (NV-02, src/preload/swipe.ts). Main shows the arrow and goes back
   * or forward, for a main frame of a page in a window's page card only (src/main/pages/swipe.ts).
   */
  swipe: 'orbit-page:swipe',
  /**
   * send(count): how many of the page's shared-screen tracks are live, on each change (D69; MD-11,
   * TB-15; main side: src/main/media/index.ts). Read only from a tab's main frame, clamped, and
   * only for that tab's sharing indicators.
   */
  screenShare: 'orbit-page:screen-share',
} as const

/** A tab comes forward for its notifications' clicks at most this often (a flood can't stall the shell). */
export const NOTIFICATION_CLICK_GAP_MS = 500

/**
 * Lets the first call for a key through, then drops that key's calls until `gapMs` has passed.
 * Keys quiet for a gap are forgotten as others arrive.
 */
export function perKeyGate<K>(gapMs: number, now: () => number = Date.now): (key: K) => boolean {
  const last = new Map<K, number>()
  return (key) => {
    const t = now()
    const before = last.get(key)
    if (before !== undefined && t - before < gapMs) return false
    if (last.size >= 64) for (const [k, at] of last) if (t - at >= gapMs) last.delete(k)
    last.set(key, t)
    return true
  }
}

/**
 * How long a permission prompt's choices ignore presses after it shows, and the gap a press must
 * leave after the one before it (a double-click's), as Chromium's prompts do.
 */
export const PROMPT_GUARD_MS = 500

/**
 * Input protection for a permission prompt (NV-15): a press (pointer, Enter or Space) takes a
 * choice only once the prompt has been on screen for PROMPT_GUARD_MS, and only when the press
 * before it was at least that long ago. So clicks that land on a prompt as it appears (a page knows
 * where it will) never answer it, however long they keep coming; the user's own click, after a
 * pause, does. Times are in milliseconds on one clock (a renderer's `performance.now()`).
 */
export class PromptGuard {
  private shownAt = Number.POSITIVE_INFINITY
  private lastPress = Number.NEGATIVE_INFINITY
  private counts = false
  private doubleCounts = false

  /** The prompt is on screen from `now`: a new one, or this one in a new place. */
  shown(now: number): void {
    this.shownAt = now
    this.lastPress = Number.NEGATIVE_INFINITY
    this.counts = false
    this.doubleCounts = false
  }

  /** The prompt is off screen: no press counts until it shows again. */
  hidden(): void {
    this.shownAt = Number.POSITIVE_INFINITY
    this.counts = false
    this.doubleCounts = false
  }

  /** A press at `now`: whether it may take a choice. */
  press(now: number): boolean {
    const quick = now - this.lastPress < PROMPT_GUARD_MS
    this.doubleCounts = quick && this.counts
    this.counts = !quick && now - this.shownAt >= PROMPT_GUARD_MS
    this.lastPress = now
    return this.counts
  }

  /** Whether the last press may take a choice; `double`: the second press of a double-click on a pick. */
  allows(double = false): boolean {
    return double ? this.doubleCounts : this.counts
  }

  /** When the next press will count (Infinity while off screen). */
  readyAt(): number {
    return Math.max(this.shownAt, this.lastPress) + PROMPT_GUARD_MS
  }
}

/** Sorts permissions into PERMISSION_ORDER, without repeats. */
export function sortKinds(kinds: Iterable<PermissionKind>): PermissionKind[] {
  const set = new Set(kinds)
  return PERMISSION_ORDER.filter((k) => set.has(k))
}

/**
 * The origin a permission belongs to: the page's own (the top frame's), as in Chromium, where a
 * frame inside the page uses what the page was given.
 */
export function permissionOrigin(url: string | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    if (u.protocol === 'file:') return 'file://'
    const origin = u.origin
    return origin && origin !== 'null' ? origin : null
  } catch {
    return null
  }
}

/** How a prompt names a site: its host (with the port), "This file" for local files. */
export function siteLabel(origin: string): string {
  if (origin === 'file://') return 'This file'
  try {
    return new URL(origin).host || origin
  } catch {
    return origin
  }
}

/** A device as the engine describes it (serial port, USB or HID device). */
export interface EngineDevice {
  deviceId?: string
  portId?: string
  portName?: string
  displayName?: string
  name?: string
  productName?: string
  manufacturerName?: string
  vendorId?: number | string
  productId?: number | string
  serialNumber?: string
}

/** A device's lasting identity for a site's grant: vendor, product and serial number where known. */
export function deviceKey(type: DeviceKind, device: EngineDevice): string {
  const id = (v: number | string | undefined) => (v === undefined || v === '' ? '' : String(v))
  if (device.vendorId !== undefined || device.productId !== undefined) {
    return `${type}:${id(device.vendorId)}:${id(device.productId)}:${device.serialNumber ?? ''}`
  }
  return `${type}:port:${device.portName ?? device.portId ?? device.deviceId ?? ''}`
}

/** A device's name for people: the product's name, else the port's, else its kind. */
export function deviceLabel(type: DeviceKind, device: EngineDevice): string {
  return device.displayName || device.productName || device.name || device.portName || DEVICE_NAME[type]
}

export interface DeviceOption {
  id: string
  name: string
}

export interface ScreenSource {
  id: string
  name: string
  /** A whole screen (else a window). */
  screen: boolean
}

/** A permission prompt on a tab (NV-15): the first of its pending requests. */
export type PermissionPrompt =
  | {
      id: number
      type: 'permission'
      origin: string
      kinds: PermissionKind[]
      /** Offers "Allow this time" (camera, microphone, location). */
      oneTime: boolean
    }
  | { id: number; type: 'device'; origin: string; device: DeviceKind; devices: DeviceOption[] }
  | { id: number; type: 'screen'; origin: string; sources: ScreenSource[] }
  | {
      id: number
      type: 'file'
      origin: string
      /** The file's (or folder's) name. */
      name: string
      directory: boolean
      /** Saving changes to it (else seeing it). */
      write: boolean
    }

/**
 * How the user answered a prompt: allow (and remember), allow this time, block (and remember), or
 * dismiss (no answer: asked again next time). A chooser's allow comes with the device or screen picked.
 */
export type PromptChoice = 'allow' | 'once' | 'block' | 'dismiss'

/** A row of the site controls panel's permissions. */
export interface SitePermissionRow {
  kind: PermissionKind
  /** allow / block: the user's choice; once: allowed this time; ask: asked, no choice yet. */
  state: 'allow' | 'block' | 'once' | 'ask'
}

/** A device the site may use again. */
export interface SiteDeviceRow {
  key: string
  type: DeviceKind
  name: string
}

/** What the site controls panel shows for the active tab's site (NV-16). */
export interface SiteControlsInfo {
  tabId: TabId
  url: string
  /** The host (with the port), or the address for pages that have none. */
  host: string
  connection: Connection
  /** A web page (http or https): permissions, pop-ups and site data apply. */
  web: boolean
  /** The tab is in a private window: choices last until the last private window closes. */
  private: boolean
  permissions: SitePermissionRow[]
  devices: SiteDeviceRow[]
  /** Page zoom in percent (NV-06). */
  zoom: number
  /** A change the page only sees once it reloads. */
  reload: boolean
}

/** The site controls panel's size and its gap from what it is anchored to. */
export const SITE_PANEL = { width: 300, gap: 6, margin: 8 }
