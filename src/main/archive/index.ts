import { join } from 'node:path'
import { app, clipboard, Menu, type MenuItemConstructorOptions } from 'electron'
import type { ArchiveQuery, ArchiveRestoreResult, LibraryOpenArgs } from '../../shared/commands/archive'
import { DEFAULT_PROFILE_ID } from '../../shared/defaults'
import { newId } from '../../shared/ids'
import type { ArchivedTab, ProfileId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import type { CallContext } from '../registry'
import { findMenuItem, menuLabels } from '../tabs/menus'
import { LibraryHost } from './library'
import { restoreEntries } from './restore'
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
  setTimeout(() => void store.load(), LOAD_DELAY_MS)
  app.on('before-quit', () => store.close())

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
    library.open(mainWindowOf(c), {
      ...(section ? { section } : {}),
      ...(args.confirmClear ? { confirmClear: true } : {}),
    })
  }
  commands.register('library.open', (args, c) => openLibrary(c, args ?? {}))
  commands.register('library.close', (_args, c) => library.close(windowOf(c)))
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

  // ---- Archive entries ----

  commands.register('archive.query', async (args: ArchiveQuery, c) => {
    await store.load()
    return store.query({ ...args, profileId: profileOf(args.profileId, c) }, (url) => ctx.tabs.faviconFor(url))
  })

  commands.register('archive.delete', async ({ ids }) => {
    await store.load()
    return sync.remove(Array.isArray(ids) ? ids : []).length
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

  // ---- Row menu (AR-05, AR-07) ----

  let lastMenu: MenuItemConstructorOptions[] = []
  commands.register('archive.contextMenu', async ({ ids }, c) => {
    await store.load()
    const windowId = windowOf(c)
    const entries = (Array.isArray(ids) ? ids : []).map((id) => store.get(id)).filter((e) => !!e)
    if (entries.length === 0) return
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
        click: () => void commands.run('tabs.create', { url: first.url }, { windowId }),
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
        click: () => sync.remove(entries.map((e) => e.id)),
      },
    )
    lastMenu = items
    if (ctx.e2e) return
    const win = windowId ? windows.get(windowId) : undefined
    if (win?.isDestroyed()) return
    Menu.buildFromTemplate(items).popup(win ? { window: win } : undefined)
  })

  if (ctx.e2e) {
    commands.register('library.testInfo', (_args, c) => library.info(windowOf(c)))
    commands.register('archive.testMenu', ({ click }) => {
      if (click) {
        const item = findMenuItem(lastMenu, click)
        if (item?.click && item.enabled !== false) (item.click as () => void)()
      }
      return menuLabels(lastMenu)
    })
    // Fills the Archive for tests (lists, search at scale) without growing OrbitState.
    commands.register('archive.testSeed', async ({ count, days = 30, profileId, spaceId, prefix = 'Seeded' }, c) => {
      await store.load()
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
          url: `https://${word}${i % 97}.example.test/page/${i}`,
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
    })
  }

  return { store, sync, library }
}
