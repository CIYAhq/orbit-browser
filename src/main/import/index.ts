import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import { ACTIONS_BY_ID } from '../../shared/actions'
import type { ImportPlan, ImportProgressItem, ImportSource, ParsedFile } from '../../shared/commands/import'
import type { WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import type { HistoryService } from '../history'
import type { CallContext } from '../registry'
import { cleanTree, FILE_FOLDER_NAME, MAX_FILE_BYTES, parseFile } from './files'
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
  commands.register('import.sources', async (): Promise<ImportSource[]> => {
    importPlaces(ctx.e2e)
    return []
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

  commands.register('import.start', ({ plan }, c) => {
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
    const run = commands.run as unknown as (n: string, a: unknown, cc: CallContext) => Promise<unknown>
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
