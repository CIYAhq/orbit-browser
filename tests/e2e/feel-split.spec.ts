/**
 * Feel of split view (feel.md FL-18: the drop zone, a pane growing in, the divider, a flip and a
 * close), measured frame by frame with the shared sampler (frames.ts). Each test logs its numbers
 * (`[feel]` lines): docs/FEEL.md has them against their targets.
 */
import { expect, type Page, test } from '@playwright/test'
import { type Box, motionOf, note, type Recording, record, responseTo, series, settledFrom } from './frames'
import { action, type Fixtures, FRAME_SLACK, launchOrbit, type Orbit, run, startFixtures, tabView } from './helpers'
import { settled } from './tabs-support'

let fx: Fixtures
let orbit: Orbit

test.beforeAll(async () => {
  fx = await startFixtures()
})
test.afterAll(async () => {
  await fx.close()
})
test.beforeEach(async () => {
  orbit = await launchOrbit()
})
test.afterEach(async () => {
  await orbit.app.close()
})

/** One refresh interval at 60 Hz. */
const FRAME = 1000 / 60
/** Every pane card, by tab. */
const PANES = { selector: '[data-testid="split-pane"]', key: 'data-tab-id' }
const ZONE = '[data-testid="split-drop-indicator"]'

async function openTab(name: string, activate = true): Promise<string> {
  return (await run(orbit.app, 'tabs.create', { url: fx.url(`/page/${name}`), activate })) as string
}

/** Waits until the boxes of everything `selector` matches stay the same over two frames. */
async function still(page: Page, selector: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(async (sel) => {
        const boxes = () =>
          [...document.querySelectorAll(sel)]
            .map((el) => {
              const b = el.getBoundingClientRect()
              return `${b.x},${b.y},${b.width},${b.height},${getComputedStyle(el).opacity}`
            })
            .join(';')
        const before = boxes()
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        return before === boxes()
      }, selector),
    )
    .toBe(true)
}

const near = (a: Box | undefined, b: Box | undefined, tol = 0.5) =>
  !!a &&
  !!b &&
  Math.abs(a.x - b.x) <= tol &&
  Math.abs(a.y - b.y) <= tol &&
  Math.abs(a.width - b.width) <= tol &&
  Math.abs(a.height - b.height) <= tol

/**
 * How the panes moved in a recording: the first frame any pane differs from where it started (or a
 * new pane shows), the frame from which every pane stays within 0.5 px of its final place, and the
 * largest one-frame step of any pane edge as a share of that edge's travel (1 = a jump). `seen` is
 * the same within 2 px: FL-01's standard spring (0.32 s / 0.88) overshoots by 0.3 % of the travel,
 * which over half a page card is about 2 px, so it comes within 0.5 px only after that overshoot.
 */
function panesMotion(r: Recording) {
  const first = r.frames[0]?.lists.panes ?? {}
  const end = r.frames.at(-1)?.lists.panes ?? {}
  const ids = Object.keys(end)
  const moved = r.frames.find((f) =>
    ids.some((id) => {
      const now = f.lists.panes?.[id]
      return !!now && (!first[id] || !near(now, first[id]))
    }),
  )
  const placed = settledFrom(r, (f) => ids.every((id) => near(f.lists.panes?.[id], end[id])))
  const seen = settledFrom(r, (f) => ids.every((id) => near(f.lists.panes?.[id], end[id], 2)))
  const edges = ids.flatMap((id) =>
    (['x', 'y', 'width', 'height'] as const).map((k) => motionOf(series(r, 'panes', (b) => b[k], id))),
  )
  const moving = edges.filter((m) => m.travel > 2)
  return {
    moved,
    placed,
    seen,
    ms: moved && placed ? placed.t - moved.t : Number.POSITIVE_INFINITY,
    seenMs: moved && seen ? seen.t - moved.t : Number.POSITIVE_INFINITY,
    step: Math.max(0, ...moving.map((m) => m.biggestStep)),
    end,
  }
}

/**
 * Moves the window so that the X server's own pointer (the test's pointer is Playwright's) sits over
 * the sidebar. That pointer gets a move with no button down whenever the view under it changes (a
 * page shrinking to make room for a pane), and a move with no button down ends a tab drag.
 */
async function pointerOverSidebar(o: Orbit): Promise<void> {
  const width = await o.app.evaluate(({ screen }) => {
    const { windows } = (
      globalThis as unknown as {
        __orbit: {
          ctx: { windows: { ids: () => string[]; get: (id: string) => Electron.BrowserWindow | undefined } }
        }
      }
    ).__orbit.ctx
    const win = windows.get(windows.ids()[0] as string)
    if (!win) throw new Error('no window')
    const p = screen.getCursorScreenPoint()
    const area = screen.getDisplayNearestPoint(p).bounds
    const b = win.getContentBounds()
    const x = Math.max(area.x, p.x - 120)
    const y = Math.max(area.y, p.y - 300)
    const next = {
      x,
      y,
      width: Math.min(b.width, area.x + area.width - x),
      height: Math.min(b.height, area.y + area.height - y),
    }
    win.setContentBounds(next)
    return next.width
  })
  await expect.poll(() => o.shell.evaluate(() => window.innerWidth)).toBe(width)
  await settled(o.shell)
}

test('[FL-18] a tab dragged over the page: the drop zone fades in within about 100 ms and shows the half; on release both panes are in place within 350 ms', async () => {
  const { app, shell } = orbit
  await pointerOverSidebar(orbit)
  const b = await openTab('Dragged')
  const a = await openTab('Shown')
  await expect.poll(async () => (await tabView(app, a))?.visible).toBe(true)
  await settled(shell)
  const row = shell.locator(`[data-testid="tab-row"][data-tab-id="${b}"]`)
  const from = await row.boundingBox()
  const frame = await shell.getByTestId('content-frame').boundingBox()
  if (!from || !frame) throw new Error('missing boxes')
  // Lift the row and hold it over the sidebar, short of the page.
  await shell.mouse.move(from.x + 40, from.y + from.height / 2)
  await shell.mouse.down()
  await shell.mouse.move(from.x + 60, from.y + from.height / 2, { steps: 3 })
  await shell.mouse.move(from.x + 90, from.y + from.height / 2 + 40, { steps: 3 })
  const zone = { selector: ZONE, attrs: ['data-side'] }

  // Into the page's right half, in moves as a hand makes them. The press selected the dragged tab
  // (FL-05): the first move over the page shows the page the drag began on again, and a move after
  // that finds the zone, which fades in where the new pane will go.
  const enter = await record(shell, { zone, panes: PANES })
  await shell.mouse.move(frame.x + frame.width * 0.85, frame.y + frame.height / 2, { steps: 8 })
  await shell.mouse.move(frame.x + frame.width * 0.85 + 10, frame.y + frame.height / 2, { steps: 2 })
  await expect(shell.locator(ZONE)).toHaveAttribute('data-side', 'right')
  await still(shell, `${ZONE}, [data-testid="split-pane"]`)
  const e = await enter.stop()
  const onPage = e.inputs.find((i) => i.type === 'pointermove' && (i.x ?? 0) >= frame.x)
  if (!onPage) throw new Error('the moves never reached the page')
  const shown = responseTo(e, onPage, (f) => (f.els.zone?.opacity ?? 0) > 0.05)
  const first = e.frames.find((f) => f.els.zone)
  // The move the zone answered: the last one handled before its first frame.
  const cause = first ? e.inputs.filter((i) => i.type === 'pointermove' && i.frame <= first.i).at(-1) : undefined
  const drawn = cause ? responseTo(e, cause, (f) => (f.els.zone?.opacity ?? 0) > 0.05) : undefined
  const full = first ? e.frames.find((f) => f.i >= first.i && (f.els.zone?.opacity ?? 0) >= 0.95) : undefined
  const fadeMs = first && full ? full.t - first.t : undefined
  const fadeFrames = e.frames.filter((f) => (f.els.zone?.opacity ?? 0) > 0.05 && (f.els.zone?.opacity ?? 1) < 0.95)
  const zoneEnd = e.frames.at(-1)?.els.zone
  note('FL-18', 'pointer onto the page → zone drawn', shown?.ms, 'once the page the drag began on is back')
  note('FL-18', 'move that finds the zone → zone drawn', drawn?.frames, '≤ 2 (a fade from 0)', 'frames')
  note('FL-18', 'zone: first frame → fully in', fadeMs, '≈ 100 ms')
  note('FL-18', 'zone width, share of the page', ((zoneEnd?.width ?? 0) / frame.width) * 100, '≈ 50 % (the half)', '%')

  // To the bottom band: the zone takes the bottom half.
  const change = await record(shell, { zone, panes: PANES })
  await shell.mouse.move(frame.x + frame.width / 2, frame.y + frame.height * 0.9)
  await expect(shell.locator(ZONE)).toHaveAttribute('data-side', 'bottom')
  await still(shell, `${ZONE}, [data-testid="split-pane"]`)
  const c = await change.stop()
  const turned = c.inputs.findLast((i) => i.type === 'pointermove')
  if (!turned) throw new Error('the move never reached the shell')
  const zoneAt = c.frames.at(-1)?.els.zone ?? undefined
  const atBottom = settledFrom(c, (f) => near(f.els.zone ?? undefined, zoneAt))
  const moves = responseTo(c, turned, (f) => !near(f.els.zone ?? undefined, c.frames[0]?.els.zone ?? undefined))
  const placedIn = atBottom ? atBottom.i - turned.frame + 1 : Number.POSITIVE_INFINITY
  note('FL-18', 'pointer to another half → zone starts moving', moves?.frames, '1', 'frames')
  note('FL-18', 'pointer to another half → zone in its new place', placedIn, '1 (at once)', 'frames')
  note(
    'FL-18',
    'pointer to another half → zone in its new place (ms)',
    atBottom ? atBottom.t - turned.t : undefined,
    'at once (FL-18); a short ease of about 120 ms (SV-26)',
  )

  // Back to the right half, then release: both panes take their places.
  await shell.mouse.move(frame.x + frame.width * 0.85, frame.y + frame.height / 2, { steps: 2 })
  await expect(shell.locator(ZONE)).toHaveAttribute('data-side', 'right')
  await still(shell, `${ZONE}, [data-testid="split-pane"]`)
  const drop = await record(shell, { zone, panes: PANES })
  await shell.mouse.up()
  await expect(shell.locator(`[data-testid="split-pane"][data-tab-id="${b}"]`)).toHaveCount(1)
  await still(shell, '[data-testid="split-pane"]')
  const d = await drop.stop()
  const release = d.inputs.find((i) => i.type === 'pointerup')
  if (!release) throw new Error('the release never reached the shell')
  const m = panesMotion(d)
  const inPlace = m.placed ? m.placed.t - release.t : Number.POSITIVE_INFINITY
  const inSight = m.seen ? m.seen.t - release.t : Number.POSITIVE_INFINITY
  note('FL-18', 'release → both panes within 2 px of their place', inSight, '≤ 350 ms')
  note('FL-18', 'release → both panes in place (within 0.5 px)', inPlace, '≤ 350 ms')
  note('FL-18', 'release: largest step of a pane edge, share of its travel', m.step * 100, '< 60 % (no jump)', '%')

  // A fade from 0 shows from its second frame; one frame more under load.
  expect(drawn?.frames ?? Number.POSITIVE_INFINITY, 'the zone shows in the frames after the move').toBeLessThanOrEqual(
    3 * FRAME_SLACK,
  )
  expect(shown?.ms ?? Number.POSITIVE_INFINITY, 'the zone shows while the tab is over the page').toBeLessThanOrEqual(
    300 * FRAME_SLACK,
  )
  expect(fadeFrames.length, 'the zone fades in').toBeGreaterThanOrEqual(1)
  expect(fadeMs ?? Number.POSITIVE_INFINITY, 'the zone is fully in').toBeLessThanOrEqual(
    (100 + 2 * FRAME) * FRAME_SLACK,
  )
  expect((zoneEnd?.width ?? 0) / frame.width, 'the zone shows the half the new pane takes').toBeGreaterThan(0.4)
  expect((zoneAt?.y ?? 0) - frame.y, 'the zone moved to the bottom half').toBeGreaterThan(frame.height * 0.4)
  expect(placedIn, 'the zone is in its new half in the frame after the move').toBeLessThanOrEqual(2 * FRAME_SLACK)
  expect(inSight, 'both panes are in place').toBeLessThanOrEqual(350 * FRAME_SLACK)
  expect(inPlace, 'and settle the last 2 px').toBeLessThanOrEqual(600 * FRAME_SLACK)
  expect(Object.keys(m.end).sort()).toEqual([a, b].sort())
})

test('[FL-18] a pane added beside the page grows in with the standard spring; the divider follows the pointer; a flip moves the panes; closing one lets the other fill', async () => {
  const { app, shell } = orbit
  const a = await openTab('Left')
  await expect.poll(async () => (await tabView(app, a))?.visible).toBe(true)
  const b = await openTab('Right', false)
  await settled(shell)
  const frame = await shell.getByTestId('content-frame').boundingBox()
  if (!frame) throw new Error('no page card')

  // Create: the page shrinks to its half while the new pane grows in from the right.
  const grow = await record(shell, { panes: PANES })
  expect(await run(app, 'split.addTab', { tabId: b, target: a, side: 'right' })).toBeTruthy()
  await expect(shell.locator('[data-testid="split-pane"]')).toHaveCount(2)
  await still(shell, '[data-testid="split-pane"]')
  const g = await grow.stop()
  const made = panesMotion(g)
  const newEnd = made.end[b]
  const born = g.frames.find((f) => f.lists.panes?.[b])
  const widest = Math.max(...g.frames.map((f) => f.lists.panes?.[b]?.width ?? 0))
  note('FL-18', 'create: first frame → both panes within 2 px', made.seenMs, '260–300 ms (standard spring), ≤ 350 ms')
  note('FL-18', 'create: first frame → both panes in place', made.ms, '260–300 ms (standard spring), ≤ 350 ms')
  note(
    'FL-18',
    'create: new pane, first frame width, share of its own',
    ((born?.lists.panes?.[b]?.width ?? 0) / (newEnd?.width ?? 1)) * 100,
    'small (grows in)',
    '%',
  )
  note('FL-18', 'create: new pane overshoot', widest - (newEnd?.width ?? 0), 'none visible', 'px')
  note('FL-18', 'create: largest step of a pane edge, share of its travel', made.step * 100, '< 60 % (no jump)', '%')

  // Resize: the divider follows the pointer in every frame.
  const divider = shell.getByTestId('split-divider')
  const handle = await divider.boundingBox()
  if (!handle) throw new Error('no divider')
  const startX = handle.x + handle.width / 2
  const y = handle.y + handle.height / 2
  await shell.mouse.move(startX, y)
  await shell.mouse.down()
  const resize = await record(shell, { divider: '[data-testid="split-divider"]' })
  for (let i = 1; i <= 12; i++) await shell.mouse.move(startX - i * 10, y)
  await still(shell, '[data-testid="split-divider"]')
  const rz = await resize.stop()
  await shell.mouse.up()
  // Each frame after a move: the divider's centre against the last pointer position handled before it.
  const lagging = rz.frames.filter((f) => {
    const last = rz.inputs.filter((i) => i.type === 'pointermove' && i.frame <= f.i).at(-1)
    const box = f.els.divider
    return !!last && !!box && Math.abs(box.x + box.width / 2 - (last.x ?? 0)) > 1
  }).length
  note('FL-18', 'resize: frames with the divider off the pointer by > 1 px', lagging, '0 (1:1)', 'frames')

  // Flip: the panes travel to their new places.
  await still(shell, '[data-testid="split-pane"]')
  const flip = await record(shell, { panes: PANES })
  await action(app, 'split.flip')
  await expect
    .poll(async () => (await shell.locator(`[data-testid="split-pane"][data-tab-id="${b}"]`).boundingBox())?.y ?? 0)
    .toBeGreaterThan(frame.y + frame.height / 3)
  await still(shell, '[data-testid="split-pane"]')
  const fl = await flip.stop()
  const flipped = panesMotion(fl)
  note('FL-18', 'flip: first move → panes within 2 px', flipped.seenMs, '≈ 300 ms (FL-18); ≈ 250 ms (SV-26)')
  note('FL-18', 'flip: first move → panes in place', flipped.ms, '≈ 300 ms (FL-18); ≈ 250 ms (SV-26)')
  note(
    'FL-18',
    'flip: largest step of a pane edge, share of its travel',
    flipped.step * 100,
    '< 60 % (travel, no jump)',
    '%',
  )

  // Close: the other pane fills with the spring.
  const close = await record(shell, { panes: PANES })
  await run(app, 'split.closePane', { tabId: b })
  await expect(shell.locator(`[data-testid="split-pane"][data-tab-id="${b}"]`)).toHaveCount(0)
  await still(shell, '[data-testid="split-pane"]')
  const cl = await close.stop()
  const filled = panesMotion(cl)
  note('FL-18', 'close: first move → the other pane within 2 px', filled.seenMs, '260–300 ms (standard spring)')
  note('FL-18', 'close: first move → the other pane in place', filled.ms, '260–300 ms (standard spring)')
  note('FL-18', 'close: largest step of a pane edge, share of its travel', filled.step * 100, '< 60 % (no jump)', '%')

  // In place as the eye sees it (within 2 px) by 350 ms; the spring's last 2 px take until about 450 ms.
  expect(made.seenMs, 'the new pane is in place').toBeLessThanOrEqual(350 * FRAME_SLACK)
  expect(made.ms, 'and settles').toBeLessThanOrEqual(600 * FRAME_SLACK)
  expect(widest - (newEnd?.width ?? 0), 'no visible overshoot').toBeLessThanOrEqual(4)
  if (FRAME_SLACK === 1) {
    expect(made.step, 'the panes move with a spring').toBeLessThan(0.6)
    expect(flipped.step, 'a flip moves the panes').toBeLessThan(0.6)
    expect(filled.step, 'the other pane fills with a spring').toBeLessThan(0.6)
    expect(lagging, 'the divider stays under the pointer').toBe(0)
  }
  expect(flipped.seenMs, 'the flip is done').toBeLessThanOrEqual(350 * FRAME_SLACK)
  expect(filled.seenMs, 'the other pane has filled').toBeLessThanOrEqual(350 * FRAME_SLACK)
  expect(Math.max(flipped.ms, filled.ms), 'and they settle').toBeLessThanOrEqual(600 * FRAME_SLACK)
})
