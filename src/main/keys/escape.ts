import { type IpcMainEvent, ipcMain, type WebContents } from 'electron'
import { PAGE_CHANNEL } from '../../shared/site'

/**
 * Esc on a loading page (KS-19, NV-04, D59). As in Chromium, the page gets Esc first, and Orbit
 * stops the load only if the page didn't use it. Electron runs no isolated-world script while a
 * main frame loads, so the page preload (src/preload/page.ts) says what the page did: one bit per
 * trusted Esc in the main frame, sent once every handler of the page has run.
 *
 * Main reads the bit only while it waits after an Esc pressed in a loading tab, or a first Esc in
 * window full screen that went to the page (KS-02's toast, NV-20), at most ESCAPE_WAIT_MS; no answer
 * counts as not used (D60). A bit counts only from the main frame of a tab's page (D40), and only for
 * an Esc pressed there: one sent with no press waiting does nothing. One bit answers one press, for
 * every caller that waits on it.
 */

/** How long main waits for the page's answer: KS-02's verdict wait (D59, D60). */
export const ESCAPE_WAIT_MS = 250

/** One Esc pressed while a tab loaded, as main saw it: whether the page used it, and whether the load stopped. */
export interface EscapeRecord {
  url: string
  used: boolean
  stopped: boolean
}

/** One Esc waiting for the page's answer, and what each caller does with it. */
interface Press {
  contents: WebContents
  callbacks: ((used: boolean) => void)[]
  settle: (used: boolean) => void
}

/** The presses still waiting for the page's answer, oldest first, by tab contents. */
const waiting = new WeakMap<WebContents, Press[]>()
/** Each press by its key's `before-input-event` input: one object for every listener of that event. */
const pressFor = new WeakMap<object, Press>()

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
    waiting.get(contents)?.[0]?.settle(used)
  })
}

/**
 * Calls `answered` with whether the page used the Esc pressed in `contents` (a tab's), once the
 * page says so or after ESCAPE_WAIT_MS (not used). `input` is that press's `before-input-event`
 * input, the one object every listener of the event gets: callers that pass the same one wait on
 * the same press, so the page's one bit answers each of them.
 */
export function whenEscapeAnswered(
  contents: WebContents,
  input: object | undefined,
  answered: (used: boolean) => void,
): void {
  const queue = waiting.get(contents) ?? []
  waiting.set(contents, queue)
  const joined = input && pressFor.get(input)
  if (joined && joined.contents === contents && queue.includes(joined)) {
    joined.callbacks.push(answered)
    return
  }
  let timer: NodeJS.Timeout | undefined
  const press: Press = {
    contents,
    callbacks: [answered],
    settle: (used) => {
      clearTimeout(timer)
      const at = queue.indexOf(press)
      if (at < 0) return
      queue.splice(at, 1)
      for (const callback of press.callbacks) callback(used)
    },
  }
  queue.push(press)
  if (input) pressFor.set(input, press)
  timer = setTimeout(() => press.settle(false), ESCAPE_WAIT_MS)
}

/**
 * Esc was pressed in `contents` while its tab loads and no overlay is open: waits for the page's
 * answer, then calls `stop` unless the page used the key or the load ended meanwhile. `input`, the
 * press's, shares the wait with another caller for the same press (full screen's, KS-02).
 */
export function escapeThenStop(
  contents: WebContents,
  stillLoading: () => boolean,
  stop: () => void,
  input?: object,
): void {
  const url = contents.getURL()
  whenEscapeAnswered(contents, input, (used) => {
    const stopped = !used && !contents.isDestroyed() && stillLoading()
    if (stopped) stop()
    log.push({ url, used, stopped })
    if (log.length > LOG_SIZE) log.shift()
  })
}

/** The last presses Orbit waited on, oldest first (e2e). */
export function escapeLog(): EscapeRecord[] {
  return log.map((r) => ({ ...r }))
}
