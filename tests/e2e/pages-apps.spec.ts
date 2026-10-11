import { type ElectronApplication, expect, test } from '@playwright/test'
import { activeTabId, launchOrbit, type Orbit, state, tabPage } from './helpers'
import {
  APP_ICON,
  APPS_ENV,
  dialogPage,
  launchedLinks,
  type PagesFixtures,
  pageDialogs,
  startPagesFixtures,
  waitDialog,
} from './pages-support'
import { newTab, tab, waitTab } from './tabs-support'

let fx: PagesFixtures
let orbit: Orbit

test.beforeAll(async () => {
  fx = await startPagesFixtures()
})
test.afterAll(async () => {
  await fx.close()
})
test.beforeEach(async () => {
  orbit = await launchOrbit({ env: APPS_ENV })
})
test.afterEach(async () => {
  await orbit.app.close()
})

const MAIL = 'mailto:someone@example.com?subject=Hello%20there'

/** A tab on the `/apps` fixture (optionally with a frame), loaded, and its page. */
async function openApps(app: ElectronApplication, frame?: string) {
  const path = `/apps${frame ? `?frame=${encodeURIComponent(frame)}` : ''}`
  const tabId = await newTab(app, fx.url(path))
  await waitTab(app, tabId, '/apps')
  return { tabId, page: await tabPage(app, '/apps') }
}

const tabIds = async (app: ElectronApplication) => Object.keys((await state(app)).tabs).sort()
const windowCount = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
const noDialogs = async (app: ElectronApplication) => (await pageDialogs(app)).length === 0

test('[NV-19] a mailto: link asks first, naming the app with its icon and the site; Cancel, the default, leaves the page as it was and opens no tab', async () => {
  const { app } = orbit
  const { tabId, page } = await openApps(app)
  const before = await tabIds(app)
  await page.locator('#mail').click()
  const asked = await waitDialog(app, (d) => d.tabId === tabId && d.kind === 'app' && d.onScreen)
  expect(asked).toMatchObject({ title: 'Open Mail?', message: `localhost:${fx.port} wants to open this application.` })
  await expect.poll(async () => (await waitDialog(app, (d) => d.id === asked.id)).focused).toBe(true)
  const view = await dialogPage(app, asked.id)
  await expect(view.getByTestId('page-dialog-icon')).toHaveAttribute('src', APP_ICON)
  await expect(view.getByTestId('page-dialog-ok')).toHaveText('Open Mail')
  const check = view.getByTestId('page-dialog-check')
  await expect(check).not.toBeChecked()
  await expect(view.locator('label', { has: check })).toHaveText(
    `Always allow localhost:${fx.port} to open links of this type in the associated app`,
  )
  // The keyboard starts on Cancel, and Tab goes round the card: the checkbox, Cancel, Open.
  const cancel = view.getByTestId('page-dialog-cancel')
  await expect(cancel).toBeFocused()
  await view.keyboard.press('Tab')
  await expect(view.getByTestId('page-dialog-ok')).toBeFocused()
  await view.keyboard.press('Tab')
  await expect(check).toBeFocused()
  // Space checks it; Enter there still gives Cancel, the safe answer.
  await view.keyboard.press('Space')
  await expect(check).toBeChecked()
  await view.keyboard.press('Enter')
  await expect.poll(() => noDialogs(app)).toBe(true)

  // Esc cancels too, and Enter on Cancel.
  await page.locator('#mail').click()
  const again = await waitDialog(app, (d) => d.kind === 'app' && d.id !== asked.id && d.focused)
  await (await dialogPage(app, again.id)).keyboard.press('Escape')
  await expect.poll(() => noDialogs(app)).toBe(true)
  await page.locator('#mail').click()
  const third = await waitDialog(app, (d) => d.kind === 'app' && d.id > again.id && d.focused)
  await (await dialogPage(app, third.id)).keyboard.press('Enter')
  await expect.poll(() => noDialogs(app)).toBe(true)

  // Nothing opened, nothing was always allowed, and the page is as it was, with no new tab.
  expect(await launchedLinks(app)).toEqual([])
  expect(await page.evaluate(() => location.href)).toBe(fx.url('/apps'))
  expect(await tab(app, tabId)).toMatchObject({ url: fx.url('/apps'), title: 'Apps', loading: false })
  expect((await tab(app, tabId))?.pendingUrl).toBeUndefined()
  expect(await tabIds(app)).toEqual(before)
  await page.locator('#mail').click()
  await waitDialog(app, (d) => d.kind === 'app' && d.id > third.id && d.onScreen)
})

test('[NV-19] Open launches the app; “Always allow” opens that site’s links of that kind without asking, after a restart too, and no other site’s', async () => {
  const frameSite = `127.0.0.1:${fx.port}`
  const first = await openApps(orbit.app, `http://${frameSite}/app-frame`)
  await first.page.locator('#mail').click()
  const asked = await waitDialog(orbit.app, (d) => d.kind === 'app' && d.focused)
  const view = await dialogPage(orbit.app, asked.id)
  await view.getByTestId('page-dialog-check').check()
  await view.getByTestId('page-dialog-ok').click()
  await expect.poll(() => launchedLinks(orbit.app)).toEqual([MAIL])
  expect(await noDialogs(orbit.app)).toBe(true)
  // The same site's next mailto: link opens without asking.
  await first.page.locator('#mail').click()
  await expect.poll(() => launchedLinks(orbit.app)).toEqual([MAIL, MAIL])
  expect(await noDialogs(orbit.app)).toBe(true)
  // Another kind of link still asks; its app has no name here, so the dialog names none.
  await first.page.locator('#call').click()
  const call = await waitDialog(orbit.app, (d) => d.kind === 'app' && d.focused)
  expect(call).toMatchObject({
    title: 'Open this link in another app?',
    message: `localhost:${fx.port} wants to open a link in another app.`,
  })
  const callView = await dialogPage(orbit.app, call.id)
  await expect(callView.getByTestId('page-dialog-ok')).toHaveText('Open link')
  await expect(callView.getByTestId('page-dialog-icon')).toHaveCount(0)
  await callView.getByTestId('page-dialog-cancel').click()
  await expect.poll(() => noDialogs(orbit.app)).toBe(true)
  // A frame from another site asks in its own name: the page's choice isn't its.
  await first.page.frameLocator('#frame').locator('#frame-mail').click()
  const framed = await waitDialog(orbit.app, (d) => d.kind === 'app' && d.focused)
  expect(framed.message).toBe(`${frameSite} wants to open this application.`)
  await (await dialogPage(orbit.app, framed.id)).keyboard.press('Escape')
  await expect.poll(() => noDialogs(orbit.app)).toBe(true)
  expect(await launchedLinks(orbit.app)).toEqual([MAIL, MAIL])

  // After a restart, the choice holds.
  const { userData } = orbit
  await orbit.app.close()
  orbit = await launchOrbit({ userData, env: APPS_ENV })
  const second = await openApps(orbit.app)
  await second.page.locator('#mail').click()
  await expect.poll(() => launchedLinks(orbit.app)).toEqual([MAIL])
  expect(await noDialogs(orbit.app)).toBe(true)
})

test('[NV-19] an always-allowed site opens the app once per user gesture: a timer that follows its link again and again opens it once', async () => {
  const { app } = orbit
  const { page } = await openApps(app)
  await page.locator('#mail').click()
  const asked = await waitDialog(app, (d) => d.kind === 'app' && d.focused)
  const view = await dialogPage(app, asked.id)
  await view.getByTestId('page-dialog-check').check()
  await view.getByTestId('page-dialog-ok').click()
  await expect.poll(() => launchedLinks(app)).toEqual([MAIL])
  // One click in the page, then a timer that follows the link 20 times (review REPRO B).
  await page.locator('#area').click()
  await page.evaluate((mail) => {
    const w = window as unknown as { __tries: number }
    w.__tries = 0
    const timer = setInterval(() => {
      location.href = mail
      if (++w.__tries === 20) clearInterval(timer)
    }, 20)
  }, MAIL)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __tries: number }).__tries)).toBe(20)
  // The timer's first link used the click and opened the app; the other 19 opened nothing. A new
  // click opens it again.
  await page.locator('#mail').click()
  await expect.poll(() => launchedLinks(app)).toEqual([MAIL, MAIL, MAIL])
  expect(await noDialogs(app)).toBe(true)
})

test('[NV-19] a tab or pop-up opened only to launch an app closes itself: the question shows over the page it came from', async () => {
  const { app } = orbit
  const { tabId, page } = await openApps(app)
  const before = await tabIds(app)
  // A mailto: link that opens a new tab.
  await page.locator('#mail-tab').click()
  const asked = await waitDialog(app, (d) => d.kind === 'app' && d.tabId === tabId && d.onScreen)
  expect(asked.message).toBe(`localhost:${fx.port} wants to open this application.`)
  await expect.poll(() => tabIds(app)).toEqual(before)
  expect(await activeTabId(app)).toBe(tabId)
  await (await dialogPage(app, asked.id)).getByTestId('page-dialog-cancel').click()
  await expect.poll(() => noDialogs(app)).toBe(true)

  // A new tab for a web address that redirects to another app's link.
  await page.locator('#app-tab').click()
  const join = await waitDialog(app, (d) => d.kind === 'app' && d.tabId === tabId && d.id > asked.id && d.onScreen)
  expect(join.title).toBe('Open this link in another app?')
  await expect.poll(() => tabIds(app)).toEqual(before)
  expect(await activeTabId(app)).toBe(tabId)
  await (await dialogPage(app, join.id)).getByTestId('page-dialog-ok').click()
  await expect.poll(() => launchedLinks(app)).toEqual(['zoommtg://join?confno=123'])

  // A pop-up window for a mailto: link.
  const windows = await windowCount(app)
  await page.locator('#pop').click()
  const pop = await waitDialog(app, (d) => d.kind === 'app' && d.tabId === tabId && d.id > join.id)
  await expect.poll(() => windowCount(app)).toBe(windows)
  await (await dialogPage(app, pop.id)).getByTestId('page-dialog-cancel').click()
  await expect.poll(() => noDialogs(app)).toBe(true)

  // Nothing left behind: no tab, no Archive entry.
  expect(await tabIds(app)).toEqual(before)
  const { archive } = await state(app)
  expect(archive.filter((a) => /^(mailto|zoommtg):|\/to-app/.test(a.url))).toEqual([])
  expect(await launchedLinks(app)).toEqual(['zoommtg://join?confno=123'])
})
