import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { action, launchOrbit, type Orbit, run, state, tabPage } from './helpers'
import {
  cmd,
  type NavFixtures,
  openTab,
  pageMouse,
  pressInPage,
  startNavFixtures,
  toolsInfo,
  viewStack,
  waitLoaded,
  windowState,
} from './nav-support'

/**
 * A page's life in its card: the inactive window's sidebar (SB-21), the loading indicator (SB-28),
 * the address while a page is on its way (NV-04) and the link status pill (SB-27).
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

interface LinkPillInfo {
  visible: boolean
  tabId: string | null
  url: string | null
  text: string | null
  expanded: boolean
  side: 'left' | 'right'
  bounds?: { x: number; y: number; width: number; height: number }
  expandedAfter: number | null
}

type NavHooks = {
  __orbitNav: { loading: (windowId?: string) => LoadingInfo; linkPill: (windowId?: string) => LinkPillInfo }
}

function loading(app: ElectronApplication): Promise<LoadingInfo> {
  return app.evaluate(() => (globalThis as unknown as NavHooks).__orbitNav.loading())
}

function linkPill(app: ElectronApplication): Promise<LinkPillInfo> {
  return app.evaluate(() => (globalThis as unknown as NavHooks).__orbitNav.linkPill())
}

/** A view's own page (`view=<name>`), once it has started. */
async function viewPageOf(app: ElectronApplication, name: string): Promise<Page> {
  let found: Page | undefined
  await expect
    .poll(() => {
      found = app.windows().find((p) => p.url().includes(`view=${name}`))
      return !!found
    })
    .toBe(true)
  return found as Page
}

/** The middle of an element of a tab's page, in the page's coordinates. */
async function middleOf(tab: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await tab.locator(selector).boundingBox()
  if (!box) throw new Error(`no ${selector}`)
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
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

/** Runs script in the page whose address contains `part`, as the person's own act (a user gesture). */
function inPage(app: ElectronApplication, part: string, code: string): Promise<unknown> {
  return app.evaluate(
    ({ webContents }, [p, c]) => {
      const contents = webContents.getAllWebContents().find((w) => w.getURL().includes(p))
      if (!contents) throw new Error(`no page ${p}`)
      return contents.executeJavaScript(c, true)
    },
    [part, code] as const,
  )
}

/** The first window's views, bottom to top: a page's path, or an Orbit view's name in capitals. */
function zOrder(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('view=shell'))
    return (win?.contentView.children ?? []).map((v) => {
      const wc = (v as Electron.WebContentsView).webContents
      if (!wc || wc.isDestroyed()) return 'dead'
      const url = new URL(wc.getURL() || 'about:blank')
      return url.searchParams.get('view')?.toUpperCase() ?? url.pathname
    })
  })
}

/** True while a page of the first window is in HTML full screen. */
function htmlFullscreen(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(() => {
    const { windows } = (
      globalThis as unknown as {
        __orbit: { ctx: { windows: { ids: () => string[]; inHtmlFullscreen: (id: string) => boolean } } }
      }
    ).__orbit.ctx
    return windows.inHtmlFullscreen(windows.ids()[0] as string)
  })
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
  // The page comes when the test lets it, however slow the machine (review A-F9).
  const slow = fx.url('/slow/Slowly')
  await cmd(app, 'tabs.navigate', { tabId: id, url: slow })
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
  const view = await viewPageOf(app, 'loading')
  const indicator = view.getByTestId('loading-indicator')
  await expect(indicator).toHaveAttribute('data-state', 'loading')
  // The sweep moves (an indeterminate animation).
  expect(await view.locator('.loading-view__sweep').evaluate((el) => getComputedStyle(el).animationName)).toBe(
    'loading-sweep',
  )
  // The page arrives: the pill finishes, then its view goes.
  fx.release('/slow/Slowly')
  await waitLoaded(app, id, slow)
  await expect.poll(async () => (await loading(app)).visible, { timeout: 2000 }).toBe(false)
})

test('[SB-28][FL-23] a load shorter than the delay never shows the indicator; switching tabs takes it away', async () => {
  const { app } = orbit
  const id = await openTab(app, page('Quick'))
  // The tab's first load may have shown it (a slow machine): wait until it has finished and gone.
  await expect.poll(async () => (await loading(app)).visible || (await loading(app)).pending).toBe(false)
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

test('[SB-28][NV-20] the loading indicator stays off a page in HTML full screen and its view leaves the window: the page is top-most under the overlay; it comes back after (review A-M1)', async () => {
  const { app } = orbit
  const id = await openTab(app, page('Start'))
  const url = fx.url('/slow/Film?ms=600')
  // The indicator comes for a slow load and goes, before full screen.
  await cmd(app, 'tabs.navigate', { tabId: id, url })
  await expect.poll(async () => (await loading(app)).visible).toBe(true)
  await waitLoaded(app, id, url)
  await expect.poll(async () => (await loading(app)).visible).toBe(false)
  expect(await inPage(app, '/slow/Film', 'document.documentElement.requestFullscreen().then(() => "in")')).toBe('in')
  await expect.poll(() => htmlFullscreen(app)).toBe(true)
  // Nothing of Orbit's but the overlay is above the page: no hidden indicator either.
  await expect.poll(async () => (await zOrder(app)).slice(-2)).toEqual(['/slow/Film', 'OVERLAY'])
  // A frame that takes a second to load: the tab loads all that time, but the indicator never shows.
  const before = (await loading(app)).shown
  const framed = `new Promise((done) => {
    const frame = document.createElement('iframe')
    frame.onload = () => done('loaded')
    frame.src = '/slow/Frame?ms=1000'
    document.body.append(frame)
  })`
  expect(await inPage(app, '/slow/Film', framed)).toBe('loaded')
  expect(await loading(app)).toMatchObject({ visible: false, shown: before })
  expect((await zOrder(app)).slice(-2)).toEqual(['/slow/Film', 'OVERLAY'])
  // A frame still loading when full screen ends: the indicator comes for it then.
  await inPage(
    app,
    '/slow/Film',
    `document.body.append(Object.assign(document.createElement('iframe'), { src: '/slow/Long?ms=30000' })), 1`,
  )
  await expect.poll(async () => (await state(app)).tabs[id]?.loading).toBe(true)
  expect(await loading(app)).toMatchObject({ visible: false, shown: before })
  expect(await inPage(app, '/slow/Film', 'document.exitFullscreen().then(() => "out")')).toBe('out')
  await expect.poll(() => htmlFullscreen(app)).toBe(false)
  await expect.poll(async () => (await loading(app)).visible).toBe(true)
  expect((await loading(app)).tabId).toBe(id)
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

test('[SB-27] hovering a link shows where it goes at the bottom-left of the card, in full after 1.5 s; it goes off the link', async () => {
  const { app } = orbit
  const id = await openTab(app, page('Pill'))
  const tab = await tabPage(app, '/page/Pill')
  const link = await middleOf(tab, '#next')
  await pageMouse(app, '/page/Pill', 'mouseMove', link.x, link.y)
  await expect.poll(async () => (await linkPill(app)).visible).toBe(true)
  const short = await linkPill(app)
  expect(short).toMatchObject({ tabId: id, url: page('Pill-next'), expanded: false, side: 'left' })
  expect(short.text).toBe(`localhost:${fx.port}/page/Pill-next`)
  // In the card's bottom-left corner, inside it.
  const card = await pageBounds(app, id)
  if (!card || !short.bounds) throw new Error('no bounds')
  expect(short.bounds.x).toBe(card.x)
  expect(short.bounds.y + short.bounds.height).toBe(card.y + card.height)
  expect(short.bounds.width).toBeLessThan(card.width / 2)
  // Drawn in the Space's theme.
  const view = await viewPageOf(app, 'link')
  await expect(view.getByTestId('link-pill')).toHaveText(short.text as string)
  expect(await view.getByTestId('link-pill-view').getAttribute('style')).toContain('--surface')
  // Still on the link after about 1.5 s: the full URL.
  await expect.poll(async () => (await linkPill(app)).expanded, { timeout: 5000 }).toBe(true)
  const full = await linkPill(app)
  expect(full.text).toBe(page('Pill-next'))
  expect(full.expandedAfter).toBeGreaterThanOrEqual(1450)
  await expect(view.getByTestId('link-pill')).toHaveText(page('Pill-next'))
  await expect(view.getByTestId('link-pill')).toHaveAttribute('data-expanded', 'true')
  // Off the link: it goes.
  const title = await middleOf(tab, '#title')
  await pageMouse(app, '/page/Pill', 'mouseMove', title.x + 200, title.y)
  await expect.poll(async () => (await linkPill(app)).visible).toBe(false)
  expect((await linkPill(app)).url).toBeNull()
})

test('[SB-27] the pill moves to the other corner when the pointer comes near it, and goes with its tab', async () => {
  const { app } = orbit
  const id = await openTab(app, page('Corner'))
  const tab = await tabPage(app, '/page/Corner')
  // A link right in the corner where the pill would be.
  await tab.evaluate(() => {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<a id="corner" href="/page/Elsewhere" style="position:fixed;left:10px;bottom:10px">Corner link</a>',
    )
  })
  const corner = await middleOf(tab, '#corner')
  await pageMouse(app, '/page/Corner', 'mouseMove', corner.x, corner.y)
  await expect.poll(async () => (await linkPill(app)).visible).toBe(true)
  const info = await linkPill(app)
  expect(info.side).toBe('right')
  const card = await pageBounds(app, id)
  if (!card || !info.bounds) throw new Error('no bounds')
  expect(info.bounds.x + info.bounds.width).toBe(card.x + card.width)
  expect(info.bounds.y + info.bounds.height).toBe(card.y + card.height)
  // Another tab: the pill goes with its page.
  await openTab(app, page('Other'))
  await expect.poll(async () => (await linkPill(app)).visible).toBe(false)
})

test('[SB-28][NV-05][AR-02] a page’s find bar and loading indicator stay under the Library while it is open, and are over the page again once it closes', async () => {
  const { app } = orbit
  const id = await openTab(app, page('Covered'))
  await action(app, 'page.find')
  await expect.poll(async () => (await toolsInfo(app)).placed).toBe(true)
  await run(app, 'library.open', {})
  await expect
    .poll(() => run(app, 'library.testInfo') as Promise<{ open: boolean; visible: boolean }>)
    .toMatchObject({ open: true, visible: true })
  /** Whether a view is above the page and under the Library. */
  const covered = (stack: string[], view: string) =>
    stack.indexOf(view) > stack.indexOf(`page:${id}`) && stack.indexOf(view) < stack.indexOf('view=library')
  await expect.poll(async () => covered(await viewStack(app), 'view=tools')).toBe(true)
  // A slow load in the page under the Library: its indicator goes under the Library too.
  const slow = fx.url('/slow/Covered')
  await cmd(app, 'tabs.navigate', { tabId: id, url: slow })
  await expect.poll(async () => (await loading(app)).visible).toBe(true)
  const stack = await viewStack(app)
  expect(covered(stack, 'view=loading')).toBe(true)
  expect(covered(stack, 'view=tools')).toBe(true)
  // The Library closes: both are over the page again.
  await run(app, 'library.close', {})
  await expect.poll(async () => (await viewStack(app)).includes('view=library')).toBe(false)
  const after = await viewStack(app)
  expect(after.indexOf('view=tools')).toBeGreaterThan(after.indexOf(`page:${id}`))
  expect(after.indexOf('view=loading')).toBeGreaterThan(after.indexOf(`page:${id}`))
  fx.release('/slow/Covered')
  await waitLoaded(app, id, slow)
})
