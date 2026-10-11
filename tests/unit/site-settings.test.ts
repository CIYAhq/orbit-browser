import { describe, expect, it } from 'vitest'
import { DEFAULT_PROFILE_ID } from '../../src/shared/defaults'
import { PERMISSION_ORDER } from '../../src/shared/site'
import {
  cleanSiteDefaults,
  SITE_CATEGORIES,
  SITE_CATEGORY_GROUPS,
  SITE_CATEGORY_ORDER,
  type SiteSettingsSite,
  siteChoice,
  siteDefaultFor,
  siteDefaultLabel,
  siteHost,
  siteOrigin,
} from '../../src/shared/site-settings'
import type { OrbitState } from '../../src/shared/state'

/** Settings → Site settings (ST-13): categories, defaults per profile, sites as typed. */

const profile = (id: string, partition: string, siteDefaults?: Record<string, string>) => ({
  id,
  name: id,
  partition,
  favorites: [],
  createdAt: 0,
  ...(siteDefaults ? { siteDefaults } : {}),
})

const stateWith = (profiles: ReturnType<typeof profile>[]) =>
  ({ profiles: Object.fromEntries(profiles.map((p) => [p.id, p])) }) as unknown as OrbitState

describe('[ST-13] site settings categories', () => {
  it('lists the spec’s three groups: the asked permissions, the others, then sound, JavaScript and images', () => {
    expect(SITE_CATEGORY_GROUPS.map((g) => g.title)).toEqual(['Permissions', 'More permissions', 'Content'])
    expect(SITE_CATEGORY_GROUPS[0]?.ids).toEqual(['location', 'camera', 'microphone', 'notifications'])
    expect(SITE_CATEGORY_GROUPS[2]?.ids).toEqual(['sound', 'javascript', 'images'])
    for (const id of ['popups', 'insecure', 'downloads', 'clipboard', 'midi', 'usb'] as const) {
      expect(SITE_CATEGORY_GROUPS[1]?.ids).toContain(id)
    }
    // Every permission Orbit keeps a choice for has a category, and each category is listed once.
    for (const kind of PERMISSION_ORDER) expect(SITE_CATEGORY_ORDER).toContain(kind)
    expect(new Set(SITE_CATEGORY_ORDER).size).toBe(Object.keys(SITE_CATEGORIES).length)
  })

  it('starts sensitive permissions at Ask and content at Allow; the ones Orbit can’t change have one default and no exceptions', () => {
    for (const id of ['location', 'camera', 'microphone', 'notifications', 'clipboard', 'midi', 'usb'] as const) {
      expect(SITE_CATEGORIES[id].defaults).toEqual(['ask', 'block'])
    }
    for (const id of ['sound', 'javascript', 'images'] as const) {
      expect(SITE_CATEGORIES[id].defaults).toEqual(['allow', 'block'])
      expect(SITE_CATEGORIES[id].exceptions).toEqual(['allow', 'block'])
    }
    expect(SITE_CATEGORIES.popups.defaults).toEqual(['block'])
    for (const id of ['insecure', 'downloads'] as const) {
      expect(SITE_CATEGORIES[id].defaults).toHaveLength(1)
      expect(SITE_CATEGORIES[id].exceptions).toEqual([])
      expect(SITE_CATEGORIES[id].note).toBeTruthy()
    }
  })

  it('says what each default means', () => {
    expect(siteDefaultLabel('camera', 'ask')).toBe('Sites can ask to use your camera')
    expect(siteDefaultLabel('camera', 'block')).toBe('Sites can’t use your camera')
    expect(siteDefaultLabel('javascript', 'allow')).toBe('Sites can use JavaScript')
    expect(siteDefaultLabel('images', 'block')).toBe('Sites can’t show images')
    expect(siteDefaultLabel('usb', 'ask')).toBe('Sites can ask to connect to a USB device')
  })
})

describe('[ST-13][ST-20] defaults per profile', () => {
  const state = stateWith([
    profile(DEFAULT_PROFILE_ID, 'persist:orbit-p-default', { camera: 'block' }),
    profile('p-work', 'persist:orbit-p-work', { javascript: 'block' }),
    profile('private-1', 'orbit-private-1', { camera: 'ask' }),
  ])

  it('reads a profile’s own default, else the built-in one', () => {
    expect(siteDefaultFor(state, DEFAULT_PROFILE_ID, 'camera')).toBe('block')
    expect(siteDefaultFor(state, 'p-work', 'camera')).toBe('ask')
    expect(siteDefaultFor(state, 'p-work', 'javascript')).toBe('block')
    expect(siteDefaultFor(state, DEFAULT_PROFILE_ID, 'javascript')).toBe('allow')
  })

  it('gives private windows the Default profile’s defaults', () => {
    expect(siteDefaultFor(state, 'private-1', 'camera')).toBe('block')
    expect(siteDefaultFor(state, 'private-gone', 'camera')).toBe('block')
  })

  it('keeps only defaults a category takes, and not the built-in one', () => {
    expect(
      cleanSiteDefaults({ camera: 'block', javascript: 'block', images: 'ask', popups: 'allow', insecure: 'allow' }),
    ).toEqual({ camera: 'block', javascript: 'block' })
    expect(cleanSiteDefaults({ camera: 'ask', sound: 'allow' })).toBeUndefined()
    expect(cleanSiteDefaults({ nonsense: 'block', __proto__: 'block' })).toBeUndefined()
    expect(cleanSiteDefaults(['block'])).toBeUndefined()
    expect(cleanSiteDefaults('block')).toBeUndefined()
  })
})

describe('[ST-13] sites', () => {
  it('reads a typed site as its origin, secure unless it says otherwise', () => {
    expect(siteOrigin('example.com')).toBe('https://example.com')
    expect(siteOrigin(' Example.COM/some/page?q=1 ')).toBe('https://example.com')
    expect(siteOrigin('http://localhost:3331/x')).toBe('http://localhost:3331')
    expect(siteOrigin('https://a.example:8443')).toBe('https://a.example:8443')
    for (const bad of [
      '',
      'not a site',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'ftp://example.com',
      'https://u:p@example.com',
    ]) {
      expect(siteOrigin(bad)).toBeNull()
    }
    expect(siteHost('https://a.example:8443')).toBe('a.example:8443')
  })

  it('reads a site’s choice in each category', () => {
    const site: SiteSettingsSite = {
      origin: 'https://example.com',
      permissions: { camera: 'allow', javascript: 'block' },
      popups: true,
      devices: [{ key: 'k', type: 'usb', name: 'Key' }],
    }
    expect(siteChoice(site, 'camera')).toBe('allow')
    expect(siteChoice(site, 'javascript')).toBe('block')
    expect(siteChoice(site, 'images')).toBeUndefined()
    expect(siteChoice(site, 'popups')).toBe('allow')
    expect(siteChoice(site, 'usb')).toBe('allow')
    expect(siteChoice(site, 'serial')).toBeUndefined()
    expect(siteChoice(site, 'downloads')).toBeUndefined()
  })
})
