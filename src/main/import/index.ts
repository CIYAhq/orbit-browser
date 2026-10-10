import { randomUUID } from 'node:crypto'
import { copyFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { ACTIONS_BY_ID } from '../../shared/actions'
import {
  type ImportDataType,
  type ImportPlan,
  type ImportProgressItem,
  type ImportSkip,
  type ImportSource,
  type ImportStart,
  type Inspection,
  isLongList,
  MAX_FILE_BYTES,
  PASTED_LIST,
  type ParsedFile,
  type ProfileContents,
  TOO_LARGE,
  unreadableSkip,
} from '../../shared/commands/import'
import type { WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import type { HistoryService } from '../history'
import type { CallContext } from '../registry'
import { type FoundSource, findSources, inspectProfile, publicSource } from './browsers'
import { removeScratch, setCopyStep, setScratchFolder, withScratch } from './copy'
import { pinnedExport } from './export'
import { cleanTree, FILE_FOLDER_NAME, type FileRead, LINKS_FOLDER_NAME, OVER_LIMIT } from './files'
import { historyTask } from './history'
import { ImportJobs, type Task } from './jobs'
import { countBookmarks, NO_BOOKMARKS, writeBookmarksHtml } from './netscape'
import { importPlaces } from './places'
import { readFileOffMain, readLinksOffMain, stopReaders, UNREADABLE } from './reader'
import { IMPORT_WINDOW_ID, ImportWindow } from './window'

export function registerImport(ctx: MainContext, history: HistoryService): void {
  const { commands, actions, store, windows } = ctx
  const jobs = new ImportJobs(ctx)
  // Copies of another browser's files go under user data: what a crash left is cleared now, and the
  // copies being read are removed at quit, before Orbit exits (D58). This runs before the state's last write.
  setScratchFolder(join(ctx.paths.userData, 'import-scratch'))
  app.on('will-quit', () => {
    jobs.quit()
    stopReaders()
    removeScratch()
  })
  if (ctx.e2e) {
    const hooks = {
      /** The next import stops adding once `at` bookmarks are made, until Orbit quits (D62's tests quit part-way). */
      holdAddingAt: (at: number) => {
        jobs.testPause = (made) => (made >= at ? new Promise<void>(() => {}) : undefined)
      },
      /** Each copy of another browser's file is made, then its step never finishes: only the quit can remove it. */
      holdCopying: () => {
        setCopyStep(async (from, to) => {
          await copyFile(from, to)
          await new Promise<void>(() => {})
        })
      },
    }
    ;(globalThis as unknown as { __orbitImport: typeof hooks }).__orbitImport = hooks
  }
  // A list of links too long to edit (D62 (5)): main holds its bytes for the import window, which shows only its count
  // and first lines. One at a time: the newest replaces it; an import started from it, or the window closing, lets it go.
  // Main's thread never makes text of it: the bytes come from the window and go to the reader, moved, not copied.
  let held: { id: string; bytes: Uint8Array } | undefined
  /** A file or a list, read: a long list is held here, and the window gets its count and first lines (D62 (5)). */
  const present = (read: FileRead): ParsedFile => {
    if (read.kind !== 'links') return read
    const count = read.info.count
    if (!read.bytes) return { kind: 'links', name: read.name, count, text: read.text ?? '' }
    held = { id: randomUUID(), bytes: read.bytes }
    return { kind: 'links', name: read.name, count, held: { id: held.id, count, preview: read.info.preview } }
  }
  /** A pasted list's bytes: over the cap it says so (D62 (5)); else counted once, in the reader, and held when long. */
  const checkedList = async (name: string, bytes: unknown): Promise<ParsedFile> => {
    if (!(bytes instanceof Uint8Array)) return { kind: 'error', name, message: UNREADABLE }
    if (bytes.byteLength > MAX_FILE_BYTES) return { kind: 'error', name, message: TOO_LARGE }
    return present(await readFileOffMain({ op: 'list', name, bytes }))
  }
  /** Where the import window is asked to start (a paste or a drop on the sidebar), checked: a pasted list is read. */
  const checkStart = async (start: unknown): Promise<ImportStart | undefined> => {
    const s = start as Partial<{ kind: string; bytes: unknown; file: unknown }> | undefined
    if (s?.kind === 'file' && s.file && typeof s.file === 'object') {
      const file = s.file as ParsedFile
      // A list sent as text too long to edit (only an older window would) is held all the same.
      if (file.kind === 'links' && 'text' in file && typeof file.text === 'string' && isLongList(file.text)) {
        return { kind: 'file', file: await checkedList(file.name, new TextEncoder().encode(file.text)) }
      }
      return { kind: 'file', file }
    }
    if (s?.kind !== 'links') return undefined
    const list = await checkedList(PASTED_LIST, s.bytes)
    if (list.kind === 'links' && 'held' in list) return { kind: 'links', held: list.held }
    if (list.kind === 'links') return { kind: 'links', text: list.text }
    return { kind: 'file', file: list }
  }
  const win = new ImportWindow(
    ctx,
    () => {
      const windowId = win.browserWindow()
      const spaceId = windowId ? store.state.windows[windowId]?.spaceId : store.state.spaceOrder[0]
      return {
        ...(spaceId ? { spaceId, profileId: store.state.spaces[spaceId]?.profileId } : {}),
        job: jobs.status(),
      }
    },
    () => {
      held = undefined
    },
  )
  /** The browser window a call acts for (the import window and onboarding act for one). */
  const browserOf = (c: CallContext): WindowId | undefined => {
    const id = c.windowId
    return id && store.state.windows[id]?.kind === 'main' ? id : win.browserWindow()
  }

  commands.register('import.open', async ({ start }, c) => {
    const from = c.windowId === IMPORT_WINDOW_ID ? undefined : (c.windowId ?? windows.focusedWindowId())
    win.open(from, await checkStart(start))
  })
  commands.register('import.session', () => win.takeSession())

  // The browsers found by the last look (IM-02). Their folders stay here; the window gets ids and names.
  let found = new Map<string, FoundSource>()
  const discover = async () => {
    const list = await findSources(importPlaces(ctx.e2e))
    found = new Map(list.map((s) => [s.id, s]))
    return list
  }
  const sourceOf = async (id: unknown): Promise<FoundSource> => {
    const source = found.get(String(id)) ?? (await discover()).find((s) => s.id === id)
    if (!source || source.blocked) throw new Error('That browser can’t be read')
    return source
  }
  commands.register('import.sources', async (): Promise<ImportSource[]> => (await discover()).map(publicSource))
  // What the last look at each profile couldn't read: the import's summary names it too (F3).
  const unreadable = new Map<string, NonNullable<ProfileContents['unreadable']>>()
  commands.register('import.inspect', async ({ sourceId, profileIds }): Promise<Inspection> => {
    const source = await sourceOf(sourceId)
    const ids = new Set(Array.isArray(profileIds) ? profileIds : [])
    const profiles = await withScratch(async (scratch) => {
      const out = []
      for (const p of source.profiles) if (ids.has(p.id)) out.push(await inspectProfile(source, p, scratch))
      return out
    })
    for (const p of profiles) unreadable.set(`${source.id}/${p.profileId}`, p.unreadable ?? {})
    return { sourceId: source.id, browser: source.browser, name: source.name, profiles }
  })
  // A file is read in a worker, never on main's thread (D58).
  // Its bytes go to the worker as they came, moved, not copied (D62 (5)).
  commands.register('import.parseFile', async ({ name, bytes }): Promise<ParsedFile> => {
    const file = typeof name === 'string' ? basename(name) : 'file'
    if (!(bytes instanceof Uint8Array)) return { kind: 'error', name: file, message: NO_BOOKMARKS }
    if (bytes.byteLength > MAX_FILE_BYTES) return { kind: 'error', name: file, message: TOO_LARGE }
    return present(await readFileOffMain({ op: 'file', name: file, bytes }))
  })
  commands.register('import.holdLinks', ({ bytes }) => checkedList(PASTED_LIST, bytes))
  commands.register('import.chooseFile', async (_args, c): Promise<ParsedFile | null> => {
    const parent = (c.windowId === IMPORT_WINDOW_ID ? win.window : undefined) ?? BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: 'Import from a File',
      properties: ['openFile'],
      filters: [
        { name: 'Bookmarks or links', extensions: ['html', 'htm', 'txt'] },
        { name: 'All files', extensions: ['*'] },
      ],
    }
    const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    const path = picked.canceled ? undefined : picked.filePaths[0]
    if (!path) return null
    const name = basename(path)
    try {
      if ((await stat(path)).size > MAX_FILE_BYTES) return { kind: 'error', name, message: TOO_LARGE }
    } catch {
      return { kind: 'error', name, message: UNREADABLE }
    }
    return present(await readFileOffMain({ op: 'path', name, path }))
  })

  commands.register('import.start', async ({ plan }, c) => {
    const p = plan as ImportPlan
    const item = (type: ImportProgressItem['type'], total?: number): ImportProgressItem => ({
      type,
      state: 'waiting',
      done: 0,
      ...(total !== undefined ? { total } : {}),
    })
    /** Bookmarks (or links) past the limit of one import, as a summary line (IM-14). */
    const overLimit = (count: number, [one, many] = ['bookmark', 'bookmarks']): ImportSkip => ({
      what: count === 1 ? one : many,
      count,
      reason: OVER_LIMIT,
    })
    if (p?.kind === 'file') {
      const bookmarks = item('bookmarks')
      const tasks: Task[] = [
        {
          item: bookmarks,
          // The tree comes back from the import window: checked again, a turn after the call returns.
          read: async (job) => {
            await new Promise((resolve) => setImmediate(resolve))
            const { nodes, cut } = cleanTree(p.bookmarks)
            bookmarks.total = countBookmarks(nodes)
            job.bookmarks.set('', [{ title: '', nodes }])
            // Left out when the file was read, and now (only a window that sent more than it was given).
            const fromFile = typeof p.cut === 'number' && p.cut > 0 ? Math.min(Math.floor(p.cut), 1e9) : 0
            jobs.addSkips(job, [overLimit(fromFile + cut)])
          },
          add: async (job) => jobs.addBookmarks(job, bookmarks),
        },
      ]
      return jobs.start(p, basename(String(p.name ?? 'file')), FILE_FOLDER_NAME, tasks, { windowId: browserOf(c) })
    }
    if (p?.kind === 'links') {
      // IM-12: one pinned folder, named by the user, with a pinned tab per link in the list's order.
      const links = item('links')
      const folderName =
        (typeof p.folderName === 'string' ? p.folderName.trim().slice(0, 200) : '') || LINKS_FOLDER_NAME
      const source = typeof p.name === 'string' && p.name ? basename(p.name) : 'a pasted list'
      // A long list is held here (D62 (5)): the import takes it, and it's let go.
      let list: string | Uint8Array = typeof p.text === 'string' ? p.text : ''
      if (typeof list === 'string' && list.length > MAX_FILE_BYTES) throw new Error(TOO_LARGE)
      if (typeof p.held === 'string') {
        if (held?.id !== p.held) throw new Error('This list of links is gone: drop or paste it again')
        list = held.bytes
        held = undefined
      }
      const tasks: Task[] = [
        {
          item: links,
          read: async (job) => {
            // Read in a worker (D58); main takes the answer a part at a time.
            const { nodes, lines, cut } = await readLinksOffMain(list)
            list = ''
            links.total = countBookmarks(nodes)
            job.bookmarks.set('', [{ title: '', nodes }])
            jobs.addSkips(job, [
              { what: lines === 1 ? 'line' : 'lines', count: lines, reason: 'Not a link' },
              overLimit(cut, ['link', 'links']),
            ])
          },
          add: async (job) => jobs.addBookmarks(job, links),
        },
      ]
      return jobs.start(p, source, folderName, tasks, { windowId: browserOf(c) })
    }
    if (p?.kind === 'browser') {
      // IM-02 to IM-06: the chosen profiles' types, into "Imported from <Browser>" (IM-05).
      const source = await sourceOf(p.sourceId)
      const chosen = (Array.isArray(p.profiles) ? p.profiles : []).flatMap((x) => {
        const profile = source.profiles.find((sp) => sp.id === x?.profileId)
        const types = new Set<ImportDataType>(Array.isArray(x?.types) ? x.types : [])
        return profile ? [{ profile, types, bookmarks: x.bookmarks }] : []
      })
      const tasks: Task[] = []
      const withMarks = chosen.filter((x) => x.types.has('bookmarks'))
      if (withMarks.length > 0) {
        const bookmarks = item('bookmarks')
        tasks.push({
          item: bookmarks,
          read: async (job) => {
            await new Promise((resolve) => setImmediate(resolve))
            bookmarks.total = 0
            let cut = 0
            for (const x of withMarks) {
              const clean = cleanTree(x.bookmarks)
              bookmarks.total += countBookmarks(clean.nodes)
              cut += clean.cut
              job.bookmarks.set(x.profile.id, [{ title: '', nodes: clean.nodes }])
            }
            jobs.addSkips(job, [overLimit(cut)])
          },
          add: async (job) => jobs.addBookmarks(job, bookmarks),
        })
      }
      // IM-07: history to each destination's profile (one that keeps history: never a private one).
      const withHistory = chosen.filter((x) => x.types.has('history')).map((x) => x.profile)
      if (withHistory.length > 0) {
        const keeps = (profileId: string) => !!store.state.profiles[profileId]?.partition.startsWith('persist:')
        tasks.push(historyTask(jobs, history, source, withHistory, keeps))
      }
      if (tasks.length === 0) throw new Error('Nothing to import')
      const names = new Map(chosen.map((x) => [x.profile.id, x.profile.name]))
      const id = jobs.start(p, source.name, `Imported from ${source.name}`, tasks, { windowId: browserOf(c) }, names)
      // The types chosen that a chosen profile couldn't provide, its file damaged: named in the summary (F3).
      const types = new Set(chosen.flatMap((x) => [...x.types]))
      const job = jobs.get(id)
      if (job) {
        jobs.addSkips(
          job,
          chosen.flatMap((x) =>
            Object.entries(unreadable.get(`${source.id}/${x.profile.id}`) ?? {}).flatMap(([type, why]) =>
              types.has(type as ImportDataType) ? [unreadableSkip(x.profile.name, type as ImportDataType, why)] : [],
            ),
          ),
        )
      }
      return id
    }
    throw new Error('Unknown import')
  })
  commands.register('import.status', ({ jobId }) => jobs.status(jobId))
  commands.register('import.cancel', ({ jobId }) => jobs.cancel(jobId))
  commands.register('import.commit', ({ jobId }) => jobs.commit(jobId))
  commands.register('import.close', () => win.close())
  commands.register('import.suggest', ({ jobId, url, accepted }) => jobs.suggest(jobId, url, accepted === true))
  // Export pinned items as bookmarks (IM-17): the system's save dialog, then a bookmarks file.
  commands.register('import.exportPinned', async ({ profileId, includeToday }, c) => {
    const parent = (c.windowId ? windows.get(c.windowId) : undefined) ?? BrowserWindow.getFocusedWindow()
    const options: Electron.SaveDialogOptions = {
      title: 'Export Pinned Items as Bookmarks',
      defaultPath: join(app.getPath('documents'), 'Orbit pinned items.html'),
      filters: [{ name: 'Bookmarks', extensions: ['html'] }],
    }
    const picked = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) return null
    const nodes = pinnedExport(store.state, { profileId, includeToday: includeToday === true })
    await writeFile(picked.filePath, writeBookmarksHtml(nodes), 'utf8')
    return picked.filePath
  })

  // Done (IM-14): the browser window shows the imported folder, in its Space, pinned section open.
  commands.register('import.reveal', async ({ jobId }, c) => {
    const job = jobs.find(jobId)
    const folder = job?.status.folders[0]
    const windowId = (job?.opener && store.state.windows[job.opener] ? job.opener : undefined) ?? browserOf(c)
    if (c.windowId === IMPORT_WINDOW_ID) win.close()
    if (!folder || !windowId || !store.state.folders[folder.folderId]) return
    const run = commands.run.bind(commands) as unknown as (n: string, a: unknown, cc: CallContext) => Promise<unknown>
    if (store.state.windows[windowId]?.spaceId !== folder.spaceId) {
      await run('spaces.switch', { spaceId: folder.spaceId }, { windowId })
    }
    if (store.state.spaces[folder.spaceId]?.pinnedCollapsed) {
      await run('tabs.setPinnedCollapsed', { spaceId: folder.spaceId, collapsed: false }, { windowId })
    }
    const bw = windows.get(windowId)
    if (bw && !bw.isDestroyed()) bw.focus()
    windows.sendToWindow(windowId, 'sidebar:reveal', { id: folder.folderId })
  })

  actions.register('app.import', ({ windowId }) => win.open(windowId))
  actions.register('app.exportPinned', async ({ windowId }) => {
    await commands.run('import.exportPinned', {}, { windowId })
  })

  // Onboarding's import is held until Start browsing commits it; ending another way adds nothing (OB-14).
  store.subscribe((next, prev) => {
    if (next.settings.onboarded && !prev.settings.onboarded) jobs.dropHeld()
  })

  // Keys pressed in the import window: ⌘W closes it; app and window actions act for its browser window.
  actions.intercept((id, c) => {
    if (c.windowId !== IMPORT_WINDOW_ID) return false
    if (id === 'tab.close' || id === 'window.close') win.close()
    else if (id === 'app.import') win.focus()
    else if (ACTIONS_BY_ID[id]?.category === 'App' || ACTIONS_BY_ID[id]?.category === 'Window') {
      const target = win.browserWindow()
      const bw = target ? windows.get(target) : undefined
      if (bw && !bw.isDestroyed()) bw.focus()
      void actions.run(id, { windowId: target })
    }
    return true
  })
}
