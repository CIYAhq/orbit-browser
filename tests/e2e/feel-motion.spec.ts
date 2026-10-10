/**
 * FL-01 across surfaces, measured frame by frame with the shared sampler (frames.ts): animations
 * never jump by more than their own per-frame speed, and new input mid-way carries on from where the
 * motion was (no jump to the end state, no restart). Each test logs its numbers (`[feel]` lines):
 * docs/FEEL.md has them against their targets.
 */
import { expect, test } from '@playwright/test'
import { frameAfterWall, interruption, jumpRatio, mainInputs, note, type Recording, record, series } from './frames'
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
/** No jump: the first frames after the interruption step at most twice as far as the frames before, plus `slack`. */
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
  })
  const next = () => pressInPage(app, 'view=shell', 'Right', isMac ? ['meta', 'alt'] : ['control', 'alt'])
  await next()
  await shell.waitForTimeout(110)
  await next()
  const r = await rec.until(1200)
  const presses = (await keys()).filter((k) => k.type === 'keyDown')
  expect(presses).toHaveLength(2)
  const second = r.frames[frameAfterWall(r, presses[1]?.wall ?? 0)]?.t ?? 0
  const xb = spaceX(r, b)
  const xc = spaceX(r, c)
  const atTurn = interruption(xb, second)
  const jumpB = jumpRatio(xb)
  const jumpC = jumpRatio(xc.filter((p) => p.t >= second))
  note(
    'FL-01',
    'Space retarget: step after the second press',
    atTurn.after,
    `≤ 2 × ${atTurn.before.toFixed(1)} + 2`,
    'px',
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
    { bar: { selector: '[data-testid="command-bar"], [data-testid="command-bar-closing"]', style: ['transform'] } },
    { hidden: true },
  )
  await pressInPage(app, 'view=shell', 'T', [MOD_KEY])
  await overlay.waitForTimeout(50)
  await pressInPage(app, 'view=overlay', 'Escape')
  const r = await rec.until(700)
  const esc = (await keys()).find((k) => k.type === 'keyDown' && k.key === 'Escape')
  if (!esc) throw new Error('Escape never reached main')
  const at = r.frames[frameAfterWall(r, esc.wall)]?.t ?? 0
  const opacity = r.frames.map((f) => ({ t: f.t, v: f.els.bar ? f.els.bar.opacity : Number.NaN }))
  const scale = r.frames.map((f) => {
    const m = /matrix\(([^,]+),/.exec(f.els.bar?.style?.transform ?? '')
    return { t: f.t, v: f.els.bar ? Number(m?.[1] ?? 1) : Number.NaN }
  })
  const o = interruption(opacity, at)
  const s = interruption(scale, at)
  note('FL-01', 'bar: opacity step after Escape', o.after, `≤ 2 × ${o.before.toFixed(3)} + 0.05`, '')
  note('FL-01', 'bar: scale step after Escape', s.after, `≤ 2 × ${s.before.toFixed(4)} + 0.003`, '')
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
  await expect.poll(slideX).toBeGreaterThan(0)
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
  const xs = series(r, 'slide', (bx) => bx.x)
  const at = r.frames[frameAfterWall(r, back)]?.t ?? 0
  const turn = interruption(xs, at)
  const lowest = Math.min(...xs.filter((p) => !Number.isNaN(p.v)).map((p) => p.v))
  note('FL-01', 'hover sidebar: step after turning back', turn.after, `≤ 2 × ${turn.before.toFixed(1)} + 2`, 'px')
  note('FL-01', 'hover sidebar: furthest out before turning back', rest - lowest, '< its width (turned mid-way)', 'px')
  note('FL-01', 'hover sidebar: jump ratio', jumpRatio(xs), '≤ 6', '×')
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
  const rec = await record(shell, { kids: '.folder__children' })
  await shell.mouse.down()
  await shell.mouse.up()
  await shell.waitForTimeout(90)
  await shell.mouse.down()
  await shell.mouse.up()
  const r = await rec.until(800)
  const downs = r.inputs.filter((i) => i.type === 'pointerdown')
  expect(downs).toHaveLength(2)
  const h = childrenHeight(r)
  const at = r.frames[downs[1]?.frame ?? 0]?.t ?? 0
  const turn = interruption(h, at)
  const peak = Math.max(...h.map((p) => p.v))
  note('FL-01', 'folder: height reached before collapsing', peak, '> 0 (mid-way)', 'px')
  note('FL-01', 'folder: step after the second click', turn.after, `≤ 2 × ${turn.before.toFixed(1)} + 2`, 'px')
  note('FL-01', 'folder: jump ratio', jumpRatio(h), '≤ 6', '×')
  expect(peak).toBeGreaterThan(0)
  expect(carriesOn(turn, 2)).toBe(true)
  expect(h.at(-1)?.v ?? 0).toBe(0)
})
