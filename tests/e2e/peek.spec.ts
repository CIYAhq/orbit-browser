import { expect, test } from '@playwright/test'
import { launchOrbit, type Orbit, run, state, viewPage } from './helpers'
import {
  blockNetwork,
  findPage,
  inTab,
  mainWindow,
  type OrbitGlobal,
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

/** Opens a pinned tab and a Peek from its other-site link; returns both tab ids. */
async function openPeekFromPinned(path = '/site/Source') {
  const { tabId: source, page } = await pinned(path)
  await page.locator('#other').click({ noWaitAfter: true })
  const peekTab = await settledPeek()
  return { source, peekTab, page }
}

/** The Peek is gone: no overlay, no floating tab, and the source tab is still selected. */
async function expectClosed(source: string, peekTab: string) {
  await expect.poll(async () => (await overlayOf(orbit.app)).kind).toBe('none')
  await expect.poll(async () => (await state(orbit.app)).tabs[peekTab]).toBeUndefined()
  const win = await mainWindow(orbit.app)
  expect(win.activeTab[win.spaceId]).toBe(source)
  expect((await viewInfo(orbit.app, peekTab)).inWindow).toBe(false)
  expect((await viewInfo(orbit.app, source)).visible).toBe(true)
}

test('[PK-09] Esc in the Peek page closes it and keeps the source tab as it was', async () => {
  const { source, peekTab, page } = await openPeekFromPinned()
  await page.evaluate(() => window.scrollTo(0, 400))
  await pressInTab(orbit.app, peekTab, 'Escape')
  await expectClosed(source, peekTab)
  expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(400)
  // Closed like a Today tab: it is in the Archive (PK-09).
  const archived = (await state(orbit.app)).archive.at(-1)
  expect(archived).toMatchObject({ url: sites.other('/site/Other'), from: 'peek' })
})

test('[PK-09] ⌘W closes the Peek only, never the source tab', async () => {
  const { source, peekTab } = await openPeekFromPinned()
  await pressInTab(orbit.app, peekTab, 'Mod+W')
  await expectClosed(source, peekTab)
  expect((await state(orbit.app)).tabs[source]).toBeTruthy()
})

test('[PK-05][PK-09] the × button and a click outside the card close the Peek', async () => {
  const { source, peekTab, page } = await openPeekFromPinned()
  const overlay = await viewPage(orbit.app, 'overlay')
  await overlay.getByTestId('peek-close').click()
  await expectClosed(source, peekTab)
  // (Playwright waits forever on a page whose link navigation Orbit cancelled; open by command.)
  await run(orbit.app, 'peek.open', { url: sites.other('/site/Second') })
  const second = await settledPeek()
  expect(page.url()).toContain('/site/Source')
  // A click on the dimmed page around the card.
  await overlay.mouse.click(8, 8)
  await expectClosed(source, second)
})

test('[PK-10] ⌘Z right after closing, or ⌘⇧T, reopens the Peek at the same page', async () => {
  const { source, peekTab } = await openPeekFromPinned()
  // Navigate inside the Peek first: the reopened Peek comes back on that page, with its history.
  const peekPage = await findPage(orbit.app, '/site/Other')
  await peekPage.locator('#next').click()
  await expect.poll(async () => (await state(orbit.app)).tabs[peekTab]?.url).toContain('/site/Other-Next')
  await pressInTab(orbit.app, peekTab, 'Escape')
  await expectClosed(source, peekTab)
  await pressInTab(orbit.app, source, 'Mod+Z')
  const reopened = await settledPeek()
  expect(reopened).not.toBe(peekTab)
  await expect.poll(async () => (await viewInfo(orbit.app, reopened)).url).toContain('/site/Other-Next')
  expect(await inTab(orbit.app, reopened, 'String(history.length)')).toBe('2')
  // The Archive entry made by the close is gone again.
  expect((await state(orbit.app)).archive.filter((a) => a.from === 'peek')).toHaveLength(0)
  // ⌘⇧T works the same way.
  await pressInTab(orbit.app, reopened, 'Escape')
  await expectClosed(source, reopened)
  await pressInTab(orbit.app, source, 'Shift+Mod+T')
  const again = await settledPeek()
  await expect.poll(async () => (await viewInfo(orbit.app, again)).url).toContain('/site/Other-Next')
})

test('[PK-13] selecting another tab in the sidebar dismisses the Peek, which stays reopenable', async () => {
  const today = (await run(orbit.app, 'tabs.create', { url: sites.url('/site/Elsewhere') })) as string
  const { source, peekTab } = await openPeekFromPinned()
  const win = await mainWindow(orbit.app)
  const rows = sidebarCount(await state(orbit.app), win.spaceId)
  // The sidebar is not under the overlay: a real click on a row reaches it.
  await orbit.shell.getByTestId('tab-row').filter({ hasText: 'Elsewhere' }).click()
  await expect.poll(async () => (await overlayOf(orbit.app)).kind).toBe('none')
  const after = await mainWindow(orbit.app)
  expect(after.activeTab[after.spaceId]).toBe(today)
  expect(sidebarCount(await state(orbit.app), win.spaceId)).toBe(rows)
  expect((await state(orbit.app)).tabs[peekTab]).toBeUndefined()
  // ⌘⇧T brings it back over its source tab.
  await pressInTab(orbit.app, today, 'Shift+Mod+T')
  const reopened = await settledPeek()
  const back = await mainWindow(orbit.app)
  expect(back.activeTab[back.spaceId]).toBe(source)
  expect((await state(orbit.app)).tabs[reopened]?.url).toBe(sites.other('/site/Other'))
})

test('[PK-02] same-site links navigate the pinned tab; target=_blank to another site opens a Peek', async () => {
  const { tabId: source, page } = await pinned('/site/App')
  await page.locator('#same').click()
  await expect.poll(async () => (await state(orbit.app)).tabs[source]?.url).toBe(sites.url('/site/App-Same'))
  expect((await overlayOf(orbit.app)).kind).toBe('none')
  await expect(page.locator('#title')).toHaveText('App-Same')
  await page.locator('#other-blank').click({ noWaitAfter: true })
  const peekTab = await settledPeek()
  expect((await viewInfo(orbit.app, peekTab)).url).toBe(sites.other('/site/OtherBlank'))
  // Favorites behave the same.
  await pressInTab(orbit.app, peekTab, 'Escape')
  const fav = await pinned('/site/Fav', 'favorites')
  await run(orbit.app, 'tabs.activate', { tabId: fav.tabId })
  await fav.page.locator('#other').click({ noWaitAfter: true })
  const favPeek = await settledPeek()
  expect((await overlayOf(orbit.app)).kind === 'peek' && (await overlayOf(orbit.app))).toMatchObject({
    sourceTabId: fav.tabId,
    tabId: favPeek,
  })
})

test('[PK-04] a meeting link in a pinned tab opens a new tab, not a Peek', async () => {
  const { tabId: source, page } = await pinned('/site/Calendar')
  const win = await mainWindow(orbit.app)
  await page.locator('#meeting').click({ noWaitAfter: true })
  await expect
    .poll(async () => {
      const s = await state(orbit.app)
      const w = s.windows[win.id]
      return w ? s.tabs[w.activeTab[w.spaceId] ?? '']?.url : undefined
    })
    .toBe('https://meet.google.com/abc-defg-hij')
  expect((await overlayOf(orbit.app)).kind).toBe('none')
  const s = await state(orbit.app)
  expect(s.tabs[source]?.url).toBe(sites.url('/site/Calendar'))
  expect(s.spaces[win.spaceId]?.today).toHaveLength(1)
})

test('[PK-12] with "Open links from pinned tabs in Peek" off, the link opens as a Today tab', async () => {
  await orbit.app.evaluate(() => {
    ;(globalThis as unknown as OrbitGlobal).__orbit.ctx.store.update((d) => {
      d.settings.peekExternalLinks = false
      d.settings.peekShiftClick = false
    })
  })
  const { tabId: source, page } = await pinned('/site/NoPeek')
  const win = await mainWindow(orbit.app)
  await page.locator('#other').click({ noWaitAfter: true })
  await expect.poll(async () => (await state(orbit.app)).spaces[win.spaceId]?.today.length).toBe(1)
  const s = await state(orbit.app)
  const opened = s.spaces[win.spaceId]?.today[0] as string
  expect(s.tabs[opened]?.url).toBe(sites.other('/site/Other'))
  expect(s.tabs[source]?.url).toBe(sites.url('/site/NoPeek'))
  expect((await overlayOf(orbit.app)).kind).toBe('none')
})

test('[PK-11] inside a Peek, links navigate the Peek and page commands act on it', async () => {
  const { source, peekTab } = await openPeekFromPinned()
  const peekPage = await findPage(orbit.app, '/site/Other')
  await peekPage.locator('#next').click()
  await expect.poll(async () => (await viewInfo(orbit.app, peekTab)).url).toBe(sites.other('/site/Other-Next'))
  // A target=_blank link inside the Peek stays in the Peek instead of stacking a card (PK-01).
  await peekPage.locator('#blank-same').click({ noWaitAfter: true })
  await expect.poll(async () => (await viewInfo(orbit.app, peekTab)).url).toBe(sites.other('/site/Other-Next-Blank'))
  expect((await overlayOf(orbit.app)).kind === 'peek').toBe(true)
  // Back acts on the Peek's history, not the source tab's.
  await pressInTab(orbit.app, peekTab, process.platform === 'darwin' ? 'Mod+[' : 'Alt+Left')
  await expect.poll(async () => (await viewInfo(orbit.app, peekTab)).url).toBe(sites.other('/site/Other-Next'))
  expect(await inTab(orbit.app, source, 'location.pathname')).toBe('/site/Source')
  // Copy URL and Copy URL as Markdown copy the Peek page, not the source tab.
  const clipboardText = () => orbit.app.evaluate(({ clipboard }) => clipboard.readText())
  await pressInTab(orbit.app, peekTab, 'Shift+Mod+C')
  await expect.poll(clipboardText).toBe(sites.other('/site/Other-Next'))
  await pressInTab(orbit.app, peekTab, 'Shift+Mod+Alt+C')
  await expect.poll(clipboardText).toBe(`[Other-Next](${sites.other('/site/Other-Next')})`)
  expect((await state(orbit.app)).tabs[source]?.url).toBe(sites.url('/site/Source'))
})

test('[PK-06] the card grows out of the clicked link and shrinks away; both under 300 ms', async () => {
  const { page } = await pinned('/site/Motion')
  // Record the page view's bounds on every change while it opens and closes.
  await orbit.app.evaluate(() => {
    const g = globalThis as unknown as OrbitGlobal & { __frames: { t: number; w: number; x: number }[] }
    g.__frames = []
    const ctx = g.__orbit.ctx
    ctx.events.on('peek.frame', ({ rect }) => g.__frames.push({ t: Date.now(), w: rect.width, x: rect.x }))
  })
  const link = await page.locator('#other').boundingBox()
  await page.locator('#other').click({ noWaitAfter: true })
  const peekTab = await settledPeek()
  const frames = await orbit.app.evaluate(() =>
    (globalThis as unknown as { __frames: { t: number; w: number; x: number }[] }).__frames.splice(0),
  )
  expect(frames.length).toBeGreaterThan(5)
  const first = frames[0] as { t: number; w: number; x: number }
  const last = frames[frames.length - 1] as { t: number; w: number; x: number }
  // Starts small, near the link, and grows to the card (never instant).
  expect(first.w).toBeLessThan(last.w / 3)
  expect(Math.abs(first.x + first.w / 2 - ((link?.x ?? 0) + 8))).toBeLessThan(last.w / 2)
  const settledAt = frames.findIndex((f) => Math.abs(f.w - last.w) < 1)
  expect((frames[settledAt]?.t ?? 0) - first.t).toBeLessThan(300)
  // Closing animates too: the card shrinks over a few frames.
  await pressInTab(orbit.app, peekTab, 'Escape')
  await expect.poll(async () => (await overlayOf(orbit.app)).kind).toBe('none')
  const closing = await orbit.app.evaluate(() =>
    (globalThis as unknown as { __frames: { t: number; w: number; x: number }[] }).__frames.splice(0),
  )
  expect(closing.length).toBeGreaterThan(3)
  expect((closing[closing.length - 1]?.w ?? 0) < (closing[0]?.w ?? 0)).toBe(true)
  expect((closing[closing.length - 1]?.t ?? 0) - (closing[0]?.t ?? 0)).toBeLessThan(300)
})
