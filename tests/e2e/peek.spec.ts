import { expect, test } from '@playwright/test'
import { FRAME_SLACK, launchOrbit, type Orbit, run, state, viewPage } from './helpers'
import {
  blockNetwork,
  clickInTab,
  findPage,
  inTab,
  mainWindow,
  type OrbitGlobal,
  overlayOf,
  pointerTo,
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
  // The clipboard outlives the app on macOS; copy tests must not see an earlier test's text.
  await orbit.app.evaluate(({ clipboard }) => clipboard.clear())
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
  // The open spring has run to its end ('peek:opened' after this Peek's 'peek:open', in main's clock).
  // The page view follows the card frame by frame, so on a slow machine (the macOS CI VM) it also sits
  // on the card mid-flight.
  await expect
    .poll(() =>
      orbit.app.evaluate(() => {
        const marks = (globalThis as unknown as OrbitGlobal).__orbit.ctx.perf.marks
        const open = marks.filter((m) => m.name === 'peek:open').pop()
        return !!open && marks.some((m) => m.name === 'peek:opened' && m.t >= open.t)
      }),
    )
    .toBe(true)
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

test('[PK-08] Open in Split View: the source and the Peek page become two panes, one split row where the pinned tab was', async () => {
  const { tabId: source, page } = await pinned('/site/Source')
  const win = await mainWindow(orbit.app)
  // Another pinned tab after it, so "where the pinned tab was" is a real position.
  await run(orbit.app, 'tabs.create', {
    url: sites.url('/site/Below'),
    container: { kind: 'pinned', spaceId: win.spaceId },
    activate: false,
  })
  await page.locator('#other').click({ noWaitAfter: true })
  const peekTab = await settledPeek()
  expect(await inTab(orbit.app, peekTab, 'window.marker = 42')).toBe('42')
  const before = (await state(orbit.app)).spaces[win.spaceId]?.pinned ?? []
  const at = before.indexOf(source)
  expect(at).toBeGreaterThanOrEqual(0)

  await (await viewPage(orbit.app, 'overlay')).getByTestId('peek-split').click()
  await expect.poll(async () => (await overlayOf(orbit.app)).kind).toBe('none')
  await expect(orbit.shell.getByTestId('split-row')).toHaveCount(1)
  await expect(orbit.shell.getByTestId('split-pane')).toHaveCount(2)
  const s = await state(orbit.app)
  const after = s.spaces[win.spaceId]?.pinned ?? []
  expect(after).toHaveLength(before.length)
  const split = s.splits[after[at] as string]
  expect(split?.layout).toMatchObject({
    type: 'row',
    children: [
      { type: 'leaf', tabId: source },
      { type: 'leaf', tabId: peekTab },
    ],
  })
  expect(s.tabs[peekTab]?.floating).toBeUndefined()
  // Both pages show side by side, the Peek page on the right, live (not reloaded).
  await expect
    .poll(async () => {
      const [l, r] = [await viewInfo(orbit.app, source), await viewInfo(orbit.app, peekTab)]
      return l.visible && r.visible && !!l.bounds && !!r.bounds && r.bounds.x > l.bounds.x + l.bounds.width - 1
    })
    .toBe(true)
  expect(await inTab(orbit.app, peekTab, 'window.marker')).toBe('42')
  // The Peek page's pane is the focused one, and it has the keyboard. (Split.focus comes with
  // the split lane, so it is read loosely here.)
  expect((split as { focus?: string } | undefined)?.focus).toBe(peekTab)
  await expect
    .poll(() =>
      orbit.app.evaluate(
        (_e, t) => (globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs.contents(t)?.isFocused() ?? false,
        peekTab,
      ),
    )
    .toBe(true)
})

test('[PK-08][SV-25] from a full split, Open in Split View is refused with a toast and the Peek stays as it was', async () => {
  const { tabId: source, page } = await pinned('/site/Source')
  const win = await mainWindow(orbit.app)
  const more: string[] = []
  for (const name of ['Two', 'Three', 'Four']) {
    const tabId = await run(orbit.app, 'tabs.create', {
      url: sites.url(`/site/${name}`),
      container: { kind: 'pinned', spaceId: win.spaceId },
      activate: false,
    })
    more.push(tabId as string)
  }
  await run(orbit.app, 'split.create', { tabIds: [source, ...more], focus: source })
  await expect(orbit.shell.getByTestId('split-pane')).toHaveCount(4)
  await viewsOverPanes([source, ...more])
  await page.locator('#other').click({ noWaitAfter: true })
  const peekTab = await settledPeek()
  const before = await state(orbit.app)

  await (await viewPage(orbit.app, 'overlay')).getByTestId('peek-split').click()
  await expect(orbit.shell.getByTestId('toast')).toContainText('Split View holds up to 4 tabs')
  // Nothing changed: the same Peek is open, not on its way out, and the sidebar and split are as they were.
  const overlay = await overlayOf(orbit.app)
  expect(overlay.kind === 'peek' ? [overlay.tabId, overlay.phase] : []).toEqual([peekTab, undefined])
  const after = await state(orbit.app)
  expect(after.tabs[peekTab]?.floating).toBe('peek')
  expect(after.spaces[win.spaceId]?.pinned).toEqual(before.spaces[win.spaceId]?.pinned)
  expect(after.spaces[win.spaceId]?.today).toEqual(before.spaces[win.spaceId]?.today)
  expect(after.splits).toEqual(before.splits)
  expect((await viewInfo(orbit.app, peekTab)).visible).toBe(true)
  // And it still closes as usual.
  await pressInTab(orbit.app, peekTab, 'Escape')
  await expect.poll(async () => (await overlayOf(orbit.app)).kind).toBe('none')
})

test('[PK-02][PK-05] a link in one pane of a pinned split opens one Peek over the whole content area', async () => {
  const { tabId: source, page } = await pinned('/site/Source')
  const win = await mainWindow(orbit.app)
  const beside = (await run(orbit.app, 'tabs.create', {
    url: sites.url('/site/Beside'),
    container: { kind: 'pinned', spaceId: win.spaceId },
    activate: false,
  })) as string
  await run(orbit.app, 'split.addTab', { tabId: beside, target: source, side: 'right', focus: false })
  await expect(orbit.shell.getByTestId('split-pane')).toHaveCount(2)
  await viewsOverPanes([source, beside])
  const panes = async () => [await viewInfo(orbit.app, source), await viewInfo(orbit.app, beside)] as const
  const rows = sidebarCount(await state(orbit.app), win.spaceId)

  await page.locator('#other').click({ noWaitAfter: true })
  const peekTab = await settledPeek()
  const overlay = await overlayOf(orbit.app)
  expect(overlay.kind === 'peek' ? overlay.sourceTabId : undefined).toBe(source)
  // One card across both panes, centred on the content area, not squeezed into the clicked pane.
  const [l, r] = await panes()
  const card = (await viewInfo(orbit.app, peekTab)).bounds
  if (!l.bounds || !r.bounds || !card) throw new Error('no bounds')
  expect(card.x).toBeLessThan(l.bounds.x + l.bounds.width)
  expect(card.x + card.width).toBeGreaterThan(r.bounds.x)
  const middle =
    (Math.min(l.bounds.x, r.bounds.x) + Math.max(l.bounds.x + l.bounds.width, r.bounds.x + r.bounds.width)) / 2
  expect(Math.abs(card.x + card.width / 2 - middle)).toBeLessThanOrEqual(1)
  expect(sidebarCount(await state(orbit.app), win.spaceId)).toBe(rows)

  // Closed, the split is as it was: both panes show, the clicked one has the keyboard.
  await pressInTab(orbit.app, peekTab, 'Escape')
  await expect.poll(async () => (await overlayOf(orbit.app)).kind).toBe('none')
  await expect.poll(async () => (await state(orbit.app)).tabs[peekTab]).toBeUndefined()
  await expect
    .poll(async () => {
      const [a, b] = await panes()
      return a.visible && b.visible
    })
    .toBe(true)
  await expect(orbit.shell.getByTestId('split-pane')).toHaveCount(2)
  await expect
    .poll(() =>
      orbit.app.evaluate(
        (_e, t) => (globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs.contents(t)?.isFocused() ?? false,
        source,
      ),
    )
    .toBe(true)
})

/** Waits until each tab's page shows where the shell draws its split pane (the panes have settled). */
async function viewsOverPanes(tabIds: string[]) {
  for (const tabId of tabIds) {
    await expect
      .poll(async () => {
        const view = await viewInfo(orbit.app, tabId)
        const pane = await orbit.shell.locator(`[data-testid="split-pane"][data-tab-id="${tabId}"]`).boundingBox()
        if (!view.visible || !view.bounds || !pane) return false
        const b = view.bounds
        return [b.x - pane.x, b.y - pane.y, b.width - pane.width, b.height - pane.height].every((d) => Math.abs(d) <= 1)
      })
      .toBe(true)
  }
}

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

test('[PK-01][PK-09] the Peek page takes the keyboard when it opens and the source tab gets it back', async () => {
  const { source, peekTab } = await openPeekFromPinned()
  const focused = (id: string) =>
    orbit.app.evaluate(
      (_e, t) => (globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs.contents(t)?.isFocused() ?? false,
      id,
    )
  await expect.poll(() => focused(peekTab)).toBe(true)
  // Close from the overlay's × (focus is not in the page then), and the source tab has it again.
  await (await viewPage(orbit.app, 'overlay')).getByTestId('peek-close').click()
  await expectClosed(source, peekTab)
  await expect.poll(() => focused(source)).toBe(true)
})

test('[PK-09][FL-19] a closed Peek leaves no layer over the page: it takes clicks again at once', async () => {
  const { source, peekTab } = await openPeekFromPinned()
  // In main, note whether the overlay view is still up at the moment the Peek ends.
  await orbit.app.evaluate(() => {
    const g = globalThis as unknown as OrbitGlobal & { __overlayUp?: boolean[] }
    const ctx = g.__orbit.ctx
    g.__overlayUp = []
    ctx.store.subscribe((next, prev) => {
      for (const [id, w] of Object.entries(next.windows)) {
        if (w.overlay.kind !== 'none' || prev.windows[id]?.overlay.kind !== 'peek') continue
        const overlay = ctx.windows
          .get(id)
          ?.contentView.children.find((v) =>
            (v as Electron.WebContentsView).webContents?.getURL().includes('view=overlay'),
          )
        g.__overlayUp?.push(overlay?.getVisible() ?? false)
      }
    })
  })
  await pressInTab(orbit.app, peekTab, 'Escape')
  await expectClosed(source, peekTab)
  const up = await orbit.app.evaluate(() => (globalThis as unknown as { __overlayUp?: boolean[] }).__overlayUp)
  expect(up).toEqual([false])
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
  await expect.poll(async () => (await viewInfo(orbit.app, peekTab)).url).toBe(sites.other('/site/OtherBlank'))
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

/** The pinned tab went on to `url` itself: no Peek, no new tab. */
async function expectStayedInTab(tabId: string, url: string) {
  await expect.poll(async () => (await viewInfo(orbit.app, tabId)).url).toBe(url)
  expect((await overlayOf(orbit.app)).kind).toBe('none')
  const s = await state(orbit.app)
  expect(Object.values(s.tabs).filter((t) => t.floating)).toHaveLength(0)
  const win = await mainWindow(orbit.app)
  expect(s.spaces[win.spaceId]?.today).toHaveLength(0)
  expect(win.activeTab[win.spaceId]).toBe(tabId)
}

/** What the fixture sites received at these paths since request number `since`. */
const receivedAt = (since: number, ...paths: string[]) =>
  sites
    .requests()
    .slice(since)
    .filter((r) => paths.includes(r.path))
    .map((r) => `${r.method} ${r.path} ${r.body}`.trim())

test('[PK-02] a form a pinned tab posts to another site stays in the tab and arrives with its body', async () => {
  const { tabId, page } = await pinned('/forms')
  const since = sites.requests().length
  await page.locator('#send').click({ noWaitAfter: true })
  await expectStayedInTab(tabId, sites.other('/post/target'))
  expect(receivedAt(since, '/post/target')).toEqual(['POST /post/target user=alice'])
})

test('[PK-02] a script that sends a pinned tab to another site keeps it in the tab', async () => {
  const { tabId, page } = await pinned('/forms')
  await page.locator('#script').click({ noWaitAfter: true })
  await expectStayedInTab(tabId, sites.other('/site/Landing'))
})

test('[PK-02] a sign-in that posts itself on to another site stays in the pinned tab with its assertion', async () => {
  const { tabId, page } = await pinned('/forms')
  const since = sites.requests().length
  // A same-site POST whose answer auto-submits a form to the other site (SAML or OIDC form_post).
  await page.locator('#sign-in').click({ noWaitAfter: true })
  await expectStayedInTab(tabId, sites.other('/saml/acs'))
  expect(receivedAt(since, '/idp/login', '/saml/acs')).toEqual([
    'POST /idp/login user=alice',
    'POST /saml/acs SAMLResponse=assertion-for-alice',
  ])
})

test('[PK-01][PK-02] one click that starts two navigations to its link opens one Peek, and the pinned tab stays (lead review V1)', async () => {
  const { tabId } = await pinned('/forms')
  // A link whose onclick also sets location to its href, then a clickable card around a link. The
  // clicks go through the page's input: Playwright would wait on the cancelled navigations.
  for (const [link, path] of [
    ['#twice', '/site/Twice'],
    ['#card-link', '/site/Card'],
  ] as const) {
    const since = sites.requests().length
    const box = JSON.parse(
      await inTab(orbit.app, tabId, `JSON.stringify(document.querySelector('${link}').getBoundingClientRect())`),
    ) as { x: number; y: number }
    await clickInTab(orbit.app, tabId, { x: box.x + 6, y: box.y + 6 })
    const peekTab = await settledPeek()
    await expect.poll(async () => (await viewInfo(orbit.app, peekTab)).url).toBe(sites.other(path))
    expect((await viewInfo(orbit.app, tabId)).url).toBe(sites.url('/forms'))
    expect(receivedAt(since, path)).toEqual([`GET ${path}`])
    await pressInTab(orbit.app, peekTab, 'Escape')
    await expect.poll(async () => (await overlayOf(orbit.app)).kind).toBe('none')
  }
})

test('[PK-02] Enter on a focused other-site link in a pinned tab opens a Peek', async () => {
  const { tabId: source } = await pinned('/site/Keys')
  // The pointer rests on empty page; the keyboard moves the focus onto the other-site link.
  await pointerTo(orbit.app, source, { x: 400, y: 400 })
  await inTab(orbit.app, source, `document.querySelector('#same').focus()`)
  await pressInTab(orbit.app, source, 'Tab')
  await expect.poll(() => inTab(orbit.app, source, 'document.activeElement.id')).toBe('other')
  await pressInTab(orbit.app, source, 'Enter')
  const peekTab = await settledPeek()
  await expect.poll(async () => (await viewInfo(orbit.app, peekTab)).url).toBe(sites.other('/site/Other'))
  expect((await viewInfo(orbit.app, source)).url).toBe(sites.url('/site/Keys'))
  expect((await overlayOf(orbit.app)).kind === 'peek' && (await overlayOf(orbit.app))).toMatchObject({
    sourceTabId: source,
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

test('[PK-15] hovering never opens a Peek: not a link in a pinned tab, not a pinned row', async () => {
  const { tabId, page } = await pinned('/site/Hover')
  await page.locator('#other').hover()
  await orbit.shell.locator(`[data-testid="tab-row"][data-tab-id="${tabId}"]`).hover()
  // Give a would-be hover trigger time to fire, then check nothing opened.
  await page.waitForTimeout(600)
  expect((await overlayOf(orbit.app)).kind).toBe('none')
  const s = await state(orbit.app)
  expect(Object.values(s.tabs).filter((t) => t.floating)).toHaveLength(0)
  expect(s.archive).toHaveLength(0)
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

/** Clicks the "Other site" link of a tab's page through the page's own input handling. */
async function clickOtherLink(tabId: string) {
  const link = JSON.parse(
    await inTab(orbit.app, tabId, 'JSON.stringify(document.querySelector("#other").getBoundingClientRect())'),
  ) as { x: number; y: number }
  await clickInTab(orbit.app, tabId, { x: link.x + 6, y: link.y + 6 })
}

test('[PK-11] the sidebar address shows the Peek page while it is open; ⌘L makes it a tab and edits its address', async () => {
  const { source, peekTab } = await openPeekFromPinned()
  const pill = orbit.shell.getByTestId('address-pill')
  const peekHost = new URL(sites.other('/')).host
  const sourceHost = new URL(sites.url('/')).host
  await expect(pill).toContainText(peekHost)
  await pressInTab(orbit.app, peekTab, 'Escape')
  await expectClosed(source, peekTab)
  await expect(pill).toContainText(sourceHost)
  // ⌘L: the Peek becomes the selected tab at once and the command bar edits its address; the
  // pinned tab underneath never navigates.
  await clickOtherLink(source)
  const second = await settledPeek()
  await expect(pill).toContainText(peekHost)
  await pressInTab(orbit.app, second, 'Mod+L')
  await expect
    .poll(async () => {
      const o = await overlayOf(orbit.app)
      return o.kind === 'commandbar' ? `${o.mode} ${o.query}` : o.kind
    })
    .toBe(`edit-url ${sites.other('/site/Other')}`)
  const s = await state(orbit.app)
  expect(s.tabs[second]?.floating).toBeUndefined()
  const win = await mainWindow(orbit.app)
  expect(win.activeTab[win.spaceId]).toBe(second)
  expect(s.tabs[source]?.url).toBe(sites.url('/site/Source'))
  await expect(pill).toContainText(peekHost)
})

test('[PK-06] the card grows out of the clicked link and shrinks away; both under 300 ms', async () => {
  // Frame-timed: on the macOS CI VM a frame can take 100-200 ms, so fewer frames and more time (D17).
  const frameCount = (n: number) => Math.max(2, Math.floor(n / FRAME_SLACK))
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
  expect(frames.length).toBeGreaterThanOrEqual(frameCount(6))
  const first = frames[0] as { t: number; w: number; x: number }
  const last = frames[frames.length - 1] as { t: number; w: number; x: number }
  // Starts small, near the link, and grows to the card (never instant).
  expect(first.w).toBeLessThan(last.w / 3)
  expect(Math.abs(first.x + first.w / 2 - ((link?.x ?? 0) + 8))).toBeLessThan(last.w / 2)
  const settledAt = frames.findIndex((f) => Math.abs(f.w - last.w) < 1)
  expect((frames[settledAt]?.t ?? 0) - first.t).toBeLessThan(300 * FRAME_SLACK)
  // Closing animates too: the card shrinks over a few frames.
  await pressInTab(orbit.app, peekTab, 'Escape')
  await expect.poll(async () => (await overlayOf(orbit.app)).kind).toBe('none')
  const closing = await orbit.app.evaluate(() =>
    (globalThis as unknown as { __frames: { t: number; w: number; x: number }[] }).__frames.splice(0),
  )
  expect(closing.length).toBeGreaterThanOrEqual(frameCount(4))
  expect((closing[closing.length - 1]?.w ?? 0) < (closing[0]?.w ?? 0)).toBe(true)
  expect((closing[closing.length - 1]?.t ?? 0) - (closing[0]?.t ?? 0)).toBeLessThan(300 * FRAME_SLACK)
})

/** The Peek page view's bounds, rounded, or null when it is not placed. */
async function peekBounds(peekTab: string) {
  const b = (await viewInfo(orbit.app, peekTab)).bounds
  return b ? { x: b.x, y: b.y, width: b.width, height: b.height, cy: b.y + b.height / 2 } : null
}

test('[PK-06] dragging the handle moves the card with the pointer; let go early and it springs back', async () => {
  const { peekTab } = await openPeekFromPinned()
  const overlay = await viewPage(orbit.app, 'overlay')
  const rest = await peekBounds(peekTab)
  const handle = await overlay.getByTestId('peek-handle').boundingBox()
  if (!rest || !handle) throw new Error('no card or handle')
  // The handle sits centred just above the card.
  const area = (await viewInfo(orbit.app, peekTab)).area
  expect(Math.abs(area ? area.x + handle.x + handle.width / 2 - (rest.x + rest.width / 2) : 99)).toBeLessThanOrEqual(1)
  expect(area ? area.y + handle.y + handle.height : 0).toBeLessThanOrEqual(rest.y + 1)
  const x = handle.x + handle.width / 2
  const y = handle.y + handle.height / 2
  await overlay.mouse.move(x, y)
  await overlay.mouse.down()
  await overlay.mouse.move(x, y + 40, { steps: 4 })
  await overlay.mouse.move(x, y + 80, { steps: 4 })
  // The page follows the pointer 1:1 and shrinks a little (view bounds are whole pixels).
  await expect.poll(async () => Math.abs(((await peekBounds(peekTab))?.cy ?? 0) - rest.cy - 80) <= 1).toBe(true)
  const dragged = await peekBounds(peekTab)
  expect(dragged?.width).toBeLessThan(rest.width)
  expect(dragged?.width).toBeGreaterThan(rest.width * 0.95)
  // Held still, then let go well short of a quarter of the card's height: it springs back.
  await overlay.waitForTimeout(150)
  await overlay.mouse.up()
  await expect
    .poll(async () => {
      const b = await peekBounds(peekTab)
      return !!b && Math.abs(b.y - rest.y) <= 1 && Math.abs(b.width - rest.width) <= 1
    })
    .toBe(true)
  expect((await overlayOf(orbit.app)).kind).toBe('peek')
  expect((await state(orbit.app)).tabs[peekTab]?.floating).toBe('peek')
})

test('[PK-06] dragged past a quarter of its height, or flicked down, the Peek closes', async () => {
  const { source, peekTab } = await openPeekFromPinned()
  const overlay = await viewPage(orbit.app, 'overlay')
  const rest = await peekBounds(peekTab)
  const handle = await overlay.getByTestId('peek-handle').boundingBox()
  if (!rest || !handle) throw new Error('no card or handle')
  const x = handle.x + handle.width / 2
  const y = handle.y + handle.height / 2
  const far = Math.round(rest.height * 0.32)
  await overlay.mouse.move(x, y)
  await overlay.mouse.down()
  await overlay.mouse.move(x, y + far, { steps: 8 })
  await expect.poll(async () => Math.abs(((await peekBounds(peekTab))?.cy ?? 0) - rest.cy - far) <= 1).toBe(true)
  await overlay.waitForTimeout(150)
  await overlay.mouse.up()
  await expectClosed(source, peekTab)
  // A quick flick closes it even though it moved only a little.
  await clickOtherLink(source)
  const second = await settledPeek()
  await overlay.getByTestId('peek-handle').evaluate((el) => {
    const r = el.getBoundingClientRect()
    const at = (type: string, dy: number) =>
      el.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          clientX: r.x + r.width / 2,
          clientY: r.y + r.height / 2 + dy,
        }),
      )
    at('pointerdown', 0)
    at('pointermove', 15)
    at('pointermove', 30)
    at('pointerup', 30)
  })
  await expectClosed(source, second)
})

test('[PK-06] a two-finger swipe down beside the card follows the fingers; a long one dismisses', async () => {
  const { source, peekTab } = await openPeekFromPinned()
  const overlay = await viewPage(orbit.app, 'overlay')
  const rest = await peekBounds(peekTab)
  const area = (await viewInfo(orbit.app, peekTab)).area
  if (!rest || !area) throw new Error('no card')
  // Record the card's centre on every frame (overlay coordinates).
  await orbit.app.evaluate(() => {
    const g = globalThis as unknown as OrbitGlobal & { __swipe: number[] }
    g.__swipe = []
    g.__orbit.ctx.events.on('peek.frame', ({ rect }) => g.__swipe.push(rect.y + rect.height / 2))
  })
  // Over the dimmed page, left of the card.
  await overlay.mouse.move(8, Math.round(area.height / 2))
  // Fingers moving down scroll content up (a negative delta): the card goes down with them.
  await overlay.mouse.wheel(0, -60)
  // A short swipe springs back once the fingers stop.
  await expect
    .poll(async () => {
      const b = await peekBounds(peekTab)
      const frames = await orbit.app.evaluate(() => (globalThis as unknown as { __swipe: number[] }).__swipe.length)
      return frames > 2 && !!b && Math.abs(b.y - rest.y) <= 1 && Math.abs(b.width - rest.width) <= 1
    })
    .toBe(true)
  const centres = await orbit.app.evaluate(() => (globalThis as unknown as { __swipe: number[] }).__swipe.splice(0))
  // It followed the 60 px swipe, then came back to rest (its last frame); frames are whole pixels.
  expect(Math.abs(Math.max(...centres) - (centres[centres.length - 1] ?? 0) - 60)).toBeLessThanOrEqual(1)
  expect((await overlayOf(orbit.app)).kind).toBe('peek')
  // A long swipe dismisses it.
  await overlay.mouse.wheel(0, -Math.round(rest.height * 0.4))
  await expectClosed(source, peekTab)
})
