/**
 * Helpers for the chrome lane's e2e specs (chrome.spec.ts, nav*.spec.ts): a local fixture server
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
/**
 * Launch switches for tests that visit INSECURE_HOST: the mapping, and a way past the dead proxy the
 * e2e apps may run behind (it only lets loopback names through, and this one isn't one).
 */
export const HOST_ARGS = [HOST_RULES, `--proxy-bypass-list=${INSECURE_HOST}`]

/** ⌘ on macOS, Ctrl elsewhere: the modifier that sends a click to a new tab (SB-03, NV-08). */
export const NEW_TAB_CLICK = isMac ? 'Meta' : 'Control'

/** Where the nav fixture servers start looking for a free port (this lane's range is 3330–3349). */
const NAV_PORT_BASE = 3330

export interface NavFixtures {
  port: number
  /** `http://localhost:<port><path>` */
  url: (path: string) => string
  /** The same server under another host name (`127.0.0.1`, or INSECURE_HOST with HOST_RULES). */
  urlOn: (host: string, path: string) => string
  /** How many requests a path has had. */
  hits: (path: string) => number
  /** Sends the pages a `/slow/` path is holding back now. */
  release: (path: string) => void
  /** The Cache-Control header of the latest request for a path (a hard reload sends no-cache). */
  cacheControl: (path: string) => string | undefined
  /** What the latest request for a path said about where it came from, or undefined before one. */
  sentFrom: (path: string) => SentFrom | undefined
  /** What each request for a path said about where it came from, oldest first. */
  sentFromEach: (path: string) => SentFrom[]
  close: () => Promise<void>
}

/** Request headers that say where a request comes from (review B-F1); absent ones are left out. */
export interface SentFrom {
  referer?: string
  /** Sec-Fetch-Site: `none` for an address typed by the user, `cross-site` for a link from another site. */
  site?: string
  cookie?: string
}

const ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='7' fill='%2338a169'/%3E%3C/svg%3E"

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * A page that records key presses (`window.__keys`) and mouse presses (`window.__clicks`: x, y,
 * button) and counts its loads in sessionStorage (`loads`), with a text box (#box), a link to the
 * next page (#next), one that opens a new tab (#child) and one to a download (#download, in a new
 * tab), and buttons that open a small pop-up window (`/page/Popup-<title>`, #popup) and close it
 * again (#closepopup).
 * `background` is its CSS background; `text` goes in a paragraph (#text); `open` is a page it
 * opens in a pop-up as soon as it loads, without a click; `away` is the address of one more link
 * (#away); `wait` is the address of an image (#wait) the page waits for: a `/slow/` one keeps the
 * page loading after its scripts have run.
 */
function page(title: string, background = '#f2fbf5', text = '', open = '', away = '', wait = ''): string {
  const name = encodeURIComponent(title)
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title><link rel="icon" href="${ICON}">
<style>body{font:16px system-ui;background:${background};margin:0;padding:40px}input{font:inherit}</style></head>
<body><h1 id="title">${title}</h1>
<p id="text">${escapeHtml(text)}</p>
<p><input id="box" autocomplete="off"></p>
<p><a id="next" href="/page/${encodeURIComponent(`${title}-next`)}">Next page</a></p>
<p><a id="child" href="/page/${encodeURIComponent(`${title}-child`)}" target="_blank">Child page</a></p>
${away ? `<p><a id="away" href="${escapeHtml(away)}">Away</a></p>` : ''}
<p><a id="download" href="/download/${name}.txt" target="_blank">Download</a>
<button id="popup" onclick="window.__popup = window.open('/page/Popup-${name}', 'pop', 'width=420,height=360')">Pop-up</button>
<button id="closepopup" onclick="window.__popup && window.__popup.close()">Close pop-up</button></p>
${wait ? `<img id="wait" alt="" src="${escapeHtml(wait)}">` : ''}
<div style="height:2000px"></div>
<script>
window.__keys = []
addEventListener('keydown', (e) => window.__keys.push(e.key))
window.__clicks = []
addEventListener('mousedown', (e) => window.__clicks.push({ x: e.clientX, y: e.clientY, button: e.button }))
sessionStorage.setItem('loads', String(Number(sessionStorage.getItem('loads') || 0) + 1))
${open ? `window.open(${JSON.stringify(open)}, 'auto', 'width=400,height=300')` : ''}
</script>
</body></html>`
}

/**
 * A page with a short video (#v, with controls) and a tone (#a, with controls). The video is
 * recorded in the page and played from a MediaSource, so it has a length (it can loop) and a
 * picture (its controls can be hidden).
 */
function mediaPage(title: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:16px system-ui;margin:0;padding:40px}video{display:block;width:320px;height:180px;background:#000}audio{display:block;width:320px;margin-top:24px}</style></head>
<body><video id="v" controls></video><audio id="a" controls src="/tone.wav"></audio>
<script>
const type = 'video/webm;codecs=vp8'
const c = document.createElement('canvas')
c.width = 160
c.height = 90
const g = c.getContext('2d')
let n = 0
const draw = () => { g.fillStyle = n++ % 2 ? '#2f855a' : '#2b6cb0'; g.fillRect(0, 0, 160, 90) }
draw()
const timer = setInterval(draw, 40)
const rec = new MediaRecorder(c.captureStream(25), { mimeType: type })
const chunks = []
rec.ondataavailable = (e) => chunks.push(e.data)
rec.onstop = async () => {
  clearInterval(timer)
  const data = await new Blob(chunks).arrayBuffer()
  const source = new MediaSource()
  source.addEventListener('sourceopen', () => {
    const buffer = source.addSourceBuffer(type)
    buffer.addEventListener('updateend', () => source.endOfStream(), { once: true })
    buffer.appendBuffer(data)
  }, { once: true })
  document.getElementById('v').src = URL.createObjectURL(source)
}
rec.start()
setTimeout(() => rec.stop(), 400)
</script>
</body></html>`
}

/** A WAV file: `seconds` of a quiet 440 Hz tone (8-bit mono, 8 kHz). */
function tone(seconds: number): Buffer {
  const rate = 8000
  const samples = Math.round(seconds * rate)
  const wav = Buffer.alloc(44 + samples)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + samples, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(rate, 24)
  wav.writeUInt32LE(rate, 28)
  wav.writeUInt16LE(1, 32)
  wav.writeUInt16LE(8, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(samples, 40)
  for (let i = 0; i < samples; i++) wav[44 + i] = 128 + Math.round(16 * Math.sin((2 * Math.PI * 440 * i) / rate))
  return wav
}

/**
 * Routes:
 * - `/page/<title>?bg=<css colour>&text=<words>`: a page (see `page()`), optionally in another
 *   background and with some text.
 * - `/slow/<title>?ms=N`: the page after N ms (default 30 s), or when the test releases it: keeps
 *   a tab loading.
 * - `/slow-reload/<title>`: the page at once on the first request, then slowly (30 s) on reloads.
 * - `/page/<title>?open=<path>`: the page, opening `<path>` in a pop-up as it loads (no click).
 * - `/page/<title>?away=<url>`: the page with a link (#away) to `<url>`.
 * - `/page/<title>?wait=<path>`: the page with an image from `<path>`, which it waits for.
 * - `/download/<name>`: a small text file sent as a download (Content-Disposition: attachment).
 * - `/cookies`: a page that sets two cookies for its host, `strict=1` (SameSite=Strict) and
 *   `lax=1` (SameSite=Lax).
 * - `/media/<title>`: a page with a video and a tone (see `mediaPage()`); `/tone.wav`: the tone.
 */
export async function startNavFixtures(portBase = NAV_PORT_BASE, portLast = 3399): Promise<NavFixtures> {
  const hits = new Map<string, number>()
  const cacheControl = new Map<string, string | undefined>()
  const sentFrom = new Map<string, SentFrom[]>()
  const pending = new Set<ServerResponse>()
  /** The held-back pages per path, to send early (`release`). */
  const held = new Map<string, Set<() => void>>()
  const sockets = new Set<Socket>()
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost')
    const count = (hits.get(u.pathname) ?? 0) + 1
    hits.set(u.pathname, count)
    cacheControl.set(u.pathname, req.headers['cache-control'])
    const from: SentFrom = {}
    if (req.headers.referer) from.referer = req.headers.referer
    const site = req.headers['sec-fetch-site']
    if (typeof site === 'string') from.site = site
    if (req.headers.cookie) from.cookie = req.headers.cookie
    sentFrom.set(u.pathname, [...(sentFrom.get(u.pathname) ?? []), from])
    const [, kind = '', raw = 'index'] = u.pathname.split('/')
    const title = decodeURIComponent(raw)
    const send = () => {
      pending.delete(res)
      if (res.writableEnded || res.destroyed) return
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
      res.end(
        page(
          title,
          u.searchParams.get('bg') ?? undefined,
          u.searchParams.get('text') ?? '',
          u.searchParams.get('open') ?? '',
          u.searchParams.get('away') ?? '',
          u.searchParams.get('wait') ?? '',
        ),
      )
    }
    const later = (ms: number) => {
      pending.add(res)
      const waiting = held.get(u.pathname) ?? new Set<() => void>()
      held.set(u.pathname, waiting)
      const done = () => {
        clearTimeout(timer)
        waiting.delete(done)
        send()
      }
      const timer = setTimeout(done, ms)
      waiting.add(done)
      res.on('close', () => {
        clearTimeout(timer)
        waiting.delete(done)
        pending.delete(res)
      })
    }
    if (kind === 'page') return send()
    if (kind === 'download') {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'content-disposition': `attachment; filename="${title.replace(/[^\w.-]/g, '_')}"`,
        'cache-control': 'no-store',
      })
      return res.end(`Downloaded ${title}\n`)
    }
    if (kind === 'cookies') {
      res.writeHead(200, {
        'content-type': 'text/html',
        'cache-control': 'no-store',
        'set-cookie': ['strict=1; SameSite=Strict; Path=/', 'lax=1; SameSite=Lax; Path=/'],
      })
      return res.end('<!doctype html><title>Cookies</title><p>Cookies set.</p>')
    }
    if (kind === 'media') {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
      return res.end(mediaPage(title))
    }
    if (kind === 'tone.wav') {
      res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' })
      return res.end(tone(2))
    }
    if (kind === 'slow') return later(Number(u.searchParams.get('ms') ?? 30_000))
    if (kind === 'slow-reload') return count === 1 ? send() : later(30_000)
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  // Everything the tests run stays within 3300–3399 (or the range a suite asks for): the first free
  // port from this suite's base.
  const base = portBase + (Number(process.env.TEST_PARALLEL_INDEX ?? 0) % 10)
  await new Promise<void>((resolveListen, reject) => {
    let port = base
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && port < portLast) server.listen(++port, '127.0.0.1')
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
    release: (path) => {
      for (const done of [...(held.get(path) ?? [])]) done()
    },
    cacheControl: (path) => cacheControl.get(path),
    sentFrom: (path) => sentFrom.get(path)?.at(-1),
    sentFromEach: (path) => [...(sentFrom.get(path) ?? [])],
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
    flush: () => unknown
    ctx: {
      windows: { get: (id: string) => Electron.BrowserWindow | undefined }
      tabs: {
        contents: (id: string) => Electron.WebContents | undefined
        tabIdFor: (contents: Electron.WebContents) => string | undefined
      }
    }
  }
  __orbitNav: {
    menu: () => { windowId: string; direction: 'back' | 'forward'; labels: string[]; icons: boolean[] } | null
    chooseMenu: (label: string, newTab?: boolean) => boolean
    floating: (windowId?: string) => FloatingInfo
    pointerAt: (x: number, y: number, windowId?: string) => void
    corner: (tabId: string) => number | null
    tools: (windowId?: string) => ToolsInfo
    blockedMenu: () => string[] | null
    chooseBlocked: (label: string) => boolean
    pageMenu: () => PageMenu | null
    choosePageMenu: (label: string) => boolean
  }
}

/** The page context menu Orbit last built (NV-12): labels top to bottom, `-` for separators. */
export interface PageMenu {
  tabId: string
  labels: string[]
  enabled: Record<string, boolean>
  /** Whether each tickable item is ticked. */
  checked: Record<string, boolean>
}

/** The page context menu last opened (kept instead of shown in tests), or null. */
export function pageMenu(app: ElectronApplication): Promise<PageMenu | null> {
  return app.evaluate(() => (globalThis as unknown as Hooks).__orbitNav.pageMenu())
}

export function choosePageMenu(app: ElectronApplication, label: string): Promise<boolean> {
  return app.evaluate((_e, l) => (globalThis as unknown as Hooks).__orbitNav.choosePageMenu(l), label)
}

/** The blocked pop-ups menu last opened from the address display (NV-09), or null. */
export function blockedMenu(app: ElectronApplication): Promise<string[] | null> {
  return app.evaluate(() => (globalThis as unknown as Hooks).__orbitNav.blockedMenu())
}

export function chooseBlocked(app: ElectronApplication, label: string): Promise<boolean> {
  return app.evaluate((_e, l) => (globalThis as unknown as Hooks).__orbitNav.chooseBlocked(l), label)
}

export type Modifier = 'shift' | 'control' | 'alt' | 'meta'
type InputEventInit = { type: string } & Record<string, unknown>

/** Runs a script in the page with this address (or a part of it); null while there's none or it loads. */
function inPage<T>(app: ElectronApplication, page: string, code: string): Promise<T | null> {
  return app.evaluate(
    async ({ webContents }, [part, js]) => {
      const matches = (url: string) => (part.startsWith('http') ? url === part : url.includes(part))
      const contents = webContents.getAllWebContents().find((w) => matches(w.getURL()))
      if (!contents || contents.isLoading()) return null
      return await contents.executeJavaScript(js)
    },
    [page, code] as const,
  ) as Promise<T | null>
}

/** Sends input events to the page with this address (or a part of it) as the hardware would. */
export async function sendToPage(app: ElectronApplication, page: string, events: InputEventInit[]): Promise<void> {
  await app.evaluate(
    ({ webContents }, [part, list]) => {
      const matches = (url: string) => (part.startsWith('http') ? url === part : url.includes(part))
      const contents = webContents.getAllWebContents().find((w) => matches(w.getURL()))
      if (!contents) throw new Error(`no page ${part}`)
      for (const event of list) contents.sendInputEvent(event as unknown as Electron.MouseInputEvent)
    },
    [page, events] as const,
  )
}

/**
 * Moves the pointer onto the middle of an element of a page until the page has it hovered, and
 * returns that point. The move goes again while waiting: the real pointer's own crossing (a window
 * opening over it, say) can take the page's hover back after it (fix check B, F1).
 * `page` is the page's full address (matched exactly), or a part of it.
 */
export async function hoverInPage(
  app: ElectronApplication,
  page: string,
  selector: string,
): Promise<{ x: number; y: number }> {
  const sel = JSON.stringify(selector)
  const deadline = Date.now() + 10_000
  let at: { x: number; y: number } | null = null
  while (!at && Date.now() < deadline) {
    at = await inPage<{ x: number; y: number }>(
      app,
      page,
      `(() => { const r = document.querySelector(${sel})?.getBoundingClientRect(); return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null })()`,
    )
    if (!at) await new Promise((r) => setTimeout(r, 100))
  }
  if (!at) throw new Error(`no ${selector} in ${page}`)
  const { x, y } = at
  await expect
    .poll(async () => {
      await sendToPage(app, page, [{ type: 'mouseMove', x, y }])
      return inPage<boolean>(app, page, `!!document.querySelector(${sel})?.matches(':hover')`)
    })
    .toBe(true)
  return { x, y }
}

/**
 * Clicks an element of a page the way a person does, through the browser process: the pointer
 * goes onto it first (until the page has it hovered), then the modifier keys go down, the button
 * is pressed and released, and the keys come up, so Orbit sees the keys as well as the page.
 * `page` is the page's full address (matched exactly), or a part of it.
 */
export async function clickInPage(
  app: ElectronApplication,
  page: string,
  selector: string,
  modifiers: Modifier[] = [],
  button: 'left' | 'middle' | 'right' = 'left',
): Promise<void> {
  const { x, y } = await hoverInPage(app, page, selector)
  await sendToPage(app, page, clickEvents(x, y, modifiers, button))
}

/** The keys going down, a press and release at (x, y), and the keys coming up. */
export function clickEvents(
  x: number,
  y: number,
  modifiers: Modifier[] = [],
  button: 'left' | 'middle' | 'right' = 'left',
): InputEventInit[] {
  const keys: Record<Modifier, string> = { shift: 'Shift', control: 'Control', alt: 'Alt', meta: 'Meta' }
  const events: InputEventInit[] = []
  const held: Modifier[] = []
  for (const m of modifiers) {
    held.push(m)
    events.push({ type: 'keyDown', keyCode: keys[m], modifiers: [...held] })
  }
  events.push({ type: 'mouseDown', x, y, button, clickCount: 1, modifiers: [...modifiers] })
  events.push({ type: 'mouseUp', x, y, button, clickCount: 1, modifiers: [...modifiers] })
  for (const m of [...modifiers].reverse()) {
    held.pop()
    events.push({ type: 'keyUp', keyCode: keys[m], modifiers: [...held] })
  }
  return events
}

/** Orbit's windows: id, kind and bounds, in the order they opened. */
export async function windowList(
  app: ElectronApplication,
): Promise<{ id: string; kind: string; spaceId: string; bounds: Electron.Rectangle | null }[]> {
  const s = await state(app)
  const ids = await app.evaluate(() => (globalThis as unknown as Hooks).__orbit.windowIds())
  const bounds = await app.evaluate((_e, list) => {
    const { __orbit } = globalThis as unknown as Hooks
    return list.map((id) => {
      const win = __orbit.ctx.windows.get(id)
      return win && !win.isDestroyed() ? win.getBounds() : null
    })
  }, ids)
  return ids.map((id, i) => ({
    id,
    kind: s.windows[id]?.kind ?? '',
    spaceId: s.windows[id]?.spaceId ?? '',
    bounds: bounds[i] ?? null,
  }))
}

/** Windows that are not Orbit's own (pop-ups pages opened): their titles. */
export function foreignWindowTitles(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ BrowserWindow }) => {
    const { __orbit } = globalThis as unknown as Hooks
    const own = new Set(__orbit.windowIds().map((id) => __orbit.ctx.windows.get(id)))
    return BrowserWindow.getAllWindows()
      .filter((w) => !w.isDestroyed() && !own.has(w))
      .map((w) => w.getTitle())
  })
}

/** Runs a command as if from the given window. */
export function cmdIn<T = unknown>(
  app: ElectronApplication,
  windowId: string,
  name: string,
  args: unknown = {},
): Promise<T> {
  return app.evaluate(async (_e, [w, n, a]) => (globalThis as unknown as Hooks).__orbit.run(n, a, w), [
    windowId,
    name,
    args,
  ] as const) as Promise<T>
}

/** A window's sidebar (`shell`) or overlay page. */
export async function uiPageOf(app: ElectronApplication, view: 'shell' | 'overlay', windowId: string): Promise<Page> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    for (const p of app.windows()) {
      if (!p.url().includes(`view=${view}`)) continue
      const id = await p
        .evaluate(() => (window as unknown as { orbit?: { windowId?: string } }).orbit?.windowId)
        .catch(() => undefined)
      if (id === windowId) return p
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`no ${view} page for window ${windowId}`)
}

/** Closes a window as its close button would. */
export async function closeWindow(app: ElectronApplication, windowId: string): Promise<void> {
  await app.evaluate((_e, id) => {
    ;(globalThis as unknown as Hooks).__orbit.ctx.windows.get(id)?.close()
  }, windowId)
}

/**
 * The first window's shown views from the bottom up: `page:<tab id>` for a page, `view=<name>` for
 * Orbit's own (the Library, the page tools, the loading indicator…).
 */
export function viewStack(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => {
    const { __orbit } = globalThis as unknown as Hooks
    const win = __orbit.ctx.windows.get(__orbit.windowIds()[0] as string)
    return (win?.contentView.children ?? []).flatMap((child) => {
      const contents = (child as Electron.WebContentsView).webContents
      if (!child.getVisible() || !contents || contents.isDestroyed()) return []
      const tabId = __orbit.ctx.tabs.tabIdFor(contents)
      if (tabId) return [`page:${tabId}`]
      const view = /[?&]view=([a-z]+)/.exec(contents.getURL())?.[1]
      return view ? [`view=${view}`] : []
    })
  })
}

/** Writes the state file now (it is otherwise written a moment after each change). */
export async function flushState(app: ElectronApplication): Promise<void> {
  await app.evaluate(async () => {
    await (globalThis as unknown as Hooks).__orbit.flush()
  })
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

/**
 * The pointer Orbit reads for the sidebar's edge at `x`, `y` of a window's content (default: the
 * first), inside it or not, as a real pointer no view in the window hears (fix check A, M1).
 */
export async function pointerAt(app: ElectronApplication, x: number, y: number, windowId?: string): Promise<void> {
  await app.evaluate((_e, [px, py, w]) => (globalThis as unknown as Hooks).__orbitNav.pointerAt(px, py, w), [
    x,
    y,
    windowId,
  ] as const)
}

/** A window's floating sidebar (default: the first). */
export function floatingInfo(app: ElectronApplication, windowId?: string): Promise<FloatingInfo> {
  return app.evaluate((_e, w) => (globalThis as unknown as Hooks).__orbitNav.floating(w), windowId)
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
      if (!t || t.url !== url || t.loading || t.asleep || !t.title || t.title.includes('/')) return false
      // A tab that has just woken still has its stored address and a host-name title before its load
      // starts: the page itself has to be there too.
      return app.evaluate(
        (_e, [id, u]) => {
          const page = (globalThis as unknown as Hooks).__orbit.ctx.tabs.contents(id)
          return !!page && !page.isDestroyed() && page.getURL() === u && !page.isLoading()
        },
        [tabId, url] as const,
      )
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
  type: 'mouseMove' | 'mouseDown' | 'mouseUp' | 'mouseLeave',
  x: number,
  y: number,
): Promise<void> {
  await app.evaluate(
    ({ webContents }, [part, t, px, py]) => {
      const page = webContents.getAllWebContents().find((w) => w.getURL().includes(part))
      if (!page) throw new Error(`no page with ${part}`)
      if (t === 'mouseMove' || t === 'mouseLeave') page.sendInputEvent({ type: t, x: px, y: py })
      else page.sendInputEvent({ type: t, x: px, y: py, button: 'left', clickCount: 1 })
    },
    [urlPart, type, x, y] as const,
  )
}

/** Moves the mouse over the first window's shell the way the hardware does: through the browser process. */
export async function shellMouseMove(app: ElectronApplication, x: number, y: number): Promise<void> {
  await app.evaluate(
    ({ webContents }, [px, py]) => {
      const shell = webContents.getAllWebContents().find((w) => w.getURL().includes('view=shell'))
      if (!shell) throw new Error('no shell')
      shell.sendInputEvent({ type: 'mouseMove', x: px, y: py })
    },
    [x, y] as const,
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
