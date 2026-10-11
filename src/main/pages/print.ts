import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, type IpcMainEvent, ipcMain, type WebContents } from 'electron'
import {
  cleanSettings,
  countPdfPages,
  DEFAULT_PRINT_SETTINGS,
  LAYOUT_SETTINGS,
  type PrintContent,
  type PrintDestination,
  type PrintPreview,
  type PrintSettings,
  pagesProblem,
  pdfFileName,
  pdfRanges,
  printerRanges,
  printersFromJson,
  SAVE_AS_PDF,
} from '../../shared/print'
import type { Rect } from '../../shared/rpc'
import { PAGE_CHANNEL } from '../../shared/site'
import type { TabId } from '../../shared/state'
import type { MainContext } from '../context'
import { withDialog } from '../media/dialog-watch'
import { createCovers, type HostKind } from './covers'
import { setPageEntries } from './entry'

/** How long the preview waits for the page to print; a page that hangs gets no preview. */
const PREVIEW_TIMEOUT_MS = 15_000
/** How long a page still loading gets to finish before its preview is made (Chromium prints once it has loaded). */
const LOAD_WAIT_MS = 5_000

/** A print job, as it leaves Orbit. */
export type PrintJob =
  | { kind: 'printer'; options: Electron.WebContentsPrintOptions }
  | { kind: 'pdf'; data: Buffer; name: string }

/**
 * Sends a job out of Orbit: to a printer, or a PDF to a file the user picks. The one place Orbit
 * prints (NV-07); test runs record each job instead, so none ever prints or asks where to save.
 * Resolves `ok: false` when nothing went out: with a reason when it failed, without when the user
 * cancelled.
 */
export type DeliverPrint = (page: WebContents, job: PrintJob) => Promise<{ ok: boolean; reason?: string }>

/** The printers a page can print on. */
export type ListPrinters = (page: WebContents) => Promise<PrintDestination[]>

/** The real delivery: Electron's `print` without its own dialog, or the PDF saved where the user says. */
export const deliverPrint: DeliverPrint = async (page, job) => {
  if (job.kind === 'printer') {
    return new Promise((resolve) =>
      page.print({ ...job.options, silent: true }, (ok, reason) => resolve(ok ? { ok } : { ok, reason })),
    )
  }
  const options = {
    defaultPath: join(app.getPath('downloads'), job.name),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  }
  const win = BrowserWindow.fromWebContents(page)
  // The picture-in-picture player keeps clear of it (MD-06).
  const { canceled, filePath } = await (win
    ? withDialog(win, dialog.showSaveDialog(win, options))
    : dialog.showSaveDialog(options))
  if (canceled || !filePath) return { ok: false }
  await writeFile(filePath, job.data)
  return { ok: true }
}

/** The OS's printers. */
export const systemPrinters: ListPrinters = async (page) =>
  (await page.getPrintersAsync()).map((p) => ({ id: p.name, name: p.displayName || p.name }))

/** Test runs: the printers named in ORBIT_E2E_PRINTERS (JSON: `[{ id, name }]`), else none. */
export function testPrinters(json: string | undefined): ListPrinters {
  const list = printersFromJson(json)
  return async () => list
}

/** A print dialog as tests see it. */
export interface PrintInfo {
  dialog: number
  tabId: TabId | null
  host: HostKind | null
  onScreen: boolean
  focused: boolean
  bounds?: Rect
  preview: PrintPreview['state']
  /** The pages of the preview, once it's ready. */
  pages: number | null
  settings: PrintSettings
  destinations: string[]
  busy: boolean
  error: string | null
}

/** A job a test run's delivery recorded: what a printer would get, or the PDF's name and size. */
export interface PrintRecord {
  kind: PrintJob['kind']
  url: string
  options?: Electron.WebContentsPrintOptions
  name?: string
  bytes?: number
  pages?: number
}

export interface Print$ {
  open(page: WebContents): void
  info(): PrintInfo[]
}

interface Session {
  page: WebContents
  dialog: number
  /** The content id the view last got this dialog's state under. */
  contentId: number
  settings: PrintSettings
  destinations: PrintDestination[]
  preview: PrintPreview
  /** Bumps with each preview asked for: an older one that comes late is dropped. */
  generation: number
  busy: boolean
  error?: string
  off: () => void
}

/**
 * Print (NV-07): Orbit's print dialog over a page, as Chromium's print preview is (Electron has
 * none, and its `print` opens the system's dialog instead). ⌘P / Ctrl+P, File → Print, the command
 * bar, the page menu and the page's own `window.print()` open it; Esc closes it and leaves the page
 * as it was. It shows the page as it prints (the engine's PDF of it, in the PDF viewer) with the
 * destination (the OS's printers, Save as PDF), pages, copies, layout, colour, headers and footers
 * and background graphics, and remembers the last choices until Orbit quits. Like a page's dialog
 * (NV-24), it covers that page only, waits while the page is off screen, takes the keyboard while
 * it shows (KS-19) and gives it back to the page when it closes (KS-16).
 */
export function registerPrint(ctx: MainContext, deps: { deliver: DeliverPrint; printers: ListPrinters }): Print$ {
  const { commands, tabs } = ctx
  const sessions = new Map<number, Session>()
  let nextId = 1
  /** The last dialog's choices: the next one starts from them (Chromium keeps them across runs). */
  let last: PrintSettings = DEFAULT_PRINT_SETTINGS

  const contentOf = (s: Session): PrintContent => ({
    id: s.contentId,
    dialog: s.dialog,
    title: s.page.isDestroyed() ? '' : s.page.getTitle(),
    settings: s.settings,
    destinations: s.destinations,
    preview: s.preview,
    busy: s.busy,
    ...(s.error ? { error: s.error } : {}),
  })

  const covers = createCovers<PrintContent>(ctx, {
    view: 'print',
    content: (page) => {
      const s = sessions.get(page.id)
      return s ? contentOf(s) : undefined
    },
    // Esc closes the dialog wherever its keyboard is, the preview included (KS-19).
    onKey: (page, _view, event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'Escape') return
      if (input.meta || input.control || input.alt || input.shift) return
      event.preventDefault()
      close(page)
    },
  })

  const current = (s: Session) => !s.page.isDestroyed() && sessions.get(s.page.id) === s
  const changed = (s: Session) => {
    if (!current(s)) return
    s.contentId = nextId++
    covers.update(s.page)
  }

  const close = (page: WebContents) => {
    const s = sessions.get(page.id)
    if (!s) return
    sessions.delete(page.id)
    s.off()
    // The view goes, and the page gets the keyboard back (KS-16).
    covers.update(page)
    // A close or a navigation the page started after its `print()` goes on now (the page preload).
    if (!page.isDestroyed()) page.send(PAGE_CHANNEL.printClosed)
  }

  const preview = async (s: Session) => {
    const generation = ++s.generation
    if (s.preview.state !== 'loading') {
      s.preview = { state: 'loading' }
      changed(s)
    }
    const { page } = s
    // A page that prints while it loads prints once it has (as Chromium's does).
    if (page.isLoading()) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          if (!page.isDestroyed()) page.off('did-stop-loading', done)
          resolve()
        }
        const timer = setTimeout(done, LOAD_WAIT_MS)
        page.once('did-stop-loading', done)
      })
    }
    if (!current(s) || s.generation !== generation) return
    let next: PrintPreview
    try {
      const pdf = await withTimeout(page.printToPDF(pdfOptions(s.settings)), PREVIEW_TIMEOUT_MS)
      next = { state: 'ready', version: generation, pages: countPdfPages(pdf.toString('latin1')), pdf }
    } catch (err) {
      if (current(s)) console.error('[pages] print preview', err)
      next = { state: 'error', message: 'This page can’t be previewed.' }
    }
    if (!current(s) || s.generation !== generation) return
    s.preview = next
    changed(s)
  }

  const open = (page: WebContents) => {
    if (page.isDestroyed() || !covers.hostable(page)) return
    // Asked again (⌘P, `window.print()`): the dialog it has stays as it is.
    if (sessions.has(page.id)) {
      covers.update(page)
      return
    }
    const onNavigate = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      // The page going elsewhere takes its dialog with it.
      if (details.isMainFrame && !details.isSameDocument) close(page)
    }
    const onGone = () => close(page)
    page.on('did-start-navigation', onNavigate)
    page.on('render-process-gone', onGone)
    page.once('destroyed', onGone)
    const s: Session = {
      page,
      dialog: nextId++,
      contentId: nextId++,
      settings: { ...last, allPages: true, ranges: '', copies: 1 },
      destinations: [{ id: SAVE_AS_PDF, name: 'Save as PDF' }],
      preview: { state: 'loading' },
      generation: 0,
      busy: false,
      off: () => {
        if (page.isDestroyed()) return
        page.off('did-start-navigation', onNavigate)
        page.off('render-process-gone', onGone)
        page.off('destroyed', onGone)
      },
    }
    sessions.set(page.id, s)
    covers.update(page)
    void preview(s)
    void deps.printers(page).then(
      (printers) => {
        if (!current(s)) return
        s.destinations = [{ id: SAVE_AS_PDF, name: 'Save as PDF' }, ...printers]
        // The printer used last, if it's still there; else the PDF.
        if (!s.destinations.some((d) => d.id === s.settings.destination)) {
          s.settings = { ...s.settings, destination: SAVE_AS_PDF }
        }
        changed(s)
      },
      () => {},
    )
  }

  /** Prints (or saves) with the dialog's settings; the dialog closes once it has. */
  const send = async (s: Session) => {
    const { page, settings } = s
    if (s.busy || s.preview.state !== 'ready' || pagesProblem(settings, s.preview.pages)) return
    const total = s.preview.pages
    s.busy = true
    s.error = undefined
    changed(s)
    let result: { ok: boolean; reason?: string }
    try {
      if (settings.destination === SAVE_AS_PDF) {
        const data = await withTimeout(
          page.printToPDF({ ...pdfOptions(settings), pageRanges: pdfRanges(settings, total) }),
          PREVIEW_TIMEOUT_MS,
        )
        result = current(s)
          ? await deps.deliver(page, { kind: 'pdf', data, name: pdfFileName(page.getTitle()) })
          : { ok: false }
      } else {
        result = await deps.deliver(page, { kind: 'printer', options: printerOptions(page, settings, total) })
      }
    } catch (err) {
      console.error('[pages] print', err)
      result = { ok: false, reason: 'Something went wrong' }
    }
    if (!current(s)) return
    s.busy = false
    if (result.ok) {
      last = { ...settings }
      close(page)
      return
    }
    // Cancelled (where to save): the dialog stays as it was.
    if (result.reason) s.error = `Couldn’t print: ${result.reason}`
    changed(s)
  }

  const sessionOf = (sender: WebContents | undefined, dialogId: unknown): Session | undefined => {
    const page = sender ? covers.shownBy(sender)?.page : undefined
    const s = page ? sessions.get(page.id) : undefined
    return s && s.dialog === dialogId ? s : undefined
  }

  commands.register('pages.printContent', (_args, c) => {
    const shown = c.sender ? covers.shownBy(c.sender) : undefined
    return shown?.content ?? null
  })
  commands.register('pages.printChange', ({ dialog, settings }, c) => {
    const s = sessionOf(c.sender, dialog)
    if (!s || s.busy) return
    const was = s.settings
    s.settings = cleanSettings(settings ?? {}, was, s.destinations)
    s.error = undefined
    if (LAYOUT_SETTINGS.some((key) => s.settings[key] !== was[key])) void preview(s)
    changed(s)
  })
  commands.register('pages.printAnswer', ({ dialog, ok }, c) => {
    const s = sessionOf(c.sender, dialog)
    if (!s) return
    if (ok === true) void send(s)
    else if (!s.busy) close(s.page)
  })

  // The page's own `window.print()` (the page preload): only a page's main frame has it (D40). The
  // reply says whether the page has a print dialog open now: its close and navigations wait for it.
  // The reply goes out as soon as returnValue is set, so it is set once.
  ipcMain.on(PAGE_CHANNEL.print, (event: IpcMainEvent) => {
    let opened = false
    try {
      const frame = event.senderFrame
      if (frame && !frame.parent && !event.sender.isDestroyed()) {
        open(event.sender)
        opened = sessions.has(event.sender.id)
      }
    } catch (err) {
      console.error('[pages] print', err)
    }
    event.returnValue = opened
  })

  setPageEntries({ print: open })

  return {
    open,
    info: () =>
      [...sessions.values()].map((s) => {
        const cover = covers.info(s.page)
        return {
          dialog: s.dialog,
          tabId: tabs.tabIdFor(s.page) ?? null,
          host: cover.host,
          onScreen: cover.onScreen,
          focused: cover.focused,
          ...(cover.bounds ? { bounds: cover.bounds } : {}),
          preview: s.preview.state,
          pages: s.preview.state === 'ready' ? s.preview.pages : null,
          settings: s.settings,
          destinations: s.destinations.map((d) => d.id),
          busy: s.busy,
          error: s.error ?? null,
        }
      }),
  }
}

/** The PDF the preview shows, and Save as PDF saves: the whole page, laid out as it prints. */
function pdfOptions(settings: PrintSettings): Electron.PrintToPDFOptions {
  return {
    landscape: settings.landscape,
    displayHeaderFooter: settings.headerFooter,
    printBackground: settings.background,
    pageSize: paperSize(),
  }
}

/** What a printer gets: the headers and footers name the page's title and address, as the preview does. */
function printerOptions(page: WebContents, settings: PrintSettings, total: number): Electron.WebContentsPrintOptions {
  const ranges = printerRanges(settings, total)
  return {
    deviceName: settings.destination,
    copies: settings.copies,
    landscape: settings.landscape,
    color: settings.color,
    printBackground: settings.background,
    ...(ranges ? { pageRanges: ranges } : {}),
    ...(settings.headerFooter ? { header: page.getTitle(), footer: page.getURL() } : {}),
  }
}

/** Letter where the system's region uses it (the Americas' Letter countries), else A4 (as Chromium's PDF). */
function paperSize(): 'Letter' | 'A4' {
  const region = app.getLocaleCountryCode().toUpperCase()
  return ['US', 'CA', 'MX', 'PR', 'PH', 'CL', 'CO', 'VE', 'GT', 'CR', 'PA', 'DO', 'SV', 'NI', 'BO'].includes(region)
    ? 'Letter'
    : 'A4'
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}
