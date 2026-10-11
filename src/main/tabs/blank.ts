import { isBlankSpace, isBlankWindow } from '../../shared/blank'
import { createSpace, createWindowState, DEFAULT_PROFILE_ID } from '../../shared/defaults'
import { isFolderId } from '../../shared/ids'
import { isPrivateProfileId } from '../../shared/private'
import type { ItemId, OrbitState, ProfileId, Space, SpaceId, WindowId, WindowState } from '../../shared/state'
import { NEUTRAL_THEME } from '../../shared/theme'
import { tabsInItem } from '../../shared/tree'
import type { MainContext } from '../context'
import type { TabOps } from './ops'

/** What a blank window doesn't have (TB-17): Spaces, pinned tabs, Favorites and folders. */
const NOT_IN_BLANK =
  /^(space\.|tab\.togglePin$|tab\.favorite$|tab\.resetToPinned$|pinned\.toggleCollapsed$|folder\.new$)/

/** A blank window's own Space, in profile `profileId` (TB-17). */
export function blankSpace(profileId: ProfileId, now = Date.now()): Space {
  const space = createSpace('Blank Window', profileId, NEUTRAL_THEME, '', now)
  space.blank = true
  return space
}

/** Items of a Space and everything inside its folders. */
function itemsOf(state: OrbitState, spaceId: SpaceId): ItemId[] {
  const out: ItemId[] = []
  const visit = (ids: ItemId[]) => {
    for (const id of ids) {
      out.push(id)
      const folder = isFolderId(id) ? state.folders[id] : undefined
      if (folder) visit(folder.children)
    }
  }
  const space = state.spaces[spaceId]
  if (space) visit([...space.pinned, ...space.today])
  return out
}

/**
 * Blank windows (TB-17, NV-10, SP-24): "New Blank Window" (the command bar; ⌃⌘N and the File menu
 * on macOS) opens a window whose sidebar is its own and starts empty, a step down and
 * right of the window it came from, with the command bar open; dragging a tab out of the sidebar
 * makes one too (`TabOps.toNewWindow`). It shows a Space of its own in the profile of the window it
 * came from, out of the Space order: no other window lists its tabs, and it has no Spaces, pinned
 * tabs, Favorites or folders (their actions do nothing there). Open at quit, it comes back after a
 * relaunch; closed, its Space goes and its tabs go to the Archive.
 */
export function registerBlankWindows(ctx: MainContext, ops: TabOps): void {
  const { store, actions, commands, windows } = ctx

  const open = (fromWindowId: WindowId | undefined): WindowId | null => {
    const from = fromWindowId ?? windows.focusedWindowId()
    const state = store.state
    const fromProfile = state.spaces[state.windows[from ?? '']?.spaceId ?? '']?.profileId
    // The profile of the window it came from; a private window's stays there (NV-11).
    const profileId = fromProfile && !isPrivateProfileId(fromProfile) ? fromProfile : DEFAULT_PROFILE_ID
    let created: WindowState | undefined
    store.update((d) => {
      const space = blankSpace(d.profiles[profileId] ? profileId : DEFAULT_PROFILE_ID)
      d.spaces[space.id] = space
      const win = createWindowState(space.id)
      win.bounds = windows.cascadeFrom(from)
      d.windows[win.id] = win
      created = win
    })
    if (!created) return null
    const id = windows.open(created)
    const win = windows.get(id)
    const source = from ? windows.get(from) : undefined
    if (win && source && !source.isDestroyed() && source.isFullScreen()) win.setFullScreen(true)
    // A new window starts with the command bar open, ready to type (NV-10, SP-24).
    win?.once('show', () => {
      void commands
        .run('overlay.open', { overlay: { kind: 'commandbar', mode: 'new-tab', query: '' } }, { windowId: id })
        .catch(() => {})
    })
    return id
  }

  /** A blank window closed: its Space goes, once no window shows it, and its tabs go to the Archive. */
  const dropSpaces = (spaceIds: SpaceId[]) => {
    for (const spaceId of spaceIds) {
      const state = store.state
      if (!isBlankSpace(state, spaceId)) continue
      if (Object.values(state.windows).some((w) => w.spaceId === spaceId)) continue
      const tabIds = itemsOf(state, spaceId).flatMap((id) => tabsInItem(state, id))
      if (tabIds.length > 0) ops.closeTabs(tabIds, 'auto', { remove: true, undoLabel: false })
      store.update((d) => {
        for (const id of itemsOf(d, spaceId)) {
          if (d.folders[id]) delete d.folders[id]
          if (d.splits[id]) delete d.splits[id]
        }
        delete d.spaces[spaceId]
        for (const w of Object.values(d.windows)) delete w.activeTab[spaceId]
      })
    }
  }

  /** Blank Spaces no window shows. */
  const unshown = (state: OrbitState): SpaceId[] => {
    const shown = new Set(Object.values(state.windows).map((w) => w.spaceId))
    return Object.values(state.spaces)
      .filter((s) => s.blank && !shown.has(s.id))
      .map((s) => s.id)
  }
  store.subscribe((next, prev) => {
    if (next.windows === prev.windows) return
    const gone = unshown(next)
    if (gone.length > 0) setImmediate(() => dropSpaces(gone))
  })
  // Loaded with no window (a crash part-way through closing it): the same, once every area is ready.
  const lost = unshown(store.state)
  if (lost.length > 0) setImmediate(() => dropSpaces(lost))

  actions.register('window.newBlank', (c) => {
    open(c.windowId)
  })
  // What a blank window doesn't have does nothing there: Spaces, pinned tabs, Favorites, folders.
  actions.intercept((id, c) => {
    if (!NOT_IN_BLANK.test(id)) return false
    const windowId = c.windowId ?? windows.focusedWindowId()
    return !!windowId && isBlankWindow(store.state, windowId)
  })
}
