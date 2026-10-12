import { BrowserWindow, nativeTheme, type Rectangle, screen } from 'electron'
import { ACTIONS_BY_ID } from '../../shared/actions'
import { createWindowState, DEFAULT_PROFILE_ID, MAX_FAVORITES } from '../../shared/defaults'
import { chosenApps, isOnboardingStep, type OnboardingInfo } from '../../shared/onboarding'
import { WELCOME_URL } from '../../shared/project'
import type { ColorMode, Settings, WindowId } from '../../shared/state'
import { type KeyRemap, keyRemaps } from '../../shared/system-keys'
import { NEUTRAL_THEME, normalizeSpaceTheme, paletteFor } from '../../shared/theme'
import type { MainContext } from '../context'
import { systemClashes } from '../keys/system'
import { loadRenderer, uiWebPreferences } from '../windows'
import { addOrbitBasics } from './basics'
import { guardOwnWindow } from './ui-window'

/** The onboarding window's id for IPC. It is not a browser window: no WindowState, no tabs. */
export const ONBOARDING_WINDOW_ID = 'w-onboarding'

const SIZE = { width: 920, height: 660 }
/** The first browser window's share of the screen's width and height (OB-09). */
const FIRST_WINDOW_SHARE = 0.8
const MIN_SIZE = { width: 720, height: 560 }
const isMac = process.platform === 'darwin'
/** The first-run key check (KS-03) is Linux's: macOS and Windows keep no keys Orbit binds by default. */
const checksKeys = process.platform === 'linux'
/** How long onboarding waits for the desktop to say which keys it keeps before going on without. */
const KEY_CHECK_WAIT = 1500

let current: Onboarding | undefined

/**
 * Called at start-up, and when Orbit is activated with no browser window, instead of opening one:
 * until onboarding is done the first run shows it (OB-01), and it opens the first browser window at
 * the end. Test runs (ORBIT_E2E=1) skip it unless ORBIT_ONBOARDING=1. Returns whether it is showing.
 */
export function startOnboarding(): boolean {
  return current?.startIfDue() ?? false
}

const isColorMode = (v: unknown): v is ColorMode => v === 'system' || v === 'light' || v === 'dark'

/** What a run of onboarding keeps until it ends: its step and picks (OB-14). */
function forgetProgress(settings: Settings): void {
  delete settings.onboardingStep
  delete settings.onboardingFavorites
  delete settings.onboardingThemeBefore
}

/** Brings the onboarding window forward if it is open (a second launch, say). Returns whether it is. */
export function focusOnboarding(): boolean {
  const win = current?.window
  if (!win) return false
  current?.focus()
  return true
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
      forgetProgress(d.settings)
    })
    if (this.window) this.focus()
    else this.open()
  }

  async info(): Promise<OnboardingInfo> {
    const keys = await this.keyRemaps()
    const { settings, spaceOrder } = this.ctx.store.state
    return {
      step: isOnboardingStep(settings.onboardingStep) ? settings.onboardingStep : 'welcome',
      spaceId: spaceOrder[0],
      importer: this.ctx.commands.has('import.open'),
      returning: this.browserWindows().length > 0,
      favorites: chosenApps(settings.onboardingFavorites).map((app) => app.id),
      keys,
    }
  }

  /**
   * KS-03, on Linux: the keys Orbit's actions are bound to that the desktop keeps, with a free key
   * for each. The same check as Settings → Shortcuts' marks; asked as the window opens, so it is
   * usually answered by the time the page asks. A desktop that doesn't answer in time gets no step.
   */
  private async keyRemaps(): Promise<KeyRemap[]> {
    if (!checksKeys) return []
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), KEY_CHECK_WAIT)
    })
    const clashes = await Promise.race([systemClashes(), late])
    clearTimeout(timer)
    if (!clashes) return []
    return keyRemaps(clashes, this.ctx.store.state.settings.shortcuts ?? {}, process.platform, (id) =>
      this.ctx.actions.has(id),
    )
  }

  /** The theme step's live change (OB-04). The first one keeps what it replaces, for Skip (D44). */
  async setTheme(theme: unknown, appearance: unknown): Promise<void> {
    const state = this.ctx.store.state
    if (!this.window || this.finishing || state.settings.onboarded) return
    const spaceId = state.spaceOrder[0]
    const space = spaceId ? state.spaces[spaceId] : undefined
    if (!spaceId || !space) return
    if (!state.settings.onboardingThemeBefore) {
      this.ctx.store.update((d) => {
        d.settings.onboardingThemeBefore = { spaceId, theme: space.theme, appearance: state.settings.appearance }
      })
    }
    if (theme !== undefined)
      await this.ctx.commands.run('spaces.update', { spaceId, theme: normalizeSpaceTheme(theme) })
    if (isColorMode(appearance)) await this.ctx.commands.run('settings.update', { appearance })
  }

  /** Keeps the Favorites picked so far in the state file, so a quit resumes with them (OB-14). */
  setFavorites(favorites: unknown): void {
    if (!this.window || this.finishing || this.ctx.store.state.settings.onboarded) return
    const ids = chosenApps(favorites).map((app) => app.id)
    this.ctx.store.update((d) => {
      d.settings.onboardingFavorites = ids
    })
  }

  /**
   * Skip setup (OB-14, D44): a default first window, as the spec words it: the theme step's change
   * is undone (the colours and mode from before it), and no Favorites are added or anything imported.
   */
  skip(): Promise<void> {
    return this.finish([], true)
  }

  setStep(step: unknown): void {
    if (!this.window || !isOnboardingStep(step) || this.ctx.store.state.settings.onboardingStep === step) return
    this.ctx.store.update((d) => {
      d.settings.onboardingStep = step
    })
  }

  /**
   * Adds the chosen Favorites, marks onboarding done and shows the browser window (OB-09): the
   * first one, or after Reset onboarding the one open already, which gets nothing new.
   */
  async finish(favorites: unknown, skipped = false): Promise<void> {
    if (!this.window || this.finishing) return
    this.finishing = true
    try {
      const before = this.ctx.store.state.settings.onboardingThemeBefore
      if (skipped && before) {
        if (this.ctx.store.state.spaces[before.spaceId]) {
          await this.ctx.commands.run('spaces.update', { spaceId: before.spaceId, theme: before.theme })
        }
        await this.ctx.commands.run('settings.update', { appearance: before.appearance })
      }
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
        forgetProgress(d.settings)
      })
      // After Reset onboarding a browser window is open already: go back to it. Otherwise this is the
      // first one. It opens before this window closes, so Orbit never has no window (and quits).
      const open = this.browserWindows()
      const windowId = open[open.length - 1] ?? (await this.openFirstWindow())
      const win = this.ctx.windows.get(windowId)
      if (win && !win.isDestroyed() && win.isVisible()) win.focus()
      this.window?.close()
    } finally {
      this.finishing = false
    }
  }

  /**
   * The first browser window (OB-09): centred at about 80% of the screen, with a small pinned
   * "Orbit basics" folder (the guide and help, OB-10, OB-13) at the top of the first Space's pinned
   * section and Orbit's welcome page in Today, which it shows. The command bar stays closed.
   */
  private async openFirstWindow(): Promise<WindowId> {
    const spaceId = this.ctx.store.state.spaceOrder[0]
    if (!spaceId) return this.ctx.windows.open()
    const area = screen.getPrimaryDisplay().workArea
    const width = Math.round(area.width * FIRST_WINDOW_SHARE)
    const height = Math.round(area.height * FIRST_WINDOW_SHARE)
    const bounds = {
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
      width,
      height,
    }
    const first = { ...createWindowState(spaceId), bounds }
    this.ctx.store.update((d) => {
      addOrbitBasics(d, spaceId)
      d.windows[first.id] = first
    })
    const windowId = this.ctx.windows.open(first)
    // Shown from the window's first frame: the window shows itself once its sidebar has painted.
    await this.ctx.commands.run('tabs.create', { url: WELCOME_URL, spaceId, activate: true }, { windowId })
    return windowId
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
    // The desktop's keys are looked up while the page loads (KS-03).
    if (checksKeys) void systemClashes()
    // Recorded at once, so a quit on the welcome step resumes there rather than counting as done
    // (an install with no step and onboarded false is from before onboarding: see index.ts).
    if (this.ctx.store.state.settings.onboardingStep === undefined) {
      this.ctx.store.update((d) => {
        d.settings.onboardingStep = 'welcome'
      })
    }
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
  commands.register('onboarding.setTheme', ({ theme, appearance }) => onboarding.setTheme(theme, appearance))
  commands.register('onboarding.setFavorites', ({ favorites }) => onboarding.setFavorites(favorites))
  commands.register('onboarding.finish', ({ favorites }) => onboarding.finish(favorites))
  commands.register('onboarding.skip', () => onboarding.skip())
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
