import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, type Page, test } from '@playwright/test'
import type { MainContext } from '../../src/main/context'
import type { DownloadEntry } from '../../src/shared/commands/downloads'
import type { Download, OrbitState } from '../../src/shared/state'
import { action, activeTabId, isMac, launchOrbit, listenInRange, type Orbit, run, state, tabPage } from './helpers'

/**
 * Downloads (DL). A local server sends the files, with an ETag and byte ranges (so a download can
 * continue where it stopped) unless `?plain`:
 * - `/file/<name>?size=` at once;
 * - `/held/<name>?size=` half at once, the rest when the test releases it;
 * - `/slow/<name>?size=&rate=` at `rate` bytes per second;
 * - `/cut/<name>?size=` a quarter, then the connection breaks, and every request breaks until the
 *   test repairs it.
 */

const MB = 1024 * 1024

interface DownloadServer {
  url: (path: string) => string
  /** Sends the rest of a held file. */
  release: (name: string) => void
  /** Lets a cut-off file through again. */
  repair: (name: string) => void
  /** The requests for a file so far, with the byte range each asked for. */
  requests: (name: string) => { range?: string }[]
  close: () => Promise<void>
}

const PAGE = (body: string) => `<!doctype html><html><head><title>Downloads</title></head>
<body style="font: 16px system-ui; padding: 24px">${body}</body></html>`

function body(size: number): Buffer {
  const out = Buffer.alloc(size)
  for (let i = 0; i < size; i++) out[i] = i % 251
  return out
}

async function startDownloadServer(): Promise<DownloadServer> {
  const held = new Map<string, () => void>()
  const released = new Set<string>()
  const broken = new Set<string>()
  const repaired = new Set<string>()
  const log = new Map<string, { range?: string }[]>()
  const open = new Set<ServerResponse>()
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost')
    const [kind, raw = ''] = u.pathname.split('/').filter(Boolean)
    const name = decodeURIComponent(raw)
    const size = Number(u.searchParams.get('size') ?? 1024)
    if (kind === 'page') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(
        PAGE(`<h1 id="title">${name || 'Downloads'}</h1>
          <p><a id="download" href="/file/report.pdf?size=${10 * MB}" download>Download the report</a></p>
          <p><a id="attachment" href="/file/data.csv?size=4096">Data (attachment)</a></p>
          <p><a id="new-tab" href="/file/notes.zip?size=2048" target="_blank">Notes in a new tab</a></p>
          <p><a id="held" href="/held/big.bin?size=${4 * MB}">Big file</a></p>`),
      )
      return
    }
    if (kind !== 'file' && kind !== 'held' && kind !== 'slow' && kind !== 'cut') {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    const range = req.headers.range
    log.set(name, [...(log.get(name) ?? []), range ? { range } : {}])
    open.add(res)
    res.on('close', () => open.delete(res))
    if (kind === 'cut' && broken.has(name)) {
      res.destroy()
      return
    }
    const data = body(size)
    const plain = u.searchParams.has('plain')
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${name}"`,
      ...(plain ? {} : { etag: `"${name}-${size}"`, 'accept-ranges': 'bytes' }),
    }
    const from = !plain && range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0
    if (from > 0 && from < size) {
      res.writeHead(206, {
        ...headers,
        'content-length': String(size - from),
        'content-range': `bytes ${from}-${size - 1}/${size}`,
      })
      res.end(data.subarray(from))
      return
    }
    res.writeHead(200, { ...headers, 'content-length': String(size) })
    if (kind === 'file' || (kind === 'cut' && repaired.has(name))) {
      res.end(data)
      return
    }
    if (kind === 'cut') {
      broken.add(name)
      res.write(data.subarray(0, Math.floor(size / 4)), () => setTimeout(() => res.destroy(), 100))
      return
    }
    if (kind === 'slow') {
      const chunk = Math.max(1, Math.round(Number(u.searchParams.get('rate') ?? 512 * 1024) / 20))
      let sent = 0
      const timer = setInterval(() => {
        const next = Math.min(size, sent + chunk)
        res.write(data.subarray(sent, next))
        sent = next
        if (sent < size) return
        clearInterval(timer)
        res.end()
      }, 50)
      res.on('close', () => clearInterval(timer))
      return
    }
    const half = Math.floor(size / 2)
    res.write(data.subarray(0, half))
    const finish = () => {
      held.delete(name)
      if (!res.destroyed) res.end(data.subarray(half))
    }
    if (released.has(name)) finish()
    else held.set(name, finish)
  })
  const port = await listenInRange(server, 3300 + (Number(process.env.TEST_PARALLEL_INDEX ?? 0) % 50))
  return {
    url: (path) => `http://localhost:${(server.address() as AddressInfo).port || port}${path}`,
    release: (name) => {
      released.add(name)
      held.get(name)?.()
    },
    repair: (name) => {
      broken.delete(name)
      repaired.add(name)
    },
    requests: (name) => log.get(name) ?? [],
    close: () =>
      new Promise((r) => {
        for (const res of open) res.destroy()
        server.close(() => r())
      }),
  }
}

let server: DownloadServer
let orbit: Orbit

test.beforeEach(async () => {
  server = await startDownloadServer()
  orbit = await launchOrbit()
  // macOS keeps the clipboard after the app quits (DL-04 copies files and links).
  await orbit.app.evaluate(({ clipboard }) => clipboard.clear())
})
test.afterEach(async () => {
  await orbit.app.close().catch(() => {})
  await server.close()
})

const folder = () => join(orbit.userData, 'Downloads')
const list = async (profileId?: string) => (await run(orbit.app, 'downloads.list', { profileId })) as Download[]
const named = async (filename: string) => (await list()).find((d) => d.filename === filename)
const sizeOf = (path: string) => (existsSync(path) ? statSync(path).size : -1)

/** Opens the fixture page in a new tab and returns it. */
async function openPage(title = 'Downloads'): Promise<{ tabId: string; page: Page }> {
  const tabId = (await run(orbit.app, 'tabs.create', { url: server.url(`/page/${title}`) })) as string
  const page = await tabPage(orbit.app, `/page/${title}`)
  await expect(page.locator('#title')).toHaveText(title)
  return { tabId, page }
}

const tabCount = async () => Object.keys((await state(orbit.app)).tabs).length

/** Starts downloads from a page, all at once (links with a `download` attribute, clicked in turn). */
async function startDownloads(page: Page, ...paths: string[]): Promise<void> {
  await page.evaluate((hrefs) => {
    for (const href of hrefs) {
      const a = document.createElement('a')
      a.href = href
      a.download = ''
      document.body.append(a)
      a.click()
      a.remove()
    }
  }, paths)
}

type Hooks = {
  opened: string[]
  shown: string[]
  trash: string
  trashFails?: boolean
  menu: () => string[]
  clickMenu: (label: string) => boolean
  settle: () => Promise<void>
}

/** Reads the downloads test hooks (main process). */
function hooks<T>(read: (h: Hooks) => T | Promise<T>): Promise<T> {
  return orbit.app.evaluate(
    async (_e, source) =>
      new Function('h', `return (${source})(h)`)(
        (globalThis as unknown as { __orbitDownloads: unknown }).__orbitDownloads,
      ) as T,
    read.toString(),
  )
}

/** The labels of a download's menu (it never shows in test runs). */
async function menuOf(id: string): Promise<string[]> {
  await run(orbit.app, 'downloads.menu', { id })
  return hooks((h) => h.menu())
}

async function clickMenu(label: string): Promise<void> {
  const clicked = await orbit.app.evaluate(
    (_e, l) =>
      (globalThis as unknown as { __orbitDownloads: { clickMenu: (l: string) => boolean } }).__orbitDownloads.clickMenu(
        l,
      ),
    label,
  )
  expect(clicked, label).toBe(true)
}

const SHOW_IN_FOLDER = isMac ? 'Show in Finder' : 'Show in Folder'

const rows = () => orbit.shell.getByTestId('download-row')
const row = (filename: string) => orbit.shell.locator(`[data-testid="download-row"][title="${filename}"]`)
const idOf = async (filename: string) => ((await named(filename)) as Download).id
const entry = async (filename: string) => (await list()).find((d) => d.filename === filename) as DownloadEntry

/** Records the animations the shell starts (DL-02's flight, its fade and the landing). */
async function recordAnimations(): Promise<void> {
  await orbit.shell.evaluate(() => {
    const w = window as unknown as { __anims: { id: string; testid: string | null; last: string }[] }
    w.__anims = []
    const animate = Element.prototype.animate
    Element.prototype.animate = function (this: Element, keyframes, options) {
      const frames = Array.isArray(keyframes) ? keyframes : []
      const id = typeof options === 'object' && options?.id ? options.id : ''
      w.__anims.push({
        id,
        testid: this.getAttribute('data-testid'),
        last: String(frames[frames.length - 1]?.transform ?? ''),
      })
      return animate.call(this, keyframes, options)
    }
  })
}

const animations = (id: string) =>
  orbit.shell.evaluate(
    (wanted) =>
      (window as unknown as { __anims: { id: string; testid: string | null; last: string }[] }).__anims.filter(
        (a) => a.id === wanted,
      ),
    id,
  )

test('[DL-01] a download link saves the file in the profile download folder; no tab opens', async () => {
  const { tabId, page } = await openPage()
  const tabsBefore = await tabCount()
  await page.locator('#download').click()
  await expect.poll(async () => (await named('report.pdf'))?.state).toBe('completed')
  const done = (await named('report.pdf')) as Download
  expect(done).toMatchObject({
    savePath: join(folder(), 'report.pdf'),
    receivedBytes: 10 * MB,
    totalBytes: 10 * MB,
    profileId: 'p-default',
  })
  expect(sizeOf(join(folder(), 'report.pdf'))).toBe(10 * MB)
  expect(readdirSync(folder()).filter((f) => f.endsWith('.crdownload'))).toEqual([])
  // The page stays where it was; the sidebar has no new tab.
  expect(await tabCount()).toBe(tabsBefore)
  expect(await activeTabId(orbit.app)).toBe(tabId)
  expect((await state(orbit.app)).tabs[tabId]?.url).toBe(server.url('/page/Downloads'))
})

test('[DL-01] the same file twice: the second is saved as "name (1)"', async () => {
  const { page } = await openPage()
  await page.locator('#attachment').click()
  await expect.poll(async () => (await named('data.csv'))?.state).toBe('completed')
  await page.locator('#attachment').click()
  await expect.poll(async () => (await named('data (1).csv'))?.state).toBe('completed')
  expect(readdirSync(folder()).sort()).toEqual(['data (1).csv', 'data.csv'])
  expect(sizeOf(join(folder(), 'data (1).csv'))).toBe(4096)
})

test('[DL-01] a download opened in a new tab leaves no tab behind and no Archive entry', async () => {
  const { tabId, page } = await openPage()
  const tabsBefore = await tabCount()
  await page.locator('#new-tab').click()
  await expect.poll(async () => (await named('notes.zip'))?.state).toBe('completed')
  await expect.poll(tabCount).toBe(tabsBefore)
  expect(await activeTabId(orbit.app)).toBe(tabId)
  const s: OrbitState = await state(orbit.app)
  expect(s.archive.filter((a) => a.url.includes('/file/'))).toEqual([])
  expect(sizeOf(join(folder(), 'notes.zip'))).toBe(2048)
})

test('[DL-01] a partial file has a temporary name, and the download outlives the page that started it', async () => {
  const { tabId, page } = await openPage()
  await page.locator('#held').click()
  const partial = join(folder(), 'big.bin.crdownload')
  await expect.poll(async () => (await named('big.bin'))?.state).toBe('progressing')
  const id = ((await named('big.bin')) as Download).id
  // While it runs: the sidebar's state has it with the bytes so far, under its temporary name.
  await expect.poll(async () => (await state(orbit.app)).downloads[id]?.receivedBytes).toBe(2 * MB)
  expect((await state(orbit.app)).downloads[id]).toMatchObject({ state: 'progressing', totalBytes: 4 * MB })
  expect(existsSync(partial)).toBe(true)
  expect(existsSync(join(folder(), 'big.bin'))).toBe(false)
  expect(await run(orbit.app, 'downloads.active')).toBe(1)
  // The page that started it closes; the download goes on.
  await run(orbit.app, 'tabs.close', { tabId })
  await expect.poll(async () => (await state(orbit.app)).tabs[tabId]).toBeUndefined()
  server.release('big.bin')
  await expect.poll(async () => (await named('big.bin'))?.state).toBe('completed')
  expect(sizeOf(join(folder(), 'big.bin'))).toBe(4 * MB)
  expect(existsSync(partial)).toBe(false)
  // Done: shown as complete for a few seconds, then off the sidebar's indicator; still in the list.
  await expect.poll(async () => (await state(orbit.app)).downloads[id], { timeout: 15_000 }).toBeUndefined()
  expect((await named('big.bin'))?.state).toBe('completed')
  expect(await run(orbit.app, 'downloads.active')).toBe(0)
})

test('[DL-01] cancelling a download deletes its partial file', async () => {
  const { page } = await openPage()
  await page.locator('#held').click()
  await expect.poll(async () => (await named('big.bin'))?.state).toBe('progressing')
  const id = ((await named('big.bin')) as Download).id
  await expect.poll(() => existsSync(join(folder(), 'big.bin.crdownload'))).toBe(true)
  await run(orbit.app, 'downloads.cancel', { id })
  await expect.poll(async () => (await named('big.bin'))?.state).toBe('cancelled')
  await expect.poll(() => readdirSync(folder())).toEqual([])
  expect((await state(orbit.app)).downloads[id]).toBeUndefined()
})

test("[DL-01] each profile's downloads are its own", async () => {
  const profileId = (await run(orbit.app, 'profiles.create', { name: 'Work' })) as string
  await run(orbit.app, 'spaces.create', { name: 'Work', profileId, activate: true })
  const { page } = await openPage('Work')
  await page.locator('#attachment').click()
  await expect.poll(async () => (await list(profileId)).map((d) => d.filename)).toEqual(['data.csv'])
  expect((await list(profileId))[0]).toMatchObject({ profileId, state: 'completed' })
  expect(await list('p-default')).toEqual([])
})

test('[DL-01] quitting with a download in progress asks first', async () => {
  const { page } = await openPage()
  await page.locator('#held').click()
  await expect.poll(async () => (await named('big.bin'))?.state).toBe('progressing')
  const asked = () =>
    orbit.app.evaluate(
      () => (globalThis as unknown as { __orbitDownloads: { asked: string[] } }).__orbitDownloads.asked,
    )
  const answer = (value: 'quit' | 'cancel') =>
    orbit.app.evaluate((_e, v) => {
      ;(globalThis as unknown as { __orbitDownloads: { quitAnswer?: string } }).__orbitDownloads.quitAnswer = v
    }, value)
  // "Cancel": Orbit keeps running, the download too.
  await answer('cancel')
  await orbit.app.evaluate(({ app }) => app.quit())
  await expect.poll(asked).toEqual(['1 download in progress, quit anyway?'])
  // Nothing started quitting: the window is there and the window manager isn't winding down.
  const windowManager = () =>
    orbit.app.evaluate(() => {
      const { ctx } = (globalThis as unknown as { __orbit: { ctx: MainContext } }).__orbit
      return { windows: ctx.windows.ids().length, quitting: ctx.windows.quitting }
    })
  expect(await windowManager()).toEqual({ windows: 1, quitting: false })
  expect((await named('big.bin'))?.state).toBe('progressing')
  // "Quit": it quits (app.close() fails the test if it doesn't).
  await answer('quit')
  await orbit.app.close()
})

// ---- DL-02: the start animation ----

test('[DL-02] a download flies from the page into the Library button; two at once fly twice', async () => {
  const { page } = await openPage()
  await recordAnimations()
  await startDownloads(page, '/file/one.csv?size=2048', '/file/two.csv?size=2048')
  await expect.poll(async () => (await animations('download-flight')).length).toBe(2)
  // Each lands on the Library button, which bounces.
  const button = await orbit.shell.getByTestId('library-button').boundingBox()
  if (!button) throw new Error('no Library button')
  const landing = `translate(${button.x + button.width / 2 - 13}px, ${button.y + button.height / 2 - 13}px)`
  for (const flight of await animations('download-flight')) {
    expect(flight.testid).toBe('download-flight')
    expect(flight.last.startsWith(landing), flight.last).toBe(true)
  }
  await expect
    .poll(async () => (await animations('download-landing')).map((a) => a.testid))
    .toEqual(['library-button', 'library-button'])
  // The flying icons are gone once they land.
  await expect(orbit.shell.getByTestId('download-flight')).toHaveCount(0)
  expect(await animations('download-fade')).toEqual([])
})

test('[DL-02] with the sidebar hidden, a toast says what is downloading', async () => {
  const { page } = await openPage()
  await recordAnimations()
  await action(orbit.app, 'sidebar.toggle')
  await expect
    .poll(
      async () =>
        (await state(orbit.app)).windows[Object.keys((await state(orbit.app)).windows)[0] as string]?.sidebar.visible,
    )
    .toBe(false)
  await page.locator('#attachment').click()
  await expect(orbit.shell.getByTestId('toast').filter({ hasText: 'Downloading data.csv' })).toHaveCount(1)
  await expect(orbit.shell.getByTestId('toast').filter({ hasText: 'Downloaded data.csv' })).toHaveCount(1)
  expect(await animations('download-flight')).toEqual([])
})

test('[DL-02] with reduced motion, the icon fades on the Library button instead of flying', async () => {
  const { page } = await openPage()
  await orbit.shell.emulateMedia({ reducedMotion: 'reduce' })
  await recordAnimations()
  await page.locator('#attachment').click()
  await expect.poll(async () => (await animations('download-fade')).length).toBe(1)
  expect(await animations('download-flight')).toEqual([])
  expect(await animations('download-landing')).toEqual([])
})

// ---- DL-03: the sidebar's downloads row ----

test('[DL-03] a running download shows its name, bytes and a falling time left; ✕ cancels it and deletes the partial file', async () => {
  const tray = orbit.shell.getByTestId('downloads-tray')
  const spaceBar = orbit.shell.getByTestId('library-button')
  // No downloads: the row takes no room.
  expect((await tray.boundingBox())?.height).toBe(0)
  const barTop = (await spaceBar.boundingBox())?.y
  const { page } = await openPage()
  await startDownloads(page, `/slow/movie.bin?size=${4 * MB}&rate=${512 * 1024}`)
  const r = row('movie.bin')
  await expect(r).toBeVisible()
  await expect(r.getByTestId('download-name')).toHaveText('movie.bin')
  const meta = r.getByTestId('download-meta')
  await expect(meta).toHaveText(/^[\d.]+ (B|KB|MB) of 4 MB · \d+ s left$/)
  const secondsLeft = async () => Number(/(\d+) s left/.exec((await meta.textContent()) ?? '')?.[1] ?? Number.NaN)
  const progress = async () => Number(await r.getByTestId('download-progress').getAttribute('aria-valuenow'))
  const firstLeft = await secondsLeft()
  const firstDone = await progress()
  expect(firstLeft).toBeGreaterThan(1)
  await expect.poll(secondsLeft, { timeout: 10_000 }).toBeLessThan(firstLeft)
  await expect.poll(progress).toBeGreaterThan(firstDone)
  // ✕: cancelled, the partial file deleted, the row gone without leaving a gap.
  await r.getByTestId('download-cancel').click()
  await expect.poll(async () => (await named('movie.bin'))?.state).toBe('cancelled')
  await expect.poll(() => readdirSync(folder())).toEqual([])
  await expect(rows()).toHaveCount(0)
  await expect.poll(async () => (await tray.boundingBox())?.height).toBe(0)
  expect((await spaceBar.boundingBox())?.y).toBe(barTop)
})

test('[DL-03] several downloads: the newest with "+N"; hovering lists them, each with its own ✕', async () => {
  const { page } = await openPage()
  await startDownloads(page, `/held/one.bin?size=${MB}`, `/held/two.bin?size=${MB}`, `/held/three.bin?size=${MB}`)
  await expect.poll(async () => (await list()).filter((d) => d.state === 'progressing').length).toBe(3)
  await expect(rows()).toHaveCount(1)
  await expect(orbit.shell.getByTestId('downloads-more')).toHaveText('+2')
  // Hovering lists all three.
  await orbit.shell.getByTestId('downloads-tray').hover()
  await expect(rows()).toHaveCount(3)
  await expect(rows().getByTestId('download-cancel')).toHaveCount(3)
  await row('two.bin').getByTestId('download-cancel').click()
  await expect(rows()).toHaveCount(2)
  await expect.poll(async () => (await named('two.bin'))?.state).toBe('cancelled')
  expect(existsSync(join(folder(), 'two.bin.crdownload'))).toBe(false)
  // Leaving folds it back to the newest; "+1" opens the list until clicked again.
  await orbit.shell.mouse.move(700, 300)
  await expect(rows()).toHaveCount(1)
  await expect(orbit.shell.getByTestId('downloads-more')).toHaveText('+1')
  await orbit.shell.getByTestId('downloads-more').click()
  await expect(rows()).toHaveCount(2)
  await orbit.shell.mouse.move(700, 300)
  await expect(rows()).toHaveCount(2)
  await orbit.shell.getByTestId('downloads-more').click()
  await orbit.shell.mouse.move(700, 300)
  await expect(rows()).toHaveCount(1)
  for (const name of ['one.bin', 'three.bin']) server.release(name)
  await expect.poll(async () => (await list()).filter((d) => d.state === 'completed').length).toBe(2)
})

test('[DL-03][DL-04] a finished download shows "done" for a few seconds; a click opens it', async () => {
  const { tabId, page } = await openPage()
  await startDownloads(page, '/file/notes.txt?size=2048')
  const r = row('notes.txt')
  await expect(r).toHaveAttribute('data-state', 'completed')
  await expect(r.getByTestId('download-meta')).toHaveText('Done · 2 KB')
  // Text opens in a tab of Orbit's own.
  await r.getByTestId('download-open').click()
  const file = pathToFileURL(join(folder(), 'notes.txt')).href
  await expect.poll(async () => (await state(orbit.app)).tabs[(await activeTabId(orbit.app)) ?? '']?.url).toBe(file)
  expect(await activeTabId(orbit.app)).not.toBe(tabId)
  // Then the row goes; the download stays in the list.
  await expect(rows()).toHaveCount(0, { timeout: 10_000 })
  expect((await named('notes.txt'))?.state).toBe('completed')
  // Anything else opens in its app.
  const tabs = await tabCount()
  await startDownloads(page, '/file/sheet.csv?size=2048')
  await row('sheet.csv').getByTestId('download-open').click()
  await expect.poll(() => hooks((h) => h.opened)).toEqual([join(folder(), 'sheet.csv')])
  expect(await tabCount()).toBe(tabs)
})

// ---- DL-15: pause, resume and retry ----

test('[DL-03][DL-15] a download cut off shows Resume, and continues where it stopped', async () => {
  const { page } = await openPage()
  await startDownloads(page, `/cut/big.bin?size=${4 * MB}`)
  const r = row('big.bin')
  await expect(r).toHaveAttribute('data-state', 'interrupted', { timeout: 15_000 })
  await expect(r.getByTestId('download-resume')).toBeVisible()
  await expect(r.getByTestId('download-meta')).toHaveText(/^Failed · /)
  expect((await entry('big.bin')).canResume).toBe(true)
  server.repair('big.bin')
  await r.getByTestId('download-resume').click()
  await expect.poll(async () => (await named('big.bin'))?.state).toBe('completed')
  // The rest came as a range, after the bytes it had.
  const ranges = server.requests('big.bin').map((q) => q.range)
  expect(ranges.at(-1)).toMatch(/^bytes=[1-9]\d*-$/)
  expect(readFileSync(join(folder(), 'big.bin')).equals(body(4 * MB))).toBe(true)
  expect(readdirSync(folder())).toEqual(['big.bin'])
})

test('[DL-15] with no way to check the rest against, a cut-off download offers Retry and starts again', async () => {
  const { page } = await openPage()
  await startDownloads(page, `/cut/plain.bin?size=${2 * MB}&plain`)
  const r = row('plain.bin')
  await expect(r).toHaveAttribute('data-state', 'interrupted', { timeout: 15_000 })
  await expect(r.getByTestId('download-retry')).toBeVisible()
  await expect(r.getByTestId('download-resume')).toHaveCount(0)
  const id = await idOf('plain.bin')
  expect(await menuOf(id)).toEqual(['Retry', 'Copy Download Link', 'Remove from List'])
  server.repair('plain.bin')
  await r.getByTestId('download-retry').click()
  await expect.poll(async () => (await named('plain.bin'))?.state).toBe('completed')
  expect(readFileSync(join(folder(), 'plain.bin')).equals(body(2 * MB))).toBe(true)
  expect((await list()).map((d) => d.filename)).toEqual(['plain.bin'])
  expect(server.requests('plain.bin').at(-1)?.range).toBeUndefined()
})

test('[DL-15] pause and resume from the row and its menu', async () => {
  const { page } = await openPage()
  await page.locator('#held').click()
  const r = row('big.bin')
  await expect.poll(async () => (await named('big.bin'))?.receivedBytes).toBe(2 * MB)
  await expect(r).toHaveAttribute('data-state', 'progressing')
  await r.click({ button: 'right' })
  await expect.poll(() => hooks((h) => h.menu())).toEqual(['Pause', 'Cancel', 'Copy Download Link'])
  await clickMenu('Pause')
  await expect(r).toHaveAttribute('data-state', 'paused')
  await expect(r.getByTestId('download-meta')).toHaveText('Paused · 2 MB of 4 MB')
  expect(await menuOf(await idOf('big.bin'))).toEqual(['Resume', 'Cancel', 'Copy Download Link'])
  // Paused, it still counts as running when quitting.
  expect(await run(orbit.app, 'downloads.active')).toBe(1)
  await r.getByTestId('download-resume').click()
  await expect(r).toHaveAttribute('data-state', 'progressing')
  server.release('big.bin')
  await expect.poll(async () => (await named('big.bin'))?.state).toBe('completed')
  expect(statSync(join(folder(), 'big.bin')).size).toBe(4 * MB)
})

test('[DL-15] a download cut off by quitting resumes after a restart', async () => {
  const { page } = await openPage()
  await page.locator('#held').click()
  await expect.poll(async () => (await named('big.bin'))?.receivedBytes).toBe(2 * MB)
  const { userData } = orbit
  await orbit.app.close()
  orbit = await launchOrbit({ userData })
  const r = row('big.bin')
  await expect(r).toHaveAttribute('data-state', 'interrupted')
  await expect(r.getByTestId('download-resume')).toBeVisible()
  // The bytes so far outlived the quit.
  const partials = readdirSync(folder()).filter((f) => f.endsWith('.crdownload'))
  expect(partials.length).toBeGreaterThan(0)
  for (const f of partials) expect(statSync(join(folder(), f)).size).toBe(2 * MB)
  expect(await named('big.bin')).toMatchObject({ state: 'interrupted', canResume: true, receivedBytes: 2 * MB })
  await r.getByTestId('download-resume').click()
  await expect.poll(async () => (await named('big.bin'))?.state).toBe('completed')
  expect(server.requests('big.bin').at(-1)?.range).toBe(`bytes=${2 * MB}-`)
  expect(readFileSync(join(folder(), 'big.bin')).equals(body(4 * MB))).toBe(true)
  expect(readdirSync(folder())).toEqual(['big.bin'])
  expect((await list()).length).toBe(1)
})

// ---- DL-04, DL-08: what can be done with a download ----

test("[DL-04] a finished download's menu opens it, shows it in its folder, copies the file and its link", async () => {
  const { page } = await openPage()
  await page.locator('#attachment').click()
  await expect.poll(async () => (await named('data.csv'))?.state).toBe('completed')
  const id = await idOf('data.csv')
  const path = join(folder(), 'data.csv')
  expect(await menuOf(id)).toEqual([
    'Open',
    SHOW_IN_FOLDER,
    'Copy File',
    'Copy Download Link',
    'Remove from List',
    'Delete File',
  ])
  await clickMenu(SHOW_IN_FOLDER)
  await expect.poll(() => hooks((h) => h.shown)).toEqual([path])
  await clickMenu('Open')
  await expect.poll(() => hooks((h) => h.opened)).toEqual([path])
  await clickMenu('Copy File')
  await expect.poll(() => orbit.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(path)
  expect(await orbit.app.evaluate(({ clipboard }) => clipboard.has('text/uri-list'))).toBe(true)
  await clickMenu('Copy Download Link')
  await expect
    .poll(() => orbit.app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe(server.url('/file/data.csv?size=4096'))
  // The row's right-click shows the same menu.
  await startDownloads(page, '/file/row.csv?size=2048')
  await row('row.csv').click({ button: 'right' })
  await expect.poll(() => hooks((h) => h.menu())).toContain('Copy File')
})

test('[DL-04] a file moved away shows "File Missing" and downloads again', async () => {
  const { page } = await openPage()
  await page.locator('#attachment').click()
  await expect.poll(async () => (await named('data.csv'))?.state).toBe('completed')
  const id = await idOf('data.csv')
  rmSync(join(folder(), 'data.csv'))
  expect(await entry('data.csv')).toMatchObject({ id, missing: true })
  expect(await run(orbit.app, 'downloads.open', { id })).toBe(false)
  expect(await menuOf(id)).toEqual(['File Missing', 'Download Again', 'Copy Download Link', 'Remove from List'])
  await clickMenu('Download Again')
  await expect.poll(async () => (await list()).map((d) => [d.filename, d.state])).toEqual([['data.csv', 'completed']])
  expect((await entry('data.csv')).missing).toBeUndefined()
  expect((await entry('data.csv')).id).not.toBe(id)
  expect(statSync(join(folder(), 'data.csv')).size).toBe(4096)
})

test('[DL-08] Remove from List keeps the file; Delete File moves it to the Trash', async () => {
  const { page } = await openPage()
  await startDownloads(page, '/file/keep.csv?size=1000', '/file/trash.csv?size=1000')
  await expect.poll(async () => (await list()).filter((d) => d.state === 'completed').length).toBe(2)
  await run(orbit.app, 'downloads.remove', { id: await idOf('keep.csv') })
  expect((await list()).map((d) => d.filename)).toEqual(['trash.csv'])
  expect(existsSync(join(folder(), 'keep.csv'))).toBe(true)
  // The Trash can't take it: the file and its entry stay, and Orbit says so.
  const id = await idOf('trash.csv')
  await orbit.app.evaluate(() => {
    ;(globalThis as unknown as { __orbitDownloads: { trashFails?: boolean } }).__orbitDownloads.trashFails = true
  })
  expect(await run(orbit.app, 'downloads.delete', { id })).toBe(false)
  await expect(
    orbit.shell.getByTestId('toast').filter({ hasText: "Couldn't move trash.csv to the Trash" }),
  ).toHaveCount(1)
  expect(existsSync(join(folder(), 'trash.csv'))).toBe(true)
  expect((await list()).map((d) => d.filename)).toEqual(['trash.csv'])
  await orbit.app.evaluate(() => {
    ;(globalThis as unknown as { __orbitDownloads: { trashFails?: boolean } }).__orbitDownloads.trashFails = false
  })
  expect(await run(orbit.app, 'downloads.delete', { id })).toBe(true)
  expect(await list()).toEqual([])
  expect(existsSync(join(folder(), 'trash.csv'))).toBe(false)
  const trash = await hooks((h) => h.trash)
  expect(readdirSync(trash).filter((f) => f.endsWith('trash.csv'))).toHaveLength(1)
})

test('[DL-08] Clear all empties the list but for running downloads; files stay, partial ones go', async () => {
  const { page } = await openPage()
  await startDownloads(page, '/file/done.csv?size=1000', `/held/running.bin?size=${MB}`, `/cut/failed.bin?size=${MB}`)
  await expect.poll(async () => (await named('done.csv'))?.state).toBe('completed')
  await expect.poll(async () => (await named('failed.bin'))?.state, { timeout: 15_000 }).toBe('interrupted')
  await expect.poll(async () => (await named('running.bin'))?.state).toBe('progressing')
  expect(await run(orbit.app, 'downloads.clear', {})).toBe(2)
  expect((await list()).map((d) => d.filename)).toEqual(['running.bin'])
  expect(existsSync(join(folder(), 'done.csv'))).toBe(true)
  await expect.poll(() => existsSync(join(folder(), 'failed.bin.crdownload'))).toBe(false)
  await expect(rows()).toHaveCount(1)
  await expect(row('running.bin')).toBeVisible()
  server.release('running.bin')
  await expect.poll(async () => (await named('running.bin'))?.state).toBe('completed')
})

// ---- DL-16: Peek, Mini Windows and private sessions ----

test('[DL-16] downloads from a Peek and a Mini Window are like any other', async () => {
  const { tabId } = await openPage()
  const tabs = await tabCount()
  await recordAnimations()
  const peek = (await run(orbit.app, 'peek.open', { url: server.url('/page/Peeked') })) as string
  const peekPage = await tabPage(orbit.app, '/page/Peeked')
  await expect(peekPage.locator('#title')).toHaveText('Peeked')
  await peekPage.locator('#attachment').click()
  await expect.poll(async () => (await named('data.csv'))?.state).toBe('completed')
  // The Peek stays open on its page; no tab was added.
  const windowId = Object.keys((await state(orbit.app)).windows)[0] as string
  expect((await state(orbit.app)).windows[windowId]?.overlay).toMatchObject({ kind: 'peek', tabId: peek })
  expect(await tabCount()).toBe(tabs + 1)
  await run(orbit.app, 'peek.close', {})
  await run(orbit.app, 'mini.open', { url: server.url('/page/Mini') })
  const miniPage = await tabPage(orbit.app, '/page/Mini')
  await expect(miniPage.locator('#title')).toHaveText('Mini')
  await startDownloads(miniPage, '/file/from-mini.csv?size=2048')
  await expect.poll(async () => (await named('from-mini.csv'))?.state).toBe('completed')
  expect((await list()).map((d) => d.filename)).toEqual(['from-mini.csv', 'data.csv'])
  // A Mini Window has no sidebar: the main window shows each start.
  await expect.poll(async () => (await animations('download-flight')).length).toBe(2)
  expect(await activeTabId(orbit.app)).toBe(tabId)
})

test("[DL-16] a private session's downloads are in no saved list, and leave when its pages close", async () => {
  // A profile on a non-persistent session behaves like a private window.
  const priv = (await run(orbit.app, 'profiles.create', { name: 'Private' })) as string
  await orbit.app.evaluate((_e, p) => {
    const { ctx } = (globalThis as unknown as { __orbit: { ctx: MainContext } }).__orbit
    ctx.store.update((d) => {
      const profile = d.profiles[p]
      if (profile) profile.partition = `orbit-private-${p}`
    })
  }, priv)
  const normal = (await state(orbit.app)).windows[Object.keys((await state(orbit.app)).windows)[0] as string]
    ?.spaceId as string
  const spaceId = (await run(orbit.app, 'spaces.create', {
    name: 'Private',
    profileId: priv,
    activate: true,
  })) as string
  const tabId = (await run(orbit.app, 'tabs.create', { url: server.url('/page/Secret'), spaceId })) as string
  const page = await tabPage(orbit.app, '/page/Secret')
  await page.locator('#held').click()
  await expect.poll(async () => (await list(priv)).map((d) => [d.filename, d.private])).toEqual([['big.bin', true]])
  // Its row shows beside its own profile only.
  await expect(row('big.bin')).toBeVisible()
  await run(orbit.app, 'spaces.switch', { spaceId: normal })
  await expect(rows()).toHaveCount(0)
  await run(orbit.app, 'spaces.switch', { spaceId })
  await expect(row('big.bin')).toBeVisible()
  server.release('big.bin')
  await expect.poll(async () => (await list(priv))[0]?.state).toBe('completed')
  // Saved to disk like any other, but in no list on disk.
  expect(statSync(join(folder(), 'big.bin')).size).toBe(4 * MB)
  await hooks((h) => h.settle())
  const saved = join(orbit.userData, 'downloads.json')
  expect(existsSync(saved) ? readFileSync(saved, 'utf8') : '').not.toContain('big.bin')
  // Its pages close: its list empties; the file stays.
  await run(orbit.app, 'tabs.close', { tabId })
  await expect.poll(async () => list(priv)).toEqual([])
  expect(existsSync(join(folder(), 'big.bin'))).toBe(true)
})
