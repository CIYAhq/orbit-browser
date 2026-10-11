import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import type { SystemClash } from '../../src/shared/commands/keys'
import { run, state, viewPage } from './helpers'
import { type FirstRun, launchFirstRun, type OrbitGlobal, openSettings, pageOfView } from './settings-support'

/** First run, the parts the finish-settings lane built (KS-03, OB-*). Feature IDs lead each title. */

let orbit: FirstRun | undefined

test.afterEach(async () => {
  await orbit?.app.close().catch(() => {})
  orbit = undefined
})

const isLinux = process.platform === 'linux'

/**
 * Starts Orbit as a first run that shows onboarding (test runs skip it unless asked). The import
 * step finds no browsers, and the desktop keeps the keys `kept` names: the test says which, as no
 * test ever asks the desktop itself (KS-03).
 */
function launchWithOnboarding(opts: { userData?: string; kept?: SystemClash[] } = {}): Promise<FirstRun> {
  return launchFirstRun({
    ...(opts.userData ? { userData: opts.userData } : {}),
    env: { ORBIT_ONBOARDING: '1', ORBIT_IMPORT_PLACES: '[]', ORBIT_SYSTEM_KEYS: JSON.stringify(opts.kept ?? []) },
  })
}

/** The onboarding page once a step is drawn. */
async function onboardingPage(app: ElectronApplication, step: string): Promise<Page> {
  const page = await pageOfView(app, 'onboarding')
  await page.emulateMedia({ colorScheme: null })
  await expect(page.getByTestId(`onboarding-step-${step}`)).toBeVisible()
  return page
}

/** From the welcome to the step after the default browser's, choosing nothing on the way. */
async function walkToKeys(page: Page): Promise<void> {
  await page.getByTestId('onboarding-next').click()
  await page.getByTestId('onboarding-import-later').click()
  await expect(page.getByTestId('onboarding-step-theme')).toBeVisible()
  await page.getByTestId('onboarding-next').click()
  await expect(page.getByTestId('onboarding-step-favorites')).toBeVisible()
  await page.getByTestId('onboarding-next').click()
  await expect(page.getByTestId('onboarding-step-browser')).toBeVisible()
  await page.getByTestId('onboarding-browser-later').click()
}

/** Does something that closes the onboarding window, which can close it while Playwright still acts. */
async function closing(page: Page, act: () => Promise<void>): Promise<void> {
  await act().catch(async (err: unknown) => {
    if (!page.isClosed()) await page.waitForEvent('close', { timeout: 2000 }).catch(() => {})
    if (!page.isClosed()) throw err
  })
}

function onboardingOpen(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.getTitle() === 'Welcome to Orbit'),
  )
}

/** GNOME's keys on a default install: workspaces on Ctrl+Alt+←/→ (and with Shift), windows on Alt+F-keys. */
const GNOME_KEYS: SystemClash[] = [
  { accel: 'Ctrl+Alt+Left', owner: 'GNOME: Switch to workspace on the left' },
  { accel: 'Ctrl+Alt+Right', owner: 'GNOME: Switch to workspace on the right' },
  { accel: 'Ctrl+Alt+Shift+Right', owner: 'GNOME: Move window one workspace to the right' },
  { accel: 'Alt+F7', owner: 'GNOME: Move window' },
]

test('[KS-03] Linux first run: onboarding offers other keys for the ones the desktop keeps, and changes only those the user says yes to', async () => {
  test.skip(!isLinux, 'the first-run key check is Linux’s: not applicable on macOS and Windows')
  orbit = await launchWithOnboarding({ kept: GNOME_KEYS })
  const { app } = orbit
  const page = await onboardingPage(app, 'welcome')
  // The flow has a step for it: seven steps, not six.
  await expect(page.locator('.ob-progress__dot')).toHaveCount(7)
  await walkToKeys(page)
  await expect(page.getByTestId('onboarding-step-keys')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Some shortcuts are taken' })).toBeFocused()

  // The two Space keys GNOME keeps; Alt+F7 runs nothing in Orbit, so it isn't listed.
  const rows = page.getByTestId('onboarding-key')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toHaveAttribute('data-action', 'space.next')
  await expect(rows.nth(1)).toHaveAttribute('data-action', 'space.previous')
  await expect(rows.nth(0)).toContainText('Your desktop uses Ctrl+Alt+→ for GNOME: Switch to workspace on the right.')
  // The same keys with Shift, unless GNOME keeps those too (it does for →).
  await expect(rows.nth(1).getByTestId('onboarding-key-change').locator('kbd')).toHaveText([
    'Ctrl+Alt+←',
    'Ctrl+Alt+Shift+←',
  ])
  await expect(rows.nth(0).getByTestId('onboarding-key-change').locator('kbd').nth(1)).not.toHaveText(
    'Ctrl+Alt+Shift+→',
  )
  // Nothing has changed yet: listing them is no yes.
  expect((await state(app)).settings.shortcuts).toBeUndefined()

  // Take one and leave the other.
  await rows.nth(0).getByTestId('onboarding-key-pick').uncheck()
  const use = page.getByTestId('onboarding-keys-use')
  await expect(use).toHaveText('Use the new key')
  await use.click()
  await expect(page.getByTestId('onboarding-step-done')).toBeVisible()
  await expect
    .poll(async () => (await state(app)).settings.shortcuts)
    .toEqual({
      'space.previous': ['Ctrl+Alt+Shift+Left'],
    })
  await expect(page.getByTestId('onboarding-summary-keys')).toHaveText('1 changed to suit your desktop')

  // Back on the step, Previous Space shows its new key and Next Space still offers one.
  await page.getByTestId('onboarding-back').click()
  await expect(rows.nth(1).getByTestId('onboarding-key-now')).toHaveText('Now Ctrl+Alt+Shift+←')
  await expect(rows.nth(0).getByTestId('onboarding-key-pick')).toBeVisible()
  await page.getByTestId('onboarding-keys-keep').click()
  await expect(page.getByTestId('onboarding-step-done')).toBeVisible()
  await closing(page, () => page.getByTestId('onboarding-start').click())
  await expect.poll(() => onboardingOpen(app)).toBe(false)
  await expect((await viewPage(app, 'shell')).getByTestId('sidebar')).toBeVisible()
  expect((await state(app)).settings.shortcuts).toEqual({ 'space.previous': ['Ctrl+Alt+Shift+Left'] })

  // Settings → Shortcuts' marks agree: Next Space's key is still the desktop's, Previous Space's isn't.
  const settings = await openSettings(app, { section: 'shortcuts' })
  await expect(settings.getByTestId('setting-shortcut-space.next').getByTestId('shortcut-clash')).toContainText(
    'GNOME: Switch to workspace on the right',
  )
  await expect(settings.getByTestId('setting-shortcut-space.previous').getByTestId('shortcut-clash')).toHaveCount(0)
})

test('[KS-03] the key suggestions: keep them changes nothing, Settings → Shortcuts opens at the action, a key changed there shows at once; they come once', async () => {
  test.skip(!isLinux, 'the first-run key check is Linux’s: not applicable on macOS and Windows')
  orbit = await launchWithOnboarding({ kept: GNOME_KEYS })
  let { app } = orbit
  const { userData } = orbit
  const page = await onboardingPage(app, 'welcome')
  await walkToKeys(page)
  await expect(page.getByTestId('onboarding-step-keys')).toBeVisible()

  // Choose other keys in Settings: it opens at the first action listed, onboarding staying open.
  await page.getByTestId('onboarding-keys-settings').click()
  const settings = await pageOfView(app, 'settings')
  await expect(settings.getByTestId('settings-tab-shortcuts')).toHaveAttribute('aria-selected', 'true')
  await expect(settings.getByTestId('setting-shortcut-space.next')).toBeInViewport()
  // A key given there (as recording one would) shows in onboarding at once.
  expect(await run(app, 'keys.bind', { actionId: 'space.next', accel: 'F9', replace: 'Ctrl+Alt+Right' })).toEqual({
    ok: true,
  })
  const rows = page.getByTestId('onboarding-key')
  await expect(rows.nth(0).getByTestId('onboarding-key-now')).toHaveText('Now F9')
  await expect(page.getByTestId('onboarding-keys-use')).toHaveText('Use the new key')
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('view=settings')) w.close()
  })

  // Keep them as they are: Previous Space keeps the desktop's key; nothing else changes.
  await page.getByTestId('onboarding-keys-keep').click()
  await expect(page.getByTestId('onboarding-summary-keys')).toHaveText('1 changed to suit your desktop')
  await closing(page, () => page.getByTestId('onboarding-start').click())
  await expect.poll(() => onboardingOpen(app)).toBe(false)
  expect((await state(app)).settings.shortcuts).toEqual({ 'space.next': ['F9'] })

  // Once: the next start goes straight to the browser, with no suggestion.
  await app.close()
  orbit = await launchWithOnboarding({ userData, kept: GNOME_KEYS })
  app = orbit.app
  await expect((await viewPage(app, 'shell')).getByTestId('sidebar')).toBeVisible()
  expect(await onboardingOpen(app)).toBe(false)
  const windows = await app.evaluate(() => (globalThis as unknown as OrbitGlobal).__orbit.windowIds())
  expect(windows).toHaveLength(1)
})

test('[KS-03] with no keys the desktop keeps, onboarding has no shortcuts step', async () => {
  orbit = await launchWithOnboarding()
  const { app } = orbit
  const page = await onboardingPage(app, 'welcome')
  await expect(page.locator('.ob-progress__dot')).toHaveCount(6)
  await walkToKeys(page)
  await expect(page.getByTestId('onboarding-step-done')).toBeVisible()
  await expect(page.getByTestId('onboarding-summary-keys')).toHaveCount(0)
})
