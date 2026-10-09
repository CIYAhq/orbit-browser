import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Page } from '@playwright/test'
import type { MainContext } from '../../src/main/context'
import type { OrbitState, WindowState } from '../../src/shared/state'
import { state } from './helpers'

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
  close: () => Promise<void>
}

const page = (title: string, body: string, bg: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;background:${bg};margin:0;padding:32px}a{color:#3b4bdb;display:inline-block;padding:4px}</style></head>
<body><h1 id="title">${title}</h1>${body}<div style="height:3000px"></div><p id="end">End of ${title}</p></body></html>`

export async function startSites(): Promise<Sites> {
  let port = 0
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost')
    const title = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? 'index')
    if (!u.pathname.startsWith('/site/')) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    const other = `http://127.0.0.1:${port}`
    const self = `http://${req.headers.host ?? `localhost:${port}`}`
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(
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
  // Ports 3350-3399 (helpers.ts's fixtures use 3300-3349).
  const base = 3350 + (Number(process.env.TEST_PARALLEL_INDEX ?? 0) % 50)
  await new Promise<void>((resolve, reject) => {
    let p = base
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && p < 3399) server.listen(++p, '127.0.0.1')
      else reject(err)
    })
    server.listen(p, '127.0.0.1', () => resolve())
  })
  port = (server.address() as AddressInfo).port
  return {
    url: (path) => `http://localhost:${port}${path}`,
    other: (path) => `http://127.0.0.1:${port}${path}`,
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

/**
 * Clicks a point of a tab's page through the browser's input handling, holding modifier keys the
 * way a person does (their key presses come first). Playwright's modifier clicks bypass that path.
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
