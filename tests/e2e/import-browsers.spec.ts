import { chmodSync, cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { SAFARI_BLOCKED } from '../../src/main/import/browsers'
import type { ImportJob } from '../../src/shared/commands/import'
import type { OrbitState } from '../../src/shared/state'
import { MOD, type Orbit, run, state, viewPage } from './helpers'
import { clickDone, fixturePath, importPage, launchImport, openImport, pinnedShape, tabsUnder } from './import-support'
import { openSettings } from './settings-support'

/** Importing from browsers on this computer (IM-01 to IM-06, IM-14): made-up profiles under tests/fixtures. */

let orbit: Orbit | undefined
const scratch: string[] = []

test.afterEach(async () => {
  await orbit?.app.close().catch(() => {})
  orbit = undefined
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const FIXTURE_PLACES = [
  { browser: 'chrome', dir: fixturePath('chrome') },
  // Not installed: not offered.
  { browser: 'brave', dir: fixturePath('not-installed') },
  { browser: 'firefox', dir: fixturePath('firefox') },
]

/** A copy of a fixture browser's folder, to break. */
function copyOf(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-import-e2e-'))
  scratch.push(dir)
  cpSync(fixturePath(name), join(dir, name), { recursive: true })
  return join(dir, name)
}

/** Picks a browser and goes on, through its profiles step when it has several, to "What to import". */
async function chooseBrowser(page: Page, id: string, profiles?: string[]): Promise<void> {
  await page.getByTestId(`import-source-${id}`).click()
  await page.getByTestId('import-next').click()
  if (profiles) {
    for (const row of await page.getByTestId('import-profiles').locator('label').all()) {
      const name = await row.locator('span').last().innerText()
      await row.getByRole('checkbox').setChecked(profiles.includes(name))
    }
    await page.getByTestId('import-next').click()
  }
  await expect(page.getByTestId('import-step-types')).toBeVisible()
  await expect(page.getByTestId('import-inspecting')).toHaveCount(0)
}

/** From the bookmarks step: on to the target, Import, and the summary. */
async function importFromBookmarks(page: Page, target?: (page: Page) => Promise<void>): Promise<ImportJob> {
  await page.getByTestId('import-next').click()
  await expect(page.getByTestId('import-target')).toBeVisible()
  await target?.(page)
  await page.getByTestId('import-next').click()
  await expect(page.getByTestId('import-progress')).toHaveAttribute('data-phase', 'done', { timeout: 30_000 })
  return (await run(orbit?.app as Orbit['app'], 'import.status', {})) as ImportJob
}

const importedFolders = (s: OrbitState) => Object.values(s.folders).filter((f) => f.name.startsWith('Imported'))

const WORK_BOOKMARKS = {
  'Imported from Chrome': [
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
}

test('[IM-02][IM-03][IM-04][IM-05][IM-09][IM-14] a Chrome profile’s bookmarks become “Imported from Chrome”, as pinned tabs that don’t load', async () => {
  orbit = await launchImport({ places: FIXTURE_PLACES })
  const { app } = orbit
  const page = await openImport(app)
  // The browsers on this computer, each with its profiles; one that isn't installed isn't offered.
  await expect(page.locator('[data-testid^="import-source-"][role="radio"]')).toHaveCount(2)
  await expect(page.getByTestId('import-source-chrome')).toContainText('2 profiles')
  await expect(page.getByTestId('import-source-firefox')).toContainText('default-release')
  await chooseBrowser(page, 'chrome', ['Work'])
  // What the profile offers, all chosen; never passwords.
  await expect(page.getByTestId('import-type-bookmarks')).toContainText('6 bookmarks')
  await expect(page.getByTestId('import-type-bookmarks').getByRole('checkbox')).toBeChecked()
  await expect(page.getByTestId('import-type-history')).toContainText('6 pages visited')
  await expect(page.getByTestId('import-type-history').getByRole('checkbox')).toBeChecked()
  await expect(page.getByText('Passwords and cards are never imported.')).toBeVisible()
  // IM-09: its extensions, pinned ones first, listed but not importable yet; the browser's own left out.
  const extensions = page.getByTestId('import-type-extensions')
  await expect(extensions).toContainText('Example Blocker, Notes Helper, Another Ad Blocker, My Unpacked Tool')
  await expect(extensions).toContainText('Not importable yet: Orbit can’t install extensions yet.')
  await expect(extensions).toContainText('Unpacked ones never come over.')
  await expect(extensions.getByRole('checkbox')).toBeDisabled()
  await expect(extensions.getByRole('checkbox')).not.toBeChecked()
  // Nothing chosen, nothing to go on with.
  for (const type of ['bookmarks', 'history'])
    await page.getByTestId(`import-type-${type}`).getByRole('checkbox').uncheck()
  await expect(page.getByTestId('import-next')).toBeDisabled()
  for (const type of ['bookmarks', 'history'])
    await page.getByTestId(`import-type-${type}`).getByRole('checkbox').check()
  await page.getByTestId('import-next').click()

  // The profile's tree, everything chosen; Select none and all.
  await expect(page.getByTestId('import-count')).toHaveText('6 of 6 bookmarks selected')
  await page.getByRole('checkbox', { name: 'Import News' }).uncheck()
  await expect(page.getByTestId('import-count')).toHaveText('4 of 6 bookmarks selected')
  // No bookmarks still leaves the history to import.
  await page.getByTestId('import-select-none').click()
  await expect(page.getByTestId('import-count')).toHaveText('0 of 6 bookmarks selected')
  await expect(page.getByTestId('import-next')).toBeEnabled()
  await page.getByTestId('import-select-all').click()
  await expect(page.getByTestId('import-count')).toHaveText('6 of 6 bookmarks selected')
  const job = await importFromBookmarks(page)

  expect(job.source).toBe('Chrome')
  await expect(page.getByTestId('import-item-bookmarks')).toHaveAttribute('data-done', '6')
  await expect(page.getByTestId('import-item-history')).toHaveAttribute('data-done', '6')
  await expect(page.getByTestId('import-skipped')).toContainText('1 bookmark: Bookmarklet (a script, not a page)')
  await expect(page.getByTestId('import-skipped')).toContainText('1 bookmark: A page only that browser can open')
  const s = await state(app)
  const folder = job.folders[0]
  expect(folder?.spaceId).toBe(s.spaceOrder[0])
  expect(s.spaces[folder?.spaceId as string]?.pinned.at(-1)).toBe(folder?.folderId)
  expect(pinnedShape(s, [folder?.folderId as string])).toEqual([WORK_BOOKMARKS])
  expect(tabsUnder(s, folder?.folderId as string).every((t) => t.asleep && !t.favicon)).toBe(true)
  // Done shows the folder in the browser window.
  await clickDone(page)
})

test('[IM-02][IM-06] several profiles at once: each gets a matching Orbit profile and Space', async () => {
  orbit = await launchImport({ places: FIXTURE_PLACES })
  const { app } = orbit
  const before = await state(app)
  const page = await openImport(app)
  await chooseBrowser(page, 'chrome', ['Work', 'Personal'])
  await expect(page.getByTestId('import-type-bookmarks')).toContainText('9 bookmarks')
  await page.getByTestId('import-next').click()
  // Each profile's tree, under its name.
  await expect(page.getByTestId('import-count')).toHaveText('9 of 9 bookmarks selected')
  await expect(page.getByTestId('import-tree-folder').filter({ hasText: 'Personal' })).toBeVisible()
  const job = await importFromBookmarks(page, async (p) => {
    await p.getByTestId('import-matching').check()
    await expect(p.getByTestId('import-target-space')).toHaveCount(0)
  })
  expect(job.folders).toHaveLength(2)

  const s = await state(app)
  const added = s.spaceOrder.filter((id) => !before.spaceOrder.includes(id)).map((id) => s.spaces[id])
  expect(added.map((sp) => [sp?.name, s.profiles[sp?.profileId as string]?.name])).toEqual([
    ['Work', 'Work'],
    ['Personal', 'Personal'],
  ])
  const shapeIn = (spaceName: string) => {
    const space = added.find((sp) => sp?.name === spaceName)
    return pinnedShape(s, space?.pinned ?? [])
  }
  expect(shapeIn('Work')).toEqual([WORK_BOOKMARKS])
  expect(shapeIn('Personal')).toEqual([
    {
      'Imported from Chrome': [
        { 'Bookmarks bar': ['Weather <https://weather.example.org/>'] },
        { 'Other bookmarks': [{ Travel: ['Trains <https://example.com/page/Trains>'] }] },
        { 'Mobile bookmarks': ['Recipes on the go <https://example.com/page/Mobile>'] },
      ],
    },
  ])
  // Nothing went to the Spaces that were there.
  for (const id of before.spaceOrder) expect(s.spaces[id]?.pinned).toEqual(before.spaces[id]?.pinned)
  // Each profile's history went to its own profile.
  const titles = async (spaceName: string) => {
    const profileId = added.find((sp) => sp?.name === spaceName)?.profileId
    const visits = (await run(app, 'history.visits', { profileId, limit: 100 })) as { title: string }[]
    return [...new Set(visits.map((v) => v.title))]
  }
  expect(await titles('Work')).toEqual([
    'Inbox',
    'Example News',
    'Team calendar',
    'Plan for the spring',
    'sourdough - Search',
    'Cart',
  ])
  expect(await titles('Personal')).toEqual(['Weather'])
  const firstProfile = before.spaces[before.spaceOrder[0] as string]?.profileId
  expect(await run(app, 'history.visits', { profileId: firstProfile, limit: 100 })).toEqual([])
})

test('[IM-02][IM-06] Firefox’s one profile goes straight to its types; “New Space…” takes the folder; Safari without access says why', async () => {
  const safari = copyOf('safari')
  chmodSync(join(safari, 'Bookmarks.plist'), 0o000)
  orbit = await launchImport({ places: [...FIXTURE_PLACES, { browser: 'safari', dir: safari }] })
  const { app } = orbit
  const page = await openImport(app)
  // Safari's files need Full Disk Access: it says so and offers the way round it, and can't be chosen.
  const tile = page.getByTestId('import-source-safari')
  await expect(tile).toContainText(SAFARI_BLOCKED)
  await tile.click()
  await expect(page.getByTestId('import-next')).toBeDisabled()

  await chooseBrowser(page, 'firefox')
  await expect(page.getByTestId('import-type-bookmarks')).toContainText('7 bookmarks')
  await page.getByTestId('import-next').click()
  await expect(page.getByTestId('import-count')).toHaveText('7 of 7 bookmarks selected')
  const job = await importFromBookmarks(page, async (p) => {
    await p.getByTestId('import-target-space').selectOption('new')
    await p.getByTestId('import-new-space').fill('From Firefox')
  })
  await expect(page.getByTestId('import-skipped')).toContainText('1 bookmark: Saved search, not a page')
  const s = await state(app)
  const space = s.spaces[job.folders[0]?.spaceId as string]
  expect(space?.name).toBe('From Firefox')
  expect(pinnedShape(s, space?.pinned ?? [])).toEqual([
    {
      'Imported from Firefox': [
        {
          'Bookmarks Toolbar': [
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
        { 'Bookmarks Menu': [{ Recipes: [{ Bread: ['Sourdough <https://example.com/page/Sourdough>'] }] }] },
        { 'Other Bookmarks': ['Read later <https://example.com/page/Later>'] },
      ],
    },
  ])
})

test('[IM-14] a browser holding its files: Orbit asks to quit it and try again', async () => {
  const chrome = copyOf('chrome')
  const held = join(chrome, 'Default', 'Bookmarks')
  chmodSync(held, 0o000)
  orbit = await launchImport({ places: [{ browser: 'chrome', dir: chrome }] })
  const page = await openImport(orbit.app)
  await chooseBrowser(page, 'chrome', ['Work'])
  await expect(page.getByTestId('import-locked')).toContainText(
    'Chrome is using some of its files. Quit Chrome and try again',
  )
  await expect(page.getByTestId('import-type-bookmarks')).toHaveCount(0)
  // The rest can still come over.
  await expect(page.getByTestId('import-type-history').getByRole('checkbox')).toBeChecked()
  await expect(page.getByTestId('import-next')).toBeEnabled()
  // Quit (here: the file is let go of) and try again.
  chmodSync(held, 0o644)
  await page.getByTestId('import-retry').click()
  await expect(page.getByTestId('import-type-bookmarks')).toContainText('6 bookmarks')
  await expect(page.getByTestId('import-locked')).toHaveCount(0)
  await page.getByTestId('import-next').click()
  await importFromBookmarks(page)
  expect(importedFolders(await state(orbit.app)).map((f) => f.name)).toEqual(['Imported from Chrome'])
})

test('[IM-01][ST-03] the command bar’s Import and Settings → General open the same flow; Cancel at any step imports nothing', async () => {
  orbit = await launchImport({ places: FIXTURE_PLACES })
  const { app, shell } = orbit
  const before = await state(app)
  await shell.keyboard.press(`${MOD}+T`)
  const overlay = await viewPage(app, 'overlay')
  await overlay.getByTestId('command-input').fill('import')
  const row = overlay.getByTestId('command-result').filter({ hasText: 'Import from Another Browser' })
  await expect(row).toHaveAttribute('data-kind', 'action')
  await row.click()

  // Through every step to the last, then Cancel: nothing is imported, nothing started.
  let page = await importPage(app)
  await chooseBrowser(page, 'chrome', ['Work', 'Personal'])
  await page.getByTestId('import-next').click()
  await page.getByTestId('import-next').click()
  await expect(page.getByTestId('import-target')).toBeVisible()
  await page.getByTestId('import-cancel').click()
  await expect.poll(() => page.isClosed()).toBe(true)
  expect(await run(app, 'import.status', {})).toBeNull()
  const after = await state(app)
  expect(Object.keys(after.folders)).toEqual(Object.keys(before.folders))
  expect(after.spaceOrder).toEqual(before.spaceOrder)

  // Settings → General → Import… opens it again, from the start.
  const settings = await openSettings(app, { section: 'general' })
  await settings.getByTestId('import-open').click()
  page = await importPage(app)
  await expect(page.getByTestId('import-step-source')).toBeVisible()
  await expect(page.getByTestId('import-source-chrome')).toHaveAttribute('aria-checked', 'false')
})
