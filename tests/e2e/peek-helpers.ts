import { createServer, type Server } from 'node:http'
import { type ElectronApplication, expect, type Page } from '@playwright/test'
import type { MainContext } from '../../src/main/context'
import type { OrbitState, WindowState } from '../../src/shared/state'
import { listenInRange, state } from './helpers'

/** The main process's test handle (src/main/test-hooks.ts), for app.evaluate() bodies. */
export type OrbitGlobal = { __orbit: { ctx: MainContext } }

/**
 * Fixture site for Peek and Mini Window tests, served on two "sites" of the same loopback
 * server: `localhost` and `127.0.0.1` count as different sites (different registrable names).
 */
export interface Sites {
  /** A page on the first site (localhost). */
  url: (path: string) => string
  /** The same path on the other site (127.0.0.1). */
  other: (path: string) => string
  /** Every request the sites have received, oldest first, with its body. */
  requests: () => Received[]
  close: () => Promise<void>
}

export interface Received {
  method: string
  path: string
  body: string
}

const page = (title: string, body: string, bg: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;background:${bg};margin:0;padding:32px}a{color:#3b4bdb;display:inline-block;padding:4px}</style></head>
<body><h1 id="title">${title}</h1>${body}<div style="height:3000px"></div><p id="end">End of ${title}</p></body></html>`

/**
 * A page of things that navigate without being links, as on a sign-in page: a form posted to the
 * other site, a button whose script goes there, and a same-site sign-in whose answer posts a
 * sign-in assertion on to the other site by itself (as SAML and OIDC form_post sign-ins do).
 */
const formsPage = (self: string, other: string) =>
  page(
    'Forms',
    `<form method="post" action="${other}/post/target"><input name="user" value="alice"><button id="send">Send</button></form>
     <p><button id="script" onclick="location.href = '${other}/site/Landing'">Sign in with Other</button></p>
     <form method="post" action="${self}/idp/login"><input type="hidden" name="user" value="alice"><button id="sign-in">Sign in</button></form>
     <p><a id="twice" href="${other}/site/Twice" onclick="location.href = this.href">Other site, and a script</a></p>
     <div id="card" onclick="location.href = this.querySelector('a').href" style="padding:8px;border:1px solid #ccc">
       <a id="card-link" href="${other}/site/Card">A card on another site</a><p>The whole card is clickable.</p></div>`,
    '#fff8ec',
  )

/** The sign-in answer that posts itself on to the other site. */
const autoPost = (other: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Redirecting</title></head>
<body><p>Redirecting…</p><form method="post" action="${other}/saml/acs"><input type="hidden" name="SAMLResponse" value="assertion-for-alice"></form>
<script>document.forms[0].submit()</script></body></html>`

export async function startSites(): Promise<Sites> {
  let port = 0
  const received: Received[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://localhost')
      received.push({ method: req.method ?? '', path: u.pathname, body: Buffer.concat(chunks).toString() })
      const other = `http://127.0.0.1:${port}`
      const self = `http://${req.headers.host ?? `localhost:${port}`}`
      const html = (body: string) => {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(body)
      }
      if (u.pathname === '/forms') return html(formsPage(self, other))
      if (u.pathname === '/idp/login' && req.method === 'POST') return html(autoPost(other))
      if (u.pathname === '/post/target' || u.pathname === '/saml/acs') {
        return html(page(`${req.method} ${u.pathname}`, '', '#eefbf0'))
      }
      if (!u.pathname.startsWith('/site/')) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
        return
      }
      const title = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? 'index')
      html(
        page(
          title,
          `<p><a id="same" href="${self}/site/${title}-Same">Same site</a>
         <a id="other" href="${other}/site/Other">Other site</a>
         <a id="other-blank" href="${other}/site/OtherBlank" target="_blank">Other site, new tab</a>
         <a id="meeting" href="https://meet.google.com/abc-defg-hij">Join the call</a>
         <a id="next" href="${self}/site/${title}-Next">Next page</a>
         <a id="blank-same" href="${self}/site/${title}-Blank" target="_blank">Same site, new tab</a></p>`,
          u.searchParams.get('bg') ?? '#f4f0ff',
        ),
      )
    })
  })
  // From 3350 up (helpers.ts's fixtures start at 3300).
  port = await listenInRange(server, 3350 + (Number(process.env.TEST_PARALLEL_INDEX ?? 0) % 50))
  return {
    url: (path) => `http://localhost:${port}${path}`,
    other: (path) => `http://127.0.0.1:${port}${path}`,
    requests: () => received.slice(),
    close: () => new Promise((r) => server.close(() => r())),
  }
}

/** The first main window's state. */
export async function mainWindow(app: ElectronApplication): Promise<WindowState> {
  const s = await state(app)
  return Object.values(s.windows).find((w) => w.kind === 'main') as WindowState
}

export async function overlayOf(app: ElectronApplication): Promise<WindowState['overlay']> {
  return (await mainWindow(app)).overlay
}

/** Sidebar rows of a Space (pinned and Today) plus the profile's Favorites. */
export function sidebarCount(s: OrbitState, spaceId: string): number {
  const space = s.spaces[spaceId]
  const favorites = space ? (s.profiles[space.profileId]?.favorites.length ?? 0) : 0
  return (space?.pinned.length ?? 0) + (space?.today.length ?? 0) + favorites
}

/** The page area (window coordinates) and a tab view's bounds, visibility and z-position. */
export async function viewInfo(app: ElectronApplication, tabId: string) {
  return app.evaluate((_e, id) => {
    const ctx = (globalThis as unknown as OrbitGlobal).__orbit.ctx
    const windowId = ctx.windows.ids()[0] as string
    const win = ctx.windows.get(windowId)
    const view = ctx.tabs.get(id)
    const children = win?.contentView.children ?? []
    const overlayIndex = children.findIndex((v) => {
      const wc = (v as Electron.WebContentsView).webContents
      return !!wc && !wc.isDestroyed() && wc.getURL().includes('view=overlay')
    })
    return {
      area: ctx.windows.pageArea(windowId) ?? null,
      bounds: view?.getBounds() ?? null,
      visible: view?.getVisible() ?? false,
      inWindow: !!view && children.includes(view),
      aboveOverlay: !!view && children.indexOf(view) > overlayIndex,
      contentsId: view && !view.webContents.isDestroyed() ? view.webContents.id : null,
      url: view && !view.webContents.isDestroyed() ? view.webContents.getURL() : null,
    }
  }, tabId)
}

/** Runs script in a tab's page, giving up after a while instead of hanging. */
export async function inTab(app: ElectronApplication, tabId: string, code: string): Promise<string> {
  return app.evaluate(
    (_e, [id, js]) => {
      const contents = (globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs.get(id)?.webContents
      if (!contents || contents.isDestroyed()) return Promise.resolve('no page')
      return Promise.race([
        contents.executeJavaScript(js, true).then((v) => String(v)),
        new Promise<string>((r) => setTimeout(() => r('timeout'), 10_000)),
      ])
    },
    [tabId, code] as const,
  )
}

/** Finds the Playwright page for a tab whose URL contains `part` (excluding Orbit UI). */
export async function findPage(app: ElectronApplication, part: string): Promise<Page> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const found = app.windows().find((p) => p.url().includes(part) && !p.url().includes('view='))
    if (found) return found
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`No page with ${part}`)
}

/** Keeps pages from reaching the network: requests to hosts other than the fixtures fail fast. */
export async function blockNetwork(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ session }) => {
    const ctx = (globalThis as unknown as OrbitGlobal).__orbit.ctx
    for (const profile of Object.values(ctx.store.state.profiles)) {
      session.fromPartition(profile.partition).webRequest.onBeforeRequest((details, callback) => {
        const host = new URL(details.url).hostname
        callback({ cancel: /^https?:/.test(details.url) && host !== 'localhost' && host !== '127.0.0.1' })
      })
    }
  })
}

/**
 * Presses a key in a tab's page the way the OS delivers it, through the browser's key handling
 * (Orbit's shortcuts listen there). Playwright's own key presses are injected below that level.
 * `accel` is like "Mod+O" (Mod = ⌘ on macOS, Ctrl elsewhere), "Escape" or "Shift+Mod+T".
 */
export async function pressInTab(app: ElectronApplication, tabId: string, accel: string): Promise<void> {
  await app.evaluate(
    (_e, [id, keys, mac]) => {
      const contents = (globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs.contents(id)
      if (!contents) throw new Error(`no page for ${id}`)
      const parts = keys.split('+')
      const keyCode = parts.pop() as string
      const modifiers = parts.map((m) => (m === 'Mod' ? (mac ? 'meta' : 'control') : m.toLowerCase())) as (
        | 'shift'
        | 'control'
        | 'alt'
        | 'meta'
      )[]
      contents.focus()
      contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      if (keyCode.length === 1 && modifiers.length === 0) contents.sendInputEvent({ type: 'char', keyCode, modifiers })
      contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    },
    [tabId, accel, process.platform === 'darwin'] as const,
  )
}

/** Moves the pointer to a point of a tab's page, through the browser's input handling. */
export async function pointerTo(app: ElectronApplication, tabId: string, point: { x: number; y: number }) {
  await app.evaluate(
    (_e, [id, x, y]) => {
      const contents = (globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs.contents(id)
      if (!contents) throw new Error(`no page for ${id}`)
      contents.sendInputEvent({ type: 'mouseMove', x, y })
    },
    [tabId, point.x, point.y] as const,
  )
}

/**
 * Clicks a point of a tab's page through the browser's input handling, holding modifier keys the
 * way a person does (their key presses come first). Playwright's modifier clicks bypass that path.
 * The pointer gets there first, as a real one does.
 */
export async function clickInTab(
  app: ElectronApplication,
  tabId: string,
  point: { x: number; y: number },
  modifiers: ('control' | 'alt' | 'meta' | 'shift')[] = [],
): Promise<void> {
  await app.evaluate(
    (_e, [id, x, y, mods]) => {
      const contents = (globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs.contents(id)
      if (!contents) throw new Error(`no page for ${id}`)
      const key = (m: string) => ({ control: 'Control', alt: 'Alt', meta: 'Meta', shift: 'Shift' })[m] as string
      contents.sendInputEvent({ type: 'mouseMove', x, y })
      const held: typeof mods = []
      for (const m of mods) {
        held.push(m)
        contents.sendInputEvent({ type: 'keyDown', keyCode: key(m), modifiers: [...held] })
      }
      contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1, modifiers: mods })
      contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1, modifiers: mods })
      for (const m of [...mods].reverse()) {
        held.pop()
        contents.sendInputEvent({ type: 'keyUp', keyCode: key(m), modifiers: [...held] })
      }
    },
    [tabId, point.x, point.y, modifiers] as const,
  )
}

/** Where a Peek's page view was at a moment (main's wall clock). */
export interface ViewSample {
  wall: number
  x: number
  y: number
  width: number
  height: number
  /** In sight: shown in the window, with more than its corner pixel inside it. */
  shown: boolean
}

/**
 * In main, from now: polls every millisecond where the open Peek's page view is (and, once the Peek
 * has become a tab, that tab's view), and keeps a sample at each change of its bounds or of whether
 * it is in sight. Returns a reader, which stops the polling.
 */
export async function watchPeekView(app: ElectronApplication): Promise<() => Promise<ViewSample[]>> {
  await app.evaluate(() => {
    type Watch = { samples: ViewSample[]; timer: ReturnType<typeof setInterval> }
    const g = globalThis as unknown as OrbitGlobal & { __peekView?: Watch }
    const ctx = g.__orbit.ctx
    if (g.__peekView) clearInterval(g.__peekView.timer)
    const windowId = ctx.windows.ids()[0] as string
    const samples: ViewSample[] = []
    let tabId: string | undefined
    const timer = setInterval(() => {
      const overlay = ctx.store.state.windows[windowId]?.overlay
      if (overlay?.kind === 'peek') tabId = overlay.tabId
      const win = ctx.windows.get(windowId)
      const view = tabId ? ctx.tabs.get(tabId) : undefined
      if (!win || win.isDestroyed() || !view || view.webContents.isDestroyed()) return
      const b = view.getBounds()
      const [cw = 0, ch = 0] = win.getContentSize()
      const w = Math.max(0, Math.min(b.x + b.width, cw) - Math.max(b.x, 0))
      const h = Math.max(0, Math.min(b.y + b.height, ch) - Math.max(b.y, 0))
      const shown = view.getVisible() && win.contentView.children.includes(view) && w * h > 1
      const last = samples.at(-1)
      const same = last && last.x === b.x && last.y === b.y && last.width === b.width && last.height === b.height
      if (same && last.shown === shown) return
      samples.push({ wall: performance.timeOrigin + performance.now(), ...b, shown })
    }, 1)
    // A test that never reads it stops it anyway.
    setTimeout(() => clearInterval(timer), 15_000)
    g.__peekView = { samples, timer }
  })
  return () =>
    app.evaluate(() => {
      const g = globalThis as unknown as {
        __peekView?: { samples: ViewSample[]; timer: ReturnType<typeof setInterval> }
      }
      if (g.__peekView) clearInterval(g.__peekView.timer)
      return g.__peekView?.samples ?? []
    })
}

/**
 * How a Peek's page view went (PK-06): how often its size changed (each change lays its page out
 * again), and how many samples had it in sight anywhere but where it was first or last (a page shown
 * mid-motion).
 */
export function viewMoves(samples: ViewSample[]): { resizes: number; shownElsewhere: number } {
  const first = samples[0]
  const last = samples.at(-1)
  let resizes = 0
  for (let k = 1; k < samples.length; k++) {
    const a = samples[k - 1] as ViewSample
    const b = samples[k] as ViewSample
    if (a.width !== b.width || a.height !== b.height) resizes++
  }
  const at = (v: ViewSample, o: ViewSample | undefined) =>
    !!o && v.x === o.x && v.y === o.y && v.width === o.width && v.height === o.height
  const shownElsewhere = samples.filter((v) => v.shown && !at(v, first) && !at(v, last)).length
  return { resizes, shownElsewhere }
}

/** Waits until the Peek's card shows a still of its page, whole (main takes one once the page has drawn). */
export async function stillReady(overlay: Page): Promise<void> {
  const still = overlay.getByTestId('peek-still')
  await expect(still).toHaveAttribute('data-ready', 'true')
  await expect.poll(() => still.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
}
