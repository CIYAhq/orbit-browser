/**
 * Feel of the command bar (feel.md FL-16, FL-17 and FL-29's ⌘T / ⌘L budgets), measured frame by
 * frame in the overlay with the shared sampler (frames.ts). Keys go through the browser process, as
 * the keyboard's do, so main's shortcuts see them. Each test logs its numbers (`[feel]` lines):
 * docs/FEEL.md has them against their targets.
 */
import { createServer } from 'node:http'
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { bestOf, type Frame, mainInputs, note, type Recording, record } from './frames'
import {
  type Fixtures,
  FRAME_SLACK,
  isMac,
  launchOrbit,
  listenInRange,
  type Orbit,
  run,
  startFixtures,
  state,
  tabPage,
  viewPage,
} from './helpers'
import { viewStack } from './nav-support'

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
  await ready(orbit)
})
test.afterEach(async () => {
  await orbit.app.close()
})

/** One refresh interval at 60 Hz. */
const FRAME = 1000 / 60
/** The primary modifier as Electron's input events name it. */
const MOD_KEY = isMac ? 'meta' : 'control'
/** The live bar or one animating out (the hidden warm-up instance has neither test id). */
const ANY_BAR = '[data-testid="command-bar"], [data-testid="command-bar-closing"]'
const BAR = {
  bar: { selector: ANY_BAR, style: ['transform'] },
  input: { selector: '[data-testid="command-bar"] [data-testid="command-input"]', text: true, matches: [':focus'] },
  scrim: { selector: '.cmdbar-scrim', style: ['background-color'] },
}

/** The overlay renderer warms the bar up shortly after launch (CB-22): start once it has. */
async function ready(o: Orbit): Promise<void> {
  await (await viewPage(o.app, 'overlay')).locator('[data-testid="overlay"][data-warm="warm"]').waitFor({
    state: 'attached',
  })
}

/** Scale and vertical offset from a computed `transform` (identity for none). */
function scaleAndY(transform: string | undefined): { scale: number; y: number } {
  const m = /matrix\(([^)]+)\)/.exec(transform ?? '')
  if (!m) return { scale: 1, y: 0 }
  const v = (m[1] as string).split(',').map(Number)
  return { scale: v[0] ?? 1, y: v[5] ?? 0 }
}

/**
 * Presses `key` in the web contents whose URL contains `part`, then types `text` into the overlay
 * (where main puts focus when the bar opens) `gap` ms apart, as a keyboard does: through the browser
 * process, where main's shortcuts see the keys. With `gap` 0 the text follows the key in the same
 * task: a typist faster than any frame.
 */
async function keysThroughMain(
  app: ElectronApplication,
  part: string,
  key: string,
  mods: string[],
  text = '',
  gap = 0,
): Promise<void> {
  await app.evaluate(
    async ({ webContents }, [part, key, mods, text, gap]) => {
      const find = (p: string) => webContents.getAllWebContents().find((w) => w.getURL().includes(p))
      const page = find(part)
      if (!page) throw new Error(`no page with ${part}`)
      const modifiers = [...mods] as Electron.KeyboardInputEvent['modifiers']
      if (key) {
        page.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers })
        page.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers })
      }
      const overlay = find('view=overlay')
      if (!overlay) throw new Error('no overlay')
      for (const ch of text) {
        if (gap) await new Promise((r) => setTimeout(r, gap))
        const code = ch === ' ' ? 'Space' : ch
        overlay.sendInputEvent({ type: 'keyDown', keyCode: code })
        overlay.sendInputEvent({ type: 'char', keyCode: ch })
        overlay.sendInputEvent({ type: 'keyUp', keyCode: code })
      }
    },
    [part, key, mods, text, gap] as const,
  )
}

/** Waits until the overlay view is hidden again (its exit has played). */
async function overlayGone(app: ElectronApplication): Promise<void> {
  await expect.poll(async () => (await viewStack(app)).includes('view=overlay'), { intervals: [20] }).toBe(false)
}

/** What a recording of the bar opening shows, timed from the key main saw. */
function entrance(r: Recording, keyWall: number) {
  const present = r.frames.find((f) => f.els.bar)
  const visible = r.frames.find((f) => (f.els.bar?.opacity ?? 0) > 0.02)
  const opaque = r.frames.find((f) => (f.els.bar?.opacity ?? 0) >= 0.999)
  const shape = r.frames.filter((f) => f.els.bar).map((f) => ({ t: f.t, ...scaleAndY(f.els.bar?.style?.transform) }))
  // At rest once what is left of the motion is under half a pixel at the bar's edge.
  const half = (present?.els.bar?.width ?? 600) / 2
  const atRest = shape.find((_s, k) =>
    shape.slice(k).every((q) => Math.abs(q.scale - 1) * half < 0.5 && Math.abs(q.y) < 0.5),
  )
  const end = Math.max(opaque?.t ?? Number.NaN, atRest?.t ?? Number.NaN)
  const scrim = r.frames.map((f) =>
    f.els.scrim ? f.els.scrim.opacity * rgbaAlpha(f.els.scrim.style?.['background-color']) : 0,
  )
  return {
    present: present ? present.wall - keyWall : Number.POSITIVE_INFINITY,
    visible: visible ? visible.wall - keyWall : Number.POSITIVE_INFINITY,
    focusedAtFirst: !!visible?.els.input?.matched?.includes(':focus'),
    firstScale: shape[0]?.scale,
    firstY: shape[0]?.y,
    /** From the first frame with the bar to the frame it is opaque and at full size. */
    duration: present ? end - present.t : Number.POSITIVE_INFINITY,
    maxScale: Math.max(...shape.map((s) => s.scale)),
    maxY: Math.max(...shape.map((s) => s.y)),
    dim: Math.max(0, ...scrim),
  }
}

function rgbaAlpha(color: string | undefined): number {
  const m = /rgba?\(([^)]+)\)/.exec(color ?? '')
  const parts = (m?.[1] ?? '')
    .split(/[,\s/]+/)
    .filter(Boolean)
    .map(Number)
  return parts.length === 4 ? (parts[3] as number) : parts.length === 3 ? 1 : 0
}

/**
 * Opens the bar with `key` through main, recording the overlay; returns the entrance, and with
 * `opens` (timeOpens) the overlay's work for this open.
 */
async function openMeasured(app: ElectronApplication, overlay: Page, key: 'T' | 'L', opens?: OpenTimes) {
  const keys = await mainInputs(app)
  const rec = await record(overlay, BAR, { hidden: true, maxMs: 2000 })
  await keysThroughMain(app, 'view=shell', key, [MOD_KEY])
  const r = await rec.until(700)
  const down = (await keys()).find((k) => k.type === 'keyDown' && k.key.toLowerCase() === key.toLowerCase())
  if (!down) throw new Error('the shortcut never reached main')
  const t = opens ? await opens() : { patch: [], dom: [], resize: [] }
  const patch = t.patch.find((x) => x >= down.wall - 1) ?? Number.NaN
  const dom = t.dom.find((x) => x >= down.wall - 1) ?? Number.NaN
  return { ...entrance(r, down.wall), work: dom - patch, resized: t.resize.some((x) => x >= down.wall - 1) }
}

/** The overlay's open times (timeOpens), on the wall clock. */
type OpenTimes = () => Promise<{ patch: number[]; dom: number[]; resize: number[] }>

/**
 * Times every open in the overlay (CB-22), on the wall clock: when the update that opens the bar
 * arrives, and when the bar is in the DOM. Between the two is the overlay's own work for an open.
 * Also when the overlay was resized: an open that resizes it lays the whole overlay out again.
 */
async function timeOpens(overlay: Page): Promise<OpenTimes> {
  await overlay.evaluate(() => {
    type Patch = { path: (string | number)[] }
    const w = window as unknown as {
      __feelOpens?: { patch: number[]; dom: number[]; resize: number[] }
      orbit: { onPatches: (fn: (seq: number, patches: Patch[]) => void) => unknown }
    }
    if (w.__feelOpens) return
    const opens = { patch: [] as number[], dom: [] as number[], resize: [] as number[] }
    w.__feelOpens = opens
    const now = () => performance.timeOrigin + performance.now()
    window.addEventListener('resize', () => opens.resize.push(now()))
    w.orbit.onPatches((_seq, patches) => {
      if (patches.some((p) => p.path.includes('overlay'))) opens.patch.push(now())
    })
    let had = false
    new MutationObserver(() => {
      const has = !!document.querySelector('[data-testid="command-bar"]')
      if (has && !had) opens.dom.push(now())
      had = has
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-testid'] })
  })
  return () =>
    overlay.evaluate(
      () => (window as unknown as { __feelOpens: { patch: number[]; dom: number[]; resize: number[] } }).__feelOpens,
    )
}

async function closeBar(app: ElectronApplication): Promise<void> {
  await keysThroughMain(app, 'view=overlay', 'Escape', [])
  await expect.poll(async () => Object.values((await state(app)).windows)[0]?.overlay.kind).toBe('none')
  await overlayGone(app)
}

test('[CB-22][FL-16][FL-29] ⌘T and ⌘L: the bar shows in the first frame, focused, fading and scaling in over 120–160 ms with no overshoot; the first open after a launch does the work of later ones, with no resize', async () => {
  // Up to three rounds, each in a launch of its own.
  test.setTimeout(180_000)
  type Open = Awaited<ReturnType<typeof openMeasured>>
  const BUDGET = FRAME * FRAME_SLACK + 2
  const ENTRANCE = 160 * FRAME_SLACK + FRAME
  const shows = (e: Open) => e.visible <= BUDGET && e.focusedAtFirst
  /** A later ⌘T's entrance is judged in full: a busy frame can stretch it too. */
  const entersWell = (e: Open) => shows(e) && e.duration <= ENTRANCE
  /** One open and its close, with the overlay's work for the open. */
  const open = async (app: ElectronApplication, overlay: Page, key: 'T' | 'L', opens: OpenTimes) => {
    const e = await openMeasured(app, overlay, key, opens)
    await closeBar(app)
    return e
  }
  /**
   * One round, in a launch of its own: the first ⌘T after the launch, then later ones, then ⌘L on a
   * page. The later ones are the best of up to three in the round, as a busy frame says little.
   */
  const measure = async (round: number) => {
    const { app } = orbit
    const overlay = await viewPage(app, 'overlay')
    const opens = await timeOpens(overlay)
    const first = await open(app, overlay, 'T', opens)
    const t = await bestOf(() => open(app, overlay, 'T', opens), entersWell)
    // ⌘L on a page (CB-03 edits its address).
    const name = `Address${round}`
    const id = (await run(app, 'tabs.create', { url: fx.url(`/page/${name}`) })) as string
    await (await tabPage(app, `/page/${name}`)).waitForLoadState('load')
    await expect.poll(async () => (await state(app)).tabs[id]?.title).toBe(name)
    const l = await bestOf(() => open(app, overlay, 'L', opens), shows)
    const later = [...t.all, ...l.all].map((e) => e.work).sort((a, b) => a - b)
    return { first, t, l, later: later[later.length >> 1] ?? Number.NaN }
  }
  type Round = Awaited<ReturnType<typeof measure>>
  // CB-22: the overlay's work for the first open, which a cold renderer made two to three times
  // longer, is held to the later opens' in the same launch. (Nor may it resize the overlay: checked
  // in every open below.) Its frame is logged, not judged: it still shows in the second frame in
  // about two launches in five (13 of 31 so far), which FL-29's note counts among its misses (D90).
  const asFast = (r: Round) => r.first.work <= r.later * 1.5 + 2
  const meets = (r: Round) => r.first.focusedAtFirst && asFast(r) && entersWell(r.t.best) && shows(r.l.best)
  // A round that misses is measured again in a fresh launch, up to three rounds (D46): each round's
  // first open is then a first open after a launch, so a slow first use misses every round.
  const rounds: Round[] = []
  while (rounds.length < 3 && !rounds.some(meets)) {
    if (rounds.length > 0) {
      await orbit.app.close()
      orbit = await launchOrbit({ userData: orbit.userData })
      await ready(orbit)
    }
    const r = await measure(rounds.length + 1)
    rounds.push(r)
    const ms = (x: number) => `${x.toFixed(1)} ms`
    console.log(
      `[feel] round ${rounds.length}: first ⌘T visible ${ms(r.first.visible)}, work ${ms(r.first.work)}${r.first.resized ? ', resized the overlay' : ''}; later ⌘T visible ${r.t.all.map((e) => ms(e.visible)).join(', ')}; ⌘L visible ${r.l.all.map((e) => ms(e.visible)).join(', ')}; later opens' work (median) ${ms(r.later)}`,
    )
  }
  const best = rounds.find(meets) ?? (rounds.at(-1) as Round)
  const { first, t, l } = best
  note('FL-29', '⌘T → bar visible, first open after launch', first.visible, `1 frame (${FRAME.toFixed(1)} ms)`)
  note('CB-22', "overlay's work for the first open (update → bar in the DOM)", first.work, '≈ later opens')
  note('CB-22', "overlay's work for later opens (median)", best.later, '–')
  note('FL-29', '⌘T → first frame with the bar', t.best.present, '–')
  note('FL-29', '⌘T → bar visible (opacity > 0)', t.best.visible, `1 frame (${FRAME.toFixed(1)} ms)`)
  note('FL-29', '⌘L → bar visible (opacity > 0)', l.best.visible, `1 frame (${FRAME.toFixed(1)} ms)`)
  note('FL-16', 'entrance: first frame to opaque and full size', t.best.duration, '120–160 ms')
  note('FL-16', 'entrance: scale in the first frame', t.best.firstScale, '≈ 0.97', '')
  note('FL-16', 'entrance: drop in the first frame', t.best.firstY, '≈ −4 px', 'px')
  note('FL-16', 'entrance: largest scale (overshoot above 1)', t.best.maxScale, '≤ 1', '')
  note('FL-16', 'page dimming (scrim alpha)', t.best.dim, 'none or very slight', '')
  expect(first.focusedAtFirst && t.best.focusedAtFirst, 'the field had focus from the first visible frame').toBe(true)
  expect(first.work, "the first open's work, against 1.5 × the later opens' + 2 ms").toBeLessThanOrEqual(
    best.later * 1.5 + 2,
  )
  expect(t.best.visible).toBeLessThanOrEqual(BUDGET)
  expect(l.best.visible).toBeLessThanOrEqual(BUDGET)
  // What doesn't depend on load holds in every open of every round: the overlay has its size before
  // the bar opens (the first open laid the whole overlay out again at the window's size), and the
  // entrance's shape.
  for (const r of rounds) {
    for (const e of [r.first, ...r.t.all, ...r.l.all]) {
      expect(e.resized, 'the overlay was resized while the bar opened').toBe(false)
      expect(e.maxScale).toBeLessThanOrEqual(1.0005)
      expect(e.maxY).toBeLessThanOrEqual(0.05)
      expect(e.dim).toBeLessThanOrEqual(0.1)
    }
  }
  expect(t.best.duration).toBeLessThanOrEqual(ENTRANCE)
})

test('[CB-22] once a resize of the window ends, the hidden overlay is laid out at its new size out of sight, and ⌘T opens the bar with no resize', async () => {
  const { app } = orbit
  const overlay = await viewPage(app, 'overlay')
  // The warm-up is over: the overlay is hidden, at the window's size.
  await overlayGone(app)
  const opens = await timeOpens(overlay)
  const inner = () => overlay.evaluate(() => [window.innerWidth, window.innerHeight])
  const before = await inner()
  // The window is resized, as by dragging its corner: three steps.
  const content = await app.evaluate(async () => {
    const g = globalThis as unknown as {
      __orbit: { ctx: { windows: { get(id: string): Electron.BrowserWindow | undefined; ids(): string[] } } }
    }
    const win = g.__orbit.ctx.windows.get(g.__orbit.ctx.windows.ids()[0] as string)
    if (!win) throw new Error('no window')
    const [width = 0, height = 0] = win.getSize()
    for (const step of [1, 2, 3]) {
      win.setSize(width - 40 * step, height - 30 * step)
      await new Promise((r) => setTimeout(r, 30))
    }
    return win.getContentSize()
  })
  expect(content).not.toEqual(before)
  // Once it has ended, the overlay has been laid out at the window's new size, and hidden again.
  await expect.poll(inner).toEqual(content)
  await overlayGone(app)
  const e = await openMeasured(app, overlay, 'T', opens)
  console.info(
    `[feel] CB-22 after a resize: overlay ${before.join('×')} → ${content.join('×')}; ⌘T visible ${e.visible.toFixed(1)} ms${e.resized ? ', resized the overlay' : ''}`,
  )
  expect(e.resized, 'the overlay was resized while the bar opened').toBe(false)
})

test('[FL-16] ⌘T then "abc" at once: the field shows "abc", each key echoed in its frame', async () => {
  const { app } = orbit
  const overlay = await viewPage(app, 'overlay')
  type Round = { value: string; echo: number[] }
  const { best, all } = await bestOf<Round>(
    async () => {
      const rec = await record(overlay, BAR, { hidden: true, maxMs: 2000 })
      // The keys follow ⌘T in the same task: they reach the overlay before the bar exists.
      await keysThroughMain(app, 'view=shell', 'T', [MOD_KEY], 'abc')
      await expect(overlay.getByTestId('command-input')).toHaveValue('abc')
      const r = await rec.until(500)
      await closeBar(app)
      // Each key: the first frame the field shows it, counted from the first frame drawn after it.
      const echo = ['a', 'ab', 'abc'].map((want, k) => {
        const input = r.inputs.filter((i) => i.type === 'keydown')[k]
        const shown = r.frames.find((f) => f.els.input?.text?.startsWith(want))
        return input && shown ? shown.i - input.frame + 1 : Number.POSITIVE_INFINITY
      })
      return { value: 'abc', echo }
    },
    (r) => r.value === 'abc',
  )
  console.log(`[feel] FL-16 type-ahead rounds: ${all.map((r) => r.echo.join('/')).join(', ')}`)
  note('FL-16', 'keys typed with ⌘T kept', best.value === 'abc' ? 3 : 0, '3 of 3', 'keys')
  note(
    'FL-16',
    'first frame showing a key typed before the bar existed, frames after the key',
    Math.max(...best.echo),
    '–',
    'frames',
  )
  expect(best.value).toBe('abc')
})

/** A local OpenSearch-style suggestion endpoint that answers `delayMs` late (ports 3300–3399). */
async function suggestServer(delayMs: number) {
  const server = createServer((req, res) => {
    const q = new URL(req.url ?? '/', 'http://localhost').searchParams.get('q') ?? ''
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([q, [`${q}s online`, `${q} review`, `${q} guide`]]))
    }, delayMs)
  })
  const port = await listenInRange(server, 3330)
  return {
    template: `http://127.0.0.1:${port}/suggest?q=%s`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

/** Opens a fixture page titled `name` in a selected tab and waits for its title (background tabs sleep). */
async function openTab(app: ElectronApplication, name: string): Promise<void> {
  const id = (await run(app, 'tabs.create', { url: fx.url(`/page/${encodeURIComponent(name)}`) })) as string
  await expect.poll(async () => (await state(app)).tabs[id]?.title, { timeout: 15_000 }).toBe(name)
}

/** The highlighted row's id in a frame (null: none). */
function highlighted(f: Frame): string | null {
  const rows = f.lists.rows ?? {}
  return Object.keys(rows).find((id) => rows[id]?.attrs?.['aria-selected'] === 'true') ?? null
}

test('[FL-17][FL-29] typing 10 characters at 10 per second: each echoes in a frame, local results follow within 50 ms, late suggestions never move the highlight', async () => {
  const suggest = await suggestServer(200)
  await orbit.app.close()
  orbit = await launchOrbit({ env: { ORBIT_SUGGEST_URL: suggest.template } })
  await ready(orbit)
  const { app } = orbit
  await app.evaluate(() => {
    const ctx = (globalThis as unknown as { __orbit: { ctx: { store: { update: (fn: (d: never) => void) => void } } } })
      .__orbit.ctx
    ctx.store.update((d: { settings: { searchSuggestions: boolean } }) => {
      d.settings.searchSuggestions = true
    })
  })
  for (const name of ['Orbit notes', 'Orbit news', 'Orbital mechanics']) await openTab(app, name)
  const overlay = await viewPage(app, 'overlay')
  const query = 'orbit note'
  // One round types the whole query into a fresh bar. Its timing budgets (the worst echo, the
  // slowest local results) are judged on the best of up to three rounds (D46): one slow frame of a
  // busy machine says little about Orbit. What must hold every time is checked in every round.
  const typing = async () => {
    await keysThroughMain(app, 'view=shell', 'T', [MOD_KEY])
    await expect(overlay.getByTestId('command-input')).toBeFocused()
    const rec = await record(
      overlay,
      {
        input: { selector: '[data-testid="command-bar"] [data-testid="command-input"]', text: true },
        bar: '[data-testid="command-bar"]',
        rows: {
          selector: '[data-testid="command-bar"] [data-testid="command-result"]',
          key: 'data-id',
          attrs: ['aria-selected', 'data-kind'],
        },
        titles: {
          selector: '[data-testid="command-bar"] [data-testid="command-result-title"]',
          key: 'data-id',
          text: true,
        },
      },
      { maxMs: 4000 },
    )
    await keysThroughMain(app, 'view=overlay', '', [], query, 100)
    const r = await rec.until(1000 + 900)
    const downs = r.inputs.filter((i) => i.type === 'keydown')
    expect(downs).toHaveLength(query.length)
    const echo: number[] = []
    const results: number[] = []
    for (const [k, input] of downs.entries()) {
      const typed = query.slice(0, k + 1)
      const shown = r.frames.find((f) => f.i >= input.frame && f.els.input?.text === typed)
      echo.push(shown ? shown.i - input.frame + 1 : Number.POSITIVE_INFINITY)
      // The web-search row names what was typed (trimmed): the local results for this keystroke are
      // in. A trailing space names the same search, so that keystroke has nothing new to show.
      if (k > 0 && typed.trim() === query.slice(0, k).trim()) continue
      const listed = r.frames.find(
        (f) =>
          f.i >= input.frame &&
          Object.entries(f.lists.titles ?? {}).some(
            ([id, b]) => b.text?.trim() === typed.trim() && f.lists.rows?.[id]?.attrs?.['data-kind'] === 'search',
          ),
      )
      results.push(listed ? listed.t - input.t : Number.POSITIVE_INFINITY)
    }
    // Highlight changes: each must follow a keystroke's own results (within 4 frames of the text
    // changing); any later one was caused by something arriving late.
    const moved: string[] = []
    let lastText = ''
    let textAt = 0
    let prev: string | null | undefined
    for (const f of r.frames) {
      const text = f.els.input?.text ?? ''
      if (text !== lastText) {
        lastText = text
        textAt = f.t
      }
      const h = highlighted(f)
      if (prev !== undefined && h !== prev && f.t - textAt > 4 * FRAME)
        moved.push(`${prev}→${h} at ${Math.round(f.t)} ms`)
      prev = h
    }
    const end = r.frames.at(-1)
    const suggestions = Object.values(end?.lists.rows ?? {}).filter(
      (b) => b.attrs?.['data-kind'] === 'suggestion',
    ).length
    // The list's height between updates: a snap or a short animation, never a bounce back.
    const heights = r.frames.map((f) => f.els.bar?.height ?? 0)
    let reversals = 0
    for (let k = 2; k < heights.length; k++) {
      const a = (heights[k - 1] as number) - (heights[k - 2] as number)
      const b = (heights[k] as number) - (heights[k - 1] as number)
      if (Math.abs(a) > 0.5 && Math.abs(b) > 0.5 && Math.sign(a) !== Math.sign(b)) reversals++
    }
    await keysThroughMain(app, 'view=overlay', 'Escape', [])
    await overlayGone(app)
    return { echo, results, moved, suggestions, reversals }
  }
  const { best, all } = await bestOf(
    typing,
    (m) => Math.max(...m.echo) <= (FRAME_SLACK > 1 ? 2 : 1) && Math.max(...m.results) <= 50 * FRAME_SLACK,
  )
  await suggest.close()
  const { echo, results } = best
  for (const m of all) {
    console.log(
      `[feel] FL-17 echo frames ${m.echo.join(' ')}; results ms ${m.results.map((v) => Math.round(v)).join(' ')}`,
    )
  }
  note('FL-17', 'keystroke → field shows it, worst', Math.max(...echo), '1 frame', 'frames')
  note('FL-29', 'keystroke → local results on screen, worst', Math.max(...results), '≤ 50 ms')
  note(
    'FL-29',
    'keystroke → local results on screen, median',
    [...results].sort((a, b) => a - b)[results.length >> 1],
    '1 frame',
  )
  note('FL-17', 'highlight moved by a late update', Math.max(...all.map((m) => m.moved.length)), '0', 'times')
  note('FL-17', 'suggestion rows shown at the end', Math.min(...all.map((m) => m.suggestions)), '> 0', 'rows')
  note('FL-17', 'list height reversals (bounces)', Math.max(...all.map((m) => m.reversals)), '0', '')
  for (const m of all) {
    expect(m.moved).toEqual([])
    expect(m.suggestions).toBeGreaterThan(0)
    expect(m.reversals).toBe(0)
  }
  expect(Math.max(...echo)).toBeLessThanOrEqual(FRAME_SLACK > 1 ? 2 : 1)
  expect(Math.max(...results)).toBeLessThanOrEqual(50 * FRAME_SLACK)
})

test('[FL-17] ↑/↓ move the highlight in the next frame', async () => {
  const { app } = orbit
  for (const name of ['Arrow one', 'Arrow two', 'Arrow three']) await openTab(app, name)
  const overlay = await viewPage(app, 'overlay')
  await keysThroughMain(app, 'view=shell', 'T', [MOD_KEY], 'arrow')
  await expect.poll(() => overlay.getByTestId('command-result').count()).toBeGreaterThanOrEqual(3)
  const rec = await record(overlay, {
    rows: {
      selector: '[data-testid="command-bar"] [data-testid="command-result"]',
      key: 'data-id',
      attrs: ['aria-selected'],
      style: ['background-color'],
    },
  })
  for (const key of ['Down', 'Down', 'Up']) {
    await keysThroughMain(app, 'view=overlay', key, [])
    await overlay.waitForTimeout(150)
  }
  const r = await rec.stop()
  const downs = r.inputs.filter((i) => i.type === 'keydown')
  const frames = downs.map((input) => {
    const before = highlighted(r.frames[Math.max(0, input.frame - 1)] as Frame)
    const moved = r.frames.find((f) => f.i >= input.frame && highlighted(f) !== before)
    return moved ? moved.i - input.frame + 1 : Number.POSITIVE_INFINITY
  })
  // The new row's background reaches the colour it holds until the next key within 60 ms (no long fade).
  const settle = downs.map((input, k) => {
    const before = highlighted(r.frames[Math.max(0, input.frame - 1)] as Frame)
    const until = downs[k + 1]?.frame ?? r.frames.length
    const window = r.frames.filter((f) => f.i >= input.frame && f.i < until)
    const moved = window.find((f) => highlighted(f) !== before)
    if (!moved) return Number.POSITIVE_INFINITY
    const id = highlighted(moved) as string
    const steady = window.at(-1)?.lists.rows?.[id]?.style?.['background-color']
    const done = window.find((f) => f.i >= moved.i && f.lists.rows?.[id]?.style?.['background-color'] === steady)
    return done ? done.t - input.t : Number.POSITIVE_INFINITY
  })
  note('FL-17', '↑/↓ → highlight moved, worst', Math.max(...frames), '1 frame', 'frames')
  note('FL-17', '↑/↓ → highlight at its final colour, worst', Math.max(...settle), '≤ 60 ms')
  expect(Math.max(...frames)).toBeLessThanOrEqual(FRAME_SLACK > 1 ? 2 : 1)
  expect(Math.max(...settle)).toBeLessThanOrEqual(60 * FRAME_SLACK + FRAME)
})

test('[FL-16] Escape fades and shrinks the bar out over 100–120 ms; choosing a result hides it within 80 ms', async () => {
  const { app } = orbit
  const overlay = await viewPage(app, 'overlay')
  const closing = async (how: 'Escape' | 'Enter') => {
    await keysThroughMain(app, 'view=shell', 'T', [MOD_KEY], how === 'Enter' ? 'about:blank' : '')
    await expect(overlay.getByTestId('command-input')).toBeFocused()
    await expect(overlay.getByTestId('command-result').first()).toBeVisible()
    const keys = await mainInputs(app)
    const rec = await record(overlay, BAR)
    await keysThroughMain(app, 'view=overlay', how, [])
    const r = await rec.until(600)
    const down = (await keys()).find((k) => k.type === 'keyDown')
    if (!down) throw new Error('the key never reached main')
    const shown = r.frames.filter((f) => (f.els.bar?.opacity ?? 0) > 0.02)
    const last = shown.at(-1)
    const gone = r.frames.find((f) => last && f.i > last.i)
    const scales = shown.map((f) => scaleAndY(f.els.bar?.style?.transform).scale)
    await overlayGone(app)
    return {
      ms: gone ? gone.wall - down.wall : Number.POSITIVE_INFINITY,
      smallest: Math.min(...scales),
    }
  }
  const esc = await bestOf(
    () => closing('Escape'),
    (e) => e.ms <= 120 * FRAME_SLACK + FRAME,
  )
  const enter = await bestOf(
    () => closing('Enter'),
    (e) => e.ms <= 80 * FRAME_SLACK + FRAME,
  )
  note('FL-16', 'Escape → bar gone', esc.best.ms, '100–120 ms')
  note('FL-16', 'Escape: smallest scale while leaving', esc.best.smallest, '≈ 0.98', '')
  note('FL-16', 'Enter on a result → bar gone', enter.best.ms, '≈ 80 ms')
  expect(esc.best.ms).toBeLessThanOrEqual(120 * FRAME_SLACK + FRAME)
  expect(enter.best.ms).toBeLessThanOrEqual(80 * FRAME_SLACK + FRAME)
})

test('[FL-28] with Orbit set to reduce motion the bar only fades: no scale or drop in any frame, in or out', async () => {
  const { app } = orbit
  const overlay = await viewPage(app, 'overlay')
  // The OS (as Playwright emulates it) asks for no reduction: only Orbit's setting asks.
  await run(app, 'settings.update', { reduceMotion: true })
  await expect(overlay.locator('html')).toHaveClass(/\breduce-motion\b/)
  const rec = await record(overlay, BAR, { hidden: true, maxMs: 2000 })
  await keysThroughMain(app, 'view=shell', 'T', [MOD_KEY])
  await expect(overlay.getByTestId('command-bar')).toBeVisible()
  await overlay.waitForTimeout(250)
  await keysThroughMain(app, 'view=overlay', 'Escape', [])
  await overlayGone(app)
  const r = await rec.stop()
  const shapes = r.frames.filter((f) => f.els.bar).map((f) => scaleAndY(f.els.bar?.style?.transform))
  const opacities = r.frames.filter((f) => f.els.bar).map((f) => f.els.bar?.opacity ?? 0)
  const moved = Math.max(0, ...shapes.map((s) => Math.max(Math.abs(s.scale - 1) * 300, Math.abs(s.y))))
  note('FL-28', 'reduced: bar scale or drop, largest (px at the edge)', moved, '0 px', 'px')
  expect(shapes.length).toBeGreaterThan(2)
  expect(moved).toBeLessThanOrEqual(0.5)
  // It still fades: some frames between clear and opaque.
  expect(opacities.some((o) => o > 0.05 && o < 0.95)).toBe(true)
})
