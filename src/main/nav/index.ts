import { join } from 'node:path'
import { app, Menu, type MenuItemConstructorOptions, nativeImage } from 'electron'
import { ACTIONS_BY_ID, formatAccelerator, shortcutsFor } from '../../shared/actions'
import type { HistoryEntryInfo, NavButton, NavDirection } from '../../shared/commands/nav'
import { historyEntryLabel, historyMenuIndexes } from '../../shared/nav'
import { isPrivateTab, isPrivateWindow } from '../../shared/private'
import type { TabId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import type { CallContext } from '../registry'
import type { TabOps } from '../tabs/ops'
import { activeTabOf } from '../windows'
import { type LinksTestHooks, registerLinks } from './links'
import { openUrlInNewWindow } from './new-window'
import { registerPageColor } from './page-color'
import { type PageMenuTestHooks, pageMenuTestHooks, setLinkOpeners } from './page-menu'
import { type PageToolsInfo, registerPageTools } from './page-tools'
import { type PrivateWindows, registerPrivate } from './private'
import { type RevealHoldInfo, registerSidebarReveal } from './sidebar-reveal'
import { SitePrefs } from './site-prefs'

/** Test-only handle (ORBIT_E2E=1): globalThis.__orbitNav. */
export interface NavTestHooks extends LinksTestHooks, PageMenuTestHooks {
  /** The history menu on screen (labels top to bottom, and which items have an icon), or null once it closed. */
  menu: () => { windowId: WindowId; direction: NavDirection; labels: string[]; icons: boolean[] } | null
  /** Chooses an item of the open history menu by label; `newTab` is a ⌘-click (Ctrl-click). */
  chooseMenu: (label: string, newTab?: boolean) => boolean
  /** A window's page tools (default: the first): what the find bar and zoom indicator show, and where (NV-05, NV-06). */
  tools: (windowId?: WindowId) => PageToolsInfo
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
    if (windowId && !store.state.windows[windowId]?.sidebar.visible) ctx.toast(windowId, 'Opened in a new tab')
  }

  const go = (tabId: TabId, button: NavButton) => {
    if (button === 'back') return commands.run('tabs.back', { tabId })
    if (button === 'forward') return commands.run('tabs.forward', { tabId })
    if (button === 'reload') return commands.run('tabs.reload', { tabId })
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
    const tabId = ops.activeTab(windowId)
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
    const id = tabId ?? ops.activeTab(windowOf(c))
    return id ? historyEntries(id, direction) : []
  })

  commands.register('nav.goToIndex', ({ tabId, index, newTab = false }, c) => {
    const windowId = windowOf(c)
    const id = tabId ?? ops.activeTab(windowId)
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
    const tabId = ops.activeTab(windowId)
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
    if (shown && activeTabOf(next, shown.windowId) !== shown.tabId) closeMenu()
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
  // Find in page and page zoom (NV-05, NV-06). Registered after the tabs lane, so its zoom actions are replaced.
  const pageTools = registerPageTools(ctx, prefs)
  // Private windows (NV-11).
  const privateWindows: PrivateWindows = registerPrivate(ctx, ops, prefs)
  /** A link in a new window: a private one when it comes from a private window (NV-08, NV-12). */
  const openLinkWindow = (url: string, from: { tabId?: TabId; windowId?: WindowId }) => {
    const state = store.state
    if ((from.tabId && isPrivateTab(state, from.tabId)) || isPrivateWindow(state, from.windowId)) {
      privateWindows.open({ url, fromWindowId: from.windowId })
    } else {
      openUrlInNewWindow(ctx, ops, url, from.windowId)
    }
  }
  // Modified clicks on links, pop-ups and downloads (NV-08, NV-09).
  const links = registerLinks(ctx, { ops, prefs, openWindow: openLinkWindow })
  // The page menu's Open Link in New Window / Private Window (NV-12).
  setLinkOpeners({
    window: openLinkWindow,
    private: (url, from) => void privateWindows.open({ url, fromWindowId: from.windowId }),
  })

  // Placeholder until the site controls panel (NV-16) lands.
  actions.register('site.controls', (c) => ctx.toast(windowOf(c), 'Site controls are coming soon'))

  ctx.hooks.tabCreated.push((tabId, contents) => {
    // Esc stops a loading page (NV-04). The page still gets the key; an open overlay (command bar,
    // find bar, Peek) holds keyboard focus and takes Esc before the page could see it (KS-19).
    contents.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'Escape') return
      if (input.meta || input.control || input.alt || input.shift) return
      if (!store.state.tabs[tabId]?.loading) return
      const windowId = windows.windowOfTab(tabId)
      if (windowId && store.state.windows[windowId]?.overlay.kind !== 'none') return
      contents.stop()
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
      floating: (windowId) => {
        const id = windowId ?? windows.ids()[0] ?? ''
        return { ...windows.floatingInfo(id), hold: reveal.hold(id) ?? null }
      },
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
