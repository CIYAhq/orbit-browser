/**
 * The OS's screenshots (DL-05, DL-11): images in the folder the OS saves screenshots to, for the
 * Library's Media section and the Library button's popover, when the user chose to show them. The
 * folder is read only when asked, never at startup. Pure Node: unit-tested with a folder of files.
 *
 * Where the OS puts them:
 * - macOS: the folder chosen in the Screenshot app (`com.apple.screencapture location`), else the
 *   Desktop; files named like "Screenshot 2026-10-10 at 09.41.00.png".
 * - Windows: Pictures\Screenshots (Win+PrtScn, Snipping Tool).
 * - Linux: Pictures/Screenshots (GNOME 42+, KDE), and screenshots named so in Pictures.
 */
import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileKind, isMedia } from '../../shared/commands/downloads'

export interface Screenshot {
  /** `shot-` and a hash of the path: stable while the file stays. */
  id: string
  path: string
  name: string
  /** When it was taken (the file's modification time, ms). */
  at: number
  size: number
}

export interface ScreenshotFolder {
  path: string
  /** Every image in it is a screenshot (a Screenshots folder); else only files named like one. */
  all: boolean
}

/** Names the OS gives screenshots, in English and a few other common languages. */
const SCREENSHOT_NAME =
  /^(screenshot|screen shot|bildschirmfoto|capture d.écran|captura de pantalla|captura de tela|schermafbeelding|istantanea|zrzut ekranu|スクリーンショット|截屏|屏幕截图|скриншот|снимок экрана)/i

/** At most this many images are looked at per folder (the newest by name order is not known before stat). */
const MAX_CANDIDATES = 2000

/** FNV-1a, 32-bit: a short stable id for a path. */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

export const screenshotId = (path: string): string => `shot-${hash(path)}`

export function isScreenshotName(name: string): boolean {
  return SCREENSHOT_NAME.test(name)
}

/** The folders to look in, for a platform. `macLocation` is the Screenshot app's chosen folder, when set. */
export function screenshotFolders(
  platform: string,
  paths: { home: string; desktop: string; pictures: string },
  macLocation?: string,
): ScreenshotFolder[] {
  if (platform === 'darwin') return [{ path: macLocation || paths.desktop, all: false }]
  if (platform === 'win32') return [{ path: join(paths.pictures, 'Screenshots'), all: true }]
  return [
    { path: join(paths.pictures, 'Screenshots'), all: true },
    { path: paths.pictures, all: false },
  ]
}

/** The Screenshot app's folder on macOS (`defaults read com.apple.screencapture location`), if set. */
export function readMacScreenshotLocation(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('/usr/bin/defaults', ['read', 'com.apple.screencapture', 'location'], { timeout: 2000 }, (err, out) => {
      const value = String(out ?? '').trim()
      resolve(err || !value ? undefined : value.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'))
    })
  })
}

/**
 * The screenshots in some folders, newest first. Images Orbit can show only; a folder that isn't
 * there (or can't be read) has none.
 */
export async function listScreenshots(folders: ScreenshotFolder[], limit = 200): Promise<Screenshot[]> {
  const seen = new Set<string>()
  const found: Screenshot[] = []
  for (const folder of folders) {
    let names: string[]
    try {
      const entries = await readdir(folder.path, { withFileTypes: true })
      names = entries.filter((e) => e.isFile()).map((e) => e.name)
    } catch {
      continue
    }
    const candidates = names
      .filter((name) => fileKind(name) === 'image' && isMedia(name) && (folder.all || isScreenshotName(name)))
      .slice(0, MAX_CANDIDATES)
    const stats = await Promise.all(
      candidates.map(async (name) => {
        const path = join(folder.path, name)
        try {
          const s = await stat(path)
          return s.isFile() ? { path, name, at: s.mtimeMs, size: s.size } : undefined
        } catch {
          return undefined
        }
      }),
    )
    for (const s of stats) {
      if (!s || seen.has(s.path)) continue
      seen.add(s.path)
      found.push({ id: screenshotId(s.path), ...s })
    }
  }
  return found.sort((a, b) => b.at - a.at).slice(0, Math.max(0, limit))
}
