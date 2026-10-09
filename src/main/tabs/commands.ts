import {
  clipboard,
  Menu,
  type MenuItemConstructorOptions,
  WebContentsView,
  type WebContentsViewConstructorOptions,
} from 'electron'
import { isFolderId, isTabId, newId } from '../../shared/ids'
import type { ContainerRef, ItemId, OrbitState, Tab, TabId, WindowId } from '../../shared/state'
import {
  containerItems,
  type ItemLocation,
  insertItem,
  locate,
  moveItem,
  profileOfContainer,
  removeItem,
  sectionOf,
  sidebarTabOrder,
  spaceOfContainer,
  splitLeaves,
  splitOfTab,
  tabsInItem,
} from '../../shared/tree'
import { fallbackTitle } from '../../shared/url'
import type { MainContext } from '../context'
import type { CallContext } from '../registry'
import { activateInDraft, detachFromSplit, makeTab, pickNextActive } from './model'
import type { SavedHistory } from './runtime'

interface ClosedTab {
  tab: Tab
  location?: ItemLocation
  history?: SavedHistory
}

const MAX_RECENTLY_CLOSED = 50

export function registerTabs(ctx: MainContext): { recentlyClosed: ClosedTab[] } {
  const { store, commands, actions, tabs, windows } = ctx
  const recentlyClosed: ClosedTab[] = []

  const windowOf = (c: CallContext): WindowId | undefined => c.windowId ?? windows.focusedWindowId()
  const spaceOfWindow = (windowId: WindowId | undefined) =>
    (windowId && store.state.windows[windowId]?.spaceId) || (store.state.spaceOrder[0] as string)
  const activeTab = (windowId: WindowId | undefined): TabId | null => {
    if (!windowId) return null
    const win = store.state.windows[windowId]
    const id = win?.activeTab[win.spaceId]
    return id && store.state.tabs[id] ? id : null
  }

  const pinnedLike = (ref: ContainerRef, state: OrbitState): boolean => {
    if (ref.kind === 'favorites' || ref.kind === 'pinned') return true
    if (ref.kind === 'today') return false
    const loc = locate(state, ref.folderId)
    return loc ? pinnedLike(loc.container, state) : false
  }

  /** After moving a tab into/out of pinned areas, keep pinnedUrl and profile consistent. */
  const fixupAfterMove = (d: OrbitState, id: ItemId, to: ContainerRef) => {
    const pinned = pinnedLike(to, d)
    const spaceId = spaceOfContainer(d, to)
    const profileId = profileOfContainer(d, to)
    for (const tabId of tabsInItem(d, id)) {
      const tab = d.tabs[tabId]
      if (!tab) continue
      if (pinned && !tab.pinnedUrl) tab.pinnedUrl = tab.url
      if (!pinned) {
        tab.pinnedUrl = undefined
        tab.customTitle = undefined
      }
      if (spaceId) tab.spaceId = spaceId
      if (profileId && profileId !== tab.profileId) {
        tab.profileId = profileId
        // A different profile means a different session: reload in the new one.
        queueMicrotask(() => {
          tabs.savedHistory.delete(tabId)
          tabs.sleep(tabId)
        })
      }
    }
  }

  /** Deactivates a tab in every window that shows it, choosing the next tab to show. */
  const deactivateEverywhere = (d: OrbitState, tabIds: Set<TabId>) => {
    for (const win of Object.values(d.windows)) {
      for (const [spaceId, active] of Object.entries(win.activeTab)) {
        if (active && tabIds.has(active)) {
          const next = pickNextActive(d, spaceId, tabIds)
          win.activeTab[spaceId] = next
          if (next && d.tabs[next]) d.tabs[next].lastActiveAt = Date.now()
        }
      }
    }
  }

  const archiveTab = (d: OrbitState, tab: Tab, reason: 'auto' | 'closed') => {
    if (!tab.url || tab.url === 'about:blank') return
    d.archive.unshift({
      id: newId('a'),
      url: tab.url,
      title: tab.title,
      favicon: tab.favicon,
      spaceId: tab.spaceId,
      profileId: tab.profileId,
      archivedAt: Date.now(),
      reason,
    })
    if (d.archive.length > 5000) d.archive.length = 5000
  }

  /** Fully removes Today tabs (archiving them); pinned tabs and favorites are unloaded instead. */
  const closeTabs = (tabIds: TabId[], reason: 'auto' | 'closed') => {
    const state = store.state
    const removing = new Set<TabId>()
    const unloading = new Set<TabId>()
    for (const id of tabIds) {
      if (!state.tabs[id]) continue
      const section = sectionOf(state, id)
      if (section === 'pinned' || section === 'favorite') unloading.add(id)
      else removing.add(id)
    }
    for (const id of removing) {
      const tab = state.tabs[id]
      if (!tab) continue
      const contents = tabs.contents(id)
      const history =
        contents && contents.navigationHistory.length() > 0
          ? { entries: contents.navigationHistory.getAllEntries(), index: contents.navigationHistory.getActiveIndex() }
          : tabs.savedHistory.get(id)
      recentlyClosed.push({ tab, location: locate(state, id), history })
      if (recentlyClosed.length > MAX_RECENTLY_CLOSED) recentlyClosed.shift()
    }
    store.update((d) => {
      deactivateEverywhere(d, new Set([...removing, ...unloading]))
      for (const id of removing) {
        const tab = d.tabs[id]
        if (!tab) continue
        archiveTab(d, tab, reason)
        detachFromSplit(d, id)
        removeItem(d, id)
        delete d.tabs[id]
      }
      for (const id of unloading) {
        const tab = d.tabs[id]
        if (tab?.pinnedUrl) {
          tab.url = tab.pinnedUrl
          tab.title = tab.customTitle ?? tab.title
        }
      }
    })
    for (const id of removing) tabs.destroy(id)
    for (const id of unloading) {
      tabs.sleep(id)
      tabs.savedHistory.delete(id)
    }
  }

  commands.register('tabs.create', ({ url = 'about:blank', spaceId, container, index, activate = true }, c) => {
    const windowId = windowOf(c)
    const state = store.state
    const space = spaceId ?? (container && spaceOfContainer(state, container)) ?? spaceOfWindow(windowId)
    const spaceObj = state.spaces[space]
    if (!spaceObj) throw new Error(`Unknown space ${space}`)
    const target: ContainerRef = container ?? { kind: 'today', spaceId: space }
    const profileId = profileOfContainer(state, target) ?? spaceObj.profileId
    const tab = makeTab({ spaceId: space, profileId, url })
    if (pinnedLike(target, state)) tab.pinnedUrl = url
    store.update((d) => {
      d.tabs[tab.id] = tab
      insertItem(d, target, index ?? (target.kind === 'today' ? 0 : Number.MAX_SAFE_INTEGER), tab.id)
      if (activate && windowId) activateInDraft(d, windowId, tab.id)
    })
    return tab.id
  })

  commands.register('tabs.activate', ({ tabId }, c) => {
    const windowId = windowOf(c)
    if (!windowId) return
    store.update((d) => activateInDraft(d, windowId, tabId))
  })

  commands.register('tabs.close', ({ tabId }) => closeTabs([tabId], 'closed'))

  commands.register('tabs.navigate', ({ tabId, url }) => {
    tabs.navigate(tabId, url)
  })
  commands.register('tabs.back', ({ tabId }) => tabs.contents(tabId)?.navigationHistory.goBack())
  commands.register('tabs.forward', ({ tabId }) => tabs.contents(tabId)?.navigationHistory.goForward())
  commands.register('tabs.reload', ({ tabId, ignoreCache }) => {
    const contents = tabs.contents(tabId)
    if (!contents) return
    if (ignoreCache) contents.reloadIgnoringCache()
    else contents.reload()
  })
  commands.register('tabs.stop', ({ tabId }) => tabs.contents(tabId)?.stop())

  commands.register('tabs.move', ({ id, to, index }) => {
    let ok = false
    store.update((d) => {
      ok = moveItem(d, id, to, index)
      if (ok) fixupAfterMove(d, id, to)
    })
    return ok
  })

  commands.register('tabs.pin', ({ tabId }) => {
    store.update((d) => {
      const tab = d.tabs[tabId]
      if (!tab) return
      const space = d.spaces[tab.spaceId]
      if (!space) return
      const target: ContainerRef = { kind: 'pinned', spaceId: space.id }
      if (moveItem(d, splitOfTab(d, tabId) ?? tabId, target, space.pinned.length)) fixupAfterMove(d, tabId, target)
    })
  })

  commands.register('tabs.unpin', ({ tabId }) => {
    store.update((d) => {
      const tab = d.tabs[tabId]
      if (!tab) return
      const target: ContainerRef = { kind: 'today', spaceId: tab.spaceId }
      if (moveItem(d, splitOfTab(d, tabId) ?? tabId, target, 0)) fixupAfterMove(d, tabId, target)
    })
  })

  commands.register('tabs.resetToPinned', ({ tabId }) => {
    const tab = store.state.tabs[tabId]
    if (tab?.pinnedUrl) tabs.navigate(tabId, tab.pinnedUrl)
  })

  commands.register('tabs.rename', ({ tabId, title }) => {
    store.update((d) => {
      const tab = d.tabs[tabId]
      if (tab) tab.customTitle = title?.trim() ? title.trim() : undefined
    })
  })

  commands.register('tabs.duplicate', ({ tabId }, c) => {
    const tab = store.state.tabs[tabId]
    if (!tab) throw new Error('No such tab')
    const copy = makeTab({
      spaceId: tab.spaceId,
      profileId: tab.profileId,
      url: tab.url,
      title: tab.title,
      favicon: tab.favicon,
    })
    const windowId = windowOf(c)
    store.update((d) => {
      d.tabs[copy.id] = copy
      const loc = locate(d, tabId)
      const inToday = loc && sectionOf(d, tabId) === 'today'
      if (loc && inToday) insertItem(d, loc.container, loc.index + 1, copy.id)
      else insertItem(d, { kind: 'today', spaceId: tab.spaceId }, 0, copy.id)
      if (windowId) activateInDraft(d, windowId, copy.id)
    })
    return copy.id
  })

  commands.register('tabs.setMuted', ({ tabId, muted }) => {
    tabs.contents(tabId)?.setAudioMuted(muted)
    store.update((d) => {
      const tab = d.tabs[tabId]
      if (tab) tab.muted = muted
    })
  })

  commands.register('tabs.clearToday', ({ spaceId }, c) => {
    const space = store.state.spaces[spaceId ?? spaceOfWindow(windowOf(c))]
    if (!space) return
    closeTabs(
      space.today.flatMap((id) => tabsInItem(store.state, id)),
      'closed',
    )
    store.update((d) => {
      const s = d.spaces[space.id]
      if (!s) return
      // Remove now-empty folders/splits left behind in Today.
      s.today = s.today.filter((id) => isTabId(id) || tabsInItem(d, id).length > 0)
    })
  })

  commands.register('folders.create', ({ container, index, name = 'New Folder', items = [] }, c) => {
    const target: ContainerRef = container ?? { kind: 'pinned', spaceId: spaceOfWindow(windowOf(c)) }
    const id = newId('f')
    store.update((d) => {
      d.folders[id] = { id, name, children: [], collapsed: false, createdAt: Date.now() }
      insertItem(d, target, index ?? 0, id)
      for (const item of items) {
        if (moveItem(d, item, { kind: 'folder', folderId: id }, Number.MAX_SAFE_INTEGER)) {
          fixupAfterMove(d, item, { kind: 'folder', folderId: id })
        }
      }
    })
    return id
  })

  commands.register('folders.rename', ({ folderId, name }) => {
    store.update((d) => {
      const folder = d.folders[folderId]
      if (folder && name.trim()) folder.name = name.trim()
    })
  })

  commands.register('folders.setCollapsed', ({ folderId, collapsed }) => {
    store.update((d) => {
      const folder = d.folders[folderId]
      if (folder) folder.collapsed = collapsed
    })
  })

  commands.register('folders.delete', ({ folderId, keepChildren = true }) => {
    const state = store.state
    const folder = state.folders[folderId]
    if (!folder) return
    if (!keepChildren) closeTabs(tabsInItem(state, folderId), 'closed')
    store.update((d) => {
      const f = d.folders[folderId]
      if (!f) return
      const loc = removeItem(d, folderId)
      if (loc && keepChildren) {
        const list = containerItems(d, loc.container)
        list?.splice(loc.index, 0, ...f.children)
      }
      const dropNested = (id: ItemId) => {
        if (!isFolderId(id)) return
        const nested = d.folders[id]
        if (!nested) return
        if (!keepChildren) nested.children.forEach(dropNested)
        delete d.folders[id]
      }
      if (!keepChildren) f.children.forEach(dropNested)
      delete d.folders[folderId]
    })
  })

  commands.register('tabs.contextMenu', ({ id }, c) => {
    const windowId = windowOf(c)
    const state = store.state
    const items: MenuItemConstructorOptions[] = []
    const run = <K extends Parameters<typeof commands.run>[0]>(name: K, args: Parameters<typeof commands.run<K>>[1]) =>
      void commands.run(name, args, { windowId })
    if (isFolderId(id)) {
      const folder = state.folders[id]
      if (!folder) return
      items.push(
        { label: 'Rename Folder…', click: () => windowId && windows.sendToWindow(windowId, 'sidebar:rename', { id }) },
        {
          label: folder.collapsed ? 'Expand Folder' : 'Collapse Folder',
          click: () => run('folders.setCollapsed', { folderId: id, collapsed: !folder.collapsed }),
        },
        { type: 'separator' },
        {
          label: 'Delete Folder (Keep Tabs)',
          click: () => run('folders.delete', { folderId: id, keepChildren: true }),
        },
        { label: 'Delete Folder and Tabs', click: () => run('folders.delete', { folderId: id, keepChildren: false }) },
      )
    } else if (isTabId(id)) {
      const tab = state.tabs[id]
      if (!tab) return
      const section = sectionOf(state, id)
      const profile = state.profiles[tab.profileId]
      if (section === 'today') items.push({ label: 'Pin Tab', click: () => run('tabs.pin', { tabId: id }) })
      if (section === 'pinned') items.push({ label: 'Unpin Tab', click: () => run('tabs.unpin', { tabId: id }) })
      if (section !== 'favorite' && profile) {
        items.push({
          label: 'Add to Favorites',
          click: () =>
            run('tabs.move', { id, to: { kind: 'favorites', profileId: profile.id }, index: Number.MAX_SAFE_INTEGER }),
        })
      }
      if (section === 'favorite') {
        items.push({
          label: 'Remove from Favorites',
          click: () =>
            run('tabs.move', { id, to: { kind: 'pinned', spaceId: tab.spaceId }, index: Number.MAX_SAFE_INTEGER }),
        })
      }
      if (section !== 'today') {
        items.push(
          { label: 'Rename…', click: () => windowId && windows.sendToWindow(windowId, 'sidebar:rename', { id }) },
          {
            label: 'Go Back to Pinned URL',
            enabled: tab.url !== tab.pinnedUrl,
            click: () => run('tabs.resetToPinned', { tabId: id }),
          },
        )
      }
      items.push(
        { type: 'separator' },
        { label: 'Duplicate', click: () => run('tabs.duplicate', { tabId: id }) },
        {
          label: 'Copy URL',
          click: () => {
            clipboard.writeText(tab.url)
            ctx.toast(windowId, 'Copied URL to clipboard')
          },
        },
        {
          label: tab.muted ? 'Unmute Tab' : 'Mute Tab',
          click: () => run('tabs.setMuted', { tabId: id, muted: !tab.muted }),
        },
      )
      const otherSpaces = state.spaceOrder.filter((s) => s !== tab.spaceId)
      if (otherSpaces.length > 0 && section !== 'favorite') {
        items.push({
          label: 'Move to Space',
          submenu: otherSpaces.map((spaceId) => ({
            label: state.spaces[spaceId]?.name ?? spaceId,
            click: () =>
              run('tabs.move', { id: splitOfTab(state, id) ?? id, to: { kind: 'today', spaceId }, index: 0 }),
          })),
        })
      }
      items.push(
        { type: 'separator' },
        { label: section === 'today' ? 'Close Tab' : 'Unload Tab', click: () => run('tabs.close', { tabId: id }) },
      )
    }
    if (items.length > 0) Menu.buildFromTemplate(items).popup()
  })

  // Links that open new windows become tabs (keeping window.opener), popups become small windows.
  ctx.hooks.windowOpen.push((openerTabId, details) => {
    const opener = store.state.tabs[openerTabId]
    if (!opener) return undefined
    const isPopup = details.disposition === 'new-window' && !!details.features
    if (isPopup) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { width: 560, height: 700, autoHideMenuBar: true, title: '' },
      }
    }
    const background = details.disposition === 'background-tab'
    return {
      action: 'allow',
      outlivesOpener: true,
      createWindow: (options) => {
        const windowId = windows.windowOfTab(openerTabId)
        const tab = makeTab({ spaceId: opener.spaceId, profileId: opener.profileId, url: details.url })
        store.update((d) => {
          d.tabs[tab.id] = tab
          const loc = locate(d, openerTabId)
          if (loc && sectionOf(d, openerTabId) === 'today') insertItem(d, loc.container, loc.index + 1, tab.id)
          else insertItem(d, { kind: 'today', spaceId: opener.spaceId }, 0, tab.id)
          if (!background && windowId) activateInDraft(d, windowId, tab.id)
        })
        const view = new WebContentsView(options as WebContentsViewConstructorOptions)
        tabs.adopt(tab.id, view)
        return view.webContents
      },
    }
  })

  // ---- Actions ----
  const withActive = (fn: (tabId: TabId, windowId: WindowId) => void) => (c: CallContext) => {
    const windowId = windowOf(c)
    const tabId = activeTab(windowId)
    if (tabId && windowId) fn(tabId, windowId)
  }

  actions.register(
    'tab.close',
    withActive((tabId) => closeTabs([tabId], 'closed')),
  )
  actions.register('tab.reopenClosed', (c) => {
    const entry = recentlyClosed.pop()
    const windowId = windowOf(c)
    if (!entry) return
    const tab: Tab = { ...entry.tab, asleep: true, loading: false, audible: false, lastActiveAt: Date.now() }
    if (entry.history) tabs.savedHistory.set(tab.id, entry.history)
    store.update((d) => {
      if (!d.spaces[tab.spaceId]) tab.spaceId = d.spaceOrder[0] as string
      d.tabs[tab.id] = tab
      const where = entry.location && containerItems(d, entry.location.container) ? entry.location : undefined
      if (where) insertItem(d, where.container, where.index, tab.id)
      else insertItem(d, { kind: 'today', spaceId: tab.spaceId }, 0, tab.id)
      // Drop the archive entry created when it was closed.
      const archived = d.archive.findIndex((a) => a.url === tab.url && a.reason === 'closed')
      if (archived >= 0 && archived < 3) d.archive.splice(archived, 1)
      if (windowId) activateInDraft(d, windowId, tab.id)
    })
  })
  const cycle = (delta: number) => (c: CallContext) => {
    const windowId = windowOf(c)
    if (!windowId) return
    const spaceId = spaceOfWindow(windowId)
    const order = sidebarTabOrder(store.state, spaceId)
    if (order.length === 0) return
    const current = activeTab(windowId)
    const i = current ? order.indexOf(current) : -1
    const next = order[(i + delta + order.length) % order.length] as TabId
    store.update((d) => activateInDraft(d, windowId, next))
  }
  actions.register('tab.next', cycle(1))
  actions.register('tab.previous', cycle(-1))
  for (let n = 1; n <= 9; n++) {
    actions.register(`tab.goto.${n}`, (c) => {
      const windowId = windowOf(c)
      if (!windowId) return
      const order = sidebarTabOrder(store.state, spaceOfWindow(windowId))
      const target = n === 9 ? order[order.length - 1] : order[n - 1]
      if (target) store.update((d) => activateInDraft(d, windowId, target))
    })
  }
  actions.register(
    'tab.togglePin',
    withActive((tabId) => {
      const section = sectionOf(store.state, tabId)
      void commands.run(section === 'today' ? 'tabs.pin' : 'tabs.unpin', { tabId })
    }),
  )
  actions.register(
    'tab.duplicate',
    withActive((tabId, windowId) => void commands.run('tabs.duplicate', { tabId }, { windowId })),
  )
  actions.register(
    'tab.resetToPinned',
    withActive((tabId) => void commands.run('tabs.resetToPinned', { tabId })),
  )
  actions.register(
    'tab.copyUrl',
    withActive((tabId, windowId) => {
      const url = tabs.contents(tabId)?.getURL() || store.state.tabs[tabId]?.url
      if (!url) return
      clipboard.writeText(url)
      ctx.toast(windowId, 'Copied URL to clipboard')
    }),
  )
  actions.register(
    'tab.toggleMute',
    withActive((tabId) => {
      const tab = store.state.tabs[tabId]
      if (tab) void commands.run('tabs.setMuted', { tabId, muted: !tab.muted })
    }),
  )
  actions.register('tabs.clearToday', (c) => void commands.run('tabs.clearToday', {}, c))
  actions.register('folder.new', (c) => void commands.run('folders.create', {}, c))

  // Navigation & page actions on the active tab.
  const onContents = (fn: (contents: Electron.WebContents) => void) =>
    withActive((tabId) => {
      const contents = tabs.contents(tabId)
      if (contents) fn(contents)
    })
  actions.register(
    'nav.back',
    onContents((w) => w.navigationHistory.goBack()),
  )
  actions.register(
    'nav.forward',
    onContents((w) => w.navigationHistory.goForward()),
  )
  actions.register(
    'nav.reload',
    onContents((w) => w.reload()),
  )
  actions.register(
    'nav.hardReload',
    onContents((w) => w.reloadIgnoringCache()),
  )
  actions.register(
    'nav.stop',
    onContents((w) => w.stop()),
  )
  actions.register(
    'page.zoomIn',
    onContents((w) => w.setZoomLevel(Math.min(w.getZoomLevel() + 0.5, 5))),
  )
  actions.register(
    'page.zoomOut',
    onContents((w) => w.setZoomLevel(Math.max(w.getZoomLevel() - 0.5, -5))),
  )
  actions.register(
    'page.zoomReset',
    onContents((w) => w.setZoomLevel(0)),
  )
  actions.register(
    'page.print',
    onContents((w) => w.print()),
  )
  actions.register(
    'page.viewSource',
    withActive((tabId, windowId) => {
      const url = store.state.tabs[tabId]?.url
      if (url) void commands.run('tabs.create', { url: `view-source:${url}` }, { windowId })
    }),
  )
  actions.register(
    'devtools.toggle',
    onContents((w) => (w.isDevToolsOpened() ? w.closeDevTools() : w.openDevTools({ mode: 'detach' }))),
  )

  return { recentlyClosed }
}
