/**
 * Picture-in-picture's other ways back (MD-01, MD-07; FL-29), about 16 s, for the "feels right"
 * sign-off (D48). `md` shows selecting the tab and Back to tab, where the page the window showed stays
 * until the video's page has drawn. Here no such page is left: ⌘W on a tab right above the video's tab,
 * so that the video's tab comes next (TB-06); selecting it from an empty Space; and selecting its split
 * from an empty Space. Its pane shows its blank card until the page has drawn (FL-29 allows that
 * placeholder), and never a frame of its player layout.
 *
 * Each step prints a `[mark] <name> <ms>` line on stderr: its time since the scenario began.
 * record.mjs begins it 0.7 s after the recording starts, so a step shows about 0.7 s later in the clip.
 */

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

/** The main window's selected tab, in the Space it shows. */
const activeTab = async (t) => {
  const s = await t.state()
  const w = Object.values(s.windows).find((w) => w.kind === 'main')
  return w?.activeTab[w.spaceId] ?? null
}

let video = ''
let home = ''

/**
 * Unrecorded: a tab whose video plays. The main window leaves the screen's bottom-right corner free:
 * a display with no window manager keeps no window on top, so the player shows only where no other
 * window covers it.
 */
export async function setup(t) {
  const s = await t.state()
  const win = Object.values(s.windows).find((w) => w.kind === 'main')
  home = win.spaceId
  // From a task of its own, as record.mjs resizes: the inspector runs an evaluate by interrupt, and Orbit's
  // resize handler would run part-way through other main-process code.
  await t.app.evaluate(async (_e, id) => {
    await new Promise((r) => setImmediate(r))
    globalThis.__orbit.ctx.windows.get(id)?.setBounds({ x: 0, y: 0, width: 1000, height: 640 })
  }, win.id)
  await t.sleep(400)
  video = await t.run('tabs.create', { url: t.fx.url('Film club'), spaceId: home })
  await t.sleep(1200)
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

  // A quiet tab opened right above the video's tab: the video moves into the player. ⌘W closes the quiet
  // tab and selects the next one, the video's (TB-06), with no page left over its view.
  mark('above')
  const s = await t.state()
  const today = s.spaces[home]?.today ?? []
  await t.run('tabs.create', { url: t.fx.url('Notes'), spaceId: home, index: today.indexOf(video) })
  await waitFor(t, () => player(t))
  await t.sleep(1500)
  mark('close-above')
  await t.key('Mod+W')
  await waitFor(t, async () => !(await player(t)))
  await t.sleep(1600)

  // An empty Space: the video moves into the player. Selecting its tab goes back to its Space.
  mark('empty-space')
  await t.run('spaces.create', { name: 'Empty' })
  await waitFor(t, () => player(t))
  await t.sleep(1500)
  mark('back-from-empty')
  await t.run('tabs.activate', { tabId: video })
  await waitFor(t, async () => !(await player(t)) && (await activeTab(t)) === video)
  await t.sleep(1600)

  // The video's tab in a split with a quiet tab, then an empty Space, and back to the split.
  mark('split')
  const other = await t.run('tabs.create', { url: t.fx.url('Reading list'), spaceId: home, activate: false })
  await t.run('split.create', { tabIds: [video, other], focus: video })
  await t.sleep(1800)
  mark('split-empty-space')
  await t.run('spaces.create', { name: 'Empty 2' })
  await waitFor(t, () => player(t))
  await t.sleep(1500)
  mark('back-to-split')
  await t.run('tabs.activate', { tabId: video })
  await waitFor(t, async () => !(await player(t)) && (await activeTab(t)) === video)
  await t.sleep(1600)
  mark('end')
}
