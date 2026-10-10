import { BrowserWindow, nativeTheme, type Rectangle, screen } from 'electron'
import { ACTIONS_BY_ID } from '../../shared/actions'
import { DEFAULT_PROFILE_ID, MAX_FAVORITES } from '../../shared/defaults'
import { chosenApps, isOnboardingStep, type OnboardingInfo } from '../../shared/onboarding'
import type { WindowId } from '../../shared/state'
import { NEUTRAL_THEME, paletteFor } from '../../shared/theme'
import type { MainContext } from '../context'
import { loadRenderer, uiWebPreferences } from '../windows'
import { guardOwnWindow } from './ui-window'

/** The onboarding window's id for IPC. It is not a browser window: no WindowState, no tabs. */
export const ONBOARDING_WINDOW_ID = 'w-onboarding'

const SIZE = { width: 920, height: 660 }
const MIN_SIZE = { width: 720, height: 560 }
const isMac = process.platform === 'darwin'

let current: Onboarding | undefined

/**
 * Called at start-up, and when Orbit is activated with no browser window, instead of opening one:
 * until onboarding is done the first run shows it (OB-01), and it opens the first browser window at
 * the end. Test runs (ORBIT_E2E=1) skip it unless ORBIT_ONBOARDING=1. Returns whether it is showing.
 */
export function startOnboarding(): boolean {
  return current?.startIfDue() ?? false
}

/** The first-run flow's window (OB-01…OB-09, OB-14). */
class Onboarding {
  private win: BrowserWindow | undefined
  private finishing = false

  constructor(private readonly ctx: MainContext) {
    // The native background (seen while resizing) follows the colours and light or dark mode.
    nativeTheme.on('updated', () => this.window?.setBackgroundColor(this.background()))
    ctx.store.subscribe((next, prev) => {
      const spaceId = next.spaceOrder[0]
      if (!this.window || !spaceId || next.spaces[spaceId]?.theme === prev.spaces[spaceId]?.theme) return
      this.window.setBackgroundColor(this.background())
    })
  }

  get window(): BrowserWindow | undefined {
    return this.win && !this.win.isDestroyed() ? this.win : undefined
  }

  startIfDue(): boolean {
    if (this.window) {
      this.focus()
      return true
    }
    const skipInTests = this.ctx.e2e && process.env.ORBIT_ONBOARDING !== '1'
    if (this.ctx.store.state.settings.onboarded || skipInTests) return false
    this.open()
    return true
  }

  /** Runs the flow again from the start, over the windows already open; nothing is deleted (OB-14). */
  reset(): void {
    this.ctx.store.update((d) => {
      d.settings.onboarded = false
      delete d.settings.onboardingStep
    })
    if (this.window) this.focus()
    else this.open()
  }

  info(): OnboardingInfo {
    const { settings, spaceOrder } = this.ctx.store.state
    return {
      step: isOnboardingStep(settings.onboardingStep) ? settings.onboardingStep : 'welcome',
      spaceId: spaceOrder[0],
      importer: this.ctx.commands.has('import.open'),
      returning: this.browserWindows().length > 0,
    }
  }

  setStep(step: unknown): void {
    if (!this.window || !isOnboardingStep(step) || this.ctx.store.state.settings.onboardingStep === step) return
    this.ctx.store.update((d) => {
      d.settings.onboardingStep = step
    })
  }

  /** Adds the chosen Favorites, marks onboarding done and shows the browser window (OB-09). */
  async finish(favorites: unknown): Promise<void> {
    if (!this.window || this.finishing) return
    this.finishing = true
    try {
      const state = this.ctx.store.state
      const firstSpace = state.spaceOrder[0]
      const profileId = (firstSpace ? state.spaces[firstSpace]?.profileId : undefined) ?? DEFAULT_PROFILE_ID
      const profile = state.profiles[profileId]
      const have = new Set((profile?.favorites ?? []).map((id) => state.tabs[id]?.url))
      let room = MAX_FAVORITES - (profile?.favorites.length ?? 0)
      for (const app of chosenApps(favorites)) {
        if (room <= 0) break
        if (have.has(app.url)) continue
        // Added unloaded: a Favorite loads when it is first opened.
        await this.ctx.commands.run('tabs.create', {
          url: app.url,
          container: { kind: 'favorites', profileId },
          activate: false,
        })
        room--
      }
      this.ctx.store.update((d) => {
        d.settings.onboarded = true
        delete d.settings.onboardingStep
      })
      // After Reset onboarding a browser window is open already: go back to it. Otherwise this is the
      // first one. It opens before this window closes, so Orbit never has no window (and quits).
      const open = this.browserWindows()
      const windowId = open[open.length - 1] ?? this.ctx.windows.open()
      const win = this.ctx.windows.get(windowId)
      if (win && !win.isDestroyed() && win.isVisible()) win.focus()
      this.window?.close()
    } finally {
      this.finishing = false
    }
  }

  focus(): void {
    const win = this.window
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  close(): void {
    this.window?.close()
  }

  private browserWindows(): WindowId[] {
    const state = this.ctx.store.state
    return this.ctx.windows.ids().filter((id) => state.windows[id]?.kind === 'main')
  }

  private open(): void {
    const win = new BrowserWindow({
      ...this.bounds(),
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      show: false,
      title: 'Welcome to Orbit',
      fullscreenable: false,
      backgroundColor: this.background(),
      ...(isMac
        ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 18 } }
        : { autoHideMenuBar: true }),
      webPreferences: uiWebPreferences(ONBOARDING_WINDOW_ID, 'onboarding'),
    })
    this.win = win
    const contents = win.webContents
    this.ctx.windows.registerUi(contents, ONBOARDING_WINDOW_ID)
    this.ctx.windows.attachShortcuts(contents)
    guardOwnWindow(contents, 'onboarding')
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return
      win.show()
      win.focus()
    })
    win.once('closed', () => {
      if (this.win === win) this.win = undefined
    })
    loadRenderer(contents, 'onboarding')
  }

  /** Centred on the main screen, at a comfortable size. */
  private bounds(): Rectangle {
    const area = screen.getPrimaryDisplay().workArea
    const width = Math.min(SIZE.width, area.width)
    const height = Math.min(SIZE.height, area.height)
    return {
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
      width,
      height,
    }
  }

  /** The native background before the page paints: the first Space's colours. */
  private background(): string {
    const state = this.ctx.store.state
    const spaceId = state.spaceOrder[0]
    const theme = (spaceId ? state.spaces[spaceId]?.theme : undefined) ?? NEUTRAL_THEME
    return paletteFor(theme, nativeTheme.shouldUseDarkColors).windowBackground
  }
}

/** First-run onboarding (OB-*): its window, commands and the Reset Onboarding action. */
export function registerOnboarding(ctx: MainContext): void {
  const onboarding = new Onboarding(ctx)
  current = onboarding
  const { commands, actions } = ctx
  commands.register('onboarding.info', () => onboarding.info())
  commands.register('onboarding.setStep', ({ step }) => onboarding.setStep(step))
  commands.register('onboarding.finish', ({ favorites }) => onboarding.finish(favorites))
  actions.register('onboarding.reset', () => onboarding.reset())

  // Keys and menu items while onboarding has focus: it has no tabs or Spaces to act on yet.
  actions.intercept((id, c) => {
    if (c.windowId !== ONBOARDING_WINDOW_ID) return false
    if (id === 'tab.close' || id === 'window.close') onboarding.close()
    else if (id === 'app.settings' || id.startsWith('settings.')) {
      // Settings opens on its own; it acts for the browser window once there is one.
      if (ACTIONS_BY_ID[id]) void actions.run(id, {})
    }
    return true
  })
}
