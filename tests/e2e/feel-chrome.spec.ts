/**
 * Feel of the window's own furniture (feel.md FL-22 toasts), measured frame by frame
 * with the shared sampler (frames.ts). Each test logs its numbers (`[feel]` lines): docs/FEEL.md has them
 * against their targets.
 */
import { expect, test } from '@playwright/test'
import { motionOf, note, type Recording, record, series } from './frames'
import { FRAME_SLACK, launchOrbit, type Orbit } from './helpers'
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
