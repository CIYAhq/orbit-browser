import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { type ElectronApplication, expect, type Page } from '@playwright/test'
import { FIXTURE_ROOT } from '../../scripts/import-fixtures'
import type { BookmarkNode, ImportJob } from '../../src/shared/commands/import'
import type { ItemId, OrbitState } from '../../src/shared/state'
import { splitLeaves } from '../../src/shared/tree'
import { launchOrbit, listenInRange, type Orbit, run } from './helpers'
import { pageOfView } from './settings-support'

/** Import (IM-*) test support. Every launch names the fixture places Orbit may search (never the real ones). */

export const fixturePath = (...parts: string[]) => join(FIXTURE_ROOT, ...parts)

/** Launches Orbit with these browser places (none by default: `[]` searches nowhere). */
export function launchImport(
  opts: { places?: { browser: string; dir: string }[]; userData?: string; env?: Record<string, string> } = {},
): Promise<Orbit> {
  return launchOrbit({
    userData: opts.userData,
    env: { ORBIT_IMPORT_PLACES: JSON.stringify(opts.places ?? []), ...opts.env },
  })
}

/** The import window's page, drawn. */
export async function importPage(app: ElectronApplication): Promise<Page> {
  const page = await pageOfView(app, 'import')
  await expect(page.getByTestId('import-flow')).toBeVisible()
  return page
}

/** Opens the import window from the first browser window. */
export async function openImport(app: ElectronApplication, start?: unknown): Promise<Page> {
  await run(app, 'import.open', start ? { start } : {})
  return importPage(app)
}

/** Clicks Done, which closes the import window: the click can still be finishing as the window goes. */
export async function clickDone(page: Page): Promise<void> {
  const closed = page.waitForEvent('close')
  await page
    .getByTestId('import-done')
    .click()
    .catch((err: unknown) => {
      if (!page.isClosed()) throw err
    })
  await closed
}

/** Drops a file on an element the way the OS does (a DataTransfer with the file in it). */
export async function dropFile(
  page: Page,
  selector: string,
  file: { name: string; text: string; type?: string },
  extra: Record<string, string> = {},
): Promise<void> {
  await page.locator(selector).first().waitFor()
  await page.evaluate(
    ({ selector, file, extra }) => {
      const target = document.querySelector(selector) as HTMLElement
      const data = new DataTransfer()
      data.items.add(new File([file.text], file.name, { type: file.type ?? 'text/html' }))
      for (const [type, value] of Object.entries(extra)) data.setData(type, value)
      const rect = target.getBoundingClientRect()
      const at = { clientX: rect.left + rect.width / 2, clientY: rect.top + Math.min(rect.height / 2, 40) }
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true, ...at }))
      }
    },
    { selector, file, extra },
  )
}

/** Drops a file of `bytes` bytes, made in the page (too large to send from the test), on an element. */
export async function dropLargeFile(page: Page, selector: string, name: string, bytes: number): Promise<void> {
  await page.locator(selector).first().waitFor()
  await page.evaluate(
    ({ selector, name, bytes }) => {
      const target = document.querySelector(selector) as HTMLElement
      const data = new DataTransfer()
      data.items.add(new File([new Uint8Array(bytes).fill(0x61)], name, { type: 'text/html' }))
      const rect = target.getBoundingClientRect()
      const at = { clientX: rect.left + rect.width / 2, clientY: rect.top + Math.min(rect.height / 2, 40) }
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true, ...at }))
      }
    },
    { selector, name, bytes },
  )
}

/**
 * Drops a file made in the page (too large to send from the test) on an element: `head`, then `unit` repeated in parts
 * of about 1 MB until it holds at least `bytes`. `beforeDrop` runs once the file is made, just before it's dropped (to
 * start measuring there). Returns how many times `unit` is in it.
 */
export async function dropMadeFile(
  page: Page,
  selector: string,
  file: { name: string; type: string; head?: string; unit: string; bytes: number },
  beforeDrop?: () => Promise<void>,
): Promise<number> {
  await page.locator(selector).first().waitFor()
  const units = await page.evaluate((file) => {
    const each = Math.max(1, Math.floor(1_048_576 / file.unit.length))
    const part = file.unit.repeat(each)
    const parts = Math.ceil(file.bytes / part.length)
    const made = new File([file.head ?? '', ...Array(parts).fill(part)], file.name, { type: file.type })
    ;(window as unknown as { __madeFile?: File }).__madeFile = made
    return parts * each
  }, file)
  await beforeDrop?.()
  await page.evaluate((selector) => {
    const target = document.querySelector(selector) as HTMLElement
    const holder = window as unknown as { __madeFile?: File }
    const data = new DataTransfer()
    data.items.add(holder.__madeFile as File)
    holder.__madeFile = undefined
    const rect = target.getBoundingClientRect()
    const at = { clientX: rect.left + rect.width / 2, clientY: rect.top + Math.min(rect.height / 2, 40) }
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true, ...at }))
    }
  }, selector)
  return units
}

/** The import window's renderer process, or 0 when it isn't open. */
export function importWindowPid(app: ElectronApplication): Promise<number> {
  return app.evaluate(
    ({ webContents }) =>
      webContents
        .getAllWebContents()
        .find((w) => w.getURL().includes('view=import'))
        ?.getOSProcessId() ?? 0,
  )
}

/** A process's resident memory in MB (Linux, from /proc): now, and its peak since it started. */
export function memoryMb(pid: number): { now: number; peak: number } {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8')
  const mb = (key: string) => Math.round(Number(new RegExp(`${key}:\\s+(\\d+) kB`).exec(status)?.[1] ?? 0) / 1024)
  return { now: mb('VmRSS'), peak: mb('VmHWM') }
}

/**
 * Watches a process's memory while a test waits: past `limitMb` it's stopped at once, so a run that goes wrong can't
 * take the machine (the fix check saw a window pass 8 GB). Returns a stop function, which gives the MB it was stopped
 * at (0 if it wasn't).
 */
export function guardMemory(pid: number, limitMb: number): () => number {
  let stoppedAt = 0
  const timer = setInterval(() => {
    try {
      const { now } = memoryMb(pid)
      if (now <= limitMb) return
      stoppedAt = now
      clearInterval(timer)
      process.kill(pid, 'SIGKILL')
    } catch {
      clearInterval(timer)
    }
  }, 50)
  return () => {
    clearInterval(timer)
    return stoppedAt
  }
}

/** Closes the import window, if it's open, and waits until it's gone. */
export async function closeImport(app: ElectronApplication): Promise<void> {
  const page = app.windows().find((p) => p.url().includes('view=import') && !p.isClosed())
  if (!page) return
  const closed = page.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('view=import')) w.close()
  })
  await closed
}

/**
 * The pages loaded in any web contents: every address that isn't Orbit's own UI (its views are
 * created as they're first needed, so their number changes on its own).
 */
export function pagesLoaded(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .map((w) => w.getURL())
      .filter((url) => url !== '' && !/\/renderer\/index\.html\?view=/.test(url)),
  )
}

/** Makes the next "From a file…" pick `path` instead of showing the system's dialog. */
export async function pickFileNext(app: ElectronApplication, path: string | null): Promise<void> {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () =>
      picked ? { canceled: false, filePaths: [picked] } : { canceled: true, filePaths: [] }) as never
  }, path)
}

/** A loopback server that answers every page and remembers each request (to prove nothing loaded). */
export async function loggedServer(): Promise<{
  url: (path: string) => string
  requests: string[]
  close: () => Promise<void>
}> {
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<!doctype html><title>${req.url}</title><h1>${req.url}</h1>`)
  })
  // This lane's ports: 3350 to 3369, one per parallel worker.
  const port = await listenInRange(server, 3350 + (Number(process.env.TEST_PARALLEL_INDEX ?? 0) % 20))
  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  }
}

/** A Space's pinned items as names: folders as { name: [...] }, tabs as "pinned title <pinned URL>". */
export function pinnedShape(s: OrbitState, ids: readonly string[]): unknown[] {
  return ids.map((id) => {
    const f = s.folders[id]
    if (f) return { [f.name]: pinnedShape(s, f.children) }
    const t = s.tabs[id]
    return `${t?.pinnedTitle ?? t?.title} <${t?.pinnedUrl}>`
  })
}

/** Every tab under a folder. */
export function tabsUnder(s: OrbitState, id: string): OrbitState['tabs'][string][] {
  const f = s.folders[id]
  if (!f) return s.tabs[id] ? [s.tabs[id]] : []
  return f.children.flatMap((c) => tabsUnder(s, c))
}

/** `folders` folders of `size` bookmarks each ("Folder 1" holds "Page 1"…), at addresses that are never loaded. */
export function inFolders(folders: number, size: number): BookmarkNode[] {
  return Array.from({ length: folders }, (_, f) => ({
    id: `f${f}`,
    title: `Folder ${f + 1}`,
    children: Array.from({ length: size }, (_, i) => ({
      id: `b${f}-${i}`,
      title: `Page ${i + 1}`,
      url: `https://example.com/page/f${f + 1}/p${i + 1}`,
    })),
  }))
}

/** The tabs of `inFolders`' bookmarks in a state, wherever they are. */
export function importedTabs(s: OrbitState): OrbitState['tabs'][string][] {
  return Object.values(s.tabs).filter((t) => t.pinnedUrl?.startsWith('https://example.com/page/'))
}

/** The next import stops adding once `at` bookmarks are made, until `resumeAdding` or the quit (an e2e hook). */
export async function holdAddingAt(app: ElectronApplication, at: number): Promise<void> {
  await app.evaluate((_electron, n) => {
    const hooks = (globalThis as unknown as { __orbitImport: { holdAddingAt: (n: number) => void } }).__orbitImport
    hooks.holdAddingAt(n)
  }, at)
}

/** A held import goes on, to its end. */
export async function resumeAdding(app: ElectronApplication): Promise<void> {
  await app.evaluate(() =>
    (globalThis as unknown as { __orbitImport: { resumeAdding: () => void } }).__orbitImport.resumeAdding(),
  )
}

/** Waits until the latest import is adding and has made `n` bookmarks; returns how many it has. */
export async function untilMade(app: ElectronApplication, n: number): Promise<number> {
  let made = 0
  await expect
    .poll(
      async () => {
        const job = (await run(app, 'import.status', {})) as ImportJob
        made = job.items[0]?.done ?? 0
        return job.phase === 'adding' && made >= n
      },
      { intervals: [10], timeout: 60_000 },
    )
    .toBe(true)
  return made
}

/** Every place in the sidebar that lists `id`: Favorites, a pinned or Today section, a folder, a split view. */
export function placesOf(s: OrbitState, id: ItemId): string[] {
  const places: string[] = []
  for (const [profileId, p] of Object.entries(s.profiles)) {
    if (p.favorites.includes(id)) places.push(`favorites ${profileId}`)
  }
  for (const sp of Object.values(s.spaces)) {
    if (sp.pinned.includes(id)) places.push(`pinned ${sp.name}`)
    if (sp.today.includes(id)) places.push(`today ${sp.name}`)
  }
  for (const f of Object.values(s.folders)) if (f.children.includes(id)) places.push(`folder ${f.name}`)
  for (const [splitId, split] of Object.entries(s.splits)) {
    if (splitLeaves(split.layout).includes(id)) places.push(`split ${splitId}`)
  }
  return places
}

/** Ids the sidebar lists that nothing is behind: in Favorites, the sections, folders and split views. */
export function danglingIds(s: OrbitState): string[] {
  const exists = (id: string) => !!(s.tabs[id] || s.folders[id] || s.splits[id])
  const listed = [
    ...Object.values(s.profiles).flatMap((p) => p.favorites),
    ...Object.values(s.spaces).flatMap((sp) => [...sp.pinned, ...sp.today]),
    ...Object.values(s.folders).flatMap((f) => f.children),
    ...Object.values(s.splits).flatMap((split) => splitLeaves(split.layout)),
  ]
  return listed.filter((id) => !exists(id))
}

/** Starts measuring the main process's longest stall (event-loop delay), in ms. */
export async function startMainLag(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const { monitorEventLoopDelay } = process.getBuiltinModule('node:perf_hooks') as typeof import('node:perf_hooks')
    const lag = monitorEventLoopDelay({ resolution: 5 })
    lag.enable()
    ;(globalThis as unknown as { __importLag: typeof lag }).__importLag = lag
  })
}

/** The longest main-process stall since startMainLag, in ms. */
export function mainLagMs(app: ElectronApplication): Promise<number> {
  return app.evaluate(async () => {
    const lag = (
      globalThis as unknown as { __importLag: ReturnType<typeof import('node:perf_hooks').monitorEventLoopDelay> }
    ).__importLag
    await new Promise((resolve) => setTimeout(resolve, 20))
    lag.disable()
    return Math.round(lag.max / 1e6)
  })
}
