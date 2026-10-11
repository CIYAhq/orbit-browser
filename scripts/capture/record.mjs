#!/usr/bin/env node
/**
 * Records a scripted Orbit scenario as a raw screen capture (for parity clips
 * and screenshots). Drives the built app with Playwright while ffmpeg grabs
 * the X display, so native tab views are captured exactly as composited.
 *
 * Needs an ffmpeg with x11grab (set ORBIT_FFMPEG to its path) and a display:
 *   xvfb-run -a -s "-screen 0 1440x900x24" node scripts/capture/record.mjs <scenario> [--out clips/<scenario>.mp4] [--shots dir]
 *     [--fps 30] [--port 3380]
 *
 * --fps sets the recording's frame rate (60 to judge motion frame by frame). --port is where the fixture
 * server starts looking for a free port, up to 9 above it, so a capture stays inside its own range.
 *
 * Scenarios live in scripts/capture/scenarios/<name>.mjs and export
 * `default async function (t)`; see helpers in `makeToolkit` below. A scenario may also export `env`:
 * more environment for Orbit's launch (fixture paths, say), as an object or a function of `{ fx }`.
 */
import { execFile, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import { _electron as electron } from '@playwright/test'

const argv = process.argv.slice(2)
const scenario = argv.find((a) => !a.startsWith('--'))
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : fallback
}
if (!scenario) {
  console.error(
    'usage: record.mjs <scenario> [--out file.mp4] [--shots dir] [--size 1440x900] [--fps 30] [--port 3380]',
  )
  process.exit(2)
}
const scenarioName = basename(scenario, '.mjs')
const OUT = resolve(opt('out', `clips/${scenarioName}.mp4`))
const SHOTS = opt('shots') ? resolve(opt('shots')) : undefined
const [W, H] = opt('size', '1440x900').split('x').map(Number)
const FPS = opt('fps', '30')
const PORT = Number(opt('port', '3380'))
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
  // What /feed.json offers: set by a scenario with fx.offer({ version, summary, security }).
  let offer = null
  // The `cut` files that broke off (`broken`, until a scenario calls fx.repair(name)) or were repaired.
  const cuts = new Map()
  const server = createServer((req, res) => {
    const at = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (at.pathname.startsWith('/dl/')) {
      sendFile(req, res, at, cuts)
      return
    }
    // /feed.json: an update feed (UP-01). Before a scenario offers a version, its release is 0.0.0, older
    // than any build. The release's page is one of these pages.
    if (at.pathname === '/feed.json') {
      const { version = '0.0.0', summary, security = false } = offer ?? {}
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          version,
          url: `http://${req.headers.host}/${encodeURIComponent(`Orbit ${version}`)}`,
          summary,
          security,
        }),
      )
      return
    }
    const raw = at.pathname.split('/').pop() || 'Home'
    let name = raw
    try {
      name = decodeURIComponent(raw)
    } catch {
      // A malformed escape: show the name as it came.
    }
    const accent = accents[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % accents.length]
    const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${accent}"/><text x="16" y="22" font-family="Arial,sans-serif" font-size="17" font-weight="700" fill="#fff" text-anchor="middle">${esc(name[0] ?? '?')}</text></svg>`
    // /files/<name>: a page of download links (FILES) in place of the cards.
    const cards = at.pathname.startsWith('/files/')
      ? FILES.map(
          ([file, query, size]) =>
            `<a class="card file" data-file="${esc(file)}" href="/dl/${encodeURIComponent(file)}${query ? `?${query}` : ''}"><div class="dot"></div><h3>${esc(file)}</h3><p>${size}. Download</p></a>`,
        ).join('')
      : ['Overview', 'Recent', 'Shared with you', 'Starred', 'Activity', 'Ideas']
          .map(
            (c, i) =>
              `<div class="card"><div class="dot" style="opacity:${0.35 + (i % 3) * 0.2}"></div><h3>${c}</h3><p>Local demo content for ${esc(name)}. Nothing here comes from the network.</p></div>`,
          )
          .join('')
    // ?wait=<ms>: the page comes that much later (at most 30 s), for a load still under way.
    const wait = Math.min(Number(at.searchParams.get('wait')) || 0, 30_000)
    const page = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(name)}</title>
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
a.file{color:inherit;text-decoration:none}a.file:hover{border-color:${accent}}
</style></head><body><header><div class="logo"></div><b>${esc(name)}</b><nav><span>Home</span><span>Library</span><span>Settings</span></nav></header>
<main><h1>${esc(name)}</h1><p class="lead">A local demo page for Orbit screen captures, served from 127.0.0.1.</p><div class="grid">${cards}</div></main></body></html>`
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(page)
    }, wait)
  })
  let port = PORT
  await new Promise((ok, fail) => {
    server.on('error', (err) =>
      err.code === 'EADDRINUSE' && port < Math.min(PORT + 9, 3399) ? server.listen(++port, '127.0.0.1') : fail(err),
    )
    server.listen(port, '127.0.0.1', ok)
  })
  return {
    url: (name) => `http://127.0.0.1:${port}/${encodeURIComponent(name)}`,
    offer: (release) => {
      offer = release
    },
    repair: (file) => {
      cuts.set(file, 'repaired')
    },
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}

const MB = 1024 * 1024
/** The files a /files/ page links to: name, the /dl/ query, and the size it shows. */
const FILES = [
  ['Survey report.pdf', '', '1 page'],
  ['Site photo.png', '', '480 × 320'],
  ['Field recordings.zip', `size=${24 * MB}&rate=${1.5 * MB}`, '24 MB'],
  ['Station log.csv', `size=${6 * MB}&rate=${MB}&cut`, '6 MB'],
]

/**
 * /dl/<name>?size=&rate=&cut: a file sent as an attachment (DL-01), with an ETag and byte ranges, so a
 * paused or cut-off download goes on where it stopped (DL-15). A .pdf is a one-page PDF and a .png a
 * picture, so a preview shows them; any other file is `size` bytes of filler. With `rate`, it comes at
 * that many bytes a second. With `cut`, the first request breaks off after a quarter, and every request
 * after it breaks too (the engine tries again by itself a few times) until the scenario repairs it.
 */
function sendFile(req, res, at, cuts) {
  let name = at.pathname.slice('/dl/'.length)
  try {
    name = decodeURIComponent(name)
  } catch {
    // A malformed escape: the name as it came.
  }
  const ext = name.split('.').pop()
  const size = Math.min(Number(at.searchParams.get('size')) || 64 * 1024, 64 * MB)
  const data = ext === 'pdf' ? pdfFile(name.replace(/\.pdf$/, '')) : ext === 'png' ? pngFile() : filler(size)
  const from = Number(/^bytes=(\d+)-/.exec(req.headers.range ?? '')?.[1] ?? 0)
  if (cuts.get(name) === 'broken') {
    res.destroy()
    return
  }
  const cut = at.searchParams.has('cut') && !cuts.has(name)
  const rest = from > 0 && from < data.length ? data.subarray(from) : data
  res.writeHead(rest === data ? 200 : 206, {
    'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename="${name}"`,
    etag: `"${name}-${data.length}"`,
    'accept-ranges': 'bytes',
    'content-length': String(rest.length),
    ...(rest === data ? {} : { 'content-range': `bytes ${from}-${data.length - 1}/${data.length}` }),
  })
  // The first request of a `cut` file stops a quarter in, and from then on every request breaks.
  const stop = cut ? Math.floor(data.length / 4) : rest.length
  if (cut) cuts.set(name, 'broken')
  const rate = Number(at.searchParams.get('rate')) || 0
  if (!rate && !cut) {
    res.end(rest)
    return
  }
  const step = rate ? Math.max(1, Math.round(rate / 20)) : stop
  let sent = 0
  const timer = setInterval(() => {
    const next = Math.min(stop, sent + step)
    res.write(rest.subarray(sent, next))
    sent = next
    if (sent < stop) return
    clearInterval(timer)
    if (cut) setTimeout(() => res.destroy(), 100)
    else res.end()
  }, 50)
  res.on('close', () => clearInterval(timer))
}

function filler(size) {
  const out = Buffer.alloc(size)
  for (let i = 0; i < size; i++) out[i] = i % 251
  return out
}

/** A one-page PDF with a title and two lines of text. */
function pdfFile(title) {
  const text = (size, y, s) => `BT /F1 ${size} Tf 56 ${y} Td (${s.replace(/[()\\]/g, '\\$&')}) Tj ET`
  const stream = [
    text(28, 760, title),
    text(13, 726, 'North ridge transect, plots 1 to 14.'),
    text(13, 706, 'A local file for Orbit screen captures.'),
  ].join('\n')
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ]
  let out = '%PDF-1.4\n'
  const offsets = objects.map((o, i) => {
    const offset = out.length
    out += `${i + 1} 0 obj${o}endobj\n`
    return offset
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/** A 480 × 320 picture: a ridge under a sky, with a sun. */
function pngFile(w = 480, h = 320) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ridge = h * 0.62 + Math.sin(x / 55) * 18 + Math.sin(x / 23) * 6
      const sun = (x - w * 0.72) ** 2 + (y - h * 0.3) ** 2 < 30 ** 2
      const k = y > ridge ? (y - ridge) / (h - ridge) : y / ridge
      const rgb =
        y > ridge ? [48 - 20 * k, 140 - 50 * k, 90 - 30 * k] : sun ? [255, 214, 120] : [140 + 90 * k, 190 + 50 * k, 245]
      raw.set(
        rgb.map((c) => Math.round(c)),
        y * (w * 3 + 1) + 1 + x * 3,
      )
    }
  }
  const chunk = (type, body) => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(body.length)
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), body])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(typed))
    return Buffer.concat([head, typed, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(w, 0)
  header.writeUInt32BE(h, 4)
  header[8] = 8 // bits per channel
  header[9] = 2 // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
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
      FPS,
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
/** And no host name resolves but localhost: Chromium looks up a link's host before anyone clicks it (PR #10 review F2). */
const NO_LOOKUPS = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'

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

/**
 * Quits Orbit as the e2e harness does (askQuit in tests/e2e/helpers.ts, PR #16): asked from a task of
 * its own, not by the inspector's interrupt; Playwright's own close then only cleans up.
 */
async function quitOrbit(app) {
  const exited = new Promise((resolve) => app.once('close', resolve))
  await app
    .evaluate(async ({ app: electronApp }) => {
      await new Promise((r) => setImmediate(r))
      electronApp.quit()
    })
    .catch(() => {})
  await Promise.race([exited, sleep(15_000)])
  await app.close()
}

const fx = await startFixtures()
const userData = mkdtempSync(join(tmpdir(), 'orbit-capture-'))
const main = resolve('out/main/index.js')
// Recorded under another name and renamed when the scenario is done, so a failed run keeps the last clip.
const partial = OUT.replace(/(\.[^./]+)?$/, '.partial$1')
let app
let rec
let saved = false
try {
  const scenarioFile = scenario.endsWith('.mjs')
    ? resolve(scenario)
    : resolve(import.meta.dirname, 'scenarios', `${scenario}.mjs`)
  const { default: play, setup, env = {} } = await import(pathToFileURL(scenarioFile).href)
  log('launching Orbit')
  app = await electron.launch({
    args: [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      `--proxy-server=http://${OFFLINE_PROXY}`,
      NO_LOOKUPS,
      main,
    ],
    env: {
      ...process.env,
      ORBIT_E2E: '1',
      ORBIT_USER_DATA: userData,
      // Import searches no browser on this computer: a scenario that imports names its made-up ones.
      ORBIT_IMPORT_PLACES: '[]',
      ...(typeof env === 'function' ? await env({ fx }) : env),
    },
  })
  let shell
  for (let i = 0; i < 200 && !shell; i++) {
    shell = app.windows().find((p) => p.url().includes('view=shell'))
    if (!shell) await sleep(50)
  }
  await shell.getByTestId('sidebar').waitFor()
  // Fill the display so the capture shows the whole window. From a task of its own: the inspector runs
  // an evaluate by interrupt, and Orbit's resize handler would run part-way through other main-process code.
  await app.evaluate(
    async ({ BrowserWindow }, [w, h]) => {
      await new Promise((r) => setImmediate(r))
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
  if (app) await quitOrbit(app).catch(() => {})
  fx.close()
  rmSync(userData, { recursive: true, force: true })
  if (!saved) rmSync(partial, { force: true })
}
log('saved', OUT)
