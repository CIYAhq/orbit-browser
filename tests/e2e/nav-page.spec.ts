import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { launchOrbit, type Orbit, state } from './helpers'
import { cmd, type NavFixtures, openTab, pressInPage, startNavFixtures, waitLoaded, windowState } from './nav-support'

/**
 * A page's life in its card: the inactive window's sidebar (SB-21), the loading indicator (SB-28)
 * and the address while a page is on its way (NV-04).
 */

let fx: NavFixtures
let orbit: Orbit

test.beforeAll(async () => {
  fx = await startNavFixtures()
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

const page = (title: string) => fx.url(`/page/${title}`)

interface LoadingInfo {
  tabId: string | null
  visible: boolean
  state: 'loading' | 'done' | null
  bounds?: { x: number; y: number; width: number; height: number }
  shown: number
  pending: boolean
}

type NavHooks = { __orbitNav: { loading: (windowId?: string) => LoadingInfo } }

function loading(app: ElectronApplication): Promise<LoadingInfo> {
  return app.evaluate(() => (globalThis as unknown as NavHooks).__orbitNav.loading())
}

/** The loading indicator's own page (`view=loading`), once it has started. */
async function loadingPage(app: ElectronApplication): Promise<Page> {
  let found: Page | undefined
  await expect
    .poll(() => {
      found = app.windows().find((p) => p.url().includes('view=loading'))
      return !!found
    })
    .toBe(true)
  return found as Page
}

/** A tab's page bounds in its window (window coordinates). */
function pageBounds(app: ElectronApplication, tabId: string) {
  return app.evaluate(
    (_e, id) =>
      (
        globalThis as unknown as {
          __orbit: { ctx: { windows: { tabViewBounds: (t: string) => Electron.Rectangle | undefined } } }
        }
      ).__orbit.ctx.windows.tabViewBounds(id),
    tabId,
  )
}

/** Tells the first window it lost (or got) the focus, as the OS does when another app comes forward. */
function focusEvent(app: ElectronApplication, kind: 'blur' | 'focus') {
  return app.evaluate(({ BrowserWindow }, k) => {
    for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('view=shell')) w.emit(k)
  }, kind)
}

test('[SB-21] an inactive window dims its sidebar over 150 ms and brightens at once on focus', async () => {
  const { app, shell } = orbit
  await openTab(app, page('Dim'))
  const topbar = shell.getByTestId('topbar')
  const opacity = () => topbar.evaluate((el) => Number(getComputedStyle(el).opacity))
  await focusEvent(app, 'focus')
  await expect.poll(async () => (await windowState(app)).focused).toBe(true)
  await expect.poll(opacity).toBe(1)
  await focusEvent(app, 'blur')
  await expect.poll(async () => (await windowState(app)).focused).toBe(false)
  // Dimmed by about 16 %, with a short fade (not at once).
  expect(
    await topbar.evaluate((el) => {
      const style = getComputedStyle(el)
      return { duration: style.transitionDuration, property: style.transitionProperty }
    }),
  ).toEqual({ duration: '0.15s', property: 'opacity' })
  await expect.poll(opacity).toBeCloseTo(0.84, 2)
  // The whole sidebar dims: the Space's list too.
  expect(await shell.getByTestId('space-strip').evaluate((el) => Number(getComputedStyle(el).opacity))).toBeCloseTo(
    0.84,
    2,
  )
  await focusEvent(app, 'focus')
  await expect.poll(async () => (await windowState(app)).focused).toBe(true)
  // Back at once: no transition on the way back.
  expect(await topbar.evaluate((el) => getComputedStyle(el).transitionDuration)).not.toBe('0.15s')
  await expect.poll(opacity).toBe(1)
})

test('[SB-28][FL-23] a slow page shows the loading indicator at the top centre of its card; it finishes and goes when the page is in', async () => {
  const { app } = orbit
  const id = await openTab(app, page('Start'))
  const before = (await loading(app)).shown
  await cmd(app, 'tabs.navigate', { tabId: id, url: fx.url('/slow/Slowly?ms=1500') })
  await expect.poll(async () => (await state(app)).tabs[id]?.loading).toBe(true)
  // Out after the page has been loading a little while, for this tab.
  await expect.poll(async () => (await loading(app)).visible).toBe(true)
  const info = await loading(app)
  expect(info.tabId).toBe(id)
  expect(info.state).toBe('loading')
  expect(info.shown).toBe(before + 1)
  const card = await pageBounds(app, id)
  if (!card || !info.bounds) throw new Error('no bounds')
  // Centred on the card, just inside its top edge.
  expect(Math.abs(info.bounds.x + info.bounds.width / 2 - (card.x + card.width / 2))).toBeLessThanOrEqual(1)
  expect(info.bounds.y - card.y).toBe(2)
  const view = await loadingPage(app)
  const indicator = view.getByTestId('loading-indicator')
  await expect(indicator).toHaveAttribute('data-state', 'loading')
  // The sweep moves (an indeterminate animation).
  expect(await view.locator('.loading-view__sweep').evaluate((el) => getComputedStyle(el).animationName)).toBe(
    'loading-sweep',
  )
  // The page arrives: the pill finishes, then its view goes.
  await waitLoaded(app, id, fx.url('/slow/Slowly?ms=1500'))
  await expect.poll(async () => (await loading(app)).visible, { timeout: 2000 }).toBe(false)
})

test('[SB-28][FL-23] a load shorter than the delay never shows the indicator; switching tabs takes it away', async () => {
  const { app } = orbit
  const id = await openTab(app, page('Quick'))
  const before = (await loading(app)).shown
  // A load that starts and ends within the delay (a cached page), whatever the machine's speed: the
  // page's own start and stop, back to back. The indicator waits out the delay after a start…
  const afterStart = await app.evaluate(({ webContents }, part) => {
    const contents = webContents.getAllWebContents().find((w) => w.getURL().includes(part))
    if (!contents) throw new Error('no page')
    contents.emit('did-start-loading')
    const g = globalThis as unknown as { __orbitNav: { loading: () => { pending: boolean; visible: boolean } } }
    const waiting = g.__orbitNav.loading()
    contents.emit('did-stop-loading')
    return waiting
  }, '/page/Quick')
  expect(afterStart).toMatchObject({ pending: true, visible: false })
  // …and a stop within it means it never shows.
  expect(await loading(app)).toMatchObject({ visible: false, pending: false, shown: before })
  // A slow page in one tab, then another tab: the indicator goes with its tab and comes back with it.
  await cmd(app, 'tabs.navigate', { tabId: id, url: fx.url('/slow/Long?ms=30000') })
  await expect.poll(async () => (await loading(app)).visible).toBe(true)
  await openTab(app, page('Other'))
  await expect.poll(async () => (await loading(app)).visible).toBe(false)
  await cmd(app, 'tabs.activate', { tabId: id })
  await expect.poll(async () => (await loading(app)).tabId).toBe(id)
  await expect.poll(async () => (await loading(app)).visible).toBe(true)
})

test('[NV-04][SB-28] the address shows where a typed address is going; Esc stops it, the indicator goes and the address stays', async () => {
  const { app, shell } = orbit
  const id = await openTab(app, page('Steady'))
  const pill = shell.getByTestId('address-pill')
  await expect(pill).toHaveText(`localhost:${fx.port}`)
  // Another host, so the address visibly changes before the page answers.
  const pending = fx.urlOn('127.0.0.1', '/slow/Pending')
  await cmd(app, 'tabs.navigate', { tabId: id, url: pending })
  await expect(pill).toHaveText(`127.0.0.1:${fx.port}`)
  await expect(pill).toHaveAttribute('title', pending)
  await expect.poll(async () => (await loading(app)).visible).toBe(true)
  // Esc in the page stops the load: the indicator goes, the address keeps where it was going.
  await pressInPage(app, '/page/Steady', 'Escape')
  await expect.poll(async () => (await state(app)).tabs[id]?.loading).toBe(false)
  await expect.poll(async () => (await loading(app)).visible, { timeout: 2000 }).toBe(false)
  await expect(pill).toHaveText(`127.0.0.1:${fx.port}`)
  expect((await state(app)).tabs[id]?.url).toBe(page('Steady'))
  // The next navigation that commits takes over.
  await cmd(app, 'tabs.navigate', { tabId: id, url: page('Next') })
  await waitLoaded(app, id, page('Next'))
  await expect(pill).toHaveText(`localhost:${fx.port}`)
  expect((await state(app)).tabs[id]?.pendingUrl).toBeUndefined()
})

test('[NV-04] a page’s own navigation shows only once it commits', async () => {
  const { app, shell } = orbit
  const id = await openTab(app, page('Own'))
  const pill = shell.getByTestId('address-pill')
  const target = fx.urlOn('127.0.0.1', '/slow/Script?ms=30000')
  await app.evaluate(
    ({ webContents }, [part, url]) => {
      const contents = webContents.getAllWebContents().find((w) => w.getURL().includes(part))
      void contents?.executeJavaScript(`location.href = ${JSON.stringify(url)}`)
    },
    ['/page/Own', target] as const,
  )
  await expect.poll(async () => (await state(app)).tabs[id]?.loading).toBe(true)
  await expect.poll(() => fx.hits('/slow/Script')).toBe(1)
  // The page is still the old one: so is the address.
  await expect(pill).toHaveText(`localhost:${fx.port}`)
  expect((await state(app)).tabs[id]?.pendingUrl).toBeUndefined()
})
