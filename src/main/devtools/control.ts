import type { WebContents } from 'electron'
import { ACTIONS_BY_ID, parseAccelerator, shortcutsFor } from '../../shared/actions'
import type { DevtoolsState, DockSide } from '../../shared/commands/devtools'
import {
  DOCK_SIDE,
  type FrontendKey,
  type FrontendKeys,
  inFrontend,
  isDockSide,
  keyHandler,
  PICKER,
  showPanel,
} from './frontend'

/**
 * DevTools for one page (a tab, a split pane, a Peek, a Mini Window): open, close, focus, console
 * and element picker (DT-01 to DT-03). Each page has its own DevTools, docked inside its view on the
 * side last chosen in DevTools' dock menu, or undocked in a window of their own. The engine
 * remembers that side and the docked size (per profile, across restarts).
 */

export const DEVTOOLS_ACTIONS = new Set(['devtools.toggle', 'devtools.console', 'devtools.inspect'])

/** Pages whose DevTools are loading, by web contents id. */
const opening = new Map<number, Promise<WebContents | undefined>>()

/**
 * Opens a page's DevTools, docked or undocked as last chosen, and gives them the keyboard. Resolves
 * to the DevTools page once it has loaded (at once if already open); undefined if it never did.
 */
export function openDevtools(contents: WebContents): Promise<WebContents | undefined> {
  const pending = opening.get(contents.id)
  if (pending) return pending
  if (contents.isDevToolsOpened() && contents.devToolsWebContents) return Promise.resolve(contents.devToolsWebContents)
  const id = contents.id
  const loaded = new Promise<WebContents | undefined>((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      opening.delete(id)
      contents.off('devtools-opened', finish)
      contents.off('devtools-closed', finish)
      contents.off('destroyed', finish)
      const open = !contents.isDestroyed() && contents.isDevToolsOpened()
      resolve(open ? (contents.devToolsWebContents ?? undefined) : undefined)
    }
    const timer = setTimeout(finish, 10_000)
    contents.on('devtools-opened', finish)
    contents.on('devtools-closed', finish)
    contents.on('destroyed', finish)
  })
  opening.set(id, loaded)
  contents.openDevTools()
  return loaded
}

/**
 * The open key (⌥⌘I, F12; Ctrl+Shift+I): opens DevTools if closed, closes docked ones, and brings
 * undocked ones to the front, closing them if they are already in front with the keyboard (DT-01,
 * DT-03). Presses while DevTools load are ignored, so a key held down opens them once.
 */
export async function toggleDevtools(contents: WebContents): Promise<void> {
  if (opening.has(contents.id)) return
  if (!contents.isDevToolsOpened()) {
    await openDevtools(contents)
    return
  }
  const devtools = contents.devToolsWebContents
  if (!devtools) return
  const side = await dockSide(devtools)
  if (contents.isDestroyed() || !contents.isDevToolsOpened()) return
  if (side === 'undocked' && !contents.isDevToolsFocused()) devtools.focus()
  else contents.closeDevTools()
}

/** The console key (⌥⌘J; Ctrl+Shift+J): DevTools open on the Console, its prompt focused. */
export async function showConsole(contents: WebContents): Promise<void> {
  const devtools = await openDevtools(contents)
  if (!devtools) return
  await inFrontend(devtools, showPanel('console'))
  if (!devtools.isDestroyed()) devtools.focus()
}

/** The element picker (⌥⌘C): DevTools open, and the next click on the page picks an element (DT-02). */
export async function pickElement(contents: WebContents): Promise<void> {
  const devtools = await openDevtools(contents)
  if (devtools) await inFrontend(devtools, PICKER)
}

/** Runs a DevTools action on a page; false for any other action. */
export function runDevtoolsAction(id: string, contents: WebContents): boolean {
  switch (id) {
    case 'devtools.toggle':
      void toggleDevtools(contents)
      return true
    case 'devtools.console':
      void showConsole(contents)
      return true
    case 'devtools.inspect':
      void pickElement(contents)
      return true
    default:
      return false
  }
}

export async function dockSide(devtools: WebContents): Promise<DockSide | undefined> {
  const side = await inFrontend(devtools, DOCK_SIDE, 1000)
  return isDockSide(side) ? side : undefined
}

export async function devtoolsState(contents: WebContents): Promise<DevtoolsState> {
  const devtools = contents.isDevToolsOpened() && !opening.has(contents.id) ? contents.devToolsWebContents : null
  if (!devtools) return { open: false, focused: false }
  const dock = await dockSide(devtools)
  return { open: true, ...(dock ? { dock } : {}), focused: !contents.isDestroyed() && contents.isDevToolsFocused() }
}

/** Orbit's DevTools keys on this platform, for the DevTools page (see keyHandler). */
export function frontendKeys(platform: string = process.platform): FrontendKeys {
  const keys = (id: string): FrontendKey[] => {
    const action = ACTIONS_BY_ID[id]
    return action ? shortcutsFor(action, platform).map((accel) => parseAccelerator(accel)) : []
  }
  return { toggle: keys('devtools.toggle'), console: keys('devtools.console'), inspect: keys('devtools.inspect') }
}

/** Installs Orbit's keys in a page's DevTools (each time they open: every opening loads a new page). */
export function installKeys(devtools: WebContents): Promise<unknown> {
  return inFrontend(devtools, keyHandler(frontendKeys()))
}
