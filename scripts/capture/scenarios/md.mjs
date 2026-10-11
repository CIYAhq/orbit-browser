/**
 * Picture-in-picture (MD-01, MD-03, MD-04, MD-07, MD-16; FL-32), about 14 s, for the "feels right"
 * sign-off (D48). Leaving a tab whose video plays moves the video into the floating player at the
 * bottom-right; the pointer over it shows its controls; selecting the tab again puts the video back in
 * the page, still playing; "Back to tab" plays the reverse motion.
 *
 * Each step prints a `[mark] <name> <ms>` line on stderr: its time from the start of the recording,
 * so frames around it can be cut from the clip.
 */
import { execFile } from 'node:child_process'

let t0 = 0
const mark = (name) => console.error(`[mark] ${name} ${Math.round(performance.now() - t0)}`)

/** A playing video drawn from a canvas (a colour that changes every 40 ms), with a quiet tone: no file, no network. */
const VIDEO = `(() => {
  const box = document.createElement('div')
  box.style.cssText = 'margin:0 0 28px'
  box.innerHTML = '<video id="v" width="640" height="360" playsinline style="border-radius:12px;background:#000"></video><canvas id="c" width="640" height="360" style="position:absolute;left:-9999px"></canvas>'
  document.querySelector('.lead').after(box)
  const c = document.getElementById('c'), g = c.getContext('2d'); let n = 0
  setInterval(() => {
    g.fillStyle = 'hsl(' + (n * 3 % 360) + ',65%,52%)'; g.fillRect(0, 0, 640, 360)
    g.fillStyle = '#fff'; g.font = 'bold 64px system-ui'; g.fillText(String(n++), 40, 300)
  }, 40)
  const stream = c.captureStream(25)
  const ac = new AudioContext(), osc = ac.createOscillator(), gain = ac.createGain(); gain.gain.value = 0.03
  const dest = ac.createMediaStreamDestination(); osc.connect(gain).connect(dest); osc.start()
  stream.addTrack(dest.stream.getAudioTracks()[0])
  const v = document.getElementById('v'); v.srcObject = stream
  return v.play().then(() => 'playing')
})()`

/** Moves the on-screen pointer (display coordinates) in eased steps. */
let at = null
async function pointerTo(x, y, steps = 16) {
  const from = at ?? { x, y }
  for (let i = 1; i <= steps; i++) {
    const k = 0.5 - 0.5 * Math.cos((Math.PI * i) / steps)
    await new Promise((r) =>
      execFile(
        'xdotool',
        ['mousemove', String(Math.round(from.x + (x - from.x) * k)), String(Math.round(from.y + (y - from.y) * k))],
        () => r(),
      ),
    )
  }
  at = { x, y }
}

/** The floating player's window bounds once it shows a video and has settled, or null while it isn't showing. */
const player = (t) =>
  t.app.evaluate(() => {
    const info = globalThis.__orbitMedia.manager.player.info()
    return info.visible && info.holdsView ? info.bounds : null
  })

async function waitFor(t, test, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await test()
    if (v) return v
    await t.sleep(40)
  }
  throw new Error('timed out')
}

let video = ''
let notes = ''

/**
 * Unrecorded: a tab whose video plays, and a second tab to leave it for. The main window leaves the
 * screen's bottom-right corner free: a display with no window manager keeps no window on top, so the
 * player shows only where no other window covers it.
 */
export async function setup(t) {
  const s = await t.state()
  const win = Object.values(s.windows).find((w) => w.kind === 'main')
  await t.app.evaluate(
    (_e, id) => globalThis.__orbit.ctx.windows.get(id)?.setBounds({ x: 0, y: 0, width: 1000, height: 640 }),
    win.id,
  )
  await t.sleep(400)
  notes = await t.run('tabs.create', { url: t.fx.url('Notes'), spaceId: win.spaceId, activate: false })
  video = await t.run('tabs.create', { url: t.fx.url('Film club'), spaceId: win.spaceId, activate: false })
  await t.run('tabs.activate', { tabId: notes })
  await t.sleep(450)
  await t.run('tabs.activate', { tabId: video })
  await t.sleep(900)
  // As if the person pressed play: the script runs with a user gesture, so the sound may start.
  const state = await t.app.evaluate(
    (_e, [id, code]) => globalThis.__orbit.ctx.tabs.get(id).webContents.executeJavaScript(code, true),
    [video, VIDEO],
  )
  if (state !== 'playing') throw new Error(`the video didn't start: ${state}`)
  await t.sleep(1200)
}

export default async function (t) {
  t0 = performance.now()
  await t.sleep(600)

  // MD-01, MD-16: leaving the tab moves its playing video into the floating player, bottom-right.
  mark('leave')
  await t.run('tabs.activate', { tabId: notes })
  const box = await waitFor(t, () => player(t))
  await t.sleep(1800)

  // MD-04: the pointer over the player shows its controls.
  mark('hover')
  await pointerTo(box.x + box.width / 2, box.y + box.height / 2, 20)
  await t.sleep(1400)
  await pointerTo(box.x - 260, box.y - 220, 16)
  await t.sleep(600)

  // MD-01: selecting the tab again puts the video back in the page, still playing, without a blank frame.
  mark('back')
  await t.run('tabs.activate', { tabId: video })
  await waitFor(t, async () => !(await player(t)))
  await t.sleep(1500)

  // MD-07, MD-16: "Back to tab" from the player plays the reverse motion toward the page.
  mark('leave-2')
  await t.run('tabs.activate', { tabId: notes })
  await waitFor(t, () => player(t))
  await t.sleep(1500)
  mark('pip-back')
  await t.run('media.pipBack', {})
  await waitFor(t, async () => !(await player(t)))
  await t.sleep(1500)
  mark('end')
}
