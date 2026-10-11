import type { Cookie, Session } from 'electron'
import { permissionOrigin } from '../../shared/site'
import {
  isDeviceCategory,
  isPermissionCategory,
  isSiteCategory,
  SITE_CATEGORIES,
  type SiteSettingsSite,
  siteDefaultFor,
  siteHost,
  siteOrigin,
} from '../../shared/site-settings'
import type { ProfileId, TabId } from '../../shared/state'
import type { MainContext } from '../context'
import type { Permissions } from '../nav/permissions'
import type { SitePrefs } from '../nav/site-prefs'
import { isPersistentProfile } from './profiles'

/** What a page may never do on a site where it is blocked: added as a policy of the page's own (ST-13). */
const CONTENT_POLICY = { javascript: "script-src 'none'", images: "img-src 'none'" } as const

/** A site as Settings names it: an origin, or local files' "file://". */
function cleanOrigin(input: unknown): string | null {
  if (typeof input !== 'string') return null
  return input === 'file://' ? input : siteOrigin(input)
}

/** The URL a cookie is sent to, for removing it. */
function cookieUrl(cookie: Cookie): string | null {
  const domain = (cookie.domain ?? '').replace(/^\./, '')
  if (!domain) return null
  return `${cookie.secure ? 'https' : 'http'}://${domain}${cookie.path || '/'}`
}

/**
 * Settings → Site settings (ST-13): each category's default per profile (kept in state), and the
 * sites with a choice of their own, kept in chrome's per-site store (`SitePrefs`, NV-15, NV-16),
 * which the site controls panel changes too. Permission prompts read the defaults (a category
 * turned off refuses without asking; src/main/nav/permissions.ts). Sound, JavaScript and images
 * are never asked for: here they are blocked for a site or a whole profile. Sound mutes the site's
 * tabs; JavaScript and images come with a content security policy on the site's pages, on top of
 * the page's own, so a page that loads again runs no script or shows no image.
 */
export function registerSiteSettings(ctx: MainContext, prefs: SitePrefs, permissions: Permissions): void {
  const { store, commands, tabs } = ctx
  /** Tabs Orbit muted because sound is blocked on their site: unmuted again when it no longer is. */
  const mutedBySite = new Set<TabId>()

  /** Whether sound, JavaScript or images are blocked on a site: its own choice, else the profile's default. */
  const contentBlocked = (profileId: ProfileId, origin: string, kind: 'sound' | 'javascript' | 'images') => {
    const choice = prefs.permission(profileId, origin, kind)
    return choice ? choice === 'block' : siteDefaultFor(store.state, profileId, kind) === 'block'
  }

  // ---------- Sound: the site's tabs are muted ----------

  const syncSound = (tabId: TabId) => {
    const tab = store.state.tabs[tabId]
    if (!tab) {
      mutedBySite.delete(tabId)
      return
    }
    const contents = tabs.contents(tabId)
    const url = contents && !contents.isDestroyed() ? contents.getURL() || tab.url : tab.url
    const origin = permissionOrigin(url)
    const block = !!origin && contentBlocked(tab.profileId, origin, 'sound')
    if (block && !tab.muted) {
      mutedBySite.add(tabId)
      void commands.run('tabs.setMuted', { tabId, muted: true }).catch(() => {})
    } else if (!block && mutedBySite.delete(tabId) && tab.muted) {
      void commands.run('tabs.setMuted', { tabId, muted: false }).catch(() => {})
    }
  }

  /** After a change in a profile's site settings: its open tabs follow at once where they can. */
  const changed = (profileId: ProfileId) => {
    for (const tab of Object.values(store.state.tabs)) if (tab.profileId === profileId) syncSound(tab.id)
  }

  ctx.hooks.tabNavigated.push((tabId) => syncSound(tabId))
  ctx.hooks.tabCreated.push((tabId, contents) => {
    contents.once('destroyed', () => mutedBySite.delete(tabId))
  })
  // A tab the user unmutes, or mutes again, is theirs from then on.
  store.subscribe((next, prev) => {
    if (next.tabs === prev.tabs) return
    for (const tabId of mutedBySite) if (!next.tabs[tabId]?.muted) mutedBySite.delete(tabId)
  })

  // ---------- JavaScript and images: a policy on the site's pages ----------

  ctx.sessions.onSessionCreated((ses: Session, profileId: ProfileId) => {
    ses.webRequest.onHeadersReceived(
      { urls: ['http://*/*', 'https://*/*'], types: ['mainFrame', 'subFrame'] },
      (details, callback) => {
        try {
          // A frame follows the page it is in, as the site the user visits is the one they chose for.
          const top =
            details.resourceType === 'mainFrame' || !details.webContents || details.webContents.isDestroyed()
              ? details.url
              : details.webContents.getURL() || details.url
          const origin = permissionOrigin(top)
          const policies = origin
            ? (['javascript', 'images'] as const)
                .filter((kind) => contentBlocked(profileId, origin, kind))
                .map((kind) => CONTENT_POLICY[kind])
            : []
          if (policies.length === 0) return callback({})
          const headers = { ...details.responseHeaders }
          const name =
            Object.keys(headers).find((h) => h.toLowerCase() === 'content-security-policy') ?? 'Content-Security-Policy'
          // Each policy must allow what the page does: one more only ever takes away.
          headers[name] = [...(headers[name] ?? []), policies.join('; ')]
          callback({ responseHeaders: headers })
        } catch (err) {
          console.error('[site-settings] headers', err)
          callback({})
        }
      },
    )
  })

  // ---------- Commands ----------

  const persistent = (profileId: unknown): profileId is ProfileId =>
    typeof profileId === 'string' && isPersistentProfile(store.state, profileId)

  commands.register('siteSettings.list', ({ profileId }) => {
    if (!persistent(profileId)) return []
    const all = prefs.sitesOf(profileId)
    const sites = new Map<string, SiteSettingsSite>()
    const site = (origin: string) => {
      let entry = sites.get(origin)
      if (!entry) {
        entry = { origin, permissions: {}, popups: false, devices: [] }
        sites.set(origin, entry)
      }
      return entry
    }
    for (const [origin, kinds] of Object.entries(all.permissions)) {
      const entry = site(origin)
      for (const [kind, choice] of Object.entries(kinds)) {
        if (kind !== 'popups' && choice) entry.permissions[kind as keyof typeof kinds] = choice
      }
    }
    for (const [origin, grants] of Object.entries(all.devices)) site(origin).devices = grants.map((g) => ({ ...g }))
    for (const host of all.popups) {
      // Pop-ups are kept by host: they belong to the site of that host Orbit knows, else its secure origin.
      const known = [...sites.keys()].find((origin) => siteHost(origin) === host)
      site(known ?? `https://${host}`).popups = true
    }
    const hostOf = (origin: string) => siteHost(origin) || origin
    return [...sites.values()]
      .filter((s) => Object.keys(s.permissions).length > 0 || s.popups || s.devices.length > 0)
      .sort((a, b) => hostOf(a.origin).localeCompare(hostOf(b.origin)) || a.origin.localeCompare(b.origin))
  })

  commands.register('siteSettings.setDefault', ({ profileId, category, value }) => {
    if (!persistent(profileId) || !isSiteCategory(category)) return
    const def = SITE_CATEGORIES[category]
    if (!def.defaults.includes(value)) return
    store.update((d) => {
      const profile = d.profiles[profileId]
      if (!profile) return
      const defaults = { ...profile.siteDefaults }
      // The built-in default is no choice at all.
      if (value === def.defaults[0]) delete defaults[category]
      else defaults[category] = value
      if (Object.keys(defaults).length > 0) profile.siteDefaults = defaults
      else delete profile.siteDefaults
    })
    changed(profileId)
  })

  commands.register('siteSettings.set', ({ profileId, origin: raw, category, choice }) => {
    const origin = cleanOrigin(raw)
    if (!persistent(profileId) || !origin || !isSiteCategory(category)) return
    if (choice !== null && !SITE_CATEGORIES[category].exceptions.includes(choice)) return
    if (category === 'popups') {
      const host = siteHost(origin)
      if (host) prefs.setPopupsAllowed(profileId, host, choice === 'allow')
    } else if (isDeviceCategory(category)) {
      if (choice !== null) return
      for (const grant of prefs.devicesFor(profileId, origin)) {
        if (grant.type === category) prefs.revokeDevice(profileId, origin, grant.key)
      }
    } else if (isPermissionCategory(category)) {
      if (choice === null) prefs.setPermission(profileId, origin, category, undefined)
      else permissions.set(profileId, origin, category, choice === 'allow')
    }
    changed(profileId)
  })

  commands.register('siteSettings.revokeDevice', ({ profileId, origin: raw, key }) => {
    const origin = cleanOrigin(raw)
    if (!persistent(profileId) || !origin || typeof key !== 'string') return
    prefs.revokeDevice(profileId, origin, key)
  })

  commands.register('siteSettings.resetSite', ({ profileId, origin: raw }) => {
    const origin = cleanOrigin(raw)
    if (!persistent(profileId) || !origin) return
    permissions.reset(profileId, origin)
    const host = siteHost(origin)
    if (host) prefs.setPopupsAllowed(profileId, host, false)
    changed(profileId)
  })

  commands.register('siteSettings.clearSite', async ({ profileId, origin: raw }) => {
    const origin = cleanOrigin(raw)
    if (!persistent(profileId) || !origin || origin === 'file://') return
    const ses = ctx.sessions.get(profileId)
    // Cookies the site gets (its host's and its parent domains'), everything it stored, its cached files.
    const cookies = await ses.cookies.get({ url: `${origin}/` }).catch(() => [] as Cookie[])
    await Promise.all(
      cookies.map((cookie) => {
        const url = cookieUrl(cookie)
        return url ? ses.cookies.remove(url, cookie.name).catch(() => {}) : Promise.resolve()
      }),
    )
    await ses.clearStorageData({ origin }).catch(() => {})
    await ses.clearData({ dataTypes: ['cache'], origins: [origin] }).catch(() => {})
  })

  commands.register('siteSettings.clear', ({ profileId }) => {
    if (!persistent(profileId)) return
    prefs.forgetProfile(profileId)
    changed(profileId)
  })
}
