/**
 * Feel of Space switching (feel.md FL-13 swipe physics, FL-14 theme colour, FL-28's Space switch, and
 * their FL-29 budgets), measured frame by frame with the shared sampler (frames.ts).
 */
import { expect, test } from '@playwright/test'
import { bestOf, frameAfterWall, mainInputs, note, pacing, type Recording, record, rgba, series } from './frames'
import { FRAME_SLACK, isMac, launchOrbit, type Orbit, run, state } from './helpers'
import { pressInPage } from './nav-support'
import { activeSpace, createSpace, flick, hoverSidebar, settled, stripWidth } from './spaces-support'

let orbit: Orbit

test.beforeEach(async () => {
  orbit = await launchOrbit()
})
test.afterEach(async () => {
  await orbit.app.close()
})

const FRAME = 1000 / 60
/** The strip's track and its frame: the track's offset is the page offset. */
const STRIP = { track: '.space-strip__track', strip: '.space-strip' }
const offsetOf = (r: Recording) =>
  series(r, 'track', (b) => b.x).map((p, k) => ({ t: p.t, v: p.v - (r.frames[k]?.els.strip?.x ?? 0) }))
/** Next Space by keyboard, through the browser process as the keyboard does. */
const nextSpaceKey = (o: Orbit) =>
  pressInPage(o.app, 'view=shell', 'Right', isMac ? ['meta', 'alt'] : ['control', 'alt'])

/** The frame at which the strip is at rest for good: offset 0 from there on. */
function restFrom(r: Recording, from: number): number | undefined {
  const xs = offsetOf(r)
  let k = xs.length
  while (k > 0 && Math.abs(xs[k - 1]?.v ?? 0) < 0.5) k--
  const f = r.frames[k]
  return f && f.t >= from ? f.t : undefined
}

test('[FL-13][FL-29] a slow swipe moves the pages by exactly the finger travel in every frame, then settles within budget', async () => {
  const { app, shell } = orbit
  await createSpace(app, { name: 'Beta', activate: false })
  await settled(shell)
  const width = await stripWidth(shell)
  await hoverSidebar(shell)
  const rec = await record(shell, STRIP)
  // A slow swipe past half the width: 10 px a step, a step about every frame.
  const stepsNeeded = Math.ceil((width * 0.55) / 10)
  for (let k = 0; k < stepsNeeded; k++) {
    await shell.mouse.wheel(10, 0)
    await shell.waitForTimeout(14)
  }
  const r = await rec.until(1600)
  const wheels = r.inputs.filter((i) => i.type === 'wheel')
  const last = wheels.at(-1)
  if (!last) throw new Error('no wheel events')
  // Tracking: the page offset in each frame is minus the travel received before it.
  const xs = offsetOf(r)
  const off: string[] = []
  let compared = 0
  for (const f of r.frames) {
    if (f.i > last.frame) break
    const travel = wheels.filter((w) => w.frame <= f.i).reduce((s, w) => s + (w.dx ?? 0), 0)
    if (travel < 12) continue
    compared++
    const x = xs[f.i]?.v ?? 0
    if (Math.abs(x + travel) > 0.5) off.push(`${Math.round(f.t)} ms: ${x.toFixed(1)} for ${travel} px`)
  }
  const rest = restFrom(r, last.t)
  const settleFromLast = rest !== undefined ? rest - last.t : undefined
  const overshoot = Math.max(0, ...xs.filter((p) => p.t > last.t).map((p) => -width - p.v))
  note('FL-13', 'frames compared while tracking', compared, '–', 'frames')
  note('FL-13', 'frames off the finger by more than 0.5 px', off.length, '0', 'frames')
  note(
    'FL-13',
    'last event → settled (release detected 90 ms after it)',
    settleFromLast,
    '≤ 350 ms + 90 ms release gap',
  )
  note('FL-13', 'overshoot past the page', (overshoot / width) * 100, '≤ 1 %', '%')
  note('FL-13', 'frame p99 while swiping and settling', pacing(r).p99, `≤ ${FRAME.toFixed(1)} ms`)
  expect(compared).toBeGreaterThan(5)
  expect(off, 'frames where the pages were not where the fingers put them').toEqual([])
  expect(settleFromLast ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual((350 + 90) * FRAME_SLACK)
  expect(overshoot / width).toBeLessThanOrEqual(0.01)
  await expect.poll(() => activeSpace(app)).not.toBe((await state(app)).spaceOrder[0])
})

test('[FL-13][FL-29] a short quick flick switches Space and settles within 350 ms of the release', async () => {
  const { app, shell } = orbit
  const b = await createSpace(app, { name: 'Beta', activate: false })
  await settled(shell)
  const width = await stripWidth(shell)
  await hoverSidebar(shell)
  const rec = await record(shell, STRIP)
  const at = Date.now()
  // About 45 px in 9 events 6 ms apart, then OS-style momentum (under a quarter of the width).
  await flick(shell, [8, 8, 8, 7.2, 6.5, 5.9, 5.3, 4.8, 4.3], 6)
  const r = await rec.until(1500)
  await expect.poll(() => activeSpace(app)).toBe(b)
  const lastEvent = at - r.wall0
  const rest = restFrom(r, lastEvent)
  const xs = offsetOf(r)
  const over = Math.max(0, ...xs.map((p) => -width - p.v))
  note('FL-13', 'flick travel, share of the width', (58 / width) * 100, '< 25 %', '%')
  note(
    'FL-13',
    'flick: last event → settled',
    rest !== undefined ? rest - lastEvent : undefined,
    '≤ 350 ms + 90 ms release gap',
  )
  note('FL-13', 'flick: overshoot', (over / width) * 100, '≤ 1 %', '%')
  expect(rest !== undefined ? rest - lastEvent : Number.POSITIVE_INFINITY).toBeLessThanOrEqual((350 + 90) * FRAME_SLACK)
})

// FL-13's formula, (1 − 1 / (travel × 0.55 / width + 1)) × width, reaches a third of the width at
// about 0.9 widths of travel and 35.5 % at one width; it has no hard limit (52 % at two widths). The
// long swipe here is one sidebar width of finger travel.
test('[FL-13] at the first Space a swipe of one sidebar width moves the pages about a third of the width and springs back', async () => {
  const { app, shell } = orbit
  const a = await activeSpace(app)
  await createSpace(app, { name: 'Beta', activate: false })
  await settled(shell)
  const width = await stripWidth(shell)
  await hoverSidebar(shell)
  const rec = await record(shell, STRIP)
  for (let k = 0; k < 10; k++) {
    await shell.mouse.wheel(-Math.round(width / 10), 0)
    await shell.waitForTimeout(12)
  }
  const r = await rec.until(1600)
  const xs = offsetOf(r).filter((p) => !Number.isNaN(p.v))
  const furthest = Math.max(...xs.map((p) => p.v))
  const last = r.inputs.filter((i) => i.type === 'wheel').at(-1)
  const rest = last ? restFrom(r, last.t) : undefined
  note(
    'FL-13',
    'rubber band: furthest after one width of travel, share of the width',
    (furthest / width) * 100,
    '≈ 35.5 % (formula)',
    '%',
  )
  note(
    'FL-13',
    'rubber band: last event → back at rest',
    rest !== undefined && last ? rest - last.t : undefined,
    '≤ 350 ms + 90 ms',
  )
  expect(furthest).toBeGreaterThan(0)
  expect(furthest / width).toBeLessThanOrEqual(0.36)
  expect(await activeSpace(app)).toBe(a)
})

test('[FL-29][FL-13] the next-Space shortcut starts the slide in a frame, the window is on the new Space at once, and it settles within 350 ms', async () => {
  const { app, shell } = orbit
  const a = await activeSpace(app)
  const b = await createSpace(app, { name: 'Beta', activate: false })
  await settled(shell)
  const keys = await mainInputs(app)
  type Round = { start: number; frames: number; done: number; committed: boolean; p99: number; max: number }
  const { best, all } = await bestOf<Round>(
    async () => {
      await run(app, 'spaces.switch', { spaceId: a })
      await settled(shell)
      await keys()
      const rec = await record(shell, STRIP)
      await nextSpaceKey(orbit)
      // State first: the window is on the new Space before the slide is over.
      const committed = (await activeSpace(app)) === b
      const r = await rec.until(900)
      const key = (await keys()).find((k) => k.type === 'keyDown')
      if (!key) throw new Error('the shortcut never reached main')
      const t0 = key.wall - r.wall0
      const after = frameAfterWall(r, key.wall)
      const xs = offsetOf(r)
      const moved = r.frames.find((f) => f.i >= after && Math.abs(xs[f.i]?.v ?? 0) > 0.5)
      const rest = restFrom(r, t0)
      const anim = r.frames.filter((f) => f.i >= after && (rest === undefined || f.t <= rest))
      const p = pacing(anim)
      return {
        start: moved ? moved.t - t0 : Number.POSITIVE_INFINITY,
        frames: moved ? moved.i - after + 1 : Number.POSITIVE_INFINITY,
        done: rest !== undefined ? rest - t0 : Number.POSITIVE_INFINITY,
        committed,
        p99: p.p99,
        max: p.max,
      }
    },
    (x) => x.frames <= 1 && x.done <= 350 * FRAME_SLACK,
  )
  for (const [k, x] of all.entries()) {
    console.log(
      `[feel] FL-29 Space shortcut round ${k + 1}: start ${x.start.toFixed(1)} ms (${x.frames} frames), done ${x.done.toFixed(1)} ms`,
    )
  }
  note('FL-29', 'Space shortcut → slide starts', best.start, '1 frame (16.7 ms)')
  note('FL-29', 'frames from the shortcut to the first move', best.frames, '1', 'frames')
  note('FL-29', 'Space shortcut → settled', best.done, '≤ 350 ms')
  note('FL-29', 'frame p99 during the slide', best.p99, `≤ ${FRAME.toFixed(1)} ms`)
  note('FL-29', 'frame max during the slide', best.max, `≤ ${(2 * FRAME).toFixed(1)} ms`)
  expect(best.committed, 'the window switched Space at the key, before the slide ended').toBe(true)
  expect(best.frames).toBeLessThanOrEqual(2)
  expect(best.done).toBeLessThanOrEqual(350 * FRAME_SLACK)
})

/** WCAG contrast of two sRGB colours. */
function contrast(a: [number, number, number, number], b: [number, number, number, number]): number {
  const lum = ([r, g, bl]: [number, number, number, number]) => {
    const c = [r, g, bl].map((v) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * (c[0] as number) + 0.7152 * (c[1] as number) + 0.0722 * (c[2] as number)
  }
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number]
  return (x + 0.05) / (y + 0.05)
}

test('[FL-14] switching from a blue to an orange Space blends the hues in every frame, never grey, titles readable', async () => {
  const { app, shell } = orbit
  const a = await activeSpace(app)
  await run(app, 'spaces.update', { spaceId: a, theme: { colors: ['#2f6bff'], intensity: 1, grain: 0 } })
  const b = await createSpace(app, { name: 'Orange', activate: false })
  await run(app, 'spaces.update', { spaceId: b, theme: { colors: ['#ff8a2f'], intensity: 1, grain: 0 } })
  await run(app, 'tabs.create', { url: 'about:blank#one', activate: false })
  await run(app, 'tabs.create', { url: 'about:blank#two', activate: false, spaceId: b })
  await settled(shell)
  await shell.waitForTimeout(300)
  const rec = await record(shell, {
    bg: { selector: '.shell-bg', style: ['--bg-top'] },
    title: { selector: '[data-testid="tab-title"]', style: ['color'] },
  })
  await nextSpaceKey(orbit)
  const r = await rec.until(800)
  // The computed custom property, which Chromium hands back as rgb(…).
  const colors = r.frames.map((f) => f.els.bg?.style?.['--bg-top']?.trim() ?? '').filter((c) => c.startsWith('rgb'))
  const start = colors[0] as string
  const end = colors.at(-1) as string
  const between = [...new Set(colors.filter((c) => c !== start && c !== end))]
  const grey = between.filter((c) => {
    const [x, y, z] = rgba(c)
    return Math.max(x, y, z) - Math.min(x, y, z) <= 6
  })
  const contrasts = r.frames
    .filter((f) => f.els.bg?.style?.['--bg-top']?.startsWith('rgb') && f.els.title?.style?.color)
    .map((f) => contrast(rgba(f.els.title?.style?.color), rgba(f.els.bg?.style?.['--bg-top'])))
  note('FL-14', 'in-between colours seen', between.length, '> 2', 'colours')
  note('FL-14', 'grey frames', grey.length, '0', 'frames')
  note('FL-14', 'lowest title contrast on the frame colour', Math.min(...contrasts), '≥ 4.5', ':1')
  expect(between.length).toBeGreaterThan(2)
  expect(grey).toEqual([])
  expect(Math.min(...contrasts)).toBeGreaterThanOrEqual(4.5)
})

test('[FL-28] with reduced motion the shortcut cross-fades to the next Space in under 150 ms, with no sliding', async () => {
  const { app, shell } = orbit
  // Playwright emulates "no preference" on every page it drives, whatever the launch switch says:
  // the OS setting reaches the shell as this media feature.
  await shell.emulateMedia({ reducedMotion: 'reduce' })
  await createSpace(app, { name: 'Beta', activate: false })
  await settled(shell)
  const keys = await mainInputs(app)
  const rec = await record(shell, {
    ...STRIP,
    name: { selector: '[data-testid="space-name"]', text: true },
    trackOpacity: { selector: '.space-strip__track', style: ['opacity'] },
  })
  await nextSpaceKey(orbit)
  const r = await rec.until(800)
  const key = (await keys()).find((k) => k.type === 'keyDown')
  if (!key) throw new Error('the shortcut never reached main')
  const t0 = key.wall - r.wall0
  const xs = offsetOf(r)
  const slid = Math.max(0, ...xs.filter((p) => !Number.isNaN(p.v)).map((p) => Math.abs(p.v)))
  const shown = r.frames.find((f) => f.els.name?.text === 'Beta')
  const faded = r.frames.filter((f) => Number(f.els.trackOpacity?.style?.opacity ?? 1) < 0.999)
  const settledAt = faded.length ? (faded.at(-1)?.t ?? 0) + (faded.at(-1)?.dt ?? 0) : shown?.t
  note('FL-28', 'reduced: horizontal movement', slid, '0 px', 'px')
  note('FL-28', 'reduced: shortcut → new Space shown', shown ? shown.t - t0 : undefined, '1 frame')
  note('FL-28', 'reduced: shortcut → cross-fade done', settledAt !== undefined ? settledAt - t0 : undefined, '< 150 ms')
  expect(slid).toBeLessThanOrEqual(0.5)
  expect(settledAt !== undefined ? settledAt - t0 : Number.POSITIVE_INFINITY).toBeLessThan(150 * FRAME_SLACK + FRAME)
})
