/**
 * Helpers for the chrome lane's e2e specs (chrome.spec.ts, nav.spec.ts): a local fixture server
 * with pages for navigation tests, and small wrappers around Orbit's test hooks.
 */
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { type ElectronApplication, expect, type Page } from '@playwright/test'
import type { OrbitState, Tab } from '../../src/shared/state'
import { isMac, state } from './helpers'

/** Host name the fixture server also answers to, as a plain-http site that isn't this machine. */
export const INSECURE_HOST = 'insecure.test'
/** Chromium switch mapping INSECURE_HOST to the local fixture server (no network involved). */
export const HOST_RULES = `--host-resolver-rules=MAP ${INSECURE_HOST} 127.0.0.1`

/** ⌘ on macOS, Ctrl elsewhere: the modifier that sends a click to a new tab (SB-03, NV-08). */
export const NEW_TAB_CLICK = isMac ? 'Meta' : 'Control'

export interface NavFixtures {
  port: number
  /** `http://localhost:<port><path>` */
  url: (path: string) => string
  /** The same server under another host name (`127.0.0.1`, or INSECURE_HOST with HOST_RULES). */
  urlOn: (host: string, path: string) => string
  /** How many requests a path has had. */
  hits: (path: string) => number
  /** The Cache-Control header of the latest request for a path (a hard reload sends no-cache). */
  cacheControl: (path: string) => string | undefined
  close: () => Promise<void>
}

const ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='7' fill='%2338a169'/%3E%3C/svg%3E"

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * A page that records key presses (`window.__keys`) and mouse presses (`window.__clicks`: x, y,
 * button) and counts its loads in sessionStorage (`loads`), with a text box (#box), a link to the
 * next page (#next) and one that opens a new tab (#child). `background` is its CSS background;
 * `text` goes in a paragraph (#text).
 */
function page(title: string, background = '#f2fbf5', text = ''): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title><link rel="icon" href="${ICON}">
<style>body{font:16px system-ui;background:${background};margin:0;padding:40px}input{font:inherit}</style></head>
<body><h1 id="title">${title}</h1>
<p id="text">${escapeHtml(text)}</p>
<p><input id="box" autocomplete="off"></p>
<p><a id="next" href="/page/${encodeURIComponent(`${title}-next`)}">Next page</a></p>
<p><a id="child" href="/page/${encodeURIComponent(`${title}-child`)}" target="_blank">Child page</a></p>
<div style="height:2000px"></div>
<script>
window.__keys = []
addEventListener('keydown', (e) => window.__keys.push(e.key))
window.__clicks = []
addEventListener('mousedown', (e) => window.__clicks.push({ x: e.clientX, y: e.clientY, button: e.button }))
sessionStorage.setItem('loads', String(Number(sessionStorage.getItem('loads') || 0) + 1))
</script>
</body></html>`
}

/**
 * Routes:
 * - `/page/<title>?bg=<css colour>&text=<words>`: a page (see `page()`), optionally in another
 *   background and with some text.
 * - `/slow/<title>?ms=N`: the page after N ms (default 30 s): keeps a tab loading.
 * - `/slow-reload/<title>`: the page at once on the first request, then slowly (30 s) on reloads.
 */
export async function startNavFixtures(): Promise<NavFixtures> {
  const hits = new Map<string, number>()
  const cacheControl = new Map<string, string | undefined>()
  const pending = new Set<ServerResponse>()
  const sockets = new Set<Socket>()
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost')
    const count = (hits.get(u.pathname) ?? 0) + 1
    hits.set(u.pathname, count)
    cacheControl.set(u.pathname, req.headers['cache-control'])
    const [, kind = '', raw = 'index'] = u.pathname.split('/')
    const title = decodeURIComponent(raw)
    const send = () => {
      pending.delete(res)
      if (res.writableEnded || res.destroyed) return
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
      res.end(page(title, u.searchParams.get('bg') ?? undefined, u.searchParams.get('text') ?? ''))
    }
    const later = (ms: number) => {
      pending.add(res)
      const timer = setTimeout(send, ms)
      res.on('close', () => {
        clearTimeout(timer)
        pending.delete(res)
      })
    }
    if (kind === 'page') return send()
    if (kind === 'slow') return later(Number(u.searchParams.get('ms') ?? 30_000))
    if (kind === 'slow-reload') return count === 1 ? send() : later(30_000)
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolveListen, reject) => {
    let port = 3340
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && port < 3399) server.listen(++port, '127.0.0.1')
      else reject(err)
    })
    server.listen(port, '127.0.0.1', () => resolveListen())
  })
  const { port } = server.address() as AddressInfo
  return {
    port,
    url: (path) => `http://localhost:${port}${path}`,
    urlOn: (host, path) => `http://${host}:${port}${path}`,
    hits: (path) => hits.get(path) ?? 0,
    cacheControl: (path) => cacheControl.get(path),
    close: () =>
      new Promise((r) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => r())
      }),
  }
}

type Hooks = {
  __orbit: {
    run: (n: string, a: unknown, w?: string) => Promise<unknown>
    windowIds: () => string[]
    ctx: { windows: { get: (id: string) => Electron.BrowserWindow | undefined } }
  }
  __orbitNav: {
    menu: () => { windowId: string; direction: 'back' | 'forward'; labels: string[]; icons: boolean[] } | null
    chooseMenu: (label: string, newTab?: boolean) => boolean
    floating: (windowId?: string) => FloatingInfo
    corner: (tabId: string) => number | null
    tools: (windowId?: string) => ToolsInfo
  }
}

/** A window's page tools (NV-05, NV-06): what the find bar and the zoom indicator show, and where. */
export interface ToolsInfo {
  find: {
    tabId: string | null
    open: boolean
    query: string
    active: number
    matches: number
    searched: boolean
  }
  zoom: { percent: number } | null
  hovered: boolean
  placed: boolean
  bounds?: { x: number; y: number; width: number; height: number }
}

/** The first window's page tools. */
export function toolsInfo(app: ElectronApplication): Promise<ToolsInfo> {
  return app.evaluate(() => (globalThis as unknown as Hooks).__orbitNav.tools())
}

/** The page tools' page (their own renderer, `view=tools`), once it has started. */
export async function toolsPage(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const found = app.windows().find((p) => p.url().includes('view=tools'))
    if (found) return found
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('No page tools page')
}

/** The zoom factor of the web contents whose URL contains `part`. */
export function zoomOf(app: ElectronApplication, part: string): Promise<number | undefined> {
  return app.evaluate(
    ({ webContents }, p) =>
      webContents
        .getAllWebContents()
        .find((w) => w.getURL().includes(p))
        ?.getZoomFactor(),
    part,
  )
}

/** A window's floating sidebar (SB-12): whether its view exists, is placed in the window and is out. */
export interface FloatingInfo {
  exists: boolean
  placed: boolean
  shown: boolean
  bounds?: { x: number; y: number; width: number; height: number }
  /** What keeps it out; `hiding` while it waits out the grace delay before sliding away. */
  hold: { over: boolean; editing: boolean; overlay: boolean; hiding: boolean } | null
}

/** The floating sidebar's page (its own renderer, `view=sidebar`), once it has been made. */
export async function floatingPage(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const found = app.windows().find((p) => p.url().includes('view=sidebar'))
    if (found) return found
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('No floating sidebar page')
}

/** The first window's floating sidebar. */
export function floatingInfo(app: ElectronApplication): Promise<FloatingInfo> {
  return app.evaluate(() => (globalThis as unknown as Hooks).__orbitNav.floating())
}

/** The corner radius a shown page's card was given (SB-19). */
export function pageCorner(app: ElectronApplication, tabId: string): Promise<number | null> {
  return app.evaluate((_e, id) => (globalThis as unknown as Hooks).__orbitNav.corner(id), tabId)
}

/** Puts the first window into or out of native full screen and waits until it is there (macOS animates). */
export async function setNativeFullScreen(app: ElectronApplication, on: boolean): Promise<void> {
  await app.evaluate((_e, value) => {
    const { __orbit } = globalThis as unknown as Hooks
    __orbit.ctx.windows.get(__orbit.windowIds()[0] as string)?.setFullScreen(value)
  }, on)
  await expect.poll(async () => (await windowState(app)).fullscreen, { timeout: 15_000 }).toBe(on)
}

/** Runs a command as if from the first window. */
export function cmd<T = unknown>(app: ElectronApplication, name: string, args: unknown = {}): Promise<T> {
  return app.evaluate(
    async (_e, [n, a]) => {
      const g = globalThis as unknown as Hooks
      return g.__orbit.run(n, a, g.__orbit.windowIds()[0])
    },
    [name, args] as const,
  ) as Promise<T>
}

/** The history menu Orbit would show (labels top to bottom), or null when none is open. */
export function historyMenu(app: ElectronApplication) {
  return app.evaluate(() => (globalThis as unknown as Hooks).__orbitNav.menu())
}

export function chooseHistory(app: ElectronApplication, label: string, newTab = false): Promise<boolean> {
  return app.evaluate((_e, [l, n]) => (globalThis as unknown as Hooks).__orbitNav.chooseMenu(l, n), [
    label,
    newTab,
  ] as const)
}

export async function windowState(app: ElectronApplication): Promise<OrbitState['windows'][string]> {
  const s = await state(app)
  const id = await app.evaluate(() => (globalThis as unknown as Hooks).__orbit.windowIds()[0])
  return s.windows[id as string] as OrbitState['windows'][string]
}

export async function activeTab(app: ElectronApplication): Promise<Tab> {
  const s = await state(app)
  const win = await windowState(app)
  const id = win.activeTab[win.spaceId]
  const t = id ? s.tabs[id] : undefined
  if (!t) throw new Error('no active tab')
  return t
}

export async function tabCount(app: ElectronApplication): Promise<number> {
  return Object.keys((await state(app)).tabs).length
}

/** Opens a URL in a new, selected tab and waits until it has loaded. */
export async function openTab(app: ElectronApplication, url: string): Promise<string> {
  const id = await cmd<string>(app, 'tabs.create', { url })
  await waitLoaded(app, id, url)
  return id
}

/** Waits until a tab shows `url` (exactly) and has stopped loading with its page title. */
export async function waitLoaded(app: ElectronApplication, tabId: string, url: string): Promise<void> {
  await expect
    .poll(async () => {
      const t = (await state(app)).tabs[tabId]
      // Until the page's <title> arrives, Chromium titles the tab with its address.
      return !!t && t.url === url && !t.loading && !t.asleep && !!t.title && !t.title.includes('/')
    })
    .toBe(true)
}

/** Navigates a tab like a click on a link would, and waits for the page. */
export async function visit(app: ElectronApplication, tabId: string, url: string): Promise<void> {
  await cmd(app, 'tabs.navigate', { tabId, url })
  await waitLoaded(app, tabId, url)
}

/** The URL of the web contents that has keyboard focus. */
export function focusedUrl(app: ElectronApplication): Promise<string | null> {
  return app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL() ?? null)
}

/**
 * Presses a key in a tab's page the way the keyboard does: through the browser process, where
 * Orbit's shortcuts see it. (Playwright's `page.keyboard` goes straight to the page.) `key` is an
 * Electron key code ('Left', '[', 'R', 'F5', 'Escape'…); modifiers are 'shift', 'control', 'alt', 'meta'.
 */
export async function pressInPage(
  app: ElectronApplication,
  urlPart: string,
  key: string,
  modifiers: ('shift' | 'control' | 'alt' | 'meta')[] = [],
): Promise<void> {
  await app.evaluate(
    ({ webContents }, [part, keyCode, mods]) => {
      const page = webContents.getAllWebContents().find((w) => w.getURL().includes(part))
      if (!page) throw new Error(`no page with ${part}`)
      page.sendInputEvent({ type: 'keyDown', keyCode, modifiers: [...mods] })
      page.sendInputEvent({ type: 'keyUp', keyCode, modifiers: [...mods] })
    },
    [urlPart, key, modifiers] as const,
  )
}

/**
 * Moves or presses the mouse over a tab's page the way the hardware does: through the browser
 * process, where Orbit sees it. `x`, `y` are in the page's coordinates.
 */
export async function pageMouse(
  app: ElectronApplication,
  urlPart: string,
  type: 'mouseMove' | 'mouseDown' | 'mouseUp',
  x: number,
  y: number,
): Promise<void> {
  await app.evaluate(
    ({ webContents }, [part, t, px, py]) => {
      const page = webContents.getAllWebContents().find((w) => w.getURL().includes(part))
      if (!page) throw new Error(`no page with ${part}`)
      if (t === 'mouseMove') page.sendInputEvent({ type: t, x: px, y: py })
      else page.sendInputEvent({ type: t, x: px, y: py, button: 'left', clickCount: 1 })
    },
    [urlPart, type, x, y] as const,
  )
}

/** Presses a mouse side button ('back' or 'forward') over a page, as the hardware would send it. */
export async function sideButton(page: Page, button: 'back' | 'forward'): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  try {
    const at = { x: 120, y: 120, button, clickCount: 1 }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', buttons: button === 'back' ? 8 : 16, ...at })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', buttons: 0, ...at })
  } finally {
    await cdp.detach()
  }
}

/**
 * Counts calls to a main-process command from now on, by wrapping its handler: proves that
 * something did not happen (e.g. a long-press did not also navigate).
 */
export async function spyCommand(app: ElectronApplication, name: string): Promise<() => Promise<number>> {
  await app.evaluate((_e, n) => {
    type Handler = (...args: unknown[]) => unknown
    const g = globalThis as unknown as {
      __orbit: { ctx: { commands: { handlers: Map<string, Handler> } } }
      __navSpy?: Record<string, number>
    }
    const handlers = g.__orbit.ctx.commands.handlers
    const original = handlers.get(n)
    if (!original) throw new Error(`no command ${n}`)
    g.__navSpy = g.__navSpy ?? {}
    const spy = g.__navSpy
    spy[n] = 0
    handlers.set(n, (...args: unknown[]) => {
      spy[n] = (spy[n] ?? 0) + 1
      return original(...args)
    })
  }, name)
  return () =>
    app.evaluate((_e, n) => (globalThis as unknown as { __navSpy: Record<string, number> }).__navSpy[n] ?? 0, name)
}

/** Resolves once every command the shell sent before has been handled (one IPC round trip). */
export async function shellRoundTrip(shell: Page): Promise<void> {
  await shell.evaluate(() =>
    (window as unknown as { orbit: { invoke: (n: string, a: unknown) => Promise<unknown> } }).orbit.invoke(
      'app.info',
      {},
    ),
  )
}
