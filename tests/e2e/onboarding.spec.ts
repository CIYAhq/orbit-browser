import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { DEFAULT_PROFILE_ID } from '../../src/shared/defaults'
import { action, MOD, run, state, viewPage } from './helpers'
import {
  ACCOUNT_WORDS,
  accountPrompts,
  browserFocused,
  type FirstRun,
  launchFirstRun,
  type OrbitGlobal,
  openSettings,
  osWindows,
  pageOfView,
  remoteRequests,
} from './settings-support'

/** First run (OB-*). Feature IDs lead each title. */

/** Where Chromium downloads Hunspell dictionaries from (Linux). */
const SPELLCHECK_DICTIONARY = /^https:\/\/redirector\.gvt1\.com\/edgedl\/chrome\/dict\/[\w.-]+\.bdic$/

let orbit: FirstRun | undefined

test.afterEach(async () => {
  await orbit?.app.close().catch(() => {})
  orbit = undefined
})

test('[OB-02] a fresh install opens a usable browser window with nothing typed; nothing asks for an account or goes online', async () => {
  orbit = await launchFirstRun()
  const { app } = orbit
  // Usable at once: the browser window, its sidebar and the first Space.
  const shell = await viewPage(app, 'shell')
  await expect(shell.getByTestId('sidebar')).toBeVisible()
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as OrbitGlobal).__orbit.windowIds().length)).toBe(1)
  // No window but the browser window: nothing to sign in to or fill in first. Its own views: the
  // shell, the command bar and the loading indicator's, made as the window shows (chrome round 2, F3).
  const own = ['shell', 'overlay', 'loading']
  const views = () => app.windows().map((p) => new URL(p.url()).searchParams.get('view'))
  expect(views().filter((v) => !own.includes(v ?? ''))).toEqual([])
  // The command bar opens, ready to go anywhere.
  await shell.keyboard.press(`${MOD}+T`)
  const overlay = await viewPage(app, 'overlay')
  await expect(overlay.getByTestId('command-input')).toBeFocused()
  await expect(overlay.getByTestId('command-input')).toHaveValue('')

  // Nothing anywhere asks for an account: the window, the command bar, every Settings section, the menus.
  expect(await accountPrompts(shell)).toEqual([])
  expect(await accountPrompts(overlay)).toEqual([])
  await overlay.keyboard.press('Escape')
  const settings = await openSettings(app)
  const sections = await settings.locator('[data-testid^="settings-tab-"]').all()
  expect(sections.length).toBeGreaterThan(1)
  for (const tab of sections) {
    await tab.click()
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    expect(await accountPrompts(settings), (await tab.textContent()) ?? '').toEqual([])
  }
  const menuLabels = await app.evaluate(({ Menu }) => {
    const labels: string[] = []
    const walk = (menu: Electron.Menu | null) => {
      for (const item of menu?.items ?? []) {
        labels.push(item.label)
        walk(item.submenu ?? null)
      }
    }
    walk(Menu.getApplicationMenu())
    return labels
  })
  expect(menuLabels.filter((l) => ACCOUNT_WORDS.test(l))).toEqual([])

  // Everything stays on this computer: the whole run asked no server for anything. The one exception
  // is Chromium's own: on Linux it fetches the spell-check dictionary for web pages' text fields from
  // its download server (no user data in it; macOS and Windows use the system's).
  await app.close()
  expect(remoteRequests(orbit.netLog).filter((url) => !SPELLCHECK_DICTIONARY.test(url))).toEqual([])
})

/** The import step (OB-03) looks for other browsers: in test runs, in no folder at all. */
const NO_BROWSERS = { ORBIT_IMPORT_PLACES: '[]' }

/** Starts Orbit as a first run that shows onboarding (test runs skip it unless asked). */
function launchWithOnboarding(userData?: string): Promise<FirstRun> {
  return launchFirstRun({ userData, env: { ORBIT_ONBOARDING: '1', ...NO_BROWSERS } })
}

/** The browser windows open (onboarding is not one). */
function browserWindowIds(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as unknown as OrbitGlobal).__orbit.windowIds())
}

/** Whether the onboarding window is open, asked of the main process (its page may still be loading). */
function onboardingOpen(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.getTitle() === 'Welcome to Orbit'),
  )
}

/** The onboarding page once its first step is drawn, following Orbit's light or dark mode. */
async function onboardingPage(app: ElectronApplication, step: string): Promise<Page> {
  const page = await pageOfView(app, 'onboarding')
  await page.emulateMedia({ colorScheme: null })
  await expect(page.getByTestId(`onboarding-step-${step}`)).toBeVisible()
  return page
}

/** Moves on with the step's own Continue button (the import step's "Do this later") and waits for the next step. */
async function next(page: Page, to: string): Promise<void> {
  await page.getByTestId(to === 'theme' ? 'onboarding-import-later' : 'onboarding-next').click()
  await expect(page.getByTestId(`onboarding-step-${to}`)).toBeVisible()
}

/** Does something that closes the onboarding window, which can close it while Playwright still acts. */
async function closing(page: Page, act: () => Promise<void>): Promise<void> {
  await act().catch(async (err: unknown) => {
    if (!page.isClosed()) await page.waitForEvent('close', { timeout: 2000 }).catch(() => {})
    if (!page.isClosed()) throw err
  })
}

function firstSpaceTheme(app: ElectronApplication) {
  return state(app).then((s) => s.spaces[s.spaceOrder[0] as string]?.theme)
}

test('[OB-01][OB-04][OB-05][OB-07][OB-08][OB-09] a first run starts with onboarding, and what it picks shapes the first window', async () => {
  orbit = await launchWithOnboarding()
  const { app } = orbit
  const page = await onboardingPage(app, 'welcome')
  // Before any browser window: the welcome is the only window, centred and in front.
  expect(await browserWindowIds(app)).toEqual([])
  await expect.poll(async () => (await osWindows(app, 'onboarding')).map((w) => w.visible && w.focused)).toEqual([true])
  const [win] = await osWindows(app, 'onboarding')
  const area = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
  expect(Math.abs(win!.bounds.x + win!.bounds.width / 2 - (area.x + area.width / 2))).toBeLessThanOrEqual(2)
  // Each step's title has focus: Enter continues and Escape goes back (OB-01).
  await expect(page.getByRole('heading', { name: 'Welcome to Orbit' })).toBeFocused()
  expect(await accountPrompts(page)).toEqual([])
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('onboarding-step-import')).toBeVisible()
  await expect(page.getByTestId('import-flow')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Bring your bookmarks along' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('onboarding-step-welcome')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Welcome to Orbit' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Bring your bookmarks along' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('onboarding-step-theme')).toBeVisible()

  // OB-04: Match system to start with; Light and Dark apply to Orbit at once, this window included.
  await expect(page.getByTestId('onboarding-appearance-system')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('onboarding-appearance-light').click()
  await expect(page.getByTestId('onboarding')).not.toHaveAttribute('data-dark')
  const light = (await osWindows(app, 'onboarding'))[0]?.background
  await page.getByTestId('onboarding-appearance-dark').click()
  await expect.poll(async () => (await state(app)).settings.appearance).toBe('dark')
  await expect(page.getByTestId('onboarding')).toHaveAttribute('data-dark', '')
  await expect.poll(async () => (await osWindows(app, 'onboarding'))[0]?.background).not.toBe(light)
  await page.getByTestId('onboarding-appearance-system').click()
  await expect.poll(async () => (await state(app)).settings.appearance).toBe('system')
  // The first Space's colours change as they're picked, with the Space theme picker's controls.
  const neutral = await firstSpaceTheme(app)
  await page.getByTestId('theme-preset').nth(2).click()
  await expect.poll(() => firstSpaceTheme(app)).not.toEqual(neutral)
  await expect(page.getByTestId('theme-grain')).toBeVisible()
  const picked = await firstSpaceTheme(app)
  await next(page, 'favorites')

  // OB-05: nothing picked for the user, and no more than Favorites hold (12).
  const tiles = page.locator('[data-testid^="onboarding-app-"]')
  expect(await tiles.count()).toBeGreaterThanOrEqual(12)
  await expect(page.locator('[data-testid^="onboarding-app-"][aria-pressed="true"]')).toHaveCount(0)
  for (let i = 0; i < 12; i++) await tiles.nth(i).click()
  await expect(page.getByTestId('onboarding-favorites-count')).toContainText('12 chosen')
  await expect(tiles.nth(12)).toBeDisabled()
  for (let i = 0; i < 12; i++) await tiles.nth(i).click()
  await expect(page.getByTestId('onboarding-favorites-count')).toHaveText('None chosen')
  await page.getByTestId('onboarding-app-gmail').click()
  await page.getByTestId('onboarding-app-github').click()
  await expect(page.getByTestId('onboarding-app-github')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('onboarding-favorites-count')).toHaveText('2 chosen')
  expect(await accountPrompts(page)).toEqual([])
  await next(page, 'ads')
  // OB-06: ad and tracker blocking, on to start with (finish-settings-ads.spec.ts has the rest).
  await expect(page.getByTestId('onboarding-ads-switch')).toHaveAttribute('aria-checked', 'true')
  expect(await accountPrompts(page)).toEqual([])
  await next(page, 'browser')
  expect(await accountPrompts(page)).toEqual([])

  // OB-07: Not now weighs the same as making Orbit the default (test runs never change the OS's).
  const notNow = page.getByTestId('onboarding-browser-later')
  const makeDefault = page.getByTestId('onboarding-browser-default')
  expect(await notNow.getAttribute('class')).toBe(await makeDefault.getAttribute('class'))
  await makeDefault.click()
  await expect(page.getByTestId('onboarding-browser-status')).toContainText('Orbit is your default browser')
  await next(page, 'done')

  // OB-09 and OB-08: a summary, and the default profile's search engine, Google until changed.
  await expect(page.getByTestId('onboarding-summary-favorites')).toHaveText('Gmail and GitHub')
  await expect(page.getByTestId('onboarding-summary-browser')).toHaveText('Orbit')
  await expect(page.getByTestId('onboarding-summary-ads')).toHaveText('Blocked')
  const engine = page.getByTestId('onboarding-search-engine')
  await expect(engine).toHaveValue('google')
  await engine.selectOption('duckduckgo')
  await expect.poll(async () => (await state(app)).profiles[DEFAULT_PROFILE_ID]?.searchEngine).toBe('duckduckgo')
  expect(await accountPrompts(page)).toEqual([])
  await closing(page, () => page.getByTestId('onboarding-start').click())

  // The first window opens with the colours and Favorites picked; the command bar stays closed.
  const shell = await viewPage(app, 'shell')
  await expect(shell.getByTestId('sidebar')).toBeVisible()
  await expect.poll(() => onboardingOpen(app)).toBe(false)
  const [windowId] = await browserWindowIds(app)
  const s = await state(app)
  expect(s.settings.onboarded).toBe(true)
  expect(s.settings.onboardingStep).toBeUndefined()
  expect(s.profiles[DEFAULT_PROFILE_ID]?.favorites.map((id) => s.tabs[id]?.url)).toEqual([
    'https://mail.google.com/',
    'https://github.com/',
  ])
  expect(s.spaces[s.spaceOrder[0] as string]?.theme).toEqual(picked)
  expect(s.windows[windowId as string]?.overlay.kind).toBe('none')
  // Favorites load when first opened: the whole run went nowhere online (OB-02).
  await app.close()
  expect(remoteRequests(orbit.netLog).filter((url) => !SPELLCHECK_DICTIONARY.test(url))).toEqual([])
})

test('[OB-14][OB-01] onboarding resumes where a quit left it, picks and all; Skip setup opens a default first window; it never shows again', async () => {
  orbit = await launchWithOnboarding()
  let { app } = orbit
  const { userData } = orbit
  const neutral = await firstSpaceTheme(app)
  let page = await onboardingPage(app, 'welcome')
  // Quit on the very first step: the next start shows onboarding again, at the welcome step.
  expect((await state(app)).settings.onboardingStep).toBe('welcome')
  await app.close()
  orbit = await launchWithOnboarding(userData)
  app = orbit.app
  page = await onboardingPage(app, 'welcome')
  await next(page, 'import')
  await next(page, 'theme')
  await expect.poll(async () => (await state(app)).settings.onboardingStep).toBe('theme')
  // Quit part-way: the next start comes back to the same step, still before any browser window.
  await app.close()
  orbit = await launchWithOnboarding(userData)
  app = orbit.app
  page = await onboardingPage(app, 'theme')
  expect(await browserWindowIds(app)).toEqual([])
  // The theme step changes the first Space's colours and the mode as they're picked.
  const mode = (await state(app)).settings.appearance
  await page.getByTestId('theme-preset').nth(2).click()
  await expect.poll(() => firstSpaceTheme(app)).not.toEqual(neutral)
  await page.getByTestId(`onboarding-appearance-${mode === 'dark' ? 'light' : 'dark'}`).click()
  await expect.poll(async () => (await state(app)).settings.appearance).not.toBe(mode)
  await next(page, 'favorites')
  // Favorites are kept as they're picked: quitting on this step resumes with them.
  await page.getByTestId('onboarding-app-gmail').click()
  await page.getByTestId('onboarding-app-github').click()
  await expect(page.getByTestId('onboarding-favorites-count')).toHaveText('2 chosen')
  await expect.poll(async () => (await state(app)).settings.onboardingFavorites).toEqual(['gmail', 'github'])
  await app.close()
  orbit = await launchWithOnboarding(userData)
  app = orbit.app
  page = await onboardingPage(app, 'favorites')
  await expect(page.getByTestId('onboarding-favorites-count')).toHaveText('2 chosen')
  await expect(page.getByTestId('onboarding-app-github')).toHaveAttribute('aria-pressed', 'true')

  // Skip setup is on every step, top right. It opens a default first window: the colours and mode
  // from before the theme step, and none of the Favorites picked (D44).
  await closing(page, () => page.getByTestId('onboarding-skip').click())
  const shell = await viewPage(app, 'shell')
  await expect(shell.getByTestId('sidebar')).toBeVisible()
  await expect.poll(() => onboardingOpen(app)).toBe(false)
  const s = await state(app)
  expect(s.settings.onboarded).toBe(true)
  expect(s.settings.onboardingStep).toBeUndefined()
  expect(s.profiles[DEFAULT_PROFILE_ID]?.favorites).toEqual([])
  expect(s.spaces[s.spaceOrder[0] as string]?.theme).toEqual(neutral)
  expect(s.settings.appearance).toBe(mode)
  expect(s.settings).not.toHaveProperty('onboardingFavorites')
  expect(s.settings).not.toHaveProperty('onboardingThemeBefore')

  // Later starts go straight to a browser window, even with none to restore (every window closed).
  await app.close()
  const file = join(userData, 'orbit-state.json')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  saved.windows = {}
  writeFileSync(file, JSON.stringify(saved))
  orbit = await launchWithOnboarding(userData)
  app = orbit.app
  await expect((await viewPage(app, 'shell')).getByTestId('sidebar')).toBeVisible()
  expect(await onboardingOpen(app)).toBe(false)
  expect(await browserWindowIds(app)).toHaveLength(1)
})

test('[OB-01] launching Orbit again while onboarding is open brings onboarding forward, with no browser window beside it', async () => {
  orbit = await launchWithOnboarding()
  const { app } = orbit
  await onboardingPage(app, 'welcome')
  const focusedTitle = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.getTitle())
  // Another app's window has focus (a plain window stands in for it)…
  await app.evaluate(({ BrowserWindow }) => {
    new BrowserWindow({ width: 320, height: 240, title: 'Elsewhere' }).focus()
  })
  await expect.poll(focusedTitle).toBe('Elsewhere')
  // …when Orbit is launched again, with no link (Linux and Windows: a second instance).
  await app.evaluate(({ app: electronApp }) => {
    electronApp.emit('second-instance', {}, [process.execPath], process.cwd())
  })
  expect(await browserWindowIds(app)).toEqual([])
  await expect.poll(focusedTitle).toBe('Welcome to Orbit')
  expect((await state(app)).settings.onboarded).toBe(false)
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) if (w.getTitle() === 'Elsewhere') w.destroy()
  })
})

test('[OB-01] an existing install never gets onboarding: its window comes back at launch and when reopened with none open', async () => {
  // A state file as Orbit wrote it before onboarding existed: onboarded false, no step, one window.
  orbit = await launchFirstRun()
  let { app } = orbit
  const { userData } = orbit
  await expect((await viewPage(app, 'shell')).getByTestId('sidebar')).toBeVisible()
  await app.close()
  const saved = JSON.parse(readFileSync(join(userData, 'orbit-state.json'), 'utf8'))
  expect(saved.settings.onboarded).toBe(false)
  expect(saved.settings).not.toHaveProperty('onboardingStep')
  const [windowId] = Object.keys(saved.windows)
  expect(Object.keys(saved.windows)).toHaveLength(1)

  orbit = await launchWithOnboarding(userData)
  app = orbit.app
  await expect((await viewPage(app, 'shell')).getByTestId('sidebar')).toBeVisible()
  expect((await state(app)).settings.onboarded).toBe(true)

  // macOS: closing the last window keeps Orbit running, and a Dock click (activate) reopens it.
  await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    electronApp.removeAllListeners('window-all-closed')
    electronApp.on('window-all-closed', () => {})
    for (const win of BrowserWindow.getAllWindows()) win.close()
  })
  await expect.poll(() => browserWindowIds(app)).toEqual([])
  await app.evaluate(({ app: electronApp }) => {
    electronApp.emit('activate')
  })
  await expect.poll(() => browserWindowIds(app)).toEqual([windowId])
  expect(await onboardingOpen(app)).toBe(false)
})

test('[OB-14] Reset Onboarding runs it again over the open window and keeps everything; browser keys rest meanwhile', async () => {
  orbit = await launchFirstRun({ env: NO_BROWSERS })
  const { app } = orbit
  const shell = await viewPage(app, 'shell')
  await expect(shell.getByTestId('sidebar')).toBeVisible()
  // Something to keep: a Favorite (added unloaded).
  const favorite = await run(app, 'tabs.create', {
    url: 'https://example.com/',
    container: { kind: 'favorites', profileId: DEFAULT_PROFILE_ID },
    activate: false,
  })
  const tabs = Object.keys((await state(app)).tabs).sort()
  expect(tabs).toContain(favorite)
  // From the command bar.
  await shell.keyboard.press(`${MOD}+T`)
  const overlay = await viewPage(app, 'overlay')
  const input = overlay.getByTestId('command-input')
  await expect(input).toBeFocused()
  await input.fill('reset onboarding')
  const top = overlay.getByTestId('command-result').first()
  await expect(top).toHaveAttribute('data-kind', 'action')
  await expect(top).toContainText('Reset Onboarding')
  await input.press('Enter')
  const page = await onboardingPage(app, 'welcome')
  expect((await state(app)).settings.onboarded).toBe(false)

  // Keys meant for a browser window do nothing here: no tab, window or command bar appears.
  const [windowId] = await browserWindowIds(app)
  await page.keyboard.press(`${MOD}+T`)
  await page.keyboard.press(`${MOD}+N`)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('onboarding-step-import')).toBeVisible()
  expect(await browserWindowIds(app)).toEqual([windowId])
  expect((await state(app)).windows[windowId as string]?.overlay.kind).toBe('none')
  expect(Object.keys((await state(app)).tabs).sort()).toEqual(tabs)

  // Finishing goes back to the same window; nothing was deleted.
  await next(page, 'theme')
  await next(page, 'favorites')
  await next(page, 'ads')
  await next(page, 'browser')
  await page.getByTestId('onboarding-browser-later').click()
  await expect(page.getByTestId('onboarding-step-done')).toBeVisible()
  await expect(page.getByTestId('onboarding-start')).toHaveText('Back to browsing')
  await closing(page, () => page.getByTestId('onboarding-start').click())
  await expect.poll(() => onboardingOpen(app)).toBe(false)
  await expect.poll(() => browserFocused(app)).toBe(true)
  expect(await browserWindowIds(app)).toEqual([windowId])
  expect(Object.keys((await state(app)).tabs).sort()).toEqual(tabs)
  expect((await state(app)).settings.onboarded).toBe(true)

  // ⌘W closes it like any window, leaving the browser window as it was.
  await action(app, 'onboarding.reset')
  const again = await onboardingPage(app, 'welcome')
  await closing(again, () => again.keyboard.press(`${MOD}+W`))
  await expect.poll(() => onboardingOpen(app)).toBe(false)
  expect(await browserWindowIds(app)).toEqual([windowId])
  expect(Object.keys((await state(app)).tabs).sort()).toEqual(tabs)
})
