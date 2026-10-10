import { clipboard, Menu, type MenuItemConstructorOptions, nativeTheme } from 'electron'
import { FAVORITES_FULL_MESSAGE } from '../../shared/defaults'
import { newId } from '../../shared/ids'
import {
  equalizeLayout,
  flipLayout,
  isPendingPane,
  layoutLeaves,
  MAX_PANES,
  neighborPane,
  noteSplitFocus,
  type PaneSide,
  paneAfterClose,
  paneOrder,
  replacePane,
  SPLIT_FULL_MESSAGE,
  setSizesAt,
  siblingOf,
  swapPanes,
} from '../../shared/split'
import type { ContainerRef, OrbitState, SplitId, SplitLayout, TabId, WindowId } from '../../shared/state'
import { paletteFor } from '../../shared/theme'
import { insertItem, locate, sectionOf, splitOfTab } from '../../shared/tree'
import type { MainContext } from '../context'
import { SPLIT_PANE_MENU_KEYS, withKeyHints } from '../keys/menu-hints'
import type { CallContext } from '../registry'
import { makeTab } from '../tabs/model'
import { activeTabOf } from '../windows'
import {
  addPaneInDraft,
  adoptPlacement,
  copyTab,
  createSplitInDraft,
  detachTab,
  dropBlankPanes,
  focusInDraft,
  growsFavoritesPastLimit,
  isBlankPane,
  isFailure,
  leavesOf,
  overflowsFavorites,
  popOutInDraft,
  separateInDraft,
  sidebarSorted,
  splitAnchor,
  swapIntoPaneInDraft,
  windowsShowing,
} from './model'
import { PaneStrip } from './strip'

/**
 * A command bar session that fills or changes a pane: the empty pane made by ⌃⇧= / Add
 * Split (SV-02, SV-03), or ⌘L on a pane of a split (SV-15).
 */
interface PaneSession {
  windowId: WindowId
  tabId: TabId
  /** True for a new, still empty pane. */
  blank: boolean
  /** Pane focused before the empty pane was added (focus returns there on Escape). */
  previous?: TabId
  nonce: number
  settling: boolean
  /** Selection at the moment the command bar closed (a later change means a tab was chosen). */
  activeAtClose?: TabId | null
  activeTabsAtClose?: Record<string, TabId | null>
  /** Tabs that existed when the bar closed: a tab picked from the results is one of them. */
  tabsAtClose?: OrbitState['tabs']
  /** The tab the bar's choice selected, decided in the same tick the bar closed. */
  chosen?: TabId | null
  /** Grace timer while a slow choice may still fill the empty pane. */
  timer?: NodeJS.Timeout
  /** The window's Space when the bar closed (choosing a Space is not choosing a tab). */
  spaceAtClose?: string
}

/** How long an empty pane waits for the command bar's choice before it is removed. */
const SETTLE_GRACE_MS = 120

/** Split feature (main process). Owned by the split lane; see docs/ARCHITECTURE.md. */
export function registerSplit(ctx: MainContext): void {
  const { store, commands, actions, windows } = ctx
  const windowOf = (c: CallContext): WindowId | undefined => c.windowId ?? windows.focusedWindowId()
  const sessions = new Map<WindowId, PaneSession>()
  const strip = new PaneStrip(ctx)
  // An empty pane whose command bar was open when Orbit quit has nothing to show.
  store.update((d) => {
    dropBlankPanes(d)
  })
  if (ctx.e2e) (globalThis as unknown as { __orbitSplit: unknown }).__orbitSplit = { strip }

  const refuse = (windowId: WindowId | undefined, result: unknown) => {
    if (result === 'full') ctx.toast(windowId, SPLIT_FULL_MESSAGE)
  }

  /** Sleeps tabs whose profile changed so they reload in the right session (without the old session's history). */
  const reloadMoved = (tabIds: TabId[]) => {
    if (tabIds.length === 0) return
    for (const id of tabIds) {
      ctx.tabs.sleep(id)
      ctx.tabs.savedHistory.delete(id)
    }
    // Pages that were on screen lost their views: have the shells report their panes again.
    for (const windowId of windows.ids()) windows.sendToWindow(windowId, 'split:relayout', {})
  }

  /** Applies a change that moves tabs into a split, reloading any that changed profile. */
  const updateMoving = (tabIds: TabId[], recipe: (d: OrbitState) => void) => {
    const before = new Map(tabIds.map((id) => [id, store.state.tabs[id]?.profileId]))
    store.update(recipe)
    reloadMoved(
      tabIds.filter((id) => {
        const now = store.state.tabs[id]?.profileId
        return !!now && !!before.get(id) && now !== before.get(id)
      }),
    )
  }

  const activeSplit = (windowId: WindowId | undefined): { splitId: SplitId; tabId: TabId } | undefined => {
    const tabId = windowId ? activeTabOf(store.state, windowId) : null
    const splitId = tabId ? splitOfTab(store.state, tabId) : undefined
    return tabId && splitId ? { splitId, tabId } : undefined
  }

  const updateLayout = (splitId: SplitId, fn: (layout: SplitLayout) => SplitLayout) => {
    store.update((d) => {
      const split = d.splits[splitId]
      if (split) split.layout = fn(split.layout)
    })
  }

  // ---- Creating ----

  commands.register('split.create', ({ tabIds, orientation, focus }, c) => {
    const windowId = windowOf(c)
    const state = store.state
    const ordered = sidebarSorted(
      state,
      [...new Set(tabIds)].filter((id) => state.tabs[id]),
    )
    if (ordered.length > MAX_PANES) {
      ctx.toast(windowId, SPLIT_FULL_MESSAGE)
      return null
    }
    // A Favorite split's pane made into a new split leaves its own split as a new tile (FV-02).
    if (
      growsFavoritesPastLimit(state, (d) => {
        createSplitInDraft(d, ordered, { axis: orientation, at: ordered[0] })
      })
    ) {
      ctx.toast(windowId, FAVORITES_FULL_MESSAGE)
      return null
    }
    const active = windowId ? activeTabOf(state, windowId) : null
    let result: ReturnType<typeof createSplitInDraft> = 'invalid'
    updateMoving(ordered, (d) => {
      result = createSplitInDraft(d, ordered, { axis: orientation, at: ordered[0] })
      if (isFailure(result) || !windowId) return
      const target = focus && ordered.includes(focus) ? focus : active && ordered.includes(active) ? active : ordered[0]
      if (target) focusInDraft(d, windowId, target)
    })
    if (isFailure(result)) {
      refuse(windowId, result)
      return null
    }
    return result
  })

  commands.register('split.addTab', ({ tabId, target, side = 'right', focus = true }, c) => {
    const windowId = windowOf(c)
    let result: ReturnType<typeof addPaneInDraft> = 'invalid'
    // A split row as the target: the new pane goes after its last pane (or before its first for 'left'/'top').
    const anchor = splitAnchor(store.state, target, side) ?? target
    updateMoving([tabId], (d) => {
      result = addPaneInDraft(d, tabId, anchor, side)
      if (!isFailure(result) && focus && windowId) focusInDraft(d, windowId, tabId)
    })
    if (isFailure(result)) {
      refuse(windowId, result)
      return null
    }
    return result
  })

  commands.register('split.openUrl', ({ url, target, side = 'right', referrer }, c) => {
    const windowId = windowOf(c)
    const anchor = store.state.tabs[target]
    if (!anchor) return null
    if (leavesOf(store.state, splitOfTab(store.state, target)).length >= MAX_PANES) {
      ctx.toast(windowId, SPLIT_FULL_MESSAGE)
      return null
    }
    const tab = makeTab({ spaceId: anchor.spaceId, profileId: anchor.profileId, url })
    if (referrer) ctx.tabs.loadOptions.set(tab.id, { httpReferrer: referrer })
    let result: ReturnType<typeof addPaneInDraft> = 'invalid'
    store.update((d) => {
      d.tabs[tab.id] = tab
      result = addPaneInDraft(d, tab.id, target, side)
      if (isFailure(result)) delete d.tabs[tab.id]
      else if (windowId) focusInDraft(d, windowId, tab.id)
    })
    if (isFailure(result)) {
      ctx.tabs.loadOptions.delete(tab.id)
      refuse(windowId, result)
      return null
    }
    return result
  })

  /** ⌃⇧= and the Add Split actions: an empty pane beside the focused pane, filled from the command bar. */
  const addPane = (windowId: WindowId | undefined, side: PaneSide) => {
    if (!windowId) return
    const existing = sessions.get(windowId)
    if (existing) settle(existing, { cancel: true })
    const state = store.state
    const anchor = activeTabOf(state, windowId)
    const anchorTab = anchor ? state.tabs[anchor] : undefined
    // An empty window never gets a split with a blank pane (SV-02, SV-25).
    if (!anchor || !anchorTab || isBlankPane(anchorTab)) return
    if (leavesOf(state, splitOfTab(state, anchor)).length >= MAX_PANES) {
      ctx.toast(windowId, SPLIT_FULL_MESSAGE)
      return
    }
    const blank = makeTab({ spaceId: anchorTab.spaceId, profileId: anchorTab.profileId, url: 'about:blank' })
    blank.title = 'New Tab'
    let ok = false
    store.update((d) => {
      d.tabs[blank.id] = blank
      const result = addPaneInDraft(d, blank.id, anchor, side)
      if (isFailure(result)) {
        delete d.tabs[blank.id]
        return
      }
      ok = true
      // Marked as waiting for its first page until the command bar fills it (SV-02).
      const split = d.splits[result]
      if (split) split.pending = blank.id
      focusInDraft(d, windowId, blank.id)
    })
    if (!ok) return
    const session: PaneSession = {
      windowId,
      tabId: blank.id,
      blank: true,
      previous: anchor,
      nonce: -1,
      settling: false,
    }
    sessions.set(windowId, session)
    void commands.run('overlay.open', { overlay: { kind: 'commandbar', mode: 'edit-url', query: '' } }, { windowId })
    const overlay = store.state.windows[windowId]?.overlay
    if (overlay?.kind === 'commandbar') session.nonce = overlay.nonce
    else settle(session, { cancel: true })
  }

  /** Ends a pane session once its command bar closed: keep, fill, swap in or remove the pane. */
  const settle = (session: PaneSession, opts: { cancel?: boolean } = {}) => {
    const windowId = session.windowId
    if (sessions.get(windowId) !== session) return
    sessions.delete(windowId)
    clearTimeout(session.timer)
    const state = store.state
    const tab = state.tabs[session.tabId]
    const splitId = splitOfTab(state, session.tabId)
    if (!tab || !splitId) return
    const chosen = opts.cancel ? null : (session.chosen ?? null)
    // A tab that existed when the bar closed was picked from its results; a tab the choice
    // created (e.g. "open in new tab") was not, and is left alone.
    const picked = !!chosen && !!session.tabsAtClose?.[chosen]
    const chosenIsToday = picked && sectionOf(state, chosen) === 'today' && !splitOfTab(state, chosen)

    if (!session.blank) {
      // ⌘L on a pane, then an open Today tab was chosen: it takes the pane's place (SV-15).
      if (!chosen || !chosenIsToday) return
      updateMoving([chosen], (d) => {
        if (!swapIntoPaneInDraft(d, session.tabId, chosen)) return
        restoreOtherSpaces(d, session, chosen)
        focusInDraft(d, windowId, chosen)
      })
      return
    }

    if (!opts.cancel && !isBlankPane(tab)) {
      // Filled with a URL or search: a pinned split remembers it as the pane's pinned URL.
      store.update((d) => {
        const split = d.splits[splitId]
        if (split?.pending === session.tabId) delete split.pending
        adoptPlacement(d, [session.tabId], locate(d, splitId)?.container)
      })
      return
    }

    if (chosen && chosenIsToday) {
      // An open tab was chosen: it moves into the new pane (SV-02).
      updateMoving([chosen], (d) => {
        detachTab(d, chosen)
        const split = d.splits[splitId]
        if (!split) return
        split.layout = replacePane(split.layout, session.tabId, chosen)
        if (split.pending === session.tabId) delete split.pending
        delete d.tabs[session.tabId]
        adoptPlacement(d, [chosen], locate(d, splitId)?.container)
        restoreOtherSpaces(d, session, chosen)
        focusInDraft(d, windowId, chosen)
      })
      ctx.tabs.destroy(session.tabId)
      return
    }
    if (chosen && picked && !leavesOf(state, splitId).includes(chosen)) {
      // A pinned tab, Favorite or another split's pane stays where it is: the new pane opens a copy of its page.
      const url = state.tabs[chosen]?.url
      if (url && !isBlankPane({ url })) {
        store.update((d) => {
          const blank = d.tabs[session.tabId]
          const split = d.splits[splitId]
          if (split?.pending === session.tabId) delete split.pending
          if (blank) {
            blank.url = url
            blank.title = d.tabs[chosen]?.title ?? blank.title
            blank.favicon = d.tabs[chosen]?.favicon
          }
          restoreOtherSpaces(d, session, chosen)
          focusInDraft(d, windowId, session.tabId)
          adoptPlacement(d, [session.tabId], locate(d, splitId)?.container)
        })
        return
      }
    }
    // Nothing chosen (Escape, click outside) or a new tab was opened instead: the empty pane
    // goes away. Focus returns to the previous pane unless something else was selected since.
    store.update((d) => {
      const stillOnBlank = activeTabOf(d, windowId) === session.tabId
      detachTab(d, session.tabId)
      delete d.tabs[session.tabId]
      const back = picked ? chosen : stillOnBlank ? session.previous : null
      if (back && d.tabs[back]) focusInDraft(d, windowId, back)
    })
    ctx.tabs.destroy(session.tabId)
  }

  /** Undo the Space switch a "switch to tab" in another Space made while a pane was being chosen. */
  const restoreOtherSpaces = (d: OrbitState, session: PaneSession, chosen: TabId) => {
    const win = d.windows[session.windowId]
    if (!win || !session.activeTabsAtClose) return
    for (const [spaceId, id] of Object.entries(win.activeTab)) {
      if (id === chosen && session.activeTabsAtClose[spaceId] !== chosen) {
        win.activeTab[spaceId] = session.activeTabsAtClose[spaceId] ?? null
      }
    }
  }

  // Watch command bar sessions: open on a pane → track; closed → settle right after the choice ran.
  store.subscribe((next) => {
    for (const session of [...sessions.values()]) {
      const overlay = next.windows[session.windowId]?.overlay
      const open = overlay?.kind === 'commandbar' && overlay.nonce === session.nonce
      if (session.blank && !next.tabs[session.tabId]) {
        // The empty pane itself was closed (e.g. Cmd/Ctrl+W): end the session and its command bar.
        sessions.delete(session.windowId)
        clearTimeout(session.timer)
        if (open) queueMicrotask(() => void commands.run('overlay.close', {}, { windowId: session.windowId }))
        continue
      }
      if (session.nonce < 0) continue
      if (session.settling) {
        // Another command bar opened while this one was still settling: decide now (nothing was chosen).
        if (session.timer && overlay?.kind === 'commandbar' && overlay.nonce !== session.nonce) {
          clearTimeout(session.timer)
          session.timer = undefined
          queueMicrotask(() => settle(session, { cancel: true }))
        }
        continue
      }
      if (open) continue
      session.settling = true
      session.activeAtClose = activeTabOf(next, session.windowId)
      session.activeTabsAtClose = { ...(next.windows[session.windowId]?.activeTab ?? {}) }
      session.tabsAtClose = next.tabs
      session.spaceAtClose = next.windows[session.windowId]?.spaceId
      // The command bar's choice (navigate / switch tab) runs synchronously right after the
      // overlay closes, so a microtask sees its result and still lands in the same patch batch.
      // Selection changes after that are the user's own and never count as the choice.
      queueMicrotask(() => {
        if (sessions.get(session.windowId) !== session) return
        const state = store.state
        const active = activeTabOf(state, session.windowId)
        const sameSpace = state.windows[session.windowId]?.spaceId === session.spaceAtClose
        session.chosen =
          sameSpace && session.activeAtClose === session.tabId && active && active !== session.tabId ? active : null
        const tab = state.tabs[session.tabId]
        if (session.chosen || !session.blank || (tab && !isBlankPane(tab))) settle(session)
        // Escape, a click outside, or a choice still on its way: a late page can still fill the pane.
        else session.timer = setTimeout(() => settle(session), SETTLE_GRACE_MS)
      })
    }
    for (const win of Object.values(next.windows)) {
      const overlay = win.overlay
      if (overlay.kind !== 'commandbar' || overlay.mode !== 'edit-url' || sessions.has(win.id)) continue
      const active = activeTabOf(next, win.id)
      if (!active || !splitOfTab(next, active)) continue
      sessions.set(win.id, { windowId: win.id, tabId: active, blank: false, nonce: overlay.nonce, settling: false })
    }
  })

  // ---- Closing, separating, rearranging ----

  /** Removes a pane still waiting for its first page, without archiving it. */
  const dropPending = (tabId: TabId) => {
    for (const [windowId, session] of sessions) {
      if (session.tabId !== tabId) continue
      sessions.delete(windowId)
      clearTimeout(session.timer)
    }
    store.update((d) => {
      const next = paneAfterClose(d, tabId, new Set([tabId]))
      for (const { windowId, spaceId } of windowsShowing(d, [tabId])) {
        const win = d.windows[windowId]
        if (win) win.activeTab[spaceId] = next
      }
      detachTab(d, tabId)
      delete d.tabs[tabId]
      if (next) noteSplitFocus(d, next)
    })
    ctx.tabs.destroy(tabId)
  }

  /**
   * Closes one pane. The tab model archives it, keeps the other panes' arrangement and focuses
   * a neighbouring pane, all in one update (SV-17); reopening puts it back in its split.
   */
  const closePane = (tabId: TabId) => {
    if (isPendingPane(store.state, tabId)) dropPending(tabId)
    else void commands.run('tabs.close', { tabId })
  }

  commands.register('split.closePane', ({ tabId }) => closePane(tabId))

  /** Closes the whole split as one unit (SV-19): a Today split is archived, a pinned one unloads. */
  commands.register('split.close', ({ splitId }, c) => {
    const leaves = leavesOf(store.state, splitId)
    for (const id of leaves) if (isPendingPane(store.state, id)) dropPending(id)
    const rest = leaves.filter((id) => store.state.tabs[id])
    if (rest.length > 0) void commands.run('tabs.close', { tabIds: rest }, { windowId: windowOf(c) })
  })

  commands.register('split.separate', ({ splitId }, c) => {
    // A Favorite split becomes one tile per pane: refused when that passes 12 Favorites (FV-02).
    const tiles = leavesOf(store.state, splitId).filter((id) => !isPendingPane(store.state, id)).length
    if (overflowsFavorites(store.state, splitId, tiles)) {
      ctx.toast(windowOf(c), FAVORITES_FULL_MESSAGE)
      return
    }
    for (const id of leavesOf(store.state, splitId)) if (isPendingPane(store.state, id)) dropPending(id)
    store.update((d) => {
      separateInDraft(d, splitId)
    })
  })

  commands.register('split.popOut', ({ tabId }, c) => {
    const state = store.state
    const splitId = splitOfTab(state, tabId)
    const split = splitId ? state.splits[splitId] : undefined
    if (!split) return
    // The pane becomes a tile of its own beside a Favorite split (FV-02).
    if (overflowsFavorites(state, split.id, 2)) {
      ctx.toast(windowOf(c), FAVORITES_FULL_MESSAGE)
      return
    }
    const sibling = siblingOf(split.layout, tabId)
    store.update((d) => {
      for (const { windowId, spaceId } of windowsShowing(d, [tabId])) {
        const win = d.windows[windowId]
        if (win && sibling) win.activeTab[spaceId] = sibling
      }
      popOutInDraft(d, tabId)
    })
  })

  commands.register('split.flip', ({ splitId }) => updateLayout(splitId, flipLayout))

  commands.register('split.resize', ({ splitId, path, sizes }) => {
    if (!Array.isArray(path) || !Array.isArray(sizes)) return
    updateLayout(splitId, (layout) => setSizesAt(layout, path, sizes))
  })

  commands.register('split.equalize', ({ splitId, path, index }) =>
    updateLayout(splitId, (layout) => equalizeLayout(layout, path, index)),
  )

  commands.register('split.focusPane', ({ tabId }, c) => {
    const windowId = windowOf(c)
    if (!windowId) return
    store.update((d) => focusInDraft(d, windowId, tabId))
  })

  commands.register('split.swap', ({ a, b }) => {
    const splitId = splitOfTab(store.state, a)
    if (!splitId || splitOfTab(store.state, b) !== splitId) return
    updateLayout(splitId, (layout) => swapPanes(layout, a, b))
  })

  commands.register('split.movePane', ({ tabId, direction }) => {
    const splitId = splitOfTab(store.state, tabId)
    const split = splitId ? store.state.splits[splitId] : undefined
    if (!splitId || !split) return
    const other = neighborPane(split.layout, tabId, direction)
    if (other) updateLayout(splitId, (layout) => swapPanes(layout, tabId, other))
  })

  commands.register('split.duplicate', ({ splitId }, c) => {
    const state = store.state
    const split = state.splits[splitId]
    const loc = locate(state, splitId)
    if (!split || !loc) return null
    // A Favorite split's copy is one more tile beside it (FV-02).
    if (overflowsFavorites(state, splitId, 2)) {
      ctx.toast(windowOf(c), FAVORITES_FULL_MESSAGE)
      return null
    }
    const now = Date.now()
    const copies = new Map<TabId, TabId>()
    const tabs = layoutLeaves(split.layout)
      .map((tabId) => state.tabs[tabId])
      .filter((t) => !!t)
      .map((tab) => {
        const copy = copyTab(tab, now)
        copies.set(tab.id, copy.id)
        return copy
      })
    let layout = split.layout
    for (const [from, to] of copies) layout = replacePane(layout, from, to)
    const id = newId('v')
    store.update((d) => {
      for (const copy of tabs) d.tabs[copy.id] = copy
      insertItem(d, loc.container, loc.index + 1, id)
      d.splits[id] = { id, layout, createdAt: now, ...(split.name ? { name: split.name } : {}) }
    })
    // Copies keep their back/forward history.
    for (const [from, to] of copies) {
      const contents = ctx.tabs.contents(from)
      const saved = ctx.tabs.savedHistory.get(from)
      if (contents && contents.navigationHistory.length() > 0) {
        ctx.tabs.savedHistory.set(to, {
          entries: contents.navigationHistory.getAllEntries(),
          index: contents.navigationHistory.getActiveIndex(),
        })
      } else if (saved) ctx.tabs.savedHistory.set(to, { entries: [...saved.entries], index: saved.index })
    }
    return id
  })

  /**
   * Moves a whole split (pin, Favorites, another Space) through the tab model, which keeps its
   * panes together, fixes every pane's placement and hands the selection on in the Space it
   * leaves (TB-11).
   */
  const moveSplit = (splitId: SplitId, to: ContainerRef, index: number, windowId?: WindowId): Promise<boolean> =>
    commands.run('tabs.move', { id: splitId, to, index }, { windowId })

  commands.register('split.rename', ({ splitId, name }) => {
    store.update((d) => {
      const split = d.splits[splitId]
      if (!split) return
      const clean = name?.trim().slice(0, 120)
      if (clean) split.name = clean
      else delete split.name
    })
  })

  commands.register('split.addPane', ({ side = 'right' }, c) => addPane(windowOf(c), side))

  commands.register('split.move', ({ splitId, to, index }, c) =>
    moveSplit(splitId, to, index ?? Number.MAX_SAFE_INTEGER, windowOf(c)),
  )

  // ---- Menus ----

  const title = (tabId: TabId) => {
    const tab = store.state.tabs[tabId]
    const text = tab?.customTitle ?? tab?.title ?? 'Tab'
    return text.length > 40 ? `${text.slice(0, 39)}…` : text
  }

  const paneControls = (tabId: TabId, windowId: WindowId | undefined): MenuItemConstructorOptions[] => {
    const state = store.state
    const splitId = splitOfTab(state, tabId)
    const split = splitId ? state.splits[splitId] : undefined
    if (!splitId || !split) return []
    const full = layoutLeaves(split.layout).length >= MAX_PANES
    const addFrom = (side: PaneSide) => () => {
      if (windowId) store.update((d) => focusInDraft(d, windowId, tabId))
      addPane(windowId, side)
    }
    const move = (direction: PaneSide, label: string): MenuItemConstructorOptions => ({
      label,
      enabled: !!neighborPane(split.layout, tabId, direction),
      click: () => void commands.run('split.movePane', { tabId, direction }),
    })
    return [
      { label: 'Flip Orientation', click: () => void commands.run('split.flip', { splitId }) },
      { type: 'separator' },
      { label: 'Add Split Right', enabled: !full, click: addFrom('right') },
      { label: 'Add Split Left', enabled: !full, click: addFrom('left') },
      { label: 'Add Split Above', enabled: !full, click: addFrom('top') },
      { label: 'Add Split Below', enabled: !full, click: addFrom('bottom') },
      { type: 'separator' },
      move('left', 'Move Pane Left'),
      move('right', 'Move Pane Right'),
      move('top', 'Move Pane Up'),
      move('bottom', 'Move Pane Down'),
      { type: 'separator' },
      { label: 'Equalize Sizes', click: () => void commands.run('split.equalize', { splitId }) },
      { label: 'Separate Tabs', click: () => void commands.run('split.separate', { splitId }) },
      { label: 'Close Pane', click: () => closePane(tabId) },
    ]
  }

  commands.register('split.paneMenu', ({ tabId }, c) => {
    const windowId = windowOf(c)
    // Keys lane: an item that a key also does shows the key (KS-18).
    const items = withKeyHints(paneControls(tabId, windowId), SPLIT_PANE_MENU_KEYS)
    const win = windowId ? windows.get(windowId) : undefined
    if (items.length > 0) Menu.buildFromTemplate(items).popup(win ? { window: win } : {})
  })

  commands.register('split.contextMenu', ({ splitId }, c) => {
    const windowId = windowOf(c)
    const state = store.state
    const split = state.splits[splitId]
    const loc = locate(state, splitId)
    if (!split || !loc) return
    const leaves = paneOrder(split.layout)
    const first = leaves[0]
    const section = first ? sectionOf(state, first) : undefined
    const spaceId = first ? state.tabs[first]?.spaceId : undefined
    const items: MenuItemConstructorOptions[] = leaves.map((tabId) => {
      const tab = state.tabs[tabId]
      return {
        label: title(tabId),
        submenu: [
          { label: 'Focus Pane', click: () => void commands.run('split.focusPane', { tabId }, { windowId }) },
          {
            label: tab?.muted ? 'Unmute' : 'Mute',
            click: () => void commands.run('tabs.setMuted', { tabId, muted: !tab?.muted }),
          },
          {
            label: 'Copy Link',
            click: () => {
              clipboard.writeText(ctx.tabs.contents(tabId)?.getURL() || tab?.url || '')
              ctx.toast(windowId, 'Copied URL to clipboard')
            },
          },
          { label: 'Move Out of Split', click: () => void commands.run('split.popOut', { tabId }) },
          { label: 'Close Pane', click: () => closePane(tabId) },
        ],
      }
    })
    items.push(
      { type: 'separator' },
      {
        label: 'Rename…',
        click: () => windowId && windows.sendToWindow(windowId, 'sidebar:rename', { id: splitId }),
      },
      ...(split.name
        ? [{ label: 'Show Pane Titles', click: () => void commands.run('split.rename', { splitId, name: null }) }]
        : []),
      { label: 'Flip Orientation', click: () => void commands.run('split.flip', { splitId }) },
      { label: 'Equalize Sizes', click: () => void commands.run('split.equalize', { splitId }) },
      { label: 'Duplicate', click: () => void commands.run('split.duplicate', { splitId }) },
      { type: 'separator' },
    )
    if (spaceId && section === 'today') {
      items.push({
        label: 'Pin Split',
        click: () => void moveSplit(splitId, { kind: 'pinned', spaceId }, Number.MAX_SAFE_INTEGER, windowId),
      })
    }
    if (spaceId && section === 'pinned') {
      items.push({
        label: 'Unpin Split',
        click: () => void moveSplit(splitId, { kind: 'today', spaceId }, 0, windowId),
      })
    }
    const profileId = spaceId ? state.spaces[spaceId]?.profileId : undefined
    if (profileId && section !== 'favorite') {
      items.push({
        label: 'Add to Favorites',
        click: () => void moveSplit(splitId, { kind: 'favorites', profileId }, Number.MAX_SAFE_INTEGER, windowId),
      })
    }
    if (spaceId && section === 'favorite') {
      items.push({
        label: 'Remove from Favorites',
        click: () => void moveSplit(splitId, { kind: 'pinned', spaceId }, Number.MAX_SAFE_INTEGER, windowId),
      })
    }
    const otherSpaces = state.spaceOrder.filter((s) => s !== spaceId)
    if (otherSpaces.length > 0 && section !== 'favorite') {
      items.push({
        label: 'Move to Space',
        submenu: otherSpaces.map((id) => ({
          label: state.spaces[id]?.name ?? id,
          click: () => void moveSplit(splitId, { kind: 'today', spaceId: id }, 0, windowId),
        })),
      })
    }
    items.push(
      { type: 'separator' },
      { label: 'Separate Tabs', click: () => void commands.run('split.separate', { splitId }) },
      {
        label: section === 'today' ? 'Close Split' : 'Unload Split',
        click: () => void commands.run('split.close', { splitId }),
      },
    )
    const win = windowId ? windows.get(windowId) : undefined
    Menu.buildFromTemplate(items).popup(win ? { window: win } : {})
  })

  commands.register('split.stripHover', ({ hovered }, c) => strip.setHovered(windowOf(c), hovered))
  commands.register('split.paneDrag', ({ tabId, phase, x, y }, c) => {
    const windowId = windowOf(c)
    if (!windowId) return
    const origin = strip.info(windowId).bounds
    strip.setDragging(windowId, phase === 'start' || phase === 'move')
    if (!origin) return
    windows.sendToWindow(windowId, 'split:paneDrag', { tabId, phase, x: origin.x + x, y: origin.y + y })
  })
  commands.register('split.stripTarget', (_args, c) => {
    const windowId = windowOf(c)
    return { tabId: windowId ? strip.info(windowId).tabId : null }
  })

  // ---- Focus follows the pane the user clicks into (SV-14) ----

  const focusFromPage = (tabId: TabId) => {
    const windowId = windows.windowOfTab(tabId)
    if (!windowId) return
    const state = store.state
    const active = activeTabOf(state, windowId)
    if (!active || active === tabId) return
    const splitId = splitOfTab(state, tabId)
    if (!splitId || splitOfTab(state, active) !== splitId) return
    if (state.windows[windowId]?.overlay.kind !== 'none') return
    store.update((d) => focusInDraft(d, windowId, tabId))
  }

  // Mouse input from pages matters only for split panes (click to focus, the strip's hover), so
  // the hook is attached to panes alone and follows tabs in and out of splits (review F6).
  const live = new Map<TabId, Electron.WebContents>()
  const hooked = new Map<TabId, () => void>()
  const isPane = (state: OrbitState, tabId: TabId) => !!splitOfTab(state, tabId)
  const hook = (tabId: TabId, contents: Electron.WebContents) => {
    if (hooked.has(tabId) || contents.isDestroyed()) return
    const onMouse = (_event: Electron.Event, mouse: Electron.MouseInputEvent) => {
      if (mouse.type === 'mouseDown') focusFromPage(tabId)
      strip.onPageMouse(tabId, mouse)
    }
    contents.on('before-mouse-event', onMouse)
    hooked.set(tabId, () => {
      if (!contents.isDestroyed()) contents.off('before-mouse-event', onMouse)
    })
  }
  const unhook = (tabId: TabId) => {
    hooked.get(tabId)?.()
    hooked.delete(tabId)
  }
  store.subscribe((next, prev) => {
    if (next.splits === prev.splits) return
    for (const [tabId, contents] of live) {
      if (isPane(next, tabId)) hook(tabId, contents)
      else unhook(tabId)
    }
  })

  ctx.hooks.tabCreated.push((tabId, contents) => {
    live.set(tabId, contents)
    if (isPane(store.state, tabId)) hook(tabId, contents)
    contents.once('destroyed', () => {
      unhook(tabId)
      if (live.get(tabId) === contents) live.delete(tabId)
    })
    // The pane strip stays away while a page is in HTML full screen (review F3).
    let fullscreenWindow: WindowId | undefined
    contents.on('enter-html-full-screen', () => {
      fullscreenWindow = windows.windowOfTab(tabId)
      if (fullscreenWindow) strip.setFullscreen(fullscreenWindow, true)
    })
    const leave = () => {
      if (fullscreenWindow) strip.setFullscreen(fullscreenWindow, false)
      fullscreenWindow = undefined
    }
    contents.on('leave-html-full-screen', leave)
    contents.once('destroyed', leave)
    placeholderUntilLoaded(tabId, contents)
  })

  /** A page starting in a split pane shows the frame colour until it has loaded, never a white flash (SV-26). */
  const placeholderUntilLoaded = (tabId: TabId, contents: Electron.WebContents) => {
    const state = store.state
    const tab = state.tabs[tabId]
    const space = tab ? state.spaces[tab.spaceId] : undefined
    const view = ctx.tabs.get(tabId)
    if (!view || !space || !splitOfTab(state, tabId)) return
    view.setBackgroundColor(paletteFor(space.theme, nativeTheme.shouldUseDarkColors).windowBackground)
    const restore = () => {
      clearTimeout(timer)
      if (!contents.isDestroyed() && ctx.tabs.get(tabId) === view) view.setBackgroundColor('#ffffffff')
    }
    const timer = setTimeout(restore, 4000)
    contents.once('did-finish-load', restore)
    contents.once('did-fail-load', restore)
  }

  // ---- Actions ----

  actions.register('split.add', (c) => addPane(windowOf(c), 'right'))
  actions.register('split.addRight', (c) => addPane(windowOf(c), 'right'))
  actions.register('split.addLeft', (c) => addPane(windowOf(c), 'left'))
  actions.register('split.addAbove', (c) => addPane(windowOf(c), 'top'))
  actions.register('split.addBelow', (c) => addPane(windowOf(c), 'bottom'))
  actions.register('split.close', (c) => {
    const current = activeSplit(windowOf(c))
    if (current) closePane(current.tabId)
  })
  actions.register('split.flip', (c) => {
    const current = activeSplit(windowOf(c))
    if (current) void commands.run('split.flip', { splitId: current.splitId })
  })
  actions.register('split.separate', (c) => {
    const current = activeSplit(windowOf(c))
    if (current) void commands.run('split.separate', { splitId: current.splitId })
  })
  actions.register('split.equalize', (c) => {
    const current = activeSplit(windowOf(c))
    if (current) void commands.run('split.equalize', { splitId: current.splitId })
  })
  const focusPaneAt = (pick: (order: TabId[], current: number) => TabId | undefined) => (c: CallContext) => {
    const windowId = windowOf(c)
    const current = activeSplit(windowId)
    const split = current ? store.state.splits[current.splitId] : undefined
    if (!windowId || !current || !split) return
    const order = paneOrder(split.layout)
    const target = pick(order, order.indexOf(current.tabId))
    if (target && target !== current.tabId) store.update((d) => focusInDraft(d, windowId, target))
  }
  for (let n = 1; n <= MAX_PANES; n++) {
    actions.register(
      `split.focus.${n}`,
      focusPaneAt((order) => order[n - 1]),
    )
  }
  actions.register(
    'split.focusNext',
    focusPaneAt((order, i) => order[(i + 1) % order.length]),
  )
  actions.register(
    'split.focusPrevious',
    focusPaneAt((order, i) => order[(i - 1 + order.length) % order.length]),
  )
}
