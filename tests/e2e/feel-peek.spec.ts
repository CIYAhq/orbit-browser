/**
 * Feel of the Peek (feel.md FL-19), measured frame by frame with the shared sampler (frames.ts). The
 * overlay view draws the card, its chrome and the dim; main moves the Peek's page view onto the card
 * every frame (PK-06), so the card's box in the overlay is where the page shows. Each test logs its
 * numbers (`[feel]` lines): docs/FEEL.md has them against their targets.
 */
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import {
  bestOf,
  type Frame,
  frameAfterWall,
  mainInputs,
  note,
  pacing,
  type Recording,
  record,
  rgba,
  settledFrom,
} from './frames'
import { FRAME_SLACK, launchOrbit, type Orbit, run, state, viewPage } from './helpers'
import {
  blockNetwork,
  findPage,
  mainWindow,
  type OrbitGlobal,
  overlayOf,
  pressInTab,
  type Sites,
  startSites,
} from './peek-helpers'

let sites: Sites
let orbit: Orbit

test.beforeAll(async () => {
  sites = await startSites()
})
test.afterAll(async () => {
  await sites.close()
})
test.beforeEach(async () => {
  orbit = await launchOrbit()
  await blockNetwork(orbit.app)
  // The overlay renderer is warmed up shortly after launch (CB-22).
  await (await viewPage(orbit.app, 'overlay')).getByTestId('overlay').waitFor({ state: 'attached' })
})
test.afterEach(async () => {
  await orbit.app.close()
})

/** One refresh interval at 60 Hz. */
const FRAME = 1000 / 60
const slack = FRAME_SLACK
const PEEK = {
  card: { selector: '[data-testid="peek-card"]' },
  dim: { selector: '[data-testid="peek-backdrop"]', style: ['background-color'] },
}

/** A pinned tab on the first site, whose `#other` link opens a Peek (PK-02). */
async function pinnedSource(): Promise<{ source: string; page: Page }> {
  const win = await mainWindow(orbit.app)
  const source = (await run(orbit.app, 'tabs.create', {
    url: sites.url('/site/Motion'),
    container: { kind: 'pinned', spaceId: win.spaceId },
  })) as string
  const page = await findPage(orbit.app, '/site/Motion')
  await expect(page.locator('#other')).toBeVisible()
  return { source, page }
}

/** Clicks a point of a tab's page through the browser's input handling; returns main's wall time of the press. */
function clickThroughMain(app: ElectronApplication, tabId: string, x: number, y: number): Promise<number> {
  return app.evaluate(
    (_e, [id, px, py]) => {
      const contents = (globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs.contents(id)
      if (!contents) throw new Error(`no page for ${id}`)
      contents.sendInputEvent({ type: 'mouseMove', x: px, y: py })
      const wall = performance.timeOrigin + performance.now()
      contents.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 })
      contents.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 })
      return wall
    },
    [tabId, x, y] as const,
  )
}

/** Waits until the open spring has run to its end ('peek:opened' after the last 'peek:open'); returns the Peek's tab. */
async function opened(): Promise<string> {
  await expect.poll(async () => (await overlayOf(orbit.app)).kind).toBe('peek')
  await expect
    .poll(() =>
      orbit.app.evaluate(() => {
        const marks = (globalThis as unknown as OrbitGlobal).__orbit.ctx.perf.marks
        const open = marks.filter((m) => m.name === 'peek:open').pop()
        return !!open && marks.some((m) => m.name === 'peek:opened' && m.t >= open.t)
      }),
    )
    .toBe(true)
  const overlay = await overlayOf(orbit.app)
  return overlay.kind === 'peek' ? overlay.tabId : ''
}

/** Closes the Peek with Escape and waits until it is gone. */
async function closed(peekTab: string): Promise<void> {
  await pressInTab(orbit.app, peekTab, 'Escape')
  await expect.poll(async () => (await overlayOf(orbit.app)).kind).toBe('none')
}

/** How far a frame's card is from a box, in px (the largest of its edges and size). */
function off(f: Frame, to: { x: number; y: number; width: number; height: number }): number {
  const c = f.els.card
  if (!c) return Number.POSITIVE_INFINITY
  return Math.max(
    Math.abs(c.x - to.x),
    Math.abs(c.y - to.y),
    Math.abs(c.width - to.width),
    Math.abs(c.height - to.height),
  )
}

/** What the page behind is darkened by in a frame: the dim's opacity times its colour's alpha. */
const dimOf = (f: Frame) => (f.els.dim ? f.els.dim.opacity * (rgba(f.els.dim.style?.['background-color'])[3] ?? 0) : 0)

/**
 * In main, from now: polls every millisecond for a layer of Orbit's over the page (the overlay view
 * or the Peek's page view, shown in the window) and stamps the first moment there is none. Returns a
 * reader (0 until then).
 */
async function layerGone(app: ElectronApplication, peekTab: string): Promise<() => Promise<number>> {
  await app.evaluate((_e, id) => {
    const g = globalThis as unknown as OrbitGlobal & { __feelLayerGone?: number }
    const ctx = g.__orbit.ctx
    const win = ctx.windows.get(ctx.windows.ids()[0] as string)
    const peek = ctx.tabs.contents(id)
    if (!win || !peek) throw new Error('no window or Peek')
    g.__feelLayerGone = 0
    const up = () =>
      win.contentView.children.some((v) => {
        const wc = (v as Electron.WebContentsView).webContents
        if (!wc || wc.isDestroyed() || !v.getVisible()) return false
        return wc === peek || wc.getURL().includes('view=overlay')
      })
    const started = Date.now()
    const timer = setInterval(() => {
      if (up() && Date.now() - started < 5000) return
      clearInterval(timer)
      if (!up()) g.__feelLayerGone = performance.timeOrigin + performance.now()
    }, 1)
  }, peekTab)
  return () => app.evaluate(() => (globalThis as unknown as { __feelLayerGone?: number }).__feelLayerGone ?? 0)
}

test('[FL-19] a Peek grows out of the clicked link into a card about 90 % of the page with the standard spring, and dims the page 10–20 %', async () => {
  const { source, page } = await pinnedSource()
  const overlay = await viewPage(orbit.app, 'overlay')
  const link = await page.locator('#other').boundingBox()
  if (!link) throw new Error('no link')
  const linkX = link.x + link.width / 2
  const linkY = link.y + link.height / 2
  const { best, all } = await bestOf(
    async (round) => {
      if (round > 1) await expect.poll(async () => (await overlayOf(orbit.app)).kind).toBe('none')
      const rec = await record(overlay, PEEK, { hidden: true, maxMs: 3000 })
      const clickWall = await clickThroughMain(orbit.app, source, linkX, linkY)
      const peekTab = await opened()
      // The spring's last frames are in by now (it ends within half a second of the click).
      const r: Recording = await rec.until(1200)
      const area = await overlay.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      await closed(peekTab)
      const cards = r.frames.filter((f) => (f.els.card?.width ?? 0) > 0 && (f.els.card?.opacity ?? 0) > 0)
      const first = cards[0]
      const last = cards.at(-1)
      if (!first?.els.card || !last?.els.card) throw new Error('no card drawn')
      const end = last.els.card
      const within = (px: number) => settledFrom({ ...r, frames: cards }, (f) => off(f, end) <= px)
      const cx = first.els.card.x + first.els.card.width / 2
      const cy = first.els.card.y + first.els.card.height / 2
      return {
        drawn: first.wall - clickWall,
        firstShare: first.els.card.width / end.width,
        fromLink: Math.hypot(cx - linkX, cy - linkY),
        in2: (within(2)?.t ?? Number.POSITIVE_INFINITY) - first.t,
        in05: (within(0.5)?.t ?? Number.POSITIVE_INFINITY) - first.t,
        overshoot: Math.max(0, ...cards.map((f) => ((f.els.card?.width ?? 0) - end.width) / end.width)),
        endWidth: end.width,
        width: end.width / area.width,
        height: end.height / area.height,
        centred: Math.max(
          Math.abs(end.x + end.width / 2 - area.width / 2),
          Math.abs(end.y + end.height / 2 - area.height / 2),
        ),
        dim: Math.max(0, ...r.frames.map(dimOf)),
        pace: pacing(cards),
      }
    },
    (m) => m.in2 <= (320 + 2 * FRAME) * slack,
  )
  const m = best
  note('FL-19', 'open: click → card first drawn', m.drawn, '–', 'ms')
  note('FL-19', 'open: first frame width, share of the card', m.firstShare * 100, 'small (grows from the link)', '%')
  note('FL-19', 'open: first frame centre to the link', m.fromLink, 'at the link', 'px')
  note('FL-19', 'open: first frame → card within 2 px', m.in2, '280–320 ms')
  note('FL-19', 'open: first frame → card in place (within 0.5 px)', m.in05, '280–320 ms')
  note('FL-19', 'open: overshoot, share of the card width', m.overshoot * 100, '≤ 2 %', '%')
  note('FL-19', 'open: card width, share of the page area', m.width * 100, '≈ 90 %', '%')
  note('FL-19', 'open: card height, share of the page area', m.height * 100, '≈ 90 %', '%')
  note('FL-19', 'open: page behind darkened by', m.dim * 100, '10–20 %', '%')
  note('FL-19', 'open: frame p99', m.pace.p99, '≤ 16.7 ms (FL-29)')
  note('FL-19', 'open: frame max', m.pace.max, '≤ 33.3 ms (FL-29)')
  console.info(`[feel] FL-19 open rounds: ${all.map((x) => `${Math.round(x.in2)} ms`).join(', ')}`)
  expect(m.firstShare, 'grows from the link, not from the card').toBeLessThan(0.34)
  // The card's centre at rest is about 550 px from the link: a first frame near the link grew from it.
  expect(m.fromLink).toBeLessThan(m.endWidth / 4)
  expect(m.in2).toBeLessThanOrEqual((320 + 2 * FRAME) * slack)
  expect(m.overshoot).toBeLessThanOrEqual(0.02)
  expect(m.width).toBeGreaterThan(0.85)
  expect(m.width).toBeLessThan(0.95)
  expect(m.height).toBeGreaterThan(0.85)
  expect(m.height).toBeLessThan(0.95)
  expect(m.centred).toBeLessThan(2)
  expect(m.dim).toBeGreaterThanOrEqual(0.1)
  expect(m.dim).toBeLessThanOrEqual(0.2)
})

test('[FL-19] Escape shrinks the card to about 0.96 as it fades in 150–180 ms, and the page behind takes clicks again within 200 ms', async () => {
  const { source, page } = await pinnedSource()
  const overlay = await viewPage(orbit.app, 'overlay')
  const link = await page.locator('#other').boundingBox()
  if (!link) throw new Error('no link')
  const { best, all } = await bestOf(
    async () => {
      await clickThroughMain(orbit.app, source, link.x + link.width / 2, link.y + link.height / 2)
      const peekTab = await opened()
      const gone = await layerGone(orbit.app, peekTab)
      const keys = await mainInputs(orbit.app)
      const rec = await record(overlay, PEEK, { maxMs: 3000 })
      await closed(peekTab)
      await expect.poll(gone).toBeGreaterThan(0)
      const r: Recording = await rec.stop()
      const esc = (await keys()).find((k) => k.type === 'keyDown' && k.key === 'Escape')
      if (!esc) throw new Error('Escape never reached main')
      const at = frameAfterWall(r, esc.wall)
      const open = r.frames[Math.max(0, at - 1)]?.els.card
      if (!open) throw new Error('no open card before Escape')
      const after = r.frames.slice(at)
      const moving = after.find((f) => (f.els.card?.width ?? 0) < open.width - 0.5)
      // The fade's last frame: the last one in which the card still changed, or went while it showed.
      const out = after.findLast((f, k) => {
        const a = (k > 0 ? after[k - 1] : r.frames[at - 1])?.els.card
        const b = f.els.card
        if (!a) return false
        if (!b) return a.opacity > 0.0005
        return Math.abs(a.opacity - b.opacity) > 0.0005 || Math.abs(a.width - b.width) > 0.05
      })
      const sizes = after.filter((f) => f.els.card).map((f) => (f.els.card?.width ?? 0) / open.width)
      const undimmed = after.find((f) => dimOf(f) <= 0.001)
      return {
        starts: moving ? moving.i - at + 1 : Number.POSITIVE_INFINITY,
        fade: moving && out ? out.t - moving.t : Number.POSITIVE_INFINITY,
        smallest: Math.min(...sizes),
        undimmed: undimmed ? undimmed.wall - esc.wall : Number.POSITIVE_INFINITY,
        layer: (await gone()) - esc.wall,
      }
    },
    (m) => m.layer <= 200 * slack && m.fade <= (180 + 2 * FRAME) * slack,
  )
  const m = best
  note('FL-19', 'close: Escape → card starts closing', m.starts, '1–2 frames', 'frames')
  note('FL-19', 'close: first frame → last frame of the fade', m.fade, '150–180 ms')
  note('FL-19', 'close: smallest card scale', m.smallest, '≈ 0.96', '')
  note('FL-19', 'close: Escape → dim gone', m.undimmed, 'with the card', 'ms')
  note('FL-19', 'close: Escape → no layer over the page (main)', m.layer, '≤ 200 ms')
  console.info(`[feel] FL-19 close rounds: ${all.map((x) => `layer ${Math.round(x.layer)} ms`).join(', ')}`)
  expect(m.starts).toBeLessThanOrEqual(3 * slack)
  // The curve runs 160 ms; its last tenth is under 0.1 % and is not drawn.
  expect(m.fade, 'a fade, not a cut').toBeGreaterThanOrEqual(100)
  expect(m.fade).toBeLessThanOrEqual((180 + 2 * FRAME) * slack)
  expect(m.smallest).toBeGreaterThan(0.94)
  expect(m.smallest).toBeLessThan(0.98)
  expect(m.layer).toBeLessThanOrEqual(200 * slack)
})

test('[FL-19] ⌘O grows the card until its edges meet the page card in about 220–260 ms, then it is a normal tab', async () => {
  const { source, page } = await pinnedSource()
  const overlay = await viewPage(orbit.app, 'overlay')
  const link = await page.locator('#other').boundingBox()
  if (!link) throw new Error('no link')
  await clickThroughMain(orbit.app, source, link.x + link.width / 2, link.y + link.height / 2)
  const peekTab = await opened()
  const area = await overlay.evaluate(() => ({ x: 0, y: 0, width: innerWidth, height: innerHeight }))
  const keys = await mainInputs(orbit.app)
  const rec = await record(overlay, PEEK, { maxMs: 3000 })
  await pressInTab(orbit.app, peekTab, 'Mod+O')
  await expect.poll(async () => (await overlayOf(orbit.app)).kind).toBe('none')
  const r: Recording = await rec.stop()
  const cmdO = (await keys()).find((k) => k.type === 'keyDown' && k.key.toLowerCase() === 'o')
  if (!cmdO) throw new Error('⌘O never reached main')
  const at = frameAfterWall(r, cmdO.wall)
  const start = r.frames[Math.max(0, at - 1)]?.els.card
  const after = r.frames.slice(at).filter((f) => f.els.card)
  const moving = after.find((f) => start && (f.els.card?.width ?? 0) > start.width + 0.5)
  const met = (px: number) => after.find((f) => off(f, area) <= px)
  const ms = (f: Frame | undefined) => (f && moving ? f.t - moving.t : Number.POSITIVE_INFINITY)
  note('FL-19', 'expand: first move → edges within 2 px of the page card', ms(met(2)), '220–260 ms')
  note('FL-19', 'expand: first move → edges meet (within 0.5 px)', ms(met(0.5)), '220–260 ms')
  // It is a normal, selected tab now (PK-07).
  const s = await state(orbit.app)
  const win = await mainWindow(orbit.app)
  expect(s.tabs[peekTab]?.floating).toBeUndefined()
  expect(win.activeTab[win.spaceId]).toBe(peekTab)
  expect(ms(met(2))).toBeLessThanOrEqual((260 + 2 * FRAME) * slack)
})
