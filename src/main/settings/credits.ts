import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rendererEntry } from '../windows'

/**
 * Chromium's licences and those of the projects it uses, which Electron ships as
 * LICENSES.chromium.html: beside the program on Windows and Linux and in development, in Resources
 * on a Mac (electron-builder.yml puts it there, as electron-builder drops Electron's copy).
 */
export function chromiumLicences(): string | undefined {
  const exe = process.execPath
  return [
    join(process.resourcesPath, 'LICENSES.chromium.html'),
    join(dirname(exe), 'LICENSES.chromium.html'),
    // Development on a Mac: node_modules/electron/dist/Electron.app/Contents/MacOS/Electron.
    resolve(exe, '../../../../LICENSES.chromium.html'),
  ].find((file) => existsSync(file))
}

/**
 * The open-source credits page that comes with Orbit (ST-17, UP-07, D43), built with the renderer
 * (scripts/credits.ts); `#orbit` is Orbit's licence. It links to Chromium's licences where they are.
 * The development server serves it too, but a page from there can't open a file link.
 */
export function creditsUrl(at?: 'orbit'): string {
  const entry = rendererEntry()
  const url = entry.url ? new URL('/credits.html', entry.url) : pathToFileURL(join(dirname(entry.file), 'credits.html'))
  const chromium = chromiumLicences()
  if (chromium) url.searchParams.set('chromium', pathToFileURL(chromium).href)
  if (at) url.hash = at
  return url.href
}
