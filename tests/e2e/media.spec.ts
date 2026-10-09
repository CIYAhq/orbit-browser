/**
 * Media lane e2e (media.md): picture-in-picture, the sidebar media tray, call controls and media
 * in the tab lifecycle. All media is generated locally: a WAV tone written here, a canvas
 * captureStream() video with an oscillator soundtrack, and a short WebM recorded in the page.
 */
import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test'
import type { MediaTestHooks } from '../../src/main/media'
import type { TabMedia } from '../../src/shared/state'
import { launchOrbit, type Orbit, state, tabPage, viewPage } from './helpers'
import { act, activeId, cmd, newTab, setState, tab, tabsHook, waitTab } from './tabs-support'

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

/** A real (file-backed) looping video: records a short WebM in the page, then plays it from a blob URL. */
const FILE_VIDEO = `
<video id="v" width="320" height="180" loop playsinline></video>
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
    if (parts[0] === 'media' && parts[1] === 'file-video') return html(FILE_VIDEO)
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
  await expect.poll(() => p.evaluate(() => document.body.dataset.state ?? '')).toBe(until)
  return { id, page: p }
}

const pipShowing = (p: Page) => p.evaluate(() => !!document.pictureInPictureElement)
const paused = (p: Page, selector: string) =>
  p.evaluate((s) => (document.querySelector(s) as HTMLMediaElement | null)?.paused ?? null, selector)
const controller = (o: Orbit, tabId: string) =>
  o.shell.locator(`[data-testid="media-controller"][data-tab-id="${tabId}"]`)

function mediaHook<T>(app: ElectronApplication, name: 'lastMenu' | 'clickMenu', arg?: string): Promise<T> {
  return app.evaluate(
    (_e, [n, a]) => {
      const hooks = (globalThis as unknown as { __orbitMedia: MediaTestHooks }).__orbitMedia
      return (hooks[n] as (x?: string) => unknown)(a)
    },
    [name, arg] as const,
  ) as Promise<T>
}

// ---- Tests ----

test('[MD-09] background audio shows sidebar controls: pause, play and jump back to the tab', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const a = await openPlaying(app, '/media/audio/Song%20Page?session')
  await expect.poll(async () => (await media(app, a.id))?.playing).toBe(true)
  // The selected tab never shows its own controller.
  await expect(controller(orbit, a.id)).toHaveCount(0)

  const b = await newTab(app, fx.url('/page/Other/Quiet'))
  await waitTab(app, b, '/page/Other')
  const ctl = controller(orbit, a.id)
  await expect(ctl).toBeVisible()
  await expect(ctl.getByTestId('media-title')).toHaveText('Track One')
  await expect(ctl).toContainText('Orbit Test')

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

test('[MD-01][MD-03] leaving a tab with a playing video opens picture-in-picture; returning ends it', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const v = await openPlaying(app, '/media/video/Video%20Page')
  await expect.poll(async () => (await media(app, v.id))?.video).toBe(true)
  expect(await pipShowing(v.page)).toBe(false)

  const started = Date.now()
  const b = await newTab(app, fx.url('/page/Elsewhere/Quiet'))
  await expect.poll(() => pipShowing(v.page), { timeout: 3000 }).toBe(true)
  expect(Date.now() - started).toBeLessThan(3000)
  await expect.poll(async () => (await media(app, v.id))?.autoPip).toBe(true)
  // A video in picture-in-picture is not also in the sidebar tray.
  await expect(controller(orbit, v.id)).toHaveCount(0)
  expect(await activeId(app)).toBe(b)

  // Back on the tab: picture-in-picture ends and the video keeps playing in the page.
  await cmd(app, 'tabs.activate', { tabId: v.id })
  await expect.poll(() => pipShowing(v.page)).toBe(false)
  expect(await paused(v.page, '#v')).toBe(false)
  await expect.poll(async () => (await media(app, v.id))?.pip).toBe(false)
})

test('[MD-08] no automatic picture-in-picture when it is off globally or for the site, or the tab is muted', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const v = await openPlaying(app, '/media/video/Video%20Page')
  await expect.poll(async () => (await media(app, v.id))?.video).toBe(true)
  const other = await newTab(app, fx.url('/page/Other/Quiet'))
  await waitTab(app, other, '/page/Other')
  await expect.poll(() => pipShowing(v.page)).toBe(true)
  await cmd(app, 'tabs.activate', { tabId: v.id })
  await expect.poll(() => pipShowing(v.page)).toBe(false)

  // Global switch off (Settings › Advanced; also a command bar action): the video shows in the
  // sidebar instead and keeps playing.
  await act(app, 'media.toggleAutoPip')
  expect((await state(app)).settings.autoPip).toBe(false)
  await cmd(app, 'tabs.activate', { tabId: other })
  await expect(controller(orbit, v.id)).toBeVisible()
  expect(await pipShowing(v.page)).toBe(false)
  expect(await paused(v.page, '#v')).toBe(false)
  await act(app, 'media.toggleAutoPip')
  await cmd(app, 'tabs.activate', { tabId: v.id })
  await expect(controller(orbit, v.id)).toHaveCount(0)

  // Always off for this site.
  await cmd(app, 'media.setSitePip', { url: fx.url('/'), mode: 'always' })
  expect(await cmd(app, 'media.sitePip', { url: fx.url('/x') })).toBe('always')
  await cmd(app, 'tabs.activate', { tabId: other })
  await expect(controller(orbit, v.id)).toBeVisible()
  expect(await pipShowing(v.page)).toBe(false)
  await cmd(app, 'tabs.activate', { tabId: v.id })
  await cmd(app, 'media.setSitePip', { url: fx.url('/'), mode: 'on' })

  // A muted tab neither opens picture-in-picture nor shows in the sidebar.
  await cmd(app, 'tabs.setMuted', { tabId: v.id, muted: true })
  await cmd(app, 'tabs.activate', { tabId: other })
  await expect.poll(async () => (await tab(app, v.id))?.muted).toBe(true)
  await new Promise((r) => setTimeout(r, 500))
  expect(await pipShowing(v.page)).toBe(false)
  await expect(controller(orbit, v.id)).toHaveCount(0)
})

test('[MD-07][MD-10] closing picture-in-picture keeps the media playing in the sidebar; Picture in Picture sends it back', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const v = await openPlaying(app, '/media/video/Video%20Page')
  await expect.poll(async () => (await media(app, v.id))?.video).toBe(true)
  const other = await newTab(app, fx.url('/page/Other/Quiet'))
  await waitTab(app, other, '/page/Other')
  await expect.poll(() => pipShowing(v.page)).toBe(true)

  // The player closes (its ×) without Orbit asking: the video keeps playing, now in the sidebar.
  await v.page.evaluate(() => document.exitPictureInPicture())
  const ctl = controller(orbit, v.id)
  await expect(ctl).toBeVisible()
  expect(await paused(v.page, '#v')).toBe(false)
  expect(await activeId(app)).toBe(other)

  // "Back to PiP" from the controller: the floating player opens and the controller leaves the tray.
  await ctl.getByTestId('media-pip').click()
  await expect.poll(() => pipShowing(v.page)).toBe(true)
  await expect(controller(orbit, v.id)).toHaveCount(0)
})

test('[MD-04][MD-07] Back to tab in the floating player selects the source tab, still playing', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const v = await openPlaying(app, '/media/file-video/Film')
  await expect.poll(async () => (await media(app, v.id))?.video).toBe(true)
  const other = await newTab(app, fx.url('/page/Other/Quiet'))
  await waitTab(app, other, '/page/Other')
  await expect.poll(() => pipShowing(v.page)).toBe(true)
  // The player's "Back to tab" ends picture-in-picture and leaves the video playing.
  await v.page.evaluate(() => document.exitPictureInPicture())
  await expect.poll(() => activeId(app)).toBe(v.id)
  expect(await paused(v.page, '#v')).toBe(false)
  expect(await pipShowing(v.page)).toBe(false)
})

test('[MD-10] several background players stack newest first; pausing one pauses only that tab', async () => {
  orbit = await launchOrbit()
  const { app, shell } = orbit
  const one = await openPlaying(app, '/media/audio/First%20Song')
  const two = await openPlaying(app, '/media/audio/Second%20Song')
  // Leaving "one" for "two" put it in the tray; then leave "two" too.
  await expect(controller(orbit, one.id)).toBeVisible()
  const quiet = await newTab(app, fx.url('/page/Other/Quiet'))
  await waitTab(app, quiet, '/page/Other')
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
  const quiet = await newTab(app, fx.url('/page/Other/Quiet'))
  await waitTab(app, quiet, '/page/Other')
  const ctl = controller(orbit, p.id)
  await expect(ctl.getByTestId('media-title')).toHaveText('Track One')
  await ctl.getByTestId('media-next').click()
  await expect.poll(() => p.page.evaluate(() => document.body.dataset.track)).toBe('Track Two')
  await expect(ctl.getByTestId('media-title')).toHaveText('Track Two')
  expect(await paused(p.page, '#a')).toBe(false)
})

test('[MD-12][TB-16][TD-02] tabs playing media never sleep or auto-archive; closing one removes its controller', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const a = await openPlaying(app, '/media/audio/Long%20Song')
  const quiet = await newTab(app, fx.url('/page/Other/Quiet'))
  await waitTab(app, quiet, '/page/Other')
  await expect(controller(orbit, a.id)).toBeVisible()
  await expect.poll(async () => (await media(app, a.id))?.playing).toBe(true)

  // Far past the sleep and auto-archive times: the playing tab stays awake and in Today.
  const later = Date.now() + 30 * 24 * 3600_000
  const run = await tabsHook<{ archived: string[]; slept: string[] }>(app, 'maintenance', later)
  expect(run.archived).not.toContain(a.id)
  expect(run.slept).not.toContain(a.id)
  expect((await tab(app, a.id))?.asleep).toBe(false)

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
  const quiet = await newTab(app, fx.url('/page/Other/Quiet'))
  await waitTab(app, quiet, '/page/Other')
  await expect(controller(orbit, a.id)).toBeVisible()
  await cmd(app, 'tabs.close', { tabId: a.id })
  await expect(controller(orbit, a.id)).toHaveCount(0)
  expect((await state(app)).tabs[a.id]).toBeUndefined()
})

test('[MD-02][MD-08] Picture in Picture on the selected tab; the controller menu turns it off for a site', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const v = await openPlaying(app, '/media/video/Video%20Page')
  await expect.poll(async () => (await media(app, v.id))?.video).toBe(true)
  // Manual picture-in-picture keeps the tab selected.
  await act(app, 'media.togglePip')
  await expect.poll(() => pipShowing(v.page)).toBe(true)
  expect(await activeId(app)).toBe(v.id)
  await act(app, 'media.togglePip')
  await expect.poll(() => pipShowing(v.page)).toBe(false)

  // The controller's menu (right-click): the site's automatic picture-in-picture choice.
  await setState(app, 'd.settings.autoPip = false')
  const other = await newTab(app, fx.url('/page/Other/Quiet'))
  await waitTab(app, other, '/page/Other')
  await controller(orbit, v.id).click({ button: 'right' })
  await expect
    .poll(() => mediaHook<string[]>(app, 'lastMenu'))
    .toContain('Automatic Picture in Picture on localhost > Turn Off for Today')
  expect(await mediaHook(app, 'clickMenu', 'Automatic Picture in Picture on localhost > Turn Off for Today')).toBe(true)
  expect(await cmd(app, 'media.sitePip', { url: v.page.url() })).toBe('today')
  expect((await state(app)).settings.pipSnoozed?.localhost).toBeGreaterThan(Date.now())
})

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

  const quiet = await newTab(app, fx.url('/page/Other/Quiet'))
  await waitTab(app, quiet, '/page/Other')
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

test('[MD-13][MD-14] leaving a call shows the participant in picture-in-picture; closing it leaves call controls in the sidebar', async () => {
  orbit = await launchWithFakeDevices()
  const { app } = orbit
  await allowCamera(app)
  const c = await openPlaying(app, '/media/call/Standup?participant', 'in-call')
  await expect.poll(async () => (await media(app, c.id))?.camera).toBe(true)
  const quiet = await newTab(app, fx.url('/page/Other/Quiet'))
  await waitTab(app, quiet, '/page/Other')
  // The participant (not the self view) floats.
  await expect.poll(() => c.page.evaluate(() => document.pictureInPictureElement?.id ?? '')).toBe('remote')
  await expect(controller(orbit, c.id)).toHaveCount(0)

  // Closing the call window leaves the call controller in the sidebar (MD-14).
  await c.page.evaluate(() => document.exitPictureInPicture())
  const ctl = controller(orbit, c.id)
  await expect(ctl).toBeVisible()
  await expect(ctl.getByTestId('media-mic')).toBeVisible()
  await expect(ctl.getByTestId('media-camera')).toBeVisible()
  await ctl.getByTestId('media-source').click()
  await expect.poll(() => activeId(app)).toBe(c.id)
})
