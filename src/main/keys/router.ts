import { type WebContents, webContents } from 'electron'
import { type ActionDef, formatAccelerator, priorityFor } from '../../shared/actions'
import type { RecordedKey } from '../../shared/commands/keys'
import { acceleratorFromInput, modifiersOf } from '../../shared/keymap'
import type { WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import { actionInWindow } from './open-file'
import { pageCanAnswer, pageVerdict, watchPageKeys } from './page-keys'

/** A second press of the same keys within this long after the page took the first runs the action (KS-02). */
export const AGAIN_MS = 1000

/** How long after the router ran an action the page left alone the macOS menu doesn't run it again. */
const MENU_DOUBLE_MS = 500

/** A key press left to a page first, waiting for what the page did with it. */
interface FirstPress {
  actionId: string
  /** Until when another press of the same keys runs the action: set once the page's answer is in. */
  until: number
  /** The macOS menu ran the action: the page left the key alone. */
  menuRan?: boolean
}

/**
 * The keys lane's part of the key router (src/main/windows.ts `attachShortcuts` calls it):
 * - a window where Settings → Shortcuts records a new binding gets its key presses reported
 *   instead of acted on (ST-08);
 * - an action that prefers websites leaves the first press to a web page that handles the keys
 *   itself (KS-02).
 */
export class KeyRouter {
  private ctx: MainContext | undefined
  /** The window whose key presses are being recorded (the Settings window), if any. */
  private recordingIn: WindowId | undefined
  /** First presses left to pages, by web contents and binding. */
  private firstPresses = new Map<string, FirstPress>()
  /** When the router last ran each action because a page left its keys alone. */
  private ranAfterPage = new Map<string, number>()

  init(ctx: MainContext): void {
    this.ctx = ctx
    ctx.hooks.tabCreated.push((_tabId, contents) => watchPageKeys(contents))
    // An action run some other way after a page took its keys (the toast's button, the command
    // bar): the next press of the keys is a first press again. Watches only; never handles.
    ctx.actions.intercept((id) => {
      for (const [key, first] of this.firstPresses) {
        if (first.actionId === id && first.until !== Number.POSITIVE_INFINITY) this.firstPresses.delete(key)
      }
      return false
    })
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

  /**
   * W, with Control still held, while switching to a recent tab (⌃Tab) closes the highlighted tab
   * (KS-06, TB-05); a held W closes one. Returns true when the press was the switcher's: the
   * caller keeps it from the page and every shortcut (Ctrl+W, Ctrl+Shift+W).
   */
  switcherKey(input: Electron.Input, windowOf: () => WindowId | undefined): boolean {
    if (input.type !== 'keyDown' || !input.control || input.meta || input.alt) return false
    if (input.code !== 'KeyW' && input.key.toLowerCase() !== 'w') return false
    const windowId = windowOf()
    const recent = this.ctx?.tabs.recentSwitch
    if (!windowId || !recent?.active(windowId)) return false
    if (!input.isAutoRepeat) recent.closeHighlighted(windowId)
    return true
  }

  /**
   * The action a key press runs where it was pressed: Open Peek as Tab's keys open a file in a
   * window with no Peek or Mini Window (KS-12).
   */
  actionIn(action: ActionDef | undefined, windowOf: () => WindowId | undefined): ActionDef | undefined {
    if (!action || !this.ctx) return action
    return actionInWindow(action, this.ctx.store.state, windowOf)
  }

  /**
   * Keys a web page may use (KS-02, KS-16). Returns true when the press goes to the page: the
   * caller lets it through and runs nothing now. Applies to a tab's page and:
   * - an action that prefers websites: if the page leaves the press alone, the action runs then.
   *   If the page used it, a toast offers the action, and pressing the same keys again within
   *   about a second runs it: for that press this returns false, and the caller runs the action
   *   at once and keeps the key from the page. A held key's repeats stay the page's.
   * - an action that prefers Orbit but leaves its keys to text fields (Back and Forward's ⌘[ ⌘]):
   *   the action runs unless focus was in a text field and the page used the press, or the press
   *   went into a frame Orbit can't see into.
   * A page whose main frame is loading can't say what it did with a press in time: Orbit takes
   * the keys at once then.
   */
  leaveToPage(
    contents: WebContents,
    input: Electron.Input,
    action: ActionDef,
    windowOf: () => WindowId | undefined,
  ): boolean {
    const ctx = this.ctx
    if (!ctx?.tabs.tabIdFor(contents)) return false
    const priority = priorityFor(action, process.platform, ctx.store.state.settings.shortcutPriority)
    if (priority === 'orbit' && !action.pageFirstInFields) return false
    // A page that is loading can't say in time what it did with the key: Orbit takes it at once.
    if (!pageCanAnswer(contents)) return false
    const key = `${contents.id} ${acceleratorFromInput(input) ?? ''}`
    const windowId = windowOf()
    // Until the page's answer is in, the macOS menu may run the action instead (`menuRuns`).
    const first: FirstPress = { actionId: action.id, until: Number.POSITIVE_INFINITY }
    if (priority === 'orbit') {
      this.firstPresses.set(key, first)
      void pageVerdict(contents, input, Date.now()).then((verdict) => {
        if (this.firstPresses.get(key) === first) this.firstPresses.delete(key)
        if (first.menuRan || contents.isDestroyed()) return
        if (verdict && (!verdict.seen || (verdict.prevented && verdict.inField))) return
        this.ran(action, windowId)
      })
      return true
    }
    const earlier = this.firstPresses.get(key)
    if (earlier && Date.now() <= earlier.until) {
      if (input.isAutoRepeat) return true
      this.firstPresses.delete(key)
      return false
    }
    if (input.isAutoRepeat) return true
    // Until the page's answer is in, another press counts as the second one.
    this.firstPresses.set(key, first)
    void pageVerdict(contents, input, Date.now()).then((verdict) => {
      // Whether a second press came (and ran the action) before the answer.
      const waiting = this.firstPresses.get(key) === first
      if (first.menuRan || contents.isDestroyed()) {
        if (waiting) this.firstPresses.delete(key)
        return
      }
      if (!verdict || (verdict.seen && !verdict.prevented)) {
        // The page left the key alone: the press is the action's, besides any second press's.
        if (waiting) this.firstPresses.delete(key)
        this.ran(action, windowId)
        return
      }
      if (!waiting) return
      first.until = Date.now() + AGAIN_MS
      setTimeout(() => {
        if (this.firstPresses.get(key) === first) this.firstPresses.delete(key)
      }, AGAIN_MS + 50)
      if (windowId) this.offer(windowId, action, input)
    })
    return true
  }

  /** Runs an action whose keys the page left alone. */
  private ran(action: ActionDef, windowId: WindowId | undefined): void {
    this.ranAfterPage.set(action.id, Date.now())
    void this.ctx?.actions.run(action.id, { windowId })
  }

  /**
   * Whether the macOS menu bar should run an action it was asked to. A key the router let through
   * to a page reaches the menu when the page leaves it alone: the menu runs the action then, and
   * the router doesn't run it a second time when the page's answer comes.
   */
  menuRuns(actionId: string): boolean {
    for (const [key, first] of this.firstPresses) {
      if (first.actionId !== actionId || first.until !== Number.POSITIVE_INFINITY) continue
      first.menuRan = true
      this.firstPresses.delete(key)
      return true
    }
    const ran = this.ranAfterPage.get(actionId)
    this.ranAfterPage.delete(actionId)
    return ran === undefined || Date.now() - ran > MENU_DOUBLE_MS
  }

  /** The toast after a page used an action's keys: the action, a click away (KS-02). */
  private offer(windowId: WindowId, action: ActionDef, input: Electron.Input): void {
    const accel = acceleratorFromInput(input)
    const keys = accel ? formatAccelerator(accel, process.platform) : 'the shortcut'
    this.ctx?.windows.sendToWindow(windowId, 'toast', {
      message: `The page used ${keys}`,
      action: { label: action.title, command: 'action.run', args: { id: action.id } },
    })
  }
}

/** The one key router extension for the app. */
export const keyRouter = new KeyRouter()
