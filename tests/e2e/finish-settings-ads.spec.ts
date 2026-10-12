import { createServer, type Server } from 'node:http'
import { expect, type Page, test } from '@playwright/test'
import { launchOrbit, listenInRange, type Orbit, run, state, tabPage, viewPage } from './helpers'
import { type FirstRun, launchFirstRun, openSettings, pageOfView } from './settings-support'

/**
 * Ad and tracker blocking (OB-06): on by default, from Orbit's list of servers (a test server stands
 * in for one: ORBIT_AD_HOSTS), off for a site from its site controls or for every site in Settings,
 * and chosen in onboarding.
 */

/** The listed server, and the sites of the fixture server's pages. */
const AD_HOST = 'adserver.test'
const HOSTS = ['news.adtest.test', 'shop.adtest.test', 'images.adtest.test', AD_HOST, `cdn.${AD_HOST}`]
const HOST_ARGS = [
  `--host-resolver-rules=${HOSTS.map((h) => `MAP ${h} 127.0.0.1`).join(', ')}`,
  `--proxy-bypass-list=${HOSTS.join(';')}`,
]
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eQnZqAAAAABJRU5ErkJggg==',
  'base64',
)

let server: Server
let port = 0
/** What the fixture server was asked for: "host/path", in order. */
let asked: string[] = []
let orbit: Orbit | undefined
let first: FirstRun | undefined

const url = (host: string, path: string) => `http://${host}:${port}${path}`

/** An article with an ad, a tracker's script and a photo of its own. */
function article(title: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
    <script src="${url(`cdn.${AD_HOST}`, '/track.js')}"></script></head>
    <body><h1 id="title">${title}</h1>
    <img id="ad" src="${url(AD_HOST, '/banner.png')}" width="20" height="20">
    <img id="photo" src="${url('images.adtest.test', '/photo.png')}" width="20" height="20"></body></html>`
}

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '')
    const path = new URL(req.url ?? '/', 'http://x').pathname
    asked.push(`${host}${path}`)
    if (path.endsWith('.png')) {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PIXEL)
    } else if (path.endsWith('.js')) {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end("document.documentElement.dataset.tracked = 'yes'")
    } else if (path === '/own') {
      // The listed site's own page, which loads from its own servers.
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<!doctype html><title>Own</title><h1 id="title">Own</h1>
        <img id="ad" src="${url(`cdn.${AD_HOST}`, '/own.png')}" width="20" height="20">`)
    } else {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(article(path.slice(1) || 'Home'))
    }
  })
  port = await listenInRange(server, 3330)
})
test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})
test.beforeEach(() => {
  asked = []
})
test.afterEach(async () => {
  await orbit?.app.close().catch(() => {})
  await first?.app.close().catch(() => {})
  orbit = undefined
  first = undefined
})

function launch(): Promise<Orbit> {
  return launchOrbit({ args: HOST_ARGS, env: { ORBIT_AD_HOSTS: AD_HOST } })
}

async function openTab(app: Orbit['app'], host: string, path: string): Promise<{ id: string; p: Page }> {
  const id = (await run(app, 'tabs.create', { url: url(host, path) })) as string
  const p = await tabPage(app, url(host, path))
  await expect(p.locator('#title')).toBeVisible()
  return { id, p }
}

/** Whether the page's ad image loaded, and whether the tracker's script ran. */
const pageShows = (p: Page) =>
  p.evaluate(() => ({
    ad: (document.getElementById('ad') as HTMLImageElement | null)?.naturalWidth ?? -1,
    photo: (document.getElementById('photo') as HTMLImageElement | null)?.naturalWidth ?? -1,
    tracked: document.documentElement.dataset.tracked ?? null,
  }))

const askedOf = (host: string) => asked.filter((a) => a.startsWith(`${host}/`))

/** Reloads a tab's page and waits until it is shown again. */
async function reloaded(p: Page, act: () => Promise<unknown>): Promise<void> {
  const loaded = p.waitForEvent('load')
  await act()
  await loaded
  await expect(p.locator('#title')).toBeVisible()
}

test('[OB-06][NV-16] on by default: a page loads nothing from a listed server and all the rest; its site controls count what was stopped and turn blocking off for that site only', async () => {
  orbit = await launch()
  const { app, shell } = orbit
  expect((await state(app)).settings.adBlocking).toBe(true)
  const news = await openTab(app, 'news.adtest.test', '/today')
  expect(await pageShows(news.p)).toEqual({ ad: 0, photo: 1, tracked: null })
  expect(asked).toContain('images.adtest.test/photo.png')
  expect([...askedOf(AD_HOST), ...askedOf(`cdn.${AD_HOST}`)]).toEqual([])
  expect(await run(app, 'adBlock.site', { tabId: news.id })).toEqual({ on: true, allowed: false, blocked: 2 })

  // The site controls panel says so, and its switch lets this site's ads load: the page loads again.
  await shell.getByTestId('site-controls-button').click()
  const overlay = await viewPage(app, 'overlay')
  const row = overlay.getByTestId('site-controls-ads')
  await expect(row).toHaveAttribute('data-on', 'true')
  await expect(overlay.getByTestId('site-controls-ads-state')).toHaveText('On · 2 blocked on this page')
  await reloaded(news.p, () => overlay.getByTestId('site-switch-ads').click())
  await expect.poll(() => pageShows(news.p)).toEqual({ ad: 1, photo: 1, tracked: 'yes' })
  expect(askedOf(AD_HOST)).toEqual([`${AD_HOST}/banner.png`])
  await expect(row).toHaveAttribute('data-on', 'false')
  await expect(overlay.getByTestId('site-controls-ads-state')).toHaveText('Off for this site')
  await overlay.keyboard.press('Escape')
  await expect(overlay.getByTestId('site-controls')).toBeHidden()

  // Only that site: another one still loads none of it.
  const shop = await openTab(app, 'shop.adtest.test', '/cart')
  expect(await pageShows(shop.p)).toEqual({ ad: 0, photo: 1, tracked: null })
  expect(askedOf(AD_HOST)).toHaveLength(1)

  // On again for the first site: its page loads again without them.
  await run(app, 'tabs.activate', { tabId: news.id })
  await shell.getByTestId('site-controls-button').click()
  await expect(overlay.getByTestId('site-controls-ads')).toHaveAttribute('data-on', 'false')
  await reloaded(news.p, () => overlay.getByTestId('site-switch-ads').click())
  await expect.poll(() => pageShows(news.p)).toEqual({ ad: 0, photo: 1, tracked: null })
  expect(askedOf(AD_HOST)).toHaveLength(1)
  await expect(overlay.getByTestId('site-controls-ads-state')).toHaveText('On · 2 blocked on this page')
})

test('[OB-06] a listed site’s own page loads from its own servers; the page you go to is never stopped', async () => {
  orbit = await launch()
  const own = await openTab(orbit.app, AD_HOST, '/own')
  expect(await own.p.evaluate(() => (document.getElementById('ad') as HTMLImageElement).naturalWidth)).toBe(1)
  expect(asked).toEqual([`${AD_HOST}/own`, `cdn.${AD_HOST}/own.png`])
})

test('[OB-06][ST-12] Settings → Privacy turns blocking off for every site, and the site controls say so', async () => {
  orbit = await launch()
  const { app, shell } = orbit
  const news = await openTab(app, 'news.adtest.test', '/today')
  expect(await pageShows(news.p)).toEqual({ ad: 0, photo: 1, tracked: null })
  const settings = await openSettings(app, { section: 'privacy' })
  const toggle = settings.getByTestId('ad-blocking')
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await toggle.click()
  await expect.poll(async () => (await state(app)).settings.adBlocking).toBe(false)
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await reloaded(news.p, () => run(app, 'tabs.reload', { tabId: news.id }))
  await expect.poll(() => pageShows(news.p)).toEqual({ ad: 1, photo: 1, tracked: 'yes' })

  await run(app, 'tabs.activate', { tabId: news.id })
  await shell.getByTestId('site-controls-button').click()
  const overlay = await viewPage(app, 'overlay')
  await expect(overlay.getByTestId('site-controls-ads-state')).toHaveText('Off for every site in Settings')
  await expect(overlay.getByTestId('site-switch-ads')).toBeDisabled()
})

/** Runs what closes the onboarding window: the page may go before the click's own call returns. */
async function closing(page: Page, act: () => Promise<void>): Promise<void> {
  await act().catch(async (err: unknown) => {
    if (!page.isClosed()) await page.waitForEvent('close', { timeout: 2000 }).catch(() => {})
    if (!page.isClosed()) throw err
  })
}

/** The onboarding page at a step. */
async function onboardingAt(run: FirstRun, step: string): Promise<Page> {
  const page = await pageOfView(run.app, 'onboarding')
  await expect(page.getByTestId(`onboarding-step-${step}`)).toBeVisible()
  return page
}

function launchWithOnboarding(userData?: string): Promise<FirstRun> {
  return launchFirstRun({
    userData,
    env: { ORBIT_ONBOARDING: '1', ORBIT_IMPORT_PLACES: '[]', ORBIT_SYSTEM_KEYS: '[]' },
  })
}

/** From the welcome to the ads step, choosing nothing on the way. */
async function toAdsStep(page: Page): Promise<void> {
  await page.getByTestId('onboarding-next').click()
  await page.getByTestId('onboarding-import-later').click()
  for (const step of ['theme', 'favorites']) {
    await expect(page.getByTestId(`onboarding-step-${step}`)).toBeVisible()
    await page.getByTestId('onboarding-next').click()
  }
  await expect(page.getByTestId('onboarding-step-ads')).toBeVisible()
}

test('[OB-06][OB-14] onboarding: blocking is on to start with, and Orbit’s sample page shows the difference; a quit keeps the choice; off then Start browsing turns it off', async () => {
  first = await launchWithOnboarding()
  let page = await onboardingAt(first, 'welcome')
  await toAdsStep(page)
  const toggle = page.getByTestId('onboarding-ads-switch')
  const sample = page.getByTestId('onboarding-ads-sample')
  const ads = page.getByTestId('onboarding-ads-ad')
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(sample).toHaveAttribute('data-blocking', 'true')
  await expect(ads).toHaveCount(3)
  // Blocking on: the sample's ads are folded away; off, they're there.
  const heights = () => ads.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)))
  await expect.poll(heights).toEqual([0, 0, 0])
  await expect(page.getByTestId('onboarding-ads-count')).toHaveText('3 ads and 4 trackers stopped on this page')
  await expect(page.getByTestId('onboarding-step-ads')).toContainText('site controls')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(sample).toHaveAttribute('data-blocking', 'false')
  await expect.poll(async () => (await heights()).every((h) => h > 10)).toBe(true)
  await expect(page.getByTestId('onboarding-ads-count')).toHaveText('3 ads shown, and 4 trackers see this visit')
  // Nothing changes until onboarding ends; a quit comes back to the step with the choice.
  await expect.poll(async () => (await state(first!.app)).settings.onboardingAdBlocking).toBe(false)
  expect((await state(first.app)).settings.adBlocking).toBe(true)
  const { userData } = first
  await first.app.close()
  first = await launchWithOnboarding(userData)
  page = await onboardingAt(first, 'ads')
  await expect(page.getByTestId('onboarding-ads-switch')).toHaveAttribute('aria-checked', 'false')

  await page.getByTestId('onboarding-next').click()
  await page.getByTestId('onboarding-browser-later').click()
  await expect(page.getByTestId('onboarding-summary-ads')).toHaveText('Not blocked: it’s in Settings, under Privacy')
  await closing(page, () => page.getByTestId('onboarding-start').click())
  await expect((await viewPage(first.app, 'shell')).getByTestId('sidebar')).toBeVisible()
  const s = await state(first.app)
  expect(s.settings.adBlocking).toBe(false)
  expect(s.settings).not.toHaveProperty('onboardingAdBlocking')
})

test('[OB-06][OB-14] Skip setup keeps blocking on, whatever the ads step had', async () => {
  first = await launchWithOnboarding()
  const page = await onboardingAt(first, 'welcome')
  await toAdsStep(page)
  await page.getByTestId('onboarding-ads-switch').click()
  await expect.poll(async () => (await state(first!.app)).settings.onboardingAdBlocking).toBe(false)
  await closing(page, () => page.getByTestId('onboarding-skip').click())
  await expect((await viewPage(first.app, 'shell')).getByTestId('sidebar')).toBeVisible()
  const s = await state(first.app)
  expect(s.settings.adBlocking).toBe(true)
  expect(s.settings).not.toHaveProperty('onboardingAdBlocking')
})
