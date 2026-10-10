import { expect, test } from '@playwright/test'
import { DEFAULT_PROFILE_ID } from '../../src/shared/defaults'
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

/** Runs a command-bar action by typing its name in the browser window's command bar. */
async function runFromCommandBar(name: string): Promise<void> {
  await focusBrowserWindow(orbit.app)
  await expect.poll(() => browserFocused(orbit.app)).toBe(true)
  await orbit.shell.keyboard.press(`${MOD}+T`)
  const overlay = await viewPage(orbit.app, 'overlay')
  const input = overlay.getByTestId('command-input')
  await expect(input).toBeFocused()
  await input.fill(name.toLowerCase())
  const top = overlay.getByTestId('command-result').first()
  await expect(top).toHaveAttribute('data-kind', 'action')
  await expect(top).toContainText(name)
  await input.press('Enter')
}

test('[ST-02] Settings sections and settings are command-bar actions that open Settings there', async () => {
  await runFromCommandBar('Site Search Settings')
  const page = await pageOfView(orbit.app, 'settings')
  await expect(page.getByTestId('settings-tab-search')).toHaveAttribute('aria-selected', 'true')
  // Scrolled to the setting.
  await expect(page.locator('[data-setting-group="site-search"]')).toBeInViewport()
  await expect.poll(async () => (await settingsWindows()).map((w) => w.focused)).toEqual([true])

  // Another one moves the same window.
  await runFromCommandBar('Appearance Settings')
  await expect(page.getByTestId('settings-tab-appearance')).toHaveAttribute('aria-selected', 'true')
  await expect.poll(async () => (await settingsWindows()).map((w) => w.focused)).toEqual([true])
})

test('[ST-03][ST-02] General: make Orbit the default browser from Settings or the command bar', async () => {
  const page = await openSettings(orbit.app, { section: 'general' })
  // (Test runs use a stand-in: the OS setting never changes.)
  await page.getByTestId('default-browser-set').click()
  await expect(page.getByTestId('default-browser-status')).toHaveText('Orbit is your default browser')
  // Import shows only once the import flow exists (IM-01).
  await expect(page.getByTestId('setting-import')).toHaveCount(0)
  await page.getByTestId('settings-tab-about').click()

  // The command bar action opens General at that setting.
  await runFromCommandBar('Set as Default Browser')
  await expect(page.getByTestId('settings-tab-general')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('[data-setting="default-browser"]')).toBeInViewport()
  await expect(page.getByTestId('default-browser-status')).toBeVisible()
})

// ---- Profiles (ST-04, ST-05, ST-20) ----

test('[ST-04][ST-20] Profiles: Default first, rename any profile, new profiles, delete only once no Space uses it', async () => {
  const spaceId = (await run(orbit.app, 'spaces.create', { name: 'Client', activate: false })) as string
  const work = (await run(orbit.app, 'profiles.create', { name: 'Work', assignSpaceId: spaceId })) as string
  const page = await openSettings(orbit.app, { section: 'profiles' })
  const list = page.getByTestId('profile-list').getByRole('option')
  await expect(list).toHaveCount(2)
  await expect(list.first()).toContainText('Default')
  await expect(list.nth(1)).toContainText('Work')
  await expect(list.nth(1)).toContainText('Used by 1 Space')

  // The Default profile can be renamed; it applies without a Save button.
  const name = page.getByTestId('profile-name')
  await name.fill('Personal')
  await name.press('Enter')
  await expect.poll(async () => (await state(orbit.app)).profiles[DEFAULT_PROFILE_ID]?.name).toBe('Personal')
  await expect(list.first()).toContainText('Personal')
  await expect(page.getByTestId('profile-delete')).toHaveCount(0)

  // Work is in use: Delete is off and says why.
  await list.nth(1).click()
  await expect(page.getByTestId('setting-profile-spaces')).toContainText('Client')
  await expect(page.getByTestId('profile-delete')).toBeDisabled()
  await expect(page.getByTestId('setting-profile-delete')).toContainText('Give it another profile first')
  await run(orbit.app, 'spaces.update', { spaceId, profileId: DEFAULT_PROFILE_ID })
  await expect(page.getByTestId('profile-delete')).toBeEnabled()
  await page.getByTestId('profile-delete').click()
  const dialog = page.getByTestId('profile-delete-dialog')
  await expect(dialog).toBeVisible()
  // Escape keeps it.
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect((await state(orbit.app)).profiles[work]).toBeDefined()
  await page.getByTestId('profile-delete').click()
  await page.getByTestId('profile-delete-confirm').click()
  await expect.poll(async () => (await state(orbit.app)).profiles[work]).toBeUndefined()
  await expect(list).toHaveCount(1)
  await expect(list.first()).toHaveAttribute('aria-selected', 'true')

  // New profile…: created empty and shown.
  await page.getByTestId('profile-new').click()
  await page.getByTestId('profile-new-name').fill('Side Project')
  await page.getByTestId('profile-new-create').click()
  await expect(list).toHaveCount(2)
  await expect(list.nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('profile-name')).toHaveValue('Side Project')
  await expect(page.getByTestId('setting-profile-spaces')).toContainText('No Space uses this profile.')

  // Its search engine is chosen here too; the engines themselves are in Search.
  await expect(page.getByTestId('setting-profile-search-engine').locator('.st-scope')).toHaveText('Side Project')
  await page.getByTestId('profile-search-settings').click()
  await expect(page.getByTestId('settings-tab-search')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('[data-setting-group="site-search"]')).toBeInViewport()
})

test('[ST-05][ST-20] archive timing per profile: 12 hours by default, up to 30 days, never off; others follow Default until set', async () => {
  const work = (await run(orbit.app, 'profiles.create', { name: 'Work' })) as string
  const page = await openSettings(orbit.app, { section: 'profiles' })
  const defaults = page.getByTestId(`archive-after-${DEFAULT_PROFILE_ID}`)
  await expect(defaults.locator('option')).toHaveText(['12 hours', '24 hours', '7 days', '30 days'])
  await expect(defaults).toHaveValue(String(12 * 3_600_000))
  await defaults.selectOption({ label: '7 days' })
  await expect
    .poll(async () => (await state(orbit.app)).profiles[DEFAULT_PROFILE_ID]?.archiveAfterMs)
    .toBe(7 * 86_400_000)

  await page.getByTestId(`profile-${work}`).click()
  const own = page.getByTestId(`archive-after-${work}`)
  // Labelled with its profile (ST-20); follows Default until changed.
  await expect(page.getByTestId('setting-archive-after').locator('.st-scope')).toHaveText('Work')
  await expect(own).toHaveValue('-1')
  await expect(own.locator('option:checked')).toHaveText('Same as Default (7 days)')
  await own.selectOption({ label: '24 hours' })
  await expect.poll(async () => (await state(orbit.app)).profiles[work]?.archiveAfterMs).toBe(86_400_000)
  await own.selectOption({ label: 'Same as Default (7 days)' })
  await expect.poll(async () => (await state(orbit.app)).profiles[work]).not.toHaveProperty('archiveAfterMs')
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

// ---- Search engines (ST-06) ----

/** Types a search into the browser window's command bar and returns the URL of the tab it opens. */
async function searchFromCommandBar(text: string): Promise<string> {
  await focusBrowserWindow(orbit.app)
  await expect.poll(() => browserFocused(orbit.app)).toBe(true)
  const before = new Set(Object.keys((await state(orbit.app)).tabs))
  await orbit.shell.keyboard.press(`${MOD}+T`)
  const overlay = await viewPage(orbit.app, 'overlay')
  const input = overlay.getByTestId('command-input')
  await expect(input).toBeFocused()
  await input.fill(text)
  const top = overlay.getByTestId('command-result').first()
  await expect(top).toHaveAttribute('data-kind', 'search')
  await expect(top).toContainText(text)
  await input.press('Enter')
  let url = ''
  await expect
    .poll(async () => {
      const tab = Object.values((await state(orbit.app)).tabs).find((t) => !before.has(t.id))
      url = tab?.url ?? ''
      return url
    })
    .not.toBe('')
  return url
}

test('[ST-06] the default search engine chosen in Settings is the one the command bar searches with', async () => {
  const page = await openSettings(orbit.app, { section: 'search' })
  const select = page.getByTestId(`search-engine-${DEFAULT_PROFILE_ID}`)
  await expect(select).toHaveValue('google')
  // Orbit's list (ST-06), plain search URLs.
  await expect(select.locator('option')).toHaveText([
    'Google',
    'Bing',
    'DuckDuckGo',
    'Brave Search',
    'Ecosia',
    'Startpage',
    'Kagi',
    'Perplexity',
  ])
  await select.selectOption({ label: 'DuckDuckGo' })
  await expect.poll(async () => (await state(orbit.app)).profiles[DEFAULT_PROFILE_ID]?.searchEngine).toBe('duckduckgo')
  expect(await searchFromCommandBar('orbit settings test')).toBe('https://duckduckgo.com/?q=orbit+settings+test')
})

test('[ST-06][ST-20] each profile has its own default search engine, labelled with the profile', async () => {
  const spaceId = (await run(orbit.app, 'spaces.create', { name: 'Work', activate: false })) as string
  const work = (await run(orbit.app, 'profiles.create', { name: 'Work', assignSpaceId: spaceId })) as string
  const page = await openSettings(orbit.app, { section: 'search' })
  await expect(page.getByTestId(`setting-search-engine-${DEFAULT_PROFILE_ID}`).locator('.st-scope')).toHaveText(
    'Default',
  )
  await expect(page.getByTestId(`setting-search-engine-${work}`).locator('.st-scope')).toHaveText('Work')
  await page.getByTestId(`search-engine-${work}`).selectOption({ label: 'Bing' })
  await expect.poll(async () => (await state(orbit.app)).profiles[work]?.searchEngine).toBe('bing')

  // The Default profile's Space still searches Google; the Work Space searches Bing.
  expect(await searchFromCommandBar('first query')).toBe('https://www.google.com/search?q=first+query')
  await run(orbit.app, 'spaces.switch', { spaceId })
  expect(await searchFromCommandBar('second query')).toBe('https://www.bing.com/search?q=second+query')
})

test('[ST-06] a custom engine can be added, made the default, and removed', async () => {
  const page = await openSettings(orbit.app, { section: 'search' })
  await page.getByTestId('site-search-add').click()
  await page.getByTestId('site-search-name').fill('Fixture Search')
  // A keyword already in use is refused, with the reason next to it.
  await page.getByTestId('site-search-keyword').fill('YT')
  await page.getByTestId('site-search-url').fill(fx.url('/find?q=%s'))
  await page.getByTestId('site-search-save').click()
  await expect(page.getByRole('alert')).toHaveText('YouTube already uses “yt”')
  await page.getByTestId('site-search-keyword').fill('fxs')
  await page.getByTestId('site-search-save').click()
  await expect(page.getByTestId('site-search-form')).toHaveCount(0)

  const site = (await state(orbit.app)).settings.siteSearch.find((s) => s.keyword === 'fxs')
  expect(site).toMatchObject({ name: 'Fixture Search', url: fx.url('/find?q=%s') })
  const id = site?.id as string
  await page.getByTestId(`site-search-menu-${id}`).click()
  await page.getByRole('menuitem', { name: 'Make default' }).click()
  await expect(page.getByTestId(`setting-site-search-${id}`).locator('.st-badge')).toHaveText('Default')
  await expect(page.getByTestId(`search-engine-${DEFAULT_PROFILE_ID}`)).toHaveValue(`site:${id}`)
  expect(await searchFromCommandBar('custom query')).toBe(fx.url('/find?q=custom+query'))

  // Removing it: the profile searches Google again.
  await page.getByTestId(`site-search-menu-${id}`).click()
  await page.getByRole('menuitem', { name: 'Remove' }).click()
  await expect(page.getByTestId(`setting-site-search-${id}`)).toHaveCount(0)
  await expect(page.getByTestId(`search-engine-${DEFAULT_PROFILE_ID}`)).toHaveValue('google')
  expect((await state(orbit.app)).profiles[DEFAULT_PROFILE_ID]?.searchEngine).toBeUndefined()
})

// ---- Links (ST-09) ----

/** Another app asks Orbit to open a URL (macOS open-url; the other platforms share the route). */
async function openFromOtherApp(url: string): Promise<void> {
  await orbit.app.evaluate(({ app }, u) => app.emit('open-url', { preventDefault() {} }, u), url)
}

/** The URLs of a Space's Today tabs. */
async function todayUrls(spaceId: string): Promise<string[]> {
  const s = await state(orbit.app)
  return (s.spaces[spaceId]?.today ?? []).map((id) => s.tabs[id]?.url ?? '')
}

test('[ST-09][MW-11] Links: links from other apps open in a Mini Window, the most recent Space or a chosen one', async () => {
  const first = (await state(orbit.app)).spaceOrder[0] as string
  const firstName = (await state(orbit.app)).spaces[first]?.name as string
  const work = (await run(orbit.app, 'spaces.create', { name: 'Work', activate: false })) as string
  const page = await openSettings(orbit.app, { section: 'links' })
  const choice = page.getByTestId('external-links')
  await expect(choice).toHaveValue('mini')
  await expect(choice.locator('option')).toHaveText(['A Mini Window', 'The most recent Space', firstName, 'Work'])
  const links = async () => {
    const s = (await state(orbit.app)).settings
    return [s.miniWindowForExternalLinks, s.externalLinksSpace]
  }

  await choice.selectOption({ label: 'Work' })
  await expect.poll(links).toEqual([false, work])
  await openFromOtherApp(fx.url('/page/FromMail'))
  await expect.poll(() => todayUrls(work)).toContain(fx.url('/page/FromMail'))

  await choice.selectOption({ label: 'The most recent Space' })
  await expect.poll(links).toEqual([false, null])
  await choice.selectOption({ label: 'A Mini Window' })
  await expect.poll(async () => (await links())[0]).toBe(true)

  // Peek options (PK-12, PK-03): both on by default.
  for (const [testId, key] of [
    ['peek-external-links', 'peekExternalLinks'],
    ['peek-shift-click', 'peekShiftClick'],
  ] as const) {
    await expect(page.getByTestId(testId)).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId(testId).click()
    await expect.poll(async () => (await state(orbit.app)).settings[key]).toBe(false)
  }
})

test('[ST-09] link routing rules: add, reorder, edit and remove; a link that matches opens in the rule’s Space', async () => {
  const first = (await state(orbit.app)).spaceOrder[0] as string
  const work = (await run(orbit.app, 'spaces.create', { name: 'Work', activate: false })) as string
  const page = await openSettings(orbit.app, { section: 'links' })
  const rules = async () => (await state(orbit.app)).settings.linkRules
  const addRule = async (match: 'contains' | 'exact', value: string, space: string) => {
    await page.getByTestId('link-rule-add').click()
    await page.getByTestId('link-rule-match').selectOption(match)
    await page.getByTestId('link-rule-value').fill(value)
    await page.getByTestId('link-rule-space').selectOption({ label: space })
    await page.getByTestId('link-rule-save').click()
    await expect(page.getByTestId('link-rule-form')).toHaveCount(0)
  }

  // An empty rule is refused in place.
  await page.getByTestId('link-rule-add').click()
  await page.getByTestId('link-rule-save').click()
  await expect(page.getByRole('alert')).toHaveText('Enter part of an address, such as a domain')
  await page.getByTestId('link-rule-value').press('Escape')
  await expect(page.getByTestId('link-rule-form')).toHaveCount(0)

  await addRule('contains', 'localhost', 'Work')
  const firstName = (await state(orbit.app)).spaces[first]?.name as string
  await addRule('exact', fx.url('/page/Exact'), firstName)
  await expect.poll(rules).toEqual([
    { match: 'contains', value: 'localhost', spaceId: work },
    { match: 'exact', value: fx.url('/page/Exact'), spaceId: first },
  ])
  await expect(page.getByTestId('setting-link-rule-0')).toContainText('Opens in Work')

  // The first rule that matches wins: the exact one moves up.
  await page.getByTestId('link-rule-menu-1').click()
  await page.getByTestId('link-rule-up').click()
  await expect.poll(async () => (await rules()).map((r) => r.match)).toEqual(['exact', 'contains'])
  await openFromOtherApp(fx.url('/page/Exact'))
  await expect.poll(() => todayUrls(first)).toContain(fx.url('/page/Exact'))
  // With Mini Windows on, a link a rule matches still opens in its Space.
  await openFromOtherApp(fx.url('/page/Routed'))
  await expect.poll(() => todayUrls(work)).toContain(fx.url('/page/Routed'))

  await page.getByTestId('link-rule-menu-1').click()
  await page.getByTestId('link-rule-edit').click()
  await page.getByTestId('link-rule-value').fill('figma.com')
  await page.getByTestId('link-rule-save').click()
  await expect.poll(async () => (await rules())[1]?.value).toBe('figma.com')

  await page.getByTestId('link-rule-menu-0').click()
  await page.getByTestId('link-rule-remove').click()
  await expect.poll(rules).toEqual([{ match: 'contains', value: 'figma.com', spaceId: work }])
})

// ---- Advanced (ST-10) and Privacy & security (ST-12) ----

test('[ST-10][TB-16] Advanced: when inactive tabs sleep, and picture in picture', async () => {
  const page = await openSettings(orbit.app, { section: 'advanced' })
  const sleep = page.getByTestId('sleep-after')
  await expect(sleep.locator('option')).toHaveText(['15 minutes', '30 minutes', '1 hour', '2 hours', 'Never'])
  await expect(sleep).toHaveValue(String(30 * 60_000))
  await sleep.selectOption({ label: '2 hours' })
  await expect.poll(async () => (await state(orbit.app)).settings.sleepAfterMs).toBe(2 * 3_600_000)
  await sleep.selectOption({ label: 'Never' })
  await expect.poll(async () => (await state(orbit.app)).settings.sleepAfterMs).toBe(0)

  await expect(page.getByTestId('auto-pip')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('auto-pip').click()
  await expect.poll(async () => (await state(orbit.app)).settings.autoPip).toBe(false)
})

test('[ST-12][ST-10] graphics acceleration can be turned off; it applies from the next start', async () => {
  const userData = orbit.userData
  const page = await openSettings(orbit.app, { section: 'advanced' })
  const row = page.getByTestId('setting-hardware-acceleration')
  await expect(page.getByTestId('hardware-acceleration')).toHaveAttribute('aria-checked', 'true')
  await expect(row).toContainText('Turn this off if pages flicker')
  await page.getByTestId('hardware-acceleration').click()
  await expect(row).toContainText('Restart Orbit to apply this.')
  // A test run never restarts Orbit itself.
  await expect(page.getByTestId('relaunch')).toHaveCount(0)

  await orbit.app.close()
  orbit = await launchOrbit({ userData })
  expect(await orbit.app.evaluate(({ app }) => app.isHardwareAccelerationEnabled())).toBe(false)
  expect(await run(orbit.app, 'settings.systemStatus', {})).toMatchObject({ hardwareAcceleration: false })
  const again = await openSettings(orbit.app, { section: 'advanced' })
  await expect(again.getByTestId('hardware-acceleration')).toHaveAttribute('aria-checked', 'false')
  await expect(again.getByTestId('setting-hardware-acceleration')).not.toContainText('Restart')
  await again.getByTestId('hardware-acceleration').click()
  await expect(again.getByTestId('setting-hardware-acceleration')).toContainText('Restart Orbit to apply this.')

  // Back on from the next start (whether it is used also depends on the machine's GPU).
  await orbit.app.close()
  orbit = await launchOrbit({ userData })
  expect(await run(orbit.app, 'settings.systemStatus', {})).toMatchObject({ hardwareAcceleration: true })
  const last = await openSettings(orbit.app, { section: 'advanced' })
  await expect(last.getByTestId('hardware-acceleration')).toHaveAttribute('aria-checked', 'true')
  await expect(last.getByTestId('setting-hardware-acceleration')).not.toContainText('Restart')
})

test('[ST-12] Privacy: Orbit says what it sends (nothing); Secure DNS can be turned off or pinned to a provider', async () => {
  const page = await openSettings(orbit.app, { section: 'privacy' })
  await expect(page.getByTestId('privacy-promise')).toContainText('Orbit has no servers and no accounts')
  const dns = page.getByTestId('secure-dns')
  await expect(dns).toHaveValue('automatic')
  await dns.selectOption({ label: 'Off' })
  await expect.poll(async () => (await state(orbit.app)).settings.secureDns).toBe('off')
  await dns.selectOption({ label: 'Automatic' })
  await expect.poll(async () => (await state(orbit.app)).settings.secureDns).toBe('automatic')
})

test('[ST-12][KS-12] Clear browsing data: ⌘⇧⌫ opens it; history and site data go, the cache stays when unticked', async () => {
  const url = fx.url('/page/Cookie')
  await run(orbit.app, 'tabs.create', { url })
  const site = await tabPage(orbit.app, '/page/Cookie')
  await site.waitForLoadState('domcontentloaded')
  await site.evaluate(async () => {
    type CookieStore = { set: (c: { name: string; value: string; expires: number }) => Promise<void> }
    await (globalThis as unknown as { cookieStore: CookieStore }).cookieStore.set({
      name: 'orbit',
      value: '1',
      expires: Date.now() + 3_600_000,
    })
    localStorage.setItem('orbit', '1')
  })
  const visits = () => run(orbit.app, 'history.visits', { profileId: DEFAULT_PROFILE_ID }) as Promise<unknown[]>
  const partition = (await state(orbit.app)).profiles[DEFAULT_PROFILE_ID]?.partition as string
  const cookies = () =>
    orbit.app.evaluate(
      async ({ session }, p) => (await session.fromPartition(p).cookies.get({})).map((c) => c.name),
      partition,
    )
  await expect.poll(async () => (await visits()).length).toBeGreaterThan(0)
  await expect.poll(cookies).toContain('orbit')

  await focusBrowserWindow(orbit.app)
  await expect.poll(() => browserFocused(orbit.app)).toBe(true)
  await orbit.shell.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+Backspace' : 'Control+Shift+Delete')
  const page = await pageOfView(orbit.app, 'settings')
  const dialog = page.getByTestId('clear-data-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('From the profile “Default”.')
  await expect(page.getByTestId('clear-data-range')).toHaveValue('hour')
  await page.getByTestId('clear-data-cache').click()
  await page.getByTestId('clear-data-confirm').click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('clear-data-status')).toHaveText('Deleted from Default')
  await expect.poll(async () => (await visits()).length).toBe(0)
  await expect.poll(cookies).not.toContain('orbit')
  await site.reload()
  expect(await site.evaluate(() => localStorage.getItem('orbit'))).toBeNull()

  // Coming back to Privacy doesn't open the dialog again.
  await page.getByTestId('settings-tab-general').click()
  await page.getByTestId('settings-tab-privacy').click()
  await expect(page.getByTestId('setting-clear-data')).toBeVisible()
  await expect(dialog).toHaveCount(0)
})
