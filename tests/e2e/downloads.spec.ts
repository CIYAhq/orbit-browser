import { existsSync, readdirSync, statSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import type { Download, OrbitState } from '../../src/shared/state'
import { activeTabId, launchOrbit, listenInRange, type Orbit, run, state, tabPage } from './helpers'

/**
 * Downloads (DL). A local server sends the files: `/file/<name>?size=` at once, `/held/<name>?size=`
 * half at once and the rest when the test releases it.
 */

const MB = 1024 * 1024

interface DownloadServer {
  url: (path: string) => string
  /** Sends the rest of a held file. */
  release: (name: string) => void
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
    if (kind === 'file' || kind === 'held') {
      const data = body(size)
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(size),
        'content-disposition': `attachment; filename="${name}"`,
      })
      if (kind === 'file') {
        res.end(data)
        return
      }
      open.add(res)
      res.on('close', () => open.delete(res))
      const half = Math.floor(size / 2)
      res.write(data.subarray(0, half))
      const finish = () => {
        held.delete(name)
        if (!res.destroyed) res.end(data.subarray(half))
      }
      if (released.has(name)) finish()
      else held.set(name, finish)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  const port = await listenInRange(server, 3300 + (Number(process.env.TEST_PARALLEL_INDEX ?? 0) % 50))
  return {
    url: (path) => `http://localhost:${(server.address() as AddressInfo).port || port}${path}`,
    release: (name) => {
      released.add(name)
      held.get(name)?.()
    },
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
  expect(
    await orbit.app.evaluate(
      () => (globalThis as unknown as { __orbit: { windowIds: () => string[] } }).__orbit.windowIds().length,
    ),
  ).toBe(1)
  expect((await named('big.bin'))?.state).toBe('progressing')
  // "Quit": it quits (app.close() fails the test if it doesn't).
  await answer('quit')
  await orbit.app.close()
})
