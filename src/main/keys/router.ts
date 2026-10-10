import { type WebContents, webContents } from 'electron'
import type { RecordedKey } from '../../shared/commands/keys'
import { acceleratorFromInput, modifiersOf } from '../../shared/keymap'
import type { WindowId } from '../../shared/state'
import type { MainContext } from '../context'

/**
 * The keys lane's part of the key router (src/main/windows.ts `attachShortcuts` calls it): a
 * window where Settings → Shortcuts is recording a new binding gets its key presses reported
 * instead of acted on (ST-08).
 */
export class KeyRouter {
  private ctx: MainContext | undefined
  /** The window whose key presses are being recorded (the Settings window), if any. */
  private recordingIn: WindowId | undefined

  init(ctx: MainContext): void {
    this.ctx = ctx
  }

  /** Starts (with the window) or stops recording. Closing the window stops it too. */
  setRecording(windowId: WindowId | undefined): void {
    this.recordingIn = windowId
    if (!windowId || !this.ctx) return
    for (const contents of webContents.getAllWebContents()) {
      if (this.ctx.windows.windowIdFor(contents) !== windowId) continue
      contents.once('destroyed', () => {
        if (this.recordingIn === windowId) this.recordingIn = undefined
      })
    }
  }

  /**
   * While the window of `contents` is recording, reports a key press to the page as
   * `keys.recorded` and returns true: the caller then keeps the key from the page, the menus and
   * every shortcut.
   */
  record(contents: WebContents, windowOf: () => WindowId | undefined, input: Electron.Input): boolean {
    if (!this.recordingIn || windowOf() !== this.recordingIn) return false
    if (input.type !== 'keyDown' && input.type !== 'keyUp') return true
    const press = {
      key: input.key,
      code: input.code,
      meta: input.meta,
      control: input.control,
      alt: input.alt,
      shift: input.shift,
    }
    // A modifier's own release clears it from what is held.
    const held =
      input.type === 'keyUp'
        ? {
            meta: input.meta && input.key !== 'Meta',
            control: input.control && input.key !== 'Control',
            alt: input.alt && input.key !== 'Alt',
            shift: input.shift && input.key !== 'Shift',
          }
        : press
    const recorded: RecordedKey = { modifiers: modifiersOf(held) }
    const accel = input.type === 'keyDown' ? acceleratorFromInput(press) : undefined
    if (accel) recorded.accel = accel
    if (!contents.isDestroyed()) contents.send('orbit:keys.recorded', recorded)
    return true
  }
}

/** The one key router extension for the app. */
export const keyRouter = new KeyRouter()
