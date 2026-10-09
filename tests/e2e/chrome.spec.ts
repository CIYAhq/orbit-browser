import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { isMac, launchOrbit, type Orbit, state, tabPage, viewPage } from './helpers'
import {
  activeTab,
  chooseHistory,
  cmd,
  HOST_RULES,
  historyMenu,
  INSECURE_HOST,
  type NavFixtures,
  NEW_TAB_CLICK,
  openTab,
  shellRoundTrip,
  spyCommand,
  startNavFixtures,
  tabCount,
  visit,
  waitLoaded,
  windowState,
} from './nav-support'

let fx: NavFixtures
let orbit: Orbit

test.beforeAll(async () => {
  fx = await startNavFixtures()
})
test.afterAll(async () => {
  await fx.close()
})
test.beforeEach(async () => {
  orbit = await launchOrbit({ args: [HOST_RULES] })
  // macOS keeps the clipboard between tests (even after the app quits): start empty.
  await orbit.app.evaluate(({ clipboard }) => clipboard.clear())
})
test.afterEach(async () => {
  await orbit.app.close()
})

const page = (title: string) => fx.url(`/page/${title}`)

/** Opens the first page in a new tab, then visits the others in that tab. Returns the tab. */
async function tabWithHistory(...titles: [string, ...string[]]): Promise<string> {
  const [first, ...rest] = titles
  const id = await openTab(orbit.app, page(first))
  for (const title of rest) await visit(orbit.app, id, page(title))
  return id
}

/** The tab ids other than the given ones. */
async function otherTabs(...known: string[]): Promise<string[]> {
  return Object.keys((await state(orbit.app)).tabs).filter((id) => !known.includes(id))
}

test('[SB-03][NV-01] Back and Forward grey out when there is nowhere to go and act on the active tab', async () => {
  const { app, shell } = orbit
  const back = shell.getByTestId('nav-back')
  const forward = shell.getByTestId('nav-forward')
  const reload = shell.getByTestId('nav-reload')
  // No tab yet: nothing to act on.
  await expect(back).toBeDisabled()
  await expect(forward).toBeDisabled()
  await expect(reload).toBeDisabled()

  const id = await tabWithHistory('Alpha')
  await expect(reload).toBeEnabled()
  await expect(back).toBeDisabled()
  await visit(app, id, page('Beta'))
  await expect(back).toBeEnabled()
  await expect(forward).toBeDisabled()

  await back.click()
  await waitLoaded(app, id, page('Alpha'))
  await expect(forward).toBeEnabled()
  await expect(back).toBeDisabled()
  await forward.click()
  await waitLoaded(app, id, page('Beta'))
  await expect(forward).toBeDisabled()
  // Tooltips name the keys (KS-08).
  await expect(back).toHaveAttribute('title', isMac ? 'Back (⌘[)' : 'Back (Alt+←)')
  await expect(forward).toHaveAttribute('title', isMac ? 'Forward (⌘])' : 'Forward (Alt+→)')
  await expect(reload).toHaveAttribute('title', isMac ? 'Reload (⌘R)' : 'Reload (Ctrl+R)')
})

test('[SB-03][NV-01] long-press on Back lists the history nearest first, with icons; choosing one goes there', async () => {
  const { app, shell } = orbit
  const id = await tabWithHistory('One', 'Two', 'Three', 'Four')
  const presses = await spyCommand(app, 'nav.press')
  await shell.getByTestId('nav-back').hover()
  await shell.mouse.down()
  await expect
    .poll(() => historyMenu(app))
    .toMatchObject({ direction: 'back', labels: ['Three', 'Two', 'One'], icons: [true, true, true] })
  await shell.mouse.up()
  await shellRoundTrip(shell)
  // The long-press opened the menu instead of going back.
  expect(await presses()).toBe(0)
  expect((await state(app)).tabs[id]?.url).toBe(page('Four'))

  expect(await chooseHistory(app, 'One')).toBe(true)
  await waitLoaded(app, id, page('One'))
  expect(await historyMenu(app)).toBeNull()
  // Forward's menu lists the pages ahead, nearest first.
  await shell.getByTestId('nav-forward').hover()
  await shell.mouse.down()
  await expect.poll(() => historyMenu(app)).toMatchObject({ direction: 'forward', labels: ['Two', 'Three', 'Four'] })
  await shell.mouse.up()
  expect(await chooseHistory(app, 'Three')).toBe(true)
  await waitLoaded(app, id, page('Three'))
})

test('[NV-01] right-click on Back opens the history menu at once; switching tab closes it', async () => {
  const { app, shell } = orbit
  const id = await tabWithHistory('Red', 'Green')
  const other = await cmd<string>(app, 'tabs.create', { url: page('Blue'), activate: false })
  expect((await activeTab(app)).id).toBe(id)
  await shell.getByTestId('nav-back').click({ button: 'right' })
  await expect.poll(() => historyMenu(app)).toMatchObject({ direction: 'back', labels: ['Red'] })
  await cmd(app, 'tabs.activate', { tabId: other })
  await expect.poll(() => historyMenu(app)).toBeNull()
  // Nothing left to choose: the menu of the old tab is gone.
  expect(await chooseHistory(app, 'Red')).toBe(false)
  expect((await state(app)).tabs[id]?.url).toBe(page('Green'))
})

test('[SB-03][NV-01] ⌘-click or middle-click on Back opens the previous page in a new tab; the tab stays', async () => {
  const { app, shell } = orbit
  const id = await tabWithHistory('Before', 'Current')
  const back = shell.getByTestId('nav-back')

  await back.click({ modifiers: [NEW_TAB_CLICK] })
  await expect.poll(async () => (await otherTabs(id)).length).toBe(1)
  const [first] = await otherTabs(id)
  await waitLoaded(app, first as string, page('Before'))
  // The original tab still shows its page and stays selected.
  expect((await activeTab(app)).id).toBe(id)
  expect((await state(app)).tabs[id]?.url).toBe(page('Current'))
  // The new tab keeps the history: Forward leads to the page the click was made on.
  await expect.poll(async () => (await state(app)).tabs[first as string]?.canGoForward).toBe(true)

  await back.click({ button: 'middle' })
  await expect.poll(async () => (await otherTabs(id)).length).toBe(2)
  const [second] = await otherTabs(id, first as string)
  await waitLoaded(app, second as string, page('Before'))
  expect((await activeTab(app)).id).toBe(id)

  // With ⇧ the new tab comes to the front.
  await back.click({ modifiers: [NEW_TAB_CLICK, 'Shift'] })
  await expect.poll(async () => (await otherTabs(id)).length).toBe(3)
  const [third] = await otherTabs(id, first as string, second as string)
  await expect.poll(async () => (await activeTab(app)).id).toBe(third)
  expect((await state(app)).tabs[id]?.url).toBe(page('Current'))
})

test('[SB-03][NV-03] ⌘-click or middle-click on Reload duplicates the tab; the original stays selected', async () => {
  const { app, shell } = orbit
  const id = await tabWithHistory('Origin', 'Twin')
  const reload = shell.getByTestId('nav-reload')
  const before = await tabCount(app)

  await reload.click({ modifiers: [NEW_TAB_CLICK] })
  await expect.poll(() => tabCount(app)).toBe(before + 1)
  const [copy] = await otherTabs(id)
  await waitLoaded(app, copy as string, page('Twin'))
  expect((await state(app)).tabs[id]?.url).toBe(page('Twin'))
  expect((await activeTab(app)).id).toBe(id)
  // The duplicate has the history too.
  await expect.poll(async () => (await state(app)).tabs[copy as string]?.canGoBack).toBe(true)

  await reload.click({ button: 'middle' })
  await expect.poll(() => tabCount(app)).toBe(before + 2)
  expect((await activeTab(app)).id).toBe(id)
})

test('[SB-03][NV-04] Reload turns into Stop while the page loads; clicking it stops the load', async () => {
  const { app, shell } = orbit
  const path = '/slow-reload/Slow'
  const id = await openTab(app, fx.url(path))
  const reload = shell.getByTestId('nav-reload')
  await reload.click()
  // The reload is under way (the server holds it): the button is Stop now.
  await expect.poll(() => fx.hits(path)).toBe(2)
  await expect(reload).toHaveAttribute('data-loading', 'true')
  await expect(reload).toHaveAttribute('title', 'Stop (Esc)')
  await expect(reload).toHaveAttribute('aria-label', 'Stop')
  await reload.click()
  await expect.poll(async () => (await state(app)).tabs[id]?.loading).toBe(false)
  await expect(reload).not.toHaveAttribute('data-loading')
  await expect(reload).toHaveAttribute('aria-label', 'Reload')
  // The page that was showing stays.
  const shown = await tabPage(app, path)
  expect(await shown.evaluate(() => sessionStorage.getItem('loads'))).toBe('1')
})

test('[SB-03][NV-04] double-clicking Reload stops loading', async () => {
  const { app, shell } = orbit
  const reload = shell.getByTestId('nav-reload')
  // While a navigation is under way.
  const id = await openTab(app, page('Start'))
  await cmd(app, 'tabs.navigate', { tabId: id, url: fx.url('/slow/Never') })
  await expect.poll(() => fx.hits('/slow/Never')).toBe(1)
  await expect(reload).toHaveAttribute('data-loading', 'true')
  await reload.dblclick()
  await expect.poll(async () => (await state(app)).tabs[id]?.loading).toBe(false)
  expect((await state(app)).tabs[id]?.url).toBe(page('Start'))

  // On a loaded page: the first click reloads, the second stops that reload.
  const path = '/slow-reload/Again'
  const other = await openTab(app, fx.url(path))
  await reload.dblclick()
  await expect.poll(async () => (await state(app)).tabs[other]?.loading).toBe(false)
  await expect(reload).not.toHaveAttribute('data-loading')
  const shown = await tabPage(app, path)
  expect(await shown.evaluate(() => sessionStorage.getItem('loads'))).toBe('1')
})

test('[SB-03] the sidebar-toggle button hides the sidebar', async () => {
  const { app, shell } = orbit
  const toggle = shell.getByTestId('toggle-sidebar')
  await expect(toggle).toHaveAttribute('title', isMac ? 'Hide sidebar (⌘S)' : 'Hide sidebar (Ctrl+S)')
  await toggle.click()
  await expect.poll(async () => (await windowState(app)).sidebar.visible).toBe(false)
})

test('[SB-03] at the narrowest sidebar Back, Forward and Reload stay; the toggle gives way first', async () => {
  const { app, shell } = orbit
  await tabWithHistory('Narrow', 'Narrower')
  const sidebar = shell.getByTestId('sidebar')
  const toggle = shell.getByTestId('toggle-sidebar')
  await expect(toggle).toBeVisible()
  await cmd(app, 'window.setSidebar', { width: 180 })
  await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBeLessThanOrEqual(180)
  await expect(toggle).toBeHidden()
  const box = await sidebar.boundingBox()
  if (!box) throw new Error('no sidebar')
  const lead = await shell.getByTestId(isMac ? 'traffic-space' : 'window-controls').boundingBox()
  for (const testId of ['nav-back', 'nav-forward', 'nav-reload']) {
    const button = shell.getByTestId(testId)
    await expect(button).toBeVisible()
    const b = await button.boundingBox()
    if (!b || !lead) throw new Error(`no box for ${testId}`)
    expect(b.width).toBeGreaterThanOrEqual(24)
    // Inside the sidebar, clear of the window controls.
    expect(b.x).toBeGreaterThanOrEqual(lead.x + lead.width)
    expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width)
  }
})

test('[SB-03] off macOS the window controls sit at the top left of the sidebar', async () => {
  test.skip(isMac, 'macOS draws its own traffic lights there')
  const { shell } = orbit
  const controls = shell.getByTestId('window-controls')
  await expect(controls).toBeVisible()
  for (const title of ['Close', 'Minimize', 'Maximize']) await expect(controls.getByTitle(title)).toBeVisible()
  const c = await controls.boundingBox()
  const back = await shell.getByTestId('nav-back').boundingBox()
  if (!c || !back) throw new Error('no boxes')
  expect(c.x).toBeLessThan(back.x)
})

test('[SB-04] the address shows only the host; clicking it edits the full URL in the command bar', async () => {
  const { app, shell } = orbit
  const url = fx.url('/page/Deep?x=1')
  await openTab(app, url)
  const pill = shell.getByTestId('address-pill')
  await expect(pill).toHaveText(`localhost:${fx.port}`)
  await expect(pill).toHaveAttribute('title', url)
  await pill.click()
  const overlay = await viewPage(app, 'overlay')
  const input = overlay.getByTestId('command-input')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue(url)
  expect((await windowState(app)).overlay).toMatchObject({ kind: 'commandbar', mode: 'edit-url' })
})

test('[SB-04] no padlock on pages; plain http to another machine shows a warning', async () => {
  const { app, shell } = orbit
  const address = shell.getByTestId('address')
  await expect(address).toHaveClass(/address--empty/)
  await openTab(app, fx.urlOn(INSECURE_HOST, '/page/Plain'))
  await expect(address).toHaveAttribute('data-connection', 'insecure')
  await expect(shell.getByTestId('insecure-icon')).toBeVisible()
  await expect(shell.getByTestId('address-pill')).toHaveText(`${INSECURE_HOST}:${fx.port}`)
  // This machine over http is a secure context: no warning, and never a padlock.
  await openTab(app, page('Local'))
  await expect(address).toHaveAttribute('data-connection', 'local')
  await expect(shell.getByTestId('insecure-icon')).toHaveCount(0)
  await expect(shell.getByTestId('site-controls-button')).toBeVisible()
  await expect(address.locator('.lucide-lock')).toHaveCount(0)
})

test('[SB-04][NV-17] the copy button copies the clean URL and confirms it', async () => {
  const { app, shell } = orbit
  await openTab(app, fx.url('/page/Shop?utm_source=x&id=7'))
  await shell.getByTestId('address').hover()
  const copy = shell.getByTestId('copy-url-button')
  await expect(copy).toHaveCSS('opacity', '1')
  await copy.click()
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(fx.url('/page/Shop?id=7'))
  await expect(shell.getByTestId('toast').filter({ hasText: 'Copied' })).toBeVisible()
  await expect(copy).toHaveClass(/is-copied/)
})

test('[NV-17] copying the address from the command bar shows a one-time tip about the shortcut', async () => {
  const { app, shell } = orbit
  const url = page('Hint')
  await openTab(app, url)
  const hints = await spyCommand(app, 'nav.copyHint')
  const tip = shell.getByTestId('toast').filter({ hasText: 'Tip:' })

  const copyFromBar = async () => {
    await shell.getByTestId('address-pill').click()
    const overlay = await viewPage(app, 'overlay')
    const input = overlay.getByTestId('command-input')
    await expect(input).toBeFocused()
    await expect(input).toHaveValue(url)
    // ⌘C reaches the field through the Edit menu on macOS, which calls copy() on the page.
    if (isMac) {
      await app.evaluate(({ webContents }) =>
        webContents
          .getAllWebContents()
          .find((w) => w.getURL().includes('view=overlay'))
          ?.copy(),
      )
    } else {
      await overlay.keyboard.press('Control+C')
    }
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(url)
    await overlay.keyboard.press('Escape')
    await expect.poll(async () => (await windowState(app)).overlay.kind).toBe('none')
  }

  await copyFromBar()
  await expect(tip).toBeVisible()
  await expect(tip).toContainText(isMac ? '⇧⌘C' : 'Ctrl+Shift+C')
  expect(await hints()).toBe(1)
  // Remembered for good (a file in the profile directory).
  const file = join(orbit.userData, 'orbit-site-prefs.json')
  await expect
    .poll(() => existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).hints?.['copy-url'] === true)
    .toBe(true)
  await expect(tip).toHaveCount(0)
  // The second time: no tip.
  await copyFromBar()
  await expect.poll(() => hints()).toBe(2)
  await expect(tip).toHaveCount(0)
})

test('[SB-04][SB-03] in split view the address and buttons follow the focused pane', async () => {
  const { app, shell } = orbit
  const left = await tabWithHistory('LeftOne', 'LeftTwo')
  const right = await openTab(app, fx.urlOn('127.0.0.1', '/page/Right'))
  await cmd(app, 'split.create', { tabIds: [left, right], focus: right })
  const pill = shell.getByTestId('address-pill')
  await expect(pill).toHaveText(`127.0.0.1:${fx.port}`)
  await expect(shell.getByTestId('nav-back')).toBeDisabled()
  await cmd(app, 'split.focusPane', { tabId: left })
  await expect(pill).toHaveText(`localhost:${fx.port}`)
  await shell.getByTestId('nav-back').click()
  await waitLoaded(app, left, page('LeftOne'))
  expect((await state(app)).tabs[right]?.url).toBe(fx.urlOn('127.0.0.1', '/page/Right'))
})

test('[NV-01][SB-03] Back on a fresh tab opened from a link closes it and returns to the opener', async () => {
  const { app, shell } = orbit
  const opener = await openTab(app, page('Parent'))
  const tab = await tabPage(app, '/page/Parent')
  await tab.click('#child')
  await expect.poll(async () => (await otherTabs(opener)).length).toBe(1)
  const [child] = await otherTabs(opener)
  await waitLoaded(app, child as string, page('Parent-child'))
  await expect.poll(async () => (await activeTab(app)).id).toBe(child)
  const back = shell.getByTestId('nav-back')
  await expect(back).toBeEnabled()
  await back.click()
  await expect.poll(async () => (await state(app)).tabs[child as string]).toBeUndefined()
  expect((await activeTab(app)).id).toBe(opener)
})
