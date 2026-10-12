import {
  webContents as allContents,
  type BrowserWindow,
  type IpcMainEvent,
  ipcMain,
  type WebContents,
  WebContentsView,
} from 'electron'
import { extensionKey, type PopupAnchor, type PopupRect, popupBounds } from '../../shared/extensions'
import { PAGE_CHANNEL } from '../../shared/site'
import type { InstalledExtension, ProfileId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import { ESCAPE_WAIT_MS } from '../keys/escape'
import { activeTabOf } from '../windows'
import type { ExtensionService } from './service'

/** A popup whose page never says how big it is shows at its smallest after this long. */
const SIZE_WAIT_MS = 400
/** A click on the icon or row whose popup that same click just closed leaves it closed (a toggle). */
const TOGGLE_MS = 400
/** The popup's corners, like the panels it opens beside. */
const POPUP_RADIUS = 10
/** While its page is being captured, how often Orbit reads the page's size itself. */
const MEASURE_MS = 150
/** The isolated world that size is read in: nothing of the page's sees it. */
const POPUP_WORLD = 1050
const MEASURE = '[document.documentElement.scrollWidth, document.documentElement.scrollHeight]'

/**
 * Why a popup closed. `away`: the user clicked elsewhere in Orbit, switched to another app, or the
 * window changed under it. `escape`, `closed` (its page closed itself) and `gone` (its page crashed
 * or its extension stopped) give the keyboard back to where it was.
 */
export type PopupCloseReason = 'away' | 'escape' | 'closed' | 'gone' | 'replaced'

interface Popup {
  windowId: WindowId
  profileId: ProfileId
  id: string
  view: WebContentsView
  contents: WebContents
  contentsId: number
  anchor: PopupAnchor
  /** Its page's preferred size, as it last said (null: not yet). */
  size: { width: number; height: number } | null
  shown: boolean
  /** Its page closed itself: the engine is closing it. */
  closing?: boolean
  /** Inspect Popup: its DevTools open as it shows. */
  inspect: boolean
  /** The overlay it opened over (the site controls panel's), by nonce: it closes with it. */
  overlayNonce?: number
  /** The view whose keyboard it took: the overlay's panel, or a page. */
  from?: WebContents
  sizeTimer?: NodeJS.Timeout
  measureTimer?: NodeJS.Timeout
  /** Esc presses waiting for the page's answer (D59), oldest first: each settles with whether the page used it. */
  escapes: ((used: boolean) => void)[]
  /** The Esc presses the page has answered, or that went unanswered (test view). */
  escapesSettled: number
  release: () => void
}

/** Test/debug view of a window's popup. */
export interface PopupInfo {
  id: string
  profileId: ProfileId
  url: string
  shown: boolean
  focused: boolean
  bounds: PopupRect
  contentsId: number
  /** Esc presses settled so far: the page answered whether it used each, or didn't in time. */
  escapes: number
}

/**
 * Extension popups (EX-05): an extension's popup page in a small borderless view over the window,
 * hung from the pinned icon or the site controls panel's row that opened it, at its page's own size
 * (25×25 to 800×600, and never bigger than the window). One per window.
 *
 * - It closes on a click elsewhere in Orbit (its page loses focus), Esc, a switch to another app,
 *   a resize of the window, another tab shown, the panel it opened from closing, its page closing
 *   itself or crashing, and its extension turned off or removed. While DevTools inspect it, it
 *   stays open when it loses focus.
 * - It takes the keyboard (KS-19: keys typed into it are its own; Esc closes it unless its page
 *   uses the key) and gives it back when Esc or its page closes it: to the panel it opened from,
 *   else to the page.
 * - Isolation: it runs in its profile's session like the extension's other pages, never as Orbit UI.
 *   It isn't registered with the window manager, so `ipc.ts` refuses it (EX isolation), and it gets
 *   only the page preload every page of the session gets (D40): no bridge. Orbit's key router never
 *   sees its keys (on macOS the menu bar's shortcuts still work). The pages it opens (`window.open`,
 *   a link) open as tabs (EX-12).
 * - A crash takes only the popup: it closes, and the tab and Orbit go on.
 */
export class ExtensionPopups {
  private open = new Map<WindowId, Popup>()
  /** The popup each window closed last because a press in Orbit's own views took its keyboard, for the toggle. */
  private lastAway = new Map<WindowId, { key: string; at: number }>()

  constructor(
    private readonly ctx: MainContext,
    private readonly service: ExtensionService,
    /** Opens a page the popup asked for, as a tab of the window. */
    private readonly openTab: (windowId: WindowId, url: string) => void,
  ) {
    // The page preload's Esc bit (D59), from a popup's main frame: whether its page used an Esc.
    ipcMain.on(PAGE_CHANNEL.escape, (event: IpcMainEvent, used: unknown) => {
      if (typeof used !== 'boolean' || this.open.size === 0) return
      const popup = [...this.open.values()].find((p) => p.contents === event.sender)
      try {
        if (!popup || event.senderFrame?.frameTreeNodeId !== popup.contents.mainFrame.frameTreeNodeId) return
      } catch {
        return
      }
      popup.escapes[0]?.(used)
    })
    // The extension turned off or removed, the panel it opened from closed, another tab shown.
    ctx.store.subscribe((next, prev) => {
      if (this.open.size === 0) return
      for (const popup of [...this.open.values()]) {
        const ext = next.extensions[extensionKey(popup.profileId, popup.id)]
        if (!ext?.enabled) {
          this.close(popup.windowId, 'gone')
          continue
        }
        if (next.windows === prev.windows) continue
        const win = next.windows[popup.windowId]
        if (!win) {
          this.close(popup.windowId, 'away')
          continue
        }
        if (activeTabOf(next, popup.windowId) !== activeTabOf(prev, popup.windowId)) {
          this.close(popup.windowId, 'away')
          continue
        }
        if (popup.overlayNonce !== undefined) {
          const overlay = win.overlay
          if (overlay.kind === 'none' || overlay.nonce !== popup.overlayNonce) this.close(popup.windowId, 'away')
        }
      }
    })
  }

  /**
   * Opens an extension's popup in a window, hung from `anchor`. 'closed' when the click that asked
   * for it had just closed the same popup (it toggles); 'none' when it has no popup or isn't running.
   * `inspect`: with its DevTools, undocked (a popup is too small to dock them in).
   */
  show(windowId: WindowId, ext: InstalledExtension, anchor: PopupAnchor, inspect = false): 'popup' | 'closed' | 'none' {
    const win = this.ctx.windows.get(windowId)
    if (!win || win.isDestroyed()) return 'none'
    const key = extensionKey(ext.profileId, ext.id)
    const away = this.lastAway.get(windowId)
    this.lastAway.delete(windowId)
    const current = this.open.get(windowId)
    if (!inspect && current && extensionKey(current.profileId, current.id) === key && current.contents.isFocused()) {
      // Its own icon again while it has the keyboard: the click didn't take focus from it (a
      // keyboard press of the row, say). It closes, as a toggle.
      this.close(windowId, 'escape')
      return 'closed'
    }
    if (!inspect && !current && away && away.key === key && Date.now() - away.at < TOGGLE_MS) return 'closed'
    this.close(windowId, 'replaced')
    const ses = this.service.session(ext.profileId)
    if (!ses || !ext.enabled || !ext.popup || !ses.extensions.getExtension(ext.id)) return 'none'

    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        enablePreferredSizeMode: true,
        safeDialogs: true,
      },
    })
    view.setBackgroundColor('#ffffff')
    view.setBorderRadius(POPUP_RADIUS)
    const contents = view.webContents
    const state = this.ctx.store.state.windows[windowId]
    const popup: Popup = {
      windowId,
      profileId: ext.profileId,
      id: ext.id,
      view,
      contents,
      contentsId: contents.id,
      anchor,
      size: null,
      shown: false,
      inspect,
      overlayNonce: state && state.overlay.kind !== 'none' ? state.overlay.nonce : undefined,
      from: allContents.getFocusedWebContents() ?? undefined,
      escapes: [],
      escapesSettled: 0,
      release: () => {},
    }
    this.open.set(windowId, popup)
    /** Closes this popup, if it is still the window's. */
    const closeThis = (reason: PopupCloseReason) => {
      if (this.open.get(windowId) === popup) this.close(windowId, reason)
    }

    const prefix = `chrome-extension://${ext.id}/`
    // What it opens is a tab of the window (EX-12), never a window of its own.
    contents.setWindowOpenHandler(({ url }) => {
      if (/^(https?|chrome-extension):/i.test(url)) this.openTab(windowId, url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (url.startsWith(prefix)) return
      event.preventDefault()
      if (/^https?:/i.test(url)) this.openTab(windowId, url)
      closeThis('closed')
    })
    contents.on('preferred-size-changed', (_event, size) => {
      popup.size = { width: size.width, height: size.height }
      if (this.open.get(windowId) === popup) this.place(popup)
    })
    contents.once('did-finish-load', () => {
      // Shown at its page's size; a page that hasn't said one yet gets a moment, then shows anyway.
      if (popup.size) this.place(popup)
      else if (contents.isBeingCaptured()) void this.measure(popup)
      else popup.sizeTimer = setTimeout(() => this.place(popup), SIZE_WAIT_MS)
    })
    // Esc: its page gets it first, as any page does (KS-19, D59), and it closes the popup unless the
    // page used it (an open menu of its own, say). The page preload's bit says which; no answer in
    // time counts as not used (D60).
    contents.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'Escape') return
      if (input.meta || input.control || input.alt || input.shift) return
      let timer: NodeJS.Timeout | undefined
      const settle = (used: boolean) => {
        clearTimeout(timer)
        const at = popup.escapes.indexOf(settle)
        if (at < 0) return
        popup.escapes.splice(at, 1)
        popup.escapesSettled++
        if (!used) closeThis('escape')
      }
      popup.escapes.push(settle)
      timer = setTimeout(() => settle(false), ESCAPE_WAIT_MS)
    })
    // A click elsewhere in Orbit: its page lost the keyboard. Not while DevTools inspect it.
    contents.on('blur', () => {
      if (this.open.get(windowId) !== popup || !popup.shown || contents.isDevToolsOpened()) return
      // A press in Orbit's own views (its icon's or row's, say) may be the click that runs it again:
      // that click leaves it closed (a toggle). A press on a page never is.
      setImmediate(() => {
        const now = allContents.getFocusedWebContents()
        if (now && this.ctx.windows.isUi(now)) this.lastAway.set(windowId, { key, at: Date.now() })
      })
      closeThis('away')
    })
    contents.on('devtools-closed', () => {
      if (!contents.isFocused()) closeThis('away')
    })
    contents.on('render-process-gone', () => closeThis('gone'))
    contents.on('did-fail-load', (_event, code, _text, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) closeThis('gone')
    })
    // Its page closed itself (window.close()): the engine closes it, then the keyboard leaves it.
    // Electron emits `close` for that but doesn't type it.
    const events: NodeJS.EventEmitter = contents
    events.once('close', () => {
      popup.closing = true
      closeThis('closed')
    })
    contents.once('destroyed', () => closeThis('closed'))

    // The window: a switch to another app, a resize, closing.
    const onBlur = () => {
      if (!contents.isDestroyed() && contents.isDevToolsOpened()) return
      closeThis('away')
    }
    const onResize = () => closeThis('away')
    const onClosed = () => closeThis('away')
    win.on('blur', onBlur)
    win.on('resize', onResize)
    win.on('enter-full-screen', onResize)
    win.on('leave-full-screen', onResize)
    win.once('closed', onClosed)
    popup.release = () => {
      win.off('blur', onBlur)
      win.off('resize', onResize)
      win.off('enter-full-screen', onResize)
      win.off('leave-full-screen', onResize)
      win.off('closed', onClosed)
    }

    contents.loadURL(`${prefix}${ext.popup}`).catch(() => closeThis('gone'))
    return 'popup'
  }

  /**
   * Chromium sends no new preferred size while a page is being captured (a capture of the page, or
   * a DevTools client emulating focus, as test harnesses do): Orbit then reads the page's size
   * itself, now and every MEASURE_MS while the capture lasts.
   */
  private async measure(popup: Popup): Promise<void> {
    const size: unknown = await popup.contents
      .executeJavaScriptInIsolatedWorld(POPUP_WORLD, [{ code: MEASURE }])
      .catch(() => null)
    if (this.open.get(popup.windowId) !== popup || popup.contents.isDestroyed()) return
    if (Array.isArray(size) && size.length === 2 && size.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      popup.size = { width: size[0] as number, height: size[1] as number }
    }
    this.place(popup)
    if (popup.contents.isBeingCaptured()) popup.measureTimer = setTimeout(() => void this.measure(popup), MEASURE_MS)
  }

  /** Puts the popup at its size beside its anchor, on top of the window; the first time, with the keyboard. */
  private place(popup: Popup): void {
    clearTimeout(popup.sizeTimer)
    popup.sizeTimer = undefined
    const win = this.ctx.windows.get(popup.windowId)
    if (!win || win.isDestroyed() || popup.contents.isDestroyed() || this.open.get(popup.windowId) !== popup) return
    const [width = 0, height = 0] = win.getContentSize()
    const bounds = popupBounds(popup.anchor, popup.size ?? { width: 0, height: 0 }, { width, height })
    const now = popup.view.getBounds()
    if (now.x !== bounds.x || now.y !== bounds.y || now.width !== bounds.width || now.height !== bounds.height) {
      popup.view.setBounds(bounds)
    }
    if (popup.shown) return
    popup.shown = true
    win.contentView.addChildView(popup.view)
    popup.contents.focus()
    if (popup.inspect) popup.contents.openDevTools({ mode: 'detach' })
  }

  /** Closes a window's popup, if one is open. */
  close(windowId: WindowId, reason: PopupCloseReason): void {
    const popup = this.open.get(windowId)
    if (!popup) return
    this.open.delete(windowId)
    clearTimeout(popup.sizeTimer)
    clearTimeout(popup.measureTimer)
    for (const settle of [...popup.escapes]) settle(true)
    popup.release()
    const contents = popup.contents
    const alive = !contents.isDestroyed()
    const hadKeyboard = alive && popup.shown && contents.isFocused()
    const win = this.ctx.windows.get(windowId)
    if (win && !win.isDestroyed() && win.contentView.children.includes(popup.view)) {
      win.contentView.removeChildView(popup.view)
    }
    if (alive) {
      if (contents.isDevToolsOpened()) contents.closeDevTools()
      if (!popup.closing) contents.close()
    }
    // Esc, or its page closing itself: the keyboard goes back where it was (KS-19).
    if (reason !== 'away' && reason !== 'replaced' && (hadKeyboard || !alive) && win && !win.isDestroyed()) {
      this.giveBack(popup, win)
    }
  }

  /** The keyboard back to the panel the popup opened from, while it is open, else to the page. */
  private giveBack(popup: Popup, win: BrowserWindow): void {
    if (!win.isFocused()) return
    const overlay = this.ctx.store.state.windows[popup.windowId]?.overlay
    const from = popup.from
    if (
      from &&
      !from.isDestroyed() &&
      popup.overlayNonce !== undefined &&
      overlay?.kind !== 'none' &&
      overlay?.nonce === popup.overlayNonce &&
      this.ctx.windows.isUi(from)
    ) {
      from.focus()
      return
    }
    this.ctx.windows.focusActiveTab(popup.windowId)
  }

  /** Closes every popup of an extension (it was turned off, reloaded or removed). */
  closeFor(profileId: ProfileId, id: string): void {
    for (const popup of [...this.open.values()]) {
      if (popup.profileId === profileId && popup.id === id) this.close(popup.windowId, 'gone')
    }
  }

  info(windowId: WindowId): PopupInfo | null {
    const popup = this.open.get(windowId)
    if (!popup || popup.contents.isDestroyed()) return null
    return {
      id: popup.id,
      profileId: popup.profileId,
      url: popup.contents.getURL(),
      shown: popup.shown,
      focused: popup.contents.isFocused(),
      bounds: popup.view.getBounds(),
      contentsId: popup.contentsId,
      escapes: popup.escapesSettled,
    }
  }
}
