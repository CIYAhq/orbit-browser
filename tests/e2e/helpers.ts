import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, type Page } from '@playwright/test'
import type { OrbitState } from '../../src/shared/state'

export const isMac = process.platform === 'darwin'
/** Primary modifier for shortcuts: Cmd on macOS, Ctrl elsewhere. */
export const MOD = isMac ? 'Meta' : 'Control'
/**
 * Frame-timed budgets (keystroke → painted, open → painted) hold on Linux CI and dev machines. The
 * macOS CI runner is a VM without a GPU where one frame can take 100–200 ms, so there they only catch
 * pathological regressions (D17). Budgets that don't wait for a frame are never scaled.
 */
export const FRAME_SLACK = process.env.CI && isMac ? 8 : 1

export interface Orbit {
  app: ElectronApplication
  shell: Page
  userData: string
  /**
   * Takes what the main process has logged about exceptions nothing caught. A test that throws one on
   * purpose checks it here; `app.close()` then doesn't fail the test for it (D28).
   */
  takeUncaught: () => string
}

/**
 * Tests stay offline. Orbit runs behind a dead local proxy, which loopback (where the fixture pages
 * are served) bypasses, so a search or a link to a real site gets its URL but loads nothing.
 */
const DEAD_PROXY = '127.0.0.1:9'
const OFFLINE = `--proxy-server=http://${DEAD_PROXY}`

/** Launches the built app (out/) with an isolated profile directory. */
export async function launchOrbit(opts: { userData?: string; env?: Record<string, string> } = {}): Promise<Orbit> {
  const userData = opts.userData ?? mkdtempSync(join(tmpdir(), 'orbit-e2e-'))
  const args = [OFFLINE, resolve('out/main/index.js')]
  // Linux CI/dev boxes often lack the setuid sandbox helper; macOS runs fully sandboxed.
  if (process.platform === 'linux') args.unshift('--no-sandbox')
  const app = await electron.launch({
    args,
    env: { ...process.env, ORBIT_E2E: '1', ORBIT_USER_DATA: userData, ...opts.env } as Record<string, string>,
  })
  evaluateBetweenTasks(app)
  const takeUncaught = checkQuit(app)
  const shell = await viewPage(app, 'shell')
  await shell.getByTestId('sidebar').waitFor()
  await waitOffline(app)
  return { app, shell, userData, takeUncaught }
}

/**
 * Waits until every profile's session sends web requests to the dead proxy. A session picks up the
 * command line's proxy a moment after it's made: here, about 50 ms after the sidebar shows.
 */
async function waitOffline(app: ElectronApplication): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const routes = await app.evaluate(async ({ session }) => {
      const { profiles } = (globalThis as unknown as { __orbit: { state: () => OrbitState } }).__orbit.state()
      const sessions = [
        session.defaultSession,
        ...Object.values(profiles).map((p) => session.fromPartition(p.partition)),
      ]
      return Promise.all(sessions.map((s) => s.resolveProxy('https://example.com/')))
    })
    if (routes.every((r) => r === `PROXY ${DEAD_PROXY}`)) return
    if (Date.now() > deadline) throw new Error(`Orbit would reach the network: ${routes.join(', ')}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

/**
 * Playwright runs main-process evaluates through the inspector, which can interrupt main-process
 * code part-way, even inside a store update. A change made there is lost when that update finishes:
 * a background tab a test had just created vanished. Each evaluate starts in a task of its own instead.
 */
export function evaluateBetweenTasks(app: ElectronApplication): void {
  const evaluate = app.evaluate.bind(app)
  app.evaluate = ((fn: unknown, arg?: unknown) => {
    if (typeof fn !== 'function') return evaluate(fn as never, arg as never)
    return evaluate(
      async (electron, [source, a]) => {
        await new Promise((resolve) => setImmediate(resolve))
        return new Function(`return (${source})`)()(electron, a)
      },
      [fn.toString(), arg] as const,
    )
  }) as ElectronApplication['evaluate']
}

/** How Orbit's main process logs an exception nothing caught (src/main/index.ts). */
const UNCAUGHT = '[orbit] uncaught exception:'

/**
 * `app.close()` checks the quit too. The test fails if Orbit's main process logged an exception
 * nothing caught, even one thrown while quitting. If Orbit still hasn't quit 15 s after being asked,
 * the test fails and Orbit is killed, so one stuck quit can't hang the rest of the run (D28).
 */
export function checkQuit(app: ElectronApplication): () => string {
  const proc = app.process()
  let recent = ''
  let thrown = ''
  proc.stderr?.on('data', (chunk) => {
    if (thrown) {
      if (thrown.length < 4000) thrown += String(chunk)
      return
    }
    // Look for the marker before trimming: one write can be longer than what is kept. The tail
    // kept is just long enough to find a marker split across two writes.
    const text = recent + String(chunk)
    const at = text.indexOf(UNCAUGHT)
    if (at >= 0) thrown = text.slice(at, at + 4000)
    else recent = text.slice(-UNCAUGHT.length)
  })
  const outputDone = new Promise((resolve) => (proc.stderr ? proc.stderr.once('close', resolve) : resolve(null)))
  const close = app.close.bind(app)
  let checked = false
  app.close = async () => {
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<true>((resolve) => {
      timer = setTimeout(() => resolve(true), 15_000)
    })
    const closed = close()
    const stuck = await Promise.race([closed.then(() => false), late])
    clearTimeout(timer)
    if (checked) return
    checked = true
    if (stuck) {
      const waiting = mainThreadWait(proc.pid)
      proc.kill('SIGKILL')
      await closed
      expect.soft(`still running (main thread: ${waiting})`, 'Orbit 15 s after app.close(); it was killed').toBe('quit')
    }
    await Promise.race([outputDone, new Promise((resolve) => setTimeout(resolve, 1000))])
    expect.soft(thrown, "Orbit's main process threw an exception nothing caught").toBe('')
  }
  return () => {
    const taken = thrown
    thrown = ''
    recent = ''
    return taken
  }
}

/** Where a process's main thread is waiting in the kernel (Linux only). */
function mainThreadWait(pid: number | undefined): string {
  try {
    return readFileSync(`/proc/${pid}/wchan`, 'utf8')
  } catch {
    return 'unknown'
  }
}

/** Finds an Orbit UI page (shell/overlay) by its ?view= query. */
export async function viewPage(app: ElectronApplication, view: 'shell' | 'overlay'): Promise<Page> {
  const match = (p: Page) => p.url().includes(`view=${view}`)
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const found = app.windows().find(match)
    if (found) return found
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`No ${view} page`)
}

/** Finds the web page (tab contents) currently showing a URL that matches. */
export async function tabPage(app: ElectronApplication, urlPart: string): Promise<Page> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const found = app.windows().find((p) => p.url().includes(urlPart) && !p.url().includes('view='))
    if (found) return found
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`No tab page with ${urlPart}`)
}

export function state(app: ElectronApplication): Promise<OrbitState> {
  return app.evaluate(() => (globalThis as unknown as { __orbit: { state: () => OrbitState } }).__orbit.state())
}

export async function run(app: ElectronApplication, name: string, args: unknown = {}): Promise<unknown> {
  return app.evaluate(
    async (_electron, [n, a]) => {
      const hooks = (globalThis as unknown as { __orbit: { run: (n: string, a: unknown, w?: string) => unknown } })
        .__orbit
      const ctx = (globalThis as unknown as { __orbit: { windowIds: () => string[] } }).__orbit
      return hooks.run(n, a, ctx.windowIds()[0])
    },
    [name, args] as const,
  )
}

export async function action(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(async (_electron, actionId) => {
    const hooks = (
      globalThis as unknown as {
        __orbit: { action: (id: string, w?: string) => Promise<void>; windowIds: () => string[] }
      }
    ).__orbit
    await hooks.action(actionId, hooks.windowIds()[0])
  }, id)
}

export async function tabView(app: ElectronApplication, tabId: string) {
  return app.evaluate(
    (_electron, id) =>
      (
        globalThis as unknown as {
          __orbit: {
            tabView: (id: string) => {
              bounds: { x: number; y: number; width: number; height: number }
              visible: boolean
              url: string
            } | null
          }
        }
      ).__orbit.tabView(id),
    tabId,
  )
}

/** Opens a URL in a new tab through the real command bar UI. */
export async function openViaCommandBar(orbit: Orbit, text: string): Promise<void> {
  await orbit.shell.keyboard.press(`${MOD}+T`)
  const overlay = await viewPage(orbit.app, 'overlay')
  const input = overlay.getByTestId('command-input')
  await expect(input).toBeFocused()
  await input.fill(text)
  // Wait for rows that answer what was typed: a row left from an earlier query (say, "switch to"
  // a recent tab) must not be the one Enter opens.
  await expect(overlay.getByTestId('command-result').filter({ hasText: text }).first()).toBeVisible()
  await input.press('Enter')
}

export async function activeTabId(app: ElectronApplication): Promise<string | null> {
  const s = await state(app)
  const win = Object.values(s.windows)[0]
  return win ? (win.activeTab[win.spaceId] ?? null) : null
}

// ---- Local fixture web server (ports 3300-3399 are reserved for this project) ----

export interface Fixtures {
  url: (path: string) => string
  close: () => Promise<void>
}

const PAGE = (title: string, body: string, color = '#f4f0ff') => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='7' fill='%236b7cff'/%3E%3C/svg%3E">
<style>body{font:16px system-ui;background:${color};margin:0;padding:40px}a{color:#3b4bdb}</style></head>
<body>${body}</body></html>`

export async function startFixtures(): Promise<Fixtures> {
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost')
    const name = u.pathname.split('/').filter(Boolean).pop() ?? 'index'
    if (u.pathname.startsWith('/page/')) {
      const title = decodeURIComponent(name)
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(
        PAGE(
          title,
          `<h1 id="title">${title}</h1>
           <p><a id="next" href="/page/${title}-next">Next page</a></p>
           <p><a id="external" href="http://127.0.0.1:${(server.address() as AddressInfo).port}/page/External" target="_blank">External link</a></p>
           <div style="height:3000px"></div>`,
          u.searchParams.get('bg') ?? '#f4f0ff',
        ),
      )
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  const port = await listenInRange(server, 3300 + (Number(process.env.TEST_PARALLEL_INDEX ?? 0) % 50))
  return {
    url: (path) => `http://localhost:${port}${path}`,
    close: () => new Promise((r) => server.close(() => r())),
  }
}

/**
 * Listens on loopback at the first free port from `base` up: Orbit keeps to ports 3300–3399 (the
 * brief's range), and several suites or agents may be using some of them at once.
 */
export function listenInRange(server: Server, base = 3300): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = base
    const retry = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && port < 3399) server.listen(++port, '127.0.0.1')
      else reject(err)
    }
    server.on('error', retry)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', retry)
      resolve(port)
    })
  })
}
