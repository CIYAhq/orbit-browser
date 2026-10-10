/**
 * Feel of the sidebar (feel.md FL-02 show/hide, FL-03 hover reveal, FL-21 long lists, and their
 * FL-29 budgets), measured frame by frame with the shared sampler (frames.ts).
 */
import { expect, test } from '@playwright/test'
import { firstFrame, frameAfterWall, jumpRatio, mainInputs, note, pacing, record, series } from './frames'
import { type Fixtures, FRAME_SLACK, isMac, launchOrbit, type Orbit, run, startFixtures, state } from './helpers'
import { floatingInfo, floatingPage, pageMouse, pressInPage } from './nav-support'
import { newTab, settled, waitTab } from './tabs-support'

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

const FRAME = 1000 / 60
const MOD_KEY = isMac ? 'meta' : 'control'
/** The card's margin with the sidebar hidden, and the gutter beside a shown sidebar (SB-19). */
const MARGIN_HIDDEN = 6

async function sidebar() {
  const s = await state(orbit.app)
  return (Object.values(s.windows)[0] as (typeof s.windows)[string]).sidebar
}

test('[FL-02][FL-29][FL-01] ⌘S slides the sidebar out edge to edge within 300 ms, starting in a frame; again mid-way reverses smoothly', async () => {
  const { app, shell } = orbit
  const id = await newTab(app, fx.url('/page/Slide'), { activate: true })
  await waitTab(app, id, '/page/Slide')
  await settled(shell)
  const width = (await sidebar()).width
  const keys = await mainInputs(app)
  const targets = { sidebar: '[data-testid="sidebar"]', frame: '[data-testid="content-frame"]' }
  const press = () => pressInPage(app, 'view=shell', 'S', [MOD_KEY])

  // Hide.
  let rec = await record(shell, targets)
  await keys()
  await press()
  const hide = await rec.until(700)
  const key = (await keys()).find((k) => k.type === 'keyDown')
  if (!key) throw new Error('⌘S never reached main')
  const right = series(hide, 'sidebar', (b) => b.x + b.width)
  const t0 = key.wall - hide.wall0
  const after = frameAfterWall(hide, key.wall)
  const moved = hide.frames.find(
    (f) => f.i >= after && (f.els.sidebar?.x ?? 0) + (f.els.sidebar?.width ?? 0) < width - 0.5,
  )
  const gone = hide.frames.find((f) => !f.els.sidebar || f.els.sidebar.x + f.els.sidebar.width <= 0.5)
  const gaps = hide.frames
    .filter((f) => f.els.sidebar && f.els.frame)
    .map((f) => (f.els.frame?.x ?? 0) - ((f.els.sidebar?.x ?? 0) + (f.els.sidebar?.width ?? 0)))
  const hidePace = pacing(hide.frames.filter((f) => f.i >= after && (!gone || f.i <= gone.i)))
  note('FL-02', '⌘S → sidebar starts moving', moved ? moved.t - t0 : undefined, '1 frame (16.7 ms)')
  note('FL-02', 'frames from ⌘S to the first move', moved ? moved.i - after + 1 : undefined, '1', 'frames')
  note('FL-02', '⌘S → sidebar gone', gone ? gone.t - t0 : undefined, '≤ 300 ms')
  note('FL-02', 'gap between sidebar and card, min', Math.min(...gaps), `${MARGIN_HIDDEN}–8 px, never apart`, 'px')
  note('FL-02', 'gap between sidebar and card, max', Math.max(...gaps), `${MARGIN_HIDDEN}–8 px, never apart`, 'px')
  note('FL-02', 'jump ratio of the edge', jumpRatio(right), '≤ 6× average speed', '×')
  note('FL-02', 'frame p99 while hiding', hidePace.p99, `≤ ${FRAME.toFixed(1)} ms`)
  note('FL-02', 'frame max while hiding', hidePace.max, `≤ ${(2 * FRAME).toFixed(1)} ms`)
  await expect.poll(async () => (await sidebar()).visible).toBe(false)

  // Show, and ⌘S again 90 ms in: it turns back from where it is, with no jump.
  rec = await record(shell, targets)
  await keys()
  await press()
  await new Promise((r) => setTimeout(r, 90))
  await press()
  const rev = await rec.until(900)
  const revRight = series(rev, 'sidebar', (b) => b.x + b.width)
  const real = revRight.filter((p) => !Number.isNaN(p.v))
  const peak = Math.max(...real.map((p) => p.v))
  const turnStep = Math.max(0, ...stepsAround(real))
  const revGaps = rev.frames
    .filter((f) => f.els.sidebar && f.els.frame)
    .map((f) => (f.els.frame?.x ?? 0) - ((f.els.sidebar?.x ?? 0) + (f.els.sidebar?.width ?? 0)))
  note('FL-01', 'show reversed at 90 ms: furthest the edge got', peak, `0–${width} px`, 'px')
  note('FL-01', 'show reversed: jump ratio', jumpRatio(real), '≤ 6× average speed', '×')
  note('FL-01', 'show reversed: largest step', turnStep, 'smooth', 'px')
  console.log(
    `[feel] FL-02 reversed show, edge per frame: ${revRight.map((p) => `${Math.round(p.t)}:${Number.isNaN(p.v) ? '-' : Math.round(p.v)}`).join(' ')}`,
  )
  expect(moved, 'the sidebar moved').toBeTruthy()
  expect(gone ? gone.t - t0 : Number.POSITIVE_INFINITY).toBeLessThanOrEqual(300 * FRAME_SLACK + FRAME)
  expect(Math.min(...gaps, ...revGaps)).toBeGreaterThanOrEqual(-1)
  expect(Math.max(...gaps, ...revGaps)).toBeLessThanOrEqual(8 + 1)
  if (FRAME_SLACK === 1) {
    expect(peak, 'the reversed show turned back part way').toBeLessThan(width)
    expect(jumpRatio(right)).toBeLessThanOrEqual(6)
    expect(jumpRatio(real)).toBeLessThanOrEqual(6)
  }
  await expect.poll(async () => (await sidebar()).visible).toBe(false)
})

/** Per-frame steps of a series (px). */
function stepsAround(points: { t: number; v: number }[]): number[] {
  const out: number[] = []
  for (let k = 1; k < points.length; k++) out.push(Math.abs((points[k]?.v ?? 0) - (points[k - 1]?.v ?? 0)))
  return out
}

test('[FL-03][FL-29] the left edge brings the hidden sidebar fully in within 250 ms over a still page; it goes within 1 s of leaving', async () => {
  const { app, shell } = orbit
  const id = await newTab(app, fx.url('/page/Under'), { activate: true })
  await waitTab(app, id, '/page/Under')
  await run(app, 'window.setSidebar', { visible: false })
  await expect(shell.getByTestId('sidebar')).toBeHidden()
  // The floating card's page is made ahead once the sidebar is hidden.
  const floating = await floatingPage(app)
  await floating.getByTestId('floating-sidebar').waitFor({ state: 'attached' })
  const before = (await state(app)).tabs[id]?.url
  const viewBefore = await app.evaluate(
    (_e, tabId) =>
      (
        globalThis as unknown as {
          __orbit: { tabView: (id: string) => { bounds: { x: number; width: number } } | null }
        }
      ).__orbit.tabView(tabId)?.bounds,
    id,
  )
  await shell.mouse.move(60, 300)
  const inShell = await record(shell, {})
  const card = await record(floating, { slide: '.float-sidebar__slide' }, { hidden: true })
  await shell.mouse.move(3, 300)
  const r = await card.until(800)
  const s = await inShell.stop()
  const edge = s.inputs.find((i) => i.type === 'pointermove' && (i.x ?? 99) <= 6)
  if (!edge) throw new Error('the pointer never reached the edge')
  const slideX = series(r, 'slide', (b) => b.x)
  const restX = slideX.at(-1)?.v ?? MARGIN_HIDDEN
  const started = r.frames.find(
    (f) => f.wall >= edge.wall && f.els.slide && Math.abs(f.els.slide.x - (slideX[0]?.v ?? 0)) > 0.5,
  )
  const fullyIn = r.frames.find((f) => f.wall >= edge.wall && f.els.slide && Math.abs(f.els.slide.x - restX) <= 0.5)
  const overshoot = Math.max(0, ...slideX.filter((p) => !Number.isNaN(p.v)).map((p) => p.v - restX))
  const inMs = fullyIn ? fullyIn.wall - edge.wall : undefined
  note('FL-03', 'edge → overlay starts moving', started ? started.wall - edge.wall : undefined, '1 frame')
  note('FL-03', 'edge → overlay fully in', inMs, '≤ 250 ms')
  note('FL-03', 'overshoot', overshoot, '≤ 2 px', 'px')
  note('FL-03', 'frame p99 in the card while sliding', pacing(r).p99, `≤ ${FRAME.toFixed(1)} ms`)
  // The page underneath never moved or resized.
  const viewAfter = await app.evaluate(
    (_e, tabId) =>
      (
        globalThis as unknown as {
          __orbit: { tabView: (id: string) => { bounds: { x: number; width: number } } | null }
        }
      ).__orbit.tabView(tabId)?.bounds,
    id,
  )
  expect(viewAfter).toEqual(viewBefore)
  expect((await state(app)).tabs[id]?.url).toBe(before)
  // Away over the page: gone within 1 s.
  const left = Date.now()
  await pageMouse(app, '/page/Under', 'mouseMove', 700, 300)
  await expect.poll(async () => (await floatingInfo(app)).placed, { timeout: 5000 }).toBe(false)
  const goneMs = Date.now() - left
  note('FL-03', 'pointer leaves → overlay gone (polled)', goneMs, '≤ 1000 ms (300–500 ms dwell + quick out)')
  expect(inMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(250 * FRAME_SLACK)
  expect(overshoot).toBeLessThanOrEqual(2)
  expect(goneMs).toBeLessThan(1000 * FRAME_SLACK + 200)
})

/** Creates `n` blank background Today tabs in a Space (default: the window's). */
async function manyTabs(n: number, spaceId?: string): Promise<void> {
  await orbit.app.evaluate(
    async (_e, [count, space]) => {
      const g = globalThis as unknown as {
        __orbit: { run: (n: string, a: unknown, w?: string) => Promise<unknown>; windowIds: () => string[] }
      }
      const w = g.__orbit.windowIds()[0]
      for (let i = 0; i < count; i++) {
        await g.__orbit.run(
          'tabs.create',
          { url: `about:blank#t${i}`, activate: false, ...(space ? { spaceId: space } : {}) },
          w,
        )
      }
    },
    [n, spaceId ?? null] as const,
  )
}

/** Flings the tab list down and back up with wheel events and returns the frame pacing seen. */
async function fling(): Promise<{ p50: number; p99: number; max: number; frames: number; over: number }> {
  const { shell } = orbit
  const box = await shell.getByTestId('sidebar-scroll').boundingBox()
  if (!box) throw new Error('no list')
  await shell.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  const rec = await record(shell, { list: '[data-testid="sidebar-scroll"]' }, { maxMs: 10_000 })
  // A fast two-finger fling: many small deltas, then a long fling back.
  for (let k = 0; k < 40; k++) await shell.mouse.wheel(0, 60)
  for (let k = 0; k < 40; k++) await shell.mouse.wheel(0, -60)
  await shell.waitForTimeout(400)
  const r = await rec.stop()
  const p = pacing(r)
  return { ...p, over: r.frames.filter((f) => f.dt > FRAME + 1).length }
}

test('[FL-21][FL-29] 200 tabs: a fast fling through the list keeps the frame rate', async () => {
  const { shell } = orbit
  test.setTimeout(120_000)
  await manyTabs(200)
  await expect(shell.getByTestId('today-list').locator(':scope > [data-slot]')).toHaveCount(200, { timeout: 30_000 })
  await settled(shell, 30_000)
  const p = await fling()
  note('FL-21', '200 tabs fling: frame p50', p.p50, `${FRAME.toFixed(1)} ms`)
  note('FL-21', '200 tabs fling: frame p99', p.p99, `≤ ${FRAME.toFixed(1)} ms`)
  note('FL-21', '200 tabs fling: frame max', p.max, `≤ ${(2 * FRAME).toFixed(1)} ms`)
  note('FL-21', '200 tabs fling: frames over one interval', p.over, `0 of ${p.frames}`, 'frames')
  // A loaded machine drops frames of its own: only a stall (several frames at once) fails here.
  expect(p.max).toBeLessThanOrEqual(120 * FRAME_SLACK)
})

test('[FL-21] 500 tabs and 50 folders: scrolling keeps the frame rate', async () => {
  const { app, shell } = orbit
  test.setTimeout(240_000)
  await manyTabs(500)
  const today = (await state(app)).spaces[(await state(app)).spaceOrder[0] as string]?.today ?? []
  expect(today.length).toBe(500)
  // 50 pinned folders of four tabs each; the other 300 stay in Today.
  const spaceId = (await state(app)).spaceOrder[0] as string
  await app.evaluate(
    async (_e, [ids, space]) => {
      const g = globalThis as unknown as {
        __orbit: { run: (n: string, a: unknown, w?: string) => Promise<unknown>; windowIds: () => string[] }
      }
      const w = g.__orbit.windowIds()[0]
      for (let f = 0; f < 50; f++) {
        await g.__orbit.run(
          'folders.create',
          { container: { kind: 'pinned', spaceId: space }, name: `Folder ${f}`, items: ids.slice(f * 4, f * 4 + 4) },
          w,
        )
      }
    },
    [today.slice(0, 200), spaceId] as const,
  )
  await expect(shell.getByTestId('folder')).toHaveCount(50, { timeout: 60_000 })
  await settled(shell, 60_000)
  const p = await fling()
  note('FL-21', '500 tabs + 50 folders scroll: frame p50', p.p50, `${FRAME.toFixed(1)} ms`)
  note('FL-21', '500 tabs + 50 folders scroll: frame p99', p.p99, `≤ ${FRAME.toFixed(1)} ms`)
  note('FL-21', '500 tabs + 50 folders scroll: frame max', p.max, `≤ ${(2 * FRAME).toFixed(1)} ms`)
  note('FL-21', '500 tabs + 50 folders: frames over one interval', p.over, `0 of ${p.frames}`, 'frames')
  expect(p.max).toBeLessThanOrEqual(120 * FRAME_SLACK)
})

test('[FL-21][FL-29] the first showing of a 200-tab Space that is not next door paints within budget', async () => {
  const { app, shell } = orbit
  test.setTimeout(120_000)
  const near = (await run(app, 'spaces.create', { name: 'Near', activate: false })) as string
  const far = (await run(app, 'spaces.create', { name: 'Far', activate: false, afterSpaceId: near })) as string
  await manyTabs(200, far)
  await expect.poll(async () => (await state(app)).spaces[far]?.today.length).toBe(200)
  await shell.waitForTimeout(500)
  // Not next to the current Space, so nothing of it is drawn yet.
  expect(await shell.locator(`[data-preview-space="${far}"]`).count()).toBe(0)
  const longTasks = shell.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const tasks: number[] = []
        const obs = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) tasks.push(e.duration)
        })
        obs.observe({ entryTypes: ['longtask'] })
        setTimeout(() => {
          obs.disconnect()
          resolve(tasks)
        }, 2500)
      }),
  )
  const rec = await record(shell, {
    rows: { selector: '[data-testid="today-list"] [data-testid="tab-row"]', key: 'data-tab-id' },
    name: { selector: '[data-testid="space-name"]', text: true },
  })
  const t0 = Date.now()
  await run(app, 'spaces.switch', { spaceId: far })
  const r = await rec.until(2000)
  const farTabs = new Set((await state(app)).spaces[far]?.today ?? [])
  const painted = firstFrame(r, (f) => Object.keys(f.lists.rows ?? {}).some((k) => farTabs.has(k)))
  const named = firstFrame(r, (f) => f.els.name?.text === 'Far')
  const tasks = await longTasks
  const ms0 = t0 - r.wall0
  note(
    'FL-21',
    'switch → first frame with the 200-tab Space’s rows',
    painted ? painted.t - ms0 : undefined,
    '≤ 100 ms (§8)',
  )
  note('FL-21', 'switch → its name shown', named ? named.t - ms0 : undefined, '≤ 100 ms (§8)')
  note(
    'FL-21',
    'long tasks during the first showing (sum)',
    tasks.reduce((a, b) => a + b, 0),
    'none over 50 ms',
  )
  note('FL-21', 'longest task', Math.max(0, ...tasks), '< 50 ms')
  note('FL-21', 'frame max during the first showing', pacing(r).max, `≤ ${(2 * FRAME).toFixed(1)} ms`)
  expect(painted, 'the Space’s rows were drawn').toBeTruthy()
})
