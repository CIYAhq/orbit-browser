import type { WebContents, WebFrameMain } from 'electron'
import { ANSWER_WAIT_MS, EDITABLE, type PageVerdict, pageVerdict, signature } from './page-keys'

/**
 * Where the keyboard is in a tab's page, known in main before a key arrives (KS-16, D60), so Back
 * and Forward can run at once outside text fields without asking a page that may be busy, and a
 * press with focus in a frame is judged by that frame.
 *
 * Each frame watched says, in its own world, where the keyboard is in it, and says it again when
 * that changes: a script that answers when focus moves (`FOCUS`), sent again after each answer.
 * The page's main frame is watched for as long as its document lives. The frame inside it that has
 * the keyboard (`contents.focusedFrame`) is followed too, and also notes the presses Orbit may ask
 * about, since the main frame's watcher (page-keys.ts) never sees keys pressed in a frame.
 *
 * What a frame says about itself is that page's word: a page that says the wrong thing only
 * changes what its own keys do. Answers are checked before they are used.
 */

/**
 * Where the keyboard is in one frame:
 * - 'field': on one of its text fields;
 * - 'page': elsewhere in it;
 * - 'frame': in a frame inside it;
 * - 'away': not in it.
 */
export type FrameWhere = 'field' | 'page' | 'frame' | 'away'

const WHERE: ReadonlySet<string> = new Set<FrameWhere>(['field', 'page', 'frame', 'away'])

/** A key press a followed frame noted: as the main frame's watcher notes them (page-keys.ts). */
interface KeyRecord {
  sig: string
  at: number
  inField: boolean
  prevented: boolean
}

/**
 * The script a watched frame runs: answers `{ where }` once where the keyboard is differs from
 * `known` or focus moves, and, with `keys`, `{ where, key }` once a key Orbit may ask about has
 * been through every handler of the frame (keys with ⌘, Ctrl or Alt, and F1–F24). Leaves nothing
 * behind in the page.
 */
const FOCUS = (known: FrameWhere | null, keys: boolean) => `new Promise((resolve) => {
  const editable = ${EDITABLE}
  const where = () => {
    if (!document.hasFocus()) return 'away'
    const el = document.activeElement
    if (el && /^(IFRAME|FRAME|OBJECT|EMBED|FENCEDFRAME)$/.test(el.tagName)) return 'frame'
    return editable(el) ? 'field' : 'page'
  }
  const FOCUS_EVENTS = ['focusin', 'focusout', 'focus', 'blur']
  let done = false
  const finish = (answer) => {
    if (done) return
    done = true
    for (const type of FOCUS_EVENTS) removeEventListener(type, moved, true)
    removeEventListener('keydown', pressed, true)
    resolve(answer)
  }
  const moved = () => setTimeout(() => finish({ where: where() }), 0)
  const pressed = (e) => {
    if (!e.isTrusted || ['Control', 'Meta', 'Alt', 'Shift', 'AltGraph'].includes(e.key)) return
    if (!e.metaKey && !e.ctrlKey && !e.altKey && !/^F\\d{1,2}$/.test(e.key)) return
    const key = {
      sig: [e.metaKey, e.ctrlKey, e.altKey, e.shiftKey, e.code].join(','),
      at: Date.now(),
      inField: editable(document.activeElement),
    }
    // After the whole dispatch: the frame's handlers have all had the event.
    setTimeout(() => finish({ where: where(), key: { ...key, prevented: e.defaultPrevented } }), 0)
  }
  for (const type of FOCUS_EVENTS) addEventListener(type, moved, true)
  if (${keys}) addEventListener('keydown', pressed, true)
  if (where() !== ${JSON.stringify(known)}) finish({ where: where() })
})`

/** A frame's answer, if it is one. */
function readAnswer(value: unknown): { where: FrameWhere; key?: KeyRecord } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { where, key } = value as { where?: unknown; key?: unknown }
  if (typeof where !== 'string' || !WHERE.has(where)) return undefined
  if (key === undefined) return { where: where as FrameWhere }
  if (!key || typeof key !== 'object') return undefined
  const { sig, at, inField, prevented } = key as Record<string, unknown>
  if (typeof sig !== 'string' || sig.length > 64 || typeof at !== 'number' || !Number.isFinite(at)) return undefined
  if (typeof inField !== 'boolean' || typeof prevented !== 'boolean') return undefined
  return { where: where as FrameWhere, key: { sig, at, inField, prevented } }
}

/** Reads a frame's property; undefined once the frame is gone. */
function read<T>(get: () => T): T | undefined {
  try {
    return get()
  } catch {
    return undefined
  }
}

const sameFrame = (a: WebFrameMain, b: WebFrameMain): boolean =>
  a === b ||
  read(() => a.frameTreeNodeId === b.frameTreeNodeId && a.processId === b.processId && a.routingId === b.routingId) ===
    true

/** One watched frame. */
interface Watch {
  frame: WebFrameMain
  /** What it said last; undefined until it answers. */
  where: FrameWhere | undefined
  /** Whether it notes key presses (a followed frame inside the page). */
  keys: boolean
  /** Its last key presses, oldest first. */
  records: KeyRecord[]
  /** Verdicts waiting for a press to show up in `records`. */
  wake: Set<() => void>
  /** When it answered lately: a frame that keeps answering is asked less often. */
  answers: number[]
}

/** Where the keyboard is in a page now, and how to learn what the page did with a press there. */
export interface FocusNow {
  /** The frame with the keyboard. */
  frame: WebFrameMain
  /** Whether that is a frame inside the page rather than the page itself. */
  inFrame: boolean
  /** Where in it, as far as Orbit knows. */
  where: FrameWhere | undefined
  /** What that frame did with the press `input`, pressed at `pressedAt` (main's clock). */
  verdict(input: Electron.Input, pressedAt: number): Promise<PageVerdict>
}

/** Answers this many times a second, at most, before a frame is asked again only after a pause. */
const ANSWERS_PER_SECOND = 30
const PAUSE_MS = 200

class PageFocus {
  private main: Watch | undefined
  private child: Watch | undefined
  private retry: NodeJS.Timeout | undefined

  constructor(private readonly contents: WebContents) {}

  /** Watches the main frame's document: each time one commits. */
  start(): void {
    const frame = this.frameOf(() => this.contents.mainFrame)
    this.child = undefined
    this.main = frame ? this.watch(frame, false) : undefined
  }

  stop(): void {
    this.main = undefined
    this.child = undefined
    clearTimeout(this.retry)
  }

  /** A frame inside the page loaded a new document: the followed one is watched again in it. */
  frameNavigated(processId: number, routingId: number): void {
    const child = this.child
    if (!child || read(() => child.frame.processId === processId && child.frame.routingId === routingId) !== true)
      return
    this.child = this.watch(child.frame, true)
  }

  /** Follows the frame inside the page that has the keyboard, if one does. */
  sync(): void {
    const main = this.main
    const focused = this.frameOf(() => this.contents.focusedFrame)
    if (!main || !focused || sameFrame(focused, main.frame)) {
      this.child = undefined
      return
    }
    if (this.child && sameFrame(this.child.frame, focused)) return
    this.child = this.watch(focused, true)
  }

  now(): FocusNow | undefined {
    this.sync()
    const child = this.child
    if (child) {
      return {
        frame: child.frame,
        inFrame: true,
        where: child.where,
        verdict: (input, pressedAt) => this.frameVerdict(child, input, pressedAt),
      }
    }
    const main = this.main
    if (!main) return undefined
    return {
      frame: main.frame,
      inFrame: false,
      where: main.where,
      verdict: (input, pressedAt) => pageVerdict(this.contents, input, pressedAt),
    }
  }

  private frameOf(get: () => WebFrameMain | null): WebFrameMain | undefined {
    if (this.contents.isDestroyed()) return undefined
    return read(get) ?? undefined
  }

  private watch(frame: WebFrameMain, keys: boolean): Watch {
    const watch: Watch = { frame, where: undefined, keys, records: [], wake: new Set(), answers: [] }
    this.ask(watch)
    return watch
  }

  private current(watch: Watch): boolean {
    return watch === this.main || watch === this.child
  }

  private ask(watch: Watch): void {
    let asked: Promise<unknown>
    try {
      asked = watch.frame.executeJavaScript(FOCUS(watch.where ?? null, watch.keys))
    } catch {
      return
    }
    asked.then(
      (value) => {
        if (!this.current(watch)) return
        const answer = readAnswer(value)
        // A frame that answers something else isn't asked again; its next document is.
        if (!answer) return
        watch.where = answer.where
        if (answer.key) {
          watch.records.push(answer.key)
          if (watch.records.length > 16) watch.records.shift()
          for (const wake of [...watch.wake]) wake()
        }
        const now = Date.now()
        watch.answers = watch.answers.filter((t) => now - t < 1000)
        watch.answers.push(now)
        if (watch.answers.length > ANSWERS_PER_SECOND) {
          setTimeout(() => {
            if (this.current(watch)) this.ask(watch)
          }, PAUSE_MS)
        } else {
          this.ask(watch)
        }
        if (watch === this.main) this.follow(answer.where)
      },
      // The frame's document went away: the next one is watched when it commits.
      () => {},
    )
  }

  /**
   * The main frame says the keyboard went into a frame inside it: follows that frame. Chromium may
   * say which frame has focus a moment after the page does, so this looks again a few times.
   */
  private follow(where: FrameWhere, tries = 5): void {
    clearTimeout(this.retry)
    this.sync()
    if (where !== 'frame' || this.child || tries <= 0) return
    this.retry = setTimeout(() => {
      if (this.main?.where === 'frame') this.follow('frame', tries - 1)
    }, 20)
  }

  /** What a followed frame did with a press: from what it noted, waiting for it at most ANSWER_WAIT_MS. */
  private frameVerdict(watch: Watch, input: Electron.Input, pressedAt: number): Promise<PageVerdict> {
    const sig = signature(input)
    const since = pressedAt - 10
    const find = () => watch.records.find((r) => r.sig === sig && r.at >= since)
    const verdict = (r: KeyRecord): PageVerdict => ({ seen: true, prevented: r.prevented, inField: r.inField })
    const found = find()
    if (found) return Promise.resolve(verdict(found))
    return new Promise((resolve) => {
      const done = (answer: PageVerdict) => {
        clearTimeout(timer)
        watch.wake.delete(wake)
        resolve(answer)
      }
      const wake = () => {
        const r = find()
        if (r) done(verdict(r))
      }
      // No answer: the frame left the key alone (D60).
      const timer = setTimeout(() => done(undefined), ANSWER_WAIT_MS)
      watch.wake.add(wake)
    })
  }
}

const watched = new WeakMap<WebContents, PageFocus>()

/** Watches where the keyboard is in a tab's page, from its first document on (KS-16, D60). */
export function watchPageFocus(contents: WebContents): void {
  if (watched.has(contents)) return
  const focus = new PageFocus(contents)
  watched.set(contents, focus)
  contents.on('did-navigate', () => focus.start())
  contents.on('did-frame-navigate', (_event, _url, _code, _status, isMainFrame, processId, routingId) => {
    if (!isMainFrame) focus.frameNavigated(processId, routingId)
  })
  // A key typed into a frame the page moved the keyboard to, which the page doesn't say.
  contents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown') focus.sync()
  })
  contents.once('destroyed', () => focus.stop())
  focus.start()
}

/** Where the keyboard is in a tab's page now; undefined for a page Orbit doesn't watch. */
export function pageFocus(contents: WebContents): FocusNow | undefined {
  if (contents.isDestroyed()) return undefined
  return watched.get(contents)?.now()
}
