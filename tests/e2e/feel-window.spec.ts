import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { type Frame, note, pacing, type Recording, record, rgba } from './frames'
import { FRAME_SLACK, launchOrbit, type Orbit, state } from './helpers'
import { cmd, type NavFixtures, openTab, startNavFixtures, waitLoaded } from './nav-support'

/**
 * Feel of the page card and the window (feel.md FL-23 page loading indicator, FL-27 window-level
 * motion), measured frame by frame in the views that draw them, against main's own clock.
 */

const FRAME = 1000 / 60

let fx: NavFixtures
let orbit: Orbit

test.beforeAll(async () => {
  fx = await startNavFixtures()
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

interface Stamp {
  what: string
  wall: number
  width?: number
}

type Hooks = {
  __orbit: {
    ctx: {
      tabs: {
        contents: (id: string) => Electron.WebContents | undefined
        get: (id: string) => Electron.WebContentsView | undefined
      }
      windows: {
        ids: () => string[]
        get: (id: string) => Electron.BrowserWindow | undefined
        showUiView: (...args: unknown[]) => void
        hideUiView: (...args: unknown[]) => void
      }
    }
  }
  __orbitNav: { loading: () => { visible: boolean; shown: number } }
  __feelStamps?: Stamp[]
}

const loading = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as Hooks).__orbitNav.loading())

/** What main stamped since the last read (see the stamp helpers below). */
const stamps = (app: ElectronApplication) =>
  app.evaluate(() => [...((globalThis as unknown as Hooks).__feelStamps ?? [])])

/** A view's own page (`view=<name>`), once it has started. */
async function viewPageOf(app: ElectronApplication, name: string): Promise<Page> {
  let found: Page | undefined
  await expect
    .poll(() => {
      found = app.windows().find((p) => p.url().includes(`view=${name}`))
      return !!found
    })
    .toBe(true)
  return found as Page
}

/** Stamps, in main on the wall clock, a tab's load starts and stops and the loading view coming and going. */
async function stampLoads(app: ElectronApplication, tabId: string): Promise<void> {
  await app.evaluate((_e, id) => {
    const g = globalThis as unknown as Hooks
    const now = () => performance.timeOrigin + performance.now()
    const list: Stamp[] = []
    g.__feelStamps = list
    const page = g.__orbit.ctx.tabs.contents(id)
    if (!page) throw new Error('no page')
    page.prependListener('did-start-loading', () => list.push({ what: 'start', wall: now() }))
    page.prependListener('did-stop-loading', () => list.push({ what: 'stop', wall: now() }))
    const { windows } = g.__orbit.ctx
    const isLoading = (v: unknown) => !!(v as Electron.WebContentsView).webContents?.getURL().includes('view=loading')
    const show = windows.showUiView.bind(windows)
    windows.showUiView = (...args: unknown[]) => {
      const v = args[1] as Electron.WebContentsView
      if (isLoading(v) && !v.getVisible()) list.push({ what: 'shown', wall: now() })
      show(...args)
    }
    const hide = windows.hideUiView.bind(windows)
    windows.hideUiView = (...args: unknown[]) => {
      const v = args[1] as Electron.WebContentsView
      if (isLoading(v) && v.getVisible()) list.push({ what: 'hidden', wall: now() })
      hide(...args)
    }
  }, tabId)
}

const at = (list: Stamp[], what: string, from = 0) => list.find((s) => s.what === what && s.wall >= from)?.wall

test('[FL-23] a slow page shows the loading pill about 150 ms after it starts, sweeping on a steady cycle; it fills and fades out within 200 ms of the load ending', async () => {
  const { app } = orbit
  const id = await openTab(app, fx.url('/page/Start'))
  // The window's first indicator makes its view and loads its page: one slow load first, so the
  // one measured is like every later one.
  const warm = fx.url('/slow/Warm')
  await cmd(app, 'tabs.navigate', { tabId: id, url: warm })
  await expect.poll(async () => (await loading(app)).visible).toBe(true)
  fx.release('/slow/Warm')
  await waitLoaded(app, id, warm)
  await expect.poll(async () => (await loading(app)).visible).toBe(false)
  const view = await viewPageOf(app, 'loading')
  const pageBefore = await app.evaluate(
    (_e, tabId) => (globalThis as unknown as Hooks).__orbit.ctx.tabs.get(tabId)?.getBounds(),
    id,
  )
  await stampLoads(app, id)
  const rec = await record(
    view,
    {
      pill: '.loading-view__pill',
      sweep: '.loading-view__sweep',
      root: { selector: '[data-testid="loading-indicator"]', attrs: ['data-state'] },
    },
    // The view draws no frames while it is out of the window.
    { hidden: true, maxMs: 15_000 },
  )
  const slow = fx.url('/slow/Slowly')
  await cmd(app, 'tabs.navigate', { tabId: id, url: slow })
  await expect.poll(async () => (await loading(app)).visible).toBe(true)
  const pageDuring = await app.evaluate(
    (_e, tabId) => (globalThis as unknown as Hooks).__orbit.ctx.tabs.get(tabId)?.getBounds(),
    id,
  )
  // Long enough for two full turns of the sweep (the time to watch, not a check).
  await new Promise((r) => setTimeout(r, 3000))
  fx.release('/slow/Slowly')
  await waitLoaded(app, id, slow)
  await expect.poll(async () => (await loading(app)).visible).toBe(false)
  const r = await rec.stop()
  const s = await stamps(app)
  const start = at(s, 'start')
  const shown = at(s, 'shown')
  const stop = at(s, 'stop', shown ?? 0)
  const hidden = at(s, 'hidden', stop ?? 0)
  if (start === undefined || shown === undefined || stop === undefined) throw new Error(`stamps: ${JSON.stringify(s)}`)
  const loadingState = (f: Frame) => f.els.root?.attrs?.['data-state'] === 'loading'
  const opacity = (f: Frame) => f.els.pill?.opacity ?? 0
  const first = r.frames.find((f) => f.wall >= start && loadingState(f) && opacity(f) > 0.01)
  const appear = first ? first.wall - start : undefined
  note('FL-23', 'load start → pill drawn', appear, '≈ 150 ms (not before 120 ms)')
  note('FL-23', 'load start → view shown (main)', shown - start, '150 ms')
  // The sweep's place in the pill, frame by frame while the page loads: each wrap back to the left
  // starts a turn.
  const sweeping = r.frames.filter((f) => f.wall >= (first?.wall ?? shown) && f.wall < stop && loadingState(f))
  const x = sweeping.map((f) => ({ t: f.wall, v: (f.els.sweep?.x ?? 0) - (f.els.pill?.x ?? 0) }))
  const wraps = x.filter((p, k) => k > 0 && p.v < (x[k - 1]?.v ?? 0) - 10).map((p) => p.t)
  const cycles = wraps.slice(1).map((t, k) => t - (wraps[k] ?? t))
  const cycle = cycles.length ? cycles.reduce((a, b) => a + b, 0) / cycles.length : undefined
  note('FL-23', 'sweep: one turn', cycle, '1000–1400 ms')
  note(
    'FL-23',
    'sweep: first turn ends after it is drawn',
    wraps[0] !== undefined && first ? wraps[0] - first.wall : undefined,
    '1000–1400 ms',
  )
  const pace = pacing(sweeping)
  note('FL-23', 'frame p99 in the indicator while sweeping', pace.p99, `≤ ${FRAME.toFixed(1)} ms`)
  note('FL-23', 'frame max in the indicator while sweeping', pace.max, `≤ ${(2 * FRAME).toFixed(1)} ms`)
  // The load ends: the pill fills, then fades, then its view goes.
  const after = r.frames.filter((f) => f.wall >= stop)
  const faded = after.find((f) => opacity(f) <= 0.01)
  const goneAt = Math.min(faded?.wall ?? Number.POSITIVE_INFINITY, hidden ?? Number.POSITIVE_INFINITY)
  const gone = Number.isFinite(goneAt) ? goneAt - stop : undefined
  const fading = after.filter((f) => opacity(f) > 0.01 && opacity(f) < 0.99 && f.wall < goneAt).length
  const filled = Math.max(0, ...after.map((f) => (f.els.sweep?.width ?? 0) / (f.els.pill?.width || 1)))
  note('FL-23', 'load end → pill gone', gone, '≤ 200 ms')
  note('FL-23', 'load end → view taken away (main)', hidden !== undefined ? hidden - stop : undefined, '≤ 200 ms')
  note('FL-23', 'frames of the fade out', fading, '≥ 2 (a fade, not a cut)', 'frames')
  note('FL-23', 'sweep fill before the fade, share of the pill', filled * 100, '100 %', '%')
  // The pill is a view of its own over the page: the page never moves for it.
  expect(pageDuring).toEqual(pageBefore)
  expect(appear ?? 0, 'not before the page has loaded for a while').toBeGreaterThanOrEqual(120)
  expect(appear ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual((150 + 3 * FRAME) * FRAME_SLACK)
  expect(cycle ?? 0).toBeGreaterThanOrEqual(1000)
  expect(cycle ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1400)
  expect(gone ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(200 + FRAME * FRAME_SLACK)
  expect(fading).toBeGreaterThanOrEqual(2)
  expect(filled).toBeGreaterThan(0.95)
})

test('[FL-23] a page that loads within the delay never shows the indicator', async () => {
  const { app } = orbit
  const url = fx.url('/page/Cached')
  const id = await openTab(app, url)
  const before = (await loading(app)).shown
  await stampLoads(app, id)
  const loads: number[] = []
  for (let k = 0; k < 3; k++) {
    await cmd(app, 'tabs.reload', { tabId: id })
    await waitLoaded(app, id, url)
    const s = await stamps(app)
    const start = s.filter((x) => x.what === 'start').at(-1)?.wall
    const stop = s.filter((x) => x.what === 'stop').at(-1)?.wall
    if (start !== undefined && stop !== undefined) loads.push(stop - start)
  }
  const s = await stamps(app)
  const longest = Math.max(...loads)
  note('FL-23', 'reload of a cached page: start → stop, longest of 3', longest, '≈ 50 ms')
  note('FL-23', 'indicator shown for those loads', s.filter((x) => x.what === 'shown').length, '0', 'times')
  expect(loads).toHaveLength(3)
  // Only a load that really was quick says anything (a loaded machine can make a reload slow).
  if (longest < 120) {
    expect(s.filter((x) => x.what === 'shown')).toEqual([])
    expect((await loading(app)).shown).toBe(before)
  }
})

/** Tells the first window it lost (or got) the focus, as the OS does; returns main's wall clock then. */
function focusEvent(app: ElectronApplication, kind: 'blur' | 'focus'): Promise<number> {
  return app.evaluate(({ BrowserWindow }, k) => {
    const wall = performance.timeOrigin + performance.now()
    for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('view=shell')) w.emit(k)
    return wall
  }, kind)
}

test('[FL-27] an inactive window dims its sidebar over about 150 ms and brightens at once on focus', async () => {
  const { app, shell } = orbit
  await openTab(app, fx.url('/page/Dim'))
  const focused = async () => {
    const s = await state(app)
    return Object.values(s.windows)[0]?.focused
  }
  await focusEvent(app, 'focus')
  await expect.poll(focused).toBe(true)
  const top = shell.getByTestId('topbar')
  const opacity = () => top.evaluate((el) => Number(getComputedStyle(el).opacity))
  await expect.poll(opacity).toBe(1)
  const rec = await record(shell, { top: '[data-testid="topbar"]' })
  const blur = await focusEvent(app, 'blur')
  await expect.poll(opacity).toBeCloseTo(0.84, 2)
  await settledIn(shell)
  const focus = await focusEvent(app, 'focus')
  await expect.poll(opacity).toBe(1)
  await settledIn(shell)
  const r = await rec.stop()
  const op = (f: Frame) => f.els.top?.opacity ?? 1
  const dimStart = r.frames.find((f) => f.wall >= blur && op(f) < 0.995)
  const dimmed = r.frames.find((f) => f.wall >= blur && op(f) <= 0.841)
  const between = r.frames.filter((f) => f.wall >= blur && f.wall < focus && op(f) > 0.841 && op(f) < 0.995).length
  const back = r.frames.find((f) => f.wall >= focus && op(f) >= 0.999)
  const backBetween = r.frames.filter((f) => f.wall >= focus && op(f) > 0.841 && op(f) < 0.999).length
  const dim = dimStart && dimmed ? dimmed.wall - dimStart.wall : undefined
  note(
    'FL-27',
    'blur → sidebar starts dimming',
    dimStart ? dimStart.wall - blur : undefined,
    '1 frame after the window state',
  )
  note('FL-27', 'blur: dimming takes', dim, '≈ 150 ms')
  note('FL-27', 'blur: frames in between', between, '> 2 (a fade)', 'frames')
  note('FL-27', 'focus → sidebar bright again', back ? back.wall - focus : undefined, 'at once')
  note('FL-27', 'focus: frames in between', backBetween, '0 (no fade back)', 'frames')
  expect(between).toBeGreaterThan(2)
  expect(dim ?? 0).toBeGreaterThanOrEqual(100)
  expect(dim ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual((150 + 2 * FRAME) * FRAME_SLACK)
  expect(backBetween).toBe(0)
})

/** Waits until a page has drawn two frames in a row (whatever it was doing has been drawn). */
function settledIn(page: Page): Promise<void> {
  return page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
}

/** The page view's bounds as main sets them, stamped on the wall clock, for a tab. */
async function stampViewBounds(app: ElectronApplication, tabId: string): Promise<void> {
  await app.evaluate((_e, id) => {
    const g = globalThis as unknown as Hooks
    const list: Stamp[] = []
    g.__feelStamps = list
    const view = g.__orbit.ctx.tabs.get(id)
    if (!view) throw new Error('no view')
    const set = view.setBounds.bind(view)
    view.setBounds = (b: Electron.Rectangle) => {
      list.push({ what: 'view', wall: performance.timeOrigin + performance.now(), width: b.width })
      set(b)
    }
  }, tabId)
}

/** Resizes the first window by `step` px of width once a frame (from main), `n` times. */
function resizeSteps(app: ElectronApplication, step: number, n: number): Promise<void> {
  return app.evaluate(
    async (_e, [dx, count]) => {
      const g = globalThis as unknown as Hooks
      const win = g.__orbit.ctx.windows.get(g.__orbit.ctx.windows.ids()[0] as string)
      if (!win) throw new Error('no window')
      for (let k = 0; k < count; k++) {
        const b = win.getBounds()
        win.setBounds({ ...b, width: b.width + dx })
        g.__feelStamps?.push({ what: 'window', wall: performance.timeOrigin + performance.now(), width: b.width + dx })
        await new Promise((r) => setTimeout(r, 1000 / 60))
      }
    },
    [step, n] as const,
  )
}

test('[FL-27] a window resized a step every frame: the card keeps its margin in every frame, the page view follows it, and any gap shows the page’s own colour', async () => {
  const { app, shell } = orbit
  const id = await openTab(app, fx.url('/page/Dark?bg=%23203040'))
  await expect.poll(async () => (await state(app)).tabs[id]?.pageColor ?? '').not.toBe('')
  const pane = `[data-testid="split-pane"][data-tab-id="${id}"]`
  await expect(shell.locator(pane)).toHaveCSS('background-color', 'rgb(32, 48, 64)')
  await stampViewBounds(app, id)
  const rec = await record(shell, {
    shell: '[data-testid="shell"]',
    pane: { selector: pane, style: ['background-color', 'border-top-left-radius'] },
  })
  await resizeSteps(app, 12, 15)
  await resizeSteps(app, -12, 15)
  await settledIn(shell)
  await settledIn(shell)
  const r: Recording = await rec.stop()
  const s = await stamps(app)
  const frames = r.frames.filter((f) => f.els.shell && f.els.pane)
  const margin = (f: Frame) => (f.els.shell?.width ?? 0) - ((f.els.pane?.x ?? 0) + (f.els.pane?.width ?? 0))
  const rest = margin(frames[0] as Frame)
  const widths = new Set(frames.map((f) => f.els.shell?.width))
  const cardOff = frames.filter((f) => Math.abs(margin(f) - rest) > 1).length
  // The page view: how long after the card drew a width main gave the view that width.
  const views = s.filter((x) => x.what === 'view')
  const lags: number[] = []
  let changes = 0
  for (let k = 1; k < frames.length; k++) {
    const f = frames[k] as Frame
    const w = f.els.pane?.width ?? 0
    if (Math.abs(w - (frames[k - 1]?.els.pane?.width ?? 0)) < 0.5) continue
    changes++
    const set = views.find((v) => Math.abs((v.width ?? 0) - w) <= 1 && v.wall >= f.wall - FRAME)
    if (set) lags.push(set.wall - f.wall)
  }
  lags.sort((a, b) => a - b)
  const colour = rgba(frames[0]?.els.pane?.style?.['background-color'])
  const offColour = frames.filter(
    (f) => JSON.stringify(rgba(f.els.pane?.style?.['background-color'])) !== JSON.stringify(colour),
  ).length
  const radii = new Set(frames.map((f) => f.els.pane?.style?.['border-top-left-radius']))
  note('FL-27', 'resize: window widths drawn', widths.size, '–', 'widths')
  note('FL-27', 'resize: frames where the card is off its margin by > 1 px', cardOff, '0', 'frames')
  note('FL-27', 'resize: card width drawn → page view given it, median', lags[Math.floor(lags.length / 2)], '≤ 1 frame')
  note('FL-27', 'resize: card width drawn → page view given it, worst', lags.at(-1), '≤ 1 frame')
  note('FL-27', 'resize: card widths drawn that the page view never got', changes - lags.length, '0', 'widths')
  note('FL-27', 'resize: frames where the card is not the page’s colour', offColour, '0', 'frames')
  expect(widths.size, 'the window took the steps').toBeGreaterThan(10)
  expect(cardOff).toBe(0)
  expect(colour.slice(0, 3)).toEqual([32, 48, 64])
  expect(offColour).toBe(0)
  expect(radii.size).toBe(1)
  expect(Number.parseFloat([...radii][0] ?? '0')).toBeGreaterThan(0)
  expect(lags.length, 'main placed the page view for the widths drawn').toBeGreaterThan(5)
})
