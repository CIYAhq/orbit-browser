import { pathToFileURL } from 'node:url'
import { dialog, type OpenDialogOptions } from 'electron'
import { ACTIONS_BY_ID, type ActionDef, BORROWED_KEYS } from '../../shared/actions'
import type { OrbitState, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import { browserWindowFor } from './browser-window'

/**
 * Open File… (KS-12): files from the disk open in new tabs of the window it was asked from, the
 * last one chosen selected. ⌘O / Ctrl+O first serve an open Peek (PK-07) and a Mini Window
 * (MW-05), whose action owns those keys; anywhere else the same keys open a file.
 */

const OPEN_FILE = 'file.open'

/**
 * The action a key press runs in the window `windowOf` names (asked only for Open Peek as Tab's
 * keys): they open a file where there is no Peek or Mini Window.
 */
export function actionInWindow(action: ActionDef, state: OrbitState, windowOf: () => WindowId | undefined): ActionDef {
  if (BORROWED_KEYS[OPEN_FILE]?.from !== action.id) return action
  const windowId = windowOf()
  const win = windowId ? state.windows[windowId] : undefined
  if (win?.kind === 'mini' || win?.overlay.kind === 'peek') return action
  return ACTIONS_BY_ID[OPEN_FILE] ?? action
}

export function registerOpenFile(ctx: MainContext): void {
  const { windows, commands, actions } = ctx
  actions.register(OPEN_FILE, async (c) => {
    const windowId = browserWindowFor(ctx, c.windowId ?? windows.focusedWindowId())
    const win = windows.get(windowId)
    // Asked from Settings, a Mini Window or a page's pop-up: the window the files open in comes forward.
    if (win && !win.isDestroyed() && !win.isFocused()) win.focus()
    const options: OpenDialogOptions = { title: 'Open File', properties: ['openFile', 'multiSelections'] }
    const { canceled, filePaths } =
      win && !win.isDestroyed() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (canceled) return
    for (const [i, path] of filePaths.entries()) {
      const url = pathToFileURL(path).href
      await commands.run('tabs.create', { url, activate: i === filePaths.length - 1 }, { windowId })
    }
  })
}
