import { createServer } from 'node:http'
import { join } from 'node:path'
import { type ElectronApplication, expect, type Page } from '@playwright/test'
import { FIXTURE_ROOT } from '../../scripts/import-fixtures'
import type { OrbitState } from '../../src/shared/state'
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
  const port = await listenInRange(server, 3380 + (Number(process.env.TEST_PARALLEL_INDEX ?? 0) % 10))
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
