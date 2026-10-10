import { type BrowserWindow, Menu, type MenuItemConstructorOptions, type Referrer, type WebContents } from 'electron'
import { type PageReferrer, popupTitle, referrerPolicyName, shownTabId } from '../../shared/nav'
import type { TabId, WindowId } from '../../shared/state'
import { sectionOf } from '../../shared/tree'
import type { MainContext } from '../context'
import { heldModifiers } from '../peek/input'
import type { TabOps, TabPage } from '../tabs/ops'
import { activeTabOf, shownTabs } from '../windows'
import { NAV_WORLD } from './focus'
import type { SitePrefs } from './site-prefs'

/** The engine starts its "download link" for an ⌥-click about half a second later; it is caught for this long. */
const ALT_CLICK_DOWNLOAD_MS = 15_000
/** Blocked pop-ups offered for opening from the address display, newest first. */
const BLOCKED_SHOWN = 5

/**
 * The link under the pointer in the page's main frame (through open shadow roots), as
 * `{ href, policy }`; `{ frame: true }` when the pointer is over a frame or something Orbit can't
 * look into (the link may be inside); null over anything else. `policy` is the referrer policy the
 * link sets for itself (`rel=noreferrer`, `referrerpolicy`) or else the page's
 * `<meta name="referrer">`; a policy the page sets in its response headers is out of reach.
 */
const HOVERED_LINK = `(() => {
  let root = document, el = null
  for (let i = 0; i < 16; i++) {
    const list = root.querySelectorAll(':hover')
    const last = list[list.length - 1]
    if (!last) break
    el = last
    if (!last.shadowRoot) break
    root = last.shadowRoot
  }
  if (!el) return null
  for (let n = el; n; n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null) {
    if (n.localName !== 'a' && n.localName !== 'area') continue
    const raw = n.href
    const href = typeof raw === 'string' ? raw : raw && raw.baseVal ? new URL(raw.baseVal, document.baseURI).href : ''
    if (!href) continue
    const metas = document.querySelectorAll('meta[name="referrer" i]')
    const meta = metas.length ? metas[metas.length - 1].getAttribute('content') || '' : ''
    const own = n.relList && n.relList.contains('noreferrer') ? 'no-referrer' : n.referrerPolicy || n.getAttribute('referrerpolicy') || ''
    return { href, policy: own || meta }
  }
  const tag = el.localName
  return tag === 'iframe' || tag === 'frame' || tag === 'object' || tag === 'embed' || el.shadowRoot ? { frame: true } : null
})()`

interface Hovered {
  href?: string
  policy?: string
  frame?: boolean
}

/** An ⌥-click Orbit took over: the engine's download for the same link is cancelled when it comes. */
interface AltClick {
  url: string
  until: number
  /** Not opened yet (a link inside a frame): the download, when it comes, opens the split. */
  split: boolean
}

/** Links Orbit opens: web and file pages (not script, data or blob URLs). */
const openable = (url: string | undefined): url is string => !!url && /^(https?|file):/i.test(url)

const withoutHash = (url: string) => url.split('#')[0] ?? url

function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).host : ''
  } catch {
    return ''
  }
}

export interface LinksDeps {
  ops: TabOps
  prefs: SitePrefs
  /**
   * A new window showing `url`: private when the link came from a private tab (NV-08, NV-12).
   * `page` is how its tab gets the page, when not by loading the URL as typed (review B-F1).
   */
  openWindow: (url: string, from: { tabId?: TabId; windowId?: WindowId }, page?: TabPage) => void
}

export interface LinksTestHooks {
  /** The blocked pop-ups menu last shown (labels; disabled items in brackets), or null. */
  blockedMenu: () => string[] | null
  /** Chooses an item of the blocked pop-ups menu by label. */
  chooseBlocked: (label: string) => boolean
}

/**
 * Clicks on links and the windows pages open, beyond what the tabs lane does (NV-08, NV-09):
 * - ⇧-click (when Peek doesn't take it, `peek.md`): the link in a new window, Chromium-style.
 * - ⌥-click: the link in split view beside the page, instead of the engine's "download link".
 * - A tab opened only to download something closes again and its opener is selected.
 * - Pop-up windows show the host they're on as their title, the page can't change it.
 * - Pop-ups blocked for want of a click show in the address display, where they can be opened or
 *   always allowed for the site.
 */
export function registerLinks(ctx: MainContext, deps: LinksDeps): LinksTestHooks {
  const { store, commands, tabs, windows } = ctx
  const { ops, prefs } = deps

  // ---- Modifier keys: the app's one tracker (Peek's), from the key events of every contents ----
  const held = heldModifiers()
  /** Only ⌥ (Alt) held: ⌘⌥ / Ctrl+Alt is a Mini Window click (MW-07), ⇧⌥ and ⌘-clicks are not ours. */
  const altOnly = (mouse: Electron.MouseInputEvent) => {
    const mods = new Set<string>(mouse.modifiers ?? [])
    const keys = held.get()
    const alt = keys.alt || mods.has('alt')
    const meta = keys.meta || mods.has('meta') || mods.has('command') || mods.has('cmd')
    const control = keys.control || mods.has('control') || mods.has('ctrl')
    const shift = keys.shift || mods.has('shift')
    return alt && !meta && !control && !shift
  }

  // ---- ⇧-click: a new window (NV-08). Peek's own hook comes first and takes it when it's on. ----
  ctx.hooks.windowOpen.push((openerTabId, details) => {
    if (details.disposition !== 'new-window' || details.features) return undefined
    if (!openable(details.url)) return undefined
    const from = { tabId: openerTabId, windowId: windows.windowOfTab(openerTabId) }
    const load = { httpReferrer: details.referrer }
    // The engine leaves the link to the browser: the page opens it itself (review B-F1).
    tabs.openFromPage(
      openerTabId,
      details.url,
      details.referrer,
      (view) => deps.openWindow(details.url, from, { view, load }),
      () => deps.openWindow(details.url, from, { load }),
    )
    return { action: 'deny' }
  })

  // ---- ⌥-click: split view (NV-08, SV-08) ----
  const hovered = new Map<TabId, string>()
  const altClicks = new Map<TabId, AltClick>()

  /** The link in a pane beside the page's; `referrer` is the page it came from, when known. */
  const openInSplit = (tabId: TabId, url: string, referrer?: PageReferrer) => {
    const windowId = windows.windowOfTab(tabId)
    if (!windowId || !store.state.tabs[tabId]) return
    void commands
      .run('split.openUrl', { url, target: tabId, side: 'right', ...(referrer ? { referrer } : {}) }, { windowId })
      .catch(() => {})
  }

  const onAltClick = async (tabId: TabId, contents: WebContents) => {
    const windowId = windows.windowOfTab(tabId)
    // Only a page that is one of a browser window's panes (not Peek, a Mini Window or a pop-up).
    if (!windowId || store.state.windows[windowId]?.kind === 'mini') return
    if (!shownTabs(store.state, windowId).has(tabId)) return
    const fallback = hovered.get(tabId)
    let found: Hovered | null
    try {
      found = (await contents.executeJavaScriptInIsolatedWorld(NAV_WORLD, [{ code: HOVERED_LINK }])) as Hovered | null
    } catch {
      found = { frame: true }
    }
    if (contents.isDestroyed()) return
    const until = Date.now() + ALT_CLICK_DOWNLOAD_MS
    if (found?.href) {
      if (!openable(found.href)) return
      altClicks.set(tabId, { url: found.href, until, split: false })
      // Sent with the page as referrer, as the link's policy or the page's allows (review B-F1).
      openInSplit(tabId, found.href, { url: contents.getURL(), policy: referrerPolicyName(found.policy) })
    } else if (found?.frame && openable(fallback)) {
      // A link in a frame: the engine's download of it says which, and opens the split.
      altClicks.set(tabId, { url: fallback, until, split: true })
    }
  }

  ctx.hooks.tabCreated.push((tabId, contents) => {
    contents.on('update-target-url', (_e, url) => {
      if (url) hovered.set(tabId, url)
      else hovered.delete(tabId)
    })
    contents.on('before-mouse-event', (_e, mouse) => {
      if (mouse.type !== 'mouseDown' || mouse.button !== 'left' || !altOnly(mouse)) return
      void onAltClick(tabId, contents)
    })
    contents.on('did-create-window', (popup, details) => keepHostTitle(popup, details.url))
    contents.once('destroyed', () => {
      if (tabs.contents(tabId)) return
      hovered.delete(tabId)
      altClicks.delete(tabId)
    })
  })

  // ---- Downloads: an ⌥-clicked link's, and tabs opened only to download (NV-08, NV-09) ----
  /** A tab that never showed a page: its first navigation turned into a download. */
  const neverShowedPage = (contents: WebContents) => {
    const url = contents.getURL()
    return contents.navigationHistory.length() <= 1 && (!url || url === 'about:blank')
  }
  const closeDownloadTab = (tabId: TabId) => {
    const state = store.state
    const tab = state.tabs[tabId]
    // Pinned tabs and Favorites keep their place in the sidebar.
    if (!tab || sectionOf(state, tabId) !== 'today') return
    const windowId = windows.windowOfTab(tabId)
    const shown = !!windowId && activeTabOf(state, windowId) === tabId
    const opener = tab.openerTabId && state.tabs[tab.openerTabId] ? tab.openerTabId : undefined
    // Nothing to keep: no Archive entry, no "reopen closed tab", no undo.
    store.update((d) => {
      const t = d.tabs[tabId]
      if (t) t.url = 'about:blank'
    })
    ops.closeTabs([tabId], 'auto', { undoLabel: false })
    if (shown && windowId && opener) ops.activate(windowId, opener)
  }
  ctx.sessions.onSessionCreated((ses) => {
    ses.on('will-download', (event, item, source) => {
      const tabId = source && !source.isDestroyed() ? tabs.tabIdFor(source) : undefined
      if (!source || !tabId) return
      const url = item.getURLChain()[0] ?? item.getURL()
      const alt = altClicks.get(tabId)
      if (alt && Date.now() <= alt.until && withoutHash(alt.url) === withoutHash(url)) {
        altClicks.delete(tabId)
        event.preventDefault()
        if (alt.split) openInSplit(tabId, url)
        return
      }
      if (neverShowedPage(source)) setTimeout(() => closeDownloadTab(tabId), 0)
    })
  })

  // ---- Pop-up windows: the host as the title (NV-09) ----
  const keepHostTitle = (popup: BrowserWindow, url: string) => {
    const show = (next: string) => {
      if (!popup.isDestroyed() && next) popup.setTitle(popupTitle(next))
    }
    // The window re-emits its page's title change and takes the title unless this prevents it.
    popup.on('page-title-updated', (event) => event.preventDefault())
    popup.webContents.on('did-navigate', (_e, next) => show(next))
    show(url)
  }

  // ---- Blocked pop-ups (NV-09) ----
  /** A pop-up a page tried to open, and the referrer it would have had. */
  type Blocked = { url: string; referrer: Referrer }
  const blocked = new Map<TabId, Blocked[]>()
  // Private profiles' choices stay in memory (SitePrefs).
  const popupsAllowed = (profileId: string, host: string) => prefs.popupsAllowed(profileId, host)
  const setPopupsAllowed = (profileId: string, host: string, allowed: boolean) =>
    prefs.setPopupsAllowed(profileId, host, allowed)
  const setBlocked = (tabId: TabId, urls: Blocked[]) => {
    if (urls.length > 0) blocked.set(tabId, urls)
    else blocked.delete(tabId)
    const count = urls.length || undefined
    if (store.state.tabs[tabId]?.blockedPopups === count) return
    store.update((d) => {
      const t = d.tabs[tabId]
      if (!t) return
      if (count) t.blockedPopups = count
      else delete t.blockedPopups
    })
  }

  tabs.allowsPopups = (tabId) => {
    const tab = store.state.tabs[tabId]
    const host = hostOf(tabs.contents(tabId)?.getURL() || tab?.url)
    return !!tab && !!host && popupsAllowed(tab.profileId, host)
  }
  const previousBlocked = tabs.onPopupBlocked
  tabs.onPopupBlocked = (tabId, url, referrer) => {
    previousBlocked?.(tabId, url, referrer)
    const list = (blocked.get(tabId) ?? []).filter((b) => b.url !== url)
    list.push({ url, referrer })
    setBlocked(tabId, list.slice(-20))
  }
  // A new page starts with nothing blocked.
  ctx.hooks.tabNavigated.push((tabId) => {
    if (blocked.has(tabId)) setBlocked(tabId, [])
  })

  let lastBlockedMenu: { items: MenuItemConstructorOptions[] } | null = null
  commands.register('nav.blockedPopupsMenu', ({ x, y }, c) => {
    const windowId = c.windowId ?? windows.focusedWindowId()
    // The page the address display shows: an open Peek's (PK-11), else the active tab's.
    const tabId = windowId ? shownTabId(store.state, windowId) : null
    const tab = tabId ? store.state.tabs[tabId] : undefined
    if (!windowId || !tabId || !tab) return
    const host = hostOf(tabs.contents(tabId)?.getURL() || tab.url)
    const urls = blocked.get(tabId) ?? []
    const allowed = !!host && popupsAllowed(tab.profileId, host)
    const items: MenuItemConstructorOptions[] = [
      { label: `Pop-ups blocked on ${host || 'this page'}`, enabled: false },
      ...urls
        .slice(-BLOCKED_SHOWN)
        .reverse()
        .map(
          ({ url, referrer }): MenuItemConstructorOptions => ({
            label: `Open ${url.length > 60 ? `${url.slice(0, 59)}…` : url}`,
            click: () => {
              setBlocked(
                tabId,
                (blocked.get(tabId) ?? []).filter((b) => b.url !== url),
              )
              // With the referrer the page's own request would have had (review B-F1).
              ops.createTab({
                url,
                spaceId: tab.spaceId,
                windowId,
                activate: true,
                openerTabId: tabId,
                load: { httpReferrer: referrer },
              })
            },
          }),
        ),
      { type: 'separator' },
      {
        label: `Always Allow Pop-ups from ${host || 'This Site'}`,
        type: 'checkbox',
        checked: allowed,
        enabled: !!host,
        click: () => {
          setPopupsAllowed(tab.profileId, host, !allowed)
          if (!allowed) setBlocked(tabId, [])
        },
      },
    ]
    lastBlockedMenu = { items }
    if (ctx.e2e) return
    const win = windows.get(windowId)
    if (!win || win.isDestroyed()) return
    Menu.buildFromTemplate(items).popup({
      window: win,
      x: Math.round(x),
      y: Math.round(y),
      callback: () => {
        lastBlockedMenu = null
      },
    })
  })

  return {
    blockedMenu: () =>
      lastBlockedMenu
        ? lastBlockedMenu.items
            .filter((i) => i.type !== 'separator')
            .map((i) => (i.enabled === false ? `[${i.label}]` : String(i.label)))
        : null,
    chooseBlocked: (label) => {
      const item = lastBlockedMenu?.items.find((i) => i.label === label)
      if (!item?.click) return false
      ;(item.click as () => void)()
      lastBlockedMenu = null
      return true
    },
  }
}
