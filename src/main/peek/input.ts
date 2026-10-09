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

/**
 * Remembers each page's last user click, so link handling can tell a click on a link from a
 * script redirect and see the modifiers held (Shift, ⌘⌥). Electron reports input before the page
 * acts on it, so the click is known by the time the navigation or window.open arrives.
 */
export class ClickTracker {
  private clicks = new Map<number, PageClick>()

  watch(contents: WebContents): void {
    const id = contents.id
    contents.on('input-event', (_event, input) => {
      const type = input.type
      if (type === 'mouseDown' || type === 'mouseUp') this.clicks.set(id, fromInput(input, true))
      else if (type === 'rawKeyDown' || type === 'keyDown') {
        const code = (input as { keyCode?: string }).keyCode
        if (code === 'Enter' || code === 'Return' || code === ' ' || code === 'Space') {
          this.clicks.set(id, fromInput(input, false))
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

function fromInput(input: InputEvent, mouse: boolean): PageClick {
  const mods = new Set(input.modifiers ?? [])
  const pos = input as { x?: number; y?: number }
  return {
    at: Date.now(),
    x: mouse && typeof pos.x === 'number' ? pos.x : undefined,
    y: mouse && typeof pos.y === 'number' ? pos.y : undefined,
    shift: mods.has('shift'),
    alt: mods.has('alt'),
    meta: mods.has('meta') || mods.has('command') || mods.has('cmd'),
    control: mods.has('control') || mods.has('ctrl'),
  }
}

/** ⌘⌥-click on macOS, Ctrl+Alt-click elsewhere: open in a Mini Window (MW-07). */
export function isMiniClick(click: PageClick | undefined, platform = process.platform): boolean {
  if (!click?.alt) return false
  return platform === 'darwin' ? click.meta : click.control
}
