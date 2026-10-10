import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import { ACTIONS_BY_ID } from '../../shared/actions'
import type {
  ImportDataType,
  ImportPlan,
  ImportProgressItem,
  ImportSource,
  Inspection,
  ParsedFile,
} from '../../shared/commands/import'
import type { WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import type { HistoryService } from '../history'
import type { CallContext } from '../registry'
import { type FoundSource, findSources, inspectProfile, publicSource } from './browsers'
import { withScratch } from './copy'
import { cleanTree, FILE_FOLDER_NAME, LINKS_FOLDER_NAME, linkNodes, MAX_FILE_BYTES, parseFile } from './files'
import { ImportJobs, type Task } from './jobs'
import { countBookmarks, NO_BOOKMARKS } from './netscape'
import { importPlaces } from './places'
import { IMPORT_WINDOW_ID, ImportWindow } from './window'

export function registerImport(ctx: MainContext, _history: HistoryService): void {
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
  commands.register('import.parseFile', ({ name, text }): ParsedFile => {
    const file = typeof name === 'string' ? basename(name) : 'file'
    if (typeof text !== 'string' || text.length > MAX_FILE_BYTES)
      return { kind: 'error', name: file, message: NO_BOOKMARKS }
    return parseFile(file, text)
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
      if ((await stat(path)).size > MAX_FILE_BYTES) return { kind: 'error', name, message: NO_BOOKMARKS }
      return parseFile(name, await readFile(path, 'utf8'))
    } catch {
      return { kind: 'error', name, message: 'Orbit couldn’t read this file' }
    }
  })

  commands.register('import.start', async ({ plan }, c) => {
    const p = plan as ImportPlan
    const item = (type: ImportProgressItem['type'], total?: number): ImportProgressItem => ({
      type,
      state: 'waiting',
      done: 0,
      ...(total !== undefined ? { total } : {}),
    })
    if (p?.kind === 'file') {
      const bookmarks = item('bookmarks')
      const tasks: Task[] = [
        {
          item: bookmarks,
          // The tree comes back from the import window: checked again, a turn after the call returns.
          read: async (job) => {
            await new Promise((resolve) => setImmediate(resolve))
            const nodes = cleanTree(p.bookmarks)
            bookmarks.total = countBookmarks(nodes)
            job.bookmarks.set('', [{ title: '', nodes }])
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
            await new Promise((resolve) => setImmediate(resolve))
            const { nodes, lines } = linkNodes(typeof p.text === 'string' ? p.text : '')
            links.total = countBookmarks(nodes)
            job.bookmarks.set('', [{ title: '', nodes }])
            jobs.addSkips(job, [{ what: lines === 1 ? 'line' : 'lines', count: lines, reason: 'Not a link' }])
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
            for (const x of withMarks) {
              const nodes = cleanTree(x.bookmarks)
              bookmarks.total += countBookmarks(nodes)
              job.bookmarks.set(x.profile.id, [{ title: '', nodes }])
            }
          },
          add: async (job) => jobs.addBookmarks(job, bookmarks),
        })
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
  commands.register('import.suggest', () => undefined)
  commands.register('import.exportPinned', async () => null)

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
