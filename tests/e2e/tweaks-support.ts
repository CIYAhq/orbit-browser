/**
 * Helpers for the Tweaks e2e specs (tweaks*.spec.ts, BO-*): fixture pages, the editor panel's view,
 * what main knows of a page's Tweak sheets, and the frames a tab's page paints. Builds on helpers.ts.
 */
import { createServer, type Server } from 'node:http'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import type { TweakEditorInfo } from '../../src/main/tweaks/editor'
import type { TweakTestHooks } from '../../src/main/tweaks/index'
import type { Tweak } from '../../src/shared/state'
import { listenInRange, state } from './helpers'

export interface TweakFixtures {
  port: number
  /** A fixture URL on `host` (localhost by default). */
  url: (path: string, host?: string) => string
  /** Requests the server saw (host, method and path), newest last. */
  seen: () => string[]
  close: () => Promise<void>
}

/**
 * Records, in the page's first animation frame (just before its first paint), what that frame
 * shows: the body's background and the root's zoom. `window.__first` holds it.
 */
const FIRST_FRAME = `<script>requestAnimationFrame(() => {
  const html = getComputedStyle(document.documentElement), body = getComputedStyle(document.body)
  window.__first = { bg: body.backgroundColor, zoom: html.zoom, font: body.fontFamily }
})</script>`

const head = (title: string, bg: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='7' fill='%23e0703a'/%3E%3C/svg%3E">
<style>body{font:16px system-ui;background:${bg};margin:0;padding:32px}#block{width:240px;height:120px}
#count{font:inherit;padding:6px 12px}</style></head>`

/** The serial number of each load of a page, by path: a `/slow` page's block changes colour with it. */
const BLOCK_COLORS = ['#1f5fd6', '#18a058', '#c2410c', '#7c3aed']

/**
 * - `/page/<name>?bg=…`: a plain page: a heading, a link to `/page/<name>-next` (`#next`), a
 *   button that counts its clicks (`#count`, `window.__clicks`), a text field (`#field`) and a tall
 *   area. `window.__first` is what its first frame showed (FIRST_FRAME).
 * - `/slow/<name>?bg=…&ms=…`: sends its heading and a coloured block (`#block`, a new colour on each
 *   load) at once, and the rest of the page `ms` later (600 by default): it paints before the
 *   document is ready, as a page from a slow server does.
 */
export async function startTweakFixtures(base = 3370): Promise<TweakFixtures> {
  const seen: string[] = []
  const loads = new Map<string, number>()
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost')
    seen.push(`${req.headers.host ?? ''} ${req.method} ${u.pathname}${u.search}`)
    const name = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? 'index')
    const bg = u.searchParams.get('bg') ?? '#ffffff'
    const ok = { 'content-type': 'text/html; charset=utf-8' }
    if (u.pathname.startsWith('/page/')) {
      res.writeHead(200, ok)
      res.end(
        `${head(name, bg)}<body>${FIRST_FRAME}<h1 id="title">${name}</h1>
<p><a id="next" href="/page/${encodeURIComponent(name)}-next?bg=${encodeURIComponent(bg)}">Next page</a></p>
<p><button id="count" onclick="window.__clicks = (window.__clicks || 0) + 1; this.textContent = 'Clicked ' + window.__clicks">Count</button></p>
<p><input id="field" aria-label="Field"></p>
<div style="height:2400px"></div></body></html>`,
      )
      return
    }
    if (u.pathname.startsWith('/slow/')) {
      const n = loads.get(u.pathname) ?? 0
      loads.set(u.pathname, n + 1)
      const ms = Number(u.searchParams.get('ms') ?? 600)
      res.writeHead(200, ok)
      res.write(
        `${head(name, bg)}<body>${FIRST_FRAME}<h1 id="title">${name}</h1>
<div id="block" data-load="${n}" style="background:${BLOCK_COLORS[n % BLOCK_COLORS.length]}"></div>
<div style="height:2400px"></div>`,
      )
      const timer = setTimeout(() => res.end('<p id="end">The end</p></body></html>'), ms)
      res.on('close', () => clearTimeout(timer))
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  const port = await listenInRange(server, base)
  return {
    port,
    url: (path, host = 'localhost') => `http://${host}:${port}${path}`,
    seen: () => [...seen],
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** The colours of the `/slow` page's block, by load. */
export const SLOW_BLOCKS = BLOCK_COLORS

type Hooks = { __orbitTweaks: TweakTestHooks }

/** A window's editor panel, as main sees it (BO-02). */
export function editorInfo(app: ElectronApplication, windowId?: string): Promise<TweakEditorInfo> {
  return app.evaluate((_e, w) => (globalThis as unknown as Hooks).__orbitTweaks.editor(w), windowId)
}

/** What main has put in a tab's page (BO-18): its host, its sheets by part, and whether the preload's are in. */
export function pageTweaks(app: ElectronApplication, tabId: string): Promise<ReturnType<TweakTestHooks['page']>> {
  return app.evaluate((_e, id) => (globalThis as unknown as Hooks).__orbitTweaks.page(id), tabId)
}

/** Every Tweak, oldest first. */
export async function tweakList(app: ElectronApplication): Promise<Tweak[]> {
  return Object.values((await state(app)).tweaks).sort((a, b) => a.createdAt - b.createdAt)
}

/** The editor panel's view (view=tweak): its page exists once the panel first opened in a window. */
export async function editorPage(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const found = app.windows().find((p) => p.url().includes('view=tweak'))
    if (found) return found
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('No Tweak editor view')
}

/** Waits until the editor panel is in its window, sized and with its page laid out. */
export async function waitEditorShown(app: ElectronApplication): Promise<TweakEditorInfo> {
  await expect.poll(async () => (await editorInfo(app)).placed, { timeout: 10_000 }).toBe(true)
  return editorInfo(app)
}

/** What a page's first frame showed (FIRST_FRAME). */
export function firstFrame(page: Page): Promise<{ bg: string; zoom: string; font: string } | undefined> {
  return page.evaluate(() => (window as unknown as { __first?: { bg: string; zoom: string; font: string } }).__first)
}

/** A sampled point's colour in one painted frame, and when (ms since the recording started). */
export interface FrameSample {
  t: number
  /** `#rrggbb` at each point asked for, in order. */
  colors: string[]
}

/**
 * Starts recording what a tab's page paints: every frame its compositor sends (Electron's frame
 * subscription), sampled at points given as fractions of the page's size. `stop()` ends it.
 */
export async function recordFrames(
  app: ElectronApplication,
  tabId: string,
  points: { x: number; y: number }[],
): Promise<{ stop: () => Promise<FrameSample[]> }> {
  await app.evaluate(
    ({ webContents }, [id, at]) => {
      type G = {
        __orbit: { ctx: { tabs: { contents: (id: string) => Electron.WebContents | undefined } } }
        __tweakFrames?: { t: number; colors: string[] }[]
      }
      const g = globalThis as unknown as G
      const contents = g.__orbit.ctx.tabs.contents(id) ?? webContents.getAllWebContents()[0]
      if (!contents) throw new Error('no page')
      const frames: { t: number; colors: string[] }[] = []
      g.__tweakFrames = frames
      const t0 = Date.now()
      const hex = (n: number) => n.toString(16).padStart(2, '0')
      contents.beginFrameSubscription(false, (image) => {
        const size = image.getSize()
        const colors = at.map((p) => {
          const x = Math.min(size.width - 1, Math.max(0, Math.round(p.x * size.width)))
          const y = Math.min(size.height - 1, Math.max(0, Math.round(p.y * size.height)))
          const px = image.crop({ x, y, width: 1, height: 1 }).toBitmap()
          // BGRA
          return `#${hex(px[2] ?? 0)}${hex(px[1] ?? 0)}${hex(px[0] ?? 0)}`
        })
        frames.push({ t: Date.now() - t0, colors })
      })
    },
    [tabId, points] as const,
  )
  return {
    stop: () =>
      app.evaluate((_e, id) => {
        type G = {
          __orbit: { ctx: { tabs: { contents: (id: string) => Electron.WebContents | undefined } } }
          __tweakFrames?: { t: number; colors: string[] }[]
        }
        const g = globalThis as unknown as G
        g.__orbit.ctx.tabs.contents(id)?.endFrameSubscription()
        const frames = g.__tweakFrames ?? []
        g.__tweakFrames = undefined
        return frames
      }, tabId),
  }
}

/** Whether two `#rrggbb` colours are within `tolerance` on every channel. */
export function near(a: string, b: string, tolerance = 6): boolean {
  const ch = (s: string, i: number) => Number.parseInt(s.slice(1 + 2 * i, 3 + 2 * i), 16)
  return [0, 1, 2].every((i) => Math.abs(ch(a, i) - ch(b, i)) <= tolerance)
}
