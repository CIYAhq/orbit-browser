import {
  type BrowserWindow,
  clipboard,
  dialog,
  WebContentsView,
  type WebContentsViewConstructorOptions,
} from 'electron'
import { sidebarUndoLabel } from '../../shared/actions'
import { isBlankSpace } from '../../shared/blank'
import { isFolderId, isTabId, newId } from '../../shared/ids'
import { framesMayOpen, isLocalFileUrl, localFileBlockedMessage } from '../../shared/link-routing'
import { isPrivateTab, privateTabMenu } from '../../shared/private'
import type { ContainerRef, Folder, FolderId, ItemId, TabId, WindowId } from '../../shared/state'
import type { ToastAction } from '../../shared/toast'
import {
  containerItems,
  insertItem,
  locate,
  profileOfContainer,
  rootContainerOf,
  sectionOf,
  sidebarTabOrder,
  splitOfTab,
  tabsInItem,
} from '../../shared/tree'
import { engineForWindow, parseInput } from '../../shared/url'
import type { MainContext } from '../context'
import { KEEP_KEYBOARD } from '../keys/focus'
import { TAB_MENU_KEYS, withKeyHints } from '../keys/menu-hints'
import type { CallContext } from '../registry'
import { tabSplitMenuItems } from '../split/menu'
import { registerBlankWindows } from './blank'
import { registerLinkDrop } from './link-drop'
import { TabMaintenance } from './maintenance'
import { folderMenu, type MenuOps, tabMenu } from './menus'
import { makeTab, numberedTarget, steppedTarget, todayInsertIndex } from './model'
import { TabOps, type TabPage } from './ops'
import { type RowMenuInfo, registerRowMenus } from './row-menu'
import { registerThemeUndo } from './theme-undo'
import { registerToastView, type ToastViewInfo } from './toasts'

/** Test-only handle (ORBIT_E2E=1): globalThis.__orbitTabs. */
export interface TabTestHooks {
  maintenance: (now?: number) => { archived: string[]; slept: string[] }
  /** Moves the maintenance clock ahead, as if that much time had passed (TD-02, TD-03). */
  clockAhead: (ms: number) => void
  /** The maintenance pass shortly after launch has run. */
  launchPassDone: () => boolean
  /** The row menu open in a window (default: the focused one), as the overlay draws it (TB-14). */
  rowMenu: (windowId?: WindowId) => RowMenuInfo | null
  /** Chooses an item of the open row menu by its label path ("Move to > Work > Pinned"), as a click does. */
  chooseRowMenu: (path: string, windowId?: WindowId) => boolean
  /** The toast view over the page card while the sidebar is hidden (SB-13). */
  toastView: (windowId?: WindowId) => ToastViewInfo
  undo: () => string | undefined
  recentlyClosed: () => string[]
}

/** ⌘Z pressed in a page only undoes sidebar changes this recent (lane review FU-4). */
const PAGE_UNDO_MAX_AGE_MS = 60_000

export function registerTabs(ctx: MainContext): { ops: TabOps; maintenance: TabMaintenance } {
  const { store, commands, actions, tabs, windows } = ctx
  const ops = new TabOps(ctx)
  /** Test runs move the maintenance clock ahead (clockAhead); otherwise it is the real one. */
  let ahead = 0
  const maintenance = new TabMaintenance(ctx, ops, () => Date.now() + ahead)

  const windowOf = (c: CallContext): WindowId | undefined => c.windowId ?? windows.focusedWindowId()
  /** Multi-selection per window, reported by the sidebar (TB-13). */
  const selections = new Map<WindowId, TabId[]>()
  /**
   * The window's multi-selection, honoured only while it is about what the window shows: it holds
   * the selected tab and every tab sits in the window's Space (or its profile's Favorites).
   * Otherwise it is stale (the user switched Space or tab) and dropped (lane review MF-3).
   */
  const selectionOf = (windowId: WindowId | undefined): TabId[] => {
    if (!windowId) return []
    const ids = selections.get(windowId) ?? []
    if (ids.length === 0) return []
    const state = store.state
    const win = state.windows[windowId]
    const space = win ? state.spaces[win.spaceId] : undefined
    const active = win?.activeTab[win.spaceId]
    const inView = (id: TabId) => {
      const tab = state.tabs[id]
      if (!tab || !space) return false
      const loc = locate(state, splitOfTab(state, id) ?? id)
      const root = loc ? rootContainerOf(state, loc.container) : undefined
      if (root?.kind === 'favorites') return root.profileId === space.profileId
      return root?.kind === 'pinned' || root?.kind === 'today' ? root.spaceId === space.id : false
    }
    if (!active || !ids.includes(active) || !ids.every(inView)) {
      clearSelectionIn(windowId)
      return []
    }
    return ids
  }
  const clearSelectionIn = (windowId: WindowId | undefined) => {
    if (!windowId) return
    selections.delete(windowId)
    windows.sendToWindow(windowId, 'sidebar:clear-selection', {})
  }
  const send = (windowId: WindowId | undefined, channel: string, payload: unknown) => {
    if (windowId) windows.sendToWindow(windowId, channel, payload)
  }
  const toast = (windowId: WindowId | undefined, message: string, action?: ToastAction) =>
    ctx.toast(windowId, message, action)

  const copyLinks = (windowId: WindowId | undefined, tabIds: TabId[], markdown: boolean) => {
    const text = ops.linkText(tabIds, markdown)
    if (!text) return ''
    void clipboard.writeText(text)
    toast(windowId, tabIds.length > 1 ? `Copied ${tabIds.length} links` : 'Copied')
    return text
  }

  const pasteUrlAsTab = async (windowId: WindowId | undefined, container?: ContainerRef) => {
    const text = (await clipboard.readText()).trim()
    if (!text) {
      toast(windowId, 'Nothing to paste')
      return null
    }
    const parsed = parseInput(text, engineForWindow(store.state, windowId))
    return ops.createTab({ url: parsed.url, container, windowId, activate: true })
  }

  const duplicateFolder = (folderId: FolderId) => {
    const state = store.state
    const loc = locate(state, folderId)
    if (!loc) return
    const copyItem = (id: ItemId): ItemId | undefined => {
      if (isTabId(id)) {
        const t = state.tabs[id]
        if (!t) return undefined
        const copy = makeTab({
          spaceId: t.spaceId,
          profileId: t.profileId,
          url: t.url,
          title: t.title,
          favicon: t.favicon,
          pinnedUrl: t.pinnedUrl,
          pinnedTitle: t.pinnedTitle,
          pinnedResolvedUrl: t.pinnedResolvedUrl,
          customTitle: t.customTitle,
          icon: t.icon,
        })
        newTabs.push(copy)
        return copy.id
      }
      if (isFolderId(id)) {
        const f = state.folders[id]
        if (!f) return undefined
        const copy: Folder = {
          id: newId('f'),
          name: id === folderId ? `${f.name} copy` : f.name,
          collapsed: f.collapsed,
          createdAt: Date.now(),
          icon: f.icon,
          children: [],
        }
        newFolders.push(copy)
        copy.children = f.children.map(copyItem).filter((x): x is ItemId => !!x)
        return copy.id
      }
      return undefined
    }
    const newTabs: ReturnType<typeof makeTab>[] = []
    const newFolders: Folder[] = []
    const rootId = copyItem(folderId)
    if (!rootId) return
    store.update((d) => {
      for (const t of newTabs) d.tabs[t.id] = t
      for (const f of newFolders) d.folders[f.id] = f
      insertItem(d, loc.container, loc.index + 1, rootId)
    })
  }

  const confirmDeleteFolder = async (windowId: WindowId | undefined, folderId: FolderId) => {
    const folder = store.state.folders[folderId]
    if (!folder) return
    const count = tabsInItem(store.state, folderId).length
    if (count > 0 && !ctx.e2e) {
      const win = windowId ? windows.get(windowId) : undefined
      // Sidebar undo's key as it is now (KS-05, KS-18).
      const key = sidebarUndoLabel(process.platform)
      const options = {
        type: 'warning' as const,
        buttons: ['Delete', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: `Delete “${folder.name}”?`,
        detail: `Its ${count} ${count === 1 ? 'tab moves' : 'tabs move'} to the Archive.${key ? ` You can undo this with ${key}.` : ''}`,
      }
      const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
      if (response !== 0) return
    }
    ops.deleteFolder(folderId, false)
  }

  /** A menu item that edits in the sidebar gives it the keyboard (the menu gave it to the page). */
  const toSidebar = (windowId: WindowId | undefined, channel: string, payload: unknown) => {
    if (windowId) windows.sidebarContents(windowId)?.focus()
    send(windowId, channel, payload)
  }
  const menuOps = (windowId: WindowId | undefined): MenuOps => ({
    rename: (id) => toSidebar(windowId, 'sidebar:rename', { id }),
    changeIcon: (id) => toSidebar(windowId, 'sidebar:icon', { id }),
    copyLinks: (tabIds, markdown) => void copyLinks(windowId, tabIds, markdown),
    duplicate: (tabId) => void commands.run('tabs.duplicate', { tabId }, { windowId }).catch(() => {}),
    setMuted: (tabId, muted) => void commands.run('tabs.setMuted', { tabId, muted }, { windowId }),
    moveTo: (ids, to) => {
      const target = containerItems(store.state, to)
      const index = to.kind === 'today' ? 0 : (target?.length ?? 0)
      ops.moveItems(ids, to, index, { windowId, undoLabel: 'Move' })
    },
    pin: (tabIds) => {
      for (const id of tabIds) ops.pin(id, undefined, windowId)
    },
    unpin: (tabIds) => {
      for (const id of [...tabIds].reverse()) ops.unpin(id, windowId)
    },
    favorite: (tabId) => void ops.favorite(tabId, windowId),
    archiveBelow: (tabId) => ops.archiveBelow(tabId),
    resetToPinned: (tabId) => ops.resetToPinned(tabId, { windowId }),
    replacePinnedUrl: (tabId) => ops.setPinnedUrl(tabId),
    editPinnedUrl: (tabId) => toSidebar(windowId, 'sidebar:edit-pinned-url', { id: tabId }),
    close: (tabIds) => ops.closeTabs(tabIds, 'closed'),
    remove: (id) => ops.deleteItem(id),
    newFolder: (items) => void commands.run('folders.create', { items }, { windowId }),
    setCollapsed: (folderId, collapsed) => void commands.run('folders.setCollapsed', { folderId, collapsed }),
    duplicateFolder,
    pasteUrlInto: (folderId) => void pasteUrlAsTab(windowId, { kind: 'folder', folderId }),
    deleteFolder: (folderId) => void confirmDeleteFolder(windowId, folderId),
    splitItems: (tabIds) => tabSplitMenuItems(ctx, tabIds, windowId),
  })

  const rowMenus = registerRowMenus(ctx)
  const toastView = registerToastView(ctx)
  registerThemeUndo(ctx, ops.undo)
  registerLinkDrop(ctx)
  registerBlankWindows(ctx, ops)
  /** What a row menu is about, for screen readers: the tab, the folder or the selection. */
  const menuLabelFor = (id: ItemId, selection: TabId[]): string => {
    const state = store.state
    if (selection.length > 1 && selection.includes(id as TabId)) return `${selection.length} tabs`
    if (isFolderId(id)) return state.folders[id]?.name ?? 'Folder'
    const tab = state.tabs[id as TabId]
    return tab?.customTitle || tab?.title || tab?.url || 'Tab'
  }

  // ---- Commands ----

  commands.register('tabs.create', ({ url, spaceId, container, index, activate = true }, c) =>
    ops.createTab({ url, spaceId, container, index, activate, windowId: windowOf(c) }),
  )

  commands.register('tabs.activate', ({ tabId }, c) => {
    const windowId = windowOf(c)
    if (windowId) ops.activate(windowId, tabId)
  })

  commands.register('tabs.close', ({ tabId, tabIds }) => {
    const ids = [...(tabIds ?? []), ...(tabId ? [tabId] : [])]
    ops.closeTabs(ids, 'closed')
  })

  commands.register('tabs.reopenClosed', ({ tabId }, c) =>
    tabId ? ops.reopen(tabId, windowOf(c)) : ops.reopenLast(windowOf(c)),
  )
  commands.register('tabs.favicon', ({ url }) => tabs.faviconFor(url) ?? null)
  commands.register('tabs.recentlyClosed', () =>
    [...ops.recentlyClosed]
      .reverse()
      .filter((r) => !store.state.tabs[r.tab.id])
      .map((r) => ({
        tabId: r.tab.id,
        url: r.tab.url,
        title: r.tab.customTitle || r.tab.title,
        favicon: r.tab.favicon,
        spaceId: r.tab.spaceId,
        profileId: r.tab.profileId,
        closedAt: r.closedAt ?? 0,
      })),
  )
  commands.register('tabs.undo', () => ops.undo.undo() ?? null)
  commands.register('tabs.redo', () => ops.undo.redo() ?? null)

  commands.register('tabs.navigate', ({ tabId, url }) => {
    tabs.navigate(tabId, url)
  })
  commands.register('tabs.back', ({ tabId }) => goBack(tabId))
  commands.register('tabs.forward', ({ tabId }) => tabs.contents(tabId)?.navigationHistory.goForward())
  commands.register('tabs.reload', ({ tabId, ignoreCache }) => {
    const contents = tabs.contents(tabId)
    if (!contents) return
    if (ignoreCache) contents.reloadIgnoringCache()
    else contents.reload()
  })
  commands.register('tabs.stop', ({ tabId }) => tabs.contents(tabId)?.stop())

  commands.register('tabs.move', ({ id, ids, to, index }, c) =>
    ops.moveItems(ids ?? [id], to, index, { windowId: windowOf(c) }),
  )
  commands.register('tabs.moveToSpace', ({ ids, spaceId, section }, c) =>
    ops.moveToSpace(ids, spaceId, section, windowOf(c)),
  )
  commands.register('tabs.splitWith', ({ tabId, target, side }, c) => ops.splitWith(tabId, target, side, windowOf(c)))
  commands.register('tabs.toNewWindow', ({ tabId, x, y }, c) =>
    ops.toNewWindow(tabId, windowOf(c), x !== undefined && y !== undefined ? { x, y } : undefined),
  )
  commands.register('tabs.pin', ({ tabId, spaceId }, c) => void ops.pin(tabId, spaceId, windowOf(c)))
  commands.register('tabs.unpin', ({ tabId }, c) => void ops.unpin(tabId, windowOf(c)))
  commands.register('tabs.favorite', ({ tabId }, c) => ops.favorite(tabId, windowOf(c)))
  commands.register('tabs.unfavorite', ({ tabId, section = 'pinned' }, c) =>
    ops.unfavorite(tabId, section, windowOf(c)),
  )
  commands.register('tabs.resetToPinned', ({ tabId, keepCurrent }, c) =>
    ops.resetToPinned(tabId, { keepCurrent, windowId: windowOf(c) }),
  )
  commands.register('tabs.setPinnedUrl', ({ tabId, url }, c) => {
    if (url === undefined) {
      ops.setPinnedUrl(tabId)
      return
    }
    // What was typed goes through the address parser; only web addresses can be pinned (PN-07).
    const parsed = parseInput(url, store.state.settings.searchEngine)
    if (parsed.kind !== 'url' || !/^https?:\/\//i.test(parsed.url)) {
      toast(windowOf(c), 'Enter a web address to pin')
      return
    }
    ops.setPinnedUrl(tabId, parsed.url)
  })
  commands.register('tabs.rename', ({ tabId, title }) => ops.rename(tabId, title))
  commands.register('tabs.setIcon', ({ tabId, icon }) => ops.setIcon(tabId, icon))
  commands.register('tabs.delete', ({ id }) => ops.deleteItem(id))
  commands.register('tabs.archiveBelow', ({ tabId }) => ops.archiveBelow(tabId))
  commands.register('tabs.copyLinks', ({ tabIds, markdown = false }, c) => copyLinks(windowOf(c), tabIds, markdown))

  commands.register('tabs.duplicate', ({ tabId, to, index, activate }, c) => {
    const state = store.state
    const tab = state.tabs[tabId]
    if (!tab) throw new Error('No such tab')
    const item = splitOfTab(state, tabId) ?? tabId
    const loc = locate(state, item)
    const pinned = !to && !!tab.pinnedUrl && sectionOf(state, tabId) !== 'today'
    // A copy dropped into another profile's Space starts fresh there (no history across profiles).
    const targetProfile = to ? (profileOfContainer(state, to) ?? tab.profileId) : tab.profileId
    const id = ops.createTab({
      url: tab.url,
      title: tab.title,
      favicon: tab.favicon,
      spaceId: to ? undefined : tab.spaceId,
      container: to ?? loc?.container,
      index: to ? index : loc ? loc.index + 1 : undefined,
      // A copy dropped with ⌥ stays in the background; Duplicate from the menu selects it.
      activate: activate ?? !to,
      windowId: windowOf(c),
      history: targetProfile === tab.profileId ? ops.historyOf(tabId) : undefined,
    })
    store.update((d) => {
      const copy = d.tabs[id]
      if (!copy) return
      if (tab.customTitle) copy.customTitle = tab.customTitle
      if (tab.icon) copy.icon = tab.icon
      if (pinned && tab.pinnedUrl) {
        copy.pinnedUrl = tab.pinnedUrl
        copy.pinnedTitle = tab.pinnedTitle
        copy.pinnedResolvedUrl = tab.pinnedResolvedUrl
      }
    })
    return id
  })

  commands.register('tabs.setMuted', ({ tabId, muted }) => {
    tabs.contents(tabId)?.setAudioMuted(muted)
    store.update((d) => {
      const tab = d.tabs[tabId]
      if (tab) tab.muted = muted
    })
  })

  commands.register('tabs.clearToday', ({ spaceId }, c) => ops.clearToday(spaceId ?? ops.spaceOfWindow(windowOf(c))))

  commands.register('tabs.setPinnedCollapsed', ({ spaceId, collapsed }, c) => {
    const id = spaceId ?? ops.spaceOfWindow(windowOf(c))
    store.update((d) => {
      const space = d.spaces[id]
      if (!space) return
      if (collapsed) space.pinnedCollapsed = true
      else delete space.pinnedCollapsed
    })
  })

  commands.register('tabs.setSelection', ({ tabIds }, c) => {
    const windowId = windowOf(c)
    if (!windowId) return
    if (tabIds.length > 0) selections.set(windowId, tabIds)
    else selections.delete(windowId)
  })
  commands.register('tabs.focusSidebar', (_args, c) => {
    const win = windows.get(windowOf(c) ?? '')
    if (win && !win.isDestroyed()) win.webContents.focus()
  })
  commands.register('tabs.focusPage', (_args, c) => {
    const windowId = windowOf(c)
    if (windowId) windows.focusActiveTab(windowId)
  })

  commands.register('tabs.contextMenu', ({ id, selection = [], at }, c) => {
    const windowId = windowOf(c)
    const state = store.state
    const mo = menuOps(windowId)
    // Keys lane: an item that a key also does shows the key (KS-18).
    const forTab = (tabId: TabId) => withKeyHints(tabMenu(state, tabId, selection, mo), TAB_MENU_KEYS)
    const all = isFolderId(id) ? folderMenu(state, id, mo) : isTabId(id) ? forTab(id) : []
    // Private and blank windows have no pinned tabs, Favorites, folders or other Spaces (NV-11, SB-25, TB-17).
    const own = isTabId(id) && (isPrivateTab(state, id) || isBlankSpace(state, state.tabs[id]?.spaceId))
    const items = own ? privateTabMenu(all) : all
    if (items.length === 0) return
    // Orbit's own menu in the overlay, in the Space's colours (TB-14, SP-16).
    rowMenus.show(windowId, items, { key: id, label: menuLabelFor(id, selection), at, sender: c.sender })
  })

  commands.register('folders.create', ({ container, index, name = 'New Folder', items = [] }, c) => {
    const windowId = windowOf(c)
    const id = ops.createFolder({ container, index, name, items, windowId })
    if (items.length === 0) send(windowId, 'sidebar:rename', { id, isNew: true })
    return id
  })

  commands.register('folders.rename', ({ folderId, name }) => {
    const folder = store.state.folders[folderId]
    if (!folder || !name.trim() || name.trim() === folder.name) return
    const old = folder.name
    const set = (value: string) =>
      store.update((d) => {
        const f = d.folders[folderId]
        if (f) f.name = value
      })
    set(name.trim())
    ops.undo.push('Rename Folder', () => set(old))
  })

  commands.register('folders.setIcon', ({ folderId, icon }) => {
    store.update((d) => {
      const f = d.folders[folderId]
      if (!f) return
      if (icon) f.icon = icon
      else delete f.icon
    })
  })

  commands.register('folders.setCollapsed', ({ folderId, collapsed }) => {
    store.update((d) => {
      const folder = d.folders[folderId]
      if (folder) folder.collapsed = collapsed
    })
  })

  commands.register('folders.delete', ({ folderId, keepChildren = false }, c) => {
    if (keepChildren) ops.deleteFolder(folderId, true)
    else void confirmDeleteFolder(windowOf(c), folderId)
  })

  // Links that open new windows become tabs (keeping window.opener), pop-ups become small windows
  // (NV-09). The runtime already refused opens without a user gesture. Registered last so link
  // preview and Mini Window hooks get first refusal (PN-05).
  queueMicrotask(() =>
    ctx.hooks.windowOpen.push((openerTabId, details) => {
      const opener = store.state.tabs[openerTabId]
      if (!opener) return undefined
      const isPopup = details.disposition === 'new-window' && !!details.features
      if (isPopup) {
        // The size and position the page asked for (features) are kept.
        return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, title: '' } }
      }
      // A new tab for the link, given its page or loading it with the page as referrer (review B-F1).
      const linkTab = (activate: boolean) => (page: TabPage) => {
        const windowId = windows.windowOfTab(openerTabId) ?? windows.focusedWindowId()
        const spaceId = windowId ? ops.spaceOfWindow(windowId) : opener.spaceId
        const id = ops.createTab({ url: details.url, spaceId, windowId, activate, openerTabId, ...page })
        if (activate) return
        tabs.ensure(id)
        // With the sidebar hidden the new tab would open unseen: say so, with a button to it (TB-02, SB-13).
        if (windowId && !store.state.windows[windowId]?.sidebar.visible) {
          toast(windowId, 'Opened in a new tab', { label: 'Show', command: 'tabs.activate', args: { tabId: id } })
        }
      }
      /** A link the engine left to the browser, opened by its page itself (TabRuntime.openFromPage). */
      const fromPage = (open: (page: TabPage) => void) => {
        const load = { httpReferrer: details.referrer }
        tabs.openFromPage(
          openerTabId,
          details.url,
          details.referrer,
          (view) => open({ view, load }),
          () => open({ load }),
        )
      }
      if (details.disposition === 'background-tab') {
        // ⌘/middle-click: an ordinary tab that loads in the background. A view handed back through
        // createWindow would never be shown, and Chromium keeps the opener page waiting for it.
        fromPage(linkTab(false))
        return { action: 'deny' }
      }
      return {
        action: 'allow',
        outlivesOpener: true,
        overrideBrowserWindowOptions: { webPreferences: KEEP_KEYBOARD },
        createWindow: (options) => {
          const windowId = windows.windowOfTab(openerTabId) ?? windows.focusedWindowId()
          const spaceId = windowId ? ops.spaceOfWindow(windowId) : opener.spaceId
          if (!(options as { webContents?: unknown }).webContents) {
            // ⇧⌘-click: the engine brings no page of its own (a view built from these options
            // would throw), so the page opens the link itself, as a new selected tab (NV-08).
            fromPage(linkTab(true))
            // Electron uses nothing that comes back for an open without a page of its own.
            const spare = new WebContentsView()
            setImmediate(() => spare.webContents.close())
            return spare.webContents
          }
          const tab = makeTab({ spaceId, profileId: opener.profileId, url: details.url, openerTabId })
          // Add the tab, give it the real (opener-linked) view, and only then select it: selecting
          // first would make the layout pass create a second, orphan view (review M1).
          store.update((d) => {
            const space = d.spaces[spaceId]
            if (!space) return
            d.tabs[tab.id] = tab
            // New tabs from links land at the top of Today (TB-03).
            insertItem(d, { kind: 'today', spaceId }, todayInsertIndex(space, 'new'), tab.id)
          })
          const view = new WebContentsView(options as WebContentsViewConstructorOptions)
          tabs.adopt(tab.id, view)
          if (windowId) ops.activate(windowId, tab.id)
          return view.webContents
        },
      }
    }),
  )

  // Pop-up windows (OAuth, payments) are tracked: their own opens are gesture-gated and become
  // tabs, and ⌘W/⌘R act on the pop-up itself rather than the main window (review M6).
  ctx.hooks.tabCreated.push((openerTabId, contents) =>
    contents.on('did-create-window', (popup) => trackPopup(popup, openerTabId)),
  )
  const trackPopup = (popup: BrowserWindow, openerTabId: TabId) => {
    const wc = popup.webContents
    let gesture = { at: 0, used: true }
    wc.on('input-event', (_e, input) => {
      if (['mouseDown', 'mouseUp', 'keyDown', 'rawKeyDown', 'gestureTap', 'touchEnd'].includes(input.type)) {
        gesture = { at: Date.now(), used: false }
      }
    })
    wc.setWindowOpenHandler((details) => {
      // As for a tab's page: a local file opens for no web page, and a toast names it (D49, round 2
      // fix check F1, round 3 fix check F1); nor does an internal page (D53).
      if (!framesMayOpen(wc, details.url)) {
        localFileRefused(openerTabId, details.url)
        return { action: 'deny' }
      }
      const windowId = windows.windowOfTab(openerTabId) ?? windows.focusedWindowId()
      if (gesture.used || Date.now() - gesture.at > 1000) {
        toast(windowId, 'Pop-up blocked')
        return { action: 'deny' }
      }
      gesture.used = true
      const opener = store.state.tabs[openerTabId]
      ops.createTab({ url: details.url, spaceId: opener?.spaceId, windowId })
      return { action: 'deny' }
    })
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const mod = process.platform === 'darwin' ? input.meta : input.control
      const key = input.key.toLowerCase()
      if (mod && !input.shift && key === 'w') {
        event.preventDefault()
        popup.close()
      } else if (mod && key === 'r') {
        event.preventDefault()
        wc.reload()
      }
    })
  }

  /**
   * A local file refused for a page (D49) is named in a toast, so a click that opens nothing says
   * why: once per tab and file every few seconds, however often a page asks (round 3 fix check F1).
   */
  const refusedAt = new Map<TabId, { url: string; at: number }>()
  const localFileRefused = (tabId: TabId, url: string) => {
    // An internal page refused (D53) says nothing: to a web page, `orbit:` is a scheme that isn't there.
    if (!isLocalFileUrl(url)) return
    const now = Date.now()
    const last = refusedAt.get(tabId)
    if (last?.url === url && now - last.at < 3000) return
    refusedAt.set(tabId, { url, at: now })
    toast(windows.windowOfTab(tabId) ?? windows.focusedWindowId(), localFileBlockedMessage(url))
  }
  tabs.onLocalFileRefused = localFileRefused

  // One "Pop-up blocked" per tab every few seconds, however often a page tries.
  const blockedAt = new Map<TabId, number>()
  tabs.onPopupBlocked = (tabId) => {
    const now = Date.now()
    if (now - (blockedAt.get(tabId) ?? 0) < 3000) return
    blockedAt.set(tabId, now)
    toast(windows.windowOfTab(tabId) ?? windows.focusedWindowId(), 'Pop-up blocked')
  }
  // A page that closes itself (window.close()) closes its tab (review M3).
  tabs.onPageClosed = (tabId) => {
    if (store.state.tabs[tabId]) ops.closeTabs([tabId], 'closed', { undoLabel: 'Close Tab' })
  }

  // ⌘Z from a page (outside text fields) undoes the last sidebar change (TB-18, TB-07).
  tabs.onUndoShortcut = (_tabId, redo) => {
    if (redo) ops.undo.redo()
    // From a page (outside text fields) only a recent sidebar change is undone (TB-07 "just closed").
    else ops.undo.undo(PAGE_UNDO_MAX_AGE_MS)
  }

  /** Back on a tab opened from a link with no earlier history closes it and returns to its opener (TB-19). */
  const goBack = (tabId: TabId) => {
    const contents = tabs.contents(tabId)
    const tab = store.state.tabs[tabId]
    if (contents?.navigationHistory.canGoBack()) {
      contents.navigationHistory.goBack()
      return
    }
    const opener = tab?.openerTabId ? store.state.tabs[tab.openerTabId] : undefined
    if (!tab || !opener || sectionOf(store.state, tabId) !== 'today') return
    const windowId = windows.windowOfTab(tabId) ?? windows.focusedWindowId()
    ops.closeTabs([tabId], 'closed', { undoLabel: false })
    if (windowId) ops.activate(windowId, opener.id)
  }

  // ---- Actions ----
  const withActive = (fn: (tabId: TabId, windowId: WindowId) => void) => (c: CallContext) => {
    const windowId = windowOf(c)
    const tabId = ops.activeTab(windowId)
    if (tabId && windowId) fn(tabId, windowId)
  }

  actions.register('tab.close', (c) => {
    const windowId = windowOf(c)
    const selected = selectionOf(windowId)
    if (selected.length > 1) {
      // ⌘W closes every selected tab (TB-06, TB-13).
      ops.closeTabs(selected, 'closed')
      clearSelectionIn(windowId)
      return
    }
    const tabId = ops.activeTab(windowId)
    // With nothing left to close, ⌘W closes the window (TB-06).
    if (!tabId) {
      if (windowId) windows.close(windowId)
      return
    }
    ops.closeTabs([tabId], 'closed')
  })
  actions.register('tab.reopenClosed', (c) => void ops.reopenLast(windowOf(c)))
  actions.register('tab.undo', () => void ops.undo.undo())
  actions.register('tab.redo', () => void ops.undo.redo())
  const step = (delta: number) => (c: CallContext) => {
    const windowId = windowOf(c)
    if (!windowId) return
    const target = steppedTarget(store.state, windowId, delta)
    if (target) ops.activate(windowId, target)
  }
  actions.register('tab.next', step(1))
  actions.register('tab.previous', step(-1))

  // Recent-tab switching (TB-05): while Control is held, each Tab steps back through the five
  // most recently used tabs of this Space; a quick tap-and-release goes to the previous tab.
  // Releasing Control settles there; tabs passed on the way keep their place in the recency order.
  let recent: {
    windowId: WindowId
    order: TabId[]
    times: Map<TabId, number>
    index: number
    timer?: NodeJS.Timeout
  } | null = null
  const endRecent = () => {
    const r = recent
    if (!r) return
    recent = null
    if (r.timer) clearTimeout(r.timer)
    const landed = r.order[r.index]
    const start = r.order[0]
    // Restore recency of the tabs merely passed through (after the idle-clock updates have run).
    setTimeout(() => {
      store.update((d) => {
        for (const [id, at] of r.times) {
          if (id === landed || id === start) continue
          const t = d.tabs[id]
          if (t) t.lastActiveAt = at
        }
      })
    }, 0)
  }
  const stepRecent = (delta: number) => (c: CallContext) => {
    const windowId = windowOf(c)
    if (!windowId) return
    if (!recent || recent.windowId !== windowId) {
      const state = store.state
      const win = state.windows[windowId]
      if (!win) return
      const ids = [...new Set(sidebarTabOrder(state, win.spaceId))]
        .map((id) => state.tabs[id])
        .filter((t): t is NonNullable<typeof t> => !!t)
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
        .slice(0, 5)
      const active = ops.activeTab(windowId)
      const order = active ? [active, ...ids.map((t) => t.id).filter((id) => id !== active)] : ids.map((t) => t.id)
      recent = { windowId, order: order.slice(0, 5), times: new Map(ids.map((t) => [t.id, t.lastActiveAt])), index: 0 }
    }
    const r = recent
    if (r.order.length < 2) return
    r.index = (r.index + delta + r.order.length) % r.order.length
    const target = r.order[r.index]
    if (target) ops.activate(windowId, target)
    // If the Control release is never seen (focus moved), settle after a pause.
    if (r.timer) clearTimeout(r.timer)
    r.timer = setTimeout(endRecent, 1500)
  }
  actions.register('tab.recent', stepRecent(1))
  actions.register('tab.recentBack', stepRecent(-1))
  tabs.onControlUp = endRecent
  // W, with Control still held, closes the highlighted tab; the next one in the switcher takes its
  // place and switching goes on (TB-05, keys lane KS-06).
  tabs.recentSwitch = {
    active: (windowId) => recent?.windowId === windowId,
    closeHighlighted: (windowId) => {
      const r = recent
      if (!r || r.windowId !== windowId) return
      const closing = r.order[r.index]
      if (!closing) return
      r.order.splice(r.index, 1)
      r.times.delete(closing)
      if (r.index >= r.order.length) r.index = 0
      ops.closeTabs([closing], 'closed')
      const next = r.order[r.index]
      if (next && store.state.tabs[next]) ops.activate(windowId, next)
      if (r.timer) clearTimeout(r.timer)
      r.timer = setTimeout(endRecent, 1500)
    },
  }
  commands.register('tabs.endRecentSwitch', () => endRecent())
  for (let n = 1; n <= 9; n++) {
    actions.register(`tab.goto.${n}`, (c) => {
      const windowId = windowOf(c)
      if (!windowId) return
      const target = numberedTarget(store.state, windowId, n)
      if (target) ops.activate(windowId, target)
    })
  }
  actions.register(
    'tab.togglePin',
    withActive((tabId, windowId) => {
      if (sectionOf(store.state, tabId) === 'today') ops.pin(tabId, undefined, windowId)
      else ops.unpin(tabId, windowId)
    }),
  )
  actions.register(
    'tab.favorite',
    withActive((tabId, windowId) => {
      if (sectionOf(store.state, tabId) === 'favorite') ops.unfavorite(tabId, 'pinned', windowId)
      else ops.favorite(tabId, windowId)
    }),
  )
  actions.register(
    'tab.duplicate',
    withActive((tabId, windowId) => void commands.run('tabs.duplicate', { tabId }, { windowId }).catch(() => {})),
  )
  actions.register(
    'tab.resetToPinned',
    withActive((tabId, windowId) => ops.resetToPinned(tabId, { windowId })),
  )
  actions.register(
    'tab.copyUrl',
    withActive((tabId, windowId) => {
      const selected = selectionOf(windowId)
      void copyLinks(windowId, selected.length > 1 ? selected : [tabId], false)
    }),
  )
  actions.register(
    'tab.copyUrlMarkdown',
    withActive((tabId, windowId) => void copyLinks(windowId, [tabId], true)),
  )
  actions.register('tab.pasteAsNewTab', (c) => {
    const windowId = windowOf(c)
    // From an open command bar the new tab is the answer: close the bar (review N1).
    if (windowId && store.state.windows[windowId]?.overlay.kind === 'commandbar') {
      void commands.run('overlay.close', {}, { windowId })
    }
    void pasteUrlAsTab(windowId)
  })
  actions.register(
    'tab.toggleMute',
    withActive((tabId) => {
      const tab = store.state.tabs[tabId]
      if (tab) void commands.run('tabs.setMuted', { tabId, muted: !tab.muted })
    }),
  )
  actions.register('tabs.clearToday', (c) => ops.clearToday(ops.spaceOfWindow(windowOf(c))))
  actions.register('folder.new', (c) => void commands.run('folders.create', {}, c))
  actions.register('pinned.toggleCollapsed', (c) => {
    const spaceId = ops.spaceOfWindow(windowOf(c))
    const collapsed = !store.state.spaces[spaceId]?.pinnedCollapsed
    void commands.run('tabs.setPinnedCollapsed', { spaceId, collapsed }, c)
  })
  actions.register('sidebar.focus', (c) => {
    const windowId = windowOf(c)
    if (!windowId) return
    windows.get(windowId)?.webContents.focus()
    send(windowId, 'sidebar:focus', {})
  })

  // Page actions on the active tab. Back, Forward, Reload, Stop and zoom live in src/main/nav/.
  const onContents = (fn: (contents: Electron.WebContents) => void) =>
    withActive((tabId) => {
      const contents = tabs.contents(tabId)
      if (contents) fn(contents)
    })
  actions.register(
    'page.print',
    onContents((w) => w.print()),
  )
  actions.register(
    'page.viewSource',
    withActive((tabId, windowId) => {
      const url = store.state.tabs[tabId]?.url
      if (url) ops.createTab({ url: `view-source:${url}`, windowId })
    }),
  )
  // DevTools keys (devtools.*) are registered by src/main/devtools.

  // Favicons in state are small data URLs on tabs only (lane review MF-2, F13): remote URLs (which
  // Orbit's UI would fetch in the wrong session) go, and archive entries' copies move to the
  // favicon store. Sidebar integrity itself is restored by persist.normalizeState.
  for (const tab of Object.values(store.state.tabs)) {
    if (tab.favicon?.startsWith('data:image/')) tabs.rememberFavicon(tab.url, tab.favicon)
  }
  for (const entry of store.state.archive) {
    if (entry.favicon?.startsWith('data:image/') && entry.favicon.length <= 16 * 1024) {
      tabs.rememberFavicon(entry.url, entry.favicon)
    }
  }
  store.update((d) => {
    for (const tab of Object.values(d.tabs)) if (tab.favicon && !tab.favicon.startsWith('data:')) delete tab.favicon
    for (const entry of d.archive) if (entry.favicon) delete entry.favicon
  })
  maintenance.start()

  if (ctx.e2e) {
    const hooks: TabTestHooks = {
      maintenance: (now) => maintenance.run(now),
      clockAhead: (ms) => {
        ahead += ms
      },
      launchPassDone: () => !maintenance.launchPending,
      rowMenu: (windowId) => rowMenus.info(windowId ?? windows.focusedWindowId() ?? windows.ids()[0]),
      chooseRowMenu: (path, windowId) =>
        rowMenus.chooseByLabel(windowId ?? windows.focusedWindowId() ?? windows.ids()[0], path),
      toastView: (windowId) => toastView.info(windowId ?? windows.focusedWindowId() ?? windows.ids()[0] ?? ''),
      undo: () => ops.undo.undo(),
      recentlyClosed: () => ops.recentlyClosed.map((r) => r.tab.id),
    }
    ;(globalThis as unknown as { __orbitTabs: TabTestHooks }).__orbitTabs = hooks
  }

  return { ops, maintenance }
}
