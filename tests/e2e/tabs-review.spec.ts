/**
 * Regression tests for the PR #1 review findings owned by the tabs lane (M1, M3, M4, M6, M8).
 */
import { expect, test } from '@playwright/test'
import { type Fixtures, launchOrbit, type Orbit, startFixtures, state, tabPage, tabView } from './helpers'
import { act, activeId, cmd, liveTabs, newTab, row, space, waitTab } from './tabs-support'

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

/** Web contents (pages) currently showing a URL, across the whole app. */
function pagesWith(orbit: Orbit, part: string) {
  return orbit.app.windows().filter((p) => p.url().includes(part) && !p.url().includes('view='))
}

/** Tab views drawn in a window, bottom to top, as tab ids. */
function viewOrder(orbit: Orbit, w = 0): Promise<string[]> {
  return orbit.app.evaluate((_e, wi) => {
    type Ctx = {
      windows: { get: (id: string) => Electron.BrowserWindow | undefined; ids: () => string[] }
      tabs: { tabIdFor: (c: Electron.WebContents) => string | undefined }
    }
    const ctx = (globalThis as unknown as { __orbit: { ctx: Ctx } }).__orbit.ctx
    const win = ctx.windows.get(ctx.windows.ids()[wi] as string)
    if (!win) return []
    return win.contentView.children
      .map((v) => ('webContents' in v ? ctx.tabs.tabIdFor((v as Electron.WebContentsView).webContents) : undefined))
      .filter((id): id is string => !!id)
  }, w)
}

test('[NV-09][TB-03] a target=_blank link opens one tab with one live, attached, top-most view (review M1)', async () => {
  const { app, shell } = orbit
  const opener = await newTab(app, fx.url('/page/Opener'))
  await waitTab(app, opener, '/page/Opener')
  const page = await tabPage(app, '/page/Opener')
  await page.click('#external')
  await expect.poll(async () => (await space(app)).today.length).toBe(2)
  const created = (await space(app)).today[0] as string
  await waitTab(app, created, '/page/External')
  expect(await activeId(app)).toBe(created)
  expect((await state(app)).tabs[created]?.openerTabId).toBe(opener)
  // Exactly one web contents loaded the URL, and it is the tab's attached, visible view.
  await page.waitForTimeout(300)
  expect(pagesWith(orbit, '/page/External')).toHaveLength(1)
  expect((await tabView(app, created))?.visible).toBe(true)
  const order = await viewOrder(orbit)
  expect(order[order.length - 1]).toBe(created)
  // Back to the opener: it is drawn on top again; the new tab's view is hidden, not left covering it.
  await row(shell, opener).click()
  await expect.poll(async () => (await tabView(app, opener))?.visible).toBe(true)
  await expect.poll(async () => (await tabView(app, created))?.visible).toBe(false)
})

test('[TB-06] a page that closes itself closes its tab and leaves no blank frame (review M3)', async () => {
  const { app, shell } = orbit
  const keep = await newTab(app, fx.url('/page/Keep'))
  await waitTab(app, keep, '/page/Keep')
  const page = await tabPage(app, '/page/Keep')
  await page.click('#external')
  await expect.poll(async () => (await space(app)).today.length).toBe(2)
  const popup = (await space(app)).today[0] as string
  await waitTab(app, popup, '/page/External')
  const ext = await tabPage(app, '/page/External')
  await ext.evaluate(() => window.close())
  await expect.poll(async () => (await state(app)).tabs[popup]).toBeUndefined()
  expect(await liveTabs(app)).not.toContain(popup)
  const s = await state(app)
  expect(s.archive[s.archive.length - 1]?.url).toContain('/page/External')
  // Another tab is selected and actually drawn.
  expect(await activeId(app)).toBe(keep)
  await expect.poll(async () => (await tabView(app, keep))?.visible).toBe(true)
  await expect(row(shell, popup)).toHaveCount(0)
})

test('[TB-17] selecting in a second window the tab another window shows hands it over (review M4)', async () => {
  const { app } = orbit
  const other = await newTab(app, fx.url('/page/Other'), { activate: false })
  const t = await newTab(app, fx.url('/page/Shared'))
  await waitTab(app, t, '/page/Shared')
  await act(app, 'window.new')
  await expect.poll(async () => Object.keys((await state(app)).windows).length).toBe(2)
  const ids = await app.evaluate(() =>
    (globalThis as unknown as { __orbit: { windowIds: () => string[] } }).__orbit.windowIds(),
  )
  await cmd(app, 'tabs.activate', { tabId: t }, 1)
  const s = await state(app)
  const sp = s.spaceOrder[0] as string
  expect(s.windows[ids[1] as string]?.activeTab[sp]).toBe(t)
  // The first window now shows another tab instead of a blank frame.
  expect(s.windows[ids[0] as string]?.activeTab[sp]).toBe(other)
  const holder = () =>
    app.evaluate(
      (_e, id) =>
        (
          globalThis as unknown as { __orbit: { ctx: { windows: { windowOfTab: (t: string) => string } } } }
        ).__orbit.ctx.windows.windowOfTab(id),
      t,
    )
  await expect.poll(holder).toBe(ids[1])
  await expect.poll(async () => (await tabView(app, other))?.visible).toBe(true)
})

test('[NV-09] pages cannot open tabs or pop-ups without a user gesture, and only one per click (review M6)', async () => {
  const { app, shell } = orbit
  const t = await newTab(app, fx.url('/page/Spammy'))
  await waitTab(app, t, '/page/Spammy')
  const page = await tabPage(app, '/page/Spammy')
  const url = fx.url('/page/Spam')
  // Script-only opens (no click) are blocked, tabs and sized pop-ups alike.
  await page.evaluate((u) => {
    setTimeout(() => {
      for (let i = 0; i < 5; i++) window.open(u)
      window.open(u, '', 'width=300,height=300')
    }, 50)
  }, url)
  await expect(shell.getByTestId('toast').first()).toContainText('Pop-up blocked')
  await page.waitForTimeout(300)
  expect((await space(app)).today).toEqual([t])
  expect(app.windows().filter((p) => p.url().includes('/page/Spam') && !p.url().includes('Spammy'))).toHaveLength(0)
  // One click may open one tab, not two.
  await page.evaluate((u) => {
    const b = document.createElement('button')
    b.id = 'two'
    b.textContent = 'open two'
    b.onclick = () => {
      window.open(u)
      window.open(u)
    }
    document.body.prepend(b)
  }, url)
  await page.click('#two')
  await expect.poll(async () => (await space(app)).today.length).toBe(2)
  await page.waitForTimeout(300)
  expect((await space(app)).today).toHaveLength(2)
})

test('[TB-11][PN-02] pinning the selected tab into another Space selects the next tab here (review M8)', async () => {
  const { app, shell } = orbit
  const sA = (await space(app)).id
  const sB = await cmd<string>(app, 'spaces.create', { name: 'B', activate: false })
  const next = await newTab(app, fx.url('/page/Next'), { activate: false })
  const t = await newTab(app, fx.url('/page/Leaving'))
  await waitTab(app, t, '/page/Leaving')
  await cmd(app, 'tabs.pin', { tabId: t, spaceId: sB })
  await expect.poll(async () => (await state(app)).spaces[sB]?.pinned).toEqual([t])
  const s = await state(app)
  const win = Object.values(s.windows)[0]
  expect(win?.spaceId).toBe(sA)
  expect(win?.activeTab[sA]).toBe(next)
  await expect.poll(async () => (await tabView(app, t))?.visible ?? false).toBe(false)
  await expect.poll(async () => (await tabView(app, next))?.visible).toBe(true)
  await expect(row(shell, t)).toHaveCount(0)
})
