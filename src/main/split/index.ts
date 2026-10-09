import { clipboard, Menu, type MenuItemConstructorOptions, nativeTheme } from 'electron'
import { newId } from '../../shared/ids'
import {
  anchorOf,
  equalizeLayout,
  flipLayout,
  layoutLeaves,
  MAX_PANES,
  neighborPane,
  type PaneSide,
  paneOrder,
  removePane,
  replacePane,
  SPLIT_FULL_MESSAGE,
  sameLayout,
  setSizesAt,
  siblingOf,
  swapPanes,
} from '../../shared/split'
import type { ContainerRef, OrbitState, SplitId, SplitLayout, TabId, WindowId } from '../../shared/state'
import { paletteFor } from '../../shared/theme'
import { insertItem, locate, moveItem, sectionOf, splitOfTab } from '../../shared/tree'
import type { MainContext } from '../context'
import type { CallContext } from '../registry'
import { makeTab } from '../tabs/model'
import { activeTabOf } from '../windows'
import {
  addPaneInDraft,
  adoptPlacement,
  copyTab,
  createSplitInDraft,
  detachTab,
  focusInDraft,
  isBlankPane,
  isFailure,
  leavesOf,
  popOutInDraft,
  separateInDraft,
  sidebarSorted,
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
}

/** Split feature (main process). Owned by the split lane; see docs/ARCHITECTURE.md. */
export function registerSplit(ctx: MainContext): void {
  const { store, commands, actions, windows } = ctx
  const windowOf = (c: CallContext): WindowId | undefined => c.windowId ?? windows.focusedWindowId()
  const sessions = new Map<WindowId, PaneSession>()
  const strip = new PaneStrip(ctx)
  if (ctx.e2e) (globalThis as unknown as { __orbitSplit: unknown }).__orbitSplit = { strip }

  const refuse = (windowId: WindowId | undefined, result: unknown) => {
    if (result === 'full') ctx.toast(windowId, SPLIT_FULL_MESSAGE)
  }

  /** Sleeps tabs whose profile changed so they reload in the right session. */
  const reloadMoved = (tabIds: TabId[]) => {
    for (const id of tabIds) {
      ctx.tabs.savedHistory.delete(id)
      ctx.tabs.sleep(id)
    }
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
    const active = windowId ? activeTabOf(state, windowId) : null
    let result: ReturnType<typeof createSplitInDraft> = 'invalid'
    store.update((d) => {
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
    const split = store.state.splits[target]
    const order = split ? paneOrder(split.layout) : []
    const anchor = split ? ((side === 'left' || side === 'top' ? order[0] : order[order.length - 1]) ?? target) : target
    store.update((d) => {
      result = addPaneInDraft(d, tabId, anchor, side)
      if (!isFailure(result) && focus && windowId) focusInDraft(d, windowId, tabId)
    })
    if (isFailure(result)) {
      refuse(windowId, result)
      return null
    }
    return result
  })

  commands.register('split.openUrl', ({ url, target, side = 'right' }, c) => {
    const windowId = windowOf(c)
    const anchor = store.state.tabs[target]
    if (!anchor) return null
    if (leavesOf(store.state, splitOfTab(store.state, target)).length >= MAX_PANES) {
      ctx.toast(windowId, SPLIT_FULL_MESSAGE)
      return null
    }
    const tab = makeTab({ spaceId: anchor.spaceId, profileId: anchor.profileId, url })
    let result: ReturnType<typeof addPaneInDraft> = 'invalid'
    store.update((d) => {
      d.tabs[tab.id] = tab
      result = addPaneInDraft(d, tab.id, target, side)
      if (isFailure(result)) delete d.tabs[tab.id]
      else if (windowId) focusInDraft(d, windowId, tab.id)
    })
    if (isFailure(result)) {
      refuse(windowId, result)
      return null
    }
    return result
  })

  /** ⌃⇧= and the Add Split actions: an empty pane beside the focused pane, filled from the command bar. */
  const addPane = (windowId: WindowId | undefined, side: PaneSide) => {
    if (!windowId) return
    settle(windowId, { cancel: true })
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
    else settle(windowId, { cancel: true })
  }

  /** Ends a pane session once its command bar closed: keep, fill, swap in or remove the pane. */
  const settle = (windowId: WindowId, opts: { cancel?: boolean } = {}) => {
    const session = sessions.get(windowId)
    if (!session) return
    sessions.delete(windowId)
    const state = store.state
    const tab = state.tabs[session.tabId]
    const splitId = splitOfTab(state, session.tabId)
    if (!tab || !splitId) return
    const active = activeTabOf(state, windowId)
    const chosen =
      !opts.cancel && session.activeAtClose === session.tabId && active && active !== session.tabId ? active : null
    const chosenSplit = chosen ? splitOfTab(state, chosen) : undefined
    const chosenIsToday = chosen && sectionOf(state, chosen) === 'today' && !chosenSplit

    if (!session.blank) {
      // ⌘L on a pane, then an open Today tab was chosen: it takes the pane's place (SV-15).
      if (!chosen || !chosenIsToday) return
      store.update((d) => {
        if (!swapIntoPaneInDraft(d, session.tabId, chosen)) return
        restoreOtherSpaces(d, session, chosen)
        focusInDraft(d, windowId, chosen)
      })
      return
    }

    if (!opts.cancel && !isBlankPane(tab)) {
      // Filled with a URL or search: a pinned split remembers it as the pane's pinned URL.
      store.update((d) => {
        adoptPlacement(d, [session.tabId], locate(d, splitId)?.container)
      })
      return
    }

    if (chosen && chosenIsToday) {
      // An open tab was chosen: it moves into the new pane (SV-02).
      store.update((d) => {
        detachTab(d, chosen)
        const split = d.splits[splitId]
        if (!split) return
        split.layout = replacePane(split.layout, session.tabId, chosen)
        delete d.tabs[session.tabId]
        adoptPlacement(d, [chosen], locate(d, splitId)?.container)
        restoreOtherSpaces(d, session, chosen)
        focusInDraft(d, windowId, chosen)
      })
      return
    }
    if (chosen && !leavesOf(state, splitId).includes(chosen)) {
      // A pinned tab, Favorite or another split's pane stays where it is: the new pane opens a copy of its page.
      const url = state.tabs[chosen]?.url
      if (url && !isBlankPane({ url })) {
        store.update((d) => {
          const blank = d.tabs[session.tabId]
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
    // Nothing chosen (Escape, click outside): the empty pane goes away and focus returns.
    store.update((d) => {
      detachTab(d, session.tabId)
      delete d.tabs[session.tabId]
      const back = chosen ?? session.previous
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
    for (const session of sessions.values()) {
      if (session.settling || session.nonce < 0) continue
      const win = next.windows[session.windowId]
      const overlay = win?.overlay
      if (overlay?.kind === 'commandbar' && overlay.nonce === session.nonce) continue
      session.settling = true
      session.activeAtClose = activeTabOf(next, session.windowId)
      session.activeTabsAtClose = { ...(win?.activeTab ?? {}) }
      // The command bar's choice (navigate / switch tab) runs synchronously right after the
      // overlay closes, so a microtask sees its result and still lands in the same patch batch.
      queueMicrotask(() => {
        const state = store.state
        const tab = state.tabs[session.tabId]
        const chose =
          (tab && !isBlankPane(tab)) || activeTabOf(state, session.windowId) !== session.activeAtClose || !session.blank
        if (chose) settle(session.windowId)
        else setTimeout(() => settle(session.windowId), 0)
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

  /** Closed panes and the neighbour they sat beside (most recent last). */
  const closedPanes = new Map<TabId, { target: TabId; side: PaneSide }>()
  const rememberClosed = (layout: SplitLayout, tabId: TabId) => {
    const anchor = anchorOf(layout, tabId)
    if (!anchor) return
    closedPanes.delete(tabId)
    closedPanes.set(tabId, anchor)
    if (closedPanes.size > 50) closedPanes.delete(closedPanes.keys().next().value as TabId)
  }
  /** A reopened tab that was a pane goes back beside its old neighbour (re-forming the split if needed). */
  const putBack = (tabId: TabId) => {
    const anchor = closedPanes.get(tabId)
    closedPanes.delete(tabId)
    const state = store.state
    const tab = state.tabs[tabId]
    const target = anchor ? state.tabs[anchor.target] : undefined
    if (!anchor || !tab || !target || splitOfTab(state, tabId) || tab.profileId !== target.profileId) return
    if (leavesOf(state, splitOfTab(state, anchor.target)).length >= MAX_PANES) return
    store.update((d) => {
      addPaneInDraft(d, tabId, anchor.target, anchor.side)
    })
  }

  // When the tab model closes a pane (e.g. ⌘W on the focused pane, SV-17), keep the remaining panes'
  // arrangement and sizes, and keep the split on screen with a neighbouring pane focused. Runs in a
  // microtask queued before the patch flush, so renderers only ever see the repaired state.
  const leafSet = (layout: SplitLayout) => layoutLeaves(layout).sort().join()
  store.subscribe((next, prev) => {
    // Remember where closed panes sat; bring reopened ones back into place (⌘⇧T, SV-17/SV-19).
    if (next.tabs !== prev.tabs) {
      for (const split of Object.values(prev.splits)) {
        for (const id of layoutLeaves(split.layout)) {
          if (!next.tabs[id] && !isBlankPane(prev.tabs[id])) rememberClosed(split.layout, id)
        }
      }
      for (const id of closedPanes.keys()) {
        if (next.tabs[id] && !prev.tabs[id]) queueMicrotask(() => putBack(id))
      }
    }
    const arrangements: { splitId: SplitId; layout: SplitLayout }[] = []
    for (const [splitId, split] of Object.entries(prev.splits)) {
      const now = next.splits[splitId]
      if (!now || now.layout === split.layout) continue
      // Only when panes left because their tabs were closed (not on resizes, flips, adds…).
      const closed = layoutLeaves(split.layout).filter((id) => !next.tabs[id])
      if (closed.length === 0) continue
      let kept: SplitLayout | null = split.layout
      for (const id of closed) kept = kept ? removePane(kept, id) : null
      if (kept && kept.type !== 'leaf' && leafSet(kept) === leafSet(now.layout) && !sameLayout(kept, now.layout)) {
        arrangements.push({ splitId, layout: kept })
      }
    }
    const focus: { windowId: WindowId; target: TabId; expected: TabId | null; spaceId: string }[] = []
    for (const win of Object.values(next.windows)) {
      const before = activeTabOf(prev, win.id)
      const after = activeTabOf(next, win.id)
      if (!before || before === after || next.tabs[before]) continue
      const splitId = splitOfTab(prev, before)
      const split = splitId ? prev.splits[splitId] : undefined
      if (!split || prev.windows[win.id]?.spaceId !== win.spaceId) continue
      const survivors = layoutLeaves(split.layout).filter((id) => id !== before && next.tabs[id])
      if (survivors.length === 0 || (after && survivors.includes(after))) continue
      const sibling = siblingOf(split.layout, before)
      const target = sibling && survivors.includes(sibling) ? sibling : survivors[0]
      if (target) focus.push({ windowId: win.id, target, expected: after, spaceId: win.spaceId })
    }
    if (arrangements.length === 0 && focus.length === 0) return
    queueMicrotask(() =>
      store.update((d) => {
        for (const { splitId, layout } of arrangements) {
          const current = d.splits[splitId]
          if (current && leafSet(current.layout) === leafSet(layout)) current.layout = layout
        }
        for (const f of focus) {
          const win = d.windows[f.windowId]
          if (!win || win.spaceId !== f.spaceId || !d.tabs[f.target]) continue
          if ((win.activeTab[win.spaceId] ?? null) !== f.expected) continue
          focusInDraft(d, f.windowId, f.target)
        }
      }),
    )
  })

  // ---- Closing, separating, rearranging ----

  const closePane = (tabId: TabId) => {
    const state = store.state
    const splitId = splitOfTab(state, tabId)
    const split = splitId ? state.splits[splitId] : undefined
    if (!splitId || !split) {
      void commands.run('tabs.close', { tabId })
      return
    }
    const sibling = siblingOf(split.layout, tabId) ?? layoutLeaves(split.layout).find((id) => id !== tabId)
    const blank = isBlankPane(state.tabs[tabId])
    if (!blank) rememberClosed(split.layout, tabId)
    for (const [windowId, s] of sessions) if (s.tabId === tabId) sessions.delete(windowId)
    store.update((d) => {
      const now = Date.now()
      for (const { windowId, spaceId } of windowsShowing(d, [tabId])) {
        const win = d.windows[windowId]
        if (!win || !sibling) continue
        win.activeTab[spaceId] = sibling
        const t = d.tabs[sibling]
        if (t) t.lastActiveAt = now
      }
      if (blank) {
        detachTab(d, tabId)
        delete d.tabs[tabId]
      } else {
        // As an ordinary Today tab it is closed and archived by the tab model (TB-06, TB-07).
        popOutInDraft(d, tabId, { toToday: true })
      }
    })
    if (blank) ctx.tabs.destroy(tabId)
    else void commands.run('tabs.close', { tabId })
  }

  commands.register('split.closePane', ({ tabId }) => closePane(tabId))

  commands.register('split.close', ({ splitId }) => {
    const state = store.state
    const leaves = leavesOf(state, splitId)
    for (const id of leaves) {
      if (isBlankPane(state.tabs[id])) closePane(id)
    }
    for (const id of leaves)
      if (store.state.tabs[id] && !isBlankPane(store.state.tabs[id])) {
        void commands.run('tabs.close', { tabId: id })
      }
  })

  commands.register('split.separate', ({ splitId }) => {
    const blanks = leavesOf(store.state, splitId).filter((id) => isBlankPane(store.state.tabs[id]))
    for (const id of blanks) closePane(id)
    store.update((d) => {
      separateInDraft(d, splitId)
    })
  })

  commands.register('split.popOut', ({ tabId }) => {
    const state = store.state
    const splitId = splitOfTab(state, tabId)
    const split = splitId ? state.splits[splitId] : undefined
    if (!split) return
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

  commands.register('split.duplicate', ({ splitId }) => {
    const state = store.state
    const split = state.splits[splitId]
    const loc = locate(state, splitId)
    if (!split || !loc) return null
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
      d.splits[id] = { id, layout, createdAt: now }
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

  /** Moves a whole split to another container (pin, Favorites, another Space), keeping its panes. */
  const moveSplit = (splitId: SplitId, to: ContainerRef, index: number): boolean => {
    let ok = false
    let moved: TabId[] = []
    store.update((d) => {
      if (!d.splits[splitId] || !locate(d, splitId) || !moveItem(d, splitId, to, index)) return
      ok = true
      moved = adoptPlacement(d, leavesOf(d, splitId), to)
    })
    reloadMoved(moved)
    return ok
  }

  commands.register('split.move', ({ splitId, to, index }) => moveSplit(splitId, to, index ?? Number.MAX_SAFE_INTEGER))

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
    const items = paneControls(tabId, windowId)
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
      { label: 'Flip Orientation', click: () => void commands.run('split.flip', { splitId }) },
      { label: 'Equalize Sizes', click: () => void commands.run('split.equalize', { splitId }) },
      { label: 'Duplicate', click: () => void commands.run('split.duplicate', { splitId }) },
      { type: 'separator' },
    )
    if (spaceId && section === 'today') {
      items.push({
        label: 'Pin Split',
        click: () => moveSplit(splitId, { kind: 'pinned', spaceId }, Number.MAX_SAFE_INTEGER),
      })
    }
    if (spaceId && section === 'pinned') {
      items.push({ label: 'Unpin Split', click: () => moveSplit(splitId, { kind: 'today', spaceId }, 0) })
    }
    // "Add to Favorites" waits until the Favorites grid can draw a split tile (it lists tabs only).
    if (spaceId && section === 'favorite') {
      items.push({
        label: 'Remove from Favorites',
        click: () => moveSplit(splitId, { kind: 'pinned', spaceId }, Number.MAX_SAFE_INTEGER),
      })
    }
    const otherSpaces = state.spaceOrder.filter((s) => s !== spaceId)
    if (otherSpaces.length > 0 && section !== 'favorite') {
      items.push({
        label: 'Move to Space',
        submenu: otherSpaces.map((id) => ({
          label: state.spaces[id]?.name ?? id,
          click: () => moveSplit(splitId, { kind: 'today', spaceId: id }, 0),
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

  ctx.hooks.tabCreated.push((tabId, contents) => {
    contents.on('before-mouse-event', (_event, mouse) => {
      if (mouse.type === 'mouseDown') focusFromPage(tabId)
      strip.onPageMouse(tabId, mouse)
    })
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
