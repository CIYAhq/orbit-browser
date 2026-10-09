import type { InputEvent, WebContents } from 'electron'

/** The last click (or Enter/Space key press) in a page: when, where and with which modifiers. */
export interface PageClick {
  at: number
  /** Position in the page's view (DIP); absent for a key press. */
  x?: number
  y?: number
  shift: boolean
  alt: boolean
  /** ⌘ on macOS, the Windows/Super key elsewhere. */
  meta: boolean
  control: boolean
}

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

/**
 * Remembers each page's last user click, so link handling can tell a click on a link from a
 * script redirect and see the modifiers held (Shift, ⌘⌥). Electron reports input before the page
 * acts on it, so the click is known by the time the navigation or window.open arrives.
 */
export class ClickTracker {
  private clicks = new Map<number, PageClick>()

  constructor(private modifiers: HeldModifiers) {}

  watch(contents: WebContents): void {
    const id = contents.id
    contents.on('input-event', (_event, input) => {
      const type = input.type
      if (type === 'mouseDown' || type === 'mouseUp') this.clicks.set(id, fromInput(input, true, this.modifiers.get()))
      else if (type === 'rawKeyDown' || type === 'keyDown') {
        const code = (input as { keyCode?: string }).keyCode
        if (code === 'Enter' || code === 'Return' || code === ' ' || code === 'Space') {
          this.clicks.set(id, fromInput(input, false, this.modifiers.get()))
        }
      }
    })
    contents.once('destroyed', () => this.clicks.delete(id))
  }

  /** The page's click from the last moment, if any. */
  recent(contents: WebContents, now = Date.now()): PageClick | undefined {
    const click = this.clicks.get(contents.id)
    return click && now - click.at <= CLICK_WINDOW_MS ? click : undefined
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
