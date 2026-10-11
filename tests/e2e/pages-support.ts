/**
 * Helpers for the pages lane's e2e specs (pages*.spec.ts): fixture pages that ask things of the
 * user or fail to load, and handles on Orbit's page dialogs (NV-24) and on what a page's area shows
 * when its page couldn't load or crashed (NV-13, NV-14). Builds on helpers.ts.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import type { PageDialogInfo } from '../../src/main/pages/dialogs'
import type { FullScreenInfo } from '../../src/main/pages/fullscreen'
import type { LeaveInfo } from '../../src/main/pages/leave'
import type { PrintInfo, PrintRecord } from '../../src/main/pages/print'
import type { PageScreenInfo } from '../../src/main/pages/screens'
import type { SwipeInfo } from '../../src/main/pages/swipe'
import { listenInRange, tabPage } from './helpers'
import { clickInPage } from './nav-support'

export interface PagesFixtures {
  port: number
  url: (path: string) => string
  /** Requests the server saw, newest last (method and path). */
  seen: () => string[]
  close: () => Promise<void>
}

/** The sign-in fixture's account. */
export const AUTH_USER = 'orbit'
export const AUTH_PASSWORD = 'secret word'

/** Every fixture page's icon, so a test can see a row keep it. */
export const PAGE_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='4' fill='%23d2691e'/%3E%3C/svg%3E"

const html = (title: string, body: string, head = '') => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title><link rel="icon" href="${PAGE_ICON}">${head}
<style>body{font:16px system-ui;margin:0;padding:24px;background:#f6f3ee}button,a{font:inherit}
#area{height:600px;background:#e8e2d8}</style></head><body>${body}</body></html>`

/**
 * - `/ask?kind=alert|confirm|prompt&msg=…&value=…&on=click|load`: asks once (on a click of `#ask`, or
 *   as soon as it loads) and writes what the call returned to `#result` (JSON) and the title.
 * - `/warn`: warns before it goes (`beforeunload`), with a link (`#away`), a form (`#form`) and an
 *   area to click for a user gesture (`#area`); `window.__clicks` counts the presses it got.
 * - `/framed?src=…`: a page with a frame (`#frame`, 520 × 320) loading `src` (`/warn` by default)
 *   and an area of its own (`#area`).
 * - `/going`: asks `confirm` in its `beforeunload` and `prompt` in its `pagehide`, and sends what they
 *   returned to `/beacon?at=…&r=…` (JSON); a link (`#away`) and an area to click (`#area`).
 * - `/auth`: HTTP Basic sign-in (AUTH_USER, AUTH_PASSWORD).
 * - `/page/<name>`: a plain page.
 * - `/opener?to=…`: opens `to` in a pop-up window on a click of `#open`.
 * - `/upload?to=…`: a form (`#form`) that posts to `to`.
 * - `/apps?frame=…`: links to other apps (NV-19): `#mail` (mailto:), `#call` (tel:), `#mail-tab`
 *   (mailto: in a new tab), `#app-tab` (a new tab that redirects to zoommtg:), `#pop` (a pop-up
 *   window for mailto:), and an `#frame` loading `frame` (`/app-frame`: a `#frame-mail` link).
 * - `/to-app?to=…`: redirects to `to`.
 * - `/esc?prevent=1`: notes each Escape it gets in `window.__escapes` (`keydown`, `keydown (repeat)`,
 *   `keyup`), and with `prevent=1` uses it (`preventDefault`), as a web app closing its own menu does.
 * - `/print`: a few pages long, with a field (`#field`), a button that calls `window.print()`
 *   (`#print`), and `window.__print`: its `beforeprint` and `afterprint` events, whether `print()`
 *   returned, and how many times the tab has loaded it (`loads`).
 * - `/swipe`: a strip that scrolls sideways (`#strip`, scrolled to its middle), and an area that uses
 *   the wheel itself (`#grab`, preventDefault), as a map does.
 *
 * Every page has an icon (PAGE_ICON). `port` listens on that port only (a server back on the port
 * it left).
 */
export async function startPagesFixtures(base = 3340, opts: { port?: number } = {}): Promise<PagesFixtures> {
  const seen: string[] = []
  const server: Server = createServer(pagesHandler(seen))
  const port = opts.port ? await listenOn(server, opts.port) : await listenInRange(server, base)
  return {
    port,
    url: (path) => `http://localhost:${port}${path}`,
    seen: () => [...seen],
    close: () => closeServer(server),
  }
}

/** Listens on loopback at exactly `port`. */
function listenOn(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(port)
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

/** The fixture pages' answers, for the plain and the secure server alike. */
function pagesHandler(seen: string[]): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost')
    seen.push(`${req.method} ${u.pathname}${u.search}`)
    const send = (body: string, status = 200, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers })
      res.end(body)
    }
    if (u.pathname === '/ask') {
      const kind = u.searchParams.get('kind') ?? 'confirm'
      const msg = u.searchParams.get('msg') ?? 'Are you sure?'
      const value = u.searchParams.get('value') ?? ''
      const on = u.searchParams.get('on') ?? 'click'
      const call =
        kind === 'alert'
          ? `alert(${JSON.stringify(msg)})`
          : kind === 'prompt'
            ? `prompt(${JSON.stringify(msg)}, ${JSON.stringify(value)})`
            : `confirm(${JSON.stringify(msg)})`
      send(
        html(
          'Ask',
          `<button id="ask">Ask</button><output id="result">none</output><div id="area"></div>
<script>
function ask() {
  const r = ${call}
  const text = r === undefined ? 'undefined' : JSON.stringify(r)
  document.getElementById('result').textContent = text
  document.title = 'Answered ' + text
}
document.getElementById('ask').addEventListener('click', ask)
${on === 'load' ? "addEventListener('load', () => setTimeout(ask, 0))" : ''}
</script>`,
        ),
      )
      return
    }
    if (u.pathname === '/warn') {
      send(
        html(
          'Warns',
          `<p><a id="away" href="/page/Away">Away</a></p>
<form id="form" method="post" action="/posted"><input name="note" value="draft"><button id="send">Send</button></form>
<div id="area"></div>
<script>addEventListener('beforeunload', (e) => { e.preventDefault() })
addEventListener('pointerdown', () => { window.__clicks = (window.__clicks || 0) + 1 })</script>`,
        ),
      )
      return
    }
    if (u.pathname === '/going') {
      send(
        html(
          'Going',
          `<p><a id="away" href="/page/Away">Away</a></p><div id="area"></div>
<script>
const note = (at, r) => navigator.sendBeacon('/beacon?at=' + at + '&r=' + encodeURIComponent(JSON.stringify(r)))
addEventListener('beforeunload', () => note('beforeunload', confirm('Stay?')))
addEventListener('pagehide', () => note('pagehide', prompt('Your name?', 'Ada')))
</script>`,
        ),
      )
      return
    }
    if (u.pathname === '/beacon') {
      res.writeHead(204)
      res.end()
      return
    }
    if (u.pathname === '/posted') {
      send(html('Posted', '<h1>Posted</h1>'))
      return
    }
    if (u.pathname === '/auth') {
      const expected = `Basic ${Buffer.from(`${AUTH_USER}:${AUTH_PASSWORD}`).toString('base64')}`
      if (req.headers.authorization === expected) send(html('Signed in', `<h1 id="who">Signed in as ${AUTH_USER}</h1>`))
      else send(html('No entry', '<h1 id="who">No entry</h1>'), 401, { 'www-authenticate': 'Basic realm="Orbit test"' })
      return
    }
    if (u.pathname === '/opener') {
      const to = u.searchParams.get('to') ?? '/page/Popup'
      send(
        html(
          'Opener',
          `<button id="open">Open</button><div id="area"></div>
<script>document.getElementById('open').addEventListener('click', () => {
  window.open(${JSON.stringify(to)}, 'popup', 'popup,width=520,height=420')
})</script>`,
        ),
      )
      return
    }
    if (u.pathname === '/esc') {
      const prevent = u.searchParams.get('prevent') === '1'
      send(
        html(
          'Esc',
          `<h1>Esc</h1><div id="area"></div>
<script>
window.__escapes = []
for (const type of ['keydown', 'keyup']) {
  addEventListener(type, (e) => {
    if (e.key !== 'Escape') return
    window.__escapes.push(type + (e.repeat ? ' (repeat)' : ''))
    ${prevent ? 'e.preventDefault()' : ''}
  })
}
</script>`,
        ),
      )
      return
    }
    if (u.pathname === '/print') {
      const lines = Array.from({ length: 120 }, (_, i) => `<p>Line ${i + 1} of the page to print.</p>`).join('')
      send(
        html(
          'Print',
          `<h1>Print</h1><input id="field" value="typed"><button id="print">Print</button>${lines}
<script>
sessionStorage.loads = Number(sessionStorage.loads || 0) + 1
window.__print = { before: 0, after: 0, returned: false, loads: Number(sessionStorage.loads) }
addEventListener('beforeprint', () => window.__print.before++)
addEventListener('afterprint', () => window.__print.after++)
document.getElementById('print').addEventListener('click', () => {
  window.print()
  window.__print.returned = true
})
</script>`,
        ),
      )
      return
    }
    if (u.pathname === '/swipe') {
      send(
        html(
          'Swipe',
          `<h1>Swipe</h1>
<div id="strip" style="overflow-x:auto;width:400px;height:140px"><div style="width:3000px;height:120px;background:linear-gradient(90deg,#c9c2b6,#7d766a)"></div></div>
<div id="grab" style="width:400px;height:140px;margin-top:16px;background:#d8d2c8"></div>
<script>
document.getElementById('strip').scrollLeft = 1000
document.getElementById('grab').addEventListener('wheel', (e) => e.preventDefault(), { passive: false })
</script>`,
        ),
      )
      return
    }
    if (u.pathname === '/framed') {
      const src = u.searchParams.get('src') ?? '/warn'
      send(
        html(
          'Framed',
          `<h1>Framed</h1><iframe id="frame" src="${src}" width="520" height="320"></iframe><div id="area"></div>`,
        ),
      )
      return
    }
    if (u.pathname.startsWith('/page/')) {
      const name = decodeURIComponent(u.pathname.slice('/page/'.length))
      send(html(name, `<h1 id="title">${name}</h1><div id="area"></div>`))
      return
    }
    if (u.pathname === '/apps') {
      const frame = u.searchParams.get('frame')
      send(
        html(
          'Apps',
          `<p><a id="mail" href="mailto:someone@example.com?subject=Hello%20there">Mail</a>
<a id="call" href="tel:+15550100">Call</a>
<a id="mail-tab" href="mailto:tab@example.com" target="_blank">Mail in a new tab</a>
<a id="app-tab" href="/to-app?to=${encodeURIComponent('zoommtg://join?confno=123')}" target="_blank">Join</a>
<button id="pop">Pop-up</button></p>
${frame ? `<iframe id="frame" src="${frame}" width="300" height="60"></iframe>` : ''}<div id="area"></div>
<script>document.getElementById('pop').addEventListener('click', () => {
  window.open('mailto:pop@example.com', 'pop', 'popup,width=320,height=240')
})</script>`,
        ),
      )
      return
    }
    if (u.pathname === '/app-frame') {
      send(html('Frame', '<a id="frame-mail" href="mailto:frame@example.com">Mail from the frame</a>'))
      return
    }
    if (u.pathname === '/to-app') {
      res.writeHead(302, {
        location: u.searchParams.get('to') ?? 'mailto:someone@example.com',
        'cache-control': 'no-store',
      })
      res.end()
      return
    }
    if (u.pathname === '/upload') {
      send(
        html(
          'Upload',
          `<form id="form" method="post" action="${u.searchParams.get('to') ?? '/posted'}"><input name="note" value="big">
<button id="send">Send</button></form><div id="area"></div>`,
        ),
      )
      return
    }
    send('not found', 404)
  }
}

/** Whether this machine can make a certificate for the secure fixture. */
export function canMakeCertificate(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * The fixture pages over HTTPS, with a certificate for localhost that no one trusts (made now by
 * openssl, and valid for a day): every page gets Chromium's ERR_CERT_AUTHORITY_INVALID.
 */
export async function startSecureFixtures(base = 3365): Promise<PagesFixtures> {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-e2e-cert-'))
  let key: Buffer
  let cert: Buffer
  try {
    const config = join(dir, 'cert.cnf')
    writeFileSync(
      config,
      `[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = localhost
[ext]
subjectAltName = DNS:localhost, IP:127.0.0.1
basicConstraints = CA:FALSE
`,
    )
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-config',
        config,
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    )
    key = readFileSync(join(dir, 'key.pem'))
    cert = readFileSync(join(dir, 'cert.pem'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const seen: string[] = []
  const server = createSecureServer({ key, cert }, pagesHandler(seen))
  const port = await listenInRange(server as unknown as Server, base)
  return {
    port,
    url: (path) => `https://localhost:${port}${path}`,
    seen: () => [...seen],
    close: () => closeServer(server as unknown as Server),
  }
}

export interface SilentServer {
  port: number
  url: (path: string) => string
  /** How many requests for a path reached it. */
  hits: (path: string) => number
  close: () => Promise<void>
}

/** A server that takes every request and never answers one (NV-13's time limit). */
export async function startSilentServer(base = 3360): Promise<SilentServer> {
  const seen: string[] = []
  const server = createServer((req) => {
    seen.push(new URL(req.url ?? '/', 'http://localhost').pathname)
  })
  const port = await listenInRange(server, base)
  return {
    port,
    url: (path) => `http://localhost:${port}${path}`,
    hits: (path) => seen.filter((p) => p === path).length,
    close: () => closeServer(server),
  }
}

type PagesGlobal = {
  __orbitPages: {
    dialogs: () => PageDialogInfo[]
    leave: (tabId: string) => LeaveInfo | null
    screens: () => PageScreenInfo[]
    launched: string[]
    fullScreen: (windowId: string) => FullScreenInfo
    print: () => PrintInfo[]
    printed: PrintRecord[]
    swipe: (windowId: string) => SwipeInfo
  }
}

/** The icon test runs' OS gives its mail app (NV-19). */
export const APP_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%232a7de1'/%3E%3C/svg%3E"

/**
 * The apps a test run's OS has (ORBIT_E2E_APPS, for launchOrbit's `env`): Mail opens `mailto:`
 * links, with an icon; any other kind's app goes unnamed, as on Linux (NV-19).
 */
export const APPS_ENV = { ORBIT_E2E_APPS: JSON.stringify({ mailto: { name: 'Mail', icon: APP_ICON } }) }

/** Links Orbit opened in another app, oldest first: test runs record each and start none (NV-19). */
export function launchedLinks(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => [...(globalThis as unknown as PagesGlobal).__orbitPages.launched])
}

/**
 * Clicks a button whose click closes the page it's in: a Peek's, a Mini Window's or a pop-up's
 * dialog has a view of its own, which goes with the dialog, sometimes before the click returns.
 */
export async function clickClosing(target: Locator): Promise<void> {
  try {
    await target.click()
  } catch (error) {
    if (!String(error).includes('has been closed')) throw error
  }
}

/** Every page's dialog on show or waiting (the first of each page's). */
export function pageDialogs(app: ElectronApplication): Promise<PageDialogInfo[]> {
  return app.evaluate(() => (globalThis as unknown as PagesGlobal).__orbitPages.dialogs())
}

/** Waits for a dialog that matches, and returns it. */
export async function waitDialog(
  app: ElectronApplication,
  match: (d: PageDialogInfo) => boolean,
  timeout = 15_000,
): Promise<PageDialogInfo> {
  let found: PageDialogInfo | undefined
  await expect
    .poll(
      async () => {
        found = (await pageDialogs(app)).find(match)
        return !!found
      },
      { timeout },
    )
    .toBe(true)
  return found as PageDialogInfo
}

/** Runs a script in the frame (`#frame`) of the page whose URL is `url`; null when there's none yet. */
export function inFrame(app: ElectronApplication, url: string, code: string): Promise<unknown> {
  return app.evaluate(
    async ({ webContents }, [u, c]) => {
      const frame = webContents.getAllWebContents().find((w) => w.getURL() === u)?.mainFrame.frames[0]
      return frame ? frame.executeJavaScript(c).catch(() => null) : null
    },
    [url, code] as const,
  )
}

/**
 * Clicks in the middle of a `/framed` page's frame, a `/warn` page, the way a person does (through
 * the browser process), once the frame has loaded, and waits until the frame got the press.
 */
export async function clickInFrame(app: ElectronApplication, url: string): Promise<void> {
  await expect.poll(() => inFrame(app, url, 'document.readyState')).toBe('complete')
  const before = Number(await inFrame(app, url, 'window.__clicks || 0'))
  await clickInPage(app, url, '#frame')
  await expect.poll(async () => Number(await inFrame(app, url, 'window.__clicks || 0'))).toBeGreaterThan(before)
}

export function leaveInfo(app: ElectronApplication, tabId: string): Promise<LeaveInfo | null> {
  return app.evaluate((_e, id) => (globalThis as unknown as PagesGlobal).__orbitPages.leave(id), tabId)
}

/** The dialog view (a Playwright page) showing the dialog with this id. */
export async function dialogPage(app: ElectronApplication, id: number): Promise<Page> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    for (const page of app.windows()) {
      if (!page.url().includes('view=dialog')) continue
      const shows = await page
        .locator(`[data-dialog-id="${id}"]`)
        .count()
        .catch(() => 0)
      if (shows > 0) return page
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`no dialog view shows dialog ${id}`)
}

/** What a `/ask` page's call returned (JSON text), once the page is free to answer. */
export async function askResult(page: Page): Promise<string> {
  return (await page.locator('#result').textContent()) ?? ''
}

/** Every page's error or crash screen (shown or waiting for its page to show). */
export function pageScreens(app: ElectronApplication): Promise<PageScreenInfo[]> {
  return app.evaluate(() => (globalThis as unknown as PagesGlobal).__orbitPages.screens())
}

/** Waits for a screen that matches, and returns it. */
export async function waitScreen(
  app: ElectronApplication,
  match: (s: PageScreenInfo) => boolean,
  timeout = 15_000,
): Promise<PageScreenInfo> {
  let found: PageScreenInfo | undefined
  await expect
    .poll(
      async () => {
        found = (await pageScreens(app)).find(match)
        return !!found
      },
      { timeout },
    )
    .toBe(true)
  return found as PageScreenInfo
}

/** Waits until a tab has no screen. */
export async function waitNoScreen(app: ElectronApplication, tabId: string): Promise<void> {
  await expect.poll(async () => (await pageScreens(app)).filter((s) => s.tabId === tabId).length).toBe(0)
}

/** The screen view (a Playwright page) showing the screen with this id. */
export async function screenPage(app: ElectronApplication, id: number): Promise<Page> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    for (const page of app.windows()) {
      if (!page.url().includes('view=screen')) continue
      const shows = await page
        .locator(`[data-screen-id="${id}"]`)
        .count()
        .catch(() => 0)
      if (shows > 0) return page
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`no screen view shows screen ${id}`)
}

type TabsGlobal = { __orbit: { ctx: { tabs: { contents: (id: string) => Electron.WebContents | undefined } } } }

/** Crashes a tab's page, as a renderer that dies does. */
export async function crashTab(app: ElectronApplication, tabId: string): Promise<void> {
  await app.evaluate((_e, id) => {
    ;(globalThis as unknown as TabsGlobal).__orbit.ctx.tabs.contents(id)?.forcefullyCrashRenderer()
  }, tabId)
}

export function tabCrashed(app: ElectronApplication, tabId: string): Promise<boolean | null> {
  return app.evaluate(
    (_e, id) => (globalThis as unknown as TabsGlobal).__orbit.ctx.tabs.contents(id)?.isCrashed() ?? null,
    tabId,
  )
}

/**
 * Emits one of a tab's page's events as the engine does (`unresponsive`, `responsive`). The engine
 * itself says nothing of a hung page while a debugger is attached to it, and Playwright attaches
 * to every page.
 */
export async function emitOnTab(app: ElectronApplication, tabId: string, name: string): Promise<void> {
  await app.evaluate(
    (_e, [id, n]) => {
      ;(globalThis as unknown as TabsGlobal).__orbit.ctx.tabs.contents(id)?.emit(n)
    },
    [tabId, name] as const,
  )
}

/** Starts a script in a tab's page and doesn't wait for it (it may never end). */
export async function startInTab(app: ElectronApplication, tabId: string, code: string): Promise<void> {
  await app.evaluate(
    (_e, [id, c]) => {
      void (globalThis as unknown as TabsGlobal).__orbit.ctx.tabs
        .contents(id)
        ?.executeJavaScript(c)
        .catch(() => {})
    },
    [tabId, code] as const,
  )
}

/**
 * Counts a tab's main-frame navigations from now on (a listener of the test's own on the page).
 * Returns a reader.
 */
export async function countNavigations(app: ElectronApplication, tabId: string): Promise<() => Promise<number>> {
  const key = `__pagesNavigations_${tabId}`
  await app.evaluate(
    (_e, [id, k]) => {
      const g = globalThis as unknown as TabsGlobal & Record<string, number>
      g[k] = 0
      g.__orbit.ctx.tabs.contents(id)?.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) g[k] = (g[k] ?? 0) + 1
      })
    },
    [tabId, key] as const,
  )
  return () => app.evaluate((_e, k) => (globalThis as unknown as Record<string, number>)[k] ?? 0, key)
}

export interface NetworkSwitch {
  /** Takes the page off the network (its loads fail with ERR_INTERNET_DISCONNECTED), or puts it back. */
  offline(on: boolean): Promise<void>
  close(): Promise<void>
}

/**
 * Takes one tab's page off the network and puts it back, as DevTools' Offline does (the profile's
 * own network emulation doesn't reach a page's navigations). `urlPart` finds the page.
 */
export async function networkSwitch(app: ElectronApplication, urlPart: string): Promise<NetworkSwitch> {
  const page = await tabPage(app, urlPart)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  return {
    offline: async (on) => {
      await cdp.send('Network.emulateNetworkConditions', {
        offline: on,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      })
    },
    close: () => cdp.detach().catch(() => {}),
  }
}

/** A tab's page area (window coordinates). */
export function pageBounds(app: ElectronApplication, tabId: string): Promise<unknown> {
  return app.evaluate((_e, id) => {
    const g = globalThis as unknown as { __orbit: { tabView: (id: string) => { bounds: unknown } | null } }
    return g.__orbit.tabView(id)?.bounds
  }, tabId)
}

/** A window's full screen as Orbit keeps it (NV-20). */
export function fullScreenInfo(app: ElectronApplication, windowId: string): Promise<FullScreenInfo> {
  return app.evaluate((_e, id) => (globalThis as unknown as PagesGlobal).__orbitPages.fullScreen(id), windowId)
}

/** The printers a test run's OS has (ORBIT_E2E_PRINTERS, for launchOrbit's `env`): one office printer (NV-07). */
export const PRINTERS_ENV = { ORBIT_E2E_PRINTERS: JSON.stringify([{ id: 'Office', name: 'Office Printer' }]) }

/** Every page's print dialog (NV-07). */
export function printDialogs(app: ElectronApplication): Promise<PrintInfo[]> {
  return app.evaluate(() => (globalThis as unknown as PagesGlobal).__orbitPages.print())
}

/** Print jobs, oldest first: test runs record each, and print or save none (NV-07). */
export function printedJobs(app: ElectronApplication): Promise<PrintRecord[]> {
  return app.evaluate(() => [...(globalThis as unknown as PagesGlobal).__orbitPages.printed])
}

/** Waits for a print dialog that matches (by default, one on screen with its preview), and returns it. */
export async function waitPrint(
  app: ElectronApplication,
  match: (d: PrintInfo) => boolean = (d) => d.onScreen && d.preview === 'ready',
): Promise<PrintInfo> {
  let found: PrintInfo | undefined
  await expect
    .poll(async () => {
      found = (await printDialogs(app)).find(match)
      return !!found
    })
    .toBe(true)
  return found as PrintInfo
}

/** The print view (a Playwright page) showing the print dialog with this id. */
export async function printPage(app: ElectronApplication, id: number): Promise<Page> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    for (const page of app.windows()) {
      if (!page.url().includes('view=print')) continue
      const shows = await page
        .locator(`[data-dialog-id="${id}"]`)
        .count()
        .catch(() => 0)
      if (shows > 0) return page
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`no print view shows dialog ${id}`)
}

/** A window's two-finger swipe over a page and its arrow (NV-02). */
export function swipeInfo(app: ElectronApplication, windowId: string): Promise<SwipeInfo> {
  return app.evaluate((_e, id) => (globalThis as unknown as PagesGlobal).__orbitPages.swipe(id), windowId)
}

/**
 * A two-finger horizontal swipe over the page showing `url`, at `x`, `y` (page coordinates): one
 * trackpad scroll event for each of `deltas` (px, as the page's `WheelEvent.deltaX` reads them: a
 * negative one scrolls toward the left, which is back), sent at once through the browser process,
 * as the trackpad's are. Returns the window's swipe as soon as main has heard all of them, before
 * the fingers count as lifted (RELEASE_GAP_MS after the last), or null if it didn't in time.
 */
export function swipeOverPage(
  app: ElectronApplication,
  windowId: string,
  url: string,
  at: { x: number; y: number },
  deltas: number[],
): Promise<SwipeInfo | null> {
  return app.evaluate(
    async ({ webContents }, { windowId, url, at, deltas }) => {
      const page = webContents.getAllWebContents().find((w) => w.getURL() === url)
      const hooks = (globalThis as unknown as PagesGlobal).__orbitPages
      for (const d of deltas) {
        page?.sendInputEvent({
          type: 'mouseWheel',
          x: at.x,
          y: at.y,
          deltaX: -d,
          deltaY: 0,
          hasPreciseScrollingDeltas: true,
          canScroll: true,
        })
      }
      const total = Math.abs(deltas.reduce((a, b) => a + b, 0))
      const deadline = Date.now() + 1000
      while (Date.now() < deadline) {
        const info = hooks.swipe(windowId)
        if (info.tabId && info.travel >= Math.min(total, 112) - 0.5) return info
        await new Promise((r) => setTimeout(r, 2))
      }
      return null
    },
    { windowId, url, at, deltas },
  )
}
