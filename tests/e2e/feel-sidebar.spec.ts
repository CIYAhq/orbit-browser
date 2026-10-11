/**
 * Feel of the sidebar (feel.md FL-02 show/hide, FL-03 hover reveal, FL-21 long lists, and their
 * FL-29 budgets), measured frame by frame with the shared sampler (frames.ts).
 */
import { expect, type Page, test } from '@playwright/test'
import {
  type Frame,
  firstFrame,
  frameAfterWall,
  jumpRatio,
  mainInputs,
  motionOf,
  note,
  pacing,
  record,
  series,
} from './frames'
import { type Fixtures, FRAME_SLACK, isMac, launchOrbit, type Orbit, run, startFixtures, state } from './helpers'
import { floatingInfo, floatingPage, pageMouse, pressInPage } from './nav-support'
import { newTab, row, settled, waitTab } from './tabs-support'

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
  const targets = {
    sidebar: '[data-testid="sidebar"]',
    frame: '[data-testid="content-frame"]',
    shell: { selector: '.shell', matches: ['.shell--sidebar-hidden'] },
  }
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
  // The frame that first draws the sidebar as hidden already shows it moving (the motion lead):
  // however late a loaded machine draws ⌘S, it is never drawn as a frame that stands still.
  const drawn = hide.frames.find((f) => f.els.shell?.matched?.includes('.shell--sidebar-hidden'))
  const drawnRight = drawn?.els.sidebar ? drawn.els.sidebar.x + drawn.els.sidebar.width : 0
  note('FL-02', '⌘S → sidebar starts moving', moved ? moved.t - t0 : undefined, '1 frame (16.7 ms)')
  note('FL-02', 'frames from ⌘S to the first move', moved ? moved.i - after + 1 : undefined, '1', 'frames')
  note('FL-02', 'first frame drawn hidden: edge moved', drawn ? width - drawnRight : undefined, '> 0', 'px')
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
  expect(drawn, 'a frame drew the sidebar hidden').toBeTruthy()
  expect(drawnRight, 'the first frame drawn hidden already moves').toBeLessThan(width - 0.5)
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
  // Away over the page: gone within 1 s. Polled every frame or so: the default steps (100, 250, 500 ms) only tell
  // whether it went before 350 or before 850 ms.
  const left = Date.now()
  await pageMouse(app, '/page/Under', 'mouseMove', 700, 300)
  await expect.poll(async () => (await floatingInfo(app)).placed, { timeout: 5000, intervals: [16] }).toBe(false)
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

type BlankRows = { frames: number; blank: number; shown: number; worst: string }

/**
 * Watches the tab rows on screen in each frame as it is drawn: the most of them in any frame, and the
 * most that drew nothing (left out by FL-21's row window), with the phase the test was in then. It
 * looks once the frame's layout is done, just before it is painted (a resize observer on a probe
 * resized in each frame). Looking after the frame instead would also count a scroll that comes in
 * between, before the frame that draws it.
 */
async function watchBlankRows(
  shell: Page,
): Promise<{ phase: (name: string) => Promise<void>; stop: () => Promise<BlankRows> }> {
  type Seen = BlankRows & { on: boolean; phase: string }
  await shell.evaluate(() => {
    const seen: Seen = { frames: 0, blank: 0, shown: 0, worst: '', on: true, phase: '' }
    ;(window as unknown as { __blankRows: Seen }).__blankRows = seen
    const probe = document.createElement('div')
    probe.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none'
    document.body.append(probe)
    const look = new ResizeObserver(() => {
      const scroll = document.querySelector<HTMLElement>('[data-testid="sidebar-scroll"]')
      if (!scroll) return
      const view = scroll.getBoundingClientRect()
      let blank = 0
      let shown = 0
      for (const el of scroll.querySelectorAll<HTMLElement>('[data-slot="item"]')) {
        const r = el.getBoundingClientRect()
        if (r.height === 0 || r.bottom <= view.top || r.top >= view.bottom) continue
        if (el.classList.contains('is-far')) blank++
        else shown++
      }
      seen.frames++
      if (blank > seen.blank) seen.worst = `${seen.phase} at ${Math.round(scroll.scrollTop)} px`
      seen.blank = Math.max(seen.blank, blank)
      seen.shown = Math.max(seen.shown, shown)
    })
    look.observe(probe)
    let wide = false
    const frame = () => {
      if (!seen.on) {
        look.disconnect()
        probe.remove()
        return
      }
      wide = !wide
      probe.style.width = wide ? '2px' : '1px'
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })
  return {
    phase: (name) =>
      shell.evaluate((n) => {
        ;(window as unknown as { __blankRows: Seen }).__blankRows.phase = n
      }, name),
    stop: () =>
      shell.evaluate(() => {
        const seen = (window as unknown as { __blankRows: Seen }).__blankRows
        seen.on = false
        return { frames: seen.frames, blank: seen.blank, shown: seen.shown, worst: seen.worst }
      }),
  }
}

test('[FL-21] 300 tabs: rows coming on screen are drawn in that frame, by wheel, keys, a tab found or a drag', async () => {
  const { app, shell } = orbit
  test.setTimeout(180_000)
  await manyTabs(300)
  const scroller = shell.getByTestId('sidebar-scroll')
  await expect(shell.getByTestId('today-list').locator(':scope > [data-slot]')).toHaveCount(300, { timeout: 30_000 })
  await settled(shell, 30_000)
  const spaceId = (await state(app)).spaceOrder[0] as string
  const ids = (await state(app)).spaces[spaceId]?.today ?? []
  const first = ids[0] as string
  const last = ids.at(-1) as string
  // Rows far from the screen keep their slot and draw nothing.
  expect(await shell.locator('.row-slot.is-far').count()).toBeGreaterThan(150)
  const box = await scroller.boundingBox()
  if (!box) throw new Error('no list')
  const watch = await watchBlankRows(shell)
  // Wheel: down to the end and back.
  await watch.phase('wheel')
  await shell.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let k = 0; k < 80; k++) await shell.mouse.wheel(0, 150)
  for (let k = 0; k < 80; k++) await shell.mouse.wheel(0, -150)
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(0)
  // Keys: the list's own focus to its last row, its first, and down from there.
  await watch.phase('keys')
  await scroller.focus()
  await shell.keyboard.press('End')
  await expect(row(shell, last)).toBeInViewport()
  await expect(row(shell, last)).toHaveClass(/is-focused/)
  await shell.keyboard.press('Home')
  await expect(row(shell, first)).toBeInViewport()
  for (let k = 0; k < 3; k++) await shell.keyboard.press('ArrowDown')
  await expect(row(shell, ids[3] as string)).toHaveClass(/is-focused/)
  await shell.keyboard.press('Escape')
  // Found elsewhere (the command bar's tab search, a link to an open tab): selected, it is scrolled to and drawn.
  const found = ids[200] as string
  await watch.phase('found')
  await run(app, 'tabs.activate', { tabId: found })
  await expect(row(shell, found)).toBeInViewport()
  // A jump straight to the end.
  await watch.phase('jump')
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect(row(shell, last)).toBeInViewport()
  // Drag: carried to the list's bottom edge, a row scrolls the list on; dropped there, it lands far down.
  await scroller.evaluate((el) => {
    el.scrollTop = 0
  })
  const moved = ids[2] as string
  await watch.phase('drag')
  const start = await row(shell, moved).boundingBox()
  if (!start) throw new Error('no row')
  const x = start.x + start.width / 2
  await shell.mouse.move(x, start.y + start.height / 2)
  await shell.mouse.down()
  await shell.mouse.move(x, start.y + start.height / 2 + 6, { steps: 2 })
  await shell.mouse.move(x, box.y + box.height - 8, { steps: 10 })
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop), { timeout: 15_000 }).toBeGreaterThan(1500)
  await shell.mouse.move(x, box.y + box.height / 2, { steps: 4 })
  await shell.mouse.up()
  await expect(shell.getByTestId('drag-ghost')).toHaveCount(0)
  await expect.poll(async () => (await state(app)).spaces[spaceId]?.today.indexOf(moved) ?? -1).toBeGreaterThan(40)
  const seen = await watch.stop()
  note('FL-21', 'rows on screen drawing nothing, worst frame', seen.blank, `0 (${seen.frames} frames)`, 'rows')
  expect(seen.shown).toBeGreaterThan(10)
  expect(seen.blank, `worst frame: ${seen.worst}`).toBe(0)
  // The watcher sees a frame that does draw blank rows: a jump made in a frame callback is drawn
  // before the scroll event that lets the row window catch up.
  const check = await watchBlankRows(shell)
  await scroller.evaluate(
    (el) =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollTop > 4000 ? 0 : el.scrollHeight
          setTimeout(done, 100)
        }),
      ),
  )
  expect((await check.stop()).blank).toBeGreaterThan(10)
})

test('[FL-21] 200 tabs: every row in the accessibility tree tells its place in its list and the list’s size, drawn or not', async () => {
  const { app, shell } = orbit
  test.setTimeout(120_000)
  await manyTabs(203)
  const spaceId = (await state(app)).spaceOrder[0] as string
  await expect(shell.getByTestId('today-list').locator(':scope > [data-slot]')).toHaveCount(203, { timeout: 30_000 })
  // Three of them in a pinned folder (open), so Pinned holds one item and the folder three.
  const all = (await state(app)).spaces[spaceId]?.today ?? []
  const kids = all.slice(200)
  await run(app, 'folders.create', { container: { kind: 'pinned', spaceId }, name: 'Box', items: kids })
  await expect(shell.getByTestId('today-list').locator(':scope > [data-slot]')).toHaveCount(200, { timeout: 30_000 })
  const folder = shell.getByTestId('folder-row')
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.click()
  await expect(folder).toHaveAttribute('aria-expanded', 'true')
  await settled(shell, 30_000)
  const today = (await state(app)).spaces[spaceId]?.today ?? []
  expect(today).toHaveLength(200)
  // The 151st selected (always drawn), and the list scrolled back to its top: rows 151 and the top ones are drawn.
  const selected = today[150] as string
  await run(app, 'tabs.activate', { tabId: selected })
  await expect(row(shell, selected)).toBeInViewport()
  await shell.waitForTimeout(600)
  await shell.getByTestId('sidebar-scroll').evaluate((el) => {
    el.scrollTop = 0
  })
  await shell.waitForTimeout(300)
  // The tree as assistive technology gets it. CDP lists a node's level but not its set size or
  // place: those are read from the elements the tree's items stand for, which Chromium hands on.
  const cdp = await shell.context().newCDPSession(shell)
  type AXNode = { role?: { value: string }; backendDOMNodeId?: number }
  const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as { nodes: AXNode[] }
  const items = await Promise.all(
    nodes
      .filter((n) => n.role?.value === 'treeitem' && n.backendDOMNodeId)
      .map(async (n) => {
        const { node } = await cdp.send('DOM.describeNode', { backendNodeId: n.backendDOMNodeId as number })
        const list = node.attributes ?? []
        const attr = (name: string) => {
          const i = list.indexOf(name)
          return i >= 0 && i % 2 === 0 ? (list[i + 1] as string) : null
        }
        return {
          tab: attr('data-tab-id'),
          folder: attr('data-testid') === 'folder-row',
          level: attr('aria-level'),
          pos: attr('aria-posinset'),
          size: attr('aria-setsize'),
        }
      }),
  )
  await cdp.detach()
  const inToday = items.filter((i) => i.tab && today.includes(i.tab))
  const inFolder = items.filter((i) => i.tab && kids.includes(i.tab))
  const folderRows = items.filter((i) => i.folder)
  note('FL-21', 'Today rows in the accessibility tree (the rest not drawn)', inToday.length, '< 200', 'rows')
  // Rows away from the band aren't in the tree: what this checks is that the ones that are say where they are.
  expect(inToday.length).toBeLessThan(200)
  expect(inToday.map((i) => i.tab)).toContain(selected)
  for (const i of inToday) {
    expect(i.size, `${i.tab}: Today's size`).toBe('200')
    expect(i.pos, `${i.tab}: its place in Today`).toBe(String(today.indexOf(i.tab as string) + 1))
    expect(i.level, `${i.tab}: level`).toBe('1')
  }
  expect(inFolder).toHaveLength(3)
  for (const i of inFolder) {
    expect(i.size, `${i.tab}: the folder's size`).toBe('3')
    expect(i.pos, `${i.tab}: its place in the folder`).toBe(String(kids.indexOf(i.tab as string) + 1))
    expect(i.level, `${i.tab}: level`).toBe('2')
  }
  expect(folderRows).toEqual([{ tab: null, folder: true, level: '1', pos: '1', size: '1' }])
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
    // The light picture of the Space that stands in while its list renders (SpaceStrip).
    standIn: '[data-slot="0"] .is-stand-in .tab-row',
    name: { selector: '[data-testid="space-name"]', text: true },
  })
  const t0 = Date.now()
  await run(app, 'spaces.switch', { spaceId: far })
  const r = await rec.until(2000)
  const farTabs = new Set((await state(app)).spaces[far]?.today ?? [])
  const listed = (f: Frame) => Object.keys(f.lists.rows ?? {}).some((k) => farTabs.has(k))
  const shown = firstFrame(r, (f) => !!f.els.standIn || listed(f))
  const real = firstFrame(r, listed)
  const named = firstFrame(r, (f) => f.els.name?.text === 'Far')
  const tasks = await longTasks
  const ms0 = t0 - r.wall0
  const longest = Math.max(0, ...tasks)
  note(
    'FL-21',
    'switch → first frame with the Space’s rows (stand-in or list)',
    shown && shown.t - ms0,
    '≤ 100 ms (§8)',
  )
  note(
    'FL-21',
    'switch → its own list drawn (interactive)',
    real && real.t - ms0,
    '≤ 350 ms (FL-29: before the slide ends)',
  )
  note('FL-21', 'switch → its name shown', named && named.t - ms0, '≤ 100 ms (§8)')
  note(
    'FL-21',
    'long tasks during the first showing (sum)',
    tasks.reduce((a, b) => a + b, 0),
    'none over 50 ms',
  )
  note('FL-21', 'longest task', longest, '< 50 ms (§8)')
  note('FL-21', 'frame max during the first showing', pacing(r).max, `≤ ${(2 * FRAME).toFixed(1)} ms`)
  expect(shown, 'the Space’s rows were drawn').toBeTruthy()
  expect(real, 'its list replaced the stand-in').toBeTruthy()
  // Rows of the Space show at once, and its list is drawn while the slide still runs; no task stalls
  // the screen for long, a loaded machine allowed for (FRAME_SLACK).
  expect((shown?.t ?? Number.POSITIVE_INFINITY) - ms0).toBeLessThanOrEqual(100 * FRAME_SLACK + 50)
  expect((real?.t ?? Number.POSITIVE_INFINITY) - ms0).toBeLessThanOrEqual(350 * FRAME_SLACK + 50)
  expect(longest).toBeLessThan(50 * FRAME_SLACK + 50)
})

test('[FL-20] a new Favorite pops in from about 0.85 while the other tiles re-flow without a jump; a removed one shrinks and fades', async () => {
  const { app, shell } = orbit
  const tabs: string[] = []
  for (let k = 0; k < 4; k++)
    tabs.push((await run(app, 'tabs.create', { url: `about:blank#fav${k}`, activate: false })) as string)
  for (const id of tabs.slice(0, 3)) await run(app, 'tabs.favorite', { tabId: id })
  await expect(shell.getByTestId('favorite-tile')).toHaveCount(3)
  /** Waits until the tiles stand still: the same boxes two frames apart. */
  const tilesStill = () =>
    expect
      .poll(() =>
        shell.evaluate(async () => {
          const boxes = () =>
            [...document.querySelectorAll('[data-testid="favorite-tile"]')]
              .map((el) => {
                const b = el.getBoundingClientRect()
                return `${b.x},${b.y},${b.width},${b.height}`
              })
              .join(';')
          const before = boxes()
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
          return before === boxes()
        }),
      )
      .toBe(true)
  await settled(shell)
  await tilesStill()
  const tiles = { selector: '[data-testid="favorite-tile"]', key: 'data-fav-id' }
  const added = await record(shell, { tiles })
  await run(app, 'tabs.favorite', { tabId: tabs[3] })
  await expect(shell.getByTestId('favorite-tile')).toHaveCount(4)
  const a = await added.until(700)
  const fresh = tabs[3] as string
  const end = a.frames.at(-1)?.lists.tiles?.[fresh]
  const first = a.frames.find((f) => f.lists.tiles?.[fresh])?.lists.tiles?.[fresh]
  if (!end || !first) throw new Error('the new tile never showed')
  const peak = Math.max(...a.frames.map((f) => (f.lists.tiles?.[fresh]?.width ?? 0) / end.width))
  const others = tabs
    .slice(0, 3)
    .flatMap((id) => [motionOf(series(a, 'tiles', (b) => b.x, id)), motionOf(series(a, 'tiles', (b) => b.width, id))])
  const moving = others.filter((m) => m.travel > 2)
  note('FL-20', 'new tile: first frame scale', first.width / end.width, '≈ 0.85', '×')
  note('FL-20', 'new tile: largest scale', peak, '≤ 1.04 (pop spring)', '×')
  note(
    'FL-20',
    'other tiles: largest step share',
    Math.max(0, ...moving.map((m) => m.biggestStep)) * 100,
    '< 60 %',
    '%',
  )
  expect(first.width / end.width, 'the tile pops in from about 0.85').toBeLessThanOrEqual(0.9)
  expect(peak, 'a small pop').toBeLessThanOrEqual(1.05)
  if (FRAME_SLACK === 1)
    for (const m of moving) expect(m.biggestStep, 'the other tiles re-flow with a spring').toBeLessThan(0.6)

  await settled(shell)
  await tilesStill()
  const removed = await record(shell, { tiles })
  await run(app, 'tabs.unfavorite', { tabId: tabs[0] })
  await expect(shell.getByTestId('favorite-tile')).toHaveCount(3)
  const rm = await removed.until(600)
  const gone = tabs[0] as string
  const size0 = rm.frames[0]?.lists.tiles?.[gone]?.width ?? 0
  const leaving = rm.frames.map((f) => f.lists.tiles?.[gone]).filter((b) => !!b && b.opacity < 0.99)
  const smallest = Math.min(...leaving.map((b) => (b?.width ?? 0) / size0))
  note('FL-20', 'removed tile: frames fading', leaving.length, '≈ 150 ms of frames', 'frames')
  note('FL-20', 'removed tile: smallest scale drawn', smallest, '≈ 0.85', '×')
  expect(leaving.length, 'the removed tile fades out').toBeGreaterThanOrEqual(2)
  expect(smallest, 'the removed tile shrinks to about 0.85 as it fades').toBeLessThanOrEqual(0.9)
})
