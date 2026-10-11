import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { launchOrbit, MOD, type Orbit, run, state, tabPage, viewPage } from './helpers'
import { focusBrowserWindow, openSettings } from './settings-support'
import { act, activeId, cmd, newTab, tabsHook } from './tabs-support'
import {
  bgOf,
  edited,
  editorInfo,
  openFixture,
  startTweakFixtures,
  type TweakFixtures,
  tweakList,
  waitEditor,
  zoomOf,
} from './tweaks-support'

/** The Library's Tweaks (BO-15) and the switch for all of them (BO-16). Feature IDs lead each title. */

let fx: TweakFixtures
let orbit: Orbit | undefined

test.beforeAll(async () => {
  fx = await startTweakFixtures()
})
test.afterAll(async () => {
  await fx.close()
})
test.afterEach(async () => {
  fx.slowHome(0)
  await orbit?.app.close()
  orbit = undefined
})

const WHITE = 'rgb(255, 255, 255)'
const NAVY = 'rgb(18, 52, 86)'

/** Two sites, both served by the fixture server. */
const HOSTS = ['news.lib.test', 'shop.lib.test']
const HOST_ARGS = [
  `--host-resolver-rules=${HOSTS.map((h) => `MAP ${h} 127.0.0.1`).join(', ')}`,
  `--proxy-bypass-list=${HOSTS.join(';')}`,
]

const openPage = (app: ElectronApplication, path: string, host?: string) => openFixture(app, fx, path, host)

/** A new Tweak for a tab's site, made as New Tweak… does, changed as the editor would, its editor closed again. */
async function makeTweak(app: ElectronApplication, tabId: string, patch: Record<string, unknown>): Promise<string> {
  await run(app, 'tweaks.dismissIntro', {})
  const id = (await run(app, 'tweaks.create', { tabId })) as string
  await waitEditor(app, true)
  await run(app, 'tweaks.update', { id, patch })
  await run(app, 'tweaks.closeEditor', {})
  await waitEditor(app, false)
  return id
}

/** The Library's own view (`?view=library`), once it has been created. */
async function libraryPage(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const found = app.windows().find((p) => p.url().includes('view=library'))
    if (found) return found
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('No library page')
}

/** Opens the Library on its Tweaks with View Tweaks, and waits until it shows them and has the keys. */
async function viewTweaks(app: ElectronApplication): Promise<Page> {
  await act(app, 'tweak.view')
  const lib = await libraryPage(app)
  await expect(lib.getByTestId('library')).toHaveAttribute('data-open', 'true')
  await expect(lib.getByTestId('library-section')).toHaveAttribute('data-section-id', 'tweaks')
  await expect.poll(async () => ((await run(app, 'library.testInfo')) as { focused: boolean }).focused).toBe(true)
  return lib
}

const tabCount = async (app: ElectronApplication) => Object.keys((await state(app)).tabs).length

test('[BO-15][BO-21] the Library lists every Tweak, a site’s together: name, site, a JS badge, and a switch that turns it off and on at once; View Tweaks opens it; Rename in place, and Delete… asks first and takes its styles off the page at once', async () => {
  orbit = await launchOrbit({ args: HOST_ARGS })
  const { app, shell } = orbit
  const news = await openPage(app, '/page/News', 'news.lib.test')
  const dark = await makeTweak(app, news.tabId, {
    name: 'Dark news',
    css: 'body { background: #123456 }',
    js: 'window.__ran = 1',
  })
  await makeTweak(app, news.tabId, { name: 'Big text', subdomains: true, style: { size: 125 } })
  const shop = await openPage(app, '/page/Shop', 'shop.lib.test')
  const calm = await makeTweak(app, shop.tabId, { style: { textCase: 'upper' } })
  await cmd(app, 'tabs.activate', { tabId: news.tabId })
  await expect.poll(() => bgOf(news.page)).toBe(NAVY)
  expect(await zoomOf(news.page)).toBe('1.25')

  // The command bar's View Tweaks (BO-21) opens the Library on them.
  await shell.keyboard.press(`${MOD}+T`)
  const overlay = await viewPage(app, 'overlay')
  const input = overlay.getByTestId('command-bar').getByTestId('command-input')
  await expect(input).toBeFocused()
  await input.fill('view customizations')
  await overlay.getByTestId('command-result').filter({ hasText: 'View Tweaks' }).first().click()
  const lib = await libraryPage(app)
  await expect(lib.getByTestId('library')).toHaveAttribute('data-open', 'true')
  await expect(lib.getByTestId('library-section')).toHaveAttribute('data-section-id', 'tweaks')

  // By site, a site's oldest first: the name, and the site where the name doesn't say it.
  const rows = lib.getByTestId('tweak-row')
  await expect(rows.getByTestId('tweak-row-name')).toHaveText(['Dark news', 'Big text', 'shop.lib.test'])
  await expect(rows.nth(0).getByTestId('tweak-row-site')).toHaveText('news.lib.test')
  await expect(rows.nth(1).getByTestId('tweak-row-site')).toHaveText('news.lib.test and its subdomains')
  await expect(rows.nth(2).getByTestId('tweak-row-site')).toHaveCount(0)
  await expect(lib.getByTestId('tweak-row-js')).toHaveCount(1)
  await expect(rows.nth(0).getByTestId('tweak-row-js')).toBeVisible()
  await expect(lib.getByTestId('tweaks-count')).toHaveText('3 Tweaks')

  // The switch: off, the page loses the Tweak at once, which keeps all it had; on, it is back.
  const toggle = rows.nth(0).getByTestId('tweak-row-switch')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(rows.nth(0)).toHaveAttribute('data-on', 'false')
  await expect.poll(() => bgOf(news.page)).toBe(WHITE)
  expect(await zoomOf(news.page)).toBe('1.25')
  expect((await state(app)).tweaks[dark]).toMatchObject({ enabled: false, css: 'body { background: #123456 }' })
  await toggle.click()
  await expect.poll(() => bgOf(news.page)).toBe(NAVY)

  // Keys on the chosen row: F2 renames in place (Esc leaves it as it was), Space switches, Delete
  // asks (Esc keeps it). The Library stays open through all of them.
  await rows.nth(1).getByTestId('tweak-row-name').click()
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true')
  await lib.keyboard.press('F2')
  const rename = lib.getByTestId('tweak-row-rename')
  await expect(rename).toBeFocused()
  await rename.fill('Nope')
  await lib.keyboard.press('Escape')
  await expect(rename).toHaveCount(0)
  await expect(rows.nth(1).getByTestId('tweak-row-name')).toHaveText('Big text')
  await expect(lib.getByTestId('tweaks-list')).toBeFocused()
  await lib.keyboard.press('Space')
  await expect(rows.nth(1)).toHaveAttribute('data-on', 'false')
  await expect.poll(() => zoomOf(news.page)).toBe('1')
  await lib.keyboard.press('Space')
  await expect.poll(() => zoomOf(news.page)).toBe('1.25')
  await lib.keyboard.press('Delete')
  const confirm = lib.getByTestId('tweaks-delete-confirm')
  await expect(confirm).toContainText('Delete “Big text”?')
  await lib.keyboard.press('Escape')
  await expect(confirm).toHaveCount(0)
  await expect(rows).toHaveCount(3)
  await expect(lib.getByTestId('library')).toHaveAttribute('data-open', 'true')

  // Right-click: the row's menu. Rename… edits the name in place; Enter keeps it.
  await rows.nth(2).click({ button: 'right' })
  const menu = lib.getByTestId('tweaks-menu')
  await expect(menu.getByRole('menuitem')).toHaveText(['Edit', 'Open Site', 'Rename…', 'Delete…'])
  await menu.getByTestId('tweaks-menu-rename').click()
  await expect(rename).toBeFocused()
  await rename.fill('Shop calm')
  await rename.press('Enter')
  await expect.poll(async () => (await state(app)).tweaks[calm]?.name).toBe('Shop calm')
  await expect(rows.getByTestId('tweak-row-name')).toHaveText(['Dark news', 'Big text', 'Shop calm'])
  await expect(rows.nth(2).getByTestId('tweak-row-site')).toHaveText('shop.lib.test')

  // ⋯ opens the same menu; Esc closes it, not the Library.
  await rows.nth(0).hover()
  await rows.nth(0).getByTestId('tweak-row-more').click()
  await expect(menu).toBeVisible()
  await lib.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(lib.getByTestId('library')).toHaveAttribute('data-open', 'true')

  // Delete… asks first: Cancel keeps it; Delete takes it away, and its styles leave the page at once.
  await rows.nth(0).click({ button: 'right' })
  await menu.getByTestId('tweaks-menu-delete').click()
  await expect(confirm).toContainText('Delete “Dark news”?')
  await expect(confirm).toContainText('Pages its JavaScript already ran on are back to normal when they next load.')
  await lib.getByTestId('tweaks-delete-confirm-cancel').click()
  await expect(confirm).toHaveCount(0)
  await expect(rows).toHaveCount(3)
  await rows.nth(0).click({ button: 'right' })
  await menu.getByTestId('tweaks-menu-delete').click()
  await lib.getByTestId('tweaks-delete-confirm-ok').click()
  await expect(rows.getByTestId('tweak-row-name')).toHaveText(['Big text', 'Shop calm'])
  await expect(lib.getByTestId('tweaks-count')).toHaveText('2 Tweaks')
  expect((await state(app)).tweaks[dark]).toBeUndefined()
  await expect.poll(() => bgOf(news.page)).toBe(WHITE)
  expect(await zoomOf(news.page)).toBe('1.25')
})

test('[BO-15] Edit and Open Site show the Tweak’s site: its tab in the Space where there is one, else a new tab where the Tweak was made; Edit opens the editor on it once the page can take it; the Library closes', async () => {
  orbit = await launchOrbit({ args: HOST_ARGS })
  const { app } = orbit
  const news = await openPage(app, '/page/News', 'news.lib.test')
  const dark = await makeTweak(app, news.tabId, { name: 'Dark news', css: 'body { background: #123456 }' })
  const shop = await openPage(app, '/page/Shop', 'shop.lib.test')
  const calm = await makeTweak(app, shop.tabId, { name: 'Shop calm', style: { size: 110 } })
  // Where it was made: the scheme, host and port of the page.
  expect((await state(app)).tweaks[calm]?.origin).toBe(fx.url('', 'shop.lib.test'))
  const tabs = await tabCount(app)

  // Edit, from the shop's page: the news tab comes forward, the Library goes, the editor opens on it.
  let lib = await viewTweaks(app)
  const rows = lib.getByTestId('tweak-row')
  await rows.filter({ hasText: 'Dark news' }).click({ button: 'right' })
  await lib.getByTestId('tweaks-menu-edit').click()
  await expect(lib.getByTestId('library')).toHaveAttribute('data-open', 'false')
  await waitEditor(app, true)
  expect(await editorInfo(app)).toMatchObject({ open: true, tweakId: dark, tabId: news.tabId })
  expect(await activeId(app)).toBe(news.tabId)
  expect(await tabCount(app)).toBe(tabs)
  await run(app, 'tweaks.closeEditor', {})
  await waitEditor(app, false)

  // Open Site with no tab of the site: a new tab where the Tweak was made, the Tweak on in it.
  await cmd(app, 'tabs.close', { tabId: shop.tabId })
  lib = await viewTweaks(app)
  await rows.filter({ hasText: 'Shop calm' }).click({ button: 'right' })
  await lib.getByTestId('tweaks-menu-open').click()
  await expect(lib.getByTestId('library')).toHaveAttribute('data-open', 'false')
  const home = fx.url('/', 'shop.lib.test')
  await expect.poll(async () => (await state(app)).tabs[(await activeId(app)) ?? '']?.url).toBe(home)
  const homeTab = (await activeId(app)) as string
  const homePage = await tabPage(app, home)
  await expect(homePage.locator('#title')).toHaveText('Home')
  await expect.poll(() => zoomOf(homePage)).toBe('1.1')
  expect((await editorInfo(app)).open).toBe(false)

  // Open Site again, from another tab: that tab, not a new one.
  await cmd(app, 'tabs.activate', { tabId: news.tabId })
  lib = await viewTweaks(app)
  await rows.filter({ hasText: 'Shop calm' }).click({ button: 'right' })
  await lib.getByTestId('tweaks-menu-open').click()
  await expect.poll(() => activeId(app)).toBe(homeTab)
  expect(await tabCount(app)).toBe(tabs)

  // Edit (Enter on the chosen row) with no tab of the site: a new tab, and the editor on it.
  await cmd(app, 'tabs.activate', { tabId: news.tabId })
  await cmd(app, 'tabs.close', { tabId: homeTab })
  lib = await viewTweaks(app)
  await lib.keyboard.press('End')
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true')
  await lib.keyboard.press('Enter')
  await waitEditor(app, true)
  const info = await editorInfo(app)
  expect(info.tweakId).toBe(calm)
  expect(info.tabId).not.toBe(homeTab)
  expect((await state(app)).tabs[info.tabId ?? '']?.url).toBe(home)
  expect(await activeId(app)).toBe(info.tabId)

  // Edit while the site's tab still waits for its server: the editor opens on that tab once its
  // page can take it.
  await run(app, 'tweaks.closeEditor', {})
  await waitEditor(app, false)
  await cmd(app, 'tabs.close', { tabId: info.tabId })
  fx.slowHome(4000)
  const waiting = await newTab(app, home)
  lib = await viewTweaks(app)
  await lib.keyboard.press('End')
  await lib.keyboard.press('Enter')
  await waitEditor(app, true)
  expect(await editorInfo(app)).toMatchObject({ open: true, tweakId: calm, tabId: waiting })
  expect(await tabCount(app)).toBe(tabs)
})

test('[BO-15] with no Tweaks, the Library explains them and offers Tweak This Site for the page underneath, where it is a website', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const history = await newTab(app, 'orbit://history/')
  await expect.poll(async () => (await state(app)).tabs[history]?.url).toBe('orbit://history/')
  let lib = await viewTweaks(app)
  await expect(lib.getByTestId('tweaks-empty')).toContainText('No Tweaks yet')
  await expect(lib.getByTestId('tweaks-count')).toHaveCount(0)
  // Not a website: nothing to tweak.
  await expect(lib.getByTestId('tweaks-create')).toBeDisabled()
  await run(app, 'library.close', {})

  const { tabId } = await openPage(app, '/page/Empty')
  lib = await viewTweaks(app)
  const create = lib.getByTestId('tweaks-create')
  await expect(create).toBeEnabled()
  await create.click()
  await expect(lib.getByTestId('library')).toHaveAttribute('data-open', 'false')
  await waitEditor(app, true)
  expect(await edited(app)).toMatchObject({ host: 'localhost', origin: fx.url('') })
  expect((await editorInfo(app)).tabId).toBe(tabId)
})

test('[BO-16] the switch in Settings → Advanced takes every Tweak off every page at once, closes the editor, and hides or stops each way to make one; turned back on, from the Library, each Tweak is on or off as it was', async () => {
  orbit = await launchOrbit()
  const { app, shell } = orbit
  const { tabId, page } = await openPage(app, '/page/Global')
  const dark = await makeTweak(app, tabId, { name: 'Dark', css: 'body { background: #123456 }' })
  const big = await makeTweak(app, tabId, { name: 'Big', style: { size: 125 } })
  await run(app, 'tweaks.setEnabled', { id: big, enabled: false })
  await expect.poll(() => bgOf(page)).toBe(NAVY)
  expect(await zoomOf(page)).toBe('1')
  await expect(shell.getByTestId('tweak-button')).toHaveAttribute('data-state', 'on')
  await run(app, 'tweaks.edit', { id: dark, tabId })
  await waitEditor(app, true)

  const settings = await openSettings(app, { section: 'advanced', item: 'tweaks-enabled' })
  await expect(settings.getByTestId('setting-tweaks-enabled')).toContainText('Apply Tweaks on websites I visit')
  const on = settings.getByTestId('tweaks-enabled')
  await expect(on).toHaveAttribute('aria-checked', 'true')
  await on.click()
  await expect(on).toHaveAttribute('aria-checked', 'false')
  expect((await state(app)).settings.tweaksEnabled).toBe(false)
  // Off every page at once; the editor closes; each Tweak keeps its own on or off.
  await expect.poll(() => bgOf(page)).toBe(WHITE)
  expect(await zoomOf(page)).toBe('1')
  await waitEditor(app, false)
  const own = async () => (await tweakList(app)).map((t) => [t.name, t.enabled])
  expect(await own()).toEqual([
    ['Dark', true],
    ['Big', false],
  ])

  // Each way to make one is gone, or says why.
  await focusBrowserWindow(app)
  await expect(shell.getByTestId('tweak-button')).toHaveCount(0)
  await cmd(app, 'tabs.contextMenu', { id: tabId })
  expect(await tabsHook<string[]>(app, 'lastMenu')).not.toContain('Tweak this Site…')
  await shell.getByTestId('sidebar-plus').click()
  const overlay = await viewPage(app, 'overlay')
  await expect(overlay.getByTestId('menu-plus-folder')).toBeVisible()
  await expect(overlay.getByTestId('menu-plus-tweak')).toHaveCount(0)
  await overlay.keyboard.press('Escape')
  await expect(overlay.getByTestId('plus-menu')).toBeHidden()
  await act(app, 'tweak.new')
  await expect(shell.getByTestId('toast').filter({ hasText: 'Tweaks are turned off in Settings' })).toBeVisible()
  expect(await tweakList(app)).toHaveLength(2)
  await shell.getByTestId('site-controls-button').click()
  await expect(overlay.getByTestId('site-tweaks-off')).toBeVisible()
  await expect(overlay.getByTestId('site-tweak')).toHaveCount(0)
  await overlay.keyboard.press('Escape')
  await expect(overlay.getByTestId('site-controls')).toBeHidden()

  // The Library says so: Edit waits; Turn On brings them back, each as it was, and Settings follows.
  const lib = await viewTweaks(app)
  await expect(lib.getByTestId('tweaks-off')).toBeVisible()
  await lib.getByTestId('tweak-row').first().click({ button: 'right' })
  await expect(lib.getByTestId('tweaks-menu-edit')).toBeDisabled()
  await lib.keyboard.press('Escape')
  await lib.getByTestId('tweaks-turn-on').click()
  await expect(lib.getByTestId('tweaks-off')).toHaveCount(0)
  await expect(on).toHaveAttribute('aria-checked', 'true')
  await expect.poll(() => bgOf(page)).toBe(NAVY)
  expect(await zoomOf(page)).toBe('1')
  expect(await own()).toEqual([
    ['Dark', true],
    ['Big', false],
  ])
})
