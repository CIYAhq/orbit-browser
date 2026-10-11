/**
 * Feel of the window's own furniture (feel.md FL-15 icon buttons, FL-22 toasts, FL-25 popovers),
 * measured frame by frame with the shared sampler (frames.ts). Each test logs its numbers (`[feel]`
 * lines): docs/FEEL.md has them against their targets.
 */
import { expect, test } from '@playwright/test'
import { motionOf, note, type Recording, record, responseTo, series } from './frames'
import { FRAME_SLACK, launchOrbit, type Orbit, run, state } from './helpers'
import { settled } from './tabs-support'

let orbit: Orbit

test.beforeEach(async () => {
  orbit = await launchOrbit()
})
test.afterEach(async () => {
  await orbit.app.close()
})

/** One refresh interval at 60 Hz. */
const FRAME = 1000 / 60

/** Shows a toast in the shell the way main does (`windows.sendToWindow(…, 'toast', …)`). */
async function toast(message: string): Promise<void> {
  await orbit.app.evaluate(({ webContents }, text) => {
    const shell = webContents.getAllWebContents().find((w) => w.getURL().includes('view=shell'))
    if (!shell) throw new Error('no shell')
    shell.send('orbit:toast', { message: text })
  }, message)
}

/** The toasts' keys in the order they first showed. */
function arrivals(r: Recording): string[] {
  const seen: string[] = []
  for (const f of r.frames) for (const key of Object.keys(f.lists.toasts ?? {})) if (!seen.includes(key)) seen.push(key)
  return seen
}

test('[FL-22] three toasts stack 8 px apart, each rising in with the pop spring and pushing the older ones up; each leaves 3–4 s after it came, fading and dropping', async () => {
  const { shell } = orbit
  const rec = await record(
    shell,
    { toasts: { selector: '[data-testid="toast"]', key: 'data-toast-id' } },
    { maxMs: 6000 },
  )
  for (const text of ['First toast', 'Second toast', 'Third toast']) {
    await toast(text)
    await shell.waitForTimeout(400)
  }
  await expect(shell.getByTestId('toast')).toHaveCount(0, { timeout: 8000 })
  const r = await rec.stop()
  const keys = arrivals(r)
  expect(keys, 'toasts seen').toHaveLength(3)
  const [one, two, three] = keys as [string, string, string]
  const at = (key: string) => r.frames.find((f) => f.lists.toasts?.[key]) as Recording['frames'][number]
  const box = (f: Recording['frames'][number] | undefined, key: string) => f?.lists.toasts?.[key]

  // In: the first toast alone, before the second comes.
  const firstIn = at(one)
  const beforeTwo = r.frames.filter((f) => f.t < at(two).t && f.lists.toasts?.[one])
  const rest = beforeTwo.at(-1)
  const start = box(firstIn, one)
  const end = box(rest, one)
  if (!start || !end) throw new Error('the first toast was not drawn')
  const rise = start.y - end.y
  const scale0 = start.width / end.width
  const peak = Math.max(...beforeTwo.map((f) => (box(f, one)?.width ?? 0) / end.width))
  // In place: from this frame on it stays within 0.5 px of where it rests (past the spring's overshoot).
  const off = (f: Recording['frames'][number]) =>
    Math.abs((box(f, one)?.y ?? 0) - end.y) > 0.5 || Math.abs((box(f, one)?.width ?? 0) - end.width) > 0.5
  const inPlace = beforeTwo[beforeTwo.findLastIndex(off) + 1]
  const settle = inPlace ? inPlace.t - firstIn.t : Number.POSITIVE_INFINITY

  // Stacked: all three in, settled, 8 px apart.
  const all = r.frames.filter((f) => [one, two, three].every((k) => (box(f, k)?.opacity ?? 0) > 0.99))
  const stacked = all.at(-1)
  const gaps = [
    (box(stacked, two)?.y ?? 0) - ((box(stacked, one)?.y ?? 0) + (box(stacked, one)?.height ?? 0)),
    (box(stacked, three)?.y ?? 0) - ((box(stacked, two)?.y ?? 0) + (box(stacked, two)?.height ?? 0)),
  ]

  // Pushed up: the first toast while the second comes in.
  const pushed = motionOf(
    series(r, 'toasts', (b) => b.y, one).filter((p) => p.t >= at(two).t - FRAME && p.t < at(three).t),
  )

  // Out: how long each stays, and how it leaves.
  const stays = keys.map((key) => {
    const shown = r.frames.find((f) => (box(f, key)?.opacity ?? 0) > 0.99)
    const fading = r.frames.find((f) => shown && f.i > shown.i && (box(f, key)?.opacity ?? 1) < 0.98)
    const gone = r.frames.find((f) => fading && f.i > fading.i && !box(f, key))
    const ys = r.frames.filter((f) => fading && f.i >= fading.i - 1 && box(f, key)).map((f) => box(f, key)?.y ?? 0)
    return {
      stay: fading ? fading.t - at(key).t : Number.POSITIVE_INFINITY,
      out: fading && gone ? gone.t - fading.t : Number.POSITIVE_INFINITY,
      drop: ys.length > 1 ? Math.max(...ys) - (ys[0] as number) : 0,
    }
  })
  note('FL-22', 'in: first frame below its place', rise, '≈ 12 px (rises in)', 'px')
  note('FL-22', 'in: first frame scale', scale0, '≈ 0.96', '×')
  note('FL-22', 'in: largest scale', peak, '≤ 1.03 (pop spring)', '×')
  note('FL-22', 'in: first frame → in place', settle, '200–250 ms')
  note(
    'FL-22',
    'gaps between stacked toasts',
    Math.max(...gaps.map((g) => Math.abs(g - 8))),
    '8 px apart (off by)',
    'px',
  )
  note('FL-22', 'older toast pushed up: largest step share', pushed.biggestStep * 100, '< 60 % (snappy spring)', '%')
  note('FL-22', 'shown → starts leaving, shortest', Math.min(...stays.map((s) => s.stay)), '3–4 s')
  note('FL-22', 'leaving: fade', Math.max(...stays.map((s) => s.out)), '150–180 ms')
  note('FL-22', 'leaving: drop', Math.min(...stays.map((s) => s.drop)), '≈ 8 px', 'px')
  expect(rise, 'the toast rises in').toBeGreaterThanOrEqual(8)
  expect(scale0, 'the toast grows in from about 0.96').toBeLessThanOrEqual(0.985)
  expect(peak, 'overshoot').toBeLessThanOrEqual(1.03)
  expect(settle).toBeLessThanOrEqual(400 * FRAME_SLACK)
  expect(gaps.map((g) => Math.round(g))).toEqual([8, 8])
  expect(pushed.travel, 'the older toast moves up').toBeGreaterThan(20)
  if (FRAME_SLACK === 1) expect(pushed.biggestStep, 'the older toast glides up').toBeLessThan(0.6)
  for (const s of stays) {
    expect(s.stay).toBeGreaterThanOrEqual(2900)
    expect(s.stay).toBeLessThanOrEqual(4000 * FRAME_SLACK + 300)
    expect(s.out).toBeLessThanOrEqual(250 * FRAME_SLACK)
    expect(s.drop, 'a leaving toast drops').toBeGreaterThanOrEqual(4)
  }
})

test('[FL-25] a folder’s search popover opens from 0.97 with the snappy timing and closes with the quick one', async () => {
  const { app, shell } = orbit
  const tabs: string[] = []
  for (let k = 0; k < 3; k++)
    tabs.push((await run(app, 'tabs.create', { url: `about:blank#p${k}`, activate: false })) as string)
  const space = Object.values((await state(app)).windows)[0]?.spaceId as string
  await run(app, 'folders.create', { container: { kind: 'pinned', spaceId: space }, name: 'Box', items: tabs })
  const folderRow = shell.getByTestId('folder-row')
  await folderRow.hover()
  await settled(shell)
  const button = shell.getByTestId('folder-search-button')
  await expect(button).toHaveCSS('opacity', '1')
  const rec = await record(shell, { pop: '[data-testid="folder-search"]' })
  await button.click()
  await expect(shell.getByTestId('folder-search-input')).toBeFocused()
  await shell.waitForTimeout(400)
  await shell.keyboard.press('Escape')
  await expect(shell.getByTestId('folder-search')).toHaveCount(0)
  const r = await rec.until(1000)
  const click = r.inputs.find((i) => i.type === 'pointerup')
  const esc = r.inputs.find((i) => i.type === 'keydown' && i.key === 'Escape')
  if (!click || !esc) throw new Error('the click or Escape never reached the shell')
  const open = r.frames.filter((f) => f.i < esc.frame && f.els.pop)
  const full = open.at(-1)?.els.pop
  if (!full) throw new Error('the popover never showed')
  const shown = responseTo(r, click, (f) => (f.els.pop?.opacity ?? 0) > 0)
  const first = shown?.frame.els.pop
  const opened = responseTo(
    r,
    click,
    (f) => (f.els.pop?.opacity ?? 0) >= 0.99 && (f.els.pop?.width ?? 0) >= full.width - 0.5,
  )
  const closing = r.frames.filter((f) => f.i >= esc.frame && f.els.pop && (f.els.pop.opacity ?? 0) > 0.01)
  const gone = responseTo(r, esc, (f) => !f.els.pop || f.els.pop.opacity <= 0.01)
  note('FL-25', 'popover: click → first drawn', shown?.frames, '1', 'frames')
  note('FL-25', 'popover: first frame scale', first ? first.width / full.width : undefined, '≈ 0.97', '×')
  note('FL-25', 'popover: click → fully open', opened?.ms, '≈ 150 ms (snappy)')
  note('FL-25', 'popover: Escape → gone', gone?.ms, '≈ 90–130 ms (quick)')
  note('FL-25', 'popover: frames closing', closing.length, '≥ 2 (a fade, not a cut)', 'frames')
  expect(shown?.frames ?? Number.POSITIVE_INFINITY, 'frames from the click to the popover').toBeLessThanOrEqual(2)
  expect(first ? first.width / full.width : 1, 'it grows in from about 0.97').toBeLessThanOrEqual(0.99)
  expect(opened?.ms ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual((150 + 3 * FRAME) * FRAME_SLACK)
  expect(closing.length, 'the popover fades out').toBeGreaterThanOrEqual(2)
  expect(gone?.ms ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual((130 + 3 * FRAME) * FRAME_SLACK)
})

test('[FL-15] an icon button presses to 0.94 at once and springs back on release; a disabled one stays still', async () => {
  const { shell } = orbit
  const button = shell.getByTestId('library-button')
  const back = shell.getByTestId('nav-back')
  await expect(back).toBeDisabled()
  const box = await button.boundingBox()
  const backBox = await back.boundingBox()
  if (!box || !backBox) throw new Error('no buttons')
  await shell.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await shell.waitForTimeout(200)
  const rec = await record(shell, { button: '[data-testid="library-button"]', back: '[data-testid="nav-back"]' })
  // Pressed, then released away from it: the press and the release, without opening the Library.
  await shell.mouse.down()
  await shell.waitForTimeout(200)
  await shell.mouse.move(box.x + box.width / 2, box.y - 120, { steps: 2 })
  await shell.mouse.up()
  await shell.waitForTimeout(400)
  await shell.mouse.move(backBox.x + backBox.width / 2, backBox.y + backBox.height / 2)
  await shell.mouse.down()
  await shell.waitForTimeout(150)
  await shell.mouse.up()
  const r = await rec.until(1600)
  const [down, downBack] = r.inputs.filter((i) => i.type === 'pointerdown')
  const up = r.inputs.find((i) => i.type === 'pointerup')
  if (!down || !downBack || !up) throw new Error('the presses never reached the shell')
  const scale = (f: Recording['frames'][number]) => (f.els.button?.width ?? box.width) / box.width
  const pressed = responseTo(r, down, (f) => scale(f) <= 0.95)
  const smallest = Math.min(...r.frames.filter((f) => f.i < up.frame).map(scale))
  // Back: from this frame on it stays at full size, past the pop curve's overshoot.
  const back1 = r.frames.find((f) => f.i >= up.frame && f.i < downBack.frame && Math.abs(scale(f) - 1) > 0.002)
    ? responseTo(r, up, (f) =>
        r.frames.filter((g) => g.i >= f.i && g.i < downBack.frame).every((g) => Math.abs(scale(g) - 1) <= 0.002),
      )
    : undefined
  const between = r.frames.filter((f) => f.i >= up.frame && back1 && f.i < back1.frame.i && scale(f) > smallest + 0.002)
  const still = Math.max(
    ...r.frames
      .filter((f) => f.i >= downBack.frame)
      .map((f) => Math.abs((f.els.back?.width ?? backBox.width) - backBox.width)),
  )
  note('FL-15', 'press → button at 0.94', pressed?.ms, 'at once (a 60 ms press)')
  note('FL-15', 'smallest scale while pressed', smallest, '≈ 0.94', '×')
  note('FL-15', 'release → settled at full size', back1?.ms, '≈ 240 ms (pop)')
  note('FL-15', 'disabled button: size change on a press', still, '0', 'px')
  expect(pressed?.ms ?? Number.POSITIVE_INFINITY, 'press → 0.94').toBeLessThanOrEqual((60 + 2 * FRAME) * FRAME_SLACK)
  expect(smallest).toBeCloseTo(0.94, 2)
  expect(between.length, 'the release springs back over frames, not at once').toBeGreaterThanOrEqual(2)
  expect(back1?.ms ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual((240 + 3 * FRAME) * FRAME_SLACK)
  expect(still, 'a disabled button does not move').toBeLessThanOrEqual(0.01)
})
