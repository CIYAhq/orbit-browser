import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type NativeImage, nativeImage, type WebContents } from 'electron'
import { fileKind, isMedia, type LibraryFile, showsInline } from '../../shared/commands/downloads'
import type { ProfileId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import type { FileActions } from './files'
import type { DownloadManager } from './manager'
import { listScreenshots, type Screenshot, type ScreenshotFolder } from './screenshots'
import type { DownloadRecord } from './store'

export const isScreenshotId = (id: string): boolean => id.startsWith('shot-')

export interface DownloadsLibraryOptions {
  files: FileActions
  /** Where the OS saves screenshots (DL-05, DL-11). */
  screenshotFolders: () => Promise<ScreenshotFolder[]>
  /** Starts the OS's drag of a file from a page of Orbit's UI (DL-06). */
  startDrag: (sender: WebContents, path: string) => void
  /** The main window to show something in, for a window (a Mini Window's is a main window). */
  mainWindow: (windowId: WindowId | undefined) => WindowId | undefined
  notify: (windowId: WindowId | undefined, message: string) => void
}

/**
 * The downloads in the Library and around it: the Media section's files (DL-11), the Library
 * button's recent files (DL-05), previews from the Library (DL-09, DL-10) and dragging files out
 * (DL-06). Screenshots are files of the OS: their ids (`shot-…`) stand for the paths found last.
 */
export class DownloadsLibrary {
  private shots = new Map<string, Screenshot>()

  constructor(
    private ctx: MainContext,
    private manager: DownloadManager,
    private opts: DownloadsLibraryOptions,
  ) {}

  /** The OS's screenshots, newest first (read now). */
  async screenshots(limit = 200): Promise<Screenshot[]> {
    const list = await listScreenshots(await this.opts.screenshotFolders(), limit)
    for (const shot of list) this.shots.set(shot.id, shot)
    return list
  }

  /** The file of a finished download or a screenshot, when it is there. */
  pathOf(id: string): string | undefined {
    if (isScreenshotId(id)) {
      const shot = this.shots.get(id)
      return shot && existsSync(shot.path) ? shot.path : undefined
    }
    return this.manager.finishedFile(id)
  }

  /**
   * The Media section (DL-11): images and videos downloaded in a profile whose files are still there,
   * and the OS's screenshots when the Library shows them, newest first.
   */
  async media(profileId: ProfileId, limit = 500): Promise<LibraryFile[]> {
    const records = this.manager
      .records(profileId)
      .filter((r) => r.state === 'completed' && !r.danger && isMedia(r.savePath))
    const files = await this.present(records)
    const shots = this.ctx.store.state.settings.libraryScreenshots ? await this.screenshots(limit) : []
    return newestFirst([...files, ...shots.map(shotFile)], limit)
  }

  /** The Library button's popover (DL-05): newest finished downloads still there, screenshots if chosen. */
  async recent(profileId: ProfileId, limit = 8): Promise<LibraryFile[]> {
    const show = this.ctx.store.state.settings.recentFiles
    const out: LibraryFile[] = []
    if (show.downloads) {
      // Newest first already: look at a few more than needed, as some files may have gone.
      const records = this.manager
        .records(profileId)
        .filter((r) => r.state === 'completed' && !r.danger)
        .slice(0, limit * 3)
      out.push(...(await this.present(records)))
    }
    if (show.screenshots) out.push(...(await this.screenshots(limit)).map(shotFile))
    return newestFirst(out, limit)
  }

  /**
   * Opens a file from the Library (DL-09, DL-10, DL-11): a file Orbit can show previews in a Peek over
   * the Library, or opens in a new tab with `tab` (or when there is no page to preview over); any
   * other file opens in its app. False when the file is gone or couldn't be opened.
   */
  async preview(id: string, tab: boolean, windowId: WindowId | undefined): Promise<boolean> {
    const path = this.pathOf(id)
    if (!path) return false
    if (!showsInline(path)) return this.openWithApp(path, windowId)
    const url = pathToFileURL(path).href
    const target = this.opts.mainWindow(windowId)
    const { commands } = this.ctx
    if (!tab && commands.has('peek.open')) {
      const peeked = await commands.run('peek.open', { url }, { windowId: target })
      if (peeked) return true
    }
    await commands.run('tabs.create', { url, activate: true }, { windowId: target })
    return true
  }

  /** Opens a screenshot (or any file of the Library) the way a download opens (DL-04). */
  async open(id: string, windowId: WindowId | undefined): Promise<boolean> {
    if (!isScreenshotId(id)) return this.manager.open(id, windowId)
    const path = this.pathOf(id)
    if (!path) return false
    if (!showsInline(path)) return this.openWithApp(path, windowId)
    await this.ctx.commands.run(
      'tabs.create',
      { url: pathToFileURL(path).href, activate: true },
      { windowId: this.opts.mainWindow(windowId) },
    )
    return true
  }

  showInFolder(id: string): boolean {
    if (!isScreenshotId(id)) return this.manager.showInFolder(id)
    const path = this.pathOf(id)
    if (!path) return false
    this.opts.files.showItemInFolder(path)
    return true
  }

  /** Starts dragging a file out of the page that asked (DL-06). False when there is none to drag. */
  drag(id: string, sender: WebContents | undefined): boolean {
    const path = this.pathOf(id)
    if (!path || !sender || sender.isDestroyed()) return false
    this.opts.startDrag(sender, path)
    return true
  }

  private async openWithApp(path: string, windowId: WindowId | undefined): Promise<boolean> {
    const error = await this.opts.files.openPath(path)
    if (!error) return true
    console.error('[downloads] cannot open a file:', error)
    this.opts.notify(windowId, `Couldn't open ${basename(path)}`)
    return false
  }

  /** The downloads whose files are still there, as Library files. */
  private async present(records: DownloadRecord[]): Promise<LibraryFile[]> {
    const found = await Promise.all(
      records.map(async (r): Promise<LibraryFile | undefined> => {
        try {
          const s = await stat(r.savePath)
          if (!s.isFile()) return undefined
          return {
            id: r.id,
            name: r.filename,
            kind: fileKind(r.filename),
            url: pathToFileURL(r.savePath).href,
            at: r.endedAt ?? r.startedAt,
            size: s.size,
            source: 'download',
          }
        } catch {
          return undefined
        }
      }),
    )
    return found.filter((f): f is LibraryFile => !!f)
  }
}

function shotFile(shot: Screenshot): LibraryFile {
  return {
    id: shot.id,
    name: shot.name,
    kind: 'image',
    url: pathToFileURL(shot.path).href,
    at: shot.at,
    size: shot.size,
    source: 'screenshot',
  }
}

function newestFirst(files: LibraryFile[], limit: number): LibraryFile[] {
  return files.sort((a, b) => b.at - a.at).slice(0, Math.max(0, limit))
}

let icon: NativeImage | undefined

/**
 * The picture under the pointer while a file is dragged out (DL-06): a plain page with a folded
 * corner, drawn once (macOS needs one; the OS shows its own badge for the file).
 */
export function dragIcon(): NativeImage {
  if (icon) return icon
  const size = 32
  const pixels = Buffer.alloc(size * size * 4)
  const set = (x: number, y: number, shade: number) => {
    const i = (y * size + x) * 4
    pixels[i] = shade
    pixels[i + 1] = shade
    pixels[i + 2] = shade
    pixels[i + 3] = 255
  }
  const left = 6
  const right = 25
  const top = 2
  const bottom = 29
  const fold = 7
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      // The folded corner (top right) is cut off; its edge is drawn.
      const inFold = x > right - fold && y < top + fold && x - (right - fold) > y - top
      if (inFold) continue
      const edge = x === left || x === right || y === top || y === bottom
      const foldEdge = x - (right - fold) === y - top && x > right - fold
      set(x, y, edge || foldEdge ? 120 : 250)
    }
  }
  icon = nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 1 })
  return icon
}
