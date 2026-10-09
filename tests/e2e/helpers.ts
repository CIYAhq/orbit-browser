import { mkdtempSync } from 'node:fs'
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
}

/**
 * Launches the built app (out/) with an isolated profile directory. `args` are extra Chromium
 * switches (e.g. `--host-resolver-rules` to give the local fixture server another host name).
 */
export async function launchOrbit(
  opts: { userData?: string; env?: Record<string, string>; args?: string[] } = {},
): Promise<Orbit> {
  const userData = opts.userData ?? mkdtempSync(join(tmpdir(), 'orbit-e2e-'))
  const args = [...(opts.args ?? []), resolve('out/main/index.js')]
  // Linux CI/dev boxes often lack the setuid sandbox helper; macOS runs fully sandboxed.
  if (process.platform === 'linux') args.unshift('--no-sandbox')
  const app = await electron.launch({
    args,
    env: { ...process.env, ORBIT_E2E: '1', ORBIT_USER_DATA: userData, ...opts.env } as Record<string, string>,
  })
  const shell = await viewPage(app, 'shell')
  // Attached rather than visible: a window restored with its sidebar hidden (SB-11) has one too.
  await shell.getByTestId('sidebar').waitFor({ state: 'attached' })
  return { app, shell, userData }
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
  const base = 3300 + (Number(process.env.TEST_PARALLEL_INDEX ?? 0) % 50)
  await new Promise<void>((resolveListen, reject) => {
    let port = base
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && port < 3399) server.listen(++port, '127.0.0.1')
      else reject(err)
    })
    server.listen(port, '127.0.0.1', () => resolveListen())
  })
  const { port } = server.address() as AddressInfo
  return {
    url: (path) => `http://localhost:${port}${path}`,
    close: () => new Promise((r) => server.close(() => r())),
  }
}
