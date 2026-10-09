/**
 * Regression tests for the PR #1 review findings owned by the tabs lane (M1, M3, M4, M6, M8).
 */
import { expect, test } from '@playwright/test'
import { type Fixtures, launchOrbit, type Orbit, startFixtures, state, tabPage, tabView } from './helpers'
import { act, activeId, center, cmd, drag, liveTabs, newTab, row, setState, space, waitTab } from './tabs-support'

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

test('[TB-01] favicons are fetched in the tab session and stored as small data URLs (review F13)', async () => {
  const { app, shell } = orbit
  const png = await app.evaluate(({ nativeImage }) =>
    nativeImage
      .createFromBitmap(Buffer.alloc(64 * 64 * 4, 200), { width: 64, height: 64 })
      .toPNG()
      .toString('base64'),
  )
  const { createServer } = await import('node:http')
  let iconHits = 0
  const server = createServer((req, res) => {
    if (req.url === '/icon.png') {
      iconHits++
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(Buffer.from(png, 'base64'))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>Iconic</title><link rel="icon" href="/icon.png"><p>hi</p>')
  })
  await new Promise<void>((r) => server.listen(3390, '127.0.0.1', () => r()))
  try {
    const t = await newTab(app, 'http://127.0.0.1:3390/page')
    await expect.poll(async () => (await state(app)).tabs[t]?.favicon ?? '').toMatch(/^data:image\/png;base64,/)
    const favicon = (await state(app)).tabs[t]?.favicon as string
    expect(favicon.length).toBeLessThan(16 * 1024 * 1.4)
    expect(iconHits).toBeGreaterThan(0)
    await expect(row(shell, t).locator('img.favicon')).toHaveAttribute('src', /^data:image\/png/)
  } finally {
    await new Promise((r) => server.close(() => r(null)))
  }
})

test('[FD-02][FD-10][TB-18] undoing New Folder puts its tabs back unpinned; undoing a folder delete restores it in place', async () => {
  const { app } = orbit
  const sp = (await space(app)).id
  const pinned = await newTab(app, fx.url('/page/P'), { container: { kind: 'pinned', spaceId: sp }, activate: false })
  const a = await newTab(app, fx.url('/page/A'), { activate: false })
  const b = await newTab(app, fx.url('/page/B'), { activate: false })
  const folderId = await cmd<string>(app, 'folders.create', { items: [b, a] })
  expect((await state(app)).folders[folderId]?.children).toEqual([b, a])
  expect((await state(app)).tabs[a]?.pinnedUrl).toBeTruthy()
  await cmd(app, 'tabs.undo')
  let s = await state(app)
  expect(s.folders[folderId]).toBeUndefined()
  expect(s.spaces[sp]?.today).toEqual([b, a])
  expect(s.spaces[sp]?.pinned).toEqual([pinned])
  expect(s.tabs[a]?.pinnedUrl).toBeUndefined()
  // Delete a folder but keep its tabs, then undo: the folder is back where it was, holding them.
  const box = await cmd<string>(app, 'folders.create', { name: 'Box', items: [pinned] })
  await cmd(app, 'folders.delete', { folderId: box, keepChildren: true })
  expect((await space(app)).pinned).toEqual([pinned])
  await cmd(app, 'tabs.undo')
  s = await state(app)
  expect(s.spaces[sp]?.pinned).toEqual([box])
  expect(s.folders[box]?.children).toEqual([pinned])
})

test('[TB-11][TB-18] undoing a move to another Space hands that Space’s selection on', async () => {
  const { app } = orbit
  const sA = (await space(app)).id
  const sB = await cmd<string>(app, 'spaces.create', { name: 'B', activate: false })
  const stay = await newTab(app, fx.url('/page/StayB'), { spaceId: sB, activate: false })
  const t = await newTab(app, fx.url('/page/T'), { activate: false })
  await cmd(app, 'tabs.moveToSpace', { ids: [t], spaceId: sB, section: 'today' })
  await cmd(app, 'spaces.switch', { spaceId: sB })
  await cmd(app, 'tabs.activate', { tabId: t })
  expect(Object.values((await state(app)).windows)[0]?.activeTab[sB]).toBe(t)
  await cmd(app, 'tabs.undo')
  const s = await state(app)
  expect(s.spaces[sA]?.today).toEqual([t])
  const win = Object.values(s.windows)[0]
  expect(win?.activeTab[sB]).toBe(stay)
})

test('[TB-08][TB-13][TB-18] undo of a multi-tab move restores each tab to its exact slot', async () => {
  const { app } = orbit
  const sp = (await space(app)).id
  const ids: string[] = []
  for (const n of [1, 2, 3, 4, 5, 6]) ids.unshift(await newTab(app, fx.url(`/page/U${n}`), { activate: false }))
  const pinned = await newTab(app, fx.url('/page/P1'), { container: { kind: 'pinned', spaceId: sp }, activate: false })
  const folderId = await cmd<string>(app, 'folders.create', {
    name: 'F',
    container: { kind: 'pinned', spaceId: sp },
    index: 1,
  })
  const picked = [ids[4], pinned, ids[1]] as string[]
  await cmd(app, 'tabs.move', { id: picked[0], ids: picked, to: { kind: 'folder', folderId }, index: 0 })
  expect((await state(app)).folders[folderId]?.children).toEqual(picked)
  await cmd(app, 'tabs.undo')
  const s = await state(app)
  expect(s.spaces[sp]?.today).toEqual(ids)
  expect(s.spaces[sp]?.pinned).toEqual([pinned, folderId])
})

test('[TB-08] dragging a split view row moves the whole split to the drop slot', async () => {
  const { app, shell } = orbit
  const ids: string[] = []
  for (const n of [1, 2, 3, 4]) ids.unshift(await newTab(app, fx.url(`/page/S${n}`), { activate: false }))
  const [a, s1, s2, c] = ids as [string, string, string, string]
  // Put the middle two into a split view (state only; the split lane owns its UI).
  await setState(
    app,
    `const sp = d.spaces[d.spaceOrder[0]]; d.splits['v-test'] = { id: 'v-test', createdAt: 0, layout: { type: 'row', sizes: [0.5, 0.5], children: [{ type: 'leaf', tabId: arg[0] }, { type: 'leaf', tabId: arg[1] }] } }; sp.today = [arg[2], 'v-test', arg[3]]`,
    [s1, s2, a, c],
  )
  const split = shell.locator('[data-slot][data-key="v-test"]')
  await expect(split).toBeVisible()
  const last = await center(row(shell, c))
  await drag(shell, split.locator('[data-testid="tab-row"]').first(), {
    x: last.x,
    y: last.box.y + last.box.height - 4,
  })
  await expect.poll(async () => (await space(app)).today).toEqual([a, c, 'v-test'])
})

test('[FD-02][TB-18] undoing New Folder made from scattered pinned tabs restores their exact order', async () => {
  const { app } = orbit
  const sp = (await space(app)).id
  const pin = (n: string) =>
    newTab(app, fx.url(`/page/${n}`), { container: { kind: 'pinned', spaceId: sp }, activate: false })
  const x = await pin('X')
  const b = await pin('B')
  const y = await pin('Y')
  const folderId = await cmd<string>(app, 'folders.create', { items: [x, y] })
  expect((await space(app)).pinned).toEqual([folderId, b])
  await cmd(app, 'tabs.undo')
  expect((await space(app)).pinned).toEqual([x, b, y])
  expect((await state(app)).folders[folderId]).toBeUndefined()
})

/** Window ids in creation order. */
function windowIds(o: Orbit): Promise<string[]> {
  return o.app.evaluate(() => (globalThis as unknown as { __orbit: { windowIds: () => string[] } }).__orbit.windowIds())
}

/** Which window each tab's live view is placed in. */
function holderOf(o: Orbit, tabId: string): Promise<string | undefined> {
  return o.app.evaluate(
    (_e, id) =>
      (
        globalThis as unknown as { __orbit: { ctx: { windows: { windowOfTab: (t: string) => string | undefined } } } }
      ).__orbit.ctx.windows.windowOfTab(id),
    tabId,
  )
}

/** Every window shows a different tab, and each tab's view sits in the window that shows it. */
async function expectDistinct(o: Orbit) {
  const ids = await windowIds(o)
  await expect
    .poll(async () => {
      const s = await state(o.app)
      const shown = ids.map((w) => {
        const win = s.windows[w]
        return win ? (win.activeTab[win.spaceId] ?? null) : null
      })
      const real = shown.filter((t): t is string => !!t)
      if (new Set(real).size !== real.length) return `duplicate: ${shown.join(',')}`
      for (const [i, t] of shown.entries()) {
        if (t && (await holderOf(o, t)) !== ids[i]) return `${t} not in ${ids[i]}`
      }
      return 'ok'
    })
    .toBe('ok')
}

async function resize(o: Orbit, windowId: string) {
  await o.app.evaluate((_e, id) => {
    const win = (
      globalThis as unknown as { __orbit: { ctx: { windows: { get: (w: string) => Electron.BrowserWindow } } } }
    ).__orbit.ctx.windows.get(id)
    const b = win.getBounds()
    win.setBounds({ ...b, width: b.width - 40 })
  }, windowId)
  await new Promise((r) => setTimeout(r, 400))
}

test('[TB-17][TB-06] two windows on one Space: closing or clearing never leaves both on the same tab (lane review MF-1)', async () => {
  const { app } = orbit
  const sp = (await space(app)).id
  const pinned = await newTab(app, fx.url('/page/Pin'), { container: { kind: 'pinned', spaceId: sp }, activate: false })
  const z = await newTab(app, fx.url('/page/Z'), { activate: false })
  const y = await newTab(app, fx.url('/page/Y'), { activate: false })
  const x = await newTab(app, fx.url('/page/X'))
  await waitTab(app, x, '/page/X')
  await act(app, 'window.new')
  await expect.poll(async () => (await windowIds(orbit)).length).toBe(2)
  const [w1, w2] = (await windowIds(orbit)) as [string, string]
  await cmd(app, 'tabs.activate', { tabId: y }, 1)
  await expectDistinct(orbit)
  // R1: Cmd+W in window 1 must not pick Y (window 2 shows it).
  await act(app, 'tab.close', 0)
  await expectDistinct(orbit)
  let s = await state(app)
  expect(s.windows[w1]?.activeTab[sp]).toBe(z)
  expect(s.windows[w2]?.activeTab[sp]).toBe(y)
  await resize(orbit, w2)
  await expectDistinct(orbit)
  await resize(orbit, w1)
  await expectDistinct(orbit)
  // R14: Clear in window 1: one window gets the pinned tab, the other nothing.
  await cmd(app, 'tabs.clearToday', { spaceId: sp }, 0)
  await expectDistinct(orbit)
  s = await state(app)
  const shown = [s.windows[w1]?.activeTab[sp] ?? null, s.windows[w2]?.activeTab[sp] ?? null]
  expect(shown.filter((t) => t === pinned)).toHaveLength(1)
})

test('[TB-17] three windows: a handoff leaves every window on a different tab (lane review MF-1)', async () => {
  const { app } = orbit
  const c = await newTab(app, fx.url('/page/C'), { activate: false })
  const b = await newTab(app, fx.url('/page/B'), { activate: false })
  const a = await newTab(app, fx.url('/page/A'))
  await waitTab(app, a, '/page/A')
  await act(app, 'window.new')
  await act(app, 'window.new')
  await expect.poll(async () => (await windowIds(orbit)).length).toBe(3)
  await cmd(app, 'tabs.activate', { tabId: b }, 1)
  await cmd(app, 'tabs.activate', { tabId: c }, 2)
  await expectDistinct(orbit)
  // R2: window 2 takes A from window 1; window 1 must not land on C (window 3 shows it).
  await cmd(app, 'tabs.activate', { tabId: a }, 1)
  await expectDistinct(orbit)
  const ids = await windowIds(orbit)
  const s = await state(app)
  const sp = s.spaceOrder[0] as string
  expect(s.windows[ids[1] as string]?.activeTab[sp]).toBe(a)
  expect(s.windows[ids[2] as string]?.activeTab[sp]).toBe(c)
  await resize(orbit, ids[0] as string)
  await expectDistinct(orbit)
})
