/**
 * Media lane e2e (media.md): Orbit's floating player (picture-in-picture), the sidebar media tray,
 * call controls and media in the tab lifecycle. All media is generated locally: a WAV tone written
 * here, canvas captureStream() videos with an oscillator soundtrack, a short WebM recorded in the
 * page, and a long seekable video built from that recording with Media Source Extensions.
 */
import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test'
import type { MediaTestHooks } from '../../src/main/media'
import type { PlayerHost, PlayerInfo } from '../../src/main/media/player'
import { formatClock } from '../../src/shared/media'
import type { TabMedia } from '../../src/shared/state'
import { FRAME_SLACK, launchOrbit, MOD, type Orbit, state, tabPage, tabView, viewPage } from './helpers'
import { act, activeId, cmd, newTab, tab, tabsHook, waitTab } from './tabs-support'

// ---- Local media fixtures (ports 3300–3399 are this project's) ----

/** A mono 16-bit PCM WAV sine tone. */
function wav(seconds: number, freq: number, rate = 8000): Buffer {
  const n = Math.floor(seconds * rate)
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 6000), 44 + i * 2)
  return buf
}

const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;margin:0;padding:24px;background:#f4f0ff}</style></head><body>${body}</body></html>`

/** A canvas captureStream() video with an oscillator audio track: a "playing video" with sound. */
const STREAM_VIDEO = `
<video id="v" width="320" height="180" playsinline></video>
<canvas id="c" width="320" height="180" style="position:absolute;left:-9999px"></canvas>
<script>
const c = document.getElementById('c'), g = c.getContext('2d'); let n = 0
setInterval(() => { g.fillStyle = 'hsl(' + (n++ * 9 % 360) + ',70%,50%)'; g.fillRect(0, 0, 320, 180) }, 40)
const stream = c.captureStream(25)
const ac = new AudioContext(), osc = ac.createOscillator(), gain = ac.createGain(); gain.gain.value = 0.05
const dest = ac.createMediaStreamDestination(); osc.connect(gain).connect(dest); osc.start()
stream.addTrack(dest.stream.getAudioTracks()[0])
const v = document.getElementById('v'); v.srcObject = stream
v.play().then(() => { document.body.dataset.state = 'playing' })
</script>`

/**
 * A real (file-backed) video: records a short WebM in the page, then plays it from a blob URL.
 * It loops unless `once`.
 */
const FILE_VIDEO = (once: boolean) => `
<video id="v" width="320" height="180" ${once ? '' : 'loop '}playsinline></video>
<canvas id="c" width="320" height="180" style="position:absolute;left:-9999px"></canvas>
<script>
const c = document.getElementById('c'), g = c.getContext('2d'); let n = 0
setInterval(() => { g.fillStyle = 'hsl(' + (n++ * 9 % 360) + ',70%,50%)'; g.fillRect(0, 0, 320, 180) }, 40)
const stream = c.captureStream(25)
const ac = new AudioContext(), osc = ac.createOscillator(), gain = ac.createGain(); gain.gain.value = 0.05
const dest = ac.createMediaStreamDestination(); osc.connect(gain).connect(dest); osc.start()
stream.addTrack(dest.stream.getAudioTracks()[0])
const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' }); const chunks = []
rec.ondataavailable = (e) => chunks.push(e.data)
rec.onstop = () => {
  osc.stop()
  const v = document.getElementById('v'); v.src = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }))
  v.play().then(() => { document.body.dataset.state = 'playing' })
}
rec.start(); setTimeout(() => rec.stop(), 1500)
</script>`

/**
 * A long, seekable 16:9 video with sound: one second of picture and one of sound recorded in the
 * page (MediaRecorder), each appended `seconds` times to its own SourceBuffer in sequence mode, so
 * neither track has gaps. Nothing is downloaded.
 */
const LONG_VIDEO = (seconds: number) => `
<video id="v" width="480" height="270" playsinline></video>
<canvas id="c" width="480" height="270" style="position:absolute;left:-9999px"></canvas>
<script>
const c = document.getElementById('c'), g = c.getContext('2d'); let n = 0
const draw = () => {
  g.fillStyle = 'hsl(' + (n++ * 9 % 360) + ',70%,50%)'; g.fillRect(0, 0, 480, 270)
  g.fillStyle = '#fff'; g.font = '40px sans-serif'; g.fillText(String(n), 24, 60)
}
const timer = setInterval(draw, 40)
const ac = new AudioContext(), osc = ac.createOscillator(), gain = ac.createGain(); gain.gain.value = 0.05
const dest = ac.createMediaStreamDestination(); osc.connect(gain).connect(dest); osc.start()
const record = (stream, type) => new Promise((resolve) => {
  const rec = new MediaRecorder(stream, { mimeType: type }); const chunks = []
  rec.ondataavailable = (e) => chunks.push(e.data)
  rec.onstop = () => resolve(new Blob(chunks, { type }).arrayBuffer())
  rec.start(); setTimeout(() => rec.stop(), 1000)
})
const types = ['video/webm;codecs=vp8', 'audio/webm;codecs=opus']
Promise.all([record(c.captureStream(25), types[0]), record(dest.stream, types[1])]).then(async (data) => {
  clearInterval(timer); osc.stop()
  const source = new MediaSource()
  const v = document.getElementById('v')
  v.src = URL.createObjectURL(source)
  await new Promise((r) => source.addEventListener('sourceopen', r, { once: true }))
  const buffers = types.map((t) => source.addSourceBuffer(t))
  await Promise.all(buffers.map(async (b, i) => {
    b.mode = 'sequence'
    for (let k = 0; k < ${seconds}; k++) {
      b.appendBuffer(data[i])
      await new Promise((r) => b.addEventListener('updateend', r, { once: true }))
    }
  }))
  source.endOfStream()
  await v.play()
  document.body.dataset.state = 'playing'
})
</script>`

const AUDIO = (session: boolean) => `
<audio id="a" src="/media/tone.wav?s=30&f=440" loop></audio>
<script>
const a = document.getElementById('a')
${session ? "navigator.mediaSession.metadata = new MediaMetadata({ title: 'Track One', artist: 'Orbit Test' })" : ''}
a.play().then(() => { document.body.dataset.state = 'playing' })
</script>`

/** Two tracks: the second starts when the first ends; the Media Session follows. */
const PLAYLIST = `
<audio id="a" src="/media/tone.wav?s=30&f=440"></audio>
<script>
const tracks = [['Track One', '/media/tone.wav?s=30&f=440'], ['Track Two', '/media/tone.wav?s=30&f=660']]
let i = 0
const a = document.getElementById('a')
const show = () => { navigator.mediaSession.metadata = new MediaMetadata({ title: tracks[i][0], artist: 'Orbit Test' }); document.body.dataset.track = tracks[i][0] }
a.addEventListener('ended', () => { if (i + 1 < tracks.length) { i++; a.src = tracks[i][1]; show(); a.play() } })
show()
a.play().then(() => { document.body.dataset.state = 'playing' })
</script>`

/**
 * A call: camera and microphone (fake devices) shown in a muted self view. With a participant,
 * a large muted video of another stream too (voices come through separate audio in call apps).
 */
const CALL = (participant: boolean) => `
${
  participant
    ? `<video id="remote" width="480" height="270" muted playsinline></video>
<canvas id="c" width="480" height="270" style="position:absolute;left:-9999px"></canvas>
<script>
const c = document.getElementById('c'), g = c.getContext('2d'); let n = 0
setInterval(() => { g.fillStyle = 'hsl(' + (n++ * 9 % 360) + ',60%,45%)'; g.fillRect(0, 0, 480, 270) }, 40)
const r = document.getElementById('remote'); r.srcObject = c.captureStream(25); r.play()
</script>`
    : ''
}
<video id="self" width="160" height="90" muted playsinline></video>
<script>
navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then((s) => {
  const v = document.getElementById('self'); v.srcObject = s
  return v.play()
}).then(() => { document.body.dataset.state = 'in-call' }, (e) => { document.body.dataset.state = 'error ' + e.name })
</script>`

interface Fixtures {
  url: (path: string) => string
  close: () => Promise<void>
}

async function startMediaFixtures(): Promise<Fixtures> {
  const tones = new Map<string, Buffer>()
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost')
    const parts = u.pathname.split('/').filter(Boolean)
    const title = decodeURIComponent(parts[2] ?? 'Media')
    const html = (body: string) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(page(title, `<h1>${title}</h1>${body}`))
    }
    if (u.pathname === '/media/tone.wav') {
      const key = `${u.searchParams.get('s')}-${u.searchParams.get('f')}`
      let buf = tones.get(key)
      if (!buf) {
        buf = wav(Number(u.searchParams.get('s') ?? 4), Number(u.searchParams.get('f') ?? 440))
        tones.set(key, buf)
      }
      // Range requests make the file seekable (next track, ±15 s).
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '')
      if (range) {
        const start = Number(range[1])
        const end = range[2] ? Math.min(Number(range[2]), buf.length - 1) : buf.length - 1
        res.writeHead(206, {
          'content-type': 'audio/wav',
          'content-length': end - start + 1,
          'content-range': `bytes ${start}-${end}/${buf.length}`,
          'accept-ranges': 'bytes',
        })
        res.end(buf.subarray(start, end + 1))
        return
      }
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': buf.length, 'accept-ranges': 'bytes' })
      res.end(buf)
      return
    }
    if (parts[0] === 'media' && parts[1] === 'audio') return html(AUDIO(u.searchParams.has('session')))
    if (parts[0] === 'media' && parts[1] === 'playlist') return html(PLAYLIST)
    if (parts[0] === 'media' && parts[1] === 'video') return html(STREAM_VIDEO)
    if (parts[0] === 'media' && parts[1] === 'file-video') return html(FILE_VIDEO(u.searchParams.has('once')))
    if (parts[0] === 'media' && parts[1] === 'long-video')
      return html(LONG_VIDEO(Number(u.searchParams.get('s') ?? 60)))
    if (parts[0] === 'media' && parts[1] === 'call') return html(CALL(u.searchParams.has('participant')))
    if (parts[0] === 'page') return html('<p>A quiet page.</p>')
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  const base = 3360 + (Number(process.env.TEST_PARALLEL_INDEX ?? 0) % 20)
  await new Promise<void>((resolveListen, reject) => {
    let port = base
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && port < 3399) server.listen(++port, '127.0.0.1')
      else reject(err)
    })
    server.listen(port, '127.0.0.1', () => resolveListen())
  })
  const { port } = server.address() as AddressInfo
  return {
    url: (path) => `http://localhost:${port}${path}`,
    close: () => new Promise((r) => server.close(() => r())),
  }
}

// ---- Helpers ----

let fx: Fixtures
let orbit: Orbit

test.beforeAll(async () => {
  fx = await startMediaFixtures()
})
test.afterAll(async () => {
  await fx.close()
})
test.afterEach(async () => {
  await orbit?.app.close()
})

interface Box {
  x: number
  y: number
  width: number
  height: number
}

async function media(app: ElectronApplication, tabId: string): Promise<TabMedia | undefined> {
  return (await tab(app, tabId))?.media
}

/** Opens a page in a new selected tab and waits until its media plays. */
async function openPlaying(
  app: ElectronApplication,
  path: string,
  until = 'playing',
): Promise<{ id: string; page: Page }> {
  const id = await newTab(app, fx.url(path))
  await waitTab(app, id, path.split('?')[0] as string)
  const p = await tabPage(app, path.split('?')[0] as string)
  await expect.poll(() => p.evaluate(() => document.body.dataset.state ?? ''), { timeout: 20_000 }).toBe(until)
  return { id, page: p }
}

/** Selects a quiet tab (leaving the current one). */
async function leave(app: ElectronApplication): Promise<string> {
  const id = await newTab(app, fx.url('/page/Other/Quiet'))
  await waitTab(app, id, '/page/Other')
  return id
}

/** The engine's own picture-in-picture window shows a video of the page. */
const enginePip = (p: Page) => p.evaluate(() => !!document.pictureInPictureElement)
/** The id of the page's video that floats in Orbit's player ('' when none). */
const floated = (p: Page) => p.evaluate(() => document.querySelector('video[data-orbit-pip]')?.id ?? '')
const paused = (p: Page, selector: string) =>
  p.evaluate((s) => (document.querySelector(s) as HTMLMediaElement | null)?.paused ?? null, selector)
const currentTime = (p: Page, selector = '#v') =>
  p.evaluate((s) => (document.querySelector(s) as HTMLMediaElement).currentTime, selector)
const controller = (o: Orbit, tabId: string) =>
  o.shell.locator(`[data-testid="media-controller"][data-tab-id="${tabId}"]`)

function mediaHook<T>(
  app: ElectronApplication,
  name: 'lastMenu' | 'clickMenu' | 'playerMenu' | 'clickPlayerMenu',
  arg?: string,
): Promise<T> {
  return app.evaluate(
    (_e, [n, a]) => {
      const hooks = (globalThis as unknown as { __orbitMedia: MediaTestHooks }).__orbitMedia
      return (hooks[n] as (x?: string) => unknown)(a)
    },
    [name, arg] as const,
  ) as Promise<T>
}

/** Orbit's floating player, as the main process sees it. */
function player(app: ElectronApplication): Promise<PlayerInfo> {
  return app.evaluate(() =>
    (globalThis as unknown as { __orbitMedia: MediaTestHooks }).__orbitMedia.manager.player.info(),
  )
}

/** Waits until the player shows a tab's video. */
async function expectPlayer(app: ElectronApplication, tabId: string): Promise<PlayerInfo> {
  await expect
    .poll(async () => {
      const p = await player(app)
      return p.tabId === tabId && p.visible && p.holdsView && !p.animating
    })
    .toBe(true)
  return player(app)
}

async function expectNoPlayer(app: ElectronApplication): Promise<void> {
  await expect
    .poll(async () => {
      const p = await player(app)
      return p.tabId === null && !p.visible && !p.opening
    })
    .toBe(true)
}

/** A box once it stops moving (the tray slides controllers in, FL-32). */
async function stableBox(page: Page, selector: string): Promise<Box> {
  let box: Box | null = null
  await expect
    .poll(async () => {
      const read = () =>
        page.evaluate((sel) => {
          const r = document.querySelector(sel)?.getBoundingClientRect()
          return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null
        }, selector)
      const a = await read()
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
      const b = await read()
      box = b
      return !!a && !!b && JSON.stringify(a) === JSON.stringify(b) && b.height > 0
    })
    .toBe(true)
  return box as unknown as Box
}

/** The player window and the selected tab, sampled in the main process every few ms (MD-16). */
function sampleBack(
  app: ElectronApplication,
  ms = 1000,
): Promise<(Box & { t: number; visible: boolean; active: string | null })[]> {
  return app.evaluate(async (_e, duration) => {
    const g = globalThis as unknown as {
      __orbitMedia: MediaTestHooks
      __orbit: {
        windowIds: () => string[]
        ctx: { store: { state: { windows: Record<string, { spaceId: string; activeTab: Record<string, string> }> } } }
      }
    }
    const p = g.__orbitMedia.manager.player
    const out: (Box & { t: number; visible: boolean; active: string | null })[] = []
    const start = Date.now()
    while (Date.now() - start < duration) {
      const info = p.info()
      const w = g.__orbit.ctx.store.state.windows[g.__orbit.windowIds()[0] as string]
      out.push({
        t: Date.now() - start,
        visible: info.visible,
        ...(info.bounds ?? { x: 0, y: 0, width: 0, height: 0 }),
        active: w ? (w.activeTab[w.spaceId] ?? null) : null,
      })
      await new Promise((r) => setTimeout(r, 8))
    }
    return out
  }, ms)
}

/** The player's controls (its own small view). */
async function pipPage(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const found = app.windows().find((p) => p.url().includes('view=pip'))
    if (found) {
      await found.waitForLoadState()
      return found
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('No player view')
}

/** The player's place for a corner of the work area (16 px margins). */
function cornerBox(area: Box, corner: string, width: number, height: number): Box {
  const left = corner.endsWith('left')
  const top = corner.startsWith('top')
  return {
    x: left ? area.x + 16 : area.x + area.width - 16 - width,
    y: top ? area.y + 16 : area.y + area.height - 16 - height,
    width,
    height,
  }
}

/** A pointer gesture on the player, as its view reports them (screen DIPs, ms). */
function gesture(pip: Page, e: { phase: string; kind?: string; x: number; y: number; t?: number }): Promise<void> {
  return pip.evaluate((ev) => {
    ;(window as unknown as { orbit: { send: (n: string, p: unknown) => void } }).orbit.send('media.pipGesture', ev)
  }, e)
}

/** Drags with pointer events from `from` by steps of `step` px, `ms` apart, then releases. */
async function dragPlayer(
  pip: Page,
  kind: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps: number,
  ms: number,
): Promise<void> {
  let t = Date.now()
  await gesture(pip, { phase: 'start', kind, x: from.x, y: from.y, t })
  for (let i = 1; i <= steps; i++) {
    t += ms
    const x = from.x + ((to.x - from.x) * i) / steps
    const y = from.y + ((to.y - from.y) * i) / steps
    await gesture(pip, { phase: i === steps ? 'end' : 'move', kind, x, y, t })
  }
}

type Frames = { w: number; h: number; lifted: boolean }[]

// ---- Floating player (MD-01 to MD-08, MD-16) ----

test('[MD-01][MD-03][MD-16] leaving a playing video floats it bottom-right out of its place in the page; returning puts it back with no blank frame', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const v = await openPlaying(app, '/media/long-video/Film')
  await expect.poll(async () => (await media(app, v.id))?.video).toBe(true)
  await pipPage(app)

  // Sample the player window while it appears (MD-16), then leave the tab.
  const sampling = app.evaluate(async () => {
    const p = (globalThis as unknown as { __orbitMedia: MediaTestHooks }).__orbitMedia.manager.player
    const out: { t: number; x: number; y: number; width: number; height: number }[] = []
    const start = Date.now()
    while (Date.now() - start < 1200) {
      const info = p.info()
      if (info.visible && info.bounds) out.push({ t: Date.now() - start, ...info.bounds })
      await new Promise((r) => setTimeout(r, 8))
    }
    return out
  })
  const other = await newTab(app, fx.url('/page/Other/Quiet'))
  const samples = await sampling
  const info = await expectPlayer(app, v.id)

  // Within about 300 ms (MD-01), bottom-right with a 16 px margin, 320 × 180 for 16:9 (MD-03).
  expect(info.openMs).not.toBeNull()
  expect(info.openMs as number).toBeLessThan(300 * FRAME_SLACK)
  const area = info.workArea as Box
  expect(info.bounds).toEqual(cornerBox(area, 'bottom-right', 320, 180))
  expect(info.alwaysOnTop).toBe(true)
  expect(await floated(v.page)).toBe('v')
  expect(await paused(v.page, '#v')).toBe(false)
  expect(await activeId(app)).toBe(other)
  const m = await media(app, v.id)
  expect(m?.pip).toBe(true)
  expect(m?.player).toBe(true)
  expect(m?.autoPip).toBe(true)
  // A video in picture-in-picture is not also in the sidebar tray.
  await expect(controller(orbit, v.id)).toHaveCount(0)

  // The motion starts at the video's place in the page (480 × 270) and shrinks into the corner
  // over about 300 ms on the standard curve: several in-between frames, never smaller than the end.
  const enter = info.lastEnter as { from: Box; to: Box }
  expect(enter.from.width).toBe(480)
  expect(enter.from.height).toBe(270)
  expect(enter.to).toEqual(info.bounds)
  const first = samples[0] as Box & { t: number }
  expect(first.width).toBeGreaterThan(FRAME_SLACK > 1 ? 320 : 330)
  const widths = samples.map((s) => s.width)
  for (let i = 1; i < widths.length; i++) expect(widths[i] as number).toBeLessThanOrEqual(widths[i - 1] as number)
  const between = new Set(widths.filter((w) => w > 320 && w < 480))
  expect(between.size).toBeGreaterThanOrEqual(FRAME_SLACK > 1 ? 2 : 4)
  const done = samples.find((s) => s.width === 320 && s.x === enter.to.x && s.y === enter.to.y)
  expect(done).toBeDefined()
  if (FRAME_SLACK === 1) expect((done as { t: number }).t - first.t).toBeGreaterThan(150)
  expect((done as { t: number }).t - first.t).toBeLessThan(700 * FRAME_SLACK)

  // Back on the tab: the video is in the page again, still playing, and no frame was drawn at the
  // page's size with the video still floating (MD-01: no blank frame).
  await v.page.evaluate(() => {
    const w = window as unknown as { __frames: Frames }
    w.__frames = []
    const tick = () => {
      w.__frames.push({
        w: innerWidth,
        h: innerHeight,
        lifted: !!document.querySelector('video[data-orbit-pip]'),
      })
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await expect
    .poll(() => v.page.evaluate(() => (window as unknown as { __frames: Frames }).__frames.length))
    .toBeGreaterThan(3)
  await cmd(app, 'tabs.activate', { tabId: v.id })
  await expect.poll(() => floated(v.page)).toBe('')
  await expectNoPlayer(app)
  const size = await v.page.evaluate(() => ({ w: innerWidth, h: innerHeight }))
  await expect
    .poll(() =>
      v.page.evaluate(
        (s) => (window as unknown as { __frames: Frames }).__frames.filter((f) => f.w === s.w && f.h === s.h).length,
        size,
      ),
    )
    .toBeGreaterThan(2)
  const frames = await v.page.evaluate(() => (window as unknown as { __frames: Frames }).__frames)
  expect(frames.some((f) => f.lifted)).toBe(true)
  expect(frames.filter((f) => f.w === size.w && f.h === size.h && f.lifted)).toEqual([])
  expect(await paused(v.page, '#v')).toBe(false)
  await expect.poll(async () => (await media(app, v.id))?.pip).toBe(false)
  expect((await media(app, v.id))?.player).toBeUndefined()
})

test('[MD-04][MD-05][KS-11] hovering the player shows play/pause, ±15 s, progress and speed; Space and arrows work when it has focus', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const v = await openPlaying(app, '/media/long-video/Film')
  const pip = await pipPage(app)
  await leave(app)
  await expectPlayer(app, v.id)
  const root = pip.getByTestId('pip')
  await expect(root).toHaveAttribute('data-tab-id', v.id)

  // Video only until hovered (MD-03); hovering reveals the controls.
  await expect(pip.locator('.pip__top')).toHaveCSS('opacity', '0')
  await root.hover({ position: { x: 40, y: 60 } })
  await expect(pip.locator('.pip__top')).toHaveCSS('opacity', '1')
  await expect(pip.locator('.pip__middle')).toHaveCSS('opacity', '1')
  for (const id of ['pip-back', 'pip-more', 'pip-close', 'pip-play', 'pip-back15', 'pip-forward15', 'pip-progress']) {
    await expect(pip.getByTestId(id)).toBeVisible()
  }
  const length = await v.page.evaluate(() => (document.getElementById('v') as HTMLVideoElement).duration)
  await expect(pip.getByTestId('pip-duration')).toHaveText(formatClock(length))
  await expect(pip.getByTestId('pip-live')).toHaveCount(0)

  // Play/pause.
  await pip.getByTestId('pip-play').click()
  await expect.poll(() => paused(v.page, '#v')).toBe(true)
  await expect(root).toHaveAttribute('data-playing', 'false')
  await pip.getByTestId('pip-play').click()
  await expect.poll(() => paused(v.page, '#v')).toBe(false)
  await expect(root).toHaveAttribute('data-playing', 'true')

  // +15 s and −15 s.
  const t0 = await currentTime(v.page)
  await pip.getByTestId('pip-forward15').click()
  await expect.poll(() => currentTime(v.page)).toBeGreaterThan(t0 + 14)
  const t1 = await currentTime(v.page)
  await pip.getByTestId('pip-back15').click()
  await expect.poll(() => currentTime(v.page)).toBeLessThan(t1 - 13)

  // The progress bar seeks where it is clicked; the elapsed time follows.
  const bar = (await pip.getByTestId('pip-progress').boundingBox()) as Box
  await pip.mouse.click(bar.x + bar.width * 0.75, bar.y + bar.height / 2)
  await expect.poll(() => currentTime(v.page)).toBeGreaterThan(length * 0.75 - 3)
  expect(await currentTime(v.page)).toBeLessThan(length * 0.75 + 3)
  await expect(pip.getByTestId('pip-elapsed')).toHaveText(/^0:4\d$/)

  // "…": playback speed (MD-04).
  await pip.getByTestId('pip-more').click()
  await expect.poll(() => mediaHook<string[]>(app, 'playerMenu')).toContain('Playback Speed > 1.5×')
  expect(await mediaHook(app, 'clickPlayerMenu', 'Playback Speed > 1.5×')).toBe(true)
  await expect
    .poll(() => v.page.evaluate(() => (document.getElementById('v') as HTMLVideoElement).playbackRate))
    .toBe(1.5)

  // With focus: Space plays and pauses, arrows seek 5 s (MD-05).
  await root.click({ position: { x: 40, y: 60 } })
  await pip.keyboard.press('Space')
  await expect.poll(() => paused(v.page, '#v')).toBe(true)
  const t2 = await currentTime(v.page)
  await pip.keyboard.press('ArrowLeft')
  await expect.poll(() => currentTime(v.page)).toBeLessThan(t2 - 4)
  const t3 = await currentTime(v.page)
  await pip.keyboard.press('ArrowRight')
  await expect.poll(() => currentTime(v.page)).toBeGreaterThan(t3 + 4)
  await pip.keyboard.press('Space')
  await expect.poll(() => paused(v.page, '#v')).toBe(false)
})

test('[MD-04] a live stream shows a live badge instead of a seekable bar', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const v = await openPlaying(app, '/media/video/Live%20Stream')
  const pip = await pipPage(app)
  await leave(app)
  await expectPlayer(app, v.id)
  await expect.poll(async () => (await media(app, v.id))?.live).toBe(true)
  await pip.getByTestId('pip').hover()
  await expect(pip.getByTestId('pip-live')).toBeVisible()
  await expect(pip.getByTestId('pip-progress')).toHaveCount(0)
  await expect(pip.getByTestId('pip-forward15')).toHaveCount(0)
  await expect(pip.getByTestId('pip-play')).toBeVisible()
})

test('[MD-04][MD-07][MD-10][MD-16] Back to tab and double-click return to the tab, flying back into the page; × keeps it playing in the sidebar, whose PiP button floats it again', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const v = await openPlaying(app, '/media/long-video/Film')
  const pip = await pipPage(app)
  const root = pip.getByTestId('pip')

  // "Back to tab": the source tab is selected at once (FL-01) and the video plays on in the page,
  // while the player flies back to the video's place in the page and goes (MD-16).
  const other = await leave(app)
  const corner = (await expectPlayer(app, v.id)).bounds as Box
  await root.hover({ position: { x: 40, y: 60 } })
  const sampling = sampleBack(app)
  await pip.getByTestId('pip-back').click()
  const samples = await sampling
  await expect.poll(() => activeId(app)).toBe(v.id)
  await expectNoPlayer(app)
  await expect.poll(() => floated(v.page)).toBe('')
  expect(await paused(v.page, '#v')).toBe(false)
  const back = (await player(app)).lastBack as { from: Box; to: Box }
  expect(back.from).toEqual(corner)
  const content = (await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.getContentBounds(),
  )) as Box
  const pane = (await tabView(app, v.id))?.bounds as Box
  const home = await v.page.evaluate(() => {
    const r = (document.getElementById('v') as HTMLVideoElement).getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  expect(Math.abs(back.to.x - (content.x + pane.x + home.x))).toBeLessThanOrEqual(2)
  expect(Math.abs(back.to.y - (content.y + pane.y + home.y))).toBeLessThanOrEqual(2)
  expect(Math.abs(back.to.width - home.width)).toBeLessThanOrEqual(2)
  expect(Math.abs(back.to.height - home.height)).toBeLessThanOrEqual(2)
  // On its way it grows from the corner towards the page, and the tab is already selected then.
  const flying = samples.filter((f) => f.visible && f.width > corner.width && f.width < back.to.width)
  expect(flying.length).toBeGreaterThanOrEqual(FRAME_SLACK > 1 ? 1 : 3)
  for (const f of flying) expect(f.active).toBe(v.id)
  const widths = flying.map((f) => f.width)
  for (let i = 1; i < widths.length; i++) expect(widths[i] as number).toBeGreaterThanOrEqual(widths[i - 1] as number)
  // It ends there: the last frame the player shows is the video's place in the page.
  const shown = samples.filter((f) => f.visible)
  const last = shown.at(-1) as Box
  expect({ x: last.x, y: last.y, width: last.width, height: last.height }).toEqual(back.to)

  // Double-click does the same (MD-07).
  await cmd(app, 'tabs.activate', { tabId: other })
  await expectPlayer(app, v.id)
  await root.dblclick({ position: { x: 30, y: 60 } })
  await expect.poll(() => activeId(app)).toBe(v.id)
  await expectNoPlayer(app)
  expect(await paused(v.page, '#v')).toBe(false)

  // ×: the floating video closes and the media keeps playing, now in the sidebar (MD-07).
  await cmd(app, 'tabs.activate', { tabId: other })
  await expectPlayer(app, v.id)
  await root.hover({ position: { x: 40, y: 60 } })
  await pip.getByTestId('pip-close').click()
  await expectNoPlayer(app)
  const ctl = controller(orbit, v.id)
  await expect(ctl).toBeVisible()
  await expect(ctl.getByTestId('media-title')).toHaveText('Film')
  expect(await paused(v.page, '#v')).toBe(false)
  expect(await activeId(app)).toBe(other)
  await expect.poll(() => floated(v.page)).toBe('')

  // The controller's Picture in Picture ("Back to PiP", MD-10): the player grows out of the
  // controller and the controller leaves the tray.
  const box = await stableBox(orbit.shell, `[data-testid="media-controller"][data-tab-id="${v.id}"]`)
  await ctl.getByTestId('media-pip').click()
  const info = await expectPlayer(app, v.id)
  const from = (info.lastEnter as { from: Box }).from
  expect(Math.abs(from.x + from.width / 2 - (content.x + box.x + box.width / 2))).toBeLessThanOrEqual(2)
  expect(Math.abs(from.y + from.height / 2 - (content.y + box.y + box.height / 2))).toBeLessThanOrEqual(2)
  expect(info.bounds).toEqual(cornerBox(info.workArea as Box, 'bottom-right', 320, 180))
  await expect(controller(orbit, v.id)).toHaveCount(0)
  expect((await media(app, v.id))?.autoPip).toBeUndefined()
})

test('[MD-07][MD-12] closing or navigating the source tab, or the video ending, closes the player', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  // Closing the tab stops its media and the player.
  const a = await openPlaying(app, '/media/long-video/Closing')
  const other = await leave(app)
  await expectPlayer(app, a.id)
  await cmd(app, 'tabs.close', { tabId: a.id })
  await expectNoPlayer(app)
  expect((await state(app)).tabs[a.id]).toBeUndefined()

  // Navigating it elsewhere.
  const b = await openPlaying(app, '/media/long-video/Navigating')
  await cmd(app, 'tabs.activate', { tabId: other })
  await expectPlayer(app, b.id)
  await b.page.evaluate((url) => {
    location.href = url
  }, fx.url('/page/Next/Quiet'))
  await expectNoPlayer(app)
  await waitTab(app, b.id, '/page/Next')
  expect((await media(app, b.id))?.pip).toBeUndefined()

  // The video ends: the player closes and the video doesn't start again.
  const c = await openPlaying(app, '/media/long-video/Ending')
  await cmd(app, 'tabs.activate', { tabId: other })
  await expectPlayer(app, c.id)
  await c.page.evaluate(() => {
    const e = document.getElementById('v') as HTMLVideoElement
    e.currentTime = e.duration - 1
  })
  await expectNoPlayer(app)
  expect(await c.page.evaluate(() => (document.getElementById('v') as HTMLVideoElement).ended)).toBe(true)
  await expect.poll(() => floated(c.page)).toBe('')
  expect(await paused(c.page, '#v')).toBe(true)
})

test('[MD-06][FL-32] the player snaps to the corner a move or fling heads for, resizes from a corner keeping its shape within limits, zooms, and opens where it was left', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const v = await openPlaying(app, '/media/long-video/Film')
  const pip = await pipPage(app)
  const other = await leave(app)
  const info = await expectPlayer(app, v.id)
  const area = info.workArea as Box
  let b = info.bounds as Box

  // A slow drag towards the top-left, released there: it settles in the top-left corner.
  await dragPlayer(pip, 'move', { x: b.x + 100, y: b.y + 50 }, { x: area.x + 300, y: area.y + 200 }, 10, 60)
  await expect.poll(async () => (await player(app)).bounds).toEqual(cornerBox(area, 'top-left', 320, 180))
  await expect.poll(async () => (await state(app)).settings.pipPlacement?.corner).toBe('top-left')

  // A quick flick to the right carries it to the top-right corner, though released on the left.
  b = (await player(app)).bounds as Box
  await dragPlayer(pip, 'move', { x: b.x + 160, y: b.y + 90 }, { x: b.x + 220, y: b.y + 90 }, 2, 8)
  await expect.poll(async () => (await player(app)).bounds).toEqual(cornerBox(area, 'top-right', 320, 180))

  // Dragging the bottom-left corner outwards grows it, keeping 16:9 and the top-right corner put.
  // (The largest size is half the screen's width: stay under it on small screens.)
  const max = Math.floor(area.width / 2)
  const size = Math.min(520, max - 40)
  const tall = Math.round((size * 9) / 16)
  b = (await player(app)).bounds as Box
  // Mostly sideways: the axis that moved further (relative to the player) sets the size.
  const grow = { x: b.x - (size - 320), y: b.y + b.height + (tall - 180) - 4 }
  await dragPlayer(pip, 'bottom-left', { x: b.x, y: b.y + b.height }, grow, 5, 30)
  await expect.poll(async () => (await player(app)).bounds).toEqual(cornerBox(area, 'top-right', size, tall))
  await expect.poll(async () => (await state(app)).settings.pipPlacement).toEqual({ corner: 'top-right', size })
  // The page draws the video at the player's size.
  await expect
    .poll(() => v.page.evaluate(() => (document.getElementById('v') as HTMLVideoElement).getBoundingClientRect().width))
    .toBe(size)

  // Past the largest size it resists, then springs back on release.
  b = (await player(app)).bounds as Box
  const t = Date.now()
  const handle = { x: b.x, y: b.y + b.height }
  await gesture(pip, { phase: 'start', kind: 'bottom-left', ...handle, t })
  await gesture(pip, { phase: 'move', kind: 'bottom-left', x: handle.x - 1500, y: handle.y, t: t + 40 })
  const stretched = (await player(app)).bounds as Box
  expect(stretched.width).toBeGreaterThan(max)
  expect(stretched.width).toBeLessThan(max * 1.25 + 1)
  await gesture(pip, { phase: 'end', kind: 'bottom-left', x: handle.x - 1500, y: handle.y, t: t + 80 })
  await expect.poll(async () => (await player(app)).bounds?.width).toBe(max)

  // And below the smallest (200 px wide).
  b = (await player(app)).bounds as Box
  const t2 = Date.now()
  const handle2 = { x: b.x, y: b.y + b.height }
  await gesture(pip, { phase: 'start', kind: 'bottom-left', ...handle2, t: t2 })
  await gesture(pip, { phase: 'move', kind: 'bottom-left', x: handle2.x + 2000, y: handle2.y, t: t2 + 40 })
  expect(((await player(app)).bounds as Box).width).toBeLessThan(200)
  await gesture(pip, { phase: 'end', kind: 'bottom-left', x: handle2.x + 2000, y: handle2.y, t: t2 + 80 })
  await expect.poll(async () => (await player(app)).bounds).toEqual(cornerBox(area, 'top-right', 200, 113))

  // Hover and scroll sideways: it slides along and settles in the corner it ends up nearest to.
  const root = pip.getByTestId('pip')
  await root.hover({ position: { x: 20, y: 20 } })
  await pip.mouse.wheel(900, 0)
  await expect.poll(async () => (await player(app)).bounds).toEqual(cornerBox(area, 'top-left', 200, 113))

  // ⌘ + scroll (Ctrl + scroll on Windows and Linux) zooms into the video inside the same window.
  await pip.keyboard.down(MOD)
  await pip.mouse.wheel(0, -150)
  await pip.keyboard.up(MOD)
  await expect
    .poll(() =>
      v.page.evaluate(() => new DOMMatrix(getComputedStyle(document.getElementById('v') as Element).transform).a),
    )
    .toBeGreaterThan(1.5)
  expect(((await player(app)).bounds as Box).width).toBe(200)

  // Next time it opens where it was left, at that size.
  await pip.getByTestId('pip').hover({ position: { x: 100, y: 56 } })
  await pip.getByTestId('pip-close').click()
  await expectNoPlayer(app)
  await cmd(app, 'tabs.activate', { tabId: v.id })
  await cmd(app, 'tabs.activate', { tabId: other })
  await expectPlayer(app, v.id)
  await expect.poll(async () => (await player(app)).bounds).toEqual(cornerBox(area, 'top-left', 200, 113))
  // The zoom doesn't carry over.
  expect(await v.page.evaluate(() => getComputedStyle(document.getElementById('v') as Element).transform)).toBe('none')
})

test('[MD-08] the player menu turns automatic picture-in-picture off for today or always; playback continues in the sidebar', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const v = await openPlaying(app, '/media/long-video/Film')
  const pip = await pipPage(app)
  const other = await leave(app)
  await expectPlayer(app, v.id)

  await pip.getByTestId('pip').hover({ position: { x: 40, y: 60 } })
  await pip.getByTestId('pip-more').click()
  await expect.poll(() => mediaHook<string[]>(app, 'playerMenu')).toContain('Turn Off for Today')
  expect(await mediaHook<string[]>(app, 'playerMenu')).toContain('Always Turn Off for This Site')
  expect(await mediaHook(app, 'clickPlayerMenu', 'Turn Off for Today')).toBe(true)
  await expectNoPlayer(app)
  await expect(controller(orbit, v.id)).toBeVisible()
  expect(await paused(v.page, '#v')).toBe(false)
  expect(await cmd(app, 'media.sitePip', { url: v.page.url() })).toBe('today')

  // Leaving the tab again: no player, the sidebar controls instead.
  await cmd(app, 'tabs.activate', { tabId: v.id })
  await cmd(app, 'tabs.activate', { tabId: other })
  expect((await player(app)).opening).toBe(false)
  await expect(controller(orbit, v.id)).toBeVisible()
  await expectNoPlayer(app)

  // Back on: "Always Turn Off for This Site" from the player.
  await cmd(app, 'media.setSitePip', { url: v.page.url(), mode: 'on' })
  await cmd(app, 'tabs.activate', { tabId: v.id })
  await cmd(app, 'tabs.activate', { tabId: other })
  await expectPlayer(app, v.id)
  await cmd(app, 'media.pipMenu', { x: 10, y: 10 })
  expect(await mediaHook(app, 'clickPlayerMenu', 'Always Turn Off for This Site')).toBe(true)
  await expectNoPlayer(app)
  expect(await cmd(app, 'media.sitePip', { url: v.page.url() })).toBe('always')
  expect((await state(app)).settings.pipOffSites).toContain('localhost')
})

test('[MD-08] no automatic picture-in-picture when it is off globally or for the site, or the tab is muted', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const v = await openPlaying(app, '/media/long-video/Film')
  await expect.poll(async () => (await media(app, v.id))?.video).toBe(true)
  const other = await leave(app)
  await expectPlayer(app, v.id)
  await cmd(app, 'tabs.activate', { tabId: v.id })
  await expectNoPlayer(app)

  // Global switch off (Settings › Advanced; also a command bar action): the video shows in the
  // sidebar instead and keeps playing.
  await act(app, 'media.toggleAutoPip')
  expect((await state(app)).settings.autoPip).toBe(false)
  await cmd(app, 'tabs.activate', { tabId: other })
  expect((await player(app)).opening).toBe(false)
  await expect(controller(orbit, v.id)).toBeVisible()
  await expectNoPlayer(app)
  expect(await paused(v.page, '#v')).toBe(false)
  await act(app, 'media.toggleAutoPip')
  await cmd(app, 'tabs.activate', { tabId: v.id })
  await expect(controller(orbit, v.id)).toHaveCount(0)

  // Always off for this site.
  await cmd(app, 'media.setSitePip', { url: fx.url('/'), mode: 'always' })
  expect(await cmd(app, 'media.sitePip', { url: fx.url('/x') })).toBe('always')
  await cmd(app, 'tabs.activate', { tabId: other })
  expect((await player(app)).opening).toBe(false)
  await expect(controller(orbit, v.id)).toBeVisible()
  await expectNoPlayer(app)
  await cmd(app, 'tabs.activate', { tabId: v.id })
  await cmd(app, 'media.setSitePip', { url: fx.url('/'), mode: 'on' })

  // A muted tab neither floats nor shows in the sidebar.
  await cmd(app, 'tabs.setMuted', { tabId: v.id, muted: true })
  await expect.poll(async () => (await tab(app, v.id))?.muted).toBe(true)
  await cmd(app, 'tabs.activate', { tabId: other })
  expect((await player(app)).opening).toBe(false)
  await expectNoPlayer(app)
  await expect.poll(async () => (await media(app, v.id))?.tray).toBe(false)
  await expect(controller(orbit, v.id)).toHaveCount(0)
})

test('[MD-02] Picture in Picture on the selected tab keeps the tab selected; leaving the tab moves the video into the player', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const v = await openPlaying(app, '/media/long-video/Film')
  await expect.poll(async () => (await media(app, v.id))?.video).toBe(true)
  // On the tab, the page stays on screen: the engine's own window shows the video.
  await act(app, 'media.togglePip')
  await expect.poll(() => enginePip(v.page)).toBe(true)
  expect(await activeId(app)).toBe(v.id)
  await expect.poll(async () => (await media(app, v.id))?.pip).toBe(true)
  await act(app, 'media.togglePip')
  await expect.poll(() => enginePip(v.page)).toBe(false)

  // Leaving the tab hands it over to Orbit's player, with Orbit's controls.
  await act(app, 'media.togglePip')
  await expect.poll(() => enginePip(v.page)).toBe(true)
  await leave(app)
  await expectPlayer(app, v.id)
  expect(await enginePip(v.page)).toBe(false)
  expect(await floated(v.page)).toBe('v')
  expect(await paused(v.page, '#v')).toBe(false)
  await cmd(app, 'tabs.activate', { tabId: v.id })
  await expectNoPlayer(app)
  expect(await paused(v.page, '#v')).toBe(false)
})

// ---- Sidebar media controls (MD-09, MD-10) ----

test('[MD-09][SB-10] background audio shows sidebar controls just above the bottom bar: pause, play and jump back to the tab', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const a = await openPlaying(app, '/media/audio/Song%20Page?session')
  await expect.poll(async () => (await media(app, a.id))?.playing).toBe(true)
  // The selected tab never shows its own controller.
  await expect(controller(orbit, a.id)).toHaveCount(0)

  await leave(app)
  const ctl = controller(orbit, a.id)
  await expect(ctl).toBeVisible()
  await expect(ctl.getByTestId('media-title')).toHaveText('Track One')
  await expect(ctl).toContainText('Orbit Test')
  // The tray sits just above the bottom bar and pushes the list up rather than covering it (SB-10).
  const tray = await stableBox(orbit.shell, '[data-testid="media-tray"]')
  const bar = await stableBox(orbit.shell, '[data-testid="spacebar"]')
  const list = await stableBox(orbit.shell, '[data-testid="space-strip"]')
  expect(Math.abs(tray.y + tray.height - bar.y)).toBeLessThanOrEqual(1)
  expect(list.y + list.height).toBeLessThanOrEqual(tray.y + 1)
  // Audio doesn't open the floating player.
  expect((await player(app)).tabId).toBeNull()

  // Pause there and the tab's audio stops; play resumes it.
  await ctl.getByTestId('media-play').click()
  await expect.poll(() => paused(a.page, '#a')).toBe(true)
  await expect(ctl).toHaveAttribute('data-playing', 'false')
  await expect(ctl).toBeVisible()
  await ctl.getByTestId('media-play').click()
  await expect.poll(() => paused(a.page, '#a')).toBe(false)
  await expect(ctl).toHaveAttribute('data-playing', 'true')

  // Clicking the title selects the source tab; its controller goes away.
  await ctl.getByTestId('media-source').click()
  await expect.poll(() => activeId(app)).toBe(a.id)
  await expect(controller(orbit, a.id)).toHaveCount(0)
})

test('[MD-10] several background players stack newest first; pausing one pauses only that tab', async () => {
  orbit = await launchOrbit()
  const { app, shell } = orbit
  const one = await openPlaying(app, '/media/audio/First%20Song')
  const two = await openPlaying(app, '/media/audio/Second%20Song')
  // Leaving "one" for "two" put it in the tray; then leave "two" too.
  await expect(controller(orbit, one.id)).toBeVisible()
  await leave(app)
  await expect(shell.getByTestId('media-controller')).toHaveCount(2)
  await expect(shell.getByTestId('media-controller').first()).toHaveAttribute('data-tab-id', two.id)
  await expect(shell.getByTestId('media-controller').nth(1)).toHaveAttribute('data-tab-id', one.id)

  await controller(orbit, one.id).getByTestId('media-play').click()
  await expect.poll(() => paused(one.page, '#a')).toBe(true)
  expect(await paused(two.page, '#a')).toBe(false)

  // × pauses and removes the controller.
  await controller(orbit, two.id).hover()
  await controller(orbit, two.id).getByTestId('media-close').click()
  await expect.poll(() => paused(two.page, '#a')).toBe(true)
  await expect(controller(orbit, two.id)).toHaveCount(0)
  await expect(controller(orbit, one.id)).toBeVisible()
})

test('[MD-09] next moves the page on to its next track', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const p = await openPlaying(app, '/media/playlist/Playlist')
  await leave(app)
  const ctl = controller(orbit, p.id)
  await expect(ctl.getByTestId('media-title')).toHaveText('Track One')
  await ctl.getByTestId('media-next').click()
  await expect.poll(() => p.page.evaluate(() => document.body.dataset.track)).toBe('Track Two')
  await expect(ctl.getByTestId('media-title')).toHaveText('Track Two')
  expect(await paused(p.page, '#a')).toBe(false)
})

// ---- Tab lifecycle (MD-12) ----

test('[MD-12][TB-16][TD-02] tabs playing media never sleep or auto-archive, muted video and the floating player included', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const a = await openPlaying(app, '/media/audio/Long%20Song')
  const v = await openPlaying(app, '/media/long-video/Film')
  const m = await openPlaying(app, '/media/file-video/Muted%20Film')
  await cmd(app, 'tabs.setMuted', { tabId: m.id, muted: true })
  await leave(app)
  await expect(controller(orbit, a.id)).toBeVisible()
  await expectPlayer(app, v.id)
  await expect.poll(async () => (await media(app, a.id))?.playing).toBe(true)
  await expect.poll(async () => (await media(app, m.id))?.active).toBe(true)

  // Far past the sleep and auto-archive times: the playing tabs stay awake and in Today.
  const later = Date.now() + 30 * 24 * 3600_000
  const run = await tabsHook<{ archived: string[]; slept: string[] }>(app, 'maintenance', later)
  for (const id of [a.id, v.id, m.id]) {
    expect(run.archived).not.toContain(id)
    expect(run.slept).not.toContain(id)
    expect((await tab(app, id))?.asleep).toBe(false)
  }
  expect((await player(app)).tabId).toBe(v.id)

  // Paused, it may sleep like any other tab.
  await cmd(app, 'media.control', { tabId: a.id, action: 'pause' })
  await expect.poll(async () => (await media(app, a.id))?.playing).toBe(false)
  await expect.poll(async () => (await tab(app, a.id))?.audible).toBe(false)
  const run2 = await tabsHook<{ archived: string[]; slept: string[] }>(app, 'maintenance', later)
  expect([...run2.archived, ...run2.slept]).toContain(a.id)
  await expect(controller(orbit, a.id)).toHaveCount(0)
})

test('[MD-07][MD-12] closing a playing tab stops its media and removes its controller', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const a = await openPlaying(app, '/media/audio/Closing%20Song')
  await leave(app)
  await expect(controller(orbit, a.id)).toBeVisible()
  await cmd(app, 'tabs.close', { tabId: a.id })
  await expect(controller(orbit, a.id)).toHaveCount(0)
  expect((await state(app)).tabs[a.id]).toBeUndefined()
})

// ---- Calls (MD-11, MD-13, MD-14) ----

/** The user allowed camera and microphone for the fixture site (Orbit asks once per origin). */
async function allowCamera(app: ElectronApplication): Promise<void> {
  await app.evaluate(
    (_e, origin) => {
      const g = globalThis as unknown as {
        __orbit: { ctx: { sessions: { decide: (p: string, o: string, perm: string, ok: boolean) => void } } }
      }
      g.__orbit.ctx.sessions.decide('persist:orbit-p-default', origin, 'media', true)
    },
    new URL(fx.url('/')).origin,
  )
}

/** Launches Orbit with Chromium's fake camera and microphone. */
async function launchWithFakeDevices(): Promise<Orbit> {
  const userData = mkdtempSync(join(tmpdir(), 'orbit-e2e-'))
  const args = ['--use-fake-device-for-media-stream', resolve('out/main/index.js')]
  if (process.platform === 'linux') args.unshift('--no-sandbox')
  const app = await electron.launch({
    args,
    env: { ...process.env, ORBIT_E2E: '1', ORBIT_USER_DATA: userData } as Record<string, string>,
  })
  const shell = await viewPage(app, 'shell')
  await shell.getByTestId('sidebar').waitFor()
  return { app, shell, userData }
}

test('[MD-14][MD-11][TB-15] a call tab shows camera and microphone indicators and sidebar call controls', async () => {
  orbit = await launchWithFakeDevices()
  const { app, shell } = orbit
  await allowCamera(app)
  const c = await openPlaying(app, '/media/call/Team%20Call', 'in-call')
  await expect.poll(async () => (await media(app, c.id))?.camera).toBe(true)
  expect((await media(app, c.id))?.mic).toBe(true)
  await expect(shell.locator(`[data-tab-id="${c.id}"] [data-testid="tab-capture"]`)).toBeVisible()

  await leave(app)
  const ctl = controller(orbit, c.id)
  await expect(ctl).toBeVisible()
  await ctl.getByTestId('media-mic').click()
  await expect.poll(async () => (await media(app, c.id))?.micMuted).toBe(true)
  expect(
    await c.page.evaluate(
      () =>
        (document.getElementById('self') as HTMLVideoElement).srcObject instanceof MediaStream &&
        (document.getElementById('self') as HTMLVideoElement & { srcObject: MediaStream }).srcObject
          .getAudioTracks()
          .every((t) => !t.enabled),
    ),
  ).toBe(true)
  await ctl.getByTestId('media-camera').click()
  await expect.poll(async () => (await media(app, c.id))?.cameraOff).toBe(true)
  await ctl.getByTestId('media-mic').click()
  await expect.poll(async () => (await media(app, c.id))?.micMuted).toBeUndefined()
})

test('[MD-13][MD-14] leaving a call floats the participant with call controls; closing it leaves call controls in the sidebar', async () => {
  orbit = await launchWithFakeDevices()
  const { app } = orbit
  await allowCamera(app)
  const c = await openPlaying(app, '/media/call/Standup?participant', 'in-call')
  await expect.poll(async () => (await media(app, c.id))?.camera).toBe(true)
  const pip = await pipPage(app)
  await leave(app)
  // The participant (not the self view) floats.
  await expectPlayer(app, c.id)
  expect(await floated(c.page)).toBe('remote')
  await expect(controller(orbit, c.id)).toHaveCount(0)

  // Hover: microphone and camera toggles and the way back to the call (MD-13).
  await pip.getByTestId('pip').hover({ position: { x: 40, y: 60 } })
  await expect(pip.getByTestId('pip-mic')).toBeVisible()
  await expect(pip.getByTestId('pip-camera')).toBeVisible()
  await expect(pip.getByTestId('pip-back')).toHaveAttribute('aria-label', 'Back to call tab')
  await expect(pip.getByTestId('pip-progress')).toHaveCount(0)
  await pip.getByTestId('pip-mic').click()
  await expect.poll(async () => (await media(app, c.id))?.micMuted).toBe(true)
  await expect(pip.getByTestId('pip-mic')).toHaveAttribute('aria-label', 'Turn microphone on')
  await pip.getByTestId('pip-mic').click()
  await expect.poll(async () => (await media(app, c.id))?.micMuted).toBeUndefined()

  // Closing the call window leaves the call controller in the sidebar (MD-14).
  await pip.getByTestId('pip-close').click()
  await expectNoPlayer(app)
  const ctl = controller(orbit, c.id)
  await expect(ctl).toBeVisible()
  await expect(ctl.getByTestId('media-mic')).toBeVisible()
  await expect(ctl.getByTestId('media-camera')).toBeVisible()
  await ctl.getByTestId('media-source').click()
  await expect.poll(() => activeId(app)).toBe(c.id)
})

// ---- Media in Split View (MD-01, MD-11) ----

type ElectronMenu = { items: { label: string; enabled: boolean; submenu?: ElectronMenu | null; click: () => void }[] }

/** From now on, native popup menus are recorded instead of shown (the split row's right-click menu). */
async function recordMenus(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu }) => {
    const g = globalThis as unknown as { __shownMenu?: unknown }
    Menu.prototype.popup = function popup(this: unknown) {
      g.__shownMenu = this
    }
  })
}

/** The last recorded popup menu's items, as "Item > Subitem" paths. */
function shownMenu(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => {
    const walk = (m: ElectronMenu | null | undefined, prefix: string): string[] =>
      (m?.items ?? []).flatMap((i) => [prefix + i.label, ...walk(i.submenu, `${prefix}${i.label} > `)])
    return walk((globalThis as unknown as { __shownMenu?: ElectronMenu }).__shownMenu, '')
  })
}

/** Clicks an item of the last recorded popup menu by its path; false when it is missing or disabled. */
function clickShownMenu(app: ElectronApplication, path: string): Promise<boolean> {
  return app.evaluate((_e, labels) => {
    let menu = (globalThis as unknown as { __shownMenu?: ElectronMenu }).__shownMenu
    let item: ElectronMenu['items'][number] | undefined
    for (const label of labels.split(' > ')) {
      item = menu?.items.find((i) => i.label === label)
      menu = item?.submenu ?? undefined
    }
    if (!item?.enabled) return false
    item.click()
    return true
  }, path)
}

/** A tab view's bounds once they stop changing (a new split lays its panes out with a spring). */
async function stableView(app: ElectronApplication, shell: Page, tabId: string): Promise<Box> {
  let box: Box | undefined
  await expect
    .poll(async () => {
      const a = (await tabView(app, tabId))?.bounds
      await shell.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))),
      )
      box = (await tabView(app, tabId))?.bounds
      return !!a && !!box && JSON.stringify(a) === JSON.stringify(box)
    })
    .toBe(true)
  return box as Box
}

/** Whether a tab's page is muted at the engine level (it plays, but silently). */
function audioMuted(app: ElectronApplication, tabId: string): Promise<boolean | null> {
  return app.evaluate(
    (_e, id) =>
      (
        globalThis as unknown as {
          __orbit: { ctx: { tabs: { contents: (id: string) => Electron.WebContents | undefined } } }
        }
      ).__orbit.ctx.tabs
        .contents(id)
        ?.isAudioMuted() ?? null,
    tabId,
  )
}

test('[MD-11][TB-15] in a split, the split row menu mutes one pane on its own: only that pane goes silent', async () => {
  orbit = await launchOrbit()
  const { app, shell } = orbit
  const one = await openPlaying(app, '/media/audio/First%20Song')
  const two = await openPlaying(app, '/media/audio/Second%20Song')
  expect(await cmd<string | null>(app, 'split.create', { tabIds: [one.id, two.id] })).toBeTruthy()
  const row = shell.getByTestId('split-row')
  const segment = (id: string) => row.locator(`[data-testid="split-segment"][data-tab-id="${id}"]`)
  await expect(row.getByTestId('split-segment')).toHaveCount(2)
  // Two audible panes.
  for (const t of [one, two]) {
    await expect.poll(async () => (await tab(app, t.id))?.audible).toBe(true)
    await expect(segment(t.id).getByRole('button', { name: 'Mute pane' })).toBeVisible()
  }

  // Right-click the split row: each pane has its own entry, by its title, with Mute in it.
  await recordMenus(app)
  await segment(one.id).locator('.split-segment__title').click({ button: 'right' })
  await expect.poll(() => shownMenu(app)).toEqual(expect.arrayContaining(['First Song > Mute', 'Second Song > Mute']))
  expect(await clickShownMenu(app, 'Second Song > Mute')).toBe(true)

  // Only that pane goes silent; both keep playing.
  await expect.poll(async () => (await tab(app, two.id))?.muted).toBe(true)
  expect(await audioMuted(app, two.id)).toBe(true)
  expect((await tab(app, one.id))?.muted).toBeFalsy()
  expect(await audioMuted(app, one.id)).toBe(false)
  expect(await paused(one.page, '#a')).toBe(false)
  expect(await paused(two.page, '#a')).toBe(false)
  await expect(segment(two.id).getByRole('button', { name: 'Unmute pane' })).toBeVisible()
  await expect(segment(one.id).getByRole('button', { name: 'Mute pane' })).toBeVisible()

  // The same menu turns its sound back on.
  await segment(one.id).locator('.split-segment__title').click({ button: 'right' })
  await expect.poll(() => shownMenu(app)).toContain('Second Song > Unmute')
  expect(await clickShownMenu(app, 'Second Song > Unmute')).toBe(true)
  await expect.poll(async () => (await tab(app, two.id))?.muted).toBeFalsy()
  expect(await audioMuted(app, two.id)).toBe(false)
})

test('[MD-01][MD-16] a video in a split pane floats only when the split is left, from its place in the pane, and goes back into it', async () => {
  orbit = await launchOrbit()
  const { app, shell } = orbit
  const v = await openPlaying(app, '/media/long-video/Film')
  await expect.poll(async () => (await media(app, v.id))?.video).toBe(true)
  await pipPage(app)
  const notes = await newTab(app, fx.url('/page/Notes/Quiet'))
  await waitTab(app, notes, '/page/Notes')
  expect(await cmd<string | null>(app, 'split.create', { tabIds: [v.id, notes], focus: notes })).toBeTruthy()
  await expect(shell.getByTestId('split-row').getByTestId('split-segment')).toHaveCount(2)
  await expect.poll(async () => (await tabView(app, v.id))?.visible).toBe(true)
  await expect.poll(async () => (await tabView(app, notes))?.visible).toBe(true)

  // Moving between the split's panes keeps the video on screen in its pane: nothing floats.
  for (const id of [v.id, notes]) {
    await cmd(app, 'split.focusPane', { tabId: id })
    await expect.poll(() => activeId(app)).toBe(id)
    const p = await player(app)
    expect(p.opening || p.tabId !== null).toBe(false)
  }
  expect(await floated(v.page)).toBe('')
  expect(await paused(v.page, '#v')).toBe(false)

  // Leaving the split floats it, starting from its place in its pane (MD-01, MD-16).
  const pane = await stableView(app, shell, v.id)
  const content = (await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.getContentBounds(),
  )) as Box
  const home = await v.page.evaluate(() => {
    const r = (document.getElementById('v') as HTMLVideoElement).getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  const other = await leave(app)
  const info = await expectPlayer(app, v.id)
  expect(await activeId(app)).toBe(other)
  const from = (info.lastEnter as { from: Box }).from
  expect(Math.abs(from.x - (content.x + pane.x + home.x))).toBeLessThanOrEqual(2)
  expect(Math.abs(from.y - (content.y + pane.y + home.y))).toBeLessThanOrEqual(2)
  expect(Math.abs(from.width - home.width)).toBeLessThanOrEqual(2)
  expect(info.bounds).toEqual(cornerBox(info.workArea as Box, 'bottom-right', 320, 180))
  expect(await floated(v.page)).toBe('v')

  // Back on the split (by its other pane): the video goes back into its pane, at the pane's size,
  // still playing.
  await cmd(app, 'tabs.activate', { tabId: notes })
  await expectNoPlayer(app)
  await expect.poll(() => floated(v.page)).toBe('')
  // (Within a pixel or so: the split's layout rounds fractional pane sizes.)
  await expect
    .poll(async () => {
      const b = (await tabView(app, v.id))?.bounds
      return !!b && (['x', 'y', 'width', 'height'] as const).every((k) => Math.abs(b[k] - pane[k]) <= 2)
    })
    .toBe(true)
  await expect.poll(async () => (await tabView(app, v.id))?.visible).toBe(true)
  expect(await paused(v.page, '#v')).toBe(false)
  await expect.poll(async () => (await media(app, v.id))?.pip).toBe(false)
})

test("[MD-01] a late resize from the tab's own window (a split still settling) does not cancel the video's move into the player", async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const v = await openPlaying(app, '/media/long-video/Film')
  await expect.poll(async () => (await media(app, v.id))?.video).toBe(true)
  // The page script, as the player calls it.
  const agent = <T>(fn: string, ...args: unknown[]) =>
    app.evaluate(
      (_e, [id, name, rest]) =>
        (
          (globalThis as unknown as { __orbitMedia: MediaTestHooks }).__orbitMedia.manager.player as unknown as {
            host: PlayerHost
          }
        ).host.call(id, name, ...rest),
      [v.id, fn, args] as const,
    ) as Promise<T>
  expect((await agent<{ ok: boolean }>('probe', { auto: true }))?.ok).toBe(true)
  const size = await v.page.evaluate(() => ({ w: innerWidth, h: innerHeight }))
  // The lift waits for the player's size: nothing changes in the page until then.
  const css = { w: 320, h: 180 }
  expect(await agent('lift', { from: css, to: css, ms: 0, arm: { w: size.w + 120, h: size.h + 24 } })).toBe(true)
  expect(await floated(v.page)).toBe('')
  // A resize at the page's old size arrives late: the lift still waits.
  await v.page.evaluate(() => dispatchEvent(new Event('resize')))
  await v.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  expect(await agent('lifted')).toBe(true)
  expect(await floated(v.page)).toBe('')
  // The player giving up puts everything back.
  expect(await agent('drop')).toBe(true)
  expect(await agent('lifted')).toBe(false)
  expect(await paused(v.page, '#v')).toBe(false)
})
