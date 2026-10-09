#!/usr/bin/env node
/**
 * Records a scripted Orbit scenario as a raw screen capture (for parity clips
 * and screenshots). Drives the built app with Playwright while ffmpeg grabs
 * the X display, so native tab views are captured exactly as composited.
 *
 * Needs an ffmpeg with x11grab (set ORBIT_FFMPEG to its path) and a display:
 *   xvfb-run -a -s "-screen 0 1440x900x24" node scripts/capture/record.mjs <scenario> [--out clips/<scenario>.mp4] [--shots dir]
 *
 * Scenarios live in scripts/capture/scenarios/<name>.mjs and export
 * `default async function (t)`; see helpers in `makeToolkit` below.
 */
import { execFile, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron as electron } from '@playwright/test'

const argv = process.argv.slice(2)
const scenario = argv.find((a) => !a.startsWith('--'))
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : fallback
}
if (!scenario) {
  console.error('usage: record.mjs <scenario> [--out file.mp4] [--shots dir] [--size 1440x900]')
  process.exit(2)
}
const scenarioName = basename(scenario, '.mjs')
const OUT = resolve(opt('out', `clips/${scenarioName}.mp4`))
const SHOTS = opt('shots') ? resolve(opt('shots')) : undefined
const [W, H] = opt('size', '1440x900').split('x').map(Number)
const FFMPEG = process.env.ORBIT_FFMPEG ?? 'ffmpeg'
const DISPLAY = process.env.DISPLAY
if (!DISPLAY) throw new Error('No DISPLAY: run under xvfb-run')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Where the window's content starts on the display, and where the pointer is (page coordinates). */
let origin = { x: 0, y: 0 }
let pointer = { x: 0, y: 0 }
/**
 * The recording shows the X pointer, which Playwright's input never moves, so xdotool moves it along
 * (skipped quietly where xdotool isn't installed).
 */
const xPointer = (x, y) =>
  new Promise((r) =>
    execFile('xdotool', ['mousemove', String(Math.round(origin.x + x)), String(Math.round(origin.y + y))], () => r()),
  )
const log = (...m) => console.error(`[capture ${new Date().toISOString().slice(11, 19)}]`, ...m)

/** Local pages for demos that must not depend on the network. */
async function startFixtures() {
  const accents = ['#e5484d', '#3e63dd', '#30a46c', '#f76b15', '#8e4ec6', '#12a594', '#d6409f', '#ffb224']
  const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const server = createServer((req, res) => {
    const raw = (req.url ?? '/').split('/').pop() || 'Home'
    let name = raw
    try {
      name = decodeURIComponent(raw)
    } catch {
      // A malformed escape: show the name as it came.
    }
    const accent = accents[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % accents.length]
    const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${accent}"/><text x="16" y="22" font-family="Arial,sans-serif" font-size="17" font-weight="700" fill="#fff" text-anchor="middle">${esc(name[0] ?? '?')}</text></svg>`
    const cards = ['Overview', 'Recent', 'Shared with you', 'Starred', 'Activity', 'Ideas']
      .map(
        (c, i) =>
          `<div class="card"><div class="dot" style="opacity:${0.35 + (i % 3) * 0.2}"></div><h3>${c}</h3><p>Local demo content for ${esc(name)}. Nothing here comes from the network.</p></div>`,
      )
      .join('')
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(name)}</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(icon)}">
<style>
:root{color-scheme:light}body{font:16px/1.55 system-ui,sans-serif;margin:0;background:#fafafa;color:#1d1d1f}
header{display:flex;align-items:center;gap:12px;padding:18px 40px;background:#fff;border-bottom:1px solid #eee}
header .logo{width:30px;height:30px;border-radius:8px;background:${accent}}header b{font-size:18px}
header nav{margin-left:auto;display:flex;gap:22px;color:#666;font-size:14px}
main{padding:40px;max-width:1100px}h1{font-size:40px;margin:8px 0 6px;letter-spacing:-0.02em}
.lead{color:#555;max-width:60ch;margin:0 0 28px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}
.card{background:#fff;border:1px solid #eee;border-radius:14px;padding:18px}.card h3{margin:10px 0 4px;font-size:16px}
.card p{margin:0;color:#666;font-size:14px}.dot{width:36px;height:36px;border-radius:10px;background:${accent}}
</style></head><body><header><div class="logo"></div><b>${esc(name)}</b><nav><span>Home</span><span>Library</span><span>Settings</span></nav></header>
<main><h1>${esc(name)}</h1><p class="lead">A local demo page for Orbit screen captures, served from 127.0.0.1.</p><div class="grid">${cards}</div></main></body></html>`)
  })
  let port = 3380
  await new Promise((ok, fail) => {
    server.on('error', (err) =>
      err.code === 'EADDRINUSE' && port < 3399 ? server.listen(++port, '127.0.0.1') : fail(err),
    )
    server.listen(port, '127.0.0.1', ok)
  })
  return { url: (name) => `http://127.0.0.1:${port}/${encodeURIComponent(name)}`, close: () => server.close() }
}

function startRecorder(file) {
  mkdirSync(dirname(file), { recursive: true })
  const ff = spawn(
    FFMPEG,
    [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'x11grab',
      '-draw_mouse',
      '1',
      '-framerate',
      '30',
      '-video_size',
      `${W}x${H}`,
      '-i',
      DISPLAY,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      file,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  )
  return {
    stop: () =>
      new Promise((done) => {
        ff.on('exit', done)
        ff.stdin.write('q')
        ff.stdin.end()
        setTimeout(() => ff.kill('SIGINT'), 5000)
      }),
  }
}

function screenshot(file) {
  mkdirSync(dirname(file), { recursive: true })
  return new Promise((done, fail) => {
    const ff = spawn(FFMPEG, [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'x11grab',
      '-video_size',
      `${W}x${H}`,
      '-i',
      DISPLAY,
      '-frames:v',
      '1',
      file,
    ])
    ff.on('exit', (code) => (code === 0 ? done(file) : fail(new Error(`screenshot failed (${code})`))))
  })
}

function makeToolkit(app, shell, fx) {
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const overlay = async () => {
    for (let i = 0; i < 100; i++) {
      const page = app.windows().find((p) => p.url().includes('view=overlay'))
      if (page) return page
      await sleep(50)
    }
    throw new Error('no overlay page')
  }
  let shotNo = 0
  return {
    app,
    shell,
    fx,
    mod,
    sleep,
    overlay,
    /** Run a main-process command (test hook). */
    run: (name, args = {}) =>
      app.evaluate((_e, [n, a]) => globalThis.__orbit.run(n, a, globalThis.__orbit.windowIds()[0]), [name, args]),
    action: (id) => app.evaluate((_e, a) => globalThis.__orbit.action(a, globalThis.__orbit.windowIds()[0]), id),
    state: () => app.evaluate(() => globalThis.__orbit.state()),
    /** Press a shortcut in the shell, e.g. key('Mod+T'). */
    key: (combo) => shell.keyboard.press(combo.replace('Mod', mod)),
    /** Type like a person (for command bar demos). */
    type: async (page, text, delay = 70) => {
      for (const ch of text) {
        await page.keyboard.type(ch)
        await sleep(delay * (0.6 + Math.random() * 0.8))
      }
    },
    /** Moves the pointer smoothly (eased) to the centre of a locator, on screen too. */
    point: async (locator, steps = 18) => {
      const box = await locator.boundingBox()
      if (!box) return
      const from = pointer
      const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      for (let i = 1; i <= steps; i++) {
        const k = 0.5 - 0.5 * Math.cos((Math.PI * i) / steps)
        const x = from.x + (to.x - from.x) * k
        const y = from.y + (to.y - from.y) * k
        await shell.mouse.move(x, y)
        await xPointer(x, y)
      }
      pointer = to
    },
    shot: async (name) => {
      if (!SHOTS) return
      shotNo++
      log('screenshot', name)
      await screenshot(join(SHOTS, `${scenarioName}-${String(shotNo).padStart(2, '0')}-${name}.png`))
    },
  }
}

/**
 * Captures stay offline. Orbit runs behind a dead local proxy, which stops everything it and the engine
 * would fetch (WebSockets, IP literals, Chromium's own downloads such as spell-check dictionaries),
 * while loopback, where the fixture pages are served, bypasses proxies.
 */
const OFFLINE_PROXY = '127.0.0.1:9'

/**
 * Puts every session Orbit has, and every one it makes later, on the dead proxy, and cancels any request
 * that isn't to the fixture server (WebSockets included) as a second layer. The command line's proxy
 * alone can reach a new session a moment late. Returns how each session now resolves a web address.
 */
const sealOffline = (app) =>
  app.evaluate(async ({ app: electronApp, session, webContents }, rules) => {
    const local = /^(https?|wss?):\/\/(127\.0\.0\.1|localhost)(:\d+)?\//
    const seal = (s) => {
      s.webRequest.onBeforeRequest((d, done) => done({ cancel: /^(https?|wss?):/.test(d.url) && !local.test(d.url) }))
      return s.setProxy({ proxyRules: rules })
    }
    if (!globalThis.__sealed) {
      globalThis.__sealed = true
      electronApp.on('session-created', (s) => void seal(s))
    }
    const all = new Set([session.defaultSession, ...webContents.getAllWebContents().map((wc) => wc.session)])
    for (const p of Object.values(globalThis.__orbit?.state().profiles ?? {}))
      all.add(session.fromPartition(p.partition))
    await Promise.all([...all].map(seal))
    return Promise.all([...all].map((s) => s.resolveProxy('https://example.com/')))
  }, `http://${OFFLINE_PROXY}`)

const fx = await startFixtures()
const userData = mkdtempSync(join(tmpdir(), 'orbit-capture-'))
const main = resolve('out/main/index.js')
// Recorded under another name and renamed when the scenario is done, so a failed run keeps the last clip.
const partial = OUT.replace(/(\.[^./]+)?$/, '.partial$1')
let app
let rec
let saved = false
try {
  log('launching Orbit')
  app = await electron.launch({
    args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), `--proxy-server=http://${OFFLINE_PROXY}`, main],
    env: { ...process.env, ORBIT_E2E: '1', ORBIT_USER_DATA: userData },
  })
  let shell
  for (let i = 0; i < 200 && !shell; i++) {
    shell = app.windows().find((p) => p.url().includes('view=shell'))
    if (!shell) await sleep(50)
  }
  await shell.getByTestId('sidebar').waitFor()
  // Fill the display so the capture shows the whole window.
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) => {
      for (const win of BrowserWindow.getAllWindows()) win.setBounds({ x: 0, y: 0, width: w, height: h })
    },
    [W, H],
  )
  await sleep(800)
  origin = await app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getContentBounds() ?? { x: 0, y: 0 },
  )
  // The pointer starts at rest over the page, in Playwright's input and on screen.
  pointer = { x: Math.round(W * 0.62), y: Math.round(H * 0.55) }
  await shell.mouse.move(pointer.x, pointer.y)
  await xPointer(pointer.x, pointer.y)
  // Every session on the dead proxy, checked, before anything is recorded.
  const proxies = await sealOffline(app)
  if (proxies.some((p) => p !== `PROXY ${OFFLINE_PROXY}`)) {
    throw new Error(`not recording: requests would reach the network (${proxies.join(', ')})`)
  }

  const scenarioFile = scenario.endsWith('.mjs')
    ? resolve(scenario)
    : resolve(import.meta.dirname, 'scenarios', `${scenario}.mjs`)
  const { default: play, setup } = await import(pathToFileURL(scenarioFile).href)
  const toolkit = makeToolkit(app, shell, fx)
  // Optional unrecorded preparation (Spaces, tabs, history), so the clip starts on the demo itself.
  if (setup) {
    log('setup')
    await setup(toolkit)
    await sleep(1200)
  }
  log('recording', OUT)
  rec = startRecorder(partial)
  await sleep(700)
  await play(toolkit)
  await sleep(800)
  await rec.stop()
  rec = null
  renameSync(partial, OUT)
  saved = true
} finally {
  if (rec) await rec.stop()
  await app?.close().catch(() => {})
  fx.close()
  rmSync(userData, { recursive: true, force: true })
  if (!saved) rmSync(partial, { force: true })
}
log('saved', OUT)
