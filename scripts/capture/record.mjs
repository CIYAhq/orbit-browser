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
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
const OUT = resolve(opt('out', `clips/${scenario}.mp4`))
const SHOTS = opt('shots') ? resolve(opt('shots')) : undefined
const [W, H] = opt('size', '1440x900').split('x').map(Number)
const FFMPEG = process.env.ORBIT_FFMPEG ?? 'ffmpeg'
const DISPLAY = process.env.DISPLAY
if (!DISPLAY) throw new Error('No DISPLAY: run under xvfb-run')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...m) => console.error(`[capture ${new Date().toISOString().slice(11, 19)}]`, ...m)

/** Local pages for demos that must not depend on the network. */
async function startFixtures() {
  const colors = ['#fde8e8', '#e8f0fd', '#e9fbe8', '#fff6dc', '#f1e8fd', '#e6fafa']
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').split('/').pop() || 'Home')
    const bg = colors[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % colors.length]
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${name}</title>
<style>body{font:18px system-ui;margin:0;padding:56px;background:${bg};color:#222}h1{font-size:44px;margin:0 0 16px}p{max-width:62ch;line-height:1.6}</style>
</head><body><h1>${name}</h1>${'<p>A local demo page for Orbit screen captures. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>'.repeat(12)}</body></html>`)
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
    /** Moves the pointer smoothly to the centre of a locator. */
    point: async (locator, steps = 18) => {
      const box = await locator.boundingBox()
      if (box) await shell.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps })
    },
    shot: async (name) => {
      if (!SHOTS) return
      shotNo++
      log('screenshot', name)
      await screenshot(join(SHOTS, `${scenario}-${String(shotNo).padStart(2, '0')}-${name}.png`))
    },
  }
}

const fx = await startFixtures()
const userData = mkdtempSync(join(tmpdir(), 'orbit-capture-'))
const main = resolve('out/main/index.js')
log('launching Orbit')
const app = await electron.launch({
  args: process.platform === 'linux' ? ['--no-sandbox', main] : [main],
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

const { default: play } = await import(pathToFileURL(resolve('scripts/capture/scenarios', `${scenario}.mjs`)).href)
log('recording', OUT)
const rec = startRecorder(OUT)
await sleep(700)
try {
  await play(makeToolkit(app, shell, fx))
  await sleep(800)
} finally {
  await rec.stop()
  await app.close().catch(() => {})
  fx.close()
  rmSync(userData, { recursive: true, force: true })
}
log('saved', OUT)
