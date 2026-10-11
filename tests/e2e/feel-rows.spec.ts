/**
 * Feel of the tab rows (feel.md FL-04, FL-05, FL-06, FL-09, FL-10 and their FL-29 budgets), measured
 * frame by frame with the shared sampler (frames.ts). Each test logs its numbers (`[feel]` lines):
 * docs/FEEL.md has them against their targets.
 */
import { expect, type Page, test } from '@playwright/test'
import {
  type Box,
  bestOf,
  frameAfterWall,
  jumpRatio,
  mainInputs,
  motionOf,
  ms,
  note,
  pacing,
  type Recording,
  record,
  responseTo,
  rgba,
  series,
  settledFrom,
  viewShown,
} from './frames'
import {
  type Fixtures,
  FRAME_SLACK,
  isMac,
  launchOrbit,
  MOD,
  type Orbit,
  startFixtures,
  state,
  viewPage,
} from './helpers'
import { pressInPage } from './nav-support'
import { activeId, center, cmd, newTab, row, settled, space, waitTab } from './tabs-support'

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
const alpha = (bg: string | undefined) => rgba(bg)[3]
/** The primary modifier as Electron's input events name it. */
const MOD_KEY = isMac ? 'meta' : 'control'
const TODAY_ROWS = '[data-testid="today-list"] [data-testid="tab-row"]'

/** Makes `n` Today tabs (blank pages, in the background) and waits for their rows to settle. */
async function blankTabs(n: number, tag = 't'): Promise<string[]> {
  const { app, shell } = orbit
  await app.evaluate(
    async (_e, [count, prefix]) => {
      const g = globalThis as unknown as {
        __orbit: { run: (n: string, a: unknown, w?: string) => Promise<unknown>; windowIds: () => string[] }
      }
      const w = g.__orbit.windowIds()[0]
      for (let i = 0; i < count; i++) {
        await g.__orbit.run('tabs.create', { url: `about:blank#${prefix}${i}`, activate: false }, w)
      }
    },
    [n, tag] as const,
  )
  await expect(shell.getByTestId('today-list').locator(':scope > [data-slot]')).toHaveCount(n, { timeout: 20_000 })
  await settled(shell, 20_000)
  return (await space(app)).today.slice()
}

/** The background alpha a selected row settles on (the theme's `--active`). */
function activeAlpha(shell: Page, tabId: string): Promise<number> {
  return row(shell, tabId).evaluate((el) => {
    const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(el).backgroundColor)
    const parts = (m?.[1] ?? '')
      .split(/[,\s/]+/)
      .filter(Boolean)
      .map(Number)
    return parts[3] ?? (parts.length === 3 ? 1 : 0)
  })
}

test('[FL-04] a quick sweep down 20 rows highlights each row as the pointer passes, without lag or jitter', async () => {
  const { shell } = orbit
  const all = await blankTabs(24)
  // The rows the list shows whole (a short window shows fewer than 20).
  const view = await shell.getByTestId('sidebar-scroll').boundingBox()
  const boxes = await Promise.all(all.map((id) => row(shell, id).boundingBox()))
  const ids = all
    .filter((_, k) => {
      const b = boxes[k]
      return !!b && !!view && b.y >= view.y && b.y + b.height <= view.y + view.height
    })
    .slice(0, 20)
  const top = await center(row(shell, ids[0] as string))
  const bottom = await center(row(shell, ids.at(-1) as string))
  await shell.mouse.move(top.x, top.box.y - 24)
  await shell.waitForTimeout(300)
  // The hover colour's alpha, and how far the fade in (instant timing, about 90 ms) steps in a frame.
  const hoverAlpha = alpha(
    await row(shell, ids[0] as string).evaluate((el) => getComputedStyle(el).getPropertyValue('--hover').trim()),
  )
  const inStep = (hoverAlpha * FRAME) / 80
  const rec = await record(shell, {
    rows: { selector: TODAY_ROWS, key: 'data-tab-id', style: ['background-color'], classes: true },
    titles: { selector: `${TODAY_ROWS} [data-testid="tab-title"]`, key: 'data-tab-id' },
    closes: { selector: `${TODAY_ROWS} [data-testid="tab-close"]`, key: 'data-tab-id' },
  })
  // About one pointer sample per row, as a quick flick of a mouse gives.
  await shell.mouse.move(top.x, bottom.y, { steps: ids.length })
  await shell.mouse.move(top.x + 400, bottom.y, { steps: 1 })
  const r = await rec.until(1500)
  const moves = r.inputs.filter((i) => i.type === 'pointermove')
  const first = r.frames[0]
  if (!first) throw new Error('nothing recorded')

  const lags: number[] = []
  let entered = 0
  const offs: number[] = []
  const jumps: string[] = []
  const late: string[] = []
  const apart: string[] = []
  for (const id of ids) {
    const box = first.lists.rows?.[id]
    if (!box) throw new Error(`row ${id} not drawn`)
    // The selected row keeps its own highlight under the pointer.
    if (/is-active|is-selected/.test(box.classes ?? '')) continue
    const inside = (y: number | undefined) => y !== undefined && y >= box.y && y < box.y + box.height
    const enter = moves.find((m) => inside(m.y))
    if (!enter) continue
    entered++
    const leave = moves.find((m) => m.t > enter.t && !inside(m.y))
    const lit = responseTo(r, enter, (f) => alpha(f.lists.rows?.[id]?.style?.['background-color']) > 0.004)
    const close = responseTo(r, enter, (f) => (f.lists.closes?.[id]?.opacity ?? 0) > 0.05)
    if (!lit) {
      const around = r.frames
        .filter((f) => f.i >= enter.frame - 1 && f.i <= enter.frame + 3)
        .map((f) => alpha(f.lists.rows?.[id]?.style?.['background-color']).toFixed(3))
      late.push(`${id}: never lit (entered at frame ${enter.frame}, y ${enter.y}; alpha ${around.join(' ')})`)
      continue
    }
    lags.push(lit.frames)
    if (lit.frames > 2) late.push(`${id}: lit ${lit.frames} frames after the pointer came`)
    if (close && Math.abs(close.frames - lit.frames) > 1)
      apart.push(`${id}: × ${close.frames}, highlight ${lit.frames}`)
    if (!leave) continue
    // Out: from what it shows, never up to the full hover first (FL-01: no jumps). The fade in may
    // take one more step before the pointer's leaving lands.
    const before = r.frames.filter((f) => f.i < leave.frame).at(-1)
    const after = r.frames[leave.frame]
    const a0 = alpha(before?.lists.rows?.[id]?.style?.['background-color'])
    const a1 = alpha(after?.lists.rows?.[id]?.style?.['background-color'])
    if (a1 > a0 + inStep + 0.002) jumps.push(`${id}: ${a0.toFixed(3)} → ${a1.toFixed(3)}`)
    const dark = responseTo(r, leave, (f) => alpha(f.lists.rows?.[id]?.style?.['background-color']) === 0)
    offs.push(dark?.ms ?? Number.POSITIVE_INFINITY)
  }
  // No jitter, and hover never changes layout: rows and titles keep their boxes in every frame.
  const moved: string[] = []
  for (const id of ids) {
    for (const [what, value] of [
      ['y', (f: (typeof r.frames)[number]) => f.lists.rows?.[id]?.y],
      ['title width', (f: (typeof r.frames)[number]) => f.lists.titles?.[id]?.width],
    ] as const) {
      const vs = r.frames.map(value).filter((v): v is number => v !== undefined)
      if (Math.max(...vs) - Math.min(...vs) > 0.5) moved.push(`${id} ${what}`)
    }
  }
  const pace = pacing(r)
  note('FL-04', 'rows the pointer entered (moves are coalesced per frame)', entered, '–', 'rows')
  note('FL-04', 'rows lit of those', lags.length, 'all', 'rows')
  note('FL-04', 'frames to highlight, worst', Math.max(...lags), '≤ 2 (a fade starts at 0)', 'frames')
  note('FL-04', 'highlight gone after the pointer left, worst', Math.max(...offs), '≤ 150 ms (quick)')
  note('FL-04', 'frame p99 during the sweep', pace.p99, `≤ ${FRAME.toFixed(1)} ms`)
  note('FL-04', 'frame max during the sweep', pace.max, `≤ ${(2 * FRAME).toFixed(1)} ms`)
  expect(entered, 'rows the pointer entered').toBeGreaterThanOrEqual(12)
  expect(late, 'rows lit late').toEqual([])
  expect(lags.length, 'rows lit').toBe(entered)
  expect(apart, 'close button and highlight apart').toEqual([])
  expect(jumps, 'rows whose highlight jumped up as the pointer left').toEqual([])
  expect(Math.max(...offs), 'highlight gone after the pointer left').toBeLessThanOrEqual(
    (150 + 2 * FRAME) * FRAME_SLACK,
  )
  expect(moved, 'rows or titles that moved').toEqual([])
})

test('[FL-05][FL-29] a press selects at once: highlight in the first frame, the old one gone, the page within 50 ms', async () => {
  const { app, shell } = orbit
  const a = await newTab(app, fx.url('/page/Press-A'), { activate: true })
  await waitTab(app, a, '/page/Press-A')
  const b = await newTab(app, fx.url('/page/Press-B'), { activate: true })
  await waitTab(app, b, '/page/Press-B')
  await settled(shell)
  const full = await activeAlpha(shell, b)
  const lit = (bg: string | undefined) => alpha(bg) >= full / 2
  type Round = { highlight: number; frames: number; oldGone: number; page: number; selectedOnDown: boolean }
  const { best, all } = await bestOf<Round>(
    async () => {
      // Back to B, the pointer away from the rows.
      await cmd(app, 'tabs.activate', { tabId: b })
      await expect.poll(() => activeId(app)).toBe(b)
      await shell.mouse.move(400, 860)
      await settled(shell)
      const target = await center(row(shell, a))
      const shown = await viewShown(app, a)
      const rec = await record(shell, {
        a: { selector: `[data-testid="tab-row"][data-tab-id="${a}"]`, style: ['background-color'] },
        b: { selector: `[data-testid="tab-row"][data-tab-id="${b}"]`, style: ['background-color'] },
      })
      // A quick click: onto the row and down at once, as a hand does.
      await shell.mouse.move(target.x, target.y)
      await shell.mouse.down()
      const selectedOnDown = (await activeId(app)) === a
      await shell.mouse.up()
      const r = await rec.until(500)
      const down = r.inputs.find((i) => i.type === 'pointerdown')
      if (!down) throw new Error('the press never reached the shell')
      const on = responseTo(r, down, (f) => lit(f.els.a?.style?.['background-color']))
      const off = responseTo(r, down, (f) => !lit(f.els.b?.style?.['background-color']))
      const pageAt = (await shown())[0]
      return {
        highlight: on?.ms ?? Number.POSITIVE_INFINITY,
        frames: on?.frames ?? Number.POSITIVE_INFINITY,
        oldGone: off && on ? off.frame.t - on.frame.t : Number.POSITIVE_INFINITY,
        // Main showed the view; the window's next frame draws it.
        page: pageAt === undefined ? Number.POSITIVE_INFINITY : pageAt - down.wall + FRAME,
        selectedOnDown,
      }
    },
    (x) => x.frames <= 1 && x.oldGone <= 60 * FRAME_SLACK && x.page <= 50 * FRAME_SLACK,
  )
  for (const [k, x] of all.entries()) {
    console.log(
      `[feel] FL-05 round ${k + 1}: highlight ${ms(x.highlight)} (${x.frames} frames), old gone +${ms(x.oldGone)}, page ${ms(x.page)}`,
    )
  }
  note('FL-05', 'press → highlight', best.highlight, '1 frame (16.7 ms)')
  note('FL-05', 'old highlight gone after the new one', best.oldGone, '≤ 60 ms')
  note('FL-05', 'press → page shown', best.page, '≤ 50 ms')
  expect(best.selectedOnDown, 'selected on pointer-down, before the release').toBe(true)
  expect(best.frames, 'frames from the press to the highlight').toBeLessThanOrEqual(1)
  expect(best.oldGone).toBeLessThanOrEqual(60 * FRAME_SLACK)
  expect(best.page).toBeLessThanOrEqual(50 * FRAME_SLACK)
})

test('[FL-06] a new tab from the command bar grows in within 250 ms, selected from its first frame, rows below gliding', async () => {
  const { app, shell } = orbit
  const ids = await blankTabs(5)
  const keys = await mainInputs(app)
  await shell.keyboard.press(`${MOD}+T`)
  const overlay = await viewPage(app, 'overlay')
  const input = overlay.getByTestId('command-input')
  await expect(input).toBeFocused()
  await input.fill(fx.url('/page/Inserted'))
  await expect(overlay.getByTestId('command-result').first()).toBeVisible()
  const rec = await record(shell, {
    slots: { selector: '[data-testid="today-list"] > [data-slot]', key: 'data-key' },
    rows: { selector: TODAY_ROWS, key: 'data-tab-id', classes: true },
    content: { selector: `${TODAY_ROWS} [data-testid="tab-title"]`, key: 'data-tab-id' },
  })
  await keys()
  // Through the browser process, as the keyboard does: main sees it (Playwright's keys go straight to the page).
  await pressInPage(app, 'view=overlay', 'Enter')
  const r = await rec.until(900)
  const enter = (await keys()).find((k) => k.type === 'keyDown' && k.key === 'Enter')
  if (!enter) throw new Error('Enter never reached main')
  const fresh = Object.keys(r.frames.at(-1)?.lists.slots ?? {}).find((k) => !ids.includes(k))
  if (!fresh) throw new Error('no new row')
  const height = series(r, 'slots', (b) => b.height, fresh)
  const appeared = r.frames.find((f) => f.lists.slots?.[fresh])
  const full = r.frames.find((f) => (f.lists.slots?.[fresh]?.height ?? 0) >= 31.5)
  const t0 = enter.wall - r.wall0
  const expanded = full ? full.t - t0 : Number.POSITIVE_INFINITY
  const firstRow = r.frames.find((f) => f.lists.rows?.[fresh])
  const selectedFirst = !!firstRow?.lists.rows?.[fresh]?.classes?.includes('is-active')
  // Rows below glide: no frame moves one by most of its travel at once (FL-01).
  const glides = ids.map((id) => jumpRatio(series(r, 'slots', (b) => b.y, id)))
  const biggest = ids.map((id) => motionOf(series(r, 'slots', (b) => b.y, id)).biggestStep)
  // Content fades in over the last part of the growth.
  const fadeStart = r.frames.find((f) => (f.lists.content?.[fresh]?.opacity ?? 0) > 0.02)

  const growth = motionOf(height)
  note('FL-06', 'Enter → new row fully expanded', expanded, '≤ 250 ms')
  note('FL-06', 'Enter → new row first drawn', appeared ? appeared.t - t0 : undefined, '1 frame after the state')
  note(
    'FL-06',
    'growth duration (first to last change)',
    (growth.end ?? 0) - (growth.start ?? 0),
    '180–220 ms (snappy)',
  )
  note('FL-06', 'rows below: largest step share', Math.max(...biggest) * 100, '< 60 % (no instant jump)', '%')
  note('FL-06', 'rows below: jump ratio', Math.max(...glides), '≤ 6× average speed', '×')
  const growStart = growth.start ?? 0
  const growEnd = growth.end ?? growStart
  note(
    'FL-06',
    'content fade starts, share of the growth time',
    fadeStart ? ((fadeStart.t - growStart) / Math.max(1, growEnd - growStart)) * 100 : undefined,
    '≈ 40 % (fades in over the last 60 %)',
    '%',
  )
  expect(selectedFirst, 'the new row is selected in its first frame').toBe(true)
  expect(expanded).toBeLessThanOrEqual(250 * FRAME_SLACK)
  if (FRAME_SLACK === 1) expect(Math.max(...biggest)).toBeLessThan(0.6)
})

test('[FL-09][FL-29] closing the second of five: the third is selected in the same frame and the gap closes within 250 ms', async () => {
  const { app, shell } = orbit
  const ids = await blankTabs(5)
  const [, second, third] = ids as [string, string, string]
  await cmd(app, 'tabs.activate', { tabId: second })
  await expect(row(shell, second)).toHaveClass(/is-active/)
  await settled(shell)
  const y2 = (await row(shell, second).boundingBox())?.y ?? 0
  const keys = await mainInputs(app)
  const rec = await record(shell, {
    slots: { selector: '[data-testid="today-list"] > [data-slot]', key: 'data-key', classes: true },
    rows: { selector: TODAY_ROWS, key: 'data-tab-id', classes: true },
  })
  await pressInPage(app, 'view=shell', 'W', [MOD_KEY])
  const r = await rec.until(800)
  const key = (await keys()).find((k) => k.type === 'keyDown' && k.key.toLowerCase() === 'w')
  if (!key) throw new Error('the close key never reached main')
  const after = frameAfterWall(r, key.wall)
  const t0 = key.wall - r.wall0
  const selected = r.frames.find((f) => f.i >= after && f.lists.rows?.[third]?.classes?.includes('is-active'))
  const leaving = r.frames.find((f) => f.lists.slots?.[second] && f.lists.rows?.[second] && isExiting(r, f.i, second))
  // Closed: the row below has risen into the closed row's place (to within half a pixel).
  const closed = r.frames.find((f) => f.i >= after && Math.abs((f.lists.rows?.[third]?.y ?? -1) - y2) <= 0.5)
  const exitX = motionOf(series(r, 'rows', (b) => b.x, second))
  note('FL-09', '⌘W → next tab selected', selected ? selected.t - t0 : undefined, '1 frame (16.7 ms)')
  note('FL-09', 'frames from ⌘W to the selection', selected ? selected.i - after + 1 : undefined, '1', 'frames')
  note('FL-09', '⌘W → gap closed', closed ? closed.t - t0 : undefined, '≤ 250 ms')
  note('FL-09', 'closing row slides left', exitX.travel, '≈ 12 px', 'px')
  expect(selected, 'the third row selected').toBeTruthy()
  // The same frame as the row starts leaving, or before.
  expect((selected?.i ?? Number.POSITIVE_INFINITY) <= (leaving?.i ?? Number.POSITIVE_INFINITY)).toBe(true)
  expect(closed ? closed.t - t0 : Number.POSITIVE_INFINITY).toBeLessThanOrEqual(250 * FRAME_SLACK)
})

test('[FL-07] ⌘D on the third Today tab: it travels into the pinned section as the others re-flow; ⌘Z plays it back', async () => {
  const { app, shell } = orbit
  const ids = await blankTabs(5)
  const third = ids[2] as string
  await cmd(app, 'tabs.activate', { tabId: third })
  await expect(row(shell, third)).toHaveClass(/is-active/)
  await settled(shell)
  const rowIn = (list: string) => `[data-testid="${list}"] [data-testid="tab-row"][data-tab-id="${third}"]`
  const shown = (b: Box | null | undefined) => !!b && b.opacity > 0.5
  /** Presses `key` and follows the row from one section to the other, and the rows and divider around it. */
  async function travel(what: string, key: string, from: 'today' | 'pinned', to: 'today' | 'pinned') {
    const rec = await record(shell, {
      today: rowIn('today-list'),
      pinned: rowIn('pinned-list'),
      rows: { selector: TODAY_ROWS, key: 'data-tab-id' },
      divider: '[data-testid="today-divider"]',
    })
    await shell.keyboard.press(key)
    await expect.poll(async () => (await space(app)).pinned.includes(third)).toBe(to === 'pinned')
    const r = await rec.until(900)
    const press = r.inputs.find((i) => i.type === 'keydown' && i.key?.toLowerCase() === key.at(-1)?.toLowerCase())
    const start = r.frames[0]?.els[from]
    const end = r.frames.at(-1)?.els[to]
    if (!press || !start || !end) throw new Error(`${what}: no key, or the row not drawn before or after`)
    const after = r.frames.filter((f) => f.i >= press.frame)
    // Never gone (popping out and in again), never drawn twice.
    const gone = after.filter((f) => !shown(f.els.today) && !shown(f.els.pinned)).length
    const twice = after.filter((f) => shown(f.els.today) && shown(f.els.pinned)).length
    const arrived = after.find((f) => shown(f.els[to]))
    const distance = Math.max(1, Math.abs(end.y - start.y))
    const startsAt = arrived ? Math.abs((arrived.els[to]?.y ?? 0) - start.y) / distance : 1
    const path = motionOf(series(r, to, (b) => b.y).filter((p) => p.t >= (arrived?.t ?? 0)))
    const landed = settledFrom(r, (f) => Math.abs((f.els[to]?.y ?? Number.NaN) - end.y) <= 0.5)
    const settle = landed ? landed.t - press.t : Number.POSITIVE_INFINITY
    // The divider and the rows between the two places move by a row; the rows below both stay put.
    const between = [ids[0], ids[1]].map((id) => motionOf(series(r, 'rows', (b) => b.y, id)))
    between.push(motionOf(series(r, 'divider', (b) => b.y)))
    const stepShare = Math.max(...between.map((m) => m.biggestStep))
    const excursion = Math.max(
      ...[ids[3], ids[4]].map((id) => {
        const ys = series(r, 'rows', (b) => b.y, id)
          .map((p) => p.v)
          .filter((v) => !Number.isNaN(v))
        return Math.max(...ys.map((v) => Math.abs(v - (ys[0] ?? v))))
      }),
    )
    note('FL-07', `${what} → in its new slot (within 0.5 px)`, settle, '≈ 250 ms (standard spring)')
    note('FL-07', `${what}: travel, first to last moving frame`, (path.end ?? 0) - (path.start ?? 0), '≈ 250 ms')
    note('FL-07', `${what}: first frame in the new section, share of the way gone`, startsAt * 100, '≈ 0 %', '%')
    note('FL-07', `${what}: frames with the row nowhere / twice`, gone + twice, '0', 'frames')
    note('FL-07', `${what}: divider and rows above, largest step share`, stepShare * 100, '< 60 % (no jump)', '%')
    note('FL-07', `${what}: rows below, furthest from their place`, excursion, '≈ 0 (they stay)', 'px')
    expect(gone, `${what}: frames with the row nowhere`).toBe(0)
    expect(twice, `${what}: frames with the row drawn twice`).toBe(0)
    expect(startsAt, `${what}: the row starts from where it was`).toBeLessThanOrEqual(0.35)
    expect(settle, `${what}: settled in its new slot`).toBeLessThanOrEqual(400 * FRAME_SLACK)
    expect(stepShare, `${what}: the divider and the rows above move with a spring`).toBeLessThan(
      FRAME_SLACK === 1 ? 0.6 : 0.95,
    )
    expect(excursion, `${what}: the rows below stay put`).toBeLessThanOrEqual(4)
  }
  await travel('⌘D', `${MOD}+D`, 'today', 'pinned')
  await settled(shell)
  await travel('⌘Z', `${MOD}+Z`, 'pinned', 'today')
  expect((await space(app)).today).toEqual(ids)
})

test('[FL-07] pinned while the pinned section is out of sight, or moved to another Space: the row collapses out in place and nothing scrolls', async () => {
  const { app, shell } = orbit
  const ids = await blankTabs(30)
  const scroll = shell.getByTestId('sidebar-scroll')
  // Mid-list, with room below for both moves: at its end, a list that gets shorter has to pull the rows above
  // down (its scroll range shrinks, as with any close), which is not the list scrolling after the row.
  const room = await scroll.evaluate((el) => {
    el.scrollTop = 300
    return el.scrollHeight - el.clientHeight - el.scrollTop
  })
  expect(room, 'room below the visible band for two rows to leave').toBeGreaterThanOrEqual(2 * 32)
  await settled(shell)
  const view = await scroll.boundingBox()
  if (!view) throw new Error('no sidebar')
  const band = { top: view.y, bottom: view.y + view.height }
  const pinnedEnd = await shell.getByTestId('pinned-list').evaluate((el) => el.getBoundingClientRect().bottom)
  expect(pinnedEnd + 32, 'the pinned section, even a row longer, is out of sight').toBeLessThan(band.top)
  // Two rows in the middle of the list's visible band, and the row above them.
  const boxes = await Promise.all(ids.map((id) => row(shell, id).boundingBox()))
  const k = boxes.findIndex((b) => !!b && b.y > view.y + view.height / 3)
  const [above, first, second] = [ids[k - 1], ids[k], ids[k + 1]] as [string, string, string]
  const other = await cmd<string>(app, 'spaces.create', { name: 'Elsewhere', activate: false })
  /** Moves `id` (`how`), then checks that it left in place with the close motion while the rows above stayed. */
  async function leavesInPlace(what: string, id: string, how: () => Promise<void>) {
    await cmd(app, 'tabs.activate', { tabId: id })
    await expect(row(shell, id)).toHaveClass(/is-active/)
    await settled(shell)
    const rec = await record(shell, {
      slot: `[data-testid="today-list"] > [data-slot][data-key="${id}"]`,
      row: `[data-testid="today-list"] [data-testid="tab-row"][data-tab-id="${id}"]`,
      pinned: `[data-testid="pinned-list"] [data-testid="tab-row"][data-tab-id="${id}"]`,
      above: `[data-testid="today-list"] [data-testid="tab-row"][data-tab-id="${above}"]`,
    })
    await how()
    await expect.poll(async () => (await space(app)).today.includes(id)).toBe(false)
    const r = await rec.until(800)
    const height = motionOf(series(r, 'slot', (b) => b.height))
    const x = motionOf(series(r, 'row', (b) => b.x))
    const faded = r.frames.some((f) => (f.els.row?.opacity ?? 1) > 0.05 && (f.els.row?.opacity ?? 1) < 0.95)
    const ys = series(r, 'above', (b) => b.y)
      .map((p) => p.v)
      .filter((v) => !Number.isNaN(v))
    const scrolled = Math.max(...ys.map((v) => Math.abs(v - (ys[0] ?? v))))
    const flew = r.frames.filter((f) => {
      const b = f.els.pinned
      return !!b && b.opacity > 0.05 && b.y + b.height > band.top && b.y < band.bottom
    }).length
    note('FL-07', `${what}: the row slides left as it leaves`, x.travel, '≈ 12 px (FL-09)', 'px')
    note('FL-07', `${what}: its room, largest step share`, height.biggestStep * 100, '< 60 % (no jump)', '%')
    note('FL-07', `${what}: the row above, furthest from its place`, scrolled, '0 (no scroll)', 'px')
    expect(faded, `${what}: the row fades out where it was`).toBe(true)
    expect(x.travel, `${what}: the row slides left as it leaves`).toBeGreaterThanOrEqual(6)
    expect(height.travel, `${what}: its room closes`).toBeGreaterThan(30)
    expect(height.biggestStep, `${what}: its room closes with a spring`).toBeLessThan(FRAME_SLACK === 1 ? 0.6 : 0.95)
    expect(flew, `${what}: frames showing the row travelling through the list`).toBe(0)
    expect(scrolled, `${what}: the rows above stay put`).toBeLessThanOrEqual(0.5)
  }
  await leavesInPlace('⌘D, the pinned section out of sight', first, () => shell.keyboard.press(`${MOD}+D`))
  expect((await space(app)).pinned).toEqual([first])
  await leavesInPlace('moved to another Space', second, () =>
    cmd(app, 'tabs.moveToSpace', { ids: [second], spaceId: other, section: 'today' }),
  )
  expect((await state(app)).spaces[other]?.today).toEqual([second])
})

test('[FL-08] the × fades its circle in, presses to 0.9 at once, and its row starts leaving as soon as main closes the tab', async () => {
  const { shell } = orbit
  const ids = await blankTabs(5)
  /** One round: hover the row of `id`, then its ×, press and release it; the frames of all three. */
  const round = async (id: string) => {
    const close = `[data-testid="today-list"] [data-tab-id="${id}"] [data-testid="tab-close"]`
    // Over the row, away from the ×: the × shows, its circle not yet.
    const rowBox = await row(shell, id).boundingBox()
    if (!rowBox) throw new Error('no row')
    await shell.mouse.move(rowBox.x + 30, rowBox.y + rowBox.height / 2)
    await expect(shell.locator(close)).toHaveCSS('opacity', '1')
    await settled(shell)
    const box = await shell.locator(close).boundingBox()
    const glyphBox = await shell.locator(`${close} svg`).boundingBox()
    if (!box || !glyphBox) throw new Error('no ×')
    const rec = await record(shell, {
      close: { selector: close, style: ['background-color'] },
      glyph: `${close} svg`,
      row: `[data-testid="today-list"] [data-testid="tab-row"][data-tab-id="${id}"]`,
    })
    // A hover long enough for the circle to come in, and a press held a moment.
    await shell.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 2 })
    await shell.waitForTimeout(250)
    await shell.mouse.down()
    await shell.waitForTimeout(150)
    await shell.mouse.up()
    const r = await rec.until(1200)
    const over = r.inputs.find(
      (i) => i.type === 'pointermove' && (i.x ?? 0) >= box.x && (i.x ?? 0) <= box.x + box.width,
    )
    const down = r.inputs.find((i) => i.type === 'pointerdown')
    const up = r.inputs.find((i) => i.type === 'pointerup')
    if (!over || !down || !up) throw new Error('the pointer never reached the ×')
    // Hover: the circle fades in with the instant timing (about 90 ms), so some frames show it part-way.
    const circle = (f: (typeof r.frames)[number]) => alpha(f.els.close?.style?.['background-color'])
    const full = Math.max(...r.frames.filter((f) => f.i < down.frame).map(circle))
    const partWay = r.frames.filter(
      (f) => f.i >= over.frame && f.i < down.frame && circle(f) > 0.002 && circle(f) < full - 0.002,
    ).length
    const lit = responseTo(r, over, (f) => circle(f) >= full - 0.002)?.ms ?? Number.POSITIVE_INFINITY
    // Press: the glyph is drawn at about 0.9 in the first frame after the press.
    const scale = (f: (typeof r.frames)[number]) => (f.els.glyph?.width ?? glyphBox.width) / glyphBox.width
    const pressed = responseTo(r, down, (f) => scale(f) <= 0.92)?.frames ?? Number.POSITIVE_INFINITY
    const smallest = Math.min(...r.frames.map(scale))
    // Release: the click closes the tab in main, and the row's exit (FL-09: fade, slide left,
    // collapse) shows in the first frame after main's answer: one round trip, so the second frame.
    const x0 = r.frames[0]?.els.row?.x ?? 0
    const leaving =
      responseTo(r, up, (f) => !f.els.row || f.els.row.opacity < 0.99 || f.els.row.x < x0 - 0.5)?.frames ??
      Number.POSITIVE_INFINITY
    return { partWay, lit, pressed, smallest, leaving }
  }
  // A round that misses a budget is measured again on the next row (D46).
  let next = 1
  const { best, all } = await bestOf(
    () => round(ids[next++] as string),
    (m) => m.partWay >= 1 && m.lit <= (90 + 2 * FRAME) * FRAME_SLACK && m.pressed <= 1 && m.leaving <= 2 * FRAME_SLACK,
  )
  console.log(
    `[feel] FL-08 rounds: ${all.map((m) => `lit ${Math.round(m.lit)} ms, pressed ${m.pressed}, leaving ${m.leaving} frames`).join('; ')}`,
  )
  note('FL-08', 'hover → circle fully in', best.lit, '≈ 90 ms (instant timing)')
  note('FL-08', 'frames with the circle part-way in', best.partWay, '≥ 1 (a fade, not a switch)', 'frames')
  note('FL-08', 'press → glyph at 0.9', best.pressed, '1', 'frames')
  note('FL-08', 'smallest glyph scale', best.smallest, '≈ 0.9', '×')
  note('FL-08', 'release → row starts leaving', best.leaving, '2 (main closes it in between)', 'frames')
  expect(best.partWay, 'frames with the hover circle part-way in').toBeGreaterThanOrEqual(1)
  expect(best.lit).toBeLessThanOrEqual((90 + 2 * FRAME) * FRAME_SLACK)
  expect(best.pressed, 'frames from the press to the glyph at 0.9').toBeLessThanOrEqual(1)
  expect(best.smallest).toBeCloseTo(0.9, 2)
  expect(best.leaving, 'frames from the release to the exit').toBeLessThanOrEqual(2 * FRAME_SLACK)
})

/** Whether a slot is leaving (data-exiting) in frame `i`: the classes don't say, so look at the DOM's order. */
function isExiting(r: Recording, i: number, key: string): boolean {
  const f = r.frames[i]
  const prev = r.frames[i - 1]
  const h = f?.lists.slots?.[key]?.height ?? 0
  const before = prev?.lists.slots?.[key]?.height ?? h
  return h < before - 0.1 || (f?.lists.rows?.[key]?.opacity ?? 1) < 0.999
}

test('[FL-10][FL-29] dragging the fifth row up three slots: lift in a frame, 1:1 follow, gaps without flicker; Escape returns it within 300 ms', async () => {
  const { shell } = orbit
  const ids = await blankTabs(6)
  const fifth = ids[4] as string
  const start = await center(row(shell, fifth))
  const target = await center(row(shell, ids[1] as string))
  await shell.mouse.move(start.x, start.y)
  const rec = await record(
    shell,
    {
      ghost: { selector: '[data-testid="drag-ghost"]', style: ['transform'] },
      slots: { selector: '[data-testid="today-list"] > [data-slot]', key: 'data-key' },
    },
    { maxMs: 15_000 },
  )
  await shell.mouse.down()
  // Past the 4 px threshold, then slowly up, a few px a step.
  await shell.mouse.move(start.x, start.y - 2)
  await shell.mouse.move(start.x, start.y - 6)
  const travel = start.y - 6 - target.y
  const stepsUp = Math.ceil(travel / 3)
  for (let k = 1; k <= stepsUp; k++) await shell.mouse.move(start.x, start.y - 6 - (travel * k) / stepsUp)
  await shell.waitForTimeout(300)
  await shell.keyboard.press('Escape')
  await shell.waitForTimeout(700)
  const r = await rec.stop()
  await shell.mouse.up()
  const moves = r.inputs.filter((i) => i.type === 'pointermove')
  const cross = moves.find((m) => (m.y ?? 0) <= start.y - 4)
  if (!cross) throw new Error('the pointer never crossed the threshold')
  const lift = responseTo(r, cross, (f) => !!f.els.ghost && f.els.ghost.opacity > 0)
  // Follow: in the frame after each move, the ghost is where the pointer is, at the offset it was
  // grabbed at (1:1: one offset for the whole drag, so a frame behind the pointer stands out).
  const offsets: { t: number; d: number }[] = []
  for (const m of moves.filter((x) => x.t > cross.t)) {
    const f = r.frames[m.frame]
    const g = f?.els.ghost
    if (!g || !f) continue
    // A later move may already be in this frame: compare with the last move before it.
    const latest = moves.filter((x) => x.frame <= f.i).at(-1)
    offsets.push({ t: f.t, d: (latest?.y ?? 0) - (g.y + g.height / 2) })
  }
  const sorted = offsets.map((o) => o.d).sort((x, y) => x - y)
  const grab = sorted[Math.floor(sorted.length / 2)] ?? 0
  // The press was at the row's centre, so that is where the pointer holds it: 0 px off.
  const lagging = offsets
    .filter((o) => Math.abs(o.d - grab) > 1.5)
    .map((o) => `${Math.round(o.t)} ms: ${(o.d - grab).toFixed(1)} px off`)
  // Gaps: each neighbour moves one way only while the row goes up (no flicker back and forth).
  const flicker: string[] = []
  const esc = r.inputs.find((i) => i.type === 'keydown' && i.key === 'Escape')
  for (const id of ids.slice(1, 4)) {
    const ys = r.frames
      .filter((f) => !esc || f.i < esc.frame)
      .map((f) => f.lists.slots?.[id]?.y)
      .filter((v): v is number => v !== undefined)
    let dir = 0
    let turns = 0
    for (let k = 1; k < ys.length; k++) {
      const d = Math.sign(Math.round(((ys[k] as number) - (ys[k - 1] as number)) * 10))
      if (d !== 0 && dir !== 0 && d !== dir) turns++
      if (d !== 0) dir = d
    }
    if (turns > 0) flicker.push(`${id}: ${turns} turns`)
  }
  // Escape: the row is back in its slot (the ghost over it to within half a pixel, or gone) within 300 ms.
  const slotY = r.frames[0]?.lists.slots?.[fifth]?.y ?? 0
  const home = esc
    ? r.frames.find((f) => {
        if (f.i < esc.frame) return false
        const g = f.els.ghost
        return g ? Math.abs(g.y + g.height / 2 - (slotY + 16)) <= 0.5 : (f.lists.slots?.[fifth]?.opacity ?? 0) > 0
      })
    : undefined
  const returned = home && esc ? home.t - esc.t : Number.POSITIVE_INFINITY
  note('FL-10', 'threshold → lift visible', lift?.ms, '1 frame (16.7 ms)')
  note('FL-10', 'frames from the threshold to the lift', lift?.frames, '1', 'frames')
  note('FL-10', 'frames where the row lagged the pointer', lagging.length, '0', 'frames')
  note('FL-10', 'row centre to the pointer while held', Math.abs(grab), '0 (pressed at its centre)', 'px')
  note('FL-10', 'Escape → back in its slot', returned, '≤ 300 ms')
  note('FL-10', 'frame p99 while dragging', pacing(r).p99, `≤ ${FRAME.toFixed(1)} ms`)
  expect(lift?.frames ?? Number.POSITIVE_INFINITY, 'frames to the lift').toBeLessThanOrEqual(1)
  expect(lagging, 'frames where the dragged row was not under the pointer').toEqual([])
  expect(Math.abs(grab), 'the dragged row is held where it was pressed').toBeLessThanOrEqual(1.5)
  expect(flicker, 'gaps that flickered').toEqual([])
  expect(returned).toBeLessThanOrEqual(300 * FRAME_SLACK)
})

test('[FL-21][FL-05] a press in the first frame after a row finishes growing in selects it (PR #10 review F1)', async () => {
  const { app, shell } = orbit
  await blankTabs(3)
  // When a new row stops growing, the page tells main, which presses its middle at once, the way the
  // hardware does: the press reaches the page before its next frame.
  await app.evaluate(({ webContents }) => {
    const shellContents = webContents.getAllWebContents().find((w) => w.getURL().includes('view=shell'))
    if (!shellContents) throw new Error('no shell')
    const g = globalThis as unknown as { __feelPressOn?: boolean }
    if (g.__feelPressOn) return
    g.__feelPressOn = true
    shellContents.on('console-message', (e) => {
      const m = /^feel:grown (\d+) (\d+)$/.exec(e.message)
      if (!m) return
      const at = { x: Number(m[1]), y: Number(m[2]) }
      shellContents.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 })
      shellContents.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 })
    })
  })
  const hits: string[] = []
  for (let k = 0; k < 3; k++) {
    await shell.mouse.move(600, 860)
    const watched = shell.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const known = new Set([...document.querySelectorAll<HTMLElement>('.row-slot')].map((e) => e.dataset.key))
          const seen = new Set<string>()
          const obs = new MutationObserver(() => {
            for (const slot of document.querySelectorAll<HTMLElement>('.row-slot')) {
              const key = slot.dataset.key as string
              if (known.has(key)) continue
              if (slot.classList.contains('is-growing')) seen.add(key)
              else if (seen.has(key)) {
                obs.disconnect()
                const r = slot.getBoundingClientRect()
                const x = Math.round(r.x + r.width / 2)
                const y = Math.round(r.y + r.height / 2)
                const hit = document.elementFromPoint(x, y)
                console.log(`feel:grown ${x} ${y}`)
                resolve(`${key} ${hit?.closest('[data-testid="tab-row"]') ? 'row' : (hit?.className ?? 'nothing')}`)
                return
              }
            }
          })
          obs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true })
          setTimeout(() => resolve('timeout'), 5000)
        }),
    )
    await shell.waitForTimeout(50)
    const id = await newTab(app, `about:blank#late${k}`, { activate: false })
    const seen = await watched
    hits.push(seen)
    expect(seen.startsWith(id), `the new row grew in (${seen})`).toBe(true)
    await expect
      .poll(() => activeId(app), { timeout: 3000, message: `press ${k + 1} selected the row (${seen})` })
      .toBe(id)
    await settled(shell)
  }
  note(
    'FL-05',
    'presses right after a row grew in that reached it',
    hits.filter((h) => h.endsWith(' row')).length,
    '3 of 3',
    'presses',
  )
  expect(
    hits.every((h) => h.endsWith(' row')),
    `what a hit test found there: ${hits.join(', ')}`,
  ).toBe(true)
})
