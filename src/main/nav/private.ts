import { randomUUID } from 'node:crypto'
import { app, Menu, session } from 'electron'
import { createSpace, createWindowState, THEME_PRESETS } from '../../shared/defaults'
import { isFolderId } from '../../shared/ids'
import {
  isPrivateProfileId,
  isPrivateSpace,
  isPrivateWindow,
  PRIVATE_PARTITION_PREFIX,
  PRIVATE_PROFILE_PREFIX,
} from '../../shared/private'
import type { ItemId, OrbitState, Profile, ProfileId, SpaceId, SpaceTheme, WindowId } from '../../shared/state'
import { tabsInItem } from '../../shared/tree'
import type { MainContext } from '../context'
import { PRIVATE_WINDOW_SWITCH, privateSwitchIn, urlsInArgv } from '../external-links'
import type { TabOps, TabPage } from '../tabs/ops'
import type { SitePrefs } from './site-prefs'

/** Actions for what a private window doesn't have (SB-25). */
const NOT_IN_PRIVATE =
  /^(space\.|tab\.togglePin$|tab\.favorite$|tab\.resetToPinned$|pinned\.toggleCollapsed$|folder\.new$|app\.archive$)/

export interface PrivateWindows {
  /**
   * Opens a private window, a step down and right of `fromWindowId`: with `url` in its first tab,
   * else with the command bar open for one (SB-25). `page` is how that tab gets its page, when not
   * by loading the URL as typed (review B-F1).
   */
  open(opts?: { url?: string; fromWindowId?: WindowId; page?: TabPage }): WindowId | null
  /** The current private session's profile, while a private window is open. */
  profileId(): ProfileId | undefined
}

/**
 * Private windows (NV-11, SB-25, AP-05). They share one private profile, whose session lives in
 * memory only (a partition without "persist:"), so nothing of it reaches the disk: no cookies,
 * cache, site data or form entries. History, the favicon cache, the Archive, site choices and the
 * state file leave private tabs out (`withoutPrivate`). Each window shows a Space of its own, kept
 * out of the Space order: it lists no other Space, pinned tab or Favorite, and no other window
 * lists its tabs. When the last private window closes, the profile and its session go, and the
 * next private window starts a new one.
 */
export function registerPrivate(ctx: MainContext, ops: TabOps, prefs: SitePrefs): PrivateWindows {
  const { store, actions, commands, windows } = ctx
  let current: ProfileId | undefined

  const newProfile = (now: number): Profile => {
    const key = randomUUID().replace(/-/g, '').slice(0, 12)
    return {
      id: `${PRIVATE_PROFILE_PREFIX}${key}`,
      name: 'Private',
      partition: `${PRIVATE_PARTITION_PREFIX}${key}`,
      favorites: [],
      createdAt: now,
    }
  }

  const open: PrivateWindows['open'] = ({ url, fromWindowId, page } = {}) => {
    const now = Date.now()
    const from = fromWindowId ?? windows.focusedWindowId()
    let windowId: WindowId | undefined
    let spaceId: SpaceId | undefined
    store.update((d) => {
      let profile = current ? d.profiles[current] : undefined
      if (!profile) {
        profile = newProfile(now)
        d.profiles[profile.id] = profile
        current = profile.id
      }
      // Its own Space, outside the Space order: no switcher, no other window lists it.
      const space = createSpace('Private', profile.id, THEME_PRESETS[0] as SpaceTheme, '', now)
      d.spaces[space.id] = space
      const win = createWindowState(space.id, 'private')
      win.bounds = windows.cascadeFrom(from)
      d.windows[win.id] = win
      windowId = win.id
      spaceId = space.id
    })
    if (!windowId || !spaceId) return null
    if (url) ops.createTab({ url, spaceId, windowId, activate: true, ...page })
    const created = store.state.windows[windowId]
    if (!created) return null
    const id = windows.open(created)
    const win = windows.get(id)
    const source = from ? windows.get(from) : undefined
    if (win && source && !source.isDestroyed() && source.isFullScreen()) win.setFullScreen(true)
    if (win && !url) {
      // "+" and ⌘T open the command bar there too; a new private window starts with it (SB-25).
      win.once('show', () => {
        void commands
          .run('overlay.open', { overlay: { kind: 'commandbar', mode: 'new-tab', query: '' } }, { windowId: id })
          .catch(() => {})
      })
    }
    return id
  }

  /** Items of a Space and everything inside its folders. */
  const itemsOf = (state: OrbitState, spaceId: SpaceId): ItemId[] => {
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

  /** A private window closed: its Space and tabs go once no window shows them (none is kept anywhere). */
  const dropSpaces = (spaceIds: SpaceId[]) => {
    for (const spaceId of spaceIds) {
      const state = store.state
      if (!state.spaces[spaceId]) continue
      // Only a private Space: a normal one keeps its tabs, whatever window showed it (fix check B, F3).
      if (!isPrivateSpace(state, spaceId)) continue
      if (Object.values(state.windows).some((w) => w.spaceId === spaceId)) continue
      const tabIds = itemsOf(state, spaceId).flatMap((id) => tabsInItem(state, id))
      if (tabIds.length > 0) ops.closeTabs(tabIds, 'auto', { remove: true, undoLabel: false })
      store.update((d) => {
        for (const id of itemsOf(d, spaceId)) {
          if (d.folders[id]) delete d.folders[id]
          if (d.splits[id]) delete d.splits[id]
        }
        delete d.spaces[spaceId]
      })
    }
    if (!Object.keys(store.state.windows).some((id) => isPrivateWindow(store.state, id))) endSession()
  }

  /** The last private window closed: forget everything of the private session. */
  const endSession = () => {
    const profiles = Object.values(store.state.profiles).filter((p) => isPrivateProfileId(p.id))
    if (profiles.length === 0 && !current) return
    current = undefined
    const spaces = new Set(
      Object.values(store.state.spaces)
        .filter((s) => isPrivateProfileId(s.profileId))
        .map((s) => s.id),
    )
    const leftover = Object.values(store.state.tabs)
      .filter((t) => isPrivateProfileId(t.profileId) || spaces.has(t.spaceId))
      .map((t) => t.id)
    if (leftover.length > 0) ops.closeTabs(leftover, 'auto', { remove: true, undoLabel: false })
    store.update((d) => {
      for (const id of spaces) {
        for (const item of itemsOf(d, id)) {
          if (d.folders[item]) delete d.folders[item]
          if (d.splits[item]) delete d.splits[item]
        }
        delete d.spaces[id]
      }
      for (const p of profiles) delete d.profiles[p.id]
    })
    // Reopen Closed Tab and undo never bring a private tab back once its window is gone.
    for (let i = ops.recentlyClosed.length - 1; i >= 0; i--) {
      if (isPrivateProfileId(ops.recentlyClosed[i]?.tab.profileId)) ops.recentlyClosed.splice(i, 1)
    }
    prefs.forgetPrivate()
    for (const p of profiles) {
      ctx.sessions.forget(p.partition)
      const ses = session.fromPartition(p.partition)
      void ses.clearStorageData().catch(() => {})
      void ses.clearCache().catch(() => {})
      void ses.clearAuthCache().catch(() => {})
      void ses.clearHostResolverCache().catch(() => {})
    }
  }

  store.subscribe((next, prev) => {
    if (next.windows === prev.windows) return
    const gone: SpaceId[] = []
    for (const [id, w] of Object.entries(prev.windows)) {
      if (!next.windows[id] && isPrivateWindow(prev, id)) gone.push(w.spaceId)
    }
    if (gone.length > 0) setImmediate(() => dropSpaces(gone))
  })

  actions.register('window.newPrivate', (c) => {
    open({ fromWindowId: c.windowId })
  })
  // What a private window doesn't have does nothing there (SB-25): other Spaces, pinned tabs,
  // Favorites, folders and the Archive.
  actions.intercept((id, c) => {
    if (!NOT_IN_PRIVATE.test(id)) return false
    const windowId = c.windowId ?? windows.focusedWindowId()
    return !!windowId && isPrivateWindow(store.state, windowId)
  })

  // macOS: the Dock menu; Windows: the taskbar's jump list (NV-11).
  if (process.platform === 'darwin') {
    app.dock?.setMenu(
      Menu.buildFromTemplate([
        { label: 'New Window', click: () => void actions.run('window.new', {}) },
        { label: 'New Private Window', click: () => open() },
      ]),
    )
  } else if (process.platform === 'win32' && !ctx.e2e) {
    app.setUserTasks([
      {
        program: process.execPath,
        arguments: PRIVATE_WINDOW_SWITCH,
        iconPath: process.execPath,
        iconIndex: 0,
        title: 'New Private Window',
        description: 'Open a private window',
      },
    ])
  }
  /**
   * A launch with the private window switch: a private window, with the command line's links in its
   * tabs (the first in front), never in a Mini Window or the history (review B-F6).
   */
  const openFromArgv = (argv: readonly string[], cwd: string) => {
    if (!privateSwitchIn(argv)) return
    const [first, ...rest] = urlsInArgv(argv, cwd)
    const windowId = open(first ? { url: first } : {})
    const spaceId = windowId ? store.state.windows[windowId]?.spaceId : undefined
    if (!windowId || !spaceId) return
    for (const url of rest) ops.createTab({ url, spaceId, windowId, activate: false })
  }
  app.on('second-instance', (_event, argv, workingDirectory) => openFromArgv(argv, workingDirectory))
  if (privateSwitchIn(process.argv)) setImmediate(() => openFromArgv(process.argv, process.cwd()))

  return { open, profileId: () => current }
}
