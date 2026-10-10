import { expect, test } from '@playwright/test'
import type { SpaceTheme } from '../../src/shared/state'
import { paletteFor } from '../../src/shared/theme'
import {
  type Fixtures,
  FRAME_SLACK,
  launchOrbit,
  MOD,
  type Orbit,
  run,
  startFixtures,
  state,
  tabPage,
  viewPage,
} from './helpers'
import {
  browserFocused,
  focusBrowserWindow,
  mainSeq,
  type OrbitGlobal,
  openSettings,
  osWindows,
  pageOfView,
  viewSeq,
} from './settings-support'

/** The Settings window (ST-*) and the global appearance (AP-01). Feature IDs lead each title. */

let fx: Fixtures
let orbit: Orbit

test.beforeAll(async () => {
  fx = await startFixtures()
})
test.afterAll(async () => {
  await fx.close()
})
test.beforeEach(async () => {
  orbit = await launchOrbit()
})
test.afterEach(async () => {
  await orbit.app.close().catch(() => {})
})

const settingsWindows = () => osWindows(orbit.app, 'settings')
const browserWindowIds = () => orbit.app.evaluate(() => (globalThis as unknown as OrbitGlobal).__orbit.windowIds())

test('[ST-01][KS-12] ⌘, opens one Settings window; ⌘, again brings that same window to the front', async () => {
  await orbit.shell.keyboard.press(`${MOD}+Comma`)
  const page = await pageOfView(orbit.app, 'settings')
  await expect(page.getByTestId('settings')).toBeVisible()
  await expect
    .poll(async () => (await settingsWindows()).map((w) => ({ visible: w.visible, focused: w.focused })))
    .toEqual([{ visible: true, focused: true }])
  // A separate window: the browser window is still there, unchanged.
  expect(await browserWindowIds()).toHaveLength(1)

  // Back in the browser window, ⌘, brings the same Settings window to the front.
  await focusBrowserWindow(orbit.app)
  await expect.poll(() => browserFocused(orbit.app)).toBe(true)
  await orbit.shell.keyboard.press(`${MOD}+Comma`)
  await expect.poll(async () => (await settingsWindows()).map((w) => w.focused)).toEqual([true])
  expect(await browserFocused(orbit.app)).toBe(false)

  // ⌘, in Settings keeps the one window.
  await page.keyboard.press(`${MOD}+Comma`)
  await expect.poll(async () => (await settingsWindows()).map((w) => w.focused)).toEqual([true])
  expect(orbit.app.windows().filter((p) => p.url().includes('view=settings') && !p.isClosed())).toHaveLength(1)
})

test('[ST-01] a change applies at once, with no Save button, and is still there after a restart', async () => {
  const userData = orbit.userData
  let page = await openSettings(orbit.app)
  await page.getByTestId('settings-tab-appearance').click()
  await expect(page.getByTestId('settings-content')).toHaveAttribute('data-section', 'appearance')
  await page.getByTestId('settings-appearance-dark').click()
  await expect.poll(async () => (await state(orbit.app)).settings.appearance).toBe('dark')
  await expect.poll(() => orbit.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark')
  await expect(page.getByTestId('settings')).toHaveAttribute('data-dark', '')
  await expect(page.getByRole('button', { name: /^save/i })).toHaveCount(0)

  await page.getByTestId('settings-tab-general').click()
  await page.getByTestId('mini-window-archive').selectOption({ label: 'Never' })
  await expect.poll(async () => (await state(orbit.app)).settings.miniWindowArchiveAfterMs).toBe(0)

  await orbit.app.close()
  orbit = await launchOrbit({ userData })
  const s = await state(orbit.app)
  expect(s.settings.appearance).toBe('dark')
  expect(s.settings.miniWindowArchiveAfterMs).toBe(0)
  page = await openSettings(orbit.app)
  await expect(page.getByTestId('mini-window-archive')).toHaveValue('0')
  await expect(page.getByTestId('settings')).toHaveAttribute('data-dark', '')
})

test('[ST-01] Settings reopens at its last section and size, also after a restart; ⌘W closes only Settings', async () => {
  const userData = orbit.userData
  const tabId = (await run(orbit.app, 'tabs.create', { url: fx.url('/page/Stays') })) as string
  let page = await openSettings(orbit.app)
  await page.getByTestId('settings-tab-about').click()
  await expect(page.getByTestId('settings-content')).toHaveAttribute('data-section', 'about')
  await orbit.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('view=settings'))
    win?.setSize(700, 520)
  })
  await expect
    .poll(async () => (await state(orbit.app)).settings.settingsWindowSize)
    .toEqual({ width: 700, height: 520 })

  // ⌘W in Settings closes Settings, not a tab of the browser window. (The window is gone before
  // the key comes back up: Playwright then reports the page closed.)
  await page.keyboard.press(`${MOD}+W`).catch((e: Error) => expect(e.message).toContain('closed'))
  await expect.poll(async () => (await settingsWindows()).length).toBe(0)
  expect((await state(orbit.app)).tabs[tabId]).toBeDefined()
  expect(await browserWindowIds()).toHaveLength(1)

  page = await openSettings(orbit.app)
  await expect(page.getByTestId('settings-content')).toHaveAttribute('data-section', 'about')
  expect((await settingsWindows())[0]?.bounds).toMatchObject({ width: 700, height: 520 })

  await orbit.app.close()
  orbit = await launchOrbit({ userData })
  page = await openSettings(orbit.app)
  await expect(page.getByTestId('settings-content')).toHaveAttribute('data-section', 'about')
  expect((await settingsWindows())[0]?.bounds).toMatchObject({ width: 700, height: 520 })
})

test('[ST-01] Settings left open behind the browser window does no work while you browse', async () => {
  const page = await openSettings(orbit.app)
  await expect(page.getByTestId('setting-mini-window-archive')).toBeVisible()
  // Chromium throttles its timers and frames while it is in the background.
  expect((await settingsWindows())[0]?.throttled).toBe(true)
  await focusBrowserWindow(orbit.app)
  await expect.poll(() => browserFocused(orbit.app)).toBe(true)
  const commits = () =>
    page.evaluate(() =>
      (globalThis as unknown as { __orbitSettings: { commits: () => number } }).__orbitSettings.commits(),
    )
  const before = await commits()

  // Browse: open pages, switch between them, rename and close one.
  const a = (await run(orbit.app, 'tabs.create', { url: fx.url('/page/One') })) as string
  await tabPage(orbit.app, '/page/One')
  const b = (await run(orbit.app, 'tabs.create', { url: fx.url('/page/Two') })) as string
  await tabPage(orbit.app, '/page/Two')
  await run(orbit.app, 'tabs.activate', { tabId: a })
  await run(orbit.app, 'tabs.rename', { tabId: b, title: 'Renamed' })
  await run(orbit.app, 'tabs.close', { tabId: b })
  await expect.poll(async () => (await state(orbit.app)).tabs[a]?.title).toBe('One')

  // Every change reached Settings' copy of the state, and none of it rendered Settings.
  const seq = await mainSeq(orbit.app)
  await expect.poll(() => viewSeq(page)).toBeGreaterThanOrEqual(seq)
  expect(await commits()).toBe(before)
})

test('[ST-01] in Settings, ⌘F searches Settings and ⌘T opens the command bar in the browser window', async () => {
  const [windowId] = await browserWindowIds()
  const page = await openSettings(orbit.app)
  await page.keyboard.press(`${MOD}+F`)
  await expect(page.getByTestId('settings-search')).toBeFocused()

  await page.keyboard.press(`${MOD}+T`)
  await expect.poll(async () => (await state(orbit.app)).windows[windowId as string]?.overlay.kind).toBe('commandbar')
  await expect.poll(() => browserFocused(orbit.app)).toBe(true)
  // Settings stays open behind it.
  expect(await settingsWindows()).toHaveLength(1)
})

// ---- Appearance (AP-01, ST-11) ----

test('[AP-01][ST-11] Light, Dark or Match system, chosen in Settings, turns every window, the command bar, menus, pages and Settings at once', async () => {
  await run(orbit.app, 'tabs.create', { url: fx.url('/page/Shade') })
  const web = await tabPage(orbit.app, '/page/Shade')
  const overlay = await viewPage(orbit.app, 'overlay')
  const page = await openSettings(orbit.app, { section: 'appearance' })
  // Playwright pins pages to a light colour scheme unless told not to.
  for (const p of [orbit.shell, overlay, web]) await p.emulateMedia({ colorScheme: null })
  const looks = async () => ({
    // Native menus and dialogs follow the native theme.
    menus: await orbit.app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors),
    sidebar: await orbit.shell.evaluate(() => !!document.querySelector('[data-testid="shell"][data-dark]')),
    commandBar: await overlay.evaluate(() => {
      const el = document.querySelector('[data-testid="overlay"]')
      return el ? getComputedStyle(el).colorScheme : ''
    }),
    // Web pages get prefers-color-scheme.
    page: await web.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches),
    settings: await page.evaluate(() => !!document.querySelector('[data-testid="settings"][data-dark]')),
  })
  const everywhere = (dark: boolean) => ({
    menus: dark,
    sidebar: dark,
    commandBar: dark ? 'dark' : 'light',
    page: dark,
    settings: dark,
  })

  for (const mode of ['dark', 'light'] as const) {
    const started = Date.now()
    await page.getByTestId(`settings-appearance-${mode}`).click()
    await expect.poll(looks, { intervals: [50] }).toEqual(everywhere(mode === 'dark'))
    // "Within about 1 s" (AP-01).
    expect(Date.now() - started).toBeLessThan(1000 * FRAME_SLACK)
    await expect(page.getByTestId(`settings-appearance-${mode}`)).toHaveAttribute('aria-checked', 'true')
  }

  // The theme picker's switch is the same setting: Settings shows its choice.
  await run(orbit.app, 'spaces.setAppearance', { appearance: 'dark' })
  await expect(page.getByTestId('settings-appearance-dark')).toHaveAttribute('aria-checked', 'true')
  await expect.poll(looks).toEqual(everywhere(true))

  // Match system: the OS decides.
  await page.getByTestId('settings-appearance-system').click()
  await expect.poll(() => orbit.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('system')
  const os = await orbit.app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)
  await expect.poll(looks).toEqual(everywhere(os))
})

test('[ST-01][AP-02] Settings takes the theme colours of the Space it was opened from', async () => {
  const s = await state(orbit.app)
  const windowId = (await browserWindowIds())[0] as string
  const theme = s.spaces[s.windows[windowId]?.spaceId as string]?.theme as SpaceTheme
  const page = await openSettings(orbit.app)
  await run(orbit.app, 'spaces.setAppearance', { appearance: 'dark' })
  const accent = () =>
    page.evaluate(() =>
      getComputedStyle(document.querySelector('[data-testid="settings"]') as Element)
        .getPropertyValue('--accent')
        .trim(),
    )
  await expect.poll(accent).toBe(paletteFor(theme, true).accent)
  await run(orbit.app, 'spaces.setAppearance', { appearance: 'light' })
  await expect.poll(accent).toBe(paletteFor(theme, false).accent)
})
