import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { DEFAULT_PROFILE_ID } from '../../src/shared/defaults'
import { record } from './frames'
import { type Fixtures, launchOrbit, type Orbit, run, startFixtures, state, tabPage } from './helpers'
import { openSettings } from './settings-support'

/** The Settings sections the finish-settings lane completes (ST-03, ST-16, ST-20). Feature IDs lead each title. */

let orbit: Orbit
let fx: Fixtures

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

test('[ST-20][ST-06] another profile’s search engine is “Same as Default (…)” until it picks its own, and can go back to it', async () => {
  const spaceId = (await run(orbit.app, 'spaces.create', { name: 'Work', activate: false })) as string
  const work = (await run(orbit.app, 'profiles.create', { name: 'Work', assignSpaceId: spaceId })) as string
  const page = await openSettings(orbit.app, { section: 'search' })
  const select = page.getByTestId(`search-engine-${work}`)
  const chosen = select.locator('option:checked')
  await expect(chosen).toHaveText('Same as Default (Google)')
  // The Default profile has no such choice: it is the one others follow.
  await expect(page.getByTestId(`search-engine-${DEFAULT_PROFILE_ID}`).locator('option').first()).toHaveText('Google')

  // Work follows the Default profile's engine as it changes.
  await page.getByTestId(`search-engine-${DEFAULT_PROFILE_ID}`).selectOption({ label: 'DuckDuckGo' })
  await expect(chosen).toHaveText('Same as Default (DuckDuckGo)')
  expect((await state(orbit.app)).profiles[work]?.searchEngine).toBeUndefined()

  // An engine of its own, then back to the Default profile's.
  await select.selectOption({ label: 'Bing' })
  await expect.poll(async () => (await state(orbit.app)).profiles[work]?.searchEngine).toBe('bing')
  await expect(chosen).toHaveText('Bing')
  await select.selectOption({ label: 'Same as Default (DuckDuckGo)' })
  await expect.poll(async () => (await state(orbit.app)).profiles[work]?.searchEngine).toBeUndefined()
  await expect(chosen).toHaveText('Same as Default (DuckDuckGo)')
})

test('[ST-07] a profile’s page has its download location and opens its browsing data and site settings; nothing offers passwords, autofill or payment methods (D52)', async () => {
  const work = (await run(orbit.app, 'profiles.create', { name: 'Work' })) as string
  let page = await openSettings(orbit.app, { section: 'profiles', profileId: work })
  const group = page.locator('[data-setting-group="profile-settings"]')
  await expect(group.locator('[data-setting="download-location"]')).toContainText('Work')

  // Clear browsing data… opens the dialog for this profile, whichever window Settings came from.
  await group.getByTestId('profile-clear-data').click()
  await expect(page.getByTestId('clear-data-dialog')).toBeVisible()
  await expect(page.getByTestId('clear-data-profile')).toHaveValue(work)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('clear-data-dialog')).toHaveCount(0)

  // Site settings… opens Site settings at this profile, and "notifications" at its Notifications row.
  page = await openSettings(orbit.app, { section: 'profiles', profileId: work })
  await page.getByTestId('profile-site-settings').click()
  await expect(page.getByTestId('site-settings')).toHaveAttribute('data-profile', work)
  page = await openSettings(orbit.app, { section: 'profiles', profileId: work })
  await page.getByTestId('profile-notifications').click()
  await expect(page.getByTestId('site-settings')).toHaveAttribute('data-profile', work)
  await expect(page.locator('[data-setting="site-category-notifications"]')).toHaveAttribute('data-flash', '')
  // Opened from its own tab, Site settings is for the window's profile again.
  await page.locator('#settings-tab-profiles').click()
  await page.locator('#settings-tab-site-settings').click()
  await expect(page.getByTestId('site-settings')).toHaveAttribute('data-profile', DEFAULT_PROFILE_ID)

  // Passwords, autofill and payment methods are out of scope (D52): no row offers them.
  for (const word of ['password', 'autofill', 'payment']) {
    await page.getByTestId('settings-search').fill(word)
    await expect(page.getByTestId('settings-no-results'), word).toBeVisible()
  }
})

test('[ST-17] without Chromium’s licences, the credits page says this copy of Orbit lacks them and draws no link (settings fix check 1)', async () => {
  const page = await openSettings(orbit.app, { section: 'about', item: 'licence' })
  await page.locator('[data-setting="licence"]').getByRole('button').click()
  const credits = await tabPage(orbit.app, 'credits.html')
  const chromium = credits.locator('#chromium p')
  const link = credits.locator('#chromium-link')
  const shown = { useInnerText: true }
  const found = 'Their licences all come with Orbit, in LICENSES.chromium.html.'
  const missing = 'Electron ships their licences as LICENSES.chromium.html, but that file isn’t in this copy of Orbit.'
  await expect(chromium).toContainText(found, shown)
  await expect(chromium).not.toContainText(missing, shown)
  await expect(link).toBeVisible()
  // Main leaves chromium= out when it finds no copy; anything but a file: URL of that file is none.
  const bare = credits.url().replace(/[?#].*$/, '')
  for (const url of [
    bare,
    `${bare}?chromium=file:///etc/hostname`,
    `${bare}?chromium=https://example.test/LICENSES.chromium.html`,
  ]) {
    await credits.goto(url)
    await expect(chromium, url).toContainText(missing, shown)
    await expect(chromium).not.toContainText(found, shown)
    await expect(link).toBeHidden()
    expect(await link.getAttribute('href')).toBeNull()
  }
})

test('[AP-01] under Match system, Settings takes the system’s mode whenever it draws, before the change event comes (settings fix check 2)', async () => {
  const page = await openSettings(orbit.app, { section: 'general' })
  expect((await state(orbit.app)).settings.appearance).toBe('system')
  const settings = page.getByTestId('settings')
  const dark = (await settings.getAttribute('data-dark')) !== null
  // The system's mode turns over, and the change event hasn't come: Chromium sends it with a frame,
  // which a hidden or starved window may not draw for seconds.
  await page.evaluate((now) => {
    const read = Object.getOwnPropertyDescriptor(MediaQueryList.prototype, 'matches')?.get
    Object.defineProperty(MediaQueryList.prototype, 'matches', {
      configurable: true,
      get(this: MediaQueryList) {
        return this.media.includes('prefers-color-scheme: dark') ? now : read?.call(this)
      },
    })
  }, !dark)
  // Anything that draws Settings again reads the new mode: here, a search.
  await page.getByTestId('settings-search').fill('appearance')
  await expect(page.getByTestId('settings-no-results')).toHaveCount(0)
  if (dark) await expect(settings).not.toHaveAttribute('data-dark')
  else await expect(settings).toHaveAttribute('data-dark', '')
})

/** The state Chromium keeps for the page a tab shows (its scroll position among it), as main reads it. */
const pageStateOf = (app: ElectronApplication, url: string) =>
  app.evaluate(({ webContents }, u) => {
    const page = webContents.getAllWebContents().find((c) => c.getURL() === u)
    const history = page?.navigationHistory
    return history ? (history.getEntryAtIndex(history.getActiveIndex())?.pageState ?? null) : null
  }, url)

/** Scrolls a page and waits until Chromium has recorded the new position (it does so about once a second). */
async function scrollTo(app: ElectronApplication, page: Page, y: number): Promise<void> {
  const before = await pageStateOf(app, page.url())
  await page.evaluate((top) => window.scrollTo(0, top), y)
  await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(y)
  await expect.poll(() => pageStateOf(app, page.url()), { timeout: 15_000 }).not.toBe(before)
}

test('[ST-16][TB-22] a relaunch brings each tab back where it was: the shown page at its scroll position with Back, the others asleep until selected, then scrolled too', async () => {
  const userData = orbit.userData
  const first = (await run(orbit.app, 'tabs.create', { url: fx.url('/page/First') })) as string
  const a = await tabPage(orbit.app, '/page/First')
  await a.locator('#next').click()
  await a.waitForURL(/First-next$/)
  await scrollTo(orbit.app, a, 1200)
  const second = (await run(orbit.app, 'tabs.create', { url: fx.url('/page/Second') })) as string
  const b = await tabPage(orbit.app, '/page/Second')
  await scrollTo(orbit.app, b, 800)
  await run(orbit.app, 'tabs.activate', { tabId: first })
  await orbit.app.close()

  orbit = await launchOrbit({ userData })
  const restored = await tabPage(orbit.app, '/page/First-next')
  await expect.poll(() => restored.evaluate(() => Math.round(window.scrollY))).toBe(1200)
  await expect.poll(async () => (await state(orbit.app)).tabs[first]?.canGoBack).toBe(true)
  // Only the shown tab loaded; the other waits, and comes back where it was when selected.
  expect((await state(orbit.app)).tabs[second]?.asleep).toBe(true)
  await run(orbit.app, 'tabs.activate', { tabId: second })
  const other = await tabPage(orbit.app, '/page/Second')
  await expect.poll(() => other.evaluate(() => Math.round(window.scrollY))).toBe(800)
  // Back goes to the page before, as before the relaunch.
  await run(orbit.app, 'tabs.activate', { tabId: first })
  await restored.goBack()
  await expect(restored).toHaveURL(/\/page\/First$/)
})

test('[ST-03][DL-13] General offers Orbit for the computer’s PDF files on Windows only: the row sends the user to choose it, then says Orbit opens them', async () => {
  // Not on this system (Linux): no row.
  let page = await openSettings(orbit.app, { section: 'general' })
  await expect(page.getByTestId('setting-default-browser')).toBeVisible()
  await expect(page.getByTestId('setting-pdf-app')).toHaveCount(0)

  // A run that stands in for Windows.
  await orbit.app.close()
  orbit = await launchOrbit({ env: { ORBIT_E2E_PDF_APP: '1' } })
  page = await openSettings(orbit.app, { section: 'general' })
  const row = page.getByTestId('setting-pdf-app')
  await expect(row).toContainText('Open PDFs with Orbit')
  await expect(row).toContainText('in Default apps, find .pdf and pick Orbit')
  await row.getByTestId('pdf-app-set').click()
  await expect(row.getByTestId('pdf-app-status')).toHaveText('Orbit opens PDF files')
  await expect(row).toContainText('PDF files on this computer open in Orbit.')
})

test('[OB-03][ST-03] General draws Import and export and the default browser line in its first frame, and no row below them moves after', async () => {
  const page = await openSettings(orbit.app, { section: 'about' })
  const general = '[data-testid="settings-content"][data-section="general"]'
  const rec = await record(page, {
    general,
    defaultLine: `${general} [data-setting="default-browser"] .st-row__desc`,
    importRow: `${general} [data-setting="import"]`,
    exportRow: `${general} [data-setting="export-pinned"]`,
    mini: `${general} [data-setting="mini-window-archive"]`,
  })
  await run(orbit.app, 'settings.open', { section: 'general' })
  const { frames } = await rec.until(1200)
  const drawn = frames.filter((f) => f.els.general)
  expect(drawn.length, 'General was drawn').toBeGreaterThan(0)
  // The import is part of Orbit (IM-01): no question to main before the group is drawn.
  expect(drawn[0]?.els.importRow, 'Import in General’s first frame').toBeTruthy()
  expect(drawn[0]?.els.exportRow, 'Export in General’s first frame').toBeTruthy()
  // Read before Settings first painted: the line is there at once, so nothing under it moves.
  expect(drawn[0]?.els.defaultLine, 'the default browser line in General’s first frame').toBeTruthy()
  const tops = drawn.map((f) => Math.round(f.els.mini?.y ?? -1))
  expect(new Set(tops).size, `the Mini Window row’s top in each frame: ${tops.join(', ')}`).toBe(1)
  // It opens the import flow.
  await page.locator(`${general} [data-testid="import-open"]`).click()
  await expect.poll(async () => orbit.app.windows().some((w) => w.url().includes('view=import'))).toBe(true)
})
