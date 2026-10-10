import { stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { ACTIONS_BY_ID } from '../../shared/actions'
import {
  type ImportDataType,
  type ImportPlan,
  type ImportProgressItem,
  type ImportSkip,
  type ImportSource,
  type Inspection,
  MAX_FILE_BYTES,
  type ParsedFile,
  TOO_LARGE,
} from '../../shared/commands/import'
import type { WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import type { HistoryService } from '../history'
import type { CallContext } from '../registry'
import { type FoundSource, findSources, inspectProfile, publicSource } from './browsers'
import { withScratch } from './copy'
import { pinnedExport } from './export'
import { cleanTree, FILE_FOLDER_NAME, LINKS_FOLDER_NAME, OVER_LIMIT } from './files'
import { historyTask } from './history'
import { ImportJobs, type Task } from './jobs'
import { countBookmarks, NO_BOOKMARKS, writeBookmarksHtml } from './netscape'
import { importPlaces } from './places'
import { readFileOffMain, readLinksOffMain, UNREADABLE } from './reader'
import { IMPORT_WINDOW_ID, ImportWindow } from './window'

export function registerImport(ctx: MainContext, history: HistoryService): void {
  const { commands, actions, store, windows } = ctx
  const jobs = new ImportJobs(ctx)
  const win = new ImportWindow(ctx, () => {
    const windowId = win.browserWindow()
    const spaceId = windowId ? store.state.windows[windowId]?.spaceId : store.state.spaceOrder[0]
    return {
      ...(spaceId ? { spaceId, profileId: store.state.spaces[spaceId]?.profileId } : {}),
      job: jobs.status(),
    }
  })
  /** The browser window a call acts for (the import window and onboarding act for one). */
  const browserOf = (c: CallContext): WindowId | undefined => {
    const id = c.windowId
    return id && store.state.windows[id]?.kind === 'main' ? id : win.browserWindow()
  }

  commands.register('import.open', ({ start }, c) => {
    if (c.windowId === IMPORT_WINDOW_ID) win.open(undefined, start)
    else win.open(c.windowId ?? windows.focusedWindowId(), start)
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
  commands.register('import.inspect', async ({ sourceId, profileIds }): Promise<Inspection> => {
    const source = await sourceOf(sourceId)
    const ids = new Set(Array.isArray(profileIds) ? profileIds : [])
    const profiles = await withScratch(async (scratch) => {
      const out = []
      for (const p of source.profiles) if (ids.has(p.id)) out.push(await inspectProfile(source, p, scratch))
      return out
    })
    return { sourceId: source.id, browser: source.browser, name: source.name, profiles }
  })
  // A file is read in a worker, never on main's thread (D58).
  commands.register('import.parseFile', async ({ name, text }): Promise<ParsedFile> => {
    const file = typeof name === 'string' ? basename(name) : 'file'
    if (typeof text !== 'string') return { kind: 'error', name: file, message: NO_BOOKMARKS }
    if (text.length > MAX_FILE_BYTES) return { kind: 'error', name: file, message: TOO_LARGE }
    return readFileOffMain({ op: 'file', name: file, text })
  })
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
    return readFileOffMain({ op: 'path', name, path })
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
      const tasks: Task[] = [
        {
          item: links,
          read: async (job) => {
            // Read in a worker (D58); main takes the answer a part at a time.
            const { nodes, lines, cut } = await readLinksOffMain(typeof p.text === 'string' ? p.text : '')
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
      return jobs.start(p, source.name, `Imported from ${source.name}`, tasks, { windowId: browserOf(c) }, names)
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
    const job = jobs.get(jobId)
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
