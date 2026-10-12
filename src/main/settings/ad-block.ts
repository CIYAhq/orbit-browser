import type { Session } from 'electron'
import { type AdBlockSite, adSiteOf, blockPatterns, normalHost, shouldBlock } from '../../shared/ad-block'
import type { ProfileId, TabId } from '../../shared/state'
import type { MainContext } from '../context'
import type { SitePrefs } from '../nav/site-prefs'
import { AD_HOSTS } from './ad-hosts'

/**
 * Ad and tracker blocking (OB-06): while Settings → Privacy's "Block ads and trackers" is on (the
 * default, also chosen in onboarding), no page loads anything from a server on Orbit's list
 * (./ad-hosts.ts), except a listed site's own pages, and pages of a site the user turned it off for
 * in its site controls. That choice is kept per profile with the site's other choices (a private
 * window's go with it) and is cleared with them.
 *
 * Each profile's session gets a request hook whose filter lets only requests to listed servers reach
 * it: every other request goes by without waiting for main. Electron keeps one `onBeforeRequest`
 * listener per session, so this is the only one (tests/unit/ad-block.test.ts checks).
 */
export function registerAdBlocking(ctx: MainContext, prefs: SitePrefs): void {
  const { store, commands, tabs } = ctx
  const list = new Set(AD_HOSTS)
  // Test runs add hosts of their own, such as a *.localhost name for a local server.
  if (ctx.e2e) {
    for (const host of (process.env.ORBIT_AD_HOSTS ?? '').split(',')) if (host.trim()) list.add(normalHost(host))
  }
  const urls = blockPatterns(list)
  /** Requests stopped for each page (by its web contents), since it started loading. */
  const stopped = new Map<number, number>()

  ctx.sessions.onSessionCreated((ses: Session, profileId: ProfileId) => {
    ses.webRequest.onBeforeRequest({ urls }, (details, callback) => {
      try {
        if (!store.state.settings.adBlocking) return callback({})
        const contents = details.webContents && !details.webContents.isDestroyed() ? details.webContents : undefined
        // The page the request is for: the tab's address (a frame in it goes with it), else who asked.
        const page = contents?.getURL() || details.referrer
        const site = adSiteOf(page)
        if (site && prefs.adsAllowed(profileId, site)) return callback({})
        if (!shouldBlock({ url: details.url, mainFrame: details.resourceType === 'mainFrame', page }, list)) {
          return callback({})
        }
        if (contents) stopped.set(contents.id, (stopped.get(contents.id) ?? 0) + 1)
        callback({ cancel: true })
      } catch (err) {
        console.error('[ad-block]', err)
        callback({})
      }
    })
  })

  // A page counts its own, from when it starts loading: what the page before it asked for doesn't.
  ctx.hooks.tabCreated.push((_tabId, contents) => {
    const id = contents.id
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) stopped.delete(id)
    })
    contents.once('destroyed', () => stopped.delete(id))
  })

  const siteOf = (tabId: TabId) => {
    const tab = store.state.tabs[tabId]
    if (!tab) return null
    const contents = tabs.contents(tabId)
    const live = contents && !contents.isDestroyed() ? contents : undefined
    const site = adSiteOf(live?.getURL() || tab.url)
    return site ? { profileId: tab.profileId, site, contents: live } : null
  }

  commands.register('adBlock.site', ({ tabId }): AdBlockSite | null => {
    const at = siteOf(tabId)
    if (!at) return null
    return {
      on: store.state.settings.adBlocking,
      allowed: prefs.adsAllowed(at.profileId, at.site),
      blocked: at.contents ? (stopped.get(at.contents.id) ?? 0) : 0,
    }
  })

  // The site controls panel's switch: the page loads again, with its ads or without them.
  commands.register('adBlock.setSite', async ({ tabId, blocked }) => {
    const at = siteOf(tabId)
    if (!at || prefs.adsAllowed(at.profileId, at.site) === !blocked) return
    prefs.setAdsAllowed(at.profileId, at.site, !blocked)
    if (at.contents) await commands.run('tabs.reload', { tabId })
  })
}
