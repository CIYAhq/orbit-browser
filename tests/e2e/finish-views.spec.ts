import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import {
  activeTabId,
  type Fixtures,
  launchOrbit,
  MOD,
  type Orbit,
  run,
  startFixtures,
  state,
  viewPage,
} from './helpers'

/** Views lane follow-ups: the command bar, split view, Peek, Mini Windows and media. */

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
  await orbit.app.close()
})

/** Opens a fixture page titled `name` in a new tab and waits until it has its title and favicon. */
async function newTab(name: string): Promise<string> {
  const id = (await run(orbit.app, 'tabs.create', { url: fx.url(`/page/${encodeURIComponent(name)}`) })) as string
  await expect.poll(async () => (await state(orbit.app)).tabs[id]?.title).toBe(name)
  await expect.poll(async () => !!(await state(orbit.app)).tabs[id]?.favicon).toBe(true)
  return id
}

async function openBar(): Promise<Page> {
  await orbit.shell.keyboard.press(`${MOD}+T`)
  const overlay = await viewPage(orbit.app, 'overlay')
  await expect(input(overlay)).toBeFocused()
  return overlay
}

/** The live bar (a closing one may still be animating out). */
const bar = (overlay: Page) => overlay.getByTestId('command-bar')
const input = (overlay: Page) => bar(overlay).getByTestId('command-input')
const rows = (overlay: Page) => bar(overlay).getByTestId('command-result')
/** The "search the web" row's text: once it shows a query, the rows around it answer that query. */
const searchRow = (overlay: Page) =>
  rows(overlay).and(overlay.locator('[data-kind="search"]')).getByTestId('command-result-title')

/** Popup menus are recorded instead of shown, so a test can read and click them. */
async function recordMenus(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu }) => {
    const g = globalThis as unknown as { __shownMenu?: unknown }
    Menu.prototype.popup = function popup(this: unknown) {
      g.__shownMenu = this
    }
  })
}

/** The last recorded popup menu's item labels. */
function shownMenu(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() =>
    ((globalThis as unknown as { __shownMenu?: Electron.Menu }).__shownMenu?.items ?? []).map((i) => i.label),
  )
}

/** Clicks an item of the last recorded popup menu; false when it is missing or disabled. */
function clickShownMenu(app: ElectronApplication, label: string): Promise<boolean> {
  return app.evaluate((_e, l) => {
    const item = (globalThis as unknown as { __shownMenu?: Electron.Menu }).__shownMenu?.items.find(
      (i) => i.label === l,
    )
    if (!item?.enabled) return false
    item.click()
    return true
  }, label)
}

// ---- Split view in the command bar and the sidebar (SV-21) ----

test('[SV-21][CB-06] the command bar lists an open split once, with both favicons, and Enter shows it', async () => {
  const { app, shell } = orbit
  const a = await newTab('Alpha Mail')
  const b = await newTab('Bravo Docs')
  const splitId = (await run(app, 'split.create', { tabIds: [a, b] })) as string
  expect(splitId).toBeTruthy()
  // The panes' titles in the order the sidebar's split row shows them.
  const titles = shell.locator(`[data-testid="split-row"][data-split-id="${splitId}"] .split-segment__title`)
  await expect(titles).toHaveCount(2)
  const paneTitles = (await titles.allTextContents()).join(' | ')
  expect(paneTitles.split(' | ').sort()).toEqual(['Alpha Mail', 'Bravo Docs'])
  const current = await newTab('Charlie')
  await expect.poll(() => activeTabId(app)).toBe(current)
  // Their pages are in history, where the bar could find them on their own too.
  await expect
    .poll(async () => ((await run(app, 'history.search', { text: 'page' })) as unknown[]).length)
    .toBeGreaterThanOrEqual(3)

  // Both panes match "page" (in their URLs): one row for the split, none for either pane or page.
  const overlay = await openBar()
  await input(overlay).fill('page')
  await expect(searchRow(overlay)).toHaveText('page')
  const split = rows(overlay).and(overlay.locator(`[data-id="split:${splitId}"]`))
  await expect(split).toHaveCount(1)
  await expect(split).toHaveAttribute('data-kind', 'tab')
  await expect(split.getByTestId('command-result-title')).toHaveText(paneTitles)
  await expect(split.locator('.cmdbar__label')).toHaveText('Split')
  await expect(split.getByTestId('split-favicons').locator('img.favicon')).toHaveCount(2)
  await expect(overlay.locator(`[data-id="tab:${a}"], [data-id="tab:${b}"]`)).toHaveCount(0)
  await expect(rows(overlay).and(overlay.locator('[data-kind="history"]'))).toHaveCount(0)

  // Enter on it shows the split, with the pane that matched focused.
  await input(overlay).fill('bravo')
  await expect(searchRow(overlay)).toHaveText('bravo')
  await expect(rows(overlay).first()).toHaveAttribute('data-id', `split:${splitId}`)
  await expect(split.locator('.cmdbar__hint')).toHaveText('Switch to split ↩')
  await overlay.keyboard.press('Enter')
  await expect.poll(() => activeTabId(app)).toBe(b)
  await expect(shell.getByTestId('split-pane')).toHaveCount(2)

  // Now on screen, the split and its pages aren't offered, as the current tab isn't.
  const again = await openBar()
  await input(again).fill('alpha')
  await expect(searchRow(again)).toHaveText('alpha')
  await expect(rows(again).and(again.locator(`[data-id="split:${splitId}"]`))).toHaveCount(0)
  await expect(rows(again).filter({ hasText: 'Alpha Mail' })).toHaveCount(0)
})

test("[SV-21][SV-22][SV-23] a split's icon replaces its panes' favicons on its row and Favorites tile, lasts, and can be removed", async () => {
  const { app, shell, userData } = orbit
  const a = await newTab('Alpha')
  const b = await newTab('Bravo')
  const splitId = (await run(app, 'split.create', { tabIds: [a, b] })) as string
  const row = shell.locator(`[data-testid="split-row"][data-split-id="${splitId}"]`)
  await expect(row.getByTestId('split-segment')).toHaveCount(2)
  const paneTitles = (await row.locator('.split-segment__title').allTextContents()).join(' | ')

  // Right-click → Change Icon… → pick one: it stands in for the favicons; the titles stay.
  await recordMenus(app)
  await row.click({ button: 'right' })
  await expect.poll(() => shownMenu(app)).toContain('Change Icon…')
  expect(await clickShownMenu(app, 'Change Icon…')).toBe(true)
  const picker = shell.getByTestId('icon-picker')
  await expect(picker).toBeVisible()
  await picker.getByTestId('icon-choice').first().click()
  await expect(picker).toHaveCount(0)
  await expect(row.getByTestId('split-icon')).toHaveText('⭐')
  await expect(row.getByTestId('split-segment')).toHaveCount(0)
  await expect(row.locator('.split-row__name')).toHaveText(paneTitles)
  expect((await state(app)).splits[splitId]?.icon).toBe('⭐')

  // As a Favorite, its tile shows the icon too (SV-23), and still does after a relaunch.
  const s = await state(app)
  const profileId = s.spaces[s.tabs[a]?.spaceId as string]?.profileId as string
  expect(await run(app, 'tabs.move', { id: splitId, to: { kind: 'favorites', profileId }, index: 0 })).toBe(true)
  const tile = (o: Orbit) => o.shell.locator(`[data-testid="favorite-tile"][data-split-id="${splitId}"]`)
  await expect(tile(orbit).getByTestId('split-icon')).toHaveText('⭐')
  await app.close()
  orbit = await launchOrbit({ userData })
  await expect(tile(orbit).getByTestId('split-icon')).toHaveText('⭐')

  // Remove icon: the panes' favicons come back.
  await recordMenus(orbit.app)
  await tile(orbit).click({ button: 'right' })
  await expect.poll(() => shownMenu(orbit.app)).toContain('Change Icon…')
  expect(await clickShownMenu(orbit.app, 'Change Icon…')).toBe(true)
  await orbit.shell.getByTestId('icon-picker').getByRole('button', { name: 'Remove icon' }).click()
  await expect(tile(orbit).getByTestId('split-icon')).toHaveCount(0)
  await expect(tile(orbit).locator('.favicon')).toHaveCount(2)
  await expect.poll(async () => (await state(orbit.app)).splits[splitId]?.icon).toBeUndefined()
})
