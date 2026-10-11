import { screen, session } from 'electron'
import { sidebarUndoLabel } from '../../shared/actions'
import type { SpacePanel } from '../../shared/commands/spaces'
import { createWindowState, DEFAULT_PROFILE_ID } from '../../shared/defaults'
import type { SpaceId, TabId, WindowId } from '../../shared/state'
import { tabsInItem } from '../../shared/tree'
import type { MainContext } from '../context'
import type { CallContext } from '../registry'
import type { SavedHistory } from '../tabs/runtime'
import {
  assignProfileInDraft,
  createProfileInDraft,
  createSpaceInDraft,
  type DeletedSpace,
  deleteProfileInDraft,
  deleteSpaceInDraft,
  neighbourSpace,
  normalizeSpacesInDraft,
  renameProfileInDraft,
  renameSpaceInDraft,
  reorderSpaceInDraft,
  restoreSpaceInDraft,
  setThemeInDraft,
  switchSpaceInDraft,
} from './model'

/** Key repeats closer than this queue (at most one step ahead) instead of racing through Spaces (SP-09). */
const STEP_INTERVAL_MS = 120
/** How long "Undo" stays available after deleting a Space. */
const UNDO_DELETE_MS = 60_000
/** Offset between a new window and the window it was opened from (SP-24 cascade). */
const CASCADE = 28

/** Spaces, profiles and themes (lane: spaces). */
export function registerSpaces(ctx: MainContext): void {
  const { store, commands, actions, windows } = ctx
  const windowOf = (c: CallContext): WindowId | undefined => c.windowId ?? windows.focusedWindowId()

  // Older state files: bring every Space to the current shape (D12 drops theme.mode).
  store.update((d) => normalizeSpacesInDraft(d))

  /** Last Space any window switched to: what a window opened from nowhere shows (SP-24). */
  let lastSpaceId: SpaceId | undefined

  const switchTo = (windowId: WindowId | undefined, spaceId: SpaceId): boolean => {
    if (!windowId) return false
    ctx.perf.mark('space:switch:start')
    let changed = false
    store.update((d) => {
      changed = switchSpaceInDraft(d, windowId, spaceId)
    })
    if (changed) lastSpaceId = spaceId
    return changed
  }

  /** Tabs moved to another profile must start over in that profile's session (PR-03, PR-05, review F7). */
  const restartInNewSession = (tabIds: TabId[]) => {
    for (const tabId of tabIds) {
      ctx.tabs.sleep(tabId)
      ctx.tabs.savedHistory.delete(tabId)
    }
  }

  const openPanel = (windowId: WindowId | undefined, panel: SpacePanel, params: Record<string, string | number>) =>
    windowId ? commands.run('overlay.open', { overlay: { kind: 'panel', panel, params } }, { windowId }) : undefined

  const focusShell = (windowId: WindowId | undefined) => {
    const win = windowId ? windows.get(windowId) : undefined
    if (win && !win.isDestroyed()) win.webContents.focus()
  }

  // ---- Spaces ----

  commands.register('spaces.create', ({ name, icon, theme, profileId, activate = true, afterSpaceId }, c) => {
    const windowId = windowOf(c)
    const after =
      afterSpaceId ?? (windowId ? store.state.windows[windowId]?.spaceId : undefined) ?? store.state.spaceOrder.at(-1)
    let id = ''
    store.update((d) => {
      id = createSpaceInDraft(d, { name, icon, theme, profileId, afterSpaceId: after }).id
      if (activate && windowId) switchSpaceInDraft(d, windowId, id)
    })
    if (activate) lastSpaceId = id
    return id
  })

  commands.register('spaces.switch', ({ spaceId }, c) => {
    switchTo(windowOf(c), spaceId)
  })

  const lastStepAt = new Map<WindowId, number>()
  const queuedStep = new Map<WindowId, ReturnType<typeof setTimeout>>()
  /** Direction of the queued step: a press the other way replaces it (FL-13; review F13). */
  const queuedDelta = new Map<WindowId, number>()
  const step = (windowId: WindowId | undefined, delta: number): SpaceId | null => {
    if (!windowId) return null
    const win = store.state.windows[windowId]
    if (!win) return null
    const target = neighbourSpace(store.state, win.spaceId, delta)
    if (!target) {
      // At the first/last Space keys do nothing but a small rubber-band nudge (SP-09).
      windows.sendToWindow(windowId, 'spaces:nudge', { direction: Math.sign(delta) })
      return null
    }
    switchTo(windowId, target)
    return target
  }
  /** Rate-limited step for held keys: repeats queue at most one step ahead. */
  const throttledStep = (windowId: WindowId | undefined, delta: number) => {
    if (!windowId) return
    const now = Date.now()
    const wait = (lastStepAt.get(windowId) ?? 0) + STEP_INTERVAL_MS - now
    if (wait <= 0) {
      lastStepAt.set(windowId, now)
      step(windowId, delta)
      return
    }
    queuedDelta.set(windowId, delta)
    if (queuedStep.has(windowId)) return
    queuedStep.set(
      windowId,
      setTimeout(() => {
        queuedStep.delete(windowId)
        lastStepAt.set(windowId, Date.now())
        step(windowId, queuedDelta.get(windowId) ?? delta)
        queuedDelta.delete(windowId)
      }, wait),
    )
  }

  commands.register('spaces.step', ({ delta }, c) => step(windowOf(c), delta))

  commands.register('spaces.update', ({ spaceId, name, icon, theme, profileId }) => {
    let moved: TabId[] = []
    store.update((d) => {
      if (!d.spaces[spaceId]) return
      if (name !== undefined) renameSpaceInDraft(d, spaceId, name)
      if (icon !== undefined) {
        const space = d.spaces[spaceId]
        const next = [...icon.trim()].slice(0, 8).join('')
        if (space && space.icon !== next) space.icon = next
      }
      if (theme) setThemeInDraft(d, spaceId, theme)
      if (profileId) moved = assignProfileInDraft(d, spaceId, profileId)
    })
    restartInNewSession(moved)
  })

  let lastDeleted: { deleted: DeletedSpace; histories: Map<TabId, SavedHistory> } | undefined

  commands.register('spaces.delete', ({ spaceId }, c) => {
    const state = store.state
    const space = state.spaces[spaceId]
    if (!space || state.spaceOrder.length <= 1) return false
    // Keep each tab's back/forward history so Undo brings the pages back as they were.
    const histories = new Map<TabId, SavedHistory>()
    for (const tabId of [...space.pinned, ...space.today].flatMap((id) => tabsInItem(state, id))) {
      const contents = ctx.tabs.contents(tabId)
      if (contents && contents.navigationHistory.length() > 0) {
        histories.set(tabId, {
          entries: contents.navigationHistory.getAllEntries(),
          index: contents.navigationHistory.getActiveIndex(),
        })
      } else {
        const saved = ctx.tabs.savedHistory.get(tabId)
        if (saved) histories.set(tabId, saved)
      }
    }
    let deleted: DeletedSpace | undefined
    store.update((d) => {
      deleted = deleteSpaceInDraft(d, spaceId)
    })
    if (!deleted) return false
    for (const tab of deleted.tabs) ctx.tabs.destroy(tab.id)
    lastDeleted = { deleted, histories }
    const windowId = windowOf(c)
    if (windowId) {
      windows.sendToWindow(windowId, 'spaces:deleted', { spaceId, name: deleted.space.name })
      // The Undo note lives in the sidebar; with it hidden, say how to undo (review F12): with
      // sidebar undo's key as it is now, or an Undo button when it has none (KS-05, KS-18).
      if (!store.state.windows[windowId]?.sidebar.visible) {
        const key = sidebarUndoLabel(process.platform)
        if (key) ctx.toast(windowId, `Deleted “${deleted.space.name}”. ${key} restores it.`)
        else ctx.toast(windowId, `Deleted “${deleted.space.name}”.`, { label: 'Undo', command: 'spaces.undoDelete' })
      }
    }
    return true
  })

  commands.register('spaces.undoDelete', (_args, c) => {
    const entry = lastDeleted
    if (!entry || Date.now() - entry.deleted.deletedAt > UNDO_DELETE_MS) return null
    lastDeleted = undefined
    let restored = false
    store.update((d) => {
      restored = restoreSpaceInDraft(d, entry.deleted, windowOf(c))
    })
    if (!restored) return null
    for (const [tabId, history] of entry.histories) ctx.tabs.savedHistory.set(tabId, history)
    return entry.deleted.space.id
  })

  commands.register('spaces.reorder', ({ spaceId, index }) => {
    store.update((d) => reorderSpaceInDraft(d, spaceId, index))
  })

  commands.register('spaces.beginRename', async ({ spaceId }, c) => {
    const windowId = windowOf(c)
    const win = windowId ? store.state.windows[windowId] : undefined
    if (!windowId || !win || !store.state.spaces[spaceId]) return
    if (win.overlay.kind !== 'none') await commands.run('overlay.close', {}, { windowId })
    if (!win.sidebar.visible) await commands.run('window.setSidebar', { visible: true }, { windowId })
    // A background Space (renamed from its switcher target's menu) is brought into view first,
    // so the one inline rename UI applies to it (SP-07, review M7).
    if (win.spaceId !== spaceId) switchTo(windowId, spaceId)
    focusShell(windowId)
    windows.sendToWindow(windowId, 'spaces:rename', { spaceId })
  })

  commands.register('spaces.beginCreate', async (_args, c) => {
    const windowId = windowOf(c)
    const win = windowId ? store.state.windows[windowId] : undefined
    if (!windowId || !win) return
    if (win.overlay.kind !== 'none') await commands.run('overlay.close', {}, { windowId })
    if (!win.sidebar.visible) {
      // No sidebar to show the flow in: create right away, say so and offer to show it (SP-02, SB-13).
      const id = await commands.run('spaces.create', {}, { windowId })
      const name = store.state.spaces[id]?.name ?? 'New Space'
      ctx.toast(windowId, `Created “${name}”`, { label: 'Show', command: 'window.setSidebar', args: { visible: true } })
      return
    }
    focusShell(windowId)
    windows.sendToWindow(windowId, 'spaces:new-flow', {})
  })

  commands.register('spaces.focusShell', (_args, c) => focusShell(windowOf(c)))

  commands.register('spaces.setAppearance', ({ appearance }) => {
    if (appearance !== 'system' && appearance !== 'light' && appearance !== 'dark') return
    store.update((d) => {
      if (d.settings.appearance !== appearance) d.settings.appearance = appearance
    })
  })

  // ---- Profiles ----

  commands.register('profiles.create', ({ name, assignSpaceId }) => {
    let id = ''
    let moved: TabId[] = []
    store.update((d) => {
      id = createProfileInDraft(d, name).id
      if (assignSpaceId) moved = assignProfileInDraft(d, assignSpaceId, id)
    })
    restartInNewSession(moved)
    return id
  })

  commands.register('profiles.rename', ({ profileId, name }) => {
    store.update((d) => renameProfileInDraft(d, profileId, name))
  })

  commands.register('profiles.delete', ({ profileId }) => {
    const profile = store.state.profiles[profileId]
    // Refused for Default and while any Space uses the profile (PR-08; review F1).
    if (!profile || profileId === DEFAULT_PROFILE_ID) return false
    let result: { removed: TabId[] } | undefined
    store.update((d) => {
      result = deleteProfileInDraft(d, profileId)
    })
    if (!result) return false
    // Its Favorites' pages close (no page keeps the deleted session), then its stored data goes.
    for (const tabId of result.removed) ctx.tabs.destroy(tabId)
    const ses = session.fromPartition(profile.partition)
    void ses
      .clearStorageData()
      .then(() => ses.clearCache())
      .catch((err) => console.error('[spaces] could not clear profile data', err))
    return true
  })

  // ---- Actions ----

  actions.register('space.next', (c) => throttledStep(windowOf(c), 1))
  actions.register('space.previous', (c) => throttledStep(windowOf(c), -1))
  for (let n = 1; n <= 9; n++) {
    actions.register(`space.goto.${n}`, (c) => {
      const spaceId = store.state.spaceOrder[n - 1]
      if (spaceId) switchTo(windowOf(c), spaceId)
    })
  }
  const activeSpace = (c: CallContext): SpaceId | undefined => {
    const windowId = windowOf(c)
    return windowId ? store.state.windows[windowId]?.spaceId : undefined
  }
  actions.register('space.new', (c) => void commands.run('spaces.beginCreate', {}, { windowId: windowOf(c) }))
  actions.register('space.rename', (c) => {
    const spaceId = activeSpace(c)
    if (spaceId) void commands.run('spaces.beginRename', { spaceId }, { windowId: windowOf(c) })
  })
  actions.register('space.theme', (c) => {
    const spaceId = activeSpace(c)
    if (spaceId) void openPanel(windowOf(c), 'space-theme', { spaceId })
  })
  actions.register('space.changeIcon', (c) => {
    const spaceId = activeSpace(c)
    if (spaceId) void openPanel(windowOf(c), 'space-icon', { spaceId })
  })
  actions.register('space.delete', (c) => {
    const spaceId = activeSpace(c)
    if (!spaceId) return
    if (store.state.spaceOrder.length <= 1) {
      ctx.toast(windowOf(c), 'The last Space can’t be deleted')
      return
    }
    void openPanel(windowOf(c), 'space-delete', { spaceId })
  })

  // SP-24: ⌘N opens a window on the same Space, sidebar shown, cascaded, with the command bar open.
  actions.register('window.new', (c) => {
    const sourceId = windowOf(c)
    const source = sourceId ? store.state.windows[sourceId] : undefined
    const sourceWin = sourceId ? windows.get(sourceId) : undefined
    const spaceId =
      (source?.kind === 'main' ? source.spaceId : undefined) ??
      (lastSpaceId && store.state.spaces[lastSpaceId] ? lastSpaceId : undefined) ??
      (store.state.spaceOrder[0] as SpaceId)
    const winState = createWindowState(spaceId)
    if (sourceWin && !sourceWin.isDestroyed() && !sourceWin.isFullScreen()) {
      const b = sourceWin.getNormalBounds()
      const area = screen.getDisplayMatching(b).workArea
      let x = b.x + CASCADE
      let y = b.y + CASCADE
      if (x + b.width > area.x + area.width) x = area.x + CASCADE
      if (y + b.height > area.y + area.height) y = area.y + CASCADE
      winState.bounds = { x, y, width: b.width, height: b.height }
    }
    store.update((d) => {
      d.windows[winState.id] = winState
    })
    const id = windows.open(store.state.windows[winState.id])
    const win = windows.get(id)
    if (!win) return
    if (sourceWin && !sourceWin.isDestroyed() && sourceWin.isFullScreen()) win.setFullScreen(true)
    win.once('show', () => {
      void commands.run(
        'overlay.open',
        { overlay: { kind: 'commandbar', mode: 'new-tab', query: '' } },
        { windowId: id },
      )
    })
  })
}
