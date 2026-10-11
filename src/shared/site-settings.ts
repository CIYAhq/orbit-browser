/**
 * Settings → Site settings (ST-13): the categories of what sites may do, each with a default per
 * profile (`Profile.siteDefaults`), and the sites with a choice of their own (exceptions), kept in
 * chrome's per-site store (src/main/nav/site-prefs.ts). Shared by main and the Settings window.
 */
import { DEFAULT_PROFILE_ID } from './defaults'
import { isPrivateProfile } from './private'
import { DEVICE_ASK, type DeviceKind, PERMISSION_ASK, PERMISSION_NAME, type PermissionKind } from './site'
import type { OrbitState, ProfileId } from './state'

/**
 * What Site settings lists: the permissions sites ask for, pop-ups, the devices a chooser connects
 * to, sound, JavaScript and images, and two the user can't change in Orbit (insecure content,
 * automatic downloads).
 */
export type SiteCategory = PermissionKind | DeviceKind | 'insecure' | 'downloads'

/** What a category does for a site with no choice of its own. */
export type SiteDefault = 'ask' | 'allow' | 'block'

/** A site's own choice in a category (an exception to the default). */
export type SiteChoice = 'allow' | 'block'

export interface SiteCategoryDef {
  id: SiteCategory
  name: string
  /** The defaults the user can pick, the built-in one first; just one when it can't be changed. */
  defaults: readonly SiteDefault[]
  /** The exceptions a site can have; none for a category that keeps no per-site choice. */
  exceptions: readonly SiteChoice[]
  /** Why the default can't be changed, or exceptions don't exist, when that's so. */
  note?: string
}

const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)

/** Sites ask, the user answers: sensitive permissions start at Ask, and can be turned off. */
const asked = (id: PermissionKind): SiteCategoryDef => ({
  id,
  name: PERMISSION_NAME[id],
  defaults: ['ask', 'block'],
  exceptions: ['allow', 'block'],
})

const device = (id: DeviceKind, name: string): SiteCategoryDef => ({
  id,
  name,
  defaults: ['ask', 'block'],
  // A site is allowed one device at a time, in its chooser; removing it is the way back.
  exceptions: ['allow'],
})

/** Never asked: allowed, unless the user blocks it for a site or for every site. */
const content = (id: PermissionKind): SiteCategoryDef => ({
  id,
  name: PERMISSION_NAME[id],
  defaults: ['allow', 'block'],
  exceptions: ['allow', 'block'],
})

export const SITE_CATEGORIES: Record<SiteCategory, SiteCategoryDef> = {
  location: asked('location'),
  camera: asked('camera'),
  microphone: asked('microphone'),
  notifications: asked('notifications'),
  popups: {
    id: 'popups',
    name: 'Pop-ups',
    defaults: ['block'],
    exceptions: ['allow'],
    note: 'A page opens a pop-up only right after a click on it, unless you allow the site.',
  },
  insecure: {
    id: 'insecure',
    name: 'Insecure content',
    defaults: ['block'],
    exceptions: [],
    note: 'A secure page never loads scripts or frames over an insecure connection. The engine decides this for every site, so it can’t be allowed for one.',
  },
  downloads: {
    id: 'downloads',
    name: 'Automatic downloads',
    defaults: ['allow'],
    exceptions: [],
    note: 'Orbit doesn’t ask before a site downloads several files one after another yet, so no site has a choice of its own here.',
  },
  clipboard: asked('clipboard'),
  midi: asked('midi'),
  usb: device('usb', 'USB devices'),
  serial: device('serial', 'Serial ports'),
  hid: device('hid', 'HID devices'),
  idle: asked('idle'),
  windows: asked('windows'),
  fonts: asked('fonts'),
  network: asked('network'),
  sound: content('sound'),
  javascript: content('javascript'),
  images: content('images'),
}

/** How Site settings groups the categories, in order (ST-13's three lists). */
export const SITE_CATEGORY_GROUPS: readonly { title: string; ids: readonly SiteCategory[] }[] = [
  { title: 'Permissions', ids: ['location', 'camera', 'microphone', 'notifications'] },
  {
    title: 'More permissions',
    ids: [
      'popups',
      'insecure',
      'downloads',
      'clipboard',
      'midi',
      'usb',
      'serial',
      'hid',
      'idle',
      'windows',
      'fonts',
      'network',
    ],
  },
  { title: 'Content', ids: ['sound', 'javascript', 'images'] },
]

export const SITE_CATEGORY_ORDER: readonly SiteCategory[] = SITE_CATEGORY_GROUPS.flatMap((g) => g.ids)

export function isSiteCategory(value: unknown): value is SiteCategory {
  return typeof value === 'string' && Object.hasOwn(SITE_CATEGORIES, value)
}

/** Categories kept in chrome's permission store (the rest: pop-ups by host, devices by grant). */
export function isPermissionCategory(category: SiteCategory): category is PermissionKind {
  return category !== 'popups' && category in PERMISSION_ASK
}

export function isDeviceCategory(category: SiteCategory): category is DeviceKind {
  return category in DEVICE_ASK
}

/** What a default means, as Settings says it: "Sites can ask to use your camera". */
export function siteDefaultLabel(category: SiteCategory, value: SiteDefault): string {
  const def = SITE_CATEGORIES[category]
  if (category === 'popups') return 'Only after a click on the page'
  if (category === 'insecure') return 'Blocked on secure pages'
  if (category === 'downloads') return 'Sites can download several files'
  const what = lower(isDeviceCategory(category) ? DEVICE_ASK[category] : PERMISSION_ASK[category as PermissionKind])
  if (value === 'block') return `Sites can’t ${what}`
  if (def.defaults.includes('ask')) return `Sites can ask to ${what}`
  return `Sites can ${what}`
}

/** A short name for a site's choice or a default, for selects and summaries. */
export const SITE_CHOICE_NAME: Record<SiteDefault, string> = { ask: 'Ask', allow: 'Allow', block: 'Block' }

/**
 * A profile's default for a category (ST-13): its own choice, else the built-in one. Private
 * windows have no settings of their own: they follow the Default profile's (ST-20).
 */
export function siteDefaultFor(state: OrbitState, profileId: ProfileId, category: SiteCategory): SiteDefault {
  let profile = state.profiles[profileId]
  if (!profile || isPrivateProfile(profile)) profile = state.profiles[DEFAULT_PROFILE_ID]
  return siteDefaultIn(profile?.siteDefaults, category)
}

/** A category's default in a profile's `siteDefaults`: the value kept there if it takes it, else the built-in one. */
export function siteDefaultIn(
  defaults: Partial<Record<SiteCategory, SiteDefault>> | undefined,
  category: SiteCategory,
): SiteDefault {
  const def = SITE_CATEGORIES[category]
  const value = defaults?.[category]
  return value && def.defaults.includes(value) ? value : (def.defaults[0] as SiteDefault)
}

/** A profile's site defaults as loaded (persist): only categories that can change, with a value they take. */
export function cleanSiteDefaults(raw: unknown): Partial<Record<SiteCategory, SiteDefault>> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const kept: Partial<Record<SiteCategory, SiteDefault>> = {}
  for (const [category, value] of Object.entries(raw)) {
    if (!isSiteCategory(category)) continue
    const def = SITE_CATEGORIES[category]
    // The built-in default is no choice at all: not kept.
    if (def.defaults.indexOf(value as SiteDefault) > 0) kept[category] = value as SiteDefault
  }
  return Object.keys(kept).length > 0 ? kept : undefined
}

/**
 * The origin a site typed in Settings stands for: "example.com" is https://example.com. Only web
 * sites have site settings; anything else is null.
 */
export function siteOrigin(input: string): string | null {
  const text = input.trim()
  if (!text || /\s/.test(text)) return null
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (!url.hostname || url.username || url.password) return null
    return url.origin
  } catch {
    return null
  }
}

/** The host:port a site's pop-up choice is kept by (NV-09), from its origin. */
export function siteHost(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return ''
  }
}

/** What Site settings shows for one site of a profile: every choice made for it. */
export interface SiteSettingsSite {
  origin: string
  /** Choices kept in chrome's permission store (sound, JavaScript and images too). */
  permissions: Partial<Record<PermissionKind, SiteChoice>>
  /** Allowed to open pop-ups without a click (kept by host, NV-09). */
  popups: boolean
  /** Devices it may use again without asking. */
  devices: { key: string; type: DeviceKind; name: string }[]
}

/** A site's choice in a category, if it has one. */
export function siteChoice(site: SiteSettingsSite, category: SiteCategory): SiteChoice | undefined {
  if (category === 'popups') return site.popups ? 'allow' : undefined
  if (isDeviceCategory(category)) return site.devices.some((d) => d.type === category) ? 'allow' : undefined
  if (isPermissionCategory(category)) return site.permissions[category]
  return undefined
}
