import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'
import type { MainContext } from './context'

/**
 * Links and files other apps ask Orbit to open once it is the default browser (NV-18):
 * macOS `open-url` / `open-file`, the command line of a second launch (`second-instance`)
 * and of the first launch (Linux/Windows pass the URL as an argument).
 */

/**
 * Where a link from another app goes. For now: a new Today tab in the focused window's Space
 * (the last focused main window when Orbit is in the background; a window opens if none is).
 * The mini-window lane replaces this function's body to open a Mini Window instead (MW-02).
 */
export function routeExternalUrl(ctx: MainContext, url: string): void {
  const windowId = ctx.windows.focusedWindowId() ?? ctx.windows.ids()[0] ?? ctx.windows.open()
  void ctx.commands.run('tabs.create', { url }, { windowId }).catch((err) => {
    console.error('[external-links] could not open', url, err)
  })
  const win = ctx.windows.get(windowId)
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** Files Orbit opens as pages (what the packaged app registers for, plus close relatives). */
const OPENABLE_FILE = /\.(html?|xhtml|shtml|svg|pdf)$/i

/** URLs to open from a command line: web and file URLs, and paths of existing openable files. */
export function linksFromArgv(argv: readonly string[], cwd: string): string[] {
  const links: string[] = []
  for (const arg of argv.slice(1)) {
    if (!arg || arg.startsWith('-')) continue
    if (/^(https?|file):/i.test(arg)) {
      links.push(arg)
      continue
    }
    const path = isAbsolute(arg) ? arg : resolve(cwd, arg)
    if (OPENABLE_FILE.test(path) && isFile(path)) links.push(pathToFileURL(path).href)
  }
  return links
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

let target: MainContext | undefined
const queued: string[] = []

function open(url: string): void {
  if (target) routeExternalUrl(target, url)
  else queued.push(url)
}

/**
 * Starts listening before the app is ready: macOS delivers the link that launched Orbit
 * through `open-url`/`open-file` early. Links are queued until registerExternalLinks().
 */
export function captureExternalLinks(): void {
  app.on('open-url', (event, url) => {
    event.preventDefault()
    open(url)
  })
  app.on('open-file', (event, path) => {
    event.preventDefault()
    open(pathToFileURL(path).href)
  })
  app.on('second-instance', (_event, argv, workingDirectory) => {
    const links = linksFromArgv(argv, workingDirectory)
    for (const url of links) open(url)
    if (links.length > 0 || !target) return
    // Launched again without a link: bring Orbit forward (a window opens if none is).
    const windowId = target.windows.focusedWindowId() ?? target.windows.ids()[0] ?? target.windows.open()
    const win = target.windows.get(windowId)
    if (win?.isMinimized()) win.restore()
    win?.show()
    win?.focus()
  })
}

/** Routes queued and future links once windows can open; also opens links on Orbit's own command line. */
export function registerExternalLinks(ctx: MainContext): void {
  target = ctx
  const pending = [...queued.splice(0), ...linksFromArgv(process.argv, process.cwd())]
  for (const url of pending) routeExternalUrl(ctx, url)
}
