import { type Cookie, session } from 'electron'
import { connectionOf, peekShown, zoomPercent } from '../../shared/nav'
import { isPrivateTab } from '../../shared/private'
import { permissionOrigin, SITE_PANEL, type SiteControlsInfo } from '../../shared/site'
import type { ProfileId, TabId, WindowId } from '../../shared/state'
import { displayHost } from '../../shared/url'
import type { MainContext } from '../context'
import type { CallContext } from '../registry'
import { activeTabOf } from '../windows'
import type { Permissions } from './permissions'
import type { SitePrefs } from './site-prefs'

/** What a tab's page is, for the panel: its address, permission origin and host. */
interface Site {
  tabId: TabId
  profileId: ProfileId
  url: string
  /** Where permissions are kept (null for pages that have none: internal pages, blank). */
  origin: string | null
  /** host:port, how pop-up choices are kept (NV-09). */
  host: string
  web: boolean
}

/** The URL a cookie is sent to, for removing it. */
function cookieUrl(cookie: Cookie): string | null {
  const domain = (cookie.domain ?? '').replace(/^\./, '')
  if (!domain) return null
  return `${cookie.secure ? 'https' : 'http'}://${domain}${cookie.path || '/'}`
}

/**
 * The site controls panel (NV-16): opened from the address display's button (or the Site Controls
 * action), it shows the active tab's site and connection, the permissions it was given, refused
 * or asked for (with switches), pop-ups, devices it may use, zoom with a reset, and clearing its
 * cookies and data. Changes apply at once; the panel offers a reload when the page only sees them
 * after one. It is drawn in the overlay, so the hidden sidebar stays hidden.
 */
export function registerSiteControls(ctx: MainContext, prefs: SitePrefs, permissions: Permissions): void {
  const { store, commands, actions, tabs, windows } = ctx
  /** Tabs whose page sees a change from the panel only after a reload. */
  const reloadNeeded = new Set<TabId>()

  const windowOf = (c: CallContext): WindowId | undefined => c.windowId ?? windows.focusedWindowId()

  const siteOf = (tabId: TabId | null | undefined): Site | null => {
    const tab = tabId ? store.state.tabs[tabId] : undefined
    if (!tabId || !tab) return null
    const contents = tabs.contents(tabId)
    const url = (contents && !contents.isDestroyed() ? contents.getURL() : '') || tab.url
    let host = ''
    let web = false
    try {
      const u = new URL(url)
      web = u.protocol === 'http:' || u.protocol === 'https:'
      host = web ? u.host : ''
    } catch {
      // Not an address.
    }
    return { tabId, profileId: tab.profileId, url, origin: web ? permissionOrigin(url) : null, host, web }
  }

  const info = (tabId: TabId | null | undefined): SiteControlsInfo | null => {
    const site = siteOf(tabId)
    if (!site) return null
    const tab = store.state.tabs[site.tabId]
    const rows = site.origin ? permissions.rows(site.profileId, site.origin) : []
    if (site.host) {
      // Pop-ups show once the page had one blocked, or the site may open them.
      const allowed = prefs.popupsAllowed(site.profileId, site.host)
      if (allowed || (tab?.blockedPopups ?? 0) > 0) rows.push({ kind: 'popups', state: allowed ? 'allow' : 'block' })
    }
    const devices = site.origin
      ? prefs.devicesFor(site.profileId, site.origin).map((g) => ({ key: g.key, type: g.type, name: g.name }))
      : []
    const contents = tabs.contents(site.tabId)
    return {
      tabId: site.tabId,
      url: site.url,
      host: site.host || displayHost(site.url) || site.url,
      connection: connectionOf(site.url),
      web: site.web,
      private: isPrivateTab(store.state, site.tabId),
      permissions: rows,
      devices,
      zoom: contents && !contents.isDestroyed() ? zoomPercent(contents.getZoomFactor()) : 100,
      reload: reloadNeeded.has(site.tabId),
    }
  }

  const changed = (tabId: TabId) => {
    reloadNeeded.add(tabId)
  }

  /** Opens the panel in a window's overlay with its top-left corner at a point (window coordinates). */
  const open = (windowId: WindowId, at: { x: number; y: number }) => {
    const tabId = activeTabOf(store.state, windowId)
    if (!tabId) return
    void commands
      .run(
        'overlay.open',
        {
          overlay: {
            kind: 'panel',
            panel: 'site-controls',
            params: { tabId, x: Math.round(at.x), y: Math.round(at.y) },
          },
        },
        { windowId },
      )
      .catch(() => {})
  }

  /** Where the panel goes without a button to hang from: the page's top-left corner. */
  const pageCorner = (windowId: WindowId) => {
    const tabId = activeTabOf(store.state, windowId)
    const page = tabId ? windows.tabViewBounds(tabId) : undefined
    return page ? { x: page.x + SITE_PANEL.margin, y: page.y + SITE_PANEL.margin } : { x: 16, y: 16 }
  }

  commands.register('site.openControls', ({ x, y }, c) => {
    const windowId = windowOf(c)
    if (!windowId) return
    open(windowId, x !== undefined && y !== undefined ? { x, y } : pageCorner(windowId))
  })

  // The Site Controls action (command bar, a shortcut the user sets): under the address display's
  // button while the sidebar shows (the sidebar places it), else at the page's corner. It never
  // brings the hidden sidebar out (NV-16).
  actions.register('site.controls', (c) => {
    const windowId = windowOf(c)
    const win = windowId ? store.state.windows[windowId] : undefined
    if (!windowId || !win) return
    if (win.overlay.kind === 'panel' && win.overlay.panel === 'site-controls') {
      void commands.run('overlay.close', {}, { windowId }).catch(() => {})
      return
    }
    // The panel would take the Peek's place and close it: the address shows the Peek's page (PK-11).
    if (peekShown(store.state, windowId)) return
    if (win.sidebar.visible || windows.floatingContents(windowId)) {
      windows.sendToWindow(windowId, 'sidebar:siteControls', {})
    } else {
      open(windowId, pageCorner(windowId))
    }
  })

  commands.register('site.info', ({ tabId }, c) => info(tabId ?? activeTabOf(store.state, windowOf(c) ?? '')))

  commands.register('site.setPermission', ({ tabId, kind, allowed }) => {
    const site = siteOf(tabId)
    if (!site) return
    if (kind === 'popups') {
      if (!site.host) return
      prefs.setPopupsAllowed(site.profileId, site.host, allowed)
    } else {
      if (!site.origin) return
      permissions.set(site.profileId, site.origin, kind, allowed)
    }
    changed(tabId)
  })

  commands.register('site.resetPermissions', ({ tabId }) => {
    const site = siteOf(tabId)
    if (!site?.origin) return
    permissions.reset(site.profileId, site.origin)
    if (site.host) prefs.setPopupsAllowed(site.profileId, site.host, false)
    changed(tabId)
  })

  commands.register('site.revokeDevice', ({ tabId, key }) => {
    const site = siteOf(tabId)
    if (!site?.origin) return
    prefs.revokeDevice(site.profileId, site.origin, key)
    changed(tabId)
  })

  commands.register('site.clearData', async ({ tabId }) => {
    const site = siteOf(tabId)
    if (!site?.origin || !site.web) return
    const ses =
      tabs.contents(tabId)?.session ?? session.fromPartition(store.state.profiles[site.profileId]?.partition ?? '')
    // Cookies the site gets (its host's and its parent domains'), and everything stored for it.
    const cookies = await ses.cookies.get({ url: site.url }).catch(() => [] as Cookie[])
    await Promise.all(
      cookies.map((cookie) => {
        const url = cookieUrl(cookie)
        return url ? ses.cookies.remove(url, cookie.name).catch(() => {}) : Promise.resolve()
      }),
    )
    await ses.clearStorageData({ origin: site.origin }).catch(() => {})
    changed(tabId)
    ctx.toast(windows.windowOfTab(tabId), `Cleared cookies and site data for ${site.host}`)
  })

  // A page that loads again sees every change.
  ctx.hooks.tabNavigated.push((tabId) => {
    reloadNeeded.delete(tabId)
  })
  ctx.hooks.tabCreated.push((tabId, contents) => {
    contents.once('destroyed', () => reloadNeeded.delete(tabId))
  })
}
