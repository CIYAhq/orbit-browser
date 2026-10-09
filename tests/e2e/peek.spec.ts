import { expect, test } from '@playwright/test'
import { launchOrbit, type Orbit, run, state, viewPage } from './helpers'
import {
  blockNetwork,
  findPage,
  inTab,
  mainWindow,
  overlayOf,
  pressInTab,
  type Sites,
  sidebarCount,
  startSites,
  viewInfo,
} from './peek-helpers'

/** Peek link previews (spec/peek.md). */

let sites: Sites
let orbit: Orbit
let mainLog: string[] = []

test.beforeAll(async () => {
  sites = await startSites()
})
test.afterAll(async () => {
  await sites.close()
})
test.beforeEach(async () => {
  orbit = await launchOrbit()
  mainLog = []
  orbit.app.process().stderr?.on('data', (d) => mainLog.push(String(d)))
  await blockNetwork(orbit.app)
})
test.afterEach(async () => {
  const info = test.info()
  if (info.status !== info.expectedStatus) await info.attach('main-process.log', { body: mainLog.join('') })
  await orbit.app.close().catch(() => {})
})

/** Opens a page as a pinned tab (or a Favorite) and returns its tab id and page. */
async function pinned(path: string, where: 'pinned' | 'favorites' = 'pinned') {
  const s = await state(orbit.app)
  const win = await mainWindow(orbit.app)
  const space = s.spaces[win.spaceId]
  const container =
    where === 'pinned'
      ? { kind: 'pinned', spaceId: win.spaceId }
      : { kind: 'favorites', profileId: space?.profileId as string }
  const tabId = (await run(orbit.app, 'tabs.create', { url: sites.url(path), container })) as string
  const page = await findPage(orbit.app, path)
  await expect(page.locator('#title')).toBeVisible()
  return { tabId, page }
}

/** Waits until a Peek is open and its card has settled; returns its tab id. */
async function settledPeek(): Promise<string> {
  await expect.poll(async () => (await overlayOf(orbit.app)).kind).toBe('peek')
  const overlay = await overlayOf(orbit.app)
  const tabId = overlay.kind === 'peek' ? overlay.tabId : ''
  const overlayPage = await viewPage(orbit.app, 'overlay')
  // Settled: the page view sits exactly where the overlay draws the card.
  await expect
    .poll(async () => {
      const info = await viewInfo(orbit.app, tabId)
      const card = await overlayPage.getByTestId('peek-card').boundingBox()
      if (!info.bounds || !info.area || !card) return 'pending'
      const dx = Math.abs(info.bounds.x - (info.area.x + card.x))
      const dy = Math.abs(info.bounds.y - (info.area.y + card.y))
      const dw = Math.abs(info.bounds.width - card.width)
      const dh = Math.abs(info.bounds.height - card.height)
      return dx <= 1 && dy <= 1 && dw <= 1 && dh <= 1 && card.width > 200 ? 'on card' : 'moving'
    })
    .toBe('on card')
  return tabId
}

test('[PK-01][PK-02][PK-05][PK-13] an other-site link in a pinned tab opens a Peek card over it', async () => {
  const { tabId: source, page } = await pinned('/site/Pinned')
  const win = await mainWindow(orbit.app)
  const rowsBefore = sidebarCount(await state(orbit.app), win.spaceId)
  await page.locator('#other').click({ noWaitAfter: true })
  const peekTab = await settledPeek()
  const s = await state(orbit.app)
  // The source tab stays selected and loaded underneath; the sidebar gains no row.
  expect((await mainWindow(orbit.app)).activeTab[win.spaceId]).toBe(source)
  expect(sidebarCount(s, win.spaceId)).toBe(rowsBefore)
  expect(s.tabs[peekTab]?.floating).toBe('peek')
  expect(await inTab(orbit.app, source, 'location.pathname')).toBe('/site/Pinned')
  // The Peek page is a real view above the overlay, inset inside the page area (PK-05).
  const info = await viewInfo(orbit.app, peekTab)
  expect(info.url).toContain('127.0.0.1')
  expect(info.inWindow && info.visible && info.aboveOverlay).toBe(true)
  const { area, bounds } = info
  if (!area || !bounds) throw new Error('no geometry')
  expect(bounds.x).toBeGreaterThanOrEqual(area.x + 30)
  expect(bounds.y).toBeGreaterThanOrEqual(area.y + 18)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(area.x + area.width - 30)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(area.y + area.height - 18)
  expect(bounds.width / area.width).toBeGreaterThan(0.8)
  // Exactly three controls beside the card, and the sidebar is outside the overlay (PK-13).
  const overlay = await viewPage(orbit.app, 'overlay')
  await expect(overlay.getByTestId('peek-controls').locator('button')).toHaveCount(3)
  const close = await overlay.getByTestId('peek-close').boundingBox()
  const card = await overlay.getByTestId('peek-card').boundingBox()
  expect(close && card && close.x >= card.x + card.width).toBe(true)
  expect(await overlay.evaluate(() => window.innerWidth)).toBe(area.width)
})

test('[PK-03][PK-07] Shift-click opens a Peek in a Today tab; ⌘O makes it a selected Today tab, live', async () => {
  await run(orbit.app, 'tabs.create', { url: sites.url('/site/Today') })
  const page = await findPage(orbit.app, '/site/Today')
  await expect(page.locator('#title')).toBeVisible()
  await page.locator('#next').click({ modifiers: ['Shift'], noWaitAfter: true })
  const peekTab = await settledPeek()
  expect((await state(orbit.app)).tabs[peekTab]?.url).toContain('/site/Today-Next')
  // Scroll inside the Peek, then expand from the keyboard while the Peek page has focus.
  const peekPage = await findPage(orbit.app, '/site/Today-Next')
  await expect(peekPage.locator('#title')).toHaveText('Today-Next')
  await inTab(orbit.app, peekTab, 'window.scrollTo(0, 900); "ok"')
  const before = await viewInfo(orbit.app, peekTab)
  await pressInTab(orbit.app, peekTab, 'Mod+O')
  await expect.poll(async () => (await overlayOf(orbit.app)).kind).toBe('none')
  const s = await state(orbit.app)
  const win = await mainWindow(orbit.app)
  expect(win.activeTab[win.spaceId]).toBe(peekTab)
  expect(s.spaces[win.spaceId]?.today[0]).toBe(peekTab)
  expect(s.tabs[peekTab]?.floating).toBeUndefined()
  // The same live page (no reload): same web contents and scroll, now laid out like any tab.
  await expect.poll(async () => (await viewInfo(orbit.app, peekTab)).bounds).toEqual(before.area)
  const after = await viewInfo(orbit.app, peekTab)
  expect(after.contentsId).toBe(before.contentsId)
  expect(after.aboveOverlay).toBe(false)
  expect(await inTab(orbit.app, peekTab, 'String(Math.round(scrollY))')).toBe('900')
  await expect(orbit.shell.getByTestId('tab-row').first()).toContainText('Today-Next')
})
