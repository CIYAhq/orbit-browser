import { expect, test } from '@playwright/test'
import { MOD, viewPage } from './helpers'
import {
  ACCOUNT_WORDS,
  accountPrompts,
  type FirstRun,
  launchFirstRun,
  type OrbitGlobal,
  openSettings,
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
  // No window but the browser window: nothing to sign in to or fill in first.
  const views = () => app.windows().map((p) => new URL(p.url()).searchParams.get('view'))
  expect(views().filter((v) => v !== 'shell' && v !== 'overlay')).toEqual([])
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
