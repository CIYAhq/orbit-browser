import { join } from 'node:path'
import { app, clipboard, Menu, type MenuItemConstructorOptions } from 'electron'
import { ACTIONS_BY_ID, shortcutsFor, toElectronAccelerator } from '../../shared/actions'
import type { ArchiveQuery, ArchiveRestoreResult, BackupInfo, LibraryOpenArgs } from '../../shared/commands/archive'
import { DEFAULT_PROFILE_ID } from '../../shared/defaults'
import { newId } from '../../shared/ids'
import type { ArchivedTab, ProfileId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import { installMenu } from '../menu'
import type { CallContext } from '../registry'
import { findMenuItem, menuLabels } from '../tabs/menus'
import { BackupStore, dropDeletedProfiles, scheduleBackups } from './backups'
import { DeleteUndo } from './delete-undo'
import { historyMenuItems, historyQuery, historyRows } from './history-view'
import { provideArchiveSource } from './inbox'
import { LibraryHost } from './library'
import { archiveSectionItems } from './menus'
import { ArchivePreviews } from './preview'
import { recentlyClosedItems, refreshRecentlyClosed, watchRecentlyClosed } from './recently-closed'
import { restoreEntries } from './restore'
import { RestoreData } from './restore-data'
import { KEEP_DAYS_CHOICES, keepDaysOf, scheduleRetention, setKeepDays } from './retention'
import { ArchiveSync } from './service'
import { ArchiveStore } from './store'

/** How long after start-up the Archive log is read (off the cold-start path). */
const LOAD_DELAY_MS = 300
/** Renderers hear about Archive changes at most this often. */
const CHANGED_DEBOUNCE_MS = 40

/** Section ids are short slugs (`archive`, `downloads`…). */
const SECTION_ID = /^[\w.-]{1,64}$/

export interface ArchiveApi {
  store: ArchiveStore
  sync: ArchiveSync
  library: LibraryHost
}

/**
 * The Archive (AR-*), main-process side.
 *
 * - `state.archive` is the recent window other features write to; `ArchiveSync` mirrors it into
 *   the `ArchiveStore` (every entry and its history, userData/archive/archive.jsonl).
 * - Commands (`archive.*`) query, restore, delete and clear; renderers hear `orbit:archive.changed`
 *   ({ version }) when the Archive changes and fetch again.
 */
export function registerArchive(ctx: MainContext): ArchiveApi {
  const { store: state, commands, windows } = ctx
  const store = new ArchiveStore(join(ctx.paths.userData, 'archive', 'archive.jsonl'))
  const sync = new ArchiveSync(ctx, store)
  sync.start()
  // The command bar searches the whole Archive, not only the recent entries in state (AR-04).
  provideArchiveSource(store)
  // Entries past their time go once the log is read, then hourly (AR-08).
  const stopRetention = scheduleRetention(ctx, sync, store)
  setTimeout(() => void store.load(), LOAD_DELAY_MS)
  // Sidebar backups (AR-11): a few minutes after the sidebar changes, and once after launch.
  const backups = new BackupStore(join(ctx.paths.userData, 'backups'))
  backups.onChange = () => windows.broadcast('orbit:backups.changed', {})
  const stopBackups = scheduleBackups(ctx, backups)
  // A deleted profile's data leaves the backups, as it leaves the Archive (PR-08).
  const stopProfileDrops = dropDeletedProfiles(ctx, backups)
  app.on('before-quit', (event) => {
    // Stopped by a feature that asks first (downloads in progress, DL-01): the Archive keeps running.
    if (event.defaultPrevented) return
    stopRetention()
    stopBackups()
    stopProfileDrops()
    store.close()
  })

  let changedTimer: ReturnType<typeof setTimeout> | undefined
  store.onChange = () => {
    if (changedTimer) return
    changedTimer = setTimeout(() => {
      changedTimer = undefined
      windows.broadcast('orbit:archive.changed', { version: store.version })
    }, CHANGED_DEBOUNCE_MS)
  }

  const windowOf = (c: CallContext): WindowId | undefined => c.windowId ?? windows.focusedWindowId()
  /** The Library shows in main windows: from a Mini Window it opens in the most recent main window. */
  const mainWindowOf = (c: CallContext): WindowId | undefined => {
    const s = state.state
    const id = windowOf(c)
    if (id && s.windows[id]?.kind === 'main') return id
    const focused = windows.focusedWindowId()
    if (focused && s.windows[focused]?.kind === 'main') return focused
    const main = windows.ids().filter((w) => s.windows[w]?.kind === 'main')
    const target = main[main.length - 1]
    if (target) windows.get(target)?.focus()
    return target
  }
  /** The profile a call is about: given, or the calling window's current Space's (PR-05). */
  const profileOf = (profileId: ProfileId | undefined, c: CallContext): ProfileId => {
    if (profileId) return profileId
    const s = state.state
    const windowId = windowOf(c)
    const win = windowId ? s.windows[windowId] : undefined
    const space = win ? s.spaces[win.spaceId] : undefined
    return space?.profileId ?? Object.keys(s.profiles)[0] ?? DEFAULT_PROFILE_ID
  }

  // ---- The Library (AR-02, DL-09) ----

  const library = new LibraryHost(ctx, {
    last: () => state.state.settings.librarySection || 'archive',
    remember: (section) => {
      if (state.state.settings.librarySection === section) return
      state.update((d) => {
        d.settings.librarySection = section
      })
    },
  })
  library.onChange = (windowId, open, section) => windows.sendToWindow(windowId, 'library.state', { open, section })
  ctx.actions.intercept((id, c) => library.intercept(id, c.windowId))

  const openLibrary = (c: CallContext, args: LibraryOpenArgs = {}) => {
    const section = typeof args.section === 'string' && SECTION_ID.test(args.section) ? args.section : undefined
    const keep = args.confirmKeep
    const confirmKeep =
      keep && KEEP_DAYS_CHOICES.some((k) => k.days === keep.days) && Number.isInteger(keep.count) && keep.count > 0
        ? { days: keep.days, count: keep.count }
        : undefined
    library.open(mainWindowOf(c), {
      ...(section ? { section } : {}),
      ...(args.confirmClear ? { confirmClear: true } : {}),
      ...(confirmKeep ? { confirmKeep } : {}),
    })
  }
  commands.register('library.open', (args, c) => openLibrary(c, args ?? {}))
  commands.register('library.close', (_args, c) => library.close(windowOf(c)))
  commands.register('library.drawn', ({ away }, c) => {
    if (typeof away === 'number') library.drawn(windowOf(c), away)
  })
  commands.register('library.toggle', (_args, c) => {
    const windowId = windowOf(c)
    if (library.isOpen(windowId)) library.close(windowId)
    else openLibrary(c)
  })
  commands.register('library.status', (_args, c) => library.status(windowOf(c)))
  commands.register('library.prepare', (_args, c) => library.prepare(windowOf(c)))
  commands.register('library.setSection', ({ section }, c) => {
    if (typeof section === 'string' && SECTION_ID.test(section)) library.setSection(windowOf(c), section)
  })
  ctx.actions.register('app.library', (c) => openLibrary(c))
  ctx.actions.register('app.archive', (c) => openLibrary(c, { section: 'archive' }))
  // The menu and the command bar ask in the Library before anything goes (AR-07).
  ctx.actions.register('archive.clear', (c) => openLibrary(c, { section: 'archive', confirmClear: true }))
  // ⌘Y / Ctrl+H, Archive → View History and the command bar show History in a tab (AR-10, pages
  // lane: src/main/pages/history.ts); the Library keeps its History section.
  // Help → Restore Data… and the command bar: the backups to choose from (AR-11).
  ctx.actions.register('app.restoreData', (c) => openLibrary(c, { section: 'backups' }))

  // ---- Archive entries ----

  commands.register('archive.query', async (args: ArchiveQuery, c) => {
    await store.load()
    return store.query({ ...args, profileId: profileOf(args.profileId, c) }, (url) => ctx.tabs.faviconFor(url))
  })

  // Deleted entries can come back from the toast's Undo for a minute (AR-07).
  const deletes = new DeleteUndo(ctx, store)
  const deleteEntries = (ids: readonly string[], windowId: WindowId | undefined): number => {
    const entries = ids.map((id) => store.get(id)).filter((e) => !!e)
    const gone = new Set(sync.remove(entries.map((e) => e.id)))
    if (gone.size === 0) return 0
    const undo = deletes.keep(entries.filter((e) => gone.has(e.id)))
    // The Library offers Undo, and the entries leave its selection.
    library.send(windowId, 'archive:deleted', { ids: [...gone], undo })
    return gone.size
  }
  commands.register('archive.delete', async ({ ids }, c) => {
    await store.load()
    return deleteEntries(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [], windowOf(c))
  })
  commands.register('archive.undoDelete', async ({ undo }) => {
    await store.load()
    return deletes.undo(undo)
  })
  // After the Library asked (AR-07). Browsing history is a separate store and stays.
  commands.register('archive.clear', async ({ profileId }, c) => {
    await store.load()
    return sync.clearProfile(profileOf(profileId, c)).length
  })
  commands.register('archive.setKeepDays', async ({ days, confirmed }) => {
    await store.load()
    return setKeepDays(ctx, store, days, confirmed === true)
  })
  // The app menu shows how long entries are kept (macOS has the only app menu).
  let keepDays = keepDaysOf(state.state)
  state.subscribe((next) => {
    const days = keepDaysOf(next)
    if (days === keepDays) return
    keepDays = days
    if (process.platform === 'darwin') installMenu(ctx)
  })

  /**
   * Restores entries for a window. A tab that went to a Space the window isn't showing gets a toast
   * that says where and offers to go there (AR-05): in the Library when it is open, else the window's.
   */
  const restore = (
    ids: readonly string[],
    windowId: WindowId | undefined,
    opts: { open?: boolean; here?: boolean; stay?: boolean },
  ): ArchiveRestoreResult => {
    const result = restoreEntries(ctx, store, ids, { windowId, ...opts })
    if (result.ids.length === 0 || !windowId) return result
    if (library.isOpen(windowId)) {
      library.send(windowId, 'archive:restored', result)
      return result
    }
    const s = state.state
    const current = s.windows[windowId]?.spaceId
    const away = result.spaceIds
      .map((spaceId, i) => ({ spaceId, tabId: result.tabIds[i] }))
      .filter((r) => r.spaceId !== current)
    const spaces = [...new Set(away.map((r) => r.spaceId))]
    const target = spaces[0]
    if (!target) return result
    if (spaces.length > 1) {
      windows.sendToWindow(windowId, 'toast', { message: `${away.length} tabs restored to ${spaces.length} Spaces` })
      return result
    }
    const name = s.spaces[target]?.name ?? 'another Space'
    const tabId = away.length === 1 ? away[0]?.tabId : undefined
    windows.sendToWindow(windowId, 'toast', {
      message: away.length > 1 ? `${away.length} tabs restored to ${name}` : `Restored to ${name}`,
      action: tabId
        ? { label: 'Go to Space', command: 'tabs.activate', args: { tabId } }
        : { label: 'Go to Space', command: 'spaces.switch', args: { spaceId: target } },
    })
    return result
  }

  commands.register('archive.restore', async ({ id, ids, open, here, stay }, c) => {
    await store.load()
    const list = [...(Array.isArray(ids) ? ids : []), ...(typeof id === 'string' ? [id] : [])]
    return restore(list, windowOf(c), { open: open === true, here: here === true, stay: stay === true })
  })

  // ---- Preview (AR-06): a row's page in a Peek over the Library ----

  const previews = new ArchivePreviews(ctx, store, (windowId) => library.isOpen(windowId))
  sync.skip = (s, e) => previews.isEcho(s, e)
  commands.register('archive.preview', async ({ id }, c) => {
    const windowId = windowOf(c)
    if (!windowId || typeof id !== 'string') return null
    await store.load()
    const entry = store.get(id)
    const s = state.state
    const win = s.windows[windowId]
    if (!entry || win?.kind !== 'main') return null
    // The Peek's page takes the window's profile: never another profile's entry there (PR-05).
    if (s.spaces[win.spaceId]?.profileId !== entry.profileId) return null
    const overlay = win.overlay
    // A second click while it opens: the preview is up already.
    if (previews.entryOf(windowId) === id && overlay.kind === 'peek') return { tabId: overlay.tabId, peek: true }
    const tabId = await commands.run('peek.open', { url: entry.url }, { windowId })
    if (tabId) {
      previews.track(windowId, entry, tabId)
      return { tabId, peek: true }
    }
    // Nothing to preview over (an empty Space): the page opens in a new tab and the entry stays.
    return { tabId: await commands.run('tabs.create', { url: entry.url }, { windowId }), peek: false }
  })
  commands.register('archive.restorePreview', async (_args, c) => {
    const windowId = windowOf(c)
    const id = previews.entryOf(windowId)
    if (!windowId || !id) return { ids: [], tabIds: [], spaceIds: [] }
    await store.load()
    // The Peek closes first (its page is still archived, so the close adds no entry), then the entry goes back.
    await commands.run('peek.close', {}, { windowId })
    return restore([id], windowId, {})
  })

  // ---- Row menu (AR-05, AR-07) ----

  let lastMenu: MenuItemConstructorOptions[] = []
  commands.register('archive.contextMenu', async ({ ids }, c) => {
    await store.load()
    const windowId = windowOf(c)
    const entries = (Array.isArray(ids) ? ids : []).map((id) => store.get(id)).filter((e) => !!e)
    if (entries.length === 0) {
      // Rows that are gone show nothing; no rows at all is the Archive's entry in the section list.
      if (Array.isArray(ids) && ids.length > 0) return
      const canClear = !store.newestFirst(profileOf(undefined, c)).next().done
      lastMenu = archiveSectionItems(ctx, () => windowId, { canClear })
      if (ctx.e2e) return
      const win = windowId ? windows.get(windowId) : undefined
      if (win?.isDestroyed()) return
      Menu.buildFromTemplate(lastMenu).popup(win ? { window: win } : undefined)
      return
    }
    const many = entries.length > 1
    const first = entries[0] as (typeof entries)[number]
    const items: MenuItemConstructorOptions[] = [
      {
        label: many ? `Restore ${entries.length} Tabs` : 'Restore',
        click: () =>
          restore(
            entries.map((e) => e.id),
            windowId,
            {},
          ),
      },
    ]
    if (!many) {
      items.push({
        label: 'Open in New Tab',
        click: () => {
          commands
            .run('tabs.create', { url: first.url }, { windowId })
            .catch((err) => console.error('[archive] could not open an archived page', err))
        },
      })
    }
    items.push(
      {
        label: many ? `Copy ${entries.length} URLs` : 'Copy URL',
        click: () => {
          clipboard.writeText(entries.map((e) => e.url).join('\n'))
          library.send(windowId, 'library:toast', { message: many ? 'Copied URLs' : 'Copied URL' })
        },
      },
      { type: 'separator' },
      {
        label: many ? `Delete ${entries.length} from Archive` : 'Delete from Archive',
        click: () => {
          deleteEntries(
            entries.map((e) => e.id),
            windowId,
          )
        },
      },
    )
    lastMenu = items
    if (ctx.e2e) return
    const win = windowId ? windows.get(windowId) : undefined
    if (win?.isDestroyed()) return
    Menu.buildFromTemplate(items).popup(win ? { window: win } : undefined)
  })

  // ---- Sidebar backups and Restore Data (AR-11) ----

  const info = (b: BackupInfo): BackupInfo => ({
    id: b.id,
    at: b.at,
    spaces: b.spaces,
    tabs: b.tabs,
    ...(b.unreadable ? { unreadable: true } : {}),
  })
  commands.register('backups.list', async () => (await backups.list()).map(info))
  commands.register('backups.take', async () => {
    try {
      return info(await backups.take(state.state, Date.now()))
    } catch (err) {
      console.error('[backups] could not back up the sidebar', err)
      return null
    }
  })
  const restoreData = new RestoreData(ctx, store, backups)
  commands.register('backups.restore', ({ id }) => restoreData.restore(id))
  commands.register('backups.undoRestore', ({ step }) => restoreData.undo(step))

  // ---- History (AR-10): the history store's visits, for the Library's History section ----

  commands.register('library.history', async (q, c) => {
    const visits = await commands.run('history.visits', historyQuery(q ?? {}, profileOf(q?.profileId, c)))
    return historyRows(visits, (url) => ctx.tabs.faviconFor(url))
  })
  commands.register('library.historyMenu', ({ url, profileId }, c) => {
    if (typeof url !== 'string' || !url) return
    const windowId = windowOf(c)
    lastMenu = historyMenuItems(ctx, {
      url,
      profileId: profileOf(profileId, c),
      windowId,
      send: (channel, payload) => library.send(windowId, channel, payload),
      copy: (text) => clipboard.writeText(text),
    })
    if (ctx.e2e) return
    const win = windowId ? windows.get(windowId) : undefined
    if (win?.isDestroyed()) return
    Menu.buildFromTemplate(lastMenu).popup(win ? { window: win } : undefined)
  })

  // ---- Recently Closed (AR-09) ----

  const reopenAction = ACTIONS_BY_ID['tab.reopenClosed']
  // Read as the menu opens: the user may have remapped it (KS-01, KS-18).
  const reopenKeyNow = () => {
    const shortcut = reopenAction ? shortcutsFor(reopenAction, process.platform)[0] : undefined
    return shortcut ? toElectronAccelerator(shortcut) : undefined
  }
  // The app menu's Recently Closed submenu follows the list (macOS has the only app menu).
  watchRecentlyClosed(ctx, () => {
    if (process.platform === 'darwin') installMenu(ctx)
  })
  commands.register('archive.recentlyClosedMenu', async ({ x, y }, c) => {
    const windowId = windowOf(c)
    await refreshRecentlyClosed(ctx)
    const list = recentlyClosedItems(ctx, () => windowId)
    const reopenKey = reopenKeyNow()
    const items: MenuItemConstructorOptions[] = [
      ...list,
      { type: 'separator' },
      {
        label: 'Reopen Closed Tab',
        enabled: list.some((i) => i.enabled !== false),
        ...(reopenKey ? { accelerator: reopenKey, registerAccelerator: false } : {}),
        click: () => {
          Promise.resolve(ctx.actions.run('tab.reopenClosed', { windowId })).catch((err) =>
            console.error('[archive] could not reopen a closed tab', err),
          )
        },
      },
    ]
    lastMenu = items
    if (ctx.e2e) return
    const win = windowId ? windows.get(windowId) : undefined
    if (!win || win.isDestroyed()) return
    const at = typeof x === 'number' && typeof y === 'number' ? library.toWindowPoint(windowId, x, y) : undefined
    Menu.buildFromTemplate(items).popup({ window: win, ...(at ?? {}) })
  })

  if (ctx.e2e) {
    commands.register('library.testInfo', (_args, c) => library.info(windowOf(c)))
    commands.register('archive.testMenu', ({ click, appMenu }) => {
      if (appMenu) {
        const file = Menu.getApplicationMenu()?.items.find((i) => i.label === 'File')
        const recent = file?.submenu?.items.find((i) => i.label === 'Recently Closed')
        return recent?.submenu?.items.map((i) => i.label) ?? []
      }
      if (click) {
        const item = findMenuItem(lastMenu, click)
        if (item?.click && item.enabled !== false) (item.click as () => void)()
      }
      return menuLabels(lastMenu)
    })
    // Fills the Archive for tests (lists, search at scale) without growing OrbitState.
    commands.register(
      'archive.testSeed',
      async ({ count, days = 30, profileId, spaceId, prefix = 'Seeded', base }, c) => {
        await store.load()
        // Pages of the test's fixture server when given: opening one never reaches the network.
        const origin =
          typeof base === 'string' && /^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}$/.test(base) ? base : undefined
        const s = state.state
        const profile = profileOf(profileId, c)
        const space = spaceId ?? s.spaceOrder.find((id) => s.spaces[id]?.profileId === profile) ?? s.spaceOrder[0] ?? ''
        const now = Date.now()
        const words = [
          'alpha',
          'budget',
          'cinema',
          'delta',
          'garden',
          'harbor',
          'island',
          'journal',
          'kitchen',
          'lantern',
        ]
        const span = Math.max(1, days) * 24 * 3600_000
        const entries: ArchivedTab[] = []
        for (let i = 0; i < count; i++) {
          const word = words[i % words.length] as string
          entries.push({
            id: newId('a'),
            url: origin ? `${origin}/page/${word}${i % 97}-${i}` : `https://${word}${i % 97}.example.test/page/${i}`,
            title: `${prefix} ${word} ${i}`,
            spaceId: space,
            profileId: profile,
            // Oldest first, spread evenly over the span, the newest a minute ago.
            archivedAt: now - 60_000 - Math.round(((count - 1 - i) / Math.max(1, count)) * span),
            reason: i % 3 === 0 ? 'auto' : 'closed',
            section: 'today',
            // Every tenth (the "lantern" pages) closed in a Mini Window (AR-03's source filter).
            ...(i % 10 === 9 ? { from: 'mini' as const } : {}),
          })
        }
        return store.add(entries).length
      },
    )
  }

  return { store, sync, library }
}
