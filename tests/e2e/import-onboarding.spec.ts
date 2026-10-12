import { readFileSync } from 'node:fs'
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import type { ImportJob } from '../../src/shared/commands/import'
import type { OrbitState } from '../../src/shared/state'
import { run, state, viewPage } from './helpers'
import { dropFile, fixturePath, pinnedShape, tabsUnder } from './import-support'
import { type FirstRun, launchFirstRun, pageOfView } from './settings-support'

/** Onboarding's import step (OB-03), its line on the Done screen (OB-09), and Skip setup (OB-14, D44). */

let orbit: FirstRun | undefined

test.afterEach(async () => {
  await orbit?.app.close().catch(() => {})
  orbit = undefined
})

const BOOKMARKS = { name: 'bookmarks.html', text: readFileSync(fixturePath('files', 'bookmarks.htm'), 'utf8') }

function launchOnboarding(): Promise<FirstRun> {
  return launchFirstRun({ env: { ORBIT_ONBOARDING: '1', ORBIT_IMPORT_PLACES: '[]' } })
}

async function onboardingAt(app: ElectronApplication, step: string): Promise<Page> {
  const page = await pageOfView(app, 'onboarding')
  await expect(page.getByTestId(`onboarding-step-${step}`)).toBeVisible()
  return page
}

/** Clicks something that closes the onboarding window, which may close while Playwright still acts. */
async function closing(page: Page, act: () => Promise<void>): Promise<void> {
  await act().catch(async (err: unknown) => {
    if (!page.isClosed()) await page.waitForEvent('close', { timeout: 2000 }).catch(() => {})
    if (!page.isClosed()) throw err
  })
}

/** Drops the sample bookmarks file on the import step and imports all of it into the first Space. */
async function importInline(page: Page): Promise<void> {
  await dropFile(page, '[data-testid="import-flow"]', BOOKMARKS)
  await expect(page.getByTestId('import-count')).toHaveText('6 of 6 bookmarks selected')
  await page.getByTestId('import-next').click()
  await expect(page.getByTestId('import-step-target')).toBeVisible()
  await page.getByTestId('import-next').click()
  await expect(page.getByTestId('onboarding-step-theme')).toBeVisible()
}

const importedFolders = (s: OrbitState) => Object.values(s.folders).filter((f) => f.name.startsWith('Imported'))

test('[OB-03][OB-09][IM-13] onboarding imports inline; the import is added when Start browsing opens the first window', async () => {
  orbit = await launchOnboarding()
  const { app } = orbit
  const page = await onboardingAt(app, 'welcome')
  await page.getByTestId('onboarding-next').click()
  await expect(page.getByTestId('onboarding-step-import')).toBeVisible()
  // The import flow, inline: "Do this later" weighs the same as Next, and the help for people moving
  // from another browser is there.
  await expect(page.getByTestId('import-flow')).toBeVisible()
  const later = page.getByTestId('onboarding-import-later')
  expect(await later.getAttribute('class')).toBe(await page.getByTestId('import-next').getAttribute('class'))
  await expect(page.getByTestId('import-moving-help')).toBeVisible()
  // Escape on a later step of the flow goes back within it, not out of onboarding's step.
  await dropFile(page, '[data-testid="import-flow"]', BOOKMARKS)
  await expect(page.getByTestId('import-step-bookmarks')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('import-step-source')).toBeVisible()
  await expect(page.getByTestId('onboarding-step-import')).toBeVisible()

  await importInline(page)
  // Nothing is added while onboarding goes on: it waits for Start browsing.
  const job = (await run(app, 'import.status', {})) as ImportJob
  await expect.poll(async () => ((await run(app, 'import.status', { jobId: job.id })) as ImportJob).phase).toBe('held')
  expect(importedFolders(await state(app))).toEqual([])

  await page.getByTestId('onboarding-next').click()
  await expect(page.getByTestId('onboarding-step-favorites')).toBeVisible()
  await page.getByTestId('onboarding-next').click()
  await expect(page.getByTestId('onboarding-step-ads')).toBeVisible()
  await page.getByTestId('onboarding-next').click()
  await page.getByTestId('onboarding-browser-later').click()
  await expect(page.getByTestId('onboarding-step-done')).toBeVisible()
  // OB-09: the Done screen says what will be imported, and from where.
  await expect(page.getByTestId('onboarding-summary-import')).toHaveText('6 bookmarks from bookmarks.html')
  await closing(page, () => page.getByTestId('onboarding-start').click())

  await expect((await viewPage(app, 'shell')).getByTestId('sidebar')).toBeVisible()
  await expect.poll(async () => importedFolders(await state(app)).length).toBe(1)
  const s = await state(app)
  const spaceId = s.spaceOrder[0] as string
  const folderId = s.spaces[spaceId]?.pinned.at(-1) as string
  expect(pinnedShape(s, [folderId])).toEqual([
    {
      'Imported bookmarks': [
        {
          'Bookmarks bar': [
            {
              Work: [
                'Team calendar <https://example.com/page/Calendar>',
                'Design docs <https://example.com/page/Docs>',
                'Issue tracker <https://example.com/page/Issues>',
              ],
            },
            {
              News: [
                'Morning paper <https://example.com/page/Paper>',
                'Tech & Science <weekly> <https://example.com/page/Weekly>',
              ],
            },
          ],
        },
        { 'Other bookmarks': [{ Recipes: [{ Bread: ['Sourdough <https://example.com/page/Sourdough>'] }] }] },
      ],
    },
  ])
  for (const tab of tabsUnder(s, folderId)) expect(tab).toMatchObject({ asleep: true, spaceId })
  expect(((await run(app, 'import.status', { jobId: job.id })) as ImportJob).phase).toBe('done')
})

test('[OB-14][OB-03] Skip setup after an import was chosen imports nothing (D44); Do this later then Back returns to the flow', async () => {
  orbit = await launchOnboarding()
  const { app } = orbit
  const page = await onboardingAt(app, 'welcome')
  await page.getByTestId('onboarding-next').click()
  await expect(page.getByTestId('import-flow')).toBeVisible()
  // Do this later moves on; the Done screen will say where import lives.
  await page.getByTestId('onboarding-import-later').click()
  await expect(page.getByTestId('onboarding-step-theme')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('import-flow')).toBeVisible()
  expect(await run(app, 'import.status', {})).toBeNull()

  await importInline(page)
  const job = (await run(app, 'import.status', {})) as ImportJob
  await expect.poll(async () => ((await run(app, 'import.status', { jobId: job.id })) as ImportJob).phase).toBe('held')
  // Skip setup: a default first window, and the import is dropped (D44).
  await closing(page, () => page.getByTestId('onboarding-skip').click())
  await expect((await viewPage(app, 'shell')).getByTestId('sidebar')).toBeVisible()
  await expect
    .poll(async () => ((await run(app, 'import.status', { jobId: job.id })) as ImportJob).phase)
    .toBe('cancelled')
  const s = await state(app)
  expect(s.settings.onboarded).toBe(true)
  expect(importedFolders(s)).toEqual([])
  expect(Object.values(s.tabs).filter((t) => t.url.startsWith('https://example.com/'))).toEqual([])
})

test('[OB-03][IM-02][IM-06][IM-16] onboarding offers the browsers on this computer: several profiles, types and bookmarks, into the first Space, then sites to add', async () => {
  const places = JSON.stringify([{ browser: 'chrome', dir: fixturePath('chrome') }])
  orbit = await launchFirstRun({ env: { ORBIT_ONBOARDING: '1', ORBIT_IMPORT_PLACES: places } })
  const { app } = orbit
  const page = await onboardingAt(app, 'welcome')
  await page.getByTestId('onboarding-next').click()
  await page.getByTestId('import-source-chrome').click()
  await page.getByTestId('import-next').click()
  // Both profiles, by name.
  await expect(page.getByTestId('import-profiles')).toContainText('Personal')
  await page.getByTestId('import-profiles').getByRole('checkbox').nth(1).check()
  await page.getByTestId('import-next').click()
  await expect(page.getByTestId('import-type-bookmarks')).toContainText('9 bookmarks')
  await expect(page.getByTestId('import-type-history')).toContainText('7 pages visited')
  await page.getByTestId('import-next').click()
  await expect(page.getByTestId('import-count')).toHaveText('9 of 9 bookmarks selected')
  await page.getByTestId('import-next').click()
  await expect(page.getByTestId('import-step-target')).toBeVisible()
  await page.getByTestId('import-next').click()
  await expect(page.getByTestId('onboarding-step-theme')).toBeVisible()
  await page.getByTestId('onboarding-next').click()
  await page.getByTestId('onboarding-next').click()
  await expect(page.getByTestId('onboarding-step-ads')).toBeVisible()
  await page.getByTestId('onboarding-next').click()
  await page.getByTestId('onboarding-browser-later').click()
  await expect(page.getByTestId('onboarding-summary-import')).toHaveText('9 bookmarks · 7 history items from Chrome')
  // The history, too, waits for Start browsing (D44).
  const before = await state(app)
  const profileId = before.spaces[before.spaceOrder[0] as string]?.profileId
  const titles = async () =>
    ((await run(app, 'history.visits', { profileId, limit: 100 })) as { title: string }[]).map((v) => v.title)
  expect(await titles()).toEqual([])
  // IM-16: the sites visited most, each one click to add (and one more to take back).
  const offer = (title: string) => page.getByTestId('import-suggestion').filter({ hasText: title })
  await expect(page.getByTestId('import-suggestion').locator('.im-suggestion__title')).toHaveText([
    'Inbox',
    'Example News',
    'Team calendar',
    'Plan for the spring',
    'Weather',
    'Cart',
  ])
  for (const title of ['Inbox', 'Weather', 'Cart', 'Cart']) await offer(title).click()
  await expect(offer('Inbox')).toHaveAttribute('aria-pressed', 'true')
  await expect(offer('Weather')).toHaveAttribute('aria-pressed', 'true')
  await expect(offer('Cart')).toHaveAttribute('aria-pressed', 'false')
  await closing(page, () => page.getByTestId('onboarding-start').click())

  await expect.poll(async () => importedFolders(await state(app)).map((f) => f.name)).toEqual(['Imported from Chrome'])
  await expect.poll(async () => ((await run(app, 'import.status', {})) as ImportJob).phase).toBe('done')
  const s = await state(app)
  const folderId = importedFolders(s)[0]?.id as string
  expect(s.folders[folderId]?.children.map((id) => s.folders[id]?.name)).toEqual(['Work', 'Personal'])
  expect(tabsUnder(s, folderId)).toHaveLength(9)
  // Both profiles' history, in the first Space's profile.
  await expect.poll(async () => (await titles()).slice(0, 3)).toEqual(['Inbox', 'Weather', 'Example News'])
  // The suggestions taken, unloaded: a Favorite and, after the folder, a pinned tab. Orbit basics
  // (OB-09) stays at the top.
  const first = s.spaces[s.spaceOrder[0] as string]
  const favorites = (s.profiles[profileId as string]?.favorites ?? []).map((id) => s.tabs[id])
  expect(favorites.filter((t) => t?.pinnedUrl === 'https://mail.example.net/inbox')).toHaveLength(1)
  expect(favorites.every((t) => t?.asleep)).toBe(true)
  expect(first?.pinned.map((id) => s.folders[id]?.name ?? s.tabs[id]?.pinnedUrl)).toEqual([
    'Orbit basics',
    'Imported from Chrome',
    'https://weather.example.org/',
  ])
})

test('[IM-16] Dismiss all: none of the suggestions is added', async () => {
  const places = JSON.stringify([{ browser: 'chrome', dir: fixturePath('chrome') }])
  orbit = await launchFirstRun({ env: { ORBIT_ONBOARDING: '1', ORBIT_IMPORT_PLACES: places } })
  const { app } = orbit
  const page = await onboardingAt(app, 'welcome')
  await page.getByTestId('onboarding-next').click()
  await page.getByTestId('import-source-chrome').click()
  await page.getByTestId('import-next').click()
  // The first profile (Work), its history only.
  await page.getByTestId('import-next').click()
  await page.getByTestId('import-type-bookmarks').getByRole('checkbox').uncheck()
  await page.getByTestId('import-next').click()
  await expect(page.getByTestId('import-step-target')).toBeVisible()
  await page.getByTestId('import-next').click()
  await expect(page.getByTestId('onboarding-step-theme')).toBeVisible()
  await page.getByTestId('onboarding-next').click()
  await page.getByTestId('onboarding-next').click()
  await expect(page.getByTestId('onboarding-step-ads')).toBeVisible()
  await page.getByTestId('onboarding-next').click()
  await page.getByTestId('onboarding-browser-later').click()
  await page.getByTestId('import-suggestion').first().click()
  await expect(page.getByTestId('import-suggestion').first()).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('import-suggestions-dismiss').click()
  await expect(page.getByTestId('import-suggestions')).toHaveCount(0)
  await closing(page, () => page.getByTestId('onboarding-start').click())
  await expect.poll(async () => ((await run(app, 'import.status', {})) as ImportJob).phase).toBe('done')
  const s = await state(app)
  expect(Object.values(s.tabs).filter((t) => t.url.startsWith('https://mail.example.net/'))).toEqual([])
})

test('[OB-09] Do this later: the Done screen says nothing was imported and where to find it', async () => {
  orbit = await launchOnboarding()
  const { app } = orbit
  const page = await onboardingAt(app, 'welcome')
  await page.getByTestId('onboarding-next').click()
  await page.getByTestId('onboarding-import-later').click()
  await expect(page.getByTestId('onboarding-step-theme')).toBeVisible()
  await page.getByTestId('onboarding-next').click()
  await expect(page.getByTestId('onboarding-step-favorites')).toBeVisible()
  await page.getByTestId('onboarding-next').click()
  await expect(page.getByTestId('onboarding-step-ads')).toBeVisible()
  await page.getByTestId('onboarding-next').click()
  await page.getByTestId('onboarding-browser-later').click()
  await expect(page.getByTestId('onboarding-summary-import')).toHaveText(
    'Nothing imported: it’s in Settings, under General',
  )
})
