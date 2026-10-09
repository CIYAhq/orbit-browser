import { app, type InputEvent, type WebContents, webContents } from 'electron'

/** The last click (or Enter press) in a page: when, where, on which link, with which modifiers. */
export interface PageClick {
  at: number
  /** Position in the page's view (DIP); absent for a key press. */
  x?: number
  y?: number
  /**
   * The link the page found under the click (for Enter, the focused link): its URL, null when the
   * click wasn't on a link, absent until the page answers.
   */
  href?: string | null
  /**
   * The click has opened its link (in a Peek, a tab or a Mini Window). A second navigation to that
   * link is the same click and is cancelled; nothing else counts as caused by it any more.
   */
  opened?: boolean
  shift: boolean
  alt: boolean
  /** ⌘ on macOS, the Windows/Super key elsewhere. */
  meta: boolean
  control: boolean
}

/** The isolated world Orbit's own questions to a page run in, out of reach of the page's scripts. */
export const PAGE_WORLD = 1002

/** How long after a click a navigation or new window still counts as caused by it. */
const CLICK_WINDOW_MS = 1500

type Modifiers = Pick<PageClick, 'shift' | 'alt' | 'meta' | 'control'>

const NONE: Modifiers = { shift: false, alt: false, meta: false, control: false }

/**
 * Which modifier keys are held, from the key events of every Orbit web contents (pages and UI).
 * Electron's mouse input events don't carry modifiers, so a click reads them from here.
 */
export class HeldModifiers {
  private held: Modifiers = { ...NONE }

  watch(contents: WebContents): void {
    contents.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown' && input.type !== 'keyUp') return
      const up = input.type === 'keyUp'
      this.held = {
        shift: input.key === 'Shift' ? !up : input.shift,
        alt: input.key === 'Alt' ? !up : input.alt,
        meta: input.key === 'Meta' ? !up : input.meta,
        control: input.key === 'Control' ? !up : input.control,
      }
    })
  }

  /** Focus left Orbit: key releases elsewhere never arrive. */
  reset(): void {
    this.held = { ...NONE }
  }

  get(): Modifiers {
    return this.held
  }
}

let shared: HeldModifiers | undefined

/**
 * The app's one modifier tracker, watching every web contents from the first call on. Peek and
 * Mini Window clicks (⇧, ⌘⌥) and ⌥-click split view (nav) read the same keys.
 */
export function heldModifiers(): HeldModifiers {
  if (shared) return shared
  const held = new HeldModifiers()
  shared = held
  for (const contents of webContents.getAllWebContents()) held.watch(contents)
  app.on('web-contents-created', (_event, contents) => held.watch(contents))
  // A key released while another app had focus is never seen: start over.
  app.on('browser-window-blur', () => held.reset())
  return held
}

/** The link (a or area) at a point of the page, in CSS pixels: its URL, or null. */
const linkAt = (x: number, y: number) =>
  `(() => { const a = document.elementFromPoint(${x}, ${y})?.closest('a[href], area[href]'); return a && typeof a.href === 'string' ? a.href : null })()`

/** The focused link: its URL, or null. */
const FOCUSED_LINK = `(() => { const a = document.activeElement?.closest('a[href], area[href]'); return a && typeof a.href === 'string' ? a.href : null })()`

/**
 * Remembers each page's last user click and the link it landed on, so link handling acts on a
 * click on a link and on nothing else (a form post, a script navigation, an auto-posted sign-in),
 * and sees the modifiers held (Shift, ⌘⌥).
 *
 * The link comes from two places. The engine reports the link under the pointer, or the one the
 * keyboard focused, as it changes (update-target-url): that is known before the click. The page is
 * also asked, in an isolated world, for the link under the click (or the focused one for Enter);
 * its answer is exact but often arrives after the navigation has begun (a tap, Enter, a busy page),
 * and never while the page is still loading.
 */
export class ClickTracker {
  private clicks = new Map<number, PageClick>()
  /** Each page's link under the pointer (or focused from the keyboard), as the engine shows it. */
  private targets = new Map<number, string>()

  constructor(private modifiers: HeldModifiers) {}

  watch(contents: WebContents): void {
    const id = contents.id
    contents.on('update-target-url', (_event, url) => {
      if (url) this.targets.set(id, url)
      else this.targets.delete(id)
    })
    contents.on('input-event', (_event, input) => {
      const type = input.type
      if (type === 'mouseDown') this.record(contents, fromInput(input, true, this.modifiers.get()))
      else if (type === 'mouseUp') {
        // The click itself comes with the release: its moment counts from there.
        const click = this.clicks.get(id)
        if (click) click.at = Date.now()
      } else if (type === 'rawKeyDown' || type === 'keyDown') {
        // Enter activates the focused link. Electron's input events carry key and code, not keyCode.
        if ((input as { key?: string }).key === 'Enter')
          this.record(contents, fromInput(input, false, this.modifiers.get()))
      }
    })
    contents.once('destroyed', () => {
      this.clicks.delete(id)
      this.targets.delete(id)
    })
  }

  /** The page's click from the last moment, if any, unless it has already opened its link. */
  recent(contents: WebContents, now = Date.now()): PageClick | undefined {
    const click = this.clicks.get(contents.id)
    return click && !click.opened && now - click.at <= CLICK_WINDOW_MS ? click : undefined
  }

  /**
   * The page's click from the last moment if it was on the link to `url`: the link the page found
   * under it, or the one the engine shows under the pointer or focused. A form post, a script
   * navigation or a redirect goes somewhere else, so it doesn't count.
   */
  onLink(contents: WebContents, url: string, now = Date.now()): PageClick | undefined {
    const click = this.clicks.get(contents.id)
    if (!click || now - click.at > CLICK_WINDOW_MS) return undefined
    return sameUrl(click.href, url) || sameUrl(this.targets.get(contents.id), url) ? click : undefined
  }

  /** The click has opened its link: a repeat navigation to it is cancelled, and nothing else counts. */
  markOpened(contents: WebContents): void {
    const click = this.clicks.get(contents.id)
    if (click) click.opened = true
  }

  /** Keeps the click and asks the page which link it landed on. */
  private record(contents: WebContents, click: PageClick): void {
    const id = contents.id
    this.clicks.set(id, click)
    // A loading page answers only once loaded, too late for this click (the engine's report decides).
    if (!contents.getURL() || contents.isLoadingMainFrame()) return
    const zoom = contents.getZoomFactor() || 1
    const { x, y } = click
    const code =
      x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y)
        ? linkAt(x / zoom, y / zoom)
        : FOCUSED_LINK
    contents
      .executeJavaScriptInIsolatedWorld(PAGE_WORLD, [{ code }])
      .then((href: unknown) => {
        if (this.clicks.get(id) === click) click.href = typeof href === 'string' && href ? href : null
      })
      .catch(() => {})
  }
}

/** The same URL, written the same way or not. */
function sameUrl(a: string | null | undefined, b: string): boolean {
  if (!a) return false
  if (a === b) return true
  try {
    return new URL(a).href === new URL(b).href
  } catch {
    return false
  }
}

function fromInput(input: InputEvent, mouse: boolean, held: Modifiers): PageClick {
  const mods = new Set(input.modifiers ?? [])
  const pos = input as { x?: number; y?: number }
  return {
    at: Date.now(),
    x: mouse && typeof pos.x === 'number' ? pos.x : undefined,
    y: mouse && typeof pos.y === 'number' ? pos.y : undefined,
    shift: held.shift || mods.has('shift'),
    alt: held.alt || mods.has('alt'),
    meta: held.meta || mods.has('meta') || mods.has('command') || mods.has('cmd'),
    control: held.control || mods.has('control') || mods.has('ctrl'),
  }
}

/** ⌘⌥-click on macOS, Ctrl+Alt-click elsewhere: open in a Mini Window (MW-07). */
export function isMiniClick(click: PageClick | undefined, platform = process.platform): boolean {
  if (!click?.alt) return false
  return platform === 'darwin' ? click.meta : click.control
}
