/**
 * Orbit's floating video player (media lane; media.md MD-03 to MD-07, MD-13, MD-16; feel.md FL-32).
 *
 * One small always-on-top window that borrows the source tab's own view (WebContentsView), so the
 * page keeps running exactly as it was. The page script (agent.ts) lifts the chosen video into the
 * page's top layer at the player's size at the top-left of the page; the window shows just that
 * corner. Orbit's controls (renderer view "pip") sit in a transparent view on top.
 *
 * Returning to the tab needs nothing from here: the window manager attaches the tab's view to its
 * window again (taking it out of this one), and the page puts the video back on that very frame
 * (see agent.ts). The player then just hides. Closing the player (×) hides it and leaves the view
 * detached, like any background tab, so the media plays on as audio (MD-07).
 */
import {
  app,
  BaseWindow,
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  screen,
  type WebContents,
  WebContentsView,
} from 'electron'
import type { MediaEvents } from '../../shared/commands/media'
import { PLAYBACK_RATES } from '../../shared/media'
import {
  anchoredResize,
  asideRect,
  clampPipSize,
  cornerRect,
  cubicBezier,
  dialogZone,
  draggedSize,
  EASE_OUT_CURVE,
  keepInside,
  maxPipSize,
  mixRect,
  nearestCorner,
  type PipCorner,
  pipAspect,
  pipDimensions,
  resizeWithResistance,
  roundedShape,
  STANDARD_CURVE,
  sameRect,
  settleCorner,
  springStep,
} from '../../shared/pip'
import type { Rect } from '../../shared/rpc'
import type { TabId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import { reducedMotion } from '../motion'
import { displayedTabs } from '../tabs/model'
import { loadRenderer, rendererEntry, uiWebPreferences } from '../windows'
import { onDialogsChanged, windowsWithDialogs } from './dialog-watch'

const isMac = process.platform === 'darwin'
/** Corner radius of the player where Orbit rounds it itself (macOS rounds its windows natively). */
const RADIUS = 10
/**
 * The borrowed view is this much taller than the page area it came from, so the page can tell
 * where it is from its size alone (agent.ts): at the player's size the video lifts, at any other
 * size (back in its window) it goes back into the page, each before the frame is drawn. 24 DIP is
 * still more than the page's 2 px tolerance at 500% page zoom.
 */
const EXTRA_HEIGHT = 24
const PLAYER_BACKGROUND = '#000000'
/** Tab views' own background (tabs/runtime.ts), given back when the view leaves the player. */
const TAB_BACKGROUND = '#ffffffff'
/** Enter motion (MD-16: about 300 ms, smooth, no overshoot; feel.md "standard" curve). */
const ENTER_MS = 300
/** Exits are quicker than entrances (FL-01: about 0.7×). */
const EXIT_MS = 140
/** "Back to tab": the reverse of the enter motion, a little quicker (MD-16, FL-01). */
const BACK_MS = 220
/** With reduced motion, a released player settles with a short ease-out instead of a spring (FL-28). */
const RELEASE_MS = 120
const FRAME_MS = 16
/** A pause in wheel scrolling ends a hover-scroll move (MD-06). */
const WHEEL_IDLE_MS = 160
/** How often a showing player looks for Orbit's alerts and dialogs (MD-06). */
const DIALOG_CHECK_MS = 100

export type PlayerEnd = 'close' | 'returned' | 'gone' | 'navigated' | 'ended' | 'replaced' | 'off' | 'quit'

export interface PlayerHost {
  /** Runs a function of the tab's page script; undefined when the tab has none. */
  call<T>(tabId: TabId, fn: string, ...args: unknown[]): Promise<T | undefined>
  /** The player opened or closed for a tab. */
  changed(tabId: TabId, open: boolean, auto: boolean): void
  /** Selects a tab in a window and brings the window forward. */
  focusTab(tabId: TabId, windowId: WindowId): void
  /** Turns automatic picture-in-picture off for the tab's site (MD-08 from the player's menu). */
  turnOffForSite(tabId: TabId, mode: 'today' | 'always'): void
}

interface Session {
  tabId: TabId
  /** The window the tab was in: "Back to tab" selects it there (MD-04). */
  windowId: WindowId | undefined
  view: WebContentsView
  contents: WebContents
  /** The video's shape (width / height). */
  aspect: number
  auto: boolean
  /** Page zoom: CSS px = DIP / zoom. */
  zoom: number
  /** Size of the borrowed view (the video can grow up to it). */
  viewSize: { width: number; height: number }
  /** The video's place in its window's content (DIP) when it left: "Back to tab" flies there (MD-16). */
  home: Rect | undefined
  dispose: () => void
}

interface Gesture {
  kind: 'move' | PipCorner
  startX: number
  startY: number
  start: Rect
  samples: { x: number; y: number; t: number }[]
}

export type PipGestureEvent = MediaEvents['media.pipGesture']

export interface OpenOptions {
  /** Opened because the tab was left (it closes when the tab comes back, like any player). */
  auto: boolean
  /**
   * Where the motion starts: the video's place in the page ('page', when leaving the tab), a rect
   * in a window (the sidebar controller's "Back to PiP"), or nothing (it appears in its corner).
   */
  from?: 'page' | { windowId: WindowId; rect: Rect }
  /** A point in the page (CSS px): the video under it is the one to float. */
  point?: { x: number; y: number }
  /** Take the video from the engine's own picture-in-picture window. */
  keep?: boolean
}

/** Diagnostics for tests. */
export interface PlayerInfo {
  tabId: TabId | null
  visible: boolean
  bounds: Rect | null
  workArea: Rect | null
  holdsView: boolean
  alwaysOnTop: boolean
  animating: boolean
  /** The last enter motion: where the player started and where it went (MD-16). */
  lastEnter: { from: Rect; to: Rect } | null
  /** The last "Back to tab" motion: from the player's place to the video's place in the page (MD-16). */
  lastBack: { from: Rect; to: Rect } | null
  /**
   * The last settle after a move or resize (MD-06): where it went, and how long it takes when it is
   * a timed ease-out (reduced motion, FL-28); null for the spring.
   */
  lastSettle: { from: Rect; to: Rect; ms: number | null } | null
  /** How long the last opening took, from the request to the window showing (ms; MD-01). */
  openMs: number | null
  /** An opening is under way (the page is being asked for its video). */
  opening: boolean
}

export class PipPlayer {
  private win: BaseWindow | undefined
  private ui: WebContentsView | undefined
  /** The window has its rounded shape for its current size (not macOS). */
  private shaped = false
  private session: Session | undefined
  /** Increments on every open/close: a slow open that lost the race gives up. */
  private seq = 0
  private anim: NodeJS.Timeout | undefined
  private gesture: Gesture | undefined
  private wheelTimer: NodeJS.Timeout | undefined
  private wheelSamples: { x: number; y: number; t: number }[] = []
  private lastEnter: { from: Rect; to: Rect } | null = null
  private lastBack: { from: Rect; to: Rect } | null = null
  private lastSettle: { from: Rect; to: Rect; ms: number | null } | null = null
  /** The window the controls act for (app menu and shortcuts while the player has focus). */
  private uiWindowId: WindowId | undefined
  /** "Back to tab" is under way: the player flies back into the page once the tab is selected. */
  private backing: { tabId: TabId; to: Rect | undefined } | undefined
  /** The controls view shows a still of the last frame (while flying back, MD-16). */
  private still = false
  private openMs: number | null = null
  private hiding: NodeJS.Timeout | undefined
  private opening: { tabId: TabId; done: Promise<boolean> } | undefined
  /** Finishes a closing fade at once (a new video is about to show). */
  private finishFade: (() => void) | undefined
  /**
   * Out of the way of Orbit's alerts and dialogs (MD-06): where it was, and where it went (null:
   * hidden, no corner was clear); 'user' once the user moved it meanwhile, which it keeps.
   */
  private aside: { from: Rect; to: Rect | null } | 'user' | undefined
  private dialogCheck: NodeJS.Timeout | undefined
  /** macOS: windows with a sheet (their alerts and file pickers are sheets). */
  private sheets = new WeakSet<BrowserWindow>()
  /** Last menu template (tests read it instead of a native popup). */
  lastMenu: MenuItemConstructorOptions[] = []

  constructor(
    private ctx: MainContext,
    private host: PlayerHost,
  ) {
    // Closing the tab's window puts its tabs to sleep, the player's too; and a hidden player
    // window must not keep the app alive once every Orbit window is closed.
    app.on('browser-window-created', (_e, win) => {
      win.once('closed', () => setImmediate(() => this.onWindowClosed()))
      win.on('sheet-begin', () => {
        this.sheets.add(win)
        this.checkDialogs()
      })
      win.on('sheet-end', () => {
        this.sheets.delete(win)
        this.checkDialogs()
      })
    })
    onDialogsChanged(() => this.checkDialogs())

    screen.on('display-removed', () => this.refit())
    screen.on('display-metrics-changed', () => this.refit())
  }

  /** The tab whose video is in the player. */
  get tabId(): TabId | undefined {
    return this.session?.tabId
  }

  /** Creates the window and its controls ahead of time, so the player appears at once (MD-01). */
  prewarm(): void {
    if (this.ctx.windows.ids().length > 0) this.ensureWindow()
  }

  // ---- Opening ----

  /** Shows a tab's video in the player. */
  open(tabId: TabId, opts: OpenOptions): Promise<boolean> {
    if (this.session?.tabId === tabId) return Promise.resolve(true)
    // Already on its way for this tab (leaving it twice in quick succession): one opening.
    if (this.opening?.tabId === tabId) return this.opening.done
    const done = this.start(tabId, opts).finally(() => {
      if (this.opening?.done === done) this.opening = undefined
    })
    this.opening = { tabId, done }
    return done
  }

  private async start(tabId: TabId, opts: OpenOptions): Promise<boolean> {
    const began = Date.now()
    const view = this.ctx.tabs.get(tabId)
    const contents = view?.webContents
    if (!view || !contents || contents.isDestroyed()) return false
    if (this.session) this.close('replaced')
    const seq = ++this.seq
    const probe = await this.host.call<{ ok: boolean; aspect?: number; rect?: Rect | null }>(tabId, 'probe', {
      // Leaving the tab takes only its main playing video; asking for PiP takes any video.
      auto: opts.auto && !opts.keep,
      x: opts.point?.x,
      y: opts.point?.y,
    })
    if (!probe?.ok || seq !== this.seq || contents.isDestroyed()) return false
    // Back on screen meanwhile (a quick switch away and back): nothing to do.
    if (this.isShown(tabId)) return false
    const windowId = this.ctx.windows.windowOfTab(tabId) ?? this.ctx.windows.focusedWindowId()
    const source = windowId ? this.ctx.windows.get(windowId) : undefined
    const zoom = contents.getZoomFactor() || 1
    const pane = view.getBounds()
    const aspect = pipAspect(probe.aspect ?? 0, 1)
    const anchor = source && !source.isDestroyed() ? source.getBounds() : undefined
    const display = anchor ? screen.getDisplayMatching(anchor) : screen.getPrimaryDisplay()
    const area = display.workArea
    const placement = this.ctx.store.state.settings.pipPlacement ?? { corner: 'bottom-right', size: 320 }
    const dims = pipDimensions(aspect, clampPipSize(placement.size, area, aspect))
    const target = cornerRect(area, placement.corner, dims.width, dims.height)

    // Where the video sits in its window: the enter motion starts there when leaving the tab, and
    // "Back to tab" flies back there (MD-16).
    const home = probe.rect
      ? {
          x: Math.round(pane.x + probe.rect.x * zoom),
          y: Math.round(pane.y + probe.rect.y * zoom),
          width: Math.round(probe.rect.width * zoom),
          height: Math.round(probe.rect.height * zoom),
        }
      : undefined

    // Where the motion starts (MD-16).
    let from: Rect | undefined
    if (opts.from === 'page' && home && source && !source.isDestroyed()) {
      const content = source.getContentBounds()
      from = { ...home, x: content.x + home.x, y: content.y + home.y }
    } else if (opts.from && opts.from !== 'page') {
      const win = this.ctx.windows.get(opts.from.windowId)
      if (win && !win.isDestroyed()) {
        const content = win.getContentBounds()
        const r = opts.from.rect
        // The video's shape, centred on the controller, as tall as it.
        const h = Math.max(24, Math.round(r.height))
        const w = Math.round(h * aspect)
        from = {
          x: Math.round(content.x + r.x + r.width / 2 - w / 2),
          y: Math.round(content.y + r.y + r.height / 2 - h / 2),
          width: w,
          height: h,
        }
      }
    }
    if (from && (from.width < 8 || from.height < 8 || !!reducedMotion(this.ctx))) from = undefined
    const start = from ?? target
    const ms = ENTER_MS

    // The borrowed view: at least the page area, and big enough for the largest player.
    const max = pipDimensions(aspect, maxPipSize(area, aspect))
    const viewSize = {
      width: Math.max(pane.width, max.width, start.width),
      height: Math.max(pane.height, max.height, start.height) + EXTRA_HEIGHT,
    }
    // The page draws the video at the window's size; during the motion it follows frame by frame.
    const css = { w: start.width / zoom, h: start.height / zoom }
    const lifted = await this.host.call<boolean>(tabId, 'lift', {
      from: css,
      to: css,
      ms: 0,
      arm: { w: Math.round(viewSize.width / zoom), h: Math.round(viewSize.height / zoom) },
    })
    if (!lifted || seq !== this.seq || contents.isDestroyed() || this.isShown(tabId)) {
      if (lifted) void this.host.call(tabId, 'drop')
      return false
    }

    const { win, ui } = this.ensureWindow()
    // The controls belong to the tab's window from now on, not to the window they were made in
    // (which may have closed since).
    if (windowId && windowId !== this.uiWindowId) {
      this.ctx.windows.registerUi(ui.webContents, windowId)
      this.uiWindowId = windowId
    }
    this.finishFade?.()
    this.backing = undefined
    void this.showStill(null)
    this.ctx.windows.detachView(tabId, view)
    win.contentView.addChildView(view, 0)
    view.setBounds({ x: 0, y: 0, ...viewSize })
    view.setBorderRadius(0)
    // Until the page draws at its new size, the view shows its background: black, like the video.
    view.setBackgroundColor(PLAYER_BACKGROUND)
    view.setVisible(true)
    ui.setVisible(true)

    const onGone = () => this.closeFor(tabId, 'gone')
    contents.once('destroyed', onGone)
    this.session = {
      tabId,
      windowId,
      view,
      contents,
      aspect,
      auto: opts.auto,
      zoom,
      viewSize,
      home,
      dispose: () => {
        if (!contents.isDestroyed()) contents.off('destroyed', onGone)
      },
    }
    this.place(start)
    if (!win.isVisible()) win.showInactive()
    this.openMs = Date.now() - began
    this.lastEnter = from ? { from: start, to: target } : null
    if (from) this.animateTimed(start, target, ms, () => this.pointerCheck())
    this.watchDialogs()
    this.host.changed(tabId, true, opts.auto)
    return true
  }

  private isShown(tabId: TabId): boolean {
    return displayedTabs(this.ctx.store.state).has(tabId)
  }

  // ---- Closing ----

  /** Ends the player for this tab, if it shows it. */
  closeFor(tabId: TabId, why: PlayerEnd): void {
    if (this.session?.tabId === tabId) this.close(why)
  }

  /**
   * Ends the player. The window hides first, so the page never shows in it while the video goes
   * back into the page; then the view is let go (unless its window already took it back).
   */
  close(why: PlayerEnd): void {
    const s = this.session
    if (!s) return
    this.session = undefined
    this.seq++
    this.stopMotion()
    this.unwatchDialogs()
    s.dispose()
    const win = this.win
    const release = () => {
      if (win && !win.isDestroyed() && win.contentView.children.includes(s.view))
        win.contentView.removeChildView(s.view)
      try {
        s.view.setBackgroundColor(TAB_BACKGROUND)
      } catch {}
      if (!s.contents.isDestroyed()) void this.host.call(s.tabId, 'drop')
    }
    // A still taken for "Back to tab" that won't fly (the player was closed while it was taken) goes
    // as the player hides, so the next video never shows it.
    const released = () => {
      release()
      void this.showStill(null)
    }
    const fade = isMac && !reducedMotion(this.ctx) && (why === 'close' || why === 'off' || why === 'ended')
    const back = this.backing?.tabId === s.tabId ? this.backing : undefined
    this.backing = undefined
    if (win && !win.isDestroyed() && win.isVisible() && why === 'returned' && back?.to && this.still) {
      // "Back to tab" (MD-16): the tab is already back in its window, playing; a still of the last
      // frame flies from the player to the video's place in the page, then the player hides.
      release()
      const from = win.getBounds()
      this.lastBack = { from, to: back.to }
      this.flyBack(win, from, back.to)
    } else if (win && !win.isDestroyed() && win.isVisible()) {
      if (fade) {
        this.fadeOut(win, () => {
          win.hide()
          released()
        })
      } else {
        win.hide()
        released()
      }
    } else released()
    this.host.changed(s.tabId, false, false)
  }

  /**
   * "Back to tab" and double-click (MD-04, MD-07): select the tab; the player closes as it returns.
   * With motion on, the player first takes a still of the video, then flies it back to the video's
   * place in the page while the page already plays it there (MD-16). The tab is selected at once
   * (FL-01: state first, motion second).
   */
  async back(): Promise<void> {
    const s = this.session
    if (!s || this.backing?.tabId === s.tabId) return
    const windowId =
      s.windowId && this.ctx.windows.get(s.windowId) && !this.ctx.windows.get(s.windowId)?.isDestroyed()
        ? s.windowId
        : (this.ctx.windows.focusedWindowId() ?? this.ctx.windows.ids()[0])
    if (!windowId) return
    const to = windowId === s.windowId ? this.homeOnScreen(s, windowId) : undefined
    this.backing = { tabId: s.tabId, to }
    if (to) await this.takeStill(s)
    if (this.session !== s) return
    this.host.focusTab(s.tabId, windowId)
  }

  /**
   * After the enter motion: if the pointer isn't over the player, its controls hide (it may have
   * appeared under a resting pointer and moved away, with no pointer event to say so; MD-03).
   */
  private pointerCheck(): void {
    const win = this.win
    const contents = this.ui?.webContents
    if (!win || win.isDestroyed() || !contents || contents.isDestroyed()) return
    const p = screen.getCursorScreenPoint()
    const b = win.getBounds()
    if (p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height) return
    contents.executeJavaScript("window.dispatchEvent(new Event('orbit-pip-pointer-away'))").catch(() => {})
  }

  /** The video's place in the page on screen, if the motion back there can be seen (MD-16). */
  private homeOnScreen(s: Session, windowId: WindowId): Rect | undefined {
    const source = this.ctx.windows.get(windowId)
    if (
      !s.home ||
      reducedMotion(this.ctx) ||
      !source ||
      source.isDestroyed() ||
      !source.isVisible() ||
      source.isMinimized()
    )
      return undefined
    const content = source.getContentBounds()
    const to = { ...s.home, x: content.x + s.home.x, y: content.y + s.home.y }
    // Only when the page area still holds it (the window may have shrunk meanwhile).
    const inside =
      s.home.x >= 0 &&
      s.home.y >= 0 &&
      s.home.x + s.home.width <= content.width + 1 &&
      s.home.y + s.home.height <= content.height + 1
    return inside && to.width >= 8 && to.height >= 8 ? to : undefined
  }

  /** Puts a still of the player's current frame in the controls view, over the video. */
  private async takeStill(s: Session): Promise<void> {
    const win = this.win
    if (!win || win.isDestroyed()) return
    const b = win.getBounds()
    try {
      const image = await s.contents.capturePage({ x: 0, y: 0, width: b.width, height: b.height })
      // A blank capture (no frame to show) would fly a black box: no motion then.
      if (this.session !== s || image.isEmpty() || blank(image.toBitmap())) return
      await this.showStill(`data:image/jpeg;base64,${image.toJPEG(90).toString('base64')}`)
    } catch {
      // No still (the page went away): the player just closes.
    }
  }

  /** Shows (a data URL) or clears (null) the still in the controls view. */
  private async showStill(url: string | null): Promise<void> {
    const contents = this.ui?.webContents
    if (!contents || contents.isDestroyed() || (!url && !this.still)) return
    this.still = !!url
    const css = url ? `#000 0 0 / 100% 100% no-repeat url("${url}")` : ''
    try {
      // The controls hide while the still shows; resolves once it has been drawn.
      await contents.executeJavaScript(
        `document.documentElement.style.background = ${JSON.stringify(css)};` +
          `document.documentElement.toggleAttribute('data-still', ${!!url});` +
          'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
      )
    } catch {
      this.still = false
    }
  }

  /** The still flies from the player's place to the video's place in the page, then hides. */
  private flyBack(win: BaseWindow, from: Rect, to: Rect): void {
    const done = () => {
      this.finishFade = undefined
      this.stopAnimation()
      if (win.isDestroyed()) return
      win.hide()
      void this.showStill(null)
    }
    this.finishFade = done
    this.animateTimed(from, to, BACK_MS, done)
  }

  private onWindowClosed(): void {
    const s = this.session
    if (s?.windowId && !this.ctx.windows.get(s.windowId)) {
      // Like the other tabs of the closed window, the player's tab goes to sleep.
      this.close('gone')
      this.ctx.tabs.sleep(s.tabId)
    }
    if (BrowserWindow.getAllWindows().some((w) => !w.isDestroyed())) return
    this.close('quit')
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = undefined
    this.ui = undefined
  }

  // ---- Controls from the player's view ----

  /** The player's "…" menu (MD-04, MD-08): playback speed and turning automatic PiP off for the site. */
  menu(x: number, y: number): void {
    const s = this.session
    if (!s) return
    const items = this.menuItems(s)
    this.lastMenu = items
    if (this.ctx.e2e || !this.win) return
    Menu.buildFromTemplate(items).popup({ window: this.win, x: Math.round(x), y: Math.round(y) })
  }

  private menuItems(s: Session): MenuItemConstructorOptions[] {
    const media = this.ctx.store.state.tabs[s.tabId]?.media
    const items: MenuItemConstructorOptions[] = []
    if (media && !media.live && media.seekable && !media.mic && !media.camera) {
      const rate = media.rate ?? 1
      items.push(
        {
          label: 'Playback Speed',
          submenu: PLAYBACK_RATES.map((r) => ({
            label: r === 1 ? 'Normal' : `${r}×`,
            type: 'radio' as const,
            checked: Math.abs(rate - r) < 0.01,
            click: () => void this.host.call(s.tabId, 'control', 'rate', r),
          })),
        },
        { type: 'separator' },
      )
    }
    items.push(
      { label: 'Turn Off for Today', click: () => this.host.turnOffForSite(s.tabId, 'today') },
      { label: 'Always Turn Off for This Site', click: () => this.host.turnOffForSite(s.tabId, 'always') },
    )
    return items
  }

  /** ⌘/Ctrl + scroll or pinch zooms into the video, cropping it in the same window (MD-06). */
  async zoom(factor: number, x: number, y: number): Promise<number> {
    const s = this.session
    if (!s) return 1
    return (await this.host.call<number>(s.tabId, 'zoom', factor, x / s.zoom, y / s.zoom)) || 1
  }

  /** Moving and resizing by pointer, and moving by hover-scroll (MD-06, FL-32). */
  onGesture(e: PipGestureEvent): void {
    const s = this.session
    const win = this.win
    if (!s || !win || win.isDestroyed()) return
    if (e.phase === 'wheel') {
      this.wheel(e.x, e.y)
      return
    }
    const t = e.t ?? Date.now()
    if (e.phase === 'start') {
      this.stopMotion()
      if (this.aside) this.aside = 'user'
      this.gesture = {
        kind: e.kind ?? 'move',
        startX: e.x,
        startY: e.y,
        start: win.getBounds(),
        samples: [{ x: e.x, y: e.y, t }],
      }
      return
    }
    const g = this.gesture
    if (!g) return
    g.samples.push({ x: e.x, y: e.y, t })
    while (g.samples.length > 2 && t - (g.samples[0]?.t ?? t) > 100) g.samples.shift()
    const dx = e.x - g.startX
    const dy = e.y - g.startY
    if (g.kind === 'move') {
      this.place({ ...g.start, x: g.start.x + dx, y: g.start.y + dy })
    } else {
      const area = this.areaFor(g.start)
      const size = resizeWithResistance(draggedSize(g.start, g.kind, dx, dy), area, s.aspect)
      const dims = pipDimensions(s.aspect, Math.min(size, Math.max(s.viewSize.width, s.viewSize.height)))
      this.place(anchoredResize(g.start, g.kind, dims.width, dims.height), true)
    }
    if (e.phase === 'end') {
      this.gesture = undefined
      this.settle(velocityOf(g.samples))
    }
  }

  private wheel(dx: number, dy: number): void {
    const win = this.win
    if (!win || win.isDestroyed() || !(Number.isFinite(dx) && Number.isFinite(dy)) || (!dx && !dy)) return
    this.stopAnimation()
    if (this.aside) this.aside = 'user'
    const b = win.getBounds()
    // The player follows the fingers (a two-finger scroll moves content the other way).
    this.place({ ...b, x: Math.round(b.x - dx), y: Math.round(b.y - dy) })
    const t = Date.now()
    this.wheelSamples.push({ x: b.x - dx, y: b.y - dy, t })
    while (this.wheelSamples.length > 2 && t - (this.wheelSamples[0]?.t ?? t) > 100) this.wheelSamples.shift()
    clearTimeout(this.wheelTimer)
    this.wheelTimer = setTimeout(() => {
      const samples = this.wheelSamples
      this.wheelSamples = []
      this.settle(velocityOf(samples))
    }, WHEEL_IDLE_MS)
  }

  /**
   * After a move or resize: the player glides to the corner the release heads for, at its size
   * within the limits (a rubber-banded size springs back), and Orbit remembers both (MD-06).
   */
  private settle(velocity: { x: number; y: number }): void {
    const s = this.session
    const win = this.win
    if (!s || !win || win.isDestroyed()) return
    const now = win.getBounds()
    const area = this.areaFor(now)
    const size = clampPipSize(Math.max(now.width, now.height), area, s.aspect)
    const dims = pipDimensions(s.aspect, Math.min(size, Math.max(s.viewSize.width, s.viewSize.height)))
    const corner = settleCorner(area, now, velocity)
    const target = cornerRect(area, corner, dims.width, dims.height)
    this.ctx.store.update((d) => {
      const p = d.settings.pipPlacement
      if (p?.corner === corner && p.size === size) return
      d.settings.pipPlacement = { corner, size }
    })
    const rich = !reducedMotion(this.ctx)
    this.lastSettle = { from: now, to: target, ms: rich ? null : RELEASE_MS }
    if (rich) this.animateSpring(now, target, velocity)
    else this.animateTimed(now, target, RELEASE_MS, undefined, EASE_OUT_CURVE)
  }

  // ---- Geometry and motion ----

  /** Sets the window's bounds; the controls fill it and the video follows a size change. */
  private place(rect: Rect, resizeVideo = false): void {
    const win = this.win
    const s = this.session
    if (!win || win.isDestroyed()) return
    const r = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    }
    const before = win.getBounds()
    win.setBounds(r)
    this.ui?.setBounds({ x: 0, y: 0, width: r.width, height: r.height })
    // macOS rounds the window itself; elsewhere the window takes a rounded shape (MD-03).
    if (!isMac && (before.width !== r.width || before.height !== r.height || !this.shaped)) {
      win.setShape(roundedShape(r.width, r.height, RADIUS))
      this.shaped = true
    }
    if (resizeVideo && s && (before.width !== r.width || before.height !== r.height)) {
      void this.host.call(s.tabId, 'size', r.width / s.zoom, r.height / s.zoom, 0)
    }
  }

  /**
   * A timed motion where window and video change together: the enter motion and "Back to tab" on
   * the "standard" curve (MD-16), or a release's ease-out with reduced motion (FL-28).
   */
  private animateTimed(
    from: Rect,
    to: Rect,
    ms: number,
    done?: () => void,
    curve: [number, number, number, number] = STANDARD_CURVE,
  ): void {
    this.stopAnimation()
    const ease = cubicBezier(...curve)
    const started = Date.now()
    const step = () => {
      const p = Math.min(1, (Date.now() - started) / ms)
      this.place(mixRect(from, to, ease(p)), true)
      if (p >= 1) {
        this.stopAnimation()
        done?.()
      }
    }
    this.anim = setInterval(step, FRAME_MS)
    step()
  }

  /** Glide with a spring that starts at the release velocity (FL-01, FL-32); never past the target. */
  private animateSpring(from: Rect, to: Rect, velocity: { x: number; y: number }): void {
    this.stopAnimation()
    const dx = to.x - from.x
    const dy = to.y - from.y
    const dist2 = dx * dx + dy * dy
    // Progress 0 → 1, with the release velocity along the way as its starting speed.
    let p = 0
    let v = dist2 > 1 ? (velocity.x * dx + velocity.y * dy) / dist2 : 0
    v = Math.max(-20, Math.min(20, v))
    const resize = from.width !== to.width || from.height !== to.height
    let last = Date.now()
    const step = () => {
      const now = Date.now()
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const next = springStep(p - 1, v, dt)
      p = next.offset + 1
      v = next.velocity
      const settled = Math.abs(p - 1) < 0.002 && Math.abs(v) < 0.02
      if (p > 1) {
        p = 1
        v = Math.min(0, v)
      }
      this.place(settled ? to : mixRect(from, to, p), resize)
      if (settled) this.stopAnimation()
    }
    this.anim = setInterval(step, FRAME_MS)
  }

  private fadeOut(win: BaseWindow, done: () => void): void {
    this.finishFade?.()
    const started = Date.now()
    const finish = () => {
      clearTimeout(this.hiding)
      this.finishFade = undefined
      if (!win.isDestroyed()) win.setOpacity(1)
      done()
    }
    const tick = () => {
      if (win.isDestroyed()) return finish()
      const p = Math.min(1, (Date.now() - started) / EXIT_MS)
      if (p >= 1) return finish()
      win.setOpacity(1 - p)
      this.hiding = setTimeout(tick, FRAME_MS)
    }
    this.finishFade = finish
    tick()
  }

  private stopAnimation(): void {
    if (this.anim) clearInterval(this.anim)
    this.anim = undefined
  }

  private stopMotion(): void {
    this.stopAnimation()
    clearTimeout(this.wheelTimer)
    this.wheelSamples = []
    this.gesture = undefined
  }

  private areaFor(rect: Rect): Rect {
    return screen.getDisplayNearestPoint({
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
    }).workArea
  }

  /** Screens changed: keep the player in a corner of a screen that still exists. */
  private refit(): void {
    const win = this.win
    if (!this.session || !win || win.isDestroyed() || this.gesture) return
    const b = win.getBounds()
    const area = this.areaFor(b)
    const inside = keepInside(area, b)
    if (inside.x === b.x && inside.y === b.y) return
    const corner = nearestCorner(area, b.x + b.width / 2, b.y + b.height / 2)
    this.place(cornerRect(area, corner, b.width, b.height))
  }

  // ---- Orbit's alerts and dialogs (MD-06) ----

  private watchDialogs(): void {
    if (!this.dialogCheck) this.dialogCheck = setInterval(() => this.checkDialogs(), DIALOG_CHECK_MS)
    this.checkDialogs()
  }

  private unwatchDialogs(): void {
    clearInterval(this.dialogCheck)
    this.dialogCheck = undefined
    this.aside = undefined
  }

  /**
   * The player never covers Orbit's alerts and dialogs (MD-06). While a window shows one (the
   * engine disables the window meanwhile; on macOS it is a sheet; file pickers say so through
   * dialog-watch), the player keeps clear of where it shows: it moves to the nearest corner that
   * is clear, at the same size, or hides if none is. When they close it goes back, unless the user
   * moved it meanwhile. None of this changes the remembered corner.
   */
  private checkDialogs(): void {
    const win = this.win
    if (!this.session || !win || win.isDestroyed()) return
    const noted = new Set(windowsWithDialogs())
    const owners = BrowserWindow.getAllWindows().filter(
      (w) =>
        !w.isDestroyed() && w.isVisible() && !w.isMinimized() && (noted.has(w) || this.sheets.has(w) || !w.isEnabled()),
    )
    if (owners.length === 0) {
      this.stepBack()
      return
    }
    // The user has it in hand, or it is still flying in: it is looked at again in a moment.
    if (this.aside === 'user' || this.gesture || (this.anim && !this.aside)) return
    const from = this.aside?.from ?? win.getBounds()
    const zones = owners.map((w) => {
      const bounds = w.getBounds()
      return dialogZone(bounds, screen.getDisplayMatching(bounds).workArea, isMac)
    })
    const to = asideRect(this.areaFor(from), from, zones)
    if (to === undefined) {
      this.stepBack()
      return
    }
    const was = this.aside?.to
    if (was !== undefined && (was === to || (was && to && sameRect(was, to)))) return
    this.aside = { from, to }
    this.stopAnimation()
    if (!to) {
      win.hide()
    } else if (!win.isVisible()) {
      this.place(to)
      win.showInactive()
    } else {
      this.glide(win.getBounds(), to)
    }
  }

  /** The dialogs closed: back to where it was, unless the user moved it meanwhile. */
  private stepBack(): void {
    const aside = this.aside
    this.aside = undefined
    const win = this.win
    if (!aside || aside === 'user' || !this.session || !win || win.isDestroyed()) return
    if (win.isVisible()) {
      this.glide(win.getBounds(), aside.from)
    } else {
      this.place(aside.from)
      win.showInactive()
    }
  }

  /** Moves the player, gliding there (the release's spring) unless reduced motion is asked for. */
  private glide(from: Rect, to: Rect): void {
    if (!reducedMotion(this.ctx)) this.animateSpring(from, to, { x: 0, y: 0 })
    else this.place(to)
  }

  // ---- Window ----

  private ensureWindow(): { win: BaseWindow; ui: WebContentsView } {
    if (this.win && !this.win.isDestroyed() && this.ui) return { win: this.win, ui: this.ui }
    const windowId = this.ctx.windows.ids()[0] ?? 'pip'
    const win = new BaseWindow({
      width: 320,
      height: 180,
      show: false,
      frame: false,
      title: 'Picture in Picture',
      // Linux window managers may refuse to resize a non-resizable window from code.
      resizable: process.platform === 'linux',
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: true,
      roundedCorners: true,
      backgroundColor: PLAYER_BACKGROUND,
    })
    if (isMac) {
      win.setAlwaysOnTop(true, 'floating')
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    }
    const ui = new WebContentsView({ webPreferences: uiWebPreferences(windowId, 'pip') })
    ui.setBackgroundColor('#00000000')
    win.contentView.addChildView(ui)
    ui.setBounds({ x: 0, y: 0, width: 320, height: 180 })
    this.ctx.windows.registerUi(ui.webContents, windowId)
    this.uiWindowId = windowId
    const contents = ui.webContents
    contents.on('will-navigate', (event, url) => {
      const entry = rendererEntry()
      if (!(entry.url && url.startsWith(entry.url))) event.preventDefault()
    })
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // ⌘W / Ctrl+W closes the player, not a tab behind it.
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.key.toLowerCase() !== 'w') return
      if (!(isMac ? input.meta : input.control) || input.shift || input.alt) return
      event.preventDefault()
      this.close('close')
    })
    contents.on('render-process-gone', (_e, details) => {
      if (details.reason !== 'clean-exit' && !contents.isDestroyed()) loadRenderer(contents, 'pip')
    })
    loadRenderer(contents, 'pip')
    win.on('closed', () => {
      if (this.win !== win) return
      const s = this.session
      this.session = undefined
      this.stopMotion()
      this.unwatchDialogs()
      if (s) {
        s.dispose()
        if (!s.contents.isDestroyed()) void this.host.call(s.tabId, 'drop')
        this.host.changed(s.tabId, false, false)
      }
      if (!contents.isDestroyed()) contents.close()
      this.win = undefined
      this.ui = undefined
    })
    this.win = win
    this.ui = ui
    this.shaped = false
    return { win, ui }
  }

  info(): PlayerInfo {
    const win = this.win && !this.win.isDestroyed() ? this.win : undefined
    const bounds = win ? win.getBounds() : null
    return {
      tabId: this.session?.tabId ?? null,
      visible: !!win?.isVisible(),
      bounds,
      workArea: bounds ? this.areaFor(bounds) : null,
      holdsView: !!(win && this.session && win.contentView.children.includes(this.session.view)),
      alwaysOnTop: !!win?.isAlwaysOnTop(),
      animating: !!this.anim,
      lastEnter: this.lastEnter,
      lastBack: this.lastBack,
      lastSettle: this.lastSettle,
      openMs: this.openMs,
      opening: !!this.opening,
    }
  }

  /** The controls' web contents (tests). */
  uiContents(): WebContents | undefined {
    return this.ui?.webContents
  }
}

/** True when a captured frame (BGRA) is all black or empty: nothing worth showing. */
function blank(bitmap: Buffer): boolean {
  const pixels = Math.floor(bitmap.length / 4)
  const step = Math.max(1, Math.floor(pixels / 4000))
  for (let i = 0; i < pixels; i += step) {
    const o = i * 4
    if ((bitmap[o] ?? 0) > 8 || (bitmap[o + 1] ?? 0) > 8 || (bitmap[o + 2] ?? 0) > 8) return false
  }
  return true
}

/** Release velocity in px/s from the last ~100 ms of pointer samples. */
function velocityOf(samples: { x: number; y: number; t: number }[]): { x: number; y: number } {
  const first = samples[0]
  const last = samples[samples.length - 1]
  if (!first || !last || last.t - first.t < 8) return { x: 0, y: 0 }
  const dt = (last.t - first.t) / 1000
  return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt }
}
