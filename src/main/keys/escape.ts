import { type IpcMainEvent, ipcMain, type WebContents } from 'electron'
import { PAGE_CHANNEL } from '../../shared/site'

/**
 * Esc on a loading page (KS-19, NV-04, D59). As in Chromium, the page gets Esc first, and Orbit
 * stops the load only if the page didn't use it. Electron runs no isolated-world script while a
 * main frame loads, so the page preload (src/preload/page.ts) says what the page did: one bit per
 * trusted Esc in the main frame, sent once every handler of the page has run.
 *
 * Main reads the bit only while it waits after an Esc pressed in a loading tab, at most
 * ESCAPE_WAIT_MS; no answer counts as not used (D60). A bit counts only from the main frame of a
 * tab's page (D40), and only for an Esc pressed there: one sent with no press waiting does nothing.
 */

/** How long main waits for the page's answer: KS-02's verdict wait (D59, D60). */
export const ESCAPE_WAIT_MS = 250

/** One Esc pressed while a tab loaded, as main saw it: whether the page used it, and whether the load stopped. */
export interface EscapeRecord {
  url: string
  used: boolean
  stopped: boolean
}

/** The presses still waiting for the page's answer, oldest first, by tab contents. */
const waiting = new WeakMap<WebContents, ((used: boolean) => void)[]>()

/** The last few presses, for the e2e harness. */
const log: EscapeRecord[] = []
const LOG_SIZE = 10

let listening = false

/**
 * Takes the pages' answers. `isTab` says whether a web contents is a tab's (Peek and Mini Window
 * pages are tabs too). Called once.
 */
export function listenForEscapes(isTab: (contents: WebContents) => boolean): void {
  if (listening) return
  listening = true
  ipcMain.on(PAGE_CHANNEL.escape, (event: IpcMainEvent, used: unknown) => {
    if (typeof used !== 'boolean') return
    const contents = event.sender
    const frame = event.senderFrame
    try {
      if (!frame || contents.isDestroyed() || !isTab(contents)) return
      if (frame.frameTreeNodeId !== contents.mainFrame.frameTreeNodeId) return
    } catch {
      // A frame or page that went away while the message was on its way.
      return
    }
    waiting.get(contents)?.shift()?.(used)
  })
}

/**
 * Esc was pressed in `contents` while its tab loads and no overlay is open: waits for the page's
 * answer, then calls `stop` unless the page used the key or the load ended meanwhile.
 */
export function escapeThenStop(contents: WebContents, stillLoading: () => boolean, stop: () => void): void {
  const url = contents.getURL()
  const queue = waiting.get(contents) ?? []
  waiting.set(contents, queue)
  let timer: NodeJS.Timeout | undefined
  const settle = (used: boolean) => {
    clearTimeout(timer)
    const at = queue.indexOf(settle)
    if (at >= 0) queue.splice(at, 1)
    const stopped = !used && !contents.isDestroyed() && stillLoading()
    if (stopped) stop()
    log.push({ url, used, stopped })
    if (log.length > LOG_SIZE) log.shift()
  }
  queue.push(settle)
  timer = setTimeout(() => settle(false), ESCAPE_WAIT_MS)
}

/** The last presses Orbit waited on, oldest first (e2e). */
export function escapeLog(): EscapeRecord[] {
  return log.map((r) => ({ ...r }))
}
