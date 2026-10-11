import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { DEFAULT_PROFILE_ID } from '../../src/shared/defaults'
import { SITE_CATEGORY_ORDER, type SiteSettingsSite } from '../../src/shared/site-settings'
import { launchOrbit, listenInRange, type Orbit, run, state, tabPage, viewPage } from './helpers'
import { openSettings, pageOfView } from './settings-support'

/** Settings → Site settings (ST-13) and what Clear browsing data clears with it (ST-12, DL-08). */

let orbit: Orbit
let server: Server
let port = 0

/** A 1×1 PNG. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eQnZqAAAAABJRU5ErkJggg==',
  'base64',
)

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path === '/script.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end("document.documentElement.dataset.external = 'ran'")
    } else if (path === '/pixel.png') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PIXEL)
    } else if (path === '/data.csv') {
      res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="data.csv"' })
      res.end('a,b\n1,2\n')
    } else if (path.startsWith('/page/')) {
      const title = decodeURIComponent(path.slice('/page/'.length))
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
        <script>document.documentElement.dataset.inline = 'ran'</script>
        <script src="/script.js"></script></head>
        <body><h1 id="title">${title}</h1><img id="pixel" src="/pixel.png" width="20" height="20"></body></html>`)
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  port = await listenInRange(server, 3330)
})
test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})
test.beforeEach(async () => {
  orbit = await launchOrbit()
})
test.afterEach(async () => {
  await orbit.app.close().catch(() => {})
})

const url = (path: string, host = 'localhost') => `http://${host}:${port}${path}`
const site = (host = 'localhost') => `http://${host}:${port}`

async function openTab(path: string, host = 'localhost'): Promise<{ id: string; p: Page }> {
  const id = (await run(orbit.app, 'tabs.create', { url: url(path, host) })) as string
  const p = await tabPage(orbit.app, url(path, host))
  await expect(p.locator('#title')).toBeVisible()
  return { id, p }
}

/** What the page's scripts and its image did: each script marks the page when it runs. */
const pageRan = (p: Page) =>
  p.evaluate(() => ({
    inline: document.documentElement.dataset.inline ?? null,
    external: document.documentElement.dataset.external ?? null,
    image: (document.getElementById('pixel') as HTMLImageElement | null)?.naturalWidth ?? -1,
  }))

const permissionState = (p: Page) =>
  p.evaluate(async () => (await navigator.permissions.query({ name: 'notifications' })).state)

const sites = () =>
  run(orbit.app, 'siteSettings.list', { profileId: DEFAULT_PROFILE_ID }) as Promise<SiteSettingsSite[]>
const siteDefaults = async () => (await state(orbit.app)).profiles[DEFAULT_PROFILE_ID]?.siteDefaults ?? {}

test('[ST-13] Site settings lists each category with its default; one turned off refuses without asking; a site added as allowed is allowed, and its choice can be changed and removed', async () => {
  const { id, p } = await openTab('/page/Notify')
  const settings = await openSettings(orbit.app, { section: 'site-settings' })
  // The spec's three lists, each category with what it does by default.
  await expect(settings.locator('.st-group__title')).toContainText(['Permissions', 'More permissions', 'Content'])
  for (const category of SITE_CATEGORY_ORDER)
    await expect(settings.getByTestId(`site-category-${category}`)).toBeVisible()
  await expect(settings.getByTestId('setting-site-category-notifications')).toContainText(
    'Sites can ask to show notifications',
  )
  await expect(settings.getByTestId('setting-site-category-javascript')).toContainText('Sites can use JavaScript')
  await expect(settings.getByTestId('setting-site-list-empty')).toBeVisible()

  // Notifications off for every site of the profile: the page is refused without a prompt.
  await settings.getByTestId('site-category-notifications').click()
  const category = settings.getByTestId('site-category-page')
  await expect(category).toHaveAttribute('data-category', 'notifications')
  await expect(settings.getByTestId('site-back')).toBeFocused()
  await settings.getByTestId('site-default').selectOption('block')
  await expect.poll(siteDefaults).toEqual({ notifications: 'block' })
  expect(await p.evaluate(() => Notification.requestPermission())).toBe('denied')
  expect(await permissionState(p)).toBe('denied')
  expect((await state(orbit.app)).tabs[id]?.permissionPrompt).toBeUndefined()

  // A site added as allowed is: it asks for nothing.
  await settings.getByTestId('site-add-input').fill(site())
  await settings.getByTestId('site-add-choice').selectOption('allow')
  await settings.getByTestId('site-add-button').click()
  const allowed = settings.getByTestId(`setting-site-exception-allow-${site()}`)
  await expect(allowed).toContainText(`localhost:${port}`)
  await expect.poll(() => permissionState(p)).toBe('granted')
  expect(await p.evaluate(() => Notification.requestPermission())).toBe('granted')

  // Changed to Block, it moves to the blocked list; removed, the site follows the default again.
  await allowed.getByTestId('site-exception-choice').selectOption('block')
  const blocked = settings.getByTestId(`setting-site-exception-block-${site()}`)
  await expect(blocked).toBeVisible()
  await expect(allowed).toHaveCount(0)
  await expect.poll(() => permissionState(p)).toBe('denied')
  await blocked.getByTestId('site-exception-remove').click()
  await expect(blocked).toHaveCount(0)
  await expect.poll(sites).toEqual([])
  expect(await permissionState(p)).toBe('denied')
  await settings.getByTestId('site-default').selectOption('ask')
  await expect.poll(siteDefaults).toEqual({})
  await expect.poll(() => permissionState(p)).toBe('prompt')

  // Back on the section's first page, at the category it came from.
  await settings.getByTestId('site-back').click()
  await expect(settings.getByTestId('site-category-notifications')).toBeFocused()
})

test('[ST-13][NV-16] JavaScript, images and sound blocked for one site from its page, opened by the site controls panel: its pages load with no script or image, its tab is muted; another site is untouched; Default undoes it', async () => {
  const a = await openTab('/page/Blocked')
  const b = await openTab('/page/Other', '127.0.0.1')
  const ran = { inline: 'ran', external: 'ran', image: 1 }
  expect(await pageRan(b.p)).toEqual(ran)
  await run(orbit.app, 'tabs.activate', { tabId: a.id })
  expect(await pageRan(a.p)).toEqual(ran)

  // The site controls panel links to all of the site's settings.
  await orbit.shell.getByTestId('site-controls-button').click()
  const overlay = await viewPage(orbit.app, 'overlay')
  await overlay.getByTestId('site-controls-settings').click()
  await expect(overlay.getByTestId('site-controls')).toHaveCount(0)
  const settings = await pageOfView(orbit.app, 'settings')
  const page = settings.getByTestId('site-page')
  await expect(page).toHaveAttribute('data-origin', site())
  await expect(settings.getByTestId('site-view-title')).toHaveText(site())
  await expect(settings.getByTestId('site-choice-javascript')).toHaveValue('default')
  await expect(settings.getByTestId('site-choice-javascript').locator('option').first()).toHaveText('Default (Allow)')
  await expect(settings.getByTestId('site-choice-camera').locator('option').first()).toHaveText('Default (Ask)')

  for (const kind of ['javascript', 'images', 'sound'])
    await settings.getByTestId(`site-choice-${kind}`).selectOption('block')
  await expect.poll(async () => (await state(orbit.app)).tabs[a.id]?.muted).toBe(true)
  await a.p.reload()
  await expect(a.p.locator('#title')).toBeVisible()
  expect(await pageRan(a.p)).toEqual({ inline: null, external: null, image: 0 })
  await b.p.reload()
  await expect(b.p.locator('#title')).toBeVisible()
  expect(await pageRan(b.p)).toEqual(ran)
  expect((await state(orbit.app)).tabs[b.id]?.muted).toBeFalsy()

  // The section's first page lists the site with its choices.
  await settings.getByTestId('site-back').click()
  const row = settings.getByTestId(`setting-site-${site()}`)
  await expect(row).toContainText('Sound: Block · JavaScript: Block · Images: Block')
  await row.getByTestId('site-open').click()
  for (const kind of ['javascript', 'images', 'sound']) {
    await settings.getByTestId(`site-choice-${kind}`).selectOption('default')
  }
  await expect.poll(async () => (await state(orbit.app)).tabs[a.id]?.muted).toBe(false)
  await expect.poll(sites).toEqual([])
  await a.p.reload()
  await expect(a.p.locator('#title')).toBeVisible()
  expect(await pageRan(a.p)).toEqual(ran)
})

test('[ST-12][DL-08][ST-13] Clear browsing data: Download history empties the downloads list and leaves the file; Site settings forgets every site’s choices and keeps the defaults', async () => {
  const { p } = await openTab('/page/Download')
  await p.evaluate((href) => {
    const link = document.createElement('a')
    link.href = href
    link.download = ''
    document.body.append(link)
    link.click()
  }, url('/data.csv'))
  const downloads = () =>
    run(orbit.app, 'downloads.list', { profileId: DEFAULT_PROFILE_ID }) as Promise<
      { state: string; savePath: string }[]
    >
  await expect.poll(async () => (await downloads()).map((d) => d.state)).toEqual(['completed'])
  const file = (await downloads())[0]?.savePath as string
  expect(existsSync(file)).toBe(true)
  await run(orbit.app, 'siteSettings.set', {
    profileId: DEFAULT_PROFILE_ID,
    origin: site(),
    category: 'camera',
    choice: 'block',
  })
  await run(orbit.app, 'siteSettings.setDefault', { profileId: DEFAULT_PROFILE_ID, category: 'images', value: 'block' })
  expect((await sites()).map((s) => s.origin)).toEqual([site()])

  const settings = await openSettings(orbit.app, { section: 'privacy' })
  await settings.getByTestId('clear-data-open').click()
  const box = (kind: string) => settings.getByTestId(`clear-data-${kind}`).locator('input')
  // Like site data, the downloads list goes from all time: unticked for a short range.
  await expect(box('downloads')).not.toBeChecked()
  await expect(box('site-settings')).not.toBeChecked()
  await settings.getByTestId('clear-data-range').selectOption('all')
  await expect(box('downloads')).toBeChecked()
  await expect(box('site-settings')).not.toBeChecked()
  await settings.getByTestId('clear-data-site-settings').click()
  await expect(box('site-settings')).toBeChecked()
  await settings.getByTestId('clear-data-confirm').click()
  await expect(settings.getByTestId('clear-data-status')).toHaveText('Deleted from Default')
  await expect.poll(downloads).toEqual([])
  expect(existsSync(file)).toBe(true)
  expect(file.startsWith(join(orbit.userData))).toBe(true)
  await expect.poll(sites).toEqual([])
  expect(await siteDefaults()).toEqual({ images: 'block' })
})
