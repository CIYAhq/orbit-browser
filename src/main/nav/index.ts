import { join } from 'node:path'
import { app, Menu, type MenuItemConstructorOptions, nativeImage } from 'electron'
import { ACTIONS_BY_ID, formatAccelerator, shortcutsFor } from '../../shared/actions'
import type { HistoryEntryInfo, NavButton, NavDirection } from '../../shared/commands/nav'
import { historyEntryLabel, historyMenuIndexes, shownTabId } from '../../shared/nav'
import { isPrivateTab, isPrivateWindow } from '../../shared/private'
import type { TabId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import { escapeThenStop } from '../keys/escape'
import type { CallContext } from '../registry'
import { registerSiteSettings } from '../settings/site-settings'
import type { TabOps, TabPage } from '../tabs/ops'
import { type LinkPillInfo, registerLinkPill } from './link-pill'
import { type LinksTestHooks, registerLinks } from './links'
import { type LoadingInfo, registerLoading } from './loading'
import { openUrlInNewWindow } from './new-window'
import { registerPageBridge } from './page-bridge'
import { registerPageColor } from './page-color'
import { type PageMenuTestHooks, pageMenuTestHooks, setLinkOpeners } from './page-menu'
import { type PageToolsInfo, registerPageTools } from './page-tools'
import { registerPendingUrl } from './pending-url'
import { type PermissionDialogInfo, registerPermissions } from './permissions'
import { type PrivateWindows, registerPrivate } from './private'
import { type RevealHoldInfo, registerSidebarReveal } from './sidebar-reveal'
import { registerSiteControls } from './site-controls'
import { SitePrefs } from './site-prefs'

/** Test-only handle (ORBIT_E2E=1): globalThis.__orbitNav. */
export interface NavTestHooks extends LinksTestHooks, PageMenuTestHooks {
  /** The history menu on screen (labels top to bottom, and which items have an icon), or null once it closed. */
  menu: () => { windowId: WindowId; direction: NavDirection; labels: string[]; icons: boolean[] } | null
  /** Chooses an item of the open history menu by label; `newTab` is a ⌘-click (Ctrl-click). */
  chooseMenu: (label: string, newTab?: boolean) => boolean
  /** A window's page tools (default: the first): what the find bar and zoom indicator show, and where (NV-05, NV-06). */
  tools: (windowId?: WindowId) => PageToolsInfo
  /**
   * A window's permission prompt view (default: the first): placed while the sidebar is hidden
   * (NV-15); `covered` while it is placed under a page cover such as the Library.
   */
  prompt: (windowId?: WindowId) => {
    placed: boolean
    covered: boolean
    bounds?: { x: number; y: number; width: number; height: number }
  }
  /** The plain permission dialogs open for pages without a sidebar (Peek, Mini Window, pop-up), oldest first. */
  permissionDialogs: () => PermissionDialogInfo[]
  /** Answers the oldest permission dialog with a button's label, or `cancel` (Esc). */
  answerPermissionDialog: (button: string) => boolean
  /** The corner radius of a shown page's card (0 without a frame: full screen) (SB-19). */
  corner: (tabId: TabId) => number | null
  /** The floating sidebar of a window (default: the first): its view, and what keeps it out (SB-12). */
  floating: (windowId?: WindowId) => {
    exists: boolean
    placed: boolean
    shown: boolean
    bounds?: { x: number; y: number; width: number; height: number }
    hold: RevealHoldInfo | null
  }
  /**
   * The pointer Orbit reads for the sidebar's edge, at `x`, `y` of a window's content (default: the
   * first), inside it or not: a real pointer where no view hears it (SB-12, fix check A M1).
   */
  pointerAt: (x: number, y: number, windowId?: WindowId) => void
  /** A window's page loading indicator (default: the first) (SB-28). */
  loading: (windowId?: WindowId) => LoadingInfo
  /** A window's link status pill (default: the first) (SB-27). */
  linkPill: (windowId?: WindowId) => LinkPillInfo
}

interface ShownMenu {
  windowId: WindowId
  tabId: TabId
  direction: NavDirection
  entries: HistoryEntryInfo[]
  /** Which entries have an icon in the menu. */
  icons: boolean[]
  menu?: Menu
}

const isMac = process.platform === 'darwin'

/**
 * Page navigation (NV-01, NV-03, NV-04) and the sidebar top row's buttons (SB-03): Back, Forward,
 * Reload and Stop with their keys, history menus, ⌘-click/middle-click into new tabs and Esc to
 * stop loading.
 */
export function registerNav(ctx: MainContext, ops: TabOps): void {
  const { store, commands, actions, tabs, windows } = ctx
  const windowOf = (c: CallContext): WindowId | undefined => c.windowId ?? windows.focusedWindowId()
  /** The tab the top row acts on: an open Peek's page (PK-11), else the active tab. */
  const shownTab = (windowId: WindowId | undefined): TabId | null =>
    windowId ? shownTabId(store.state, windowId) : null

  /** Keyboard focus goes to the page (after Reload, or a top-row button press), unless an overlay holds it. */
  const focusPage = (windowId: WindowId | undefined, tabId: TabId) => {
    if (!windowId || windows.windowOfTab(tabId) !== windowId) return
    if (store.state.windows[windowId]?.overlay.kind !== 'none') return
    if (!windows.get(windowId)?.isFocused()) return
    tabs.contents(tabId)?.focus()
  }

  /** A tab opened behind the current one: with the sidebar hidden it would appear unseen, so say so. */
  const openedInBackground = (windowId: WindowId | undefined, tabId: TabId) => {
    tabs.ensure(tabId)
    if (windowId && !store.state.windows[windowId]?.sidebar.visible) {
      // With a button that goes to it (SB-13).
      ctx.toast(windowId, 'Opened in a new tab', { label: 'Show', command: 'tabs.activate', args: { tabId } })
    }
  }

  // The address while a page is on its way or failed (NV-04, NV-13), and the loading indicator (SB-28).
  const pending = registerPendingUrl(ctx)
  const loading = registerLoading(ctx)
  const linkPill = registerLinkPill(ctx)

  const go = (tabId: TabId, button: NavButton) => {
    if (button === 'back') return commands.run('tabs.back', { tabId })
    if (button === 'forward') return commands.run('tabs.forward', { tabId })
    if (button === 'reload') return commands.run('tabs.reload', { tabId })
    pending.markStopped(tabId)
    return commands.run('tabs.stop', { tabId })
  }

  const historyEntries = (tabId: TabId, direction: NavDirection): HistoryEntryInfo[] => {
    const history = ops.historyOf(tabId)
    if (!history) return []
    return historyMenuIndexes(history.entries.length, history.index, direction).flatMap((index) => {
      const entry = history.entries[index]
      if (!entry) return []
      const favicon = tabs.faviconFor(entry.url)
      return [{ index, url: entry.url, title: entry.title, ...(favicon ? { favicon } : {}) }]
    })
  }

  /** Opens entry `index` of a tab's history in a new tab that keeps the whole history (NV-01). */
  const openEntryInNewTab = (
    windowId: WindowId | undefined,
    tabId: TabId,
    index: number,
    foreground: boolean,
  ): TabId | null => {
    const history = ops.historyOf(tabId)
    const entry = history?.entries[index]
    if (!history || !entry) return null
    const id = ops.createTab({
      url: entry.url,
      title: entry.title || undefined,
      windowId,
      activate: foreground,
      history: { entries: history.entries, index },
    })
    if (!foreground) openedInBackground(windowId, id)
    return id
  }

  commands.register('nav.press', async ({ button, newTab = false, foreground = false }, c) => {
    const windowId = windowOf(c)
    const tabId = shownTab(windowId)
    if (!windowId || !tabId) return null
    if (!newTab) {
      await go(tabId, button)
      focusPage(windowId, tabId)
      return null
    }
    if (button === 'stop') return null
    if (button === 'reload') {
      // ⌘-click Reload duplicates the tab with its history (NV-03).
      const id = await commands.run('tabs.duplicate', { tabId, activate: foreground }, { windowId })
      if (!foreground) openedInBackground(windowId, id)
      return id
    }
    const history = ops.historyOf(tabId)
    if (!history) return null
    return openEntryInNewTab(windowId, tabId, history.index + (button === 'back' ? -1 : 1), foreground)
  })

  commands.register('nav.history', ({ tabId, direction }, c) => {
    const id = tabId ?? shownTab(windowOf(c))
    return id ? historyEntries(id, direction) : []
  })

  commands.register('nav.goToIndex', ({ tabId, index, newTab = false }, c) => {
    const windowId = windowOf(c)
    const id = tabId ?? shownTab(windowId)
    if (!id) return null
    if (newTab) return openEntryInNewTab(windowId, id, index, false)
    const contents = tabs.contents(id)
    if (contents) {
      if (index >= 0 && index < contents.navigationHistory.length()) contents.navigationHistory.goToIndex(index)
    } else {
      // A sleeping tab wakes up on the chosen entry.
      const saved = tabs.savedHistory.get(id)
      if (!saved || index < 0 || index >= saved.entries.length) return null
      saved.index = index
      tabs.ensure(id)
    }
    focusPage(windowId, id)
    return null
  })

  // ---- History menu (long-press or right-click on Back/Forward) ----
  let shown: ShownMenu | null = null
  const closeMenu = () => {
    const current = shown
    shown = null
    if (!current?.menu) return
    const win = windows.get(current.windowId)
    try {
      current.menu.closePopup(win)
    } catch {
      // The window is gone; so is its menu.
    }
  }
  const choose = (menu: ShownMenu, index: number, newTab: boolean) => {
    if (shown === menu) shown = null
    void commands.run('nav.goToIndex', { tabId: menu.tabId, index, newTab }, { windowId: menu.windowId })
  }
  const newTabClick = (event: Electron.KeyboardEvent) => !!(isMac ? event.metaKey : event.ctrlKey)

  commands.register('nav.historyMenu', ({ direction, x, y, icons }, c) => {
    const windowId = windowOf(c)
    const tabId = shownTab(windowId)
    closeMenu()
    if (!windowId || !tabId) return
    const entries = historyEntries(tabId, direction)
    if (entries.length === 0) return
    const items = entries.map((entry) => ({ entry, icon: menuIcon(entry.favicon, icons) }))
    const record: ShownMenu = { windowId, tabId, direction, entries, icons: items.map((item) => !!item.icon) }
    shown = record
    // Under test the menu is recorded, not shown: a native menu would hold the main loop on macOS.
    if (ctx.e2e) return
    const win = windows.get(windowId)
    if (!win) return
    const template: MenuItemConstructorOptions[] = items.map(({ entry, icon }) => ({
      label: menuLabel(entry),
      icon,
      click: (_item, _window, event) => choose(record, entry.index, newTabClick(event)),
    }))
    const menu = Menu.buildFromTemplate(template)
    record.menu = menu
    menu.popup({
      window: win,
      x: Math.round(x),
      y: Math.round(y),
      callback: () => {
        if (shown === record) shown = null
      },
    })
  })

  // The menu belongs to the tab it was opened for: switching tab closes it (NV-01).
  store.subscribe((next) => {
    if (shown && shownTabId(next, shown.windowId) !== shown.tabId) closeMenu()
  })

  // ---- Keys and mouse buttons ----
  const onActive = (fn: (tabId: TabId, windowId: WindowId) => void) => (c: CallContext) => {
    const windowId = windowOf(c)
    const tabId = ops.activeTab(windowId)
    if (windowId && tabId) fn(tabId, windowId)
  }
  actions.register(
    'nav.back',
    onActive((tabId) => void go(tabId, 'back')),
  )
  actions.register(
    'nav.forward',
    onActive((tabId) => void go(tabId, 'forward')),
  )
  // After a reload the page has keyboard focus (NV-03).
  actions.register(
    'nav.reload',
    onActive((tabId, windowId) => {
      void go(tabId, 'reload')
      focusPage(windowId, tabId)
    }),
  )
  actions.register(
    'nav.hardReload',
    onActive((tabId, windowId) => {
      void commands.run('tabs.reload', { tabId, ignoreCache: true })
      focusPage(windowId, tabId)
    }),
  )
  actions.register(
    'nav.stop',
    onActive((tabId) => void go(tabId, 'stop')),
  )
  // Copying the address the long way (command bar, ⌘C) teaches the shortcut, once (NV-17).
  const prefs = new SitePrefs(join(ctx.paths.userData, 'orbit-site-prefs.json'))
  prefs.load()
  app.on('before-quit', () => prefs.flush())
  // A deleted profile's site choices go with its data (review B-F7).
  store.subscribe((next, prev) => {
    if (next.profiles === prev.profiles) return
    for (const id of Object.keys(prev.profiles)) if (!next.profiles[id]) prefs.forgetProfile(id)
  })
  commands.register('nav.copyHint', (_args, c) => {
    if (prefs.hintShown('copy-url')) return
    const action = ACTIONS_BY_ID['tab.copyUrl']
    const accel = action ? shortcutsFor(action, process.platform)[0] : undefined
    if (!accel) return
    prefs.markHint('copy-url')
    ctx.toast(windowOf(c), `Tip: ${formatAccelerator(accel, process.platform)} copies the page's link`)
  })

  // The hidden sidebar's hover reveal (SB-12, FL-03).
  const reveal = registerSidebarReveal(ctx)
  registerPageColor(ctx)
  // Find in page and page zoom (NV-05, NV-06).
  const pageTools = registerPageTools(ctx, prefs)
  // Private windows (NV-11).
  const privateWindows: PrivateWindows = registerPrivate(ctx, ops, prefs)
  /** A link in a new window: a private one when it comes from a private window (NV-08, NV-12). */
  const openLinkWindow = (url: string, from: { tabId?: TabId; windowId?: WindowId }, page?: TabPage) => {
    const state = store.state
    if ((from.tabId && isPrivateTab(state, from.tabId)) || isPrivateWindow(state, from.windowId)) {
      privateWindows.open({ url, fromWindowId: from.windowId, page })
    } else {
      openUrlInNewWindow(ctx, ops, url, from.windowId, page)
    }
  }
  // Modified clicks on links, pop-ups and downloads (NV-08, NV-09).
  const links = registerLinks(ctx, { ops, prefs, openWindow: openLinkWindow })
  // The page menu's Open Link in New Window / Private Window (NV-12).
  setLinkOpeners({
    tab: (url, from, referrer) => {
      const opener = from.tabId ? store.state.tabs[from.tabId] : undefined
      const windowId = from.windowId ?? windows.focusedWindowId()
      const id = ops.createTab({
        url,
        spaceId: opener?.spaceId,
        windowId,
        activate: false,
        openerTabId: opener?.id,
        load: { httpReferrer: referrer },
      })
      // It loads in the background, as a ⌘-clicked link's tab does, and says so while the sidebar is hidden (NV-12).
      openedInBackground(windowId, id)
    },
    window: openLinkWindow,
    private: (url, from) => void privateWindows.open({ url, fromWindowId: from.windowId }),
  })

  // Permission prompts and the site controls panel (NV-15, NV-16).
  const permissions = registerPermissions(ctx, prefs)
  registerSiteControls(ctx, prefs, permissions)
  // Settings → Site settings shows and changes the same choices (ST-13, settings lane).
  registerSiteSettings(ctx, prefs, permissions)
  // The web page preload: permission states as Chromium reads them, notification clicks (NV-15).
  registerPageBridge(ctx, permissions)

  ctx.hooks.tabCreated.push((tabId, contents) => {
    // Esc stops a loading page (NV-04), unless the page uses it: the page gets the key first, and
    // Orbit stops the load once the page's preload says no handler took it (D59, keys lane). An
    // open overlay (command bar, find bar, Peek) holds keyboard focus and takes Esc before the page
    // could see it (KS-19). An Esc that left full screen (NV-20, src/main/pages/fullscreen.ts) is
    // taken from the page: it stops nothing.
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'Escape' || event.defaultPrevented) return
      if (input.meta || input.control || input.alt || input.shift) return
      if (!store.state.tabs[tabId]?.loading) return
      const windowId = windows.windowOfTab(tabId)
      if (windowId && store.state.windows[windowId]?.overlay.kind !== 'none') return
      escapeThenStop(
        contents,
        () => !!store.state.tabs[tabId]?.loading,
        () => {
          pending.markStopped(tabId)
          contents.stop()
        },
      )
    })
    // The mouse's back/forward buttons over a page need nothing here: the page itself goes back or
    // forward one entry on release (Chromium), unless it handles the buttons (NV-01). Over the
    // sidebar they switch Spaces instead (SP-09).
  })

  if (ctx.e2e) {
    const hooks: NavTestHooks = {
      ...links,
      ...pageMenuTestHooks,
      menu: () =>
        shown
          ? {
              windowId: shown.windowId,
              direction: shown.direction,
              labels: shown.entries.map((e) => historyEntryLabel(e.title, e.url)),
              icons: shown.icons,
            }
          : null,
      chooseMenu: (label, newTab = false) => {
        const menu = shown
        const entry = menu?.entries.find((e) => historyEntryLabel(e.title, e.url) === label)
        if (!menu || !entry) return false
        choose(menu, entry.index, newTab)
        return true
      },
      corner: (tabId) => windows.cornerOf(tabId) ?? null,
      tools: (windowId) => pageTools.info(windowId ?? windows.ids()[0] ?? ''),
      prompt: (windowId) => permissions.info(windowId ?? windows.ids()[0] ?? ''),
      permissionDialogs: () => permissions.dialogs(),
      answerPermissionDialog: (button) => permissions.answerDialog(button),
      floating: (windowId) => {
        const id = windowId ?? windows.ids()[0] ?? ''
        return { ...windows.floatingInfo(id), hold: reveal.hold(id) ?? null }
      },
      pointerAt: (x, y, windowId) => reveal.pointerAt(windowId ?? windows.ids()[0] ?? '', x, y),
      loading: (windowId) => loading.info(windowId ?? windows.ids()[0] ?? ''),
      linkPill: (windowId) => linkPill.info(windowId ?? windows.ids()[0] ?? ''),
    }
    ;(globalThis as unknown as { __orbitNav: NavTestHooks }).__orbitNav = hooks
  }
}

/** A history menu item's label. On Windows and Linux a single & would mark a mnemonic. */
function menuLabel(entry: HistoryEntryInfo): string {
  const label = historyEntryLabel(entry.title, entry.url)
  return isMac ? label : label.replace(/&/g, '&&')
}

/**
 * A history menu item's 16 px icon, with a 2× version when the favicon is big enough. SVG favicons
 * come drawn as PNG by the shell (`rasters`, keyed by the SVG data URL): native menus can't draw SVG.
 */
function menuIcon(
  favicon: string | undefined,
  rasters: Record<string, string> | undefined,
): Electron.NativeImage | undefined {
  if (!favicon) return undefined
  let source: string | undefined = favicon
  if (favicon.startsWith('data:image/svg+xml')) {
    const png = rasters?.[favicon]
    source =
      typeof png === 'string' && png.startsWith('data:image/png;base64,') && png.length <= 64 * 1024 ? png : undefined
  }
  if (!source) return undefined
  const image = nativeImage.createFromDataURL(source)
  if (image.isEmpty()) return undefined
  const icon = nativeImage.createEmpty()
  icon.addRepresentation({
    scaleFactor: 1,
    dataURL: image.resize({ width: 16, height: 16, quality: 'best' }).toDataURL(),
  })
  if (image.getSize().width >= 32) {
    icon.addRepresentation({
      scaleFactor: 2,
      dataURL: image.resize({ width: 32, height: 32, quality: 'best' }).toDataURL(),
    })
  }
  return icon
}
