import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ALL_SITES_TEXT,
  addedPermissions,
  apiPermissionsOf,
  compareVersions,
  type ExtensionManifest,
  extensionKey,
  extensionPath,
  extensionsOf,
  hostPatternsOf,
  iconPathOf,
  idFromHash,
  isValidVersion,
  type LocaleMessages,
  localesToTry,
  localize,
  localizeManifest,
  normalizeExtensions,
  optionsPageOf,
  parseManifest,
  permissionLines,
  pinnedExtensions,
  popupOf,
  siteAccessText,
} from '../../src/shared/extensions'
import type { InstalledExtension } from '../../src/shared/state'
import { FIXTURES, idOf, makeKey } from '../fixtures/extensions/pack'

/** What Orbit reads of an extension's manifest, and how it says what the extension may do (EX-02, EX-07). */

const manifest = (fields: Record<string, unknown>): ExtensionManifest =>
  ({ manifest_version: 3, name: 'X', version: '1', ...fields }) as ExtensionManifest
const fixture = (name: 'basic' | 'broad') => parseManifest(readFileSync(join(FIXTURES[name], 'manifest.json'), 'utf8'))

describe('parseManifest', () => {
  it('reads Manifest V2 and V3, with or without a byte-order mark', () => {
    expect(parseManifest('{"manifest_version":3,"name":"A","version":"1.2"}').name).toBe('A')
    expect(parseManifest('﻿{"manifest_version":2,"name":"B","version":"0.0.1"}').manifest_version).toBe(2)
  })

  it('says in words why it refuses one', () => {
    expect(() => parseManifest('{')).toThrow('Its manifest isn’t valid JSON.')
    expect(() => parseManifest('[]')).toThrow('Its manifest isn’t valid JSON.')
    expect(() => parseManifest('{"name":"A","version":"1"}')).toThrow('Its manifest has no manifest version.')
    expect(() => parseManifest('{"manifest_version":1,"name":"A","version":"1"}')).toThrow(
      'It uses manifest version 1, which Orbit can’t run.',
    )
    expect(() => parseManifest('{"manifest_version":3,"name":" ","version":"1"}')).toThrow('Its manifest has no name.')
    expect(() => parseManifest('{"manifest_version":3,"name":"A","version":"1.01"}')).toThrow(
      'Its manifest’s version isn’t valid.',
    )
  })

  it('checks versions as the engine does, and compares them', () => {
    for (const v of ['1', '1.0', '0.0.0.1', '65535.1']) expect(isValidVersion(v)).toBe(true)
    for (const v of ['', '1.', '01', '1.2.3.4.5', '65536', 'a', 1]) expect(isValidVersion(v)).toBe(false)
    expect(compareVersions('1.2', '1.10')).toBeLessThan(0)
    expect(compareVersions('2', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0', '1')).toBe(0)
  })
})

describe('its texts', () => {
  it('tries the user’s locales, then the extension’s own', () => {
    expect(localesToTry('en', ['de-CH', 'fr'])).toEqual(['de_CH', 'de', 'fr', 'en'])
  })

  it('fills __MSG_ keys from the first locale that has them, without case', () => {
    const messages: LocaleMessages[] = [
      { Title: { message: 'Hallo' } },
      { title: { message: 'Hello' }, other: { message: 'More' } },
    ]
    expect(localize('__MSG_title__ / __MSG_OTHER__ / __MSG_none__', messages)).toBe('Hallo / More / ')
    expect(localize('Plain', messages)).toBe('Plain')
  })

  it('names the fixture by its English messages', () => {
    const raw = fixture('basic')
    const messages = JSON.parse(readFileSync(join(FIXTURES.basic, '_locales/en/messages.json'), 'utf8'))
    const named = localizeManifest(raw, [messages])
    expect(named.name).toBe('Orbit Test Extension')
    expect(named.description).toMatch(/^A small extension/)
    // A name whose message is missing keeps what it says.
    expect(localizeManifest(raw, []).name).toBe('__MSG_name__')
  })
})

describe('its files', () => {
  it('takes only paths inside the extension', () => {
    expect(extensionPath('./popup.html')).toBe('popup.html')
    expect(extensionPath('/options/index.html')).toBe('options/index.html')
    for (const bad of ['../x.html', 'a/../../x.html', 'https://example.com/x.html', 'a\\b.html', '', 3]) {
      expect(extensionPath(bad)).toBe('')
    }
  })

  it('finds its popup and options page (V3 and V2)', () => {
    const basic = fixture('basic')
    expect(popupOf(basic)).toBe('popup.html')
    expect(optionsPageOf(basic)).toBe('options.html')
    expect(popupOf(manifest({ manifest_version: 2, browser_action: { default_popup: 'p.html' } }))).toBe('p.html')
    expect(optionsPageOf(manifest({ options_page: 'o.html' }))).toBe('o.html')
    expect(popupOf(fixture('broad'))).toBe('')
  })

  it('picks the action’s icon at the size asked for, else the biggest', () => {
    expect(iconPathOf(fixture('basic'), 32)).toBe('icons/48.png')
    expect(iconPathOf(fixture('basic'), 16)).toBe('icons/16.png')
    expect(iconPathOf(manifest({ icons: { 16: 'a.png', 19: 'b.png' } }), 32)).toBe('b.png')
    expect(iconPathOf(manifest({ action: { default_icon: 'act.png' }, icons: { 128: 'big.png' } }))).toBe('act.png')
    expect(iconPathOf(manifest({ icons: { 48: '../x.png' } }))).toBe('')
  })
})

describe('what it may do (EX-02)', () => {
  it('reads its API permissions apart from its sites, content scripts’ pages included', () => {
    const broad = fixture('broad')
    expect(apiPermissionsOf(broad)).toEqual(['tabs', 'history', 'storage'])
    expect(hostPatternsOf(broad)).toEqual(['<all_urls>'])
    const v2 = manifest({ manifest_version: 2, permissions: ['https://a.com/*', 'cookies'] })
    expect(apiPermissionsOf(v2)).toEqual(['cookies'])
    expect(hostPatternsOf(v2)).toEqual(['https://a.com/*'])
    expect(hostPatternsOf(fixture('basic'))).toEqual(['http://localhost/*', 'http://127.0.0.1/*'])
  })

  it('says it in plain words, most far-reaching first, each once', () => {
    const broad = fixture('broad')
    expect(permissionLines(apiPermissionsOf(broad), hostPatternsOf(broad))).toEqual([
      ALL_SITES_TEXT,
      'Read your browsing history',
      'Read and change your browsing history',
    ])
    expect(permissionLines(['storage', 'alarms'], [])).toEqual([])
    expect(permissionLines(['tabs', 'webNavigation'], ['https://*.a.com/*'])).toEqual([
      'Read and change your data on a.com',
      'Read your browsing history',
    ])
    expect(permissionLines([], ['https://a.com/*', 'https://b.com/*'])).toEqual([
      'Read and change your data on a.com and b.com',
    ])
    expect(permissionLines([], ['https://a.com/*', 'https://b.com/*', 'https://c.com/*', 'https://d.com/*'])).toEqual([
      'Read and change your data on a.com, b.com and 2 other websites',
    ])
    expect(permissionLines([], ['*://*/*'])).toEqual([ALL_SITES_TEXT])
    expect(permissionLines([], ['file:///*'])).toEqual(['Read files on your computer that you open in Orbit'])
  })

  it('says where it runs, for its Details (EX-07)', () => {
    expect(siteAccessText(['<all_urls>'])).toBe('On all sites')
    expect(siteAccessText([])).toBe('None')
    expect(siteAccessText(['http://localhost/*', 'http://127.0.0.1/*'])).toBe('On localhost and 127.0.0.1')
  })

  it('finds what an update asks for that it didn’t before', () => {
    const before = { permissions: ['storage'], hosts: ['https://a.com/*'] }
    expect(addedPermissions(before, before)).toEqual([])
    expect(addedPermissions(before, { permissions: ['storage', 'history'], hosts: ['<all_urls>'] })).toEqual([
      ALL_SITES_TEXT,
      'Read and change your browsing history',
    ])
  })
})

describe('the state', () => {
  const key = makeKey('ecdsa')
  const entry = (fields: Partial<InstalledExtension> = {}): InstalledExtension => ({
    id: key.id,
    profileId: 'p-default',
    name: 'Fixture',
    version: '1.0',
    description: '',
    source: 'crx',
    path: '/x',
    enabled: true,
    allowPrivate: false,
    allowFileAccess: false,
    permissions: [],
    hosts: [],
    icon: '',
    popup: '',
    options: '',
    installedAt: 1,
    ...fields,
  })

  it('gives the ID a key’s hash names', () => {
    expect(idFromHash(new Uint8Array(32).fill(0x1f))).toBe('bp'.repeat(16))
    expect(idOf(key.publicKey)).toBe(key.id)
  })

  it('keeps each profile’s own, checked, without what is runtime only', () => {
    const profiles = { 'p-default': {}, 'p-work': {} }
    const raw = {
      [extensionKey('p-default', key.id)]: { ...entry(), error: 'old', pinnedAt: 5, icon: 'javascript:alert(1)' },
      [extensionKey('p-gone', key.id)]: entry({ profileId: 'p-gone' }),
      [extensionKey('p-work', 'not-an-id')]: entry({ profileId: 'p-work', id: 'not-an-id' }),
      'p-work:mismatched': entry({ profileId: 'p-work' }),
    }
    const out = normalizeExtensions(raw, profiles)
    expect(Object.keys(out)).toEqual([extensionKey('p-default', key.id)])
    const kept = out[extensionKey('p-default', key.id)]
    expect(kept?.error).toBeUndefined()
    expect(kept?.pinnedAt).toBe(5)
    expect(kept?.icon).toBe('')
  })

  it('lists a profile’s extensions in install order, and its pins in pin order', () => {
    const a = entry({ id: 'a'.repeat(32), installedAt: 2, pinnedAt: 20 })
    const b = entry({ id: 'b'.repeat(32), installedAt: 1, pinnedAt: 10 })
    const c = entry({ id: 'c'.repeat(32), installedAt: 3, pinnedAt: 5, enabled: false })
    const d = entry({ id: 'd'.repeat(32), profileId: 'p-work' })
    const all = Object.fromEntries([a, b, c, d].map((e) => [extensionKey(e.profileId, e.id), e]))
    expect(extensionsOf(all, 'p-default').map((e) => e.id[0])).toEqual(['b', 'a', 'c'])
    expect(pinnedExtensions(all, 'p-default').map((e) => e.id[0])).toEqual(['b', 'a'])
  })
})
