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
import { listenInRange, state, tabPage } from './helpers'
import { newTab, waitTab } from './tabs-support'

export interface TweakFixtures {
  port: number
  /** A fixture URL on `host` (localhost by default). */
  url: (path: string, host?: string) => string
  /** Requests the server saw (host, method and path), newest last. */
  seen: () => string[]
  /** From now on the home page (`/`) answers `ms` late, as a slow server does (0: at once). */
  slowHome: (ms: number) => void
  /** From now on the home page (`/`) drops the connection unanswered, as a site that doesn't load does (false: answers). */
  dropHome: (drop: boolean) => void
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

/**
 * The `/look` page's photo: one solid colour, so its pixels say whether it kept its colours. A dark
 * blue: its negative is light. (A mid-tone such as orange is nearly its own negative once inverted
 * and turned back, so it can't tell.)
 */
export const PHOTO = '#20406a'
const PHOTO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="${PHOTO}"/></svg>`

/**
 * A page's `<head>` script: every sheet the page can read (`document.styleSheets` and its adopted
 * sheets), with its media and rules, now (`window.__readable`) and later (`window.__read()`).
 */
const READ_SHEETS = `<script>(() => {
  const rules = (sheet) => { try { return Array.from(sheet.cssRules, (r) => r.cssText).join('\\n') } catch (e) { return '(unreadable)' } }
  window.__read = () => [...document.styleSheets, ...document.adoptedStyleSheets].map((sheet) => ({ media: sheet.media.mediaText, rules: rules(sheet) }))
  window.__readable = window.__read()
})()</script>`

/** A page's `<head>` script that sets its adopted sheets to one of its own, as some sites do. */
const ADOPT_OWN = `<script>(() => {
  const own = new CSSStyleSheet()
  own.replaceSync('#title { letter-spacing: 0.5px }')
  document.adoptedStyleSheets = [own]
})()</script>`

/** The serial number of each load of a page, by path: a `/slow` page's block changes colour with it. */
const BLOCK_COLORS = ['#1f5fd6', '#18a058', '#c2410c', '#7c3aed']

/**
 * - `/page/<name>?bg=…`: a plain page: a heading, a link to `/page/<name>-next` (`#next`), a
 *   button that counts its clicks (`#count`, `window.__clicks`), a text field (`#field`) and a tall
 *   area. `window.__first` is what its first frame showed (FIRST_FRAME).
 * - `/framed/<name>?other=<url>`: a page with a frame (`#inner`) showing another address.
 * - `/slow/<name>?bg=…&ms=…`: sends its heading and a coloured block (`#block`, a new colour on each
 *   load) at once, and the rest of the page `ms` later (600 by default): it paints before the
 *   document is ready, as a page from a slow server does. Its `<head>` script notes every sheet it
 *   can read, with its media and rules (`window.__readable`, and `window.__read()` for later); with
 *   `adopt=1` it then sets its adopted sheets to one of its own, dropping any others; with `layer=1`
 *   its background is also set in a cascade layer of its own, `!important`.
 * - `/held/<name>?bg=…&ms=…`: a whole page, ready at once, whose image (`#held`) comes `ms` late
 *   (0 by default): the page is still loading until then.
 * - `/look/<name>`: text (`#text`), an icon (`#icon`), code (`#code`), a photo (`#photo`, a solid
 *   PHOTO square) and a field (`#field`): what the colour, font and case controls change or keep.
 * - `/`: a home page (`#title` "Home"), where the Library's Open Site goes (BO-15); `slowHome` makes
 *   it late, so its page asks for its sheets only then, and `dropHome` drops it (no answer at all).
 * - `/cards/<name>`: a counting button (`#count`); a sidebar (`aside.sidebar`) with a widget
 *   (`#weather`) and two small stories; a feed (`main.feed`) with a promo link (`#promo`) and four
 *   stories (`article.story`); three links (`li.story`). Stories are padded: a point just inside one's
 *   corner is the story itself. `window.__first` is what its first frame showed:
 *   whether the promo and the widget were displayed, and how many stories. With `hidden=1` the feed
 *   has a fifth story the page itself hides (`hidden`).
 */
export async function startTweakFixtures(base = 3370): Promise<TweakFixtures> {
  const seen: string[] = []
  const loads = new Map<string, number>()
  let homeMs = 0
  let homeDrops = false
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
    if (u.pathname.startsWith('/framed/')) {
      // A page with a frame from another address (`other`), as a site embeds another's (BO-18).
      res.writeHead(200, ok)
      res.end(
        `${head(name, bg)}<body>${FIRST_FRAME}<h1 id="title">${name}</h1>
<iframe id="inner" title="Inner" src="${(u.searchParams.get('other') ?? '').replace(/"/g, '&quot;')}" style="width:400px;height:200px"></iframe>
</body></html>`,
      )
      return
    }
    if (u.pathname.startsWith('/look/')) {
      res.writeHead(200, ok)
      res.end(
        `${head(name, bg)}<body>${FIRST_FRAME}<h1 id="title">${name}</h1>
<p id="text">The quick brown fox jumps over the lazy dog.</p>
<p><i class="icon" id="icon" style="font-family: monospace">*</i> <code id="code">let x = 1</code></p>
<p><img id="photo" alt="Photo" width="120" height="120" src="data:image/svg+xml,${encodeURIComponent(PHOTO_SVG)}"></p>
<p><input id="field" aria-label="Field" value="Mixed Case Text"></p>
<div style="height:1600px"></div></body></html>`,
      )
      return
    }
    if (u.pathname.startsWith('/cards/')) {
      const story = (n: string) => `<article class="story"><h2>Story ${n}</h2><p>About ${n}</p></article>`
      res.writeHead(200, ok)
      res.end(
        `${head(name, bg)}<body><style>.story { padding: 10px 14px; margin: 8px 0 }</style><h1 id="title">${name}</h1>
<p><button id="count" onclick="window.__clicks = (window.__clicks || 0) + 1">Count</button></p>
<div class="layout" style="display:flex;gap:24px;align-items:flex-start">
<aside class="sidebar" style="width:220px">
<section class="widget" id="weather" aria-label="Weather" style="padding:8px;background:#dbeafe"><h3>Weather</h3><p>Sunny</p></section>
<article class="story mini"><h3>Mini one</h3></article><article class="story mini"><h3>Mini two</h3></article>
</aside>
<main class="feed" style="flex:1">
<a id="promo" class="promo" href="/page/Away" style="display:block;padding:12px;background:#ffe9a8">Big promo</a>
${['one', 'two', 'three', 'four'].map(story).join('\n')}
${u.searchParams.get('hidden') === '1' ? '<article class="story" hidden><h2>Story five</h2></article>' : ''}
</main></div>
<ul class="links"><li class="story">Link one</li><li class="story">Link two</li><li class="story">Link three</li></ul>
<script>requestAnimationFrame(() => {
  const shown = (el) => !!el && getComputedStyle(el).display !== 'none'
  window.__first = { promo: shown(document.getElementById('promo')), weather: shown(document.getElementById('weather')),
    stories: [...document.querySelectorAll('.story')].filter(shown).length }
})</script>
</body></html>`,
      )
      return
    }
    if (u.pathname.startsWith('/slow/')) {
      const n = loads.get(u.pathname) ?? 0
      loads.set(u.pathname, n + 1)
      const ms = Number(u.searchParams.get('ms') ?? 600)
      const layer =
        u.searchParams.get('layer') === '1'
          ? `<style>@layer base { body { background: ${bg} !important } }</style>`
          : ''
      res.writeHead(200, ok)
      res.write(
        `${head(name, bg).replace('</head>', `${layer}${READ_SHEETS}${u.searchParams.get('adopt') === '1' ? ADOPT_OWN : ''}</head>`)}<body>${FIRST_FRAME}<h1 id="title">${name}</h1>
<div id="block" data-load="${n}" style="background:${BLOCK_COLORS[n % BLOCK_COLORS.length]}"></div>
<div style="height:2400px"></div>`,
      )
      const timer = setTimeout(() => res.end('<p id="end">The end</p></body></html>'), ms)
      res.on('close', () => clearTimeout(timer))
      return
    }
    if (u.pathname.startsWith('/held/')) {
      const n = loads.get(u.pathname) ?? 0
      loads.set(u.pathname, n + 1)
      const ms = Number(u.searchParams.get('ms') ?? 0)
      res.writeHead(200, ok)
      res.end(
        `${head(name, bg)}<body>${FIRST_FRAME}<h1 id="title">${name}</h1>
<p><img id="held" alt="Held" width="40" height="40" src="/img/held.svg?ms=${ms}&amp;n=${n}"></p>
<div style="height:2400px"></div></body></html>`,
      )
      return
    }
    if (u.pathname.startsWith('/img/')) {
      const ms = Number(u.searchParams.get('ms') ?? 0)
      const send = () => {
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' })
        res.end(PHOTO_SVG)
      }
      if (ms <= 0) {
        send()
        return
      }
      const timer = setTimeout(send, ms)
      res.on('close', () => clearTimeout(timer))
      return
    }
    if (u.pathname === '/') {
      if (homeDrops) {
        req.socket.destroy()
        return
      }
      const send = () => {
        res.writeHead(200, ok)
        res.end(`${head('Home', bg)}<body>${FIRST_FRAME}<h1 id="title">Home</h1></body></html>`)
      }
      if (homeMs <= 0) {
        send()
        return
      }
      const timer = setTimeout(send, homeMs)
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
    slowHome: (ms) => {
      homeMs = ms
    },
    dropHome: (drop) => {
      homeDrops = drop
    },
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

/** The editor panel's view in one window (each window has its own). */
export async function editorPageOf(app: ElectronApplication, windowId: string): Promise<Page> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    for (const p of app.windows()) {
      if (!p.url().includes('view=tweak')) continue
      const id = await p
        .evaluate(() => (window as unknown as { orbit?: { windowId?: string } }).orbit?.windowId)
        .catch(() => undefined)
      if (id === windowId) return p
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`No Tweak editor view in window ${windowId}`)
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

/** A tab on fixture page `path` (on `host`), loaded, and its page. */
export async function openFixture(
  app: ElectronApplication,
  fx: TweakFixtures,
  path: string,
  host?: string,
): Promise<{ tabId: string; page: Page }> {
  const tabId = await newTab(app, fx.url(path, host))
  const part = path.split('?')[0] as string
  await waitTab(app, tabId, part)
  return { tabId, page: await tabPage(app, part) }
}

/** The editor's state in main, polled until it is open on a Tweak (and placed), or closed. */
export async function waitEditor(app: ElectronApplication, open: boolean): Promise<void> {
  if (open) await waitEditorShown(app)
  else await expect.poll(async () => (await editorInfo(app)).open).toBe(false)
}

/** The Tweak the open editor shows. */
export async function edited(app: ElectronApplication): Promise<Tweak> {
  const info = await editorInfo(app)
  const tweak = info.tweakId ? (await state(app)).tweaks[info.tweakId] : undefined
  if (!tweak) throw new Error('the editor shows no Tweak')
  return tweak
}

/** The page's root zoom now (BO-08's size is a zoom on the root). */
export const zoomOf = (page: Page): Promise<string> =>
  page.evaluate(() => getComputedStyle(document.documentElement).zoom)

/** The page body's background colour now. */
export const bgOf = (page: Page): Promise<string> =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor).catch(() => '')

/** The colour of one pixel of a tab's page as painted (`#rrggbb`), at a point in the page's CSS pixels. */
export function pixelAt(app: ElectronApplication, tabId: string, x: number, y: number): Promise<string> {
  return app.evaluate(
    async (_e, [id, px, py]) => {
      type G = { __orbit: { ctx: { tabs: { contents: (id: string) => Electron.WebContents | undefined } } } }
      const contents = (globalThis as unknown as G).__orbit.ctx.tabs.contents(id)
      if (!contents) throw new Error('no page')
      const image = await contents.capturePage({ x: Math.round(px), y: Math.round(py), width: 1, height: 1 })
      const bitmap = image.toBitmap()
      const hex = (n: number | undefined) => (n ?? 0).toString(16).padStart(2, '0')
      // BGRA
      return `#${hex(bitmap[2])}${hex(bitmap[1])}${hex(bitmap[0])}`
    },
    [tabId, x, y] as const,
  )
}

/** A `#rrggbb` colour as numbers. */
export const rgbOf = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
]

/** What Hide-element mode's picker in a tab's page says (BO-10), or null where there is none. */
export function pickerInfo(app: ElectronApplication, tabId: string): ReturnType<TweakTestHooks['picker']> {
  return app.evaluate((_e, id) => (globalThis as unknown as Hooks).__orbitTweaks.picker(id), tabId)
}

/** Marks a page's document, to tell whether it was replaced (a reload or a navigation). */
export const mark = (page: Page): Promise<unknown> => page.evaluate(() => Object.assign(window, { __mark: 1 }))
export const marked = (page: Page): Promise<boolean> =>
  page.evaluate(() => (window as unknown as { __mark?: number }).__mark === 1).catch(() => false)

/** Waits until a page's document is a new one that has painted (its first frame was noted). */
export async function newDocument(page: Page): Promise<void> {
  await expect
    .poll(async () => !(await marked(page)) && !!(await firstFrame(page).catch(() => undefined)), { timeout: 15_000 })
    .toBe(true)
}
