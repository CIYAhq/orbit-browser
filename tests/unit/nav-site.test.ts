import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SitePrefs } from '../../src/main/nav/site-prefs'
import { makeTab } from '../../src/main/tabs/model'
import { createInitialState, createWindowState, DEFAULT_PROFILE_ID } from '../../src/shared/defaults'
import { peekShown, shownTabId } from '../../src/shared/nav'
import {
  deviceKey,
  deviceLabel,
  isPermissionKind,
  kindsOf,
  NOTIFICATION_CLICK_GAP_MS,
  ONE_TIME_KINDS,
  PERMISSION_ASK,
  PERMISSION_NAME,
  PERMISSION_ORDER,
  pagePermissionKinds,
  perKeyGate,
  permissionOrigin,
  siteLabel,
  sortKinds,
} from '../../src/shared/site'
import type { OrbitState } from '../../src/shared/state'

describe('engine permissions as the prompt and panel name them (NV-15)', () => {
  it('splits a media request into camera and microphone', () => {
    expect(kindsOf('media', ['video'])).toEqual(['camera'])
    expect(kindsOf('media', ['audio'])).toEqual(['microphone'])
    expect(kindsOf('media', ['audio', 'video'])).toEqual(['camera', 'microphone'])
    // A check that doesn't say which is about both.
    expect(kindsOf('media')).toEqual(['camera', 'microphone'])
    expect(kindsOf('media', ['unknown'])).toEqual(['camera', 'microphone'])
  })

  it('maps the other permissions it asks about', () => {
    expect(kindsOf('geolocation')).toEqual(['location'])
    expect(kindsOf('geolocation-approximate')).toEqual(['location'])
    expect(kindsOf('notifications')).toEqual(['notifications'])
    expect(kindsOf('clipboard-read')).toEqual(['clipboard'])
    expect(kindsOf('midi')).toEqual(['midi'])
    expect(kindsOf('midiSysex')).toEqual(['midi'])
    expect(kindsOf('idle-detection')).toEqual(['idle'])
    expect(kindsOf('window-management')).toEqual(['windows'])
    expect(kindsOf('local-fonts')).toEqual(['fonts'])
    expect(kindsOf('local-network-access')).toEqual(['network'])
    expect(kindsOf('loopback-network')).toEqual(['network'])
  })

  it('asks about nothing else', () => {
    for (const quiet of ['fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'openExternal', 'unknown']) {
      expect(kindsOf(quiet)).toBeNull()
    }
  })

  it('maps the names pages read permissions by', () => {
    expect(pagePermissionKinds('geolocation')).toEqual(['location'])
    expect(pagePermissionKinds('notifications')).toEqual(['notifications'])
    expect(pagePermissionKinds('push')).toEqual(['notifications'])
    expect(pagePermissionKinds('camera')).toEqual(['camera'])
    expect(pagePermissionKinds('microphone')).toEqual(['microphone'])
    expect(pagePermissionKinds('clipboard-read')).toEqual(['clipboard'])
    expect(pagePermissionKinds('local-fonts')).toEqual(['fonts'])
    // As Chromium's PermissionStatus names them.
    expect(pagePermissionKinds('video_capture')).toEqual(['camera'])
    expect(pagePermissionKinds('audio_capture')).toEqual(['microphone'])
    expect(pagePermissionKinds('clipboard_read')).toEqual(['clipboard'])
    expect(pagePermissionKinds('window_management')).toEqual(['windows'])
    // The engine answers the rest itself.
    for (const other of ['clipboard-write', 'persistent-storage', 'storage-access', 'accelerometer', '']) {
      expect(pagePermissionKinds(other)).toBeNull()
    }
  })

  it('sorts into one order without repeats', () => {
    expect(sortKinds(['microphone', 'camera', 'microphone', 'location'])).toEqual(['camera', 'microphone', 'location'])
    expect(sortKinds([])).toEqual([])
  })

  it('has a question and a name for every permission, and one-time grants only for camera, microphone and location', () => {
    for (const kind of PERMISSION_ORDER) {
      expect(PERMISSION_ASK[kind]).toBeTruthy()
      expect(PERMISSION_NAME[kind]).toBeTruthy()
      expect(isPermissionKind(kind)).toBe(true)
    }
    expect(isPermissionKind('speaker')).toBe(false)
    expect(isPermissionKind(3)).toBe(false)
    expect([...ONE_TIME_KINDS].sort()).toEqual(['camera', 'location', 'microphone'])
  })
})

describe('the site a permission belongs to', () => {
  it('is the page’s origin, port included', () => {
    expect(permissionOrigin('https://maps.example.com/route?a=1#x')).toBe('https://maps.example.com')
    expect(permissionOrigin('http://localhost:3341/page/A')).toBe('http://localhost:3341')
  })

  it('is one entry for every local file, and nothing for pages without an origin', () => {
    expect(permissionOrigin('file:///home/me/a.html')).toBe('file://')
    expect(permissionOrigin('about:blank')).toBeNull()
    expect(permissionOrigin('data:text/html,hi')).toBeNull()
    expect(permissionOrigin('not a url')).toBeNull()
    expect(permissionOrigin(undefined)).toBeNull()
  })

  it('is named by its host, or "This file"', () => {
    expect(siteLabel('https://maps.example.com')).toBe('maps.example.com')
    expect(siteLabel('http://localhost:3341')).toBe('localhost:3341')
    expect(siteLabel('file://')).toBe('This file')
  })
})

describe('devices a site may use', () => {
  it('are known by vendor, product and serial number, or by port', () => {
    expect(deviceKey('usb', { vendorId: 0x2341, productId: 0x43, serialNumber: 'A1' })).toBe('usb:9025:67:A1')
    expect(deviceKey('hid', { vendorId: 1, productId: 2 })).toBe('hid:1:2:')
    expect(deviceKey('serial', { portName: '/dev/ttyUSB0', portId: 'p1' })).toBe('serial:port:/dev/ttyUSB0')
    expect(deviceKey('serial', { portId: 'p1' })).toBe('serial:port:p1')
  })

  it('are named for people', () => {
    expect(deviceLabel('usb', { productName: 'Board', name: 'x' })).toBe('Board')
    expect(deviceLabel('serial', { portName: 'COM3' })).toBe('COM3')
    expect(deviceLabel('hid', {})).toBeTruthy()
  })
})

describe('site choices on disk (NV-15, NV-16)', () => {
  const fileIn = () => join(mkdtempSync(join(tmpdir(), 'orbit-site-prefs-')), 'site-prefs.json')

  it('keeps permission choices per profile and origin, and writes them', () => {
    const file = fileIn()
    const prefs = new SitePrefs(file)
    prefs.setPermission(DEFAULT_PROFILE_ID, 'https://a.test', 'camera', 'allow')
    prefs.setPermission(DEFAULT_PROFILE_ID, 'https://a.test', 'location', 'block')
    prefs.setPermission('work', 'https://a.test', 'camera', 'block')
    expect(prefs.permission(DEFAULT_PROFILE_ID, 'https://a.test', 'camera')).toBe('allow')
    expect(prefs.permission('work', 'https://a.test', 'camera')).toBe('block')
    expect(prefs.permission(DEFAULT_PROFILE_ID, 'https://b.test', 'camera')).toBeUndefined()
    prefs.setPermission(DEFAULT_PROFILE_ID, 'https://a.test', 'location', undefined)
    expect(prefs.permissionsFor(DEFAULT_PROFILE_ID, 'https://a.test')).toEqual({ camera: 'allow' })
    prefs.flush()
    const again = new SitePrefs(file)
    again.load()
    expect(again.permissionsFor(DEFAULT_PROFILE_ID, 'https://a.test')).toEqual({ camera: 'allow' })
    expect(again.permissionsFor('work', 'https://a.test')).toEqual({ camera: 'block' })
  })

  it('keeps a private window’s choices in memory only, until the last private window closes', () => {
    const file = fileIn()
    const prefs = new SitePrefs(file)
    prefs.setPermission('private-1', 'https://a.test', 'camera', 'allow')
    prefs.grantDevice('private-1', 'https://a.test', { type: 'usb', key: 'usb:1:2:', name: 'Board' })
    expect(prefs.permission('private-1', 'https://a.test', 'camera')).toBe('allow')
    prefs.flush()
    expect(existsSync(file) ? readFileSync(file, 'utf8') : '').not.toContain('a.test')
    prefs.forgetPrivate()
    expect(prefs.permission('private-1', 'https://a.test', 'camera')).toBeUndefined()
    expect(prefs.devicesFor('private-1', 'https://a.test')).toEqual([])
  })

  it('remembers each device once and forgets it on request', () => {
    const prefs = new SitePrefs(fileIn())
    const board = { type: 'usb' as const, key: 'usb:1:2:A', name: 'Board' }
    prefs.grantDevice(DEFAULT_PROFILE_ID, 'https://a.test', board)
    prefs.grantDevice(DEFAULT_PROFILE_ID, 'https://a.test', { ...board, name: 'Board again' })
    expect(prefs.devicesFor(DEFAULT_PROFILE_ID, 'https://a.test')).toEqual([board])
    prefs.revokeDevice(DEFAULT_PROFILE_ID, 'https://a.test', board.key)
    expect(prefs.devicesFor(DEFAULT_PROFILE_ID, 'https://a.test')).toEqual([])
  })

  it('drops what it doesn’t understand when loading', () => {
    const file = fileIn()
    writeFileSync(
      file,
      JSON.stringify({
        permissions: {
          default: { 'https://a.test': { camera: 'allow', speaker: 'allow', location: 'maybe' }, 'https://b.test': 5 },
        },
        devices: {
          default: {
            'https://a.test': [
              { type: 'usb', key: 'k', name: 'n' },
              { type: 'bluetooth', key: 'x' },
            ],
          },
        },
      }),
    )
    const prefs = new SitePrefs(file)
    prefs.load()
    expect(prefs.permissionsFor('default', 'https://a.test')).toEqual({ camera: 'allow' })
    expect(prefs.permissionsFor('default', 'https://b.test')).toEqual({})
    expect(prefs.devicesFor('default', 'https://a.test')).toEqual([{ type: 'usb', key: 'k', name: 'n' }])
  })
})

describe('the tab the top row is about (PK-11)', () => {
  function setup() {
    const state: OrbitState = createInitialState(0)
    const spaceId = state.spaceOrder[0] as string
    const page = makeTab({ spaceId, profileId: DEFAULT_PROFILE_ID, url: 'https://a.test/' }, 0)
    const peek = makeTab({ spaceId, profileId: DEFAULT_PROFILE_ID, url: 'https://b.test/' }, 0)
    peek.floating = 'peek'
    state.tabs[page.id] = page
    state.tabs[peek.id] = peek
    state.spaces[spaceId]?.today.push(page.id)
    const win = createWindowState(spaceId)
    win.activeTab[spaceId] = page.id
    state.windows[win.id] = win
    return { state, win, page, peek }
  }

  it('is the active tab, or nothing for an unknown window', () => {
    const { state, win, page } = setup()
    expect(shownTabId(state, win.id)).toBe(page.id)
    expect(peekShown(state, win.id)).toBe(false)
    expect(shownTabId(state, 'w-gone')).toBeNull()
  })

  it('is the Peek’s page while one shows, and the active tab again while it closes', () => {
    const { state, win, page, peek } = setup()
    win.overlay = { kind: 'peek', tabId: peek.id, nonce: 1, sourceTabId: page.id }
    expect(shownTabId(state, win.id)).toBe(peek.id)
    expect(peekShown(state, win.id)).toBe(true)
    win.overlay = { kind: 'peek', tabId: peek.id, nonce: 1, sourceTabId: page.id, phase: 'expanding' }
    expect(shownTabId(state, win.id)).toBe(peek.id)
    win.overlay = { kind: 'peek', tabId: peek.id, nonce: 1, sourceTabId: page.id, phase: 'closing' }
    expect(shownTabId(state, win.id)).toBe(page.id)
    expect(peekShown(state, win.id)).toBe(false)
  })

  it('ignores a Peek whose page is already gone', () => {
    const { state, win, page } = setup()
    win.overlay = { kind: 'peek', tabId: 't-gone', nonce: 1 }
    expect(shownTabId(state, win.id)).toBe(page.id)
    expect(peekShown(state, win.id)).toBe(false)
  })
})

describe('notification clicks a page reports (NV-15)', () => {
  it('bring a tab forward once per gap, however fast they come', () => {
    let now = 1000
    const pass = perKeyGate<string>(NOTIFICATION_CLICK_GAP_MS, () => now)
    expect(pass('t1')).toBe(true)
    // A flood from the same tab changes nothing until the gap has passed.
    let through = 0
    for (let i = 0; i < 10_000; i++) {
      now += 0.01
      if (pass('t1')) through++
    }
    expect(through).toBe(0)
    // Another tab has its own gap.
    expect(pass('t2')).toBe(true)
    now = 1000 + NOTIFICATION_CLICK_GAP_MS
    expect(pass('t1')).toBe(true)
    expect(pass('t1')).toBe(false)
  })

  it('keeps a gap per tab as many tabs come and go', () => {
    let now = 0
    const pass = perKeyGate<number>(100, () => now)
    for (let key = 0; key < 64; key++) expect(pass(key)).toBe(true)
    now = 100
    // Once the gap has passed (the 65th key drops the quiet ones), each may pass again, once.
    expect(pass(64)).toBe(true)
    expect(pass(0)).toBe(true)
    expect(pass(0)).toBe(false)
  })
})
