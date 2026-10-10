import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'
import type { MainContext } from './context'
import { routeExternalLink } from './miniwindow'
import { miniSwitchIn } from './miniwindow/switches'
import { focusOnboarding } from './settings/onboarding'

/**
 * Links and files other apps ask Orbit to open once it is the default browser (NV-18):
 * macOS `open-url` / `open-file`, the command line of a second launch (`second-instance`)
 * and of the first launch (Linux/Windows pass the URL as an argument).
 */

/**
 * Where a link from another app goes: a Mini Window by default, a routing rule's Space, or with
 * Mini Windows off a tab in the most recent (or chosen) Space (MW-02, MW-11, NV-18).
 */
export function routeExternalUrl(ctx: MainContext, url: string): void {
  routeExternalLink(ctx, url)
}

/** Files Orbit opens as pages (what the packaged app registers for, plus close relatives). */
const OPENABLE_FILE = /\.(html?|xhtml|shtml|svg|pdf)$/i

/** The command line switch that opens a private window (Windows taskbar task, NV-11), with the launch's links in it. */
export const PRIVATE_WINDOW_SWITCH = '--private-window'

/** True when a command line asks for a private window (Chromium may reorder arguments). */
export function privateSwitchIn(argv: readonly string[]): boolean {
  return argv.some((a) => a.toLowerCase() === PRIVATE_WINDOW_SWITCH)
}

/**
 * URLs to open from a command line as links from another app (NV-18): none when it asks for a
 * private window, which opens them itself (nav/private.ts; review B-F6).
 */
export function linksFromArgv(argv: readonly string[], cwd: string): string[] {
  return privateSwitchIn(argv) ? [] : urlsInArgv(argv, cwd)
}

/** The URLs on a command line: web and file URLs, and paths of existing openable files. */
export function urlsInArgv(argv: readonly string[], cwd: string): string[] {
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
    // A jump-list launch acts on Mini Windows only (the Mini Window module handles it, MW-14), and
    // one for a private window opens that window (nav/private.ts, NV-11).
    if (links.length > 0 || !target || miniSwitchIn(argv) || privateSwitchIn(argv)) return
    // Onboarding is open (a first run, or Reset Onboarding): it comes forward, and it opens the
    // first browser window itself when done (OB-01).
    if (focusOnboarding()) return
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
