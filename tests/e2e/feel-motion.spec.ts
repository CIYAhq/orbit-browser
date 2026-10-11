/**
 * FL-01 across surfaces, measured frame by frame with the shared sampler (frames.ts): animations
 * never jump by more than their own per-frame speed, and new input mid-way carries on from where the
 * motion was (no jump to the end state, no restart). Each test logs its numbers (`[feel]` lines):
 * docs/FEEL.md has them against their targets.
 */
import { expect, test } from '@playwright/test'
import {
  type Frame,
  frameAfterWall,
  interruption,
  jumpRatio,
  mainInputs,
  motionOf,
  note,
  type Recording,
  record,
  series,
  settledFrom,
} from './frames'
import {
  type Fixtures,
  FRAME_SLACK,
  isMac,
  launchOrbit,
  type Orbit,
  run,
  startFixtures,
  state,
  viewPage,
} from './helpers'
import { floatingInfo, floatingPage, pageMouse, pointerAt, pressInPage } from './nav-support'
import { createSpace, settled } from './spaces-support'
import { newTab, waitTab } from './tabs-support'

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

const MOD_KEY = isMac ? 'meta' : 'control'
/** One refresh interval at 60 Hz. */
const FRAME = 1000 / 60
/**
 * No jump: the first frames after the interruption is handled move at most twice as fast as the
 * frames before, plus `slack` (speeds per 60 Hz frame, see `interruption`).
 */
const carriesOn = (s: { before: number; after: number }, slack: number) => s.after <= 2 * s.before + slack

/** A Space's page left edge in a frame: its live page, or its preview beside it. */
function spaceX(r: Recording, spaceId: string): { t: number; v: number }[] {
  return r.frames.map((f) => {
    const page = f.lists.pages?.[spaceId]
    const preview = f.lists.previews?.[spaceId]
    const b = page && page.opacity > 0 ? page : preview
    return { t: f.t, v: b ? b.x : Number.NaN }
  })
}

test('[FL-01][FL-13] a second Space shortcut mid-slide carries the strip on one Space further, with no jump', async () => {
  const { app, shell } = orbit
  await createSpace(app, { name: 'Beta', activate: false })
  await createSpace(app, { name: 'Gamma', activate: false })
  await settled(shell)
  // A new Space goes right after the current one: the next two are whatever the order says.
  const order = (await state(app)).spaceOrder
  const b = order[1] as string
  const c = order[2] as string
  const keys = await mainInputs(app)
  const rec = await record(shell, {
    pages: { selector: '[data-page-space]', key: 'data-page-space' },
    previews: { selector: '[data-preview-space]', key: 'data-preview-space' },
    // The switcher's dots follow the window's Space in the same commit that retargets the strip.
    dots: { selector: '[data-testid="space-dot"]', key: 'data-space-id', attrs: ['aria-pressed'] },
  })
  const next = () => pressInPage(app, 'view=shell', 'Right', isMac ? ['meta', 'alt'] : ['control', 'alt'])
  await next()
  await shell.waitForTimeout(110)
  await next()
  const r = await rec.until(1200)
  const presses = (await keys()).filter((k) => k.type === 'keyDown')
  expect(presses).toHaveLength(2)
  // The first frame that shows the second press handled: the strip heads for the last Space.
  const handled = r.frames.find(
    (f) => f.i >= frameAfterWall(r, presses[1]?.wall ?? 0) && f.lists.dots?.[c]?.attrs?.['aria-pressed'] === 'true',
  )
  if (!handled) throw new Error('the shell never showed the second press handled')
  const second = handled.t
  const xb = spaceX(r, b)
  const xc = spaceX(r, c)
  const atTurn = interruption(xb, second)
  const jumpB = jumpRatio(xb)
  const jumpC = jumpRatio(xc.filter((p) => p.t >= second))
  note(
    'FL-01',
    'Space retarget: speed after the second press',
    atTurn.after,
    `≤ 2 × ${atTurn.before.toFixed(1)} + 2`,
    'px/frame',
  )
  note('FL-01', 'Space retarget: jump ratio of the middle Space', jumpB, '≤ 6', '×')
  note('FL-01', 'Space retarget: jump ratio of the last Space', jumpC, '≤ 6', '×')
  expect(Object.values((await state(app)).windows)[0]?.spaceId).toBe(c)
  expect(carriesOn(atTurn, 2)).toBe(true)
  if (FRAME_SLACK === 1) expect(Math.max(jumpB, jumpC)).toBeLessThanOrEqual(6)
})

test('[FL-01][FL-16] Escape while the command bar is still appearing turns it around from where it is', async () => {
  const { app } = orbit
  const overlay = await viewPage(app, 'overlay')
  await overlay.getByTestId('overlay').waitFor({ state: 'attached' })
  const keys = await mainInputs(app)
  const rec = await record(
    overlay,
    {
      bar: { selector: '[data-testid="command-bar"], [data-testid="command-bar-closing"]', style: ['transform'] },
      closing: '[data-testid="command-bar-closing"]',
    },
    { hidden: true },
  )
  await pressInPage(app, 'view=shell', 'T', [MOD_KEY])
  await overlay.waitForTimeout(50)
  await pressInPage(app, 'view=overlay', 'Escape')
  const r = await rec.until(700)
  const esc = (await keys()).find((k) => k.type === 'keyDown' && k.key === 'Escape')
  if (!esc) throw new Error('Escape never reached main')
  // The first frame that shows Escape handled: the bar is the closing one.
  const handled = r.frames.find((f) => f.i >= frameAfterWall(r, esc.wall) && f.els.closing)
  expect(handled, 'the bar closes with an exit of its own').toBeTruthy()
  const at = handled?.t ?? Number.POSITIVE_INFINITY
  const opacity = r.frames.map((f) => ({ t: f.t, v: f.els.bar ? f.els.bar.opacity : Number.NaN }))
  const scale = r.frames.map((f) => {
    const m = /matrix\(([^,]+),/.exec(f.els.bar?.style?.transform ?? '')
    return { t: f.t, v: f.els.bar ? Number(m?.[1] ?? 1) : Number.NaN }
  })
  const o = interruption(opacity, at)
  const s = interruption(scale, at)
  note('FL-01', 'bar: opacity speed after Escape (per frame)', o.after, `≤ 2 × ${o.before.toFixed(3)} + 0.05`, '')
  note('FL-01', 'bar: scale speed after Escape (per frame)', s.after, `≤ 2 × ${s.before.toFixed(4)} + 0.003`, '')
  expect(carriesOn(o, 0.05)).toBe(true)
  expect(carriesOn(s, 0.003)).toBe(true)
})

test('[FL-01][FL-03] re-entering the edge while the hover sidebar slides out turns it back from where it is', async () => {
  const { app, shell } = orbit
  const id = await newTab(app, fx.url('/page/Under'), { activate: true })
  await waitTab(app, id, '/page/Under')
  await run(app, 'window.setSidebar', { visible: false })
  await expect(shell.getByTestId('sidebar')).toBeHidden()
  const floating = await floatingPage(app)
  await floating.getByTestId('floating-sidebar').waitFor({ state: 'attached' })
  await shell.mouse.move(60, 300)
  await shell.mouse.move(3, 300)
  await expect.poll(async () => (await floatingInfo(app)).placed).toBe(true)
  const slideX = () =>
    floating.evaluate(() => document.querySelector('.float-sidebar__slide')?.getBoundingClientRect().x ?? Number.NaN)
  // In and at rest, inset by the hidden sidebar's 6 px margin.
  await expect.poll(slideX).toBeGreaterThan(5.5)
  const rest = await slideX()
  const rec = await record(floating, { slide: '.float-sidebar__slide' }, { maxMs: 6000 })
  await pageMouse(app, '/page/Under', 'mouseMove', 700, 300)
  // Once it has started out, back to the edge.
  await expect.poll(slideX, { intervals: [5], timeout: 3000 }).toBeLessThan(rest - 4)
  const back = await floating.evaluate(() => performance.timeOrigin + performance.now())
  // Back at the edge: main reads the pointer there, and the card's view, still over the edge, hears it.
  await pointerAt(app, 3, 300)
  await pageMouse(app, 'view=sidebar', 'mouseMove', 3, 300)
  await floating.waitForTimeout(600)
  const r = await rec.stop()
  const xs = series(r, 'slide', (bx) => bx.x).filter((p) => !Number.isNaN(p.v))
  // Where it turned: the furthest out it went after the pointer came back.
  const sinceBack = xs.filter((p) => p.t >= (r.frames[frameAfterWall(r, back)]?.t ?? 0))
  const lowest = sinceBack.reduce((a, p) => (p.v < a.v ? p : a), sinceBack[0] ?? { t: 0, v: Number.NaN })
  const turn = interruption(xs, lowest.t)
  note('FL-01', 'hover sidebar: speed after the turn', turn.after, `≤ 2 × ${turn.before.toFixed(1)} + 2`, 'px/frame')
  note(
    'FL-01',
    'hover sidebar: furthest out before turning back',
    rest - lowest.v,
    '< its width (turned mid-way)',
    'px',
  )
  note('FL-01', 'hover sidebar: jump ratio', jumpRatio(xs), '≤ 6', '×')
  expect(rest - lowest.v).toBeLessThan(await floating.evaluate(() => innerWidth))
  expect(carriesOn(turn, 2)).toBe(true)
  expect(xs.at(-1)?.v ?? 0).toBeCloseTo(rest, 0)
})

/** Height of a folder's children box in each frame (0 while it is closed). */
function childrenHeight(r: Recording): { t: number; v: number }[] {
  return r.frames.map((f) => ({ t: f.t, v: f.els.kids?.height ?? 0 }))
}

test('[FL-01] collapsing a folder while it opens closes it from where it is', async () => {
  const { app, shell } = orbit
  const tabs: string[] = []
  for (let k = 0; k < 6; k++)
    tabs.push((await run(app, 'tabs.create', { url: `about:blank#f${k}`, activate: false })) as string)
  const space = Object.values((await state(app)).windows)[0]?.spaceId as string
  await run(app, 'folders.create', { container: { kind: 'pinned', spaceId: space }, name: 'Box', items: tabs })
  const folderRow = shell.getByTestId('folder-row')
  await expect(folderRow).toBeVisible()
  if ((await folderRow.getAttribute('aria-expanded')) === 'true') {
    await folderRow.click()
    await expect(folderRow).toHaveAttribute('aria-expanded', 'false')
  }
  await settled(shell)
  await shell.waitForTimeout(300)
  const box = await folderRow.boundingBox()
  if (!box) throw new Error('no folder row')
  await shell.mouse.move(box.x + 40, box.y + box.height / 2)
  const rec = await record(shell, {
    kids: '.folder__children',
    folder: { selector: '[data-testid="folder-row"]', attrs: ['aria-expanded'] },
  })
  await shell.mouse.down()
  await shell.mouse.up()
  await shell.waitForTimeout(90)
  await shell.mouse.down()
  await shell.mouse.up()
  const r = await rec.until(800)
  const downs = r.inputs.filter((i) => i.type === 'pointerdown')
  expect(downs).toHaveLength(2)
  const h = childrenHeight(r)
  // The first frame that shows the second click handled: the folder, opened by the first, closed again.
  const expanded = (f: Frame) => f.els.folder?.attrs?.['aria-expanded']
  const opened = r.frames.find((f) => expanded(f) === 'true')
  const handled = r.frames.find(
    (f) => opened && f.i > opened.i && f.i >= (downs[1]?.frame ?? 0) && expanded(f) === 'false',
  )
  if (!handled) throw new Error('the folder never closed')
  const at = handled.t
  const turn = interruption(h, at)
  const peak = Math.max(...h.map((p) => p.v))
  note('FL-01', 'folder: height reached before collapsing', peak, '> 0 (mid-way)', 'px')
  note('FL-01', 'folder: speed after the second click', turn.after, `≤ 2 × ${turn.before.toFixed(1)} + 2`, 'px/frame')
  note('FL-01', 'folder: jump ratio', jumpRatio(h), '≤ 6', '×')
  expect(peak).toBeGreaterThan(0)
  expect(carriesOn(turn, 2)).toBe(true)
  expect(h.at(-1)?.v ?? 0).toBe(0)
})

/** A transform's rotation in degrees (`none` is 0). */
function rotation(transform: string | undefined): number {
  const m = /matrix\(([^)]+)\)/.exec(transform ?? '')
  if (!m) return 0
  const [a, b] = (m[1] as string).split(',').map(Number) as [number, number]
  return (Math.atan2(b, a) * 180) / Math.PI
}

test('[FL-12] opening a folder of 6: the chevron turns in about 160 ms, the content below makes room within 250 ms as the children fade in one after another; closing is quicker', async () => {
  const { app, shell } = orbit
  const tabs: string[] = []
  for (let k = 0; k < 6; k++)
    tabs.push((await run(app, 'tabs.create', { url: `about:blank#g${k}`, activate: false })) as string)
  const space = Object.values((await state(app)).windows)[0]?.spaceId as string
  await run(app, 'folders.create', { container: { kind: 'pinned', spaceId: space }, name: 'Box', items: tabs })
  const folderRow = shell.getByTestId('folder-row')
  await expect(folderRow).toBeVisible()
  if ((await folderRow.getAttribute('aria-expanded')) === 'true') {
    await folderRow.click()
    await expect(folderRow).toHaveAttribute('aria-expanded', 'false')
  }
  await settled(shell)
  const box = await folderRow.boundingBox()
  if (!box) throw new Error('no folder row')
  await shell.mouse.move(box.x + 40, box.y + box.height / 2)
  await shell.waitForTimeout(300)
  const targets = {
    chevron: { selector: '[data-testid="folder-row"] .folder-row__chevron-wrap', style: ['transform'] },
    divider: '[data-testid="today-divider"]',
    kids: { selector: '.folder__children [data-testid="tab-row"]', key: 'data-tab-id' },
  }
  const open = await record(shell, targets)
  await shell.mouse.down()
  await shell.mouse.up()
  await expect(folderRow).toHaveAttribute('aria-expanded', 'true')
  const o = await open.until(700)
  const click = o.inputs.find((i) => i.type === 'pointerup')
  if (!click) throw new Error('the click never reached the shell')
  const turn = motionOf(o.frames.map((f) => ({ t: f.t, v: rotation(f.els.chevron?.style?.transform) })))
  const below = series(o, 'divider', (b) => b.y)
  const end = below.at(-1)?.v ?? 0
  const room = settledFrom(o, (f) => Math.abs((f.els.divider?.y ?? Number.NaN) - end) <= 0.5)
  const made = room ? room.t - click.t : Number.POSITIVE_INFINITY
  const flow = motionOf(below)
  // When each child first shows (opacity above 5 %), in list order.
  const shows = tabs.map((id) => o.frames.find((f) => (f.lists.kids?.[id]?.opacity ?? 0) > 0.05)?.t ?? Number.NaN)
  const spread = Math.max(...shows) - Math.min(...shows)
  note('FL-12', 'chevron turn, first to last moving frame', (turn.end ?? 0) - (turn.start ?? 0), '150–180 ms')
  note('FL-12', 'click → content below in place (within 0.5 px)', made, '≤ 250 ms')
  note('FL-12', 'content below: largest step share', flow.biggestStep * 100, '< 60 % (moves smoothly)', '%')
  note('FL-12', 'children: first shown → last shown', spread, '5 × 10–15 ms (a stagger)')
  expect(turn.travel, 'the chevron turns a quarter').toBeCloseTo(90, 0)
  expect(made, 'the content below makes room').toBeLessThanOrEqual(250 * FRAME_SLACK)
  if (FRAME_SLACK === 1) expect(flow.biggestStep, 'the content below moves smoothly').toBeLessThan(0.6)
  expect(spread, 'the children fade in one after another').toBeGreaterThanOrEqual(FRAME - 1)

  await settled(shell)
  await shell.waitForTimeout(200)
  const close = await record(shell, { ...targets, children: '.folder__children' })
  await shell.mouse.down()
  await shell.mouse.up()
  await expect(folderRow).toHaveAttribute('aria-expanded', 'false')
  const c = await close.until(700)
  const again = c.inputs.find((i) => i.type === 'pointerup')
  if (!again) throw new Error('the second click never reached the shell')
  const shut = c.frames.find((f) => f.i >= again.frame && (f.els.children?.height ?? 0) <= 0.5)
  const closing = motionOf(series(c, 'divider', (b) => b.y))
  note(
    'FL-12',
    'closing: the content below moves for',
    (closing.end ?? 0) - (closing.start ?? 0),
    '150–180 ms (quicker)',
  )
  note('FL-12', 'click → closed', shut ? shut.t - again.t : undefined, '≤ 250 ms')
  expect(shut ? shut.t - again.t : Number.POSITIVE_INFINITY).toBeLessThanOrEqual(250 * FRAME_SLACK)
})
