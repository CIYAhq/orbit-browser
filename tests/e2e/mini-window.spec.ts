import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { launchOrbit, type Orbit, state } from './helpers'
import {
  blockNetwork,
  findPage,
  type OrbitGlobal,
  pressInTab,
  type Sites,
  sidebarCount,
  startSites,
} from './peek-helpers'

/** Mini Windows (spec/mini-window.md). */

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

/** Another app asks Orbit to open a URL (macOS open-url; the other platforms share the route). */
async function openFromOtherApp(app: ElectronApplication, url: string): Promise<void> {
  await app.evaluate(({ app: electronApp }, u) => electronApp.emit('open-url', { preventDefault() {} }, u), url)
}

interface MiniInfo {
  id: string
  visible: boolean
  focused: boolean
  bounds: { x: number; y: number; width: number; height: number }
  tabId: string | null
  url: string | null
  /** The page view's bounds inside the window, and whether it is placed there. */
  page: { x: number; y: number; width: number; height: number } | null
}

/** The open Mini Windows (WindowState kind 'mini' with a live OS window). */
async function minis(app: ElectronApplication): Promise<MiniInfo[]> {
  return app.evaluate(({ BrowserWindow }) => {
    const ctx = (globalThis as unknown as OrbitGlobal).__orbit.ctx
    const s = ctx.store.state
    return Object.values(s.windows)
      .filter((w) => w.kind === 'mini')
      .map((w) => {
        const win = BrowserWindow.getAllWindows().find(
          (b) =>
            !b.isDestroyed() &&
            ctx.windows.isUi(b.webContents) &&
            ctx.windows.windowIdFor(b.webContents) === w.id,
        )
        const tabId = w.activeTab[w.spaceId] ?? null
        const view = tabId ? ctx.tabs.get(tabId) : undefined
        const placed = !!view && !!win && win.contentView.children.includes(view)
        return {
          id: w.id,
          visible: !!win?.isVisible(),
          focused: !!win?.isFocused(),
          bounds: win?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 },
          tabId,
          url: view && !view.webContents.isDestroyed() ? view.webContents.getURL() : null,
          page: placed && view ? view.getBounds() : null,
        }
      })
  })
}

/** The Playwright page of a Mini Window's own UI. */
async function miniUi(app: ElectronApplication, windowId: string): Promise<Page> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    for (const p of app.windows()) {
      if (!p.url().includes('view=mini')) continue
      const id = await p
        .evaluate(() => (window as unknown as { orbit: { windowId: string } }).orbit.windowId)
        .catch(() => '')
      if (id === windowId) return p
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`No Mini Window UI for ${windowId}`)
}

test('[MW-01][MW-02][MW-03][NV-18] a link from another app opens a Mini Window holding only that page', async () => {
  const before = await state(orbit.app)
  const main = Object.values(before.windows).find((w) => w.kind === 'main')
  if (!main) throw new Error('no main window')
  const rows = sidebarCount(before, main.spaceId)
  const url = sites.url('/site/FromChat')
  await openFromOtherApp(orbit.app, url)
  await expect.poll(async () => (await minis(orbit.app)).length).toBe(1)
  await expect.poll(async () => (await minis(orbit.app))[0]?.url).toBe(url)
  const [mini] = await minis(orbit.app)
  if (!mini) throw new Error('no mini')
  await expect.poll(async () => (await minis(orbit.app))[0]?.visible).toBe(true)
  // A small window: noticeably smaller than the main window, the page inset in its card.
  const mainBounds = await orbit.app.evaluate((_e, id) => {
    return (globalThis as unknown as OrbitGlobal).__orbit.ctx.windows.get(id)?.getBounds()
  }, main.id)
  expect(mini.bounds.width).toBeLessThan(mainBounds?.width ?? 0)
  await expect.poll(async () => (await minis(orbit.app))[0]?.page?.y).toBeGreaterThanOrEqual(36)
  const placed = (await minis(orbit.app))[0]?.page
  expect(placed?.x).toBeGreaterThan(0)
  expect((placed?.width ?? 0) + (placed?.x ?? 0) * 2).toBe(mini.bounds.width)
  // The main window is undisturbed: same selected tab, no new sidebar row.
  const after = await state(orbit.app)
  expect(sidebarCount(after, main.spaceId)).toBe(rows)
  expect(after.windows[main.id]?.activeTab).toEqual(main.activeTab)
  expect(after.tabs[mini.tabId ?? '']?.floating).toBe('mini')
  // A slim top bar: the host and "Open in…", no sidebar.
  const ui = await miniUi(orbit.app, mini.id)
  await expect(ui.getByTestId('mini-address')).toContainText('localhost')
  await expect(ui.getByTestId('mini-open-in')).toBeVisible()
  await expect(ui.getByTestId('sidebar')).toHaveCount(0)
})

test('[MW-02][MW-08] the same link again brings its Mini Window back; other links get their own', async () => {
  const url = sites.url('/site/Twice')
  await openFromOtherApp(orbit.app, url)
  await expect.poll(async () => (await minis(orbit.app))[0]?.url).toBe(url)
  await openFromOtherApp(orbit.app, url)
  await new Promise((r) => setTimeout(r, 400))
  expect(await minis(orbit.app)).toHaveLength(1)
  await openFromOtherApp(orbit.app, sites.url('/site/Second'))
  await openFromOtherApp(orbit.app, sites.url('/site/Third'))
  await expect.poll(async () => (await minis(orbit.app)).length).toBe(3)
  // New windows cascade instead of stacking exactly.
  const all = await minis(orbit.app)
  const positions = new Set(all.map((m) => `${m.bounds.x},${m.bounds.y}`))
  expect(positions.size, JSON.stringify(all.map((m) => m.bounds))).toBe(3)
})

test('[MW-05] ⌘O moves the live page into the most recent Space and closes the Mini Window', async () => {
  const url = sites.url('/site/Triage')
  await openFromOtherApp(orbit.app, url)
  await expect.poll(async () => (await minis(orbit.app))[0]?.url).toBe(url)
  const [mini] = await minis(orbit.app)
  if (!mini?.tabId) throw new Error('no mini')
  const page = await findPage(orbit.app, '/site/Triage')
  await expect(page.locator('#title')).toHaveText('Triage')
  await page.evaluate(() => window.scrollTo(0, 700))
  const contentsId = await orbit.app.evaluate(
    (_e, id) => (globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs.contents(id)?.id,
    mini.tabId,
  )
  await pressInTab(orbit.app, mini.tabId, 'Mod+O')
  await expect.poll(async () => (await minis(orbit.app)).length).toBe(0)
  const s = await state(orbit.app)
  const main = Object.values(s.windows).find((w) => w.kind === 'main')
  if (!main) throw new Error('no main window')
  expect(main.activeTab[main.spaceId]).toBe(mini.tabId)
  expect(s.spaces[main.spaceId]?.today[0]).toBe(mini.tabId)
  expect(s.tabs[mini.tabId]?.floating).toBeUndefined()
  // Not reloaded: the same web contents, still scrolled, now shown in the main window.
  const moved = await orbit.app.evaluate((_e, id) => {
    const ctx = (globalThis as unknown as OrbitGlobal).__orbit.ctx
    const contents = ctx.tabs.contents(id)
    return { id: contents?.id, window: ctx.windows.windowOfTab(id) }
  }, mini.tabId)
  expect(moved.id).toBe(contentsId)
  expect(moved.window).toBe(main.id)
  expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(700)
  await expect(orbit.shell.getByTestId('tab-row').first()).toContainText('Triage')
  // Moved, not closed: nothing went to the Archive.
  expect(s.archive.filter((a) => a.from === 'mini')).toHaveLength(0)
})

test('[MW-06][MW-15] ⌘⌥N opens a blank Mini Window whose lookup bar takes keys at once', async () => {
  // Let the window be warm, as it is a moment after launch.
  await new Promise((r) => setTimeout(r, 2000))
  await orbit.shell.keyboard.press(isMacKeys('Meta+Alt+N', 'Control+Alt+N'))
  await expect.poll(async () => (await minis(orbit.app)).length).toBe(1)
  const [mini] = await minis(orbit.app)
  if (!mini) throw new Error('no mini')
  const ui = await miniUi(orbit.app, mini.id)
  const input = ui.getByTestId('mini-lookup')
  await expect(input).toBeFocused()
  const typed = sites.url('/site/Looked-up')
  await ui.keyboard.type(typed)
  await expect(input).toHaveValue(typed)
  await ui.keyboard.press('Enter')
  await expect.poll(async () => (await minis(orbit.app))[0]?.url).toBe(typed)
  await expect(ui.getByTestId('mini-address')).toContainText('localhost')
})

test('[MW-06][MW-09] closing a Mini Window archives its page as a Mini Window page', async () => {
  const url = sites.url('/site/Closer')
  await openFromOtherApp(orbit.app, url)
  await expect.poll(async () => (await minis(orbit.app))[0]?.url).toBe(url)
  const page = await findPage(orbit.app, '/site/Closer')
  await expect(page.locator('#title')).toHaveText('Closer')
  const [mini] = await minis(orbit.app)
  await pressInTab(orbit.app, mini?.tabId ?? '', 'Mod+W')
  await expect.poll(async () => (await minis(orbit.app)).length).toBe(0)
  const s = await state(orbit.app)
  const archived = s.archive.find((a) => a.url === url)
  expect(archived?.from).toBe('mini')
  expect(archived?.reason).toBe('closed')
  // No sidebar tab and no floating tab are left behind.
  expect(Object.values(s.tabs).filter((t) => t.url === url)).toHaveLength(0)
})

test('[MW-09] a Mini Window left alone closes itself after the set time and is archived', async () => {
  await orbit.app.evaluate(() => {
    ;(globalThis as unknown as OrbitGlobal).__orbit.ctx.store.update((d) => {
      d.settings.miniWindowArchiveAfterMs = 1200
    })
  })
  const url = sites.url('/site/Idle')
  await openFromOtherApp(orbit.app, url)
  await expect.poll(async () => (await minis(orbit.app))[0]?.url).toBe(url)
  await expect.poll(async () => (await minis(orbit.app))[0]?.visible).toBe(true)
  await new Promise((r) => setTimeout(r, 300))
  // The user goes back to the main window.
  await orbit.app.evaluate(({ BrowserWindow }) => {
    const ctx = (globalThis as unknown as OrbitGlobal).__orbit.ctx
    for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('view=mini')) w.emit('blur')
    ctx.windows.get(ctx.windows.ids()[0] as string)?.focus()
  })
  await expect.poll(async () => (await minis(orbit.app)).length, { timeout: 8000 }).toBe(0)
  const archived = (await state(orbit.app)).archive.find((a) => a.url === url)
  expect(archived).toMatchObject({ from: 'mini', reason: 'auto' })
})

test('[MW-11] with Mini Windows off, a link from another app opens as a Today tab', async () => {
  await orbit.app.evaluate(() => {
    ;(globalThis as unknown as OrbitGlobal).__orbit.ctx.store.update((d) => {
      d.settings.miniWindowForExternalLinks = false
    })
  })
  const url = sites.url('/site/AsTab')
  await openFromOtherApp(orbit.app, url)
  await expect
    .poll(async () => {
      const s = await state(orbit.app)
      const main = Object.values(s.windows).find((w) => w.kind === 'main')
      return main ? s.tabs[main.activeTab[main.spaceId] ?? '']?.url : undefined
    })
    .toBe(url)
  expect(await minis(orbit.app)).toHaveLength(0)
})

function isMacKeys(mac: string, other: string): string {
  return process.platform === 'darwin' ? mac : other
}
