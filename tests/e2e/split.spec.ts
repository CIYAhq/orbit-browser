import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import type { SplitLayout } from '../../src/shared/state'
import { bestOf } from './frames'
import {
  action,
  activeTabId,
  type Fixtures,
  FRAME_SLACK,
  launchOrbit,
  MOD,
  type Orbit,
  run,
  startFixtures,
  state,
  tabPage,
  tabView,
  viewPage,
} from './helpers'
import { settled } from './tabs-support'

let fx: Fixtures
let orbit: Orbit

// Several of these flows launch the app twice or drag across views; leave headroom for busy CI machines.
test.describe.configure({ timeout: 120_000 })

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

type Box = { x: number; y: number; width: number; height: number }
/** What the SV-26 test's in-page sampler records about a pane growing in. */
type GrowProbe = { insertedAt: number; ticks: number; samples: { t: number; w: number }[]; done: boolean }

async function openTab(app: ElectronApplication, name: string, bg?: string): Promise<string> {
  const url = fx.url(`/page/${name}${bg ? `?bg=${encodeURIComponent(bg)}` : ''}`)
  return (await run(app, 'tabs.create', { url })) as string
}

async function splitOf(app: ElectronApplication, tabId: string): Promise<{ id: string; layout: SplitLayout } | null> {
  const s = await state(app)
  for (const split of Object.values(s.splits)) {
    const leaves = JSON.stringify(split.layout)
    if (leaves.includes(`"${tabId}"`)) return { id: split.id, layout: split.layout }
  }
  return null
}

async function paneBox(shell: Page, tabId: string): Promise<Box> {
  const box = await shell.locator(`[data-testid="split-pane"][data-tab-id="${tabId}"]`).boundingBox()
  if (!box) throw new Error(`no pane for ${tabId}`)
  return box
}

const near = (a: Box | undefined | null, b: Box | undefined | null, tol = 1.5) =>
  !!a &&
  !!b &&
  Math.abs(a.x - b.x) <= tol &&
  Math.abs(a.y - b.y) <= tol &&
  Math.abs(a.width - b.width) <= tol &&
  Math.abs(a.height - b.height) <= tol

/** Every pane's native view sits over its pane card (waits for animations to settle). */
async function expectViewsOverPanes(o: Orbit, tabIds: string[]): Promise<void> {
  for (const tabId of tabIds) {
    await expect
      .poll(
        async () => {
          const view = await tabView(o.app, tabId)
          // A pane that has only just been added grows in from nothing (SV-26): no box yet, poll on.
          const pane = await paneBox(o.shell, tabId).catch(() => null)
          return view?.visible === true && near(view.bounds, pane)
        },
        { message: `view of ${tabId} over its pane` },
      )
      .toBe(true)
  }
}

test('[SV-01][SV-06][SV-11][SV-21] tabs become one split row with live side-by-side panes', async () => {
  // New tabs go to the top of Today, so open them in reverse: the sidebar then reads Alpha, Bravo, Charlie.
  const c = await openTab(orbit.app, 'Charlie')
  const b = await openTab(orbit.app, 'Bravo')
  const a = await openTab(orbit.app, 'Alpha')
  // Panes follow sidebar order, whatever order the selection lists them in (SV-06).
  const splitId = await run(orbit.app, 'split.create', { tabIds: [c, a, b] })
  expect(splitId).toMatch(/^v-/)
  const row = orbit.shell.getByTestId('split-row')
  await expect(row).toHaveCount(1)
  await expect(row.getByTestId('split-segment')).toHaveCount(3)
  await expect(orbit.shell.getByTestId('tab-row')).toHaveCount(0)
  await expect(row).toContainText('Alpha')
  await expect(row).toContainText('Charlie')
  await expect(orbit.shell.getByTestId('split-pane')).toHaveCount(3)
  await expectViewsOverPanes(orbit, [a, b, c])
  // Side by side, left to right, with 8 px gaps.
  const [pa, pb, pc] = [await paneBox(orbit.shell, a), await paneBox(orbit.shell, b), await paneBox(orbit.shell, c)]
  expect(pb.x - (pa.x + pa.width)).toBeCloseTo(8, 0)
  expect(pc.x).toBeGreaterThan(pb.x)
  expect(pa.y).toBeCloseTo(pb.y, 0)
  // Five tabs are refused (SV-25).
  const more = [await openTab(orbit.app, 'D'), await openTab(orbit.app, 'E'), await openTab(orbit.app, 'F')]
  expect(await run(orbit.app, 'split.create', { tabIds: [a, ...more, b] })).toBeNull()
  await expect(orbit.shell.getByTestId('toast')).toContainText('Split View holds up to 4 tabs')
})

test('[SV-13][SV-24] dragging a divider resizes the native views and the sizes persist', async () => {
  const b = await openTab(orbit.app, 'Right')
  const a = await openTab(orbit.app, 'Left')
  await run(orbit.app, 'split.create', { tabIds: [a, b] })
  await expectViewsOverPanes(orbit, [a, b])
  const before = (await tabView(orbit.app, a))?.bounds as Box
  const divider = await orbit.shell.getByTestId('split-divider').boundingBox()
  if (!divider) throw new Error('no divider')
  const x = divider.x + divider.width / 2
  const y = divider.y + divider.height / 2
  await orbit.shell.mouse.move(x, y)
  await orbit.shell.mouse.down()
  // 40 px: room the right pane has even in a small window (the macOS runner's is about 880 px wide,
  // so each pane starts near 310 px and stops at 240).
  for (let i = 1; i <= 10; i++) await orbit.shell.mouse.move(x + i * 4, y)
  // Mid-drag the views already follow the pointer, while the stored layout (and so every
  // state subscriber, e.g. the sidebar) is untouched until the drag ends. This waits 10 s, so a
  // miss is a stall, not a slow machine: it says whether the pane card stopped too, and whether the
  // divider still had the pointer (twice seen at load 30, part-way through the drag; not reproduced
  // in ten runs under heavy load).
  await expect
    .poll(async () => (await tabView(orbit.app, a))?.bounds.width)
    .toBeGreaterThan(before.width + 30)
    .catch(async (e: Error) => {
      const card = await paneBox(orbit.shell, a).catch(() => null)
      const held = await orbit.shell
        .getByTestId('split-divider')
        .evaluate((el) => el.hasPointerCapture(1))
        .catch(() => null)
      throw new Error(
        `${e.message}\nmid-drag: pane card ${card?.width ?? '?'} px wide; divider has the pointer: ${held}`,
      )
    })
  const midDrag = (await splitOf(orbit.app, a))?.layout
  expect(midDrag?.type === 'row' && midDrag.sizes).toEqual([0.5, 0.5])
  await orbit.shell.mouse.up()
  await expectViewsOverPanes(orbit, [a, b])
  const after = (await tabView(orbit.app, a))?.bounds as Box
  expect(after.width - before.width).toBeGreaterThan(30)
  await expect
    .poll(async () => {
      const layout = (await splitOf(orbit.app, a))?.layout
      return layout && layout.type !== 'leaf' ? (layout.sizes[0] ?? 0) : 0
    })
    .toBeGreaterThan(0.52)
  // The right pane stops at its minimum width.
  const d2 = await orbit.shell.getByTestId('split-divider').boundingBox()
  if (!d2) throw new Error('no divider')
  await orbit.shell.mouse.move(d2.x + 4, d2.y + d2.height / 2)
  await orbit.shell.mouse.down()
  await orbit.shell.mouse.move(d2.x + 2000, d2.y + d2.height / 2, { steps: 5 })
  await orbit.shell.mouse.up()
  // Polled down to the minimum first: the width before this drag already passes ">= 239", and a
  // one-off read right after it could still see that width (CI saw 365).
  await expect.poll(async () => (await tabView(orbit.app, b))?.bounds.width).toBeLessThanOrEqual(242)
  expect((await tabView(orbit.app, b))?.bounds.width).toBeGreaterThanOrEqual(239)
  // Double-click evens the panes out again.
  const d3 = await orbit.shell.getByTestId('split-divider').boundingBox()
  if (!d3) throw new Error('no divider')
  await orbit.shell.mouse.dblclick(d3.x + 4, d3.y + d3.height / 2)
  await expect
    .poll(async () => {
      const [va, vb] = [await tabView(orbit.app, a), await tabView(orbit.app, b)]
      return Math.abs((va?.bounds.width ?? 0) - (vb?.bounds.width ?? 0))
    })
    .toBeLessThanOrEqual(1)
})

test('[SV-17][SV-18][SV-19] close one pane, separate a split and close a whole split', async () => {
  const a = await openTab(orbit.app, 'One')
  const b = await openTab(orbit.app, 'Two')
  const c = await openTab(orbit.app, 'Three')
  await run(orbit.app, 'split.create', { tabIds: [a, b] })
  await expectViewsOverPanes(orbit, [a, b])
  // Close the right pane: the left page fills the frame and the row becomes an ordinary tab.
  await run(orbit.app, 'split.closePane', { tabId: b })
  await expect(orbit.shell.getByTestId('split-row')).toHaveCount(0)
  await expect(orbit.shell.getByTestId('tab-row')).toHaveCount(2)
  const frame = await orbit.shell.getByTestId('content-frame').boundingBox()
  await expect.poll(async () => near((await tabView(orbit.app, a))?.bounds, frame)).toBe(true)
  expect(await activeTabId(orbit.app)).toBe(a)
  expect((await state(orbit.app)).tabs[b]).toBeUndefined()
  // Separate: every pane becomes a tab again, nothing closes.
  await run(orbit.app, 'split.create', { tabIds: [a, c] })
  await expect(orbit.shell.getByTestId('split-row')).toHaveCount(1)
  const splitId = (await splitOf(orbit.app, a))?.id as string
  await run(orbit.app, 'split.separate', { splitId })
  await expect(orbit.shell.getByTestId('split-row')).toHaveCount(0)
  await expect(orbit.shell.getByTestId('tab-row')).toHaveCount(2)
  // Close the whole split from its row's ×.
  await run(orbit.app, 'split.create', { tabIds: [a, c] })
  const row = orbit.shell.getByTestId('split-row')
  await row.hover()
  await row.getByTestId('split-close').click()
  await expect(orbit.shell.getByTestId('split-row')).toHaveCount(0)
  const s = await state(orbit.app)
  expect(s.tabs[a]).toBeUndefined()
  expect(s.tabs[c]).toBeUndefined()
})

test('[SV-02][SV-15] the shortcut adds a pane that the command bar fills; Escape removes it', async () => {
  const a = await openTab(orbit.app, 'Base')
  await expect.poll(async () => (await tabView(orbit.app, a))?.visible).toBe(true)
  await orbit.shell.keyboard.press('Control+Shift+Equal')
  const overlay = await viewPage(orbit.app, 'overlay')
  const input = overlay.getByTestId('command-input')
  await expect(input).toBeFocused()
  await expect(orbit.shell.getByTestId('split-pane')).toHaveCount(2)
  await input.fill(fx.url('/page/Added'))
  await input.press('Enter')
  await expect(orbit.shell.getByTestId('split-row').getByTestId('split-segment')).toHaveCount(2)
  await expect(orbit.shell.getByTestId('split-row')).toContainText('Added')
  const split = await splitOf(orbit.app, a)
  const added = split
    ? JSON.stringify(split.layout)
        .match(/t-[a-z0-9]+/g)
        ?.find((id) => id !== a)
    : undefined
  expect(added).toBeTruthy()
  await expectViewsOverPanes(orbit, [a, added as string])
  const [pa, pb] = [await paneBox(orbit.shell, a), await paneBox(orbit.shell, added as string)]
  expect(pb.x).toBeGreaterThan(pa.x + pa.width)
  expect(await activeTabId(orbit.app)).toBe(added)
  // Shortcut again, then Escape: the empty pane goes away and focus returns.
  await orbit.shell.keyboard.press('Control+Shift+Equal')
  await expect(input).toBeFocused()
  await expect(orbit.shell.getByTestId('split-pane')).toHaveCount(3)
  await input.press('Escape')
  await expect(orbit.shell.getByTestId('split-pane')).toHaveCount(2)
  expect(await activeTabId(orbit.app)).toBe(added)
  // ⌘L/Ctrl+L on the focused pane changes only that pane (SV-15).
  await action(orbit.app, 'url.edit')
  await expect(input).toBeFocused()
  await input.fill(fx.url('/page/Changed'))
  await input.press('Enter')
  await expect(orbit.shell.getByTestId('split-row')).toContainText('Changed')
  await expect(orbit.shell.getByTestId('split-row')).toContainText('Base')
})

test('[SV-03][SV-11] Add Split Below from the command bar stacks a pane; flip turns it side by side', async () => {
  const a = await openTab(orbit.app, 'Top')
  await expect.poll(async () => (await tabView(orbit.app, a))?.visible).toBe(true)
  await orbit.shell.keyboard.press(`${MOD}+T`)
  const overlay = await viewPage(orbit.app, 'overlay')
  const input = overlay.getByTestId('command-input')
  await input.fill('split below')
  await expect(overlay.getByTestId('command-result').first()).toContainText('Add Split Below')
  await input.press('Enter')
  // The command bar stays open for the new pane.
  await expect(overlay.getByTestId('command-bar')).toHaveAttribute('data-mode', 'edit-url')
  await expect(input).toBeFocused()
  await input.fill(fx.url('/page/Bottom'))
  await input.press('Enter')
  await expect(orbit.shell.getByTestId('split-row')).toContainText('Bottom')
  const split = await splitOf(orbit.app, a)
  expect(split?.layout.type).toBe('column')
  const bottom = JSON.stringify(split?.layout)
    .match(/t-[a-z0-9]+/g)
    ?.find((id) => id !== a) as string
  // Panes move to their new places over a few frames (slow ones on the macOS runner): poll for
  // the arrangement, then check the native views over it.
  await expect
    .poll(async () => (await paneBox(orbit.shell, bottom)).y - (await paneBox(orbit.shell, a)).y)
    .toBeGreaterThan(100)
  await expectViewsOverPanes(orbit, [a, bottom])
  await action(orbit.app, 'split.flip')
  await expect.poll(async () => (await splitOf(orbit.app, a))?.layout.type).toBe('row')
  await expect
    .poll(async () => (await paneBox(orbit.shell, bottom)).x - (await paneBox(orbit.shell, a)).x)
    .toBeGreaterThan(100)
  await expectViewsOverPanes(orbit, [a, bottom])
})

test('[SV-04][SV-25] dragging a tab row onto the page makes a split; a full split refuses', async () => {
  const b = await openTab(orbit.app, 'Dragged')
  const a = await openTab(orbit.app, 'Shown')
  await expect.poll(async () => (await tabView(orbit.app, a))?.visible).toBe(true)
  await settled(orbit.shell)
  const row = orbit.shell.locator(`[data-testid="tab-row"][data-tab-id="${b}"]`)
  const from = await row.boundingBox()
  const frame = await orbit.shell.getByTestId('content-frame').boundingBox()
  if (!from || !frame) throw new Error('missing boxes')
  await orbit.shell.mouse.move(from.x + 40, from.y + from.height / 2)
  await orbit.shell.mouse.down()
  await orbit.shell.mouse.move(from.x + 60, from.y + from.height / 2, { steps: 3 })
  await orbit.shell.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2, { steps: 8 })
  await orbit.shell.mouse.move(frame.x + frame.width / 2 + 10, frame.y + frame.height / 2, { steps: 2 })
  const indicator = orbit.shell.getByTestId('split-drop-indicator')
  await expect(indicator).toBeVisible()
  await expect(indicator).toHaveAttribute('data-side', 'right')
  // The shown page already makes room for the drop.
  await expect.poll(async () => (await tabView(orbit.app, a))?.bounds.width).toBeLessThan(frame.width * 0.6)
  await orbit.shell.mouse.up()
  await expect(orbit.shell.getByTestId('split-row')).toHaveCount(1)
  const split = await splitOf(orbit.app, a)
  expect(JSON.stringify(split?.layout)).toBe(
    JSON.stringify({
      type: 'row',
      children: [
        { type: 'leaf', tabId: a },
        { type: 'leaf', tabId: b },
      ],
      sizes: [0.5, 0.5],
    }),
  )
  await expectViewsOverPanes(orbit, [a, b])
})

async function stripInfo(app: ElectronApplication) {
  return app.evaluate(() => {
    const g = globalThis as unknown as {
      __orbitSplit: { strip: { info: (w: string) => { tabId: string | null; visible: boolean; bounds?: Box } } }
      __orbit: { windowIds: () => string[] }
    }
    return g.__orbitSplit.strip.info(g.__orbit.windowIds()[0] as string)
  })
}

test('[SV-12][SV-14] hovering a pane top shows its strip; clicking a pane focuses it', async () => {
  const b = await openTab(orbit.app, 'Second')
  const a = await openTab(orbit.app, 'First')
  await run(orbit.app, 'split.create', { tabIds: [a, b] })
  await expectViewsOverPanes(orbit, [a, b])
  // Clicking into the left page focuses that pane: outline, address and commands follow it.
  const first = await tabPage(orbit.app, '/page/First')
  await first.mouse.click(200, 300)
  await expect.poll(() => activeTabId(orbit.app)).toBe(a)
  await expect(orbit.shell.locator(`[data-testid="split-pane"][data-tab-id="${a}"]`)).toHaveAttribute(
    'data-focused',
    'true',
  )
  const ring = await orbit.shell.getByTestId('split-focus-ring').boundingBox()
  const pa = await paneBox(orbit.shell, a)
  expect(near(ring, { x: pa.x - 2, y: pa.y - 2, width: pa.width + 4, height: pa.height + 4 })).toBe(true)
  // Hover near the top edge of the right page: the strip appears centred over that pane only.
  const second = await tabPage(orbit.app, '/page/Second')
  await second.mouse.move(150, 120)
  await second.mouse.move(160, 10)
  await expect.poll(async () => (await stripInfo(orbit.app)).visible).toBe(true)
  const info = await stripInfo(orbit.app)
  expect(info.tabId).toBe(b)
  const pb = await paneBox(orbit.shell, b)
  const bounds = info.bounds as Box
  expect(Math.abs(bounds.x + bounds.width / 2 - (pb.x + pb.width / 2))).toBeLessThanOrEqual(1)
  expect(bounds.y).toBeGreaterThanOrEqual(pb.y)
  expect(bounds.y).toBeLessThan(pb.y + 20)
  // Its buttons are there on the very first show.
  const stripPage = await viewPage(orbit.app, 'strip' as 'overlay')
  await expect(stripPage.getByTestId('pane-strip-close')).toBeVisible()
  await expect(stripPage.getByTestId('pane-strip-menu')).toBeVisible()
  // Moving down into the page hides it again.
  await second.mouse.move(160, 300)
  await expect.poll(async () => (await stripInfo(orbit.app)).visible).toBe(false)
  // The strip's × closes that pane.
  await second.mouse.move(160, 8)
  await expect.poll(async () => (await stripInfo(orbit.app)).visible).toBe(true)
  const strip = await viewPage(orbit.app, 'strip' as 'overlay')
  await strip.getByTestId('pane-strip-close').click()
  await expect(orbit.shell.getByTestId('split-row')).toHaveCount(0)
  expect((await state(orbit.app)).tabs[b]).toBeUndefined()
})

test('[SV-16][SV-14] keyboard focus moves between panes and Ctrl+Shift+- closes the focused one', async () => {
  const c = await openTab(orbit.app, 'Three')
  const b = await openTab(orbit.app, 'Two')
  const a = await openTab(orbit.app, 'One')
  await run(orbit.app, 'split.create', { tabIds: [a, b, c], focus: a })
  await expectViewsOverPanes(orbit, [a, b, c])
  await orbit.shell.keyboard.press('Control+Shift+Digit3')
  await expect.poll(() => activeTabId(orbit.app)).toBe(c)
  await orbit.shell.keyboard.press('Control+Shift+BracketRight')
  await expect.poll(() => activeTabId(orbit.app)).toBe(a)
  await orbit.shell.keyboard.press('Control+Shift+BracketLeft')
  await expect.poll(() => activeTabId(orbit.app)).toBe(c)
  await expect(orbit.shell.getByTestId('address-pill')).toContainText('localhost')
  await orbit.shell.keyboard.press('Control+Shift+Minus')
  await expect(orbit.shell.getByTestId('split-row').getByTestId('split-segment')).toHaveCount(2)
  expect((await state(orbit.app)).tabs[c]).toBeUndefined()
  await expect.poll(() => activeTabId(orbit.app)).not.toBe(c)
  await expectViewsOverPanes(orbit, [a, b])
})

test('[SV-24] a resized three-pane split comes back after relaunch', async () => {
  const c = await openTab(orbit.app, 'P3')
  const b = await openTab(orbit.app, 'P2')
  const a = await openTab(orbit.app, 'P1')
  const splitId = (await run(orbit.app, 'split.create', { tabIds: [a, b, c], focus: b })) as string
  await run(orbit.app, 'split.resize', { splitId, path: [], sizes: [0.5, 0.25, 0.25] })
  await expectViewsOverPanes(orbit, [a, b, c])
  await orbit.app.evaluate(() => (globalThis as unknown as { __orbit: { flush: () => void } }).__orbit.flush())
  const userData = orbit.userData
  await orbit.app.close()
  orbit = await launchOrbit({ userData })
  const row = orbit.shell.getByTestId('split-row')
  await expect(row.getByTestId('split-segment')).toHaveCount(3)
  const s = await state(orbit.app)
  const layout = s.splits[splitId]?.layout
  expect(JSON.stringify(layout)).toContain('"sizes":[0.5,0.25,0.25]')
  expect(await activeTabId(orbit.app)).toBe(b)
  await expectViewsOverPanes(orbit, [a, b, c])
  const [pa, pb] = [await paneBox(orbit.shell, a), await paneBox(orbit.shell, b)]
  expect(pa.width / pb.width).toBeCloseTo(2, 1)
})

test('[SV-17] ⌘W / Ctrl+W closes only the focused pane and keeps the others’ arrangement', async () => {
  const c = await openTab(orbit.app, 'Cee')
  const a = await openTab(orbit.app, 'Ay')
  const splitId = (await run(orbit.app, 'split.create', { tabIds: [a, c] })) as string
  const b = await openTab(orbit.app, 'Bee')
  await run(orbit.app, 'split.addTab', { tabId: b, target: a, side: 'bottom' })
  const d = await openTab(orbit.app, 'Dee')
  await run(orbit.app, 'split.addTab', { tabId: d, target: c, side: 'bottom' })
  await run(orbit.app, 'split.resize', { splitId, path: [], sizes: [0.6, 0.4] })
  await expectViewsOverPanes(orbit, [a, b, c, d])
  expect(await activeTabId(orbit.app)).toBe(d)
  await orbit.shell.keyboard.press(`${MOD}+W`)
  await expect(orbit.shell.getByTestId('split-row').getByTestId('split-segment')).toHaveCount(3)
  // Focus stays in the split (on one of the remaining panes).
  expect([a, b, c]).toContain(await activeTabId(orbit.app))
  const layout = (await state(orbit.app)).splits[splitId]?.layout
  expect(layout).toEqual({
    type: 'row',
    sizes: [0.6, 0.4],
    children: [
      {
        type: 'column',
        sizes: [0.5, 0.5],
        children: [
          { type: 'leaf', tabId: a },
          { type: 'leaf', tabId: b },
        ],
      },
      { type: 'leaf', tabId: c },
    ],
  })
  await expectViewsOverPanes(orbit, [a, b, c])
})

test('[SV-09][SV-18] Alt-click a tab row joins it as a split; Alt-click the split row separates it', async () => {
  const b = await openTab(orbit.app, 'Joiner')
  const a = await openTab(orbit.app, 'Current')
  await orbit.shell.locator(`[data-testid="tab-row"][data-tab-id="${b}"]`).click({ modifiers: ['Alt'] })
  await expect(orbit.shell.getByTestId('split-row')).toHaveCount(1)
  const split = await splitOf(orbit.app, a)
  expect(
    split?.layout.type === 'row' && split.layout.children.map((ch) => (ch.type === 'leaf' ? ch.tabId : '')),
  ).toEqual([a, b])
  await expect.poll(() => activeTabId(orbit.app)).toBe(b)
  await expectViewsOverPanes(orbit, [a, b])
  await orbit.shell.getByTestId('split-row').click({ modifiers: ['Alt'] })
  await expect(orbit.shell.getByTestId('split-row')).toHaveCount(0)
  await expect(orbit.shell.getByTestId('tab-row')).toHaveCount(2)
})

test('[SV-22][SV-23] a split duplicates, pins and moves as one unit', async () => {
  const b = await openTab(orbit.app, 'Unit2')
  const a = await openTab(orbit.app, 'Unit1')
  const splitId = (await run(orbit.app, 'split.create', { tabIds: [a, b] })) as string
  const copy = (await run(orbit.app, 'split.duplicate', { splitId })) as string
  await expect(orbit.shell.getByTestId('split-row')).toHaveCount(2)
  const s1 = await state(orbit.app)
  const copyLeaves = JSON.stringify(s1.splits[copy]?.layout).match(/t-[a-z0-9]+/g) ?? []
  expect(copyLeaves.map((id) => s1.tabs[id]?.url)).toEqual([s1.tabs[a]?.url, s1.tabs[b]?.url])
  const spaceId = s1.tabs[a]?.spaceId as string
  expect(await run(orbit.app, 'split.move', { splitId, to: { kind: 'pinned', spaceId } })).toBe(true)
  await expect(orbit.shell.getByTestId('pinned-list').getByTestId('split-row')).toHaveCount(1)
  const s2 = await state(orbit.app)
  expect(s2.tabs[a]?.pinnedUrl).toBe(s2.tabs[a]?.url)
  expect(s2.tabs[b]?.pinnedUrl).toBe(s2.tabs[b]?.url)
  // A tab dropped onto a pinned tab makes a split that stays pinned.
  const loose = await openTab(orbit.app, 'Loose')
  const pinnedTab = await openTab(orbit.app, 'PinnedOne')
  await run(orbit.app, 'tabs.pin', { tabId: pinnedTab })
  await run(orbit.app, 'split.addTab', { tabId: loose, target: pinnedTab, side: 'right' })
  await expect(orbit.shell.getByTestId('pinned-list').getByTestId('split-row')).toHaveCount(2)
})

test('[SV-17][SV-19] reopening closed panes puts them back into their split', async () => {
  const b = await openTab(orbit.app, 'Keep')
  const a = await openTab(orbit.app, 'Gone')
  const c = await openTab(orbit.app, 'Below')
  await run(orbit.app, 'split.create', { tabIds: [a, b] })
  await run(orbit.app, 'split.addTab', { tabId: c, target: b, side: 'bottom' })
  await expectViewsOverPanes(orbit, [a, b, c])
  const splitId = (await splitOf(orbit.app, a))?.id as string
  const before = (await state(orbit.app)).splits[splitId]?.layout
  // Close one pane, then reopen it: same split, same place.
  await run(orbit.app, 'split.closePane', { tabId: c })
  await expect(orbit.shell.getByTestId('split-segment')).toHaveCount(2)
  await action(orbit.app, 'tab.reopenClosed')
  await expect(orbit.shell.getByTestId('split-segment')).toHaveCount(3)
  expect((await state(orbit.app)).splits[splitId]?.layout).toEqual(before)
  await expectViewsOverPanes(orbit, [a, b, c])
  // Close the whole split, then reopen its tabs: the split comes back together.
  await run(orbit.app, 'split.close', { splitId })
  await expect(orbit.shell.getByTestId('split-row')).toHaveCount(0)
  // One reopen brings the whole split back as it was (SV-19).
  await action(orbit.app, 'tab.reopenClosed')
  await expect(orbit.shell.getByTestId('split-row').getByTestId('split-segment')).toHaveCount(3)
  expect((await state(orbit.app)).splits[splitId]?.layout).toEqual(before)
  const back = await splitOf(orbit.app, a)
  expect(back && JSON.stringify(back.layout).match(/t-[a-z0-9]+/g)).toEqual([a, b, c])
})

test('[SV-02][SV-15] choosing an open tab for a pane moves it into the split', async () => {
  const other = await openTab(orbit.app, 'Elsewhere')
  const a = await openTab(orbit.app, 'Anchor')
  await expect.poll(async () => (await tabView(orbit.app, a))?.visible).toBe(true)
  await action(orbit.app, 'split.add')
  const overlay = await viewPage(orbit.app, 'overlay')
  const input = overlay.getByTestId('command-input')
  await expect(input).toBeFocused()
  await input.fill('Elsewhere')
  await expect(overlay.locator('[data-testid="command-result"][data-kind="tab"]').first()).toBeVisible()
  await overlay.locator('[data-testid="command-result"][data-kind="tab"]').first().click()
  await expect(orbit.shell.getByTestId('split-row').getByTestId('split-segment')).toHaveCount(2)
  await expect(orbit.shell.getByTestId('tab-row')).toHaveCount(0)
  const split = await splitOf(orbit.app, a)
  expect(split && JSON.stringify(split.layout).match(/t-[a-z0-9]+/g)).toEqual([a, other])
  expect(await activeTabId(orbit.app)).toBe(other)
  expect(Object.keys((await state(orbit.app)).tabs)).toHaveLength(2)
  await expectViewsOverPanes(orbit, [a, other])
})

test('[SV-25][SV-04] a tab dropped on a full split is refused with a toast', async () => {
  const ids = [await openTab(orbit.app, 'Q4'), await openTab(orbit.app, 'Q3'), await openTab(orbit.app, 'Q2')]
  const first = await openTab(orbit.app, 'Q1')
  const extra = await openTab(orbit.app, 'Extra')
  await run(orbit.app, 'split.create', { tabIds: [first, ...ids], focus: first })
  await expectViewsOverPanes(orbit, [first, ...ids])
  // Shortcut on a full split: nothing is added.
  await orbit.shell.keyboard.press('Control+Shift+Equal')
  await expect(orbit.shell.getByTestId('toast')).toContainText('Split View holds up to 4 tabs')
  await expect(orbit.shell.getByTestId('split-pane')).toHaveCount(4)
  const row = await orbit.shell.locator(`[data-testid="tab-row"][data-tab-id="${extra}"]`).boundingBox()
  const pane = await paneBox(orbit.shell, first)
  if (!row) throw new Error('no row')
  await orbit.shell.mouse.move(row.x + 40, row.y + row.height / 2)
  await orbit.shell.mouse.down()
  await orbit.shell.mouse.move(row.x + 70, row.y + row.height / 2, { steps: 3 })
  await orbit.shell.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2, { steps: 6 })
  await orbit.shell.mouse.move(pane.x + pane.width / 2 + 5, pane.y + pane.height / 2, { steps: 2 })
  await expect(orbit.shell.getByTestId('split-drop-indicator')).toHaveCount(0)
  await orbit.shell.mouse.up()
  await expect(orbit.shell.getByTestId('split-pane')).toHaveCount(4)
  await expect(orbit.shell.locator(`[data-testid="tab-row"][data-tab-id="${extra}"]`)).toHaveCount(1)
})

test('[SV-25][SV-05] a full split row shows no drop target: a tab resting on it gets no half to take', async () => {
  const extra = await openTab(orbit.app, 'Extra')
  const ids = [await openTab(orbit.app, 'Q4'), await openTab(orbit.app, 'Q3'), await openTab(orbit.app, 'Q2')]
  const first = await openTab(orbit.app, 'Q1')
  const splitId = (await run(orbit.app, 'split.create', { tabIds: [first, ...ids], focus: first })) as string
  await expect(orbit.shell.getByTestId('split-row')).toHaveCount(1)
  await settled(orbit.shell)
  const a = await orbit.shell.locator(`[data-testid="tab-row"][data-tab-id="${extra}"]`).boundingBox()
  const to = await orbit.shell.getByTestId('split-row').boundingBox()
  if (!a || !to) throw new Error('rows')
  await orbit.shell.mouse.move(a.x + 30, a.y + a.height / 2)
  await orbit.shell.mouse.down()
  await orbit.shell.mouse.move(a.x + 40, a.y + a.height / 2 - 6, { steps: 2 })
  await orbit.shell.mouse.move(to.x + to.width * 0.75, to.y + to.height * 0.5, { steps: 10 })
  // The drag is live, so the check below can't pass because no drag started (PR #10 review F7).
  await expect(orbit.shell.locator('html')).toHaveClass(/\bis-dragging-tab\b/)
  // Well past the rest that makes a split on a row with room (400 ms).
  await orbit.shell.waitForTimeout(900)
  // Still live at the count, so a drag that ended during the wait can't pass it (PR #19 review F9).
  expect(await orbit.shell.locator('html').getAttribute('class')).toMatch(/\bis-dragging-tab\b/)
  expect(await orbit.shell.locator('.row-slot.is-split-target').count()).toBe(0)
  await orbit.shell.mouse.up()
  await settled(orbit.shell)
  // Nothing joins the split: the tab is still its own row (the press selected it, so the page shows it).
  const layout = JSON.stringify((await state(orbit.app)).splits[splitId]?.layout)
  for (const id of [first, ...ids]) expect(layout).toContain(id)
  expect(layout).not.toContain(extra)
  await expect(orbit.shell.locator(`[data-testid="tab-row"][data-tab-id="${extra}"]`)).toHaveCount(1)
})

test('[SV-22][SV-21] a split can be named; the name replaces the pane titles', async () => {
  const b = await openTab(orbit.app, 'Docs')
  const a = await openTab(orbit.app, 'Mail')
  const splitId = (await run(orbit.app, 'split.create', { tabIds: [a, b] })) as string
  const row = orbit.shell.getByTestId('split-row')
  await expect(row.getByTestId('split-segment')).toHaveCount(2)
  await row.dblclick()
  const field = row.getByTestId('split-rename')
  await expect(field).toBeFocused()
  await field.fill('Morning')
  await field.press('Enter')
  await expect(row.getByTestId('split-name')).toHaveText('Morning')
  await expect(row.getByTestId('split-segment')).toHaveCount(0)
  expect((await state(orbit.app)).splits[splitId]?.name).toBe('Morning')
  // Escape cancels an edit; clearing the name shows the pane titles again.
  await row.dblclick()
  await row.getByTestId('split-rename').fill('Nope')
  await row.getByTestId('split-rename').press('Escape')
  await expect(row.getByTestId('split-name')).toHaveText('Morning')
  await run(orbit.app, 'split.rename', { splitId, name: null })
  await expect(row.getByTestId('split-segment')).toHaveCount(2)
})

test('[SV-14][SV-15] the split row returns to the last focused pane; ⌘L / Ctrl+L can swap an open tab into a pane', async () => {
  const other = await openTab(orbit.app, 'Outside')
  const b = await openTab(orbit.app, 'Right pane')
  const a = await openTab(orbit.app, 'Left pane')
  await run(orbit.app, 'split.create', { tabIds: [a, b], focus: b })
  await expectViewsOverPanes(orbit, [a, b])
  // Leave the split, then click the row's edge (not a segment): the right pane is focused again.
  await run(orbit.app, 'tabs.activate', { tabId: other })
  await expect.poll(async () => (await tabView(orbit.app, b))?.visible).toBe(false)
  // A locator click waits for the row to stand still and checks that the row takes the click: on a slow
  // machine the rows from split.create can still be moving in.
  const row = orbit.shell.getByTestId('split-row')
  const box = await row.boundingBox()
  if (!box) throw new Error('no row')
  await row.click({ position: { x: 3, y: box.height / 2 } })
  await expect.poll(() => activeTabId(orbit.app)).toBe(b)
  await expectViewsOverPanes(orbit, [a, b])
  // ⌘L / Ctrl+L on the focused pane and pick the open tab: it takes the pane's place, the old page goes to Today.
  await orbit.shell.keyboard.press(`${MOD}+L`)
  const overlay = await viewPage(orbit.app, 'overlay')
  const input = overlay.getByTestId('command-input')
  await expect(input).toBeFocused()
  await input.fill('Outside')
  const result = overlay.locator('[data-testid="command-result"][data-kind="tab"]').first()
  await expect(result).toContainText('Outside')
  await result.click()
  await expect(orbit.shell.getByTestId('split-row')).toContainText('Outside')
  await expect(orbit.shell.getByTestId('split-row')).not.toContainText('Right pane')
  await expect(orbit.shell.locator(`[data-testid="tab-row"][data-tab-id="${b}"]`)).toHaveCount(1)
  expect(await activeTabId(orbit.app)).toBe(other)
  await expectViewsOverPanes(orbit, [a, other])
})

async function showStrip(app: ElectronApplication, tabId: string): Promise<Box> {
  await app.evaluate((_e, id) => {
    const g = globalThis as unknown as {
      __orbitSplit: { strip: { show: (w: string, t: string) => void } }
      __orbit: { windowIds: () => string[] }
    }
    g.__orbitSplit.strip.show(g.__orbit.windowIds()[0] as string, id)
  }, tabId)
  await expect.poll(async () => (await stripInfo(app)).visible).toBe(true)
  return (await stripInfo(app)).bounds as Box
}

/** Drags a pane by its strip grip to a point in window coordinates. */
async function dragPaneTo(o: Orbit, tabId: string, to: { x: number; y: number }, check?: () => Promise<void>) {
  const bounds = await showStrip(o.app, tabId)
  const strip = await viewPage(o.app, 'strip' as 'overlay')
  // The strip takes clicks again once it has re-rendered out of a previous fade-out.
  await expect(strip.locator('[data-testid="pane-strip"]:not(.is-leaving)')).toBeVisible()
  const grip = await strip.getByTestId('pane-strip-grip').boundingBox()
  if (!grip) throw new Error('no grip')
  const sx = grip.x + grip.width / 2
  const sy = grip.y + grip.height / 2
  await strip.mouse.move(sx, sy)
  await strip.mouse.down()
  const tx = to.x - bounds.x
  const ty = to.y - bounds.y
  for (let i = 1; i <= 8; i++) await strip.mouse.move(sx + ((tx - sx) * i) / 8, sy + ((ty - sy) * i) / 8)
  if (check) await check()
  await strip.mouse.up()
}

test('[SV-20][SV-12] dragging a pane by its strip swaps or moves it', async () => {
  const b = await openTab(orbit.app, 'Bpane')
  const a = await openTab(orbit.app, 'Apane')
  const splitId = (await run(orbit.app, 'split.create', { tabIds: [a, b] })) as string
  await expectViewsOverPanes(orbit, [a, b])
  const pa = await paneBox(orbit.shell, a)
  // Onto the centre of the other pane: the two trade places (previewed live while dragging).
  await dragPaneTo(orbit, b, { x: pa.x + pa.width / 2, y: pa.y + pa.height / 2 }, async () => {
    await expect
      .poll(async () => ((await tabView(orbit.app, b))?.bounds.x ?? 0) < ((await tabView(orbit.app, a))?.bounds.x ?? 0))
      .toBe(true)
  })
  await expect
    .poll(async () => JSON.stringify((await state(orbit.app)).splits[splitId]?.layout))
    .toContain(`"tabId":"${b}"},{"type":"leaf","tabId":"${a}"`)
  await expectViewsOverPanes(orbit, [a, b])
  // A third pane dragged onto the top edge of another pane moves above it.
  const c = await openTab(orbit.app, 'Cpane')
  await run(orbit.app, 'split.addTab', { tabId: c, target: a, side: 'right' })
  await expectViewsOverPanes(orbit, [a, b, c])
  const pb = await paneBox(orbit.shell, b)
  await dragPaneTo(orbit, c, { x: pb.x + pb.width / 2, y: pb.y + 40 })
  await expect
    .poll(async () => {
      const layout = (await state(orbit.app)).splits[splitId]?.layout
      return JSON.stringify(layout)
    })
    .toContain(`{"type":"column","children":[{"type":"leaf","tabId":"${c}"},{"type":"leaf","tabId":"${b}"}]`)
  await expectViewsOverPanes(orbit, [a, b, c])
})

test('[SV-25] a page going full screen in a pane fills the window and comes back to the split', async () => {
  const b = await openTab(orbit.app, 'Video')
  const a = await openTab(orbit.app, 'Notes')
  await run(orbit.app, 'split.create', { tabIds: [a, b] })
  await expectViewsOverPanes(orbit, [a, b])
  const video = await tabPage(orbit.app, '/page/Video')
  await video.evaluate(() => {
    const button = document.createElement('button')
    button.id = 'fs'
    button.textContent = 'Full screen'
    button.onclick = () => void document.documentElement.requestFullscreen()
    document.body.prepend(button)
  })
  await video.click('#fs')
  // In one look: the page covers the whole window and the other pane is hidden.
  await expect
    .poll(async () => {
      const v = await tabView(orbit.app, b)
      const other = await tabView(orbit.app, a)
      const w = await orbit.shell.evaluate(() => window.innerWidth)
      return v?.bounds.x === 0 && v.bounds.y === 0 && v.bounds.width === w && other?.visible === false
    })
    .toBe(true)
  // No pane strip over a full-screen page (review F3).
  await orbit.app.evaluate((_e, id) => {
    const g = globalThis as unknown as {
      __orbitSplit: { strip: { show: (w: string, t: string) => void } }
      __orbit: { windowIds: () => string[] }
    }
    g.__orbitSplit.strip.show(g.__orbit.windowIds()[0] as string, id)
  }, b)
  expect((await stripInfo(orbit.app)).visible).toBe(false)
  await video.evaluate(() => document.exitFullscreen())
  await expectViewsOverPanes(orbit, [a, b])
  await expect(orbit.shell.getByTestId('split-pane')).toHaveCount(2)
})

test('[SV-13] resizing the window keeps each pane’s proportion', async () => {
  const b = await openTab(orbit.app, 'Narrow')
  const a = await openTab(orbit.app, 'Wide')
  const splitId = (await run(orbit.app, 'split.create', { tabIds: [a, b] })) as string
  await run(orbit.app, 'split.resize', { splitId, path: [], sizes: [0.7, 0.3] })
  await expectViewsOverPanes(orbit, [a, b])
  await orbit.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    win?.setSize(1100, 760)
  })
  await expect.poll(async () => (await orbit.shell.evaluate(() => window.innerWidth)) === 1100).toBe(true)
  await expectViewsOverPanes(orbit, [a, b])
  const [pa, pb] = [await paneBox(orbit.shell, a), await paneBox(orbit.shell, b)]
  expect(pa.width / pb.width).toBeCloseTo(0.7 / 0.3, 1)
})

/**
 * Adds `tabId` beside `target` and samples the new pane's card width every frame, timed from when the
 * card enters the page. The sampler runs before the pane is added: started alongside the command it
 * could begin late and miss the growth (CI saw a first sample at 94 %). It stops by itself, so it
 * can't hang the test.
 */
async function growIn(tabId: string, target: string): Promise<GrowProbe> {
  await orbit.shell.evaluate((id) => {
    const probe: GrowProbe = { insertedAt: 0, ticks: 0, samples: [], done: false }
    ;(window as unknown as { __grow: GrowProbe }).__grow = probe
    const started = performance.now()
    const card = () => document.querySelector<HTMLElement>(`[data-testid="split-pane"][data-tab-id="${id}"]`)
    const seen = new MutationObserver(() => {
      if (!card()) return
      probe.insertedAt = performance.now()
      seen.disconnect()
    })
    seen.observe(document.body, { subtree: true, childList: true })
    const tick = () => {
      probe.ticks++
      const now = performance.now()
      const el = card()
      if (el && probe.insertedAt) probe.samples.push({ t: now - probe.insertedAt, w: el.getBoundingClientRect().width })
      if (probe.insertedAt ? now - probe.insertedAt > 900 : now - started > 8000) probe.done = true
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, tabId)
  expect(await run(orbit.app, 'split.addTab', { tabId, target, side: 'right' })).toBeTruthy()
  const probe = () => orbit.shell.evaluate(() => (window as unknown as { __grow: GrowProbe }).__grow)
  await expect
    .poll(async () => {
      const p = await probe()
      return p.done ? 'done' : `${p.ticks} frames, card ${p.insertedAt ? 'in' : 'not in'} the page`
    })
    .toBe('done')
  const result = await probe()
  expect(result.insertedAt, `the new pane never appeared (${result.ticks} frames)`).toBeGreaterThan(0)
  return result
}

test('[SV-26] a new pane grows in with a spring and a closed one fades out', async () => {
  const a = await openTab(orbit.app, 'Grow1')
  await expect.poll(async () => (await tabView(orbit.app, a))?.visible).toBe(true)
  // The spring runs on the clock, so a frame that comes late already shows more of it: the shape is
  // checked on frames that came in time (at 100 ms it is about half grown), which needs a frame by
  // 100 ms and a few while it grows. A starved renderer can miss them; then that pane is closed and a
  // new one grows in, up to three rounds (as for timing budgets, D46), so the test never passes
  // without seeing the shape (PR #10 review F6). On the macOS CI VM a frame can take 100–200 ms
  // (D17), so there only the end state is checked.
  let grown: { tabId: string; samples: GrowProbe['samples'] } | undefined
  const rounds: string[] = []
  for (let round = 1; round <= 3 && !grown; round++) {
    const b = (await run(orbit.app, 'tabs.create', {
      url: fx.url(`/page/Grow${round + 1}`),
      activate: false,
    })) as string
    const { samples } = await growIn(b, a)
    const early = samples.filter((s) => s.t <= 100).length
    const by300 = samples.filter((s) => s.t <= 300).length
    const end = samples[samples.length - 1]?.w ?? 0
    const settled = samples.find((s) => Math.abs(s.w - end) <= 1)?.t ?? 1000
    // The checks below need a frame by 100 ms and two while it grows (PR #19 review M2), and the
    // settle within budget: a starved renderer draws its end late too (D46).
    if (FRAME_SLACK !== 1 || (early > 0 && by300 >= 3 && settled < 650)) grown = { tabId: b, samples }
    else {
      rounds.push(`round ${round}: ${early} frames by 100 ms, ${by300} by 300 ms, settled at ${Math.round(settled)} ms`)
      await run(orbit.app, 'split.closePane', { tabId: b })
      // The next pane grows from the neighbour that overlaps it, so wait for the close to finish: the
      // shell has drawn it (its ghost exists from here) and the ghost has faded. Until then the
      // neighbour may not reach the next pane's edge yet, and that pane appears at full size
      // (PR #19 review M1).
      await expect(orbit.shell.locator(`[data-testid="split-pane"][data-tab-id="${b}"]`)).toHaveCount(0)
      await expect(orbit.shell.locator('[data-testid="split-ghost"]')).toHaveCount(0)
    }
  }
  if (!grown) throw new Error(`frames never came in time to show the grow-in (${rounds.join('; ')})`)
  const { tabId: b, samples } = grown
  const final = samples[samples.length - 1]?.w ?? 0
  // It starts small and grows over several frames (a spring, not a jump), settles within 1 px
  // in well under a second (about 330 ms on an idle machine), without visible overshoot.
  if (FRAME_SLACK === 1) {
    expect(samples.filter((s) => s.t <= 100)[0]?.w).toBeLessThan(final * 0.8)
    expect(samples.filter((s) => s.w > 1 && s.w < final - 1).length).toBeGreaterThan(1)
  }
  const settledAt = samples.find((s) => Math.abs(s.w - final) <= 1)
  expect(settledAt?.t ?? 1000).toBeLessThan(FRAME_SLACK === 1 ? 650 : 900)
  expect(Math.max(...samples.map((s) => s.w))).toBeLessThan(final + 4)
  // Closing a pane leaves a short-lived fading card.
  const ghost = orbit.shell.waitForSelector('[data-testid="split-ghost"]', { state: 'attached', timeout: 5000 })
  await run(orbit.app, 'split.closePane', { tabId: b })
  await ghost
  await expect(orbit.shell.locator('[data-testid="split-ghost"]')).toHaveCount(0)
})

test('[SV-13][SV-26] a divider drag leaves the sidebar untouched and causes no long tasks', async () => {
  const b = await openTab(orbit.app, 'PerfR')
  const a = await openTab(orbit.app, 'PerfL')
  await run(orbit.app, 'split.create', { tabIds: [a, b] })
  await expectViewsOverPanes(orbit, [a, b])
  await orbit.shell.evaluate(() => {
    const w = window as unknown as { __longTasks: number[]; __sidebarMutations: number }
    w.__longTasks = []
    w.__sidebarMutations = 0
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__longTasks.push(e.duration)
    }).observe({ entryTypes: ['longtask'] })
    const sidebar = document.querySelector('[data-testid="sidebar"]') as Element
    const ww = w as unknown as { __lastMutation: number }
    ww.__lastMutation = performance.now()
    new MutationObserver((records) => {
      w.__sidebarMutations += records.length
      ww.__lastMutation = performance.now()
    }).observe(sidebar, { subtree: true, childList: true, attributes: true, characterData: true })
  })
  // Let late page titles, favicons and row animations settle, then count from zero.
  await expect
    .poll(() =>
      orbit.shell.evaluate(
        () => performance.now() - (window as unknown as { __lastMutation: number }).__lastMutation > 600,
      ),
    )
    .toBe(true)
  await orbit.shell.evaluate(() => {
    ;(window as unknown as { __sidebarMutations: number }).__sidebarMutations = 0
  })
  // One round drags the divider back and forth; a round with a long task is dragged again (D46): on a
  // loaded machine the renderer can wait long enough for the CPU to stretch a short task past 50 ms.
  const { best: mid, all } = await bestOf(
    async (round) => {
      if (round > 1) {
        // The last drag's sizes are saved as it ends: let the sidebar settle, then count from zero again.
        await expect
          .poll(() =>
            orbit.shell.evaluate(
              () => performance.now() - (window as unknown as { __lastMutation: number }).__lastMutation > 600,
            ),
          )
          .toBe(true)
      }
      await orbit.shell.evaluate(() => {
        const w = window as unknown as { __longTasks: number[]; __sidebarMutations: number }
        w.__longTasks.length = 0
        w.__sidebarMutations = 0
      })
      const divider = await orbit.shell.getByTestId('split-divider').boundingBox()
      if (!divider) throw new Error('no divider')
      const y = divider.y + divider.height / 2
      await orbit.shell.mouse.move(divider.x + 4, y)
      await orbit.shell.mouse.down()
      for (let i = 1; i <= 60; i++) await orbit.shell.mouse.move(divider.x + 4 + Math.sin(i / 6) * 150, y)
      const seen = await orbit.shell.evaluate(() => {
        const w = window as unknown as { __longTasks: number[]; __sidebarMutations: number }
        return { longTasks: [...w.__longTasks], mutations: w.__sidebarMutations }
      })
      await orbit.shell.mouse.up()
      return seen
    },
    (r) => r.mutations === 0 && r.longTasks.every((d) => d <= 50),
  )
  console.info(
    `[split e2e perf] long tasks while dragging, by round: ${all.map((r) => `[${r.longTasks.map(Math.round).join(', ')}]`).join(' ')}`,
  )
  expect(mid.mutations).toBe(0)
  expect(mid.longTasks.filter((d) => d > 50)).toEqual([])
})

test('[SV-02][SV-15] pane sessions: quick re-add, new-tab choice and closing the empty pane', async () => {
  const a = await openTab(orbit.app, 'Steady')
  await expect.poll(async () => (await tabView(orbit.app, a))?.visible).toBe(true)
  const overlay = await viewPage(orbit.app, 'overlay')
  const input = overlay.getByTestId('command-input')
  // Escape then the shortcut again right away: the second empty pane is the one that gets filled.
  await orbit.shell.keyboard.press('Control+Shift+Equal')
  await expect(input).toBeFocused()
  await input.press('Escape')
  await orbit.shell.keyboard.press('Control+Shift+Equal')
  await expect(input).toBeFocused()
  await input.fill(fx.url('/page/Second'))
  await input.press('Enter')
  await expect(orbit.shell.getByTestId('split-row')).toContainText('Second')
  await expect(orbit.shell.getByTestId('split-row')).toContainText('Steady')
  await expect(orbit.shell.getByTestId('split-pane')).toHaveCount(2)
  // ⌘L / Ctrl+L on a pane, then ⌘/Ctrl+Enter (open in a new tab): the pane keeps its page.
  const pane = (await activeTabId(orbit.app)) as string
  await orbit.shell.keyboard.press(`${MOD}+L`)
  await expect(input).toBeFocused()
  await input.fill(fx.url('/page/Elsewhere'))
  await expect(overlay.getByTestId('command-result').first()).toBeVisible()
  await input.press(`${MOD}+Enter`)
  await expect(orbit.shell.getByTestId('tab-row')).toHaveCount(1)
  await expect(orbit.shell.getByTestId('split-row')).toContainText('Second')
  expect((await state(orbit.app)).tabs[pane]?.url).toContain('/page/Second')
  // Closing the empty pane itself (⌘W / Ctrl+W while its command bar is open) closes the bar too.
  await run(orbit.app, 'tabs.activate', { tabId: a })
  await orbit.shell.keyboard.press('Control+Shift+Equal')
  await expect(input).toBeFocused()
  await expect(orbit.shell.getByTestId('split-pane')).toHaveCount(3)
  await input.press(`${MOD}+W`)
  await expect(overlay.getByTestId('command-bar')).toHaveCount(0)
  await expect(orbit.shell.getByTestId('split-pane')).toHaveCount(2)
})

test('[SV-02][SV-23] a split made from a Favorite stays in the Favorites grid', async () => {
  const fav = await openTab(orbit.app, 'Fav')
  const s = await state(orbit.app)
  const profileId = s.spaces[s.tabs[fav]?.spaceId as string]?.profileId as string
  await run(orbit.app, 'tabs.move', { id: fav, to: { kind: 'favorites', profileId }, index: 0 })
  await run(orbit.app, 'tabs.activate', { tabId: fav })
  await expect(orbit.shell.getByTestId('favorite-tile')).toHaveCount(1)
  await action(orbit.app, 'split.add')
  const overlay = await viewPage(orbit.app, 'overlay')
  const input = overlay.getByTestId('command-input')
  await expect(input).toBeFocused()
  await input.fill(fx.url('/page/Beside'))
  await input.press('Enter')
  const tile = orbit.shell.locator('[data-testid="favorite-tile"][data-split-id]')
  await expect(tile).toHaveCount(1)
  await expect(orbit.shell.getByTestId('split-pane')).toHaveCount(2)
})

test('[FV-02][SV-23] a Favorite split never comes apart past 12 Favorites: Separate and Move Out are refused (lead review F1)', async () => {
  const panes = [await openTab(orbit.app, 'P3'), await openTab(orbit.app, 'P2'), await openTab(orbit.app, 'P1')]
  const s = await state(orbit.app)
  const spaceId = s.tabs[panes[0] as string]?.spaceId as string
  const profileId = s.spaces[spaceId]?.profileId as string
  const favorites = { kind: 'favorites', profileId }
  for (let i = 0; i < 11; i++) {
    const id = await run(orbit.app, 'tabs.create', { url: fx.url(`/page/F${i}`), activate: false })
    expect(await run(orbit.app, 'tabs.move', { id, to: favorites, index: i }), `Favorite ${i}`).toBe(true)
  }
  const splitId = (await run(orbit.app, 'split.create', { tabIds: panes })) as string
  await run(orbit.app, 'tabs.move', { id: splitId, to: favorites, index: 11 })
  const tiles = async () => (await state(orbit.app)).profiles[profileId]?.favorites ?? []
  await expect.poll(async () => (await tiles()).length).toBe(12)
  // Separating would make 14 tiles and moving one pane out 13: both are refused, and nothing changes.
  await run(orbit.app, 'split.separate', { splitId })
  await expect(orbit.shell.getByTestId('toast').last()).toContainText('Favorites are full (12 max)')
  await run(orbit.app, 'split.popOut', { tabId: panes[0] })
  expect(await tiles()).toHaveLength(12)
  const layout = JSON.stringify((await state(orbit.app)).splits[splitId]?.layout)
  for (const id of panes) expect(layout).toContain(id)
  // With room for one more tile, a pane moves out as usual.
  await run(orbit.app, 'tabs.move', { id: (await tiles())[0], to: { kind: 'today', spaceId }, index: 0 })
  await run(orbit.app, 'split.popOut', { tabId: panes[0] })
  await expect.poll(async () => (await tiles()).length).toBe(12)
  expect(JSON.stringify((await state(orbit.app)).splits[splitId]?.layout)).not.toContain(panes[0])
})

test('[FV-02][SV-23] Duplicate and Open in Split View never make a 13th Favorite from a Favorite split (PR #10 review M1)', async () => {
  const panes = [await openTab(orbit.app, 'P3'), await openTab(orbit.app, 'P2'), await openTab(orbit.app, 'P1')]
  const s = await state(orbit.app)
  const spaceId = s.tabs[panes[0] as string]?.spaceId as string
  const profileId = s.spaces[spaceId]?.profileId as string
  const favorites = { kind: 'favorites', profileId }
  for (let i = 0; i < 11; i++) {
    const id = await run(orbit.app, 'tabs.create', { url: fx.url(`/page/F${i}`), activate: false })
    expect(await run(orbit.app, 'tabs.move', { id, to: favorites, index: i }), `Favorite ${i}`).toBe(true)
  }
  const splitId = (await run(orbit.app, 'split.create', { tabIds: panes })) as string
  await run(orbit.app, 'tabs.move', { id: splitId, to: favorites, index: 11 })
  const tiles = async () => (await state(orbit.app)).profiles[profileId]?.favorites ?? []
  await expect.poll(async () => (await tiles()).length).toBe(12)
  // A copy of the split would be a 13th tile beside it.
  expect(await run(orbit.app, 'split.duplicate', { splitId })).toBeNull()
  await expect(orbit.shell.getByTestId('toast').last()).toContainText('Favorites are full (12 max)')
  expect(await tiles()).toHaveLength(12)
  // A pane split with a Today tab would leave its split as a new tile, also a 13th.
  const today = await openTab(orbit.app, 'Today')
  expect(await run(orbit.app, 'split.create', { tabIds: [panes[0], today] })).toBeNull()
  expect(await tiles()).toHaveLength(12)
  expect(JSON.stringify((await state(orbit.app)).splits[splitId]?.layout)).toContain(panes[0])
  // With room for one more tile, both work as usual.
  await run(orbit.app, 'tabs.move', { id: (await tiles())[0], to: { kind: 'today', spaceId }, index: 0 })
  expect(await run(orbit.app, 'split.duplicate', { splitId })).toBeTruthy()
  await expect.poll(async () => (await tiles()).length).toBe(12)
  await run(orbit.app, 'tabs.move', { id: (await tiles())[0], to: { kind: 'today', spaceId }, index: 0 })
  expect(await run(orbit.app, 'split.create', { tabIds: [panes[0], today] })).toBeTruthy()
  await expect.poll(async () => (await tiles()).length).toBe(12)
})

test('[SV-17] a reopened pane returns to its exact spot beside a stacked pair', async () => {
  const b = await openTab(orbit.app, 'StackTop')
  const a = await openTab(orbit.app, 'LeftTall')
  const splitId = (await run(orbit.app, 'split.create', { tabIds: [a, b] })) as string
  const c = await openTab(orbit.app, 'StackBottom')
  await run(orbit.app, 'split.addTab', { tabId: c, target: b, side: 'bottom' })
  await expectViewsOverPanes(orbit, [a, b, c])
  const before = (await state(orbit.app)).splits[splitId]?.layout
  await run(orbit.app, 'split.closePane', { tabId: a })
  await expect(orbit.shell.getByTestId('split-segment')).toHaveCount(2)
  await action(orbit.app, 'tab.reopenClosed')
  await expect(orbit.shell.getByTestId('split-segment')).toHaveCount(3)
  expect(JSON.stringify((await state(orbit.app)).splits[splitId]?.layout)).toBe(JSON.stringify(before))
  await expectViewsOverPanes(orbit, [a, b, c])
})

/** Records every native placement the window manager makes (tab ids and widths). */
async function logPlacements(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const g = globalThis as unknown as {
      __orbit: { ctx: { windows: { applyPanes: (...a: unknown[]) => void } } }
      __placements: { tabId: string; width: number }[][]
    }
    const wm = g.__orbit.ctx.windows
    const original = wm.applyPanes.bind(wm)
    g.__placements = []
    wm.applyPanes = (...args: unknown[]) => {
      const panes = args[1] as { tabId: string; rect: { width: number } }[]
      g.__placements.push(panes.map((p) => ({ tabId: p.tabId, width: Math.round(p.rect.width) })))
      original(...args)
    }
  })
}

async function takePlacements(app: ElectronApplication) {
  return app.evaluate(() => {
    const g = globalThis as unknown as { __placements: { tabId: string; width: number }[][] }
    const out = g.__placements
    g.__placements = []
    return out
  })
}

test('[SV-17][SV-26] ⌘W and ⌘⇧T (Ctrl+W, Ctrl+Shift+T) on a pane never show a page outside the split', async () => {
  const x = await openTab(orbit.app, 'Neighbour')
  const c = await openTab(orbit.app, 'PaneC')
  const b = await openTab(orbit.app, 'PaneB')
  const a = await openTab(orbit.app, 'PaneA')
  await run(orbit.app, 'split.create', { tabIds: [a, b, c], focus: b })
  await expectViewsOverPanes(orbit, [a, b, c])
  // Visit the neighbouring tab and come back, as in the review's scenario.
  await run(orbit.app, 'tabs.activate', { tabId: x })
  await expect.poll(async () => (await tabView(orbit.app, x))?.visible).toBe(true)
  await run(orbit.app, 'tabs.activate', { tabId: b })
  await expectViewsOverPanes(orbit, [a, b, c])
  await logPlacements(orbit.app)
  await orbit.shell.keyboard.press(`${MOD}+W`)
  await expect(orbit.shell.getByTestId('split-row').getByTestId('split-segment')).toHaveCount(2)
  // The panes that stay are placed without the closed one once the shell has drawn the close. On a
  // loaded machine that can come after the sidebar's row has changed, while the views still sit over
  // the panes as they were: wait for it before comparing views and panes.
  const closing = await takePlacements(orbit.app)
  await expect
    .poll(async () => {
      closing.push(...(await takePlacements(orbit.app)))
      return closing.some((placed) => placed.length > 0 && !placed.some((p) => p.tabId === b))
    })
    .toBe(true)
  await expectViewsOverPanes(orbit, [a, c])
  closing.push(...(await takePlacements(orbit.app)))
  for (const placed of closing) {
    expect(placed.map((p) => p.tabId)).not.toContain(x)
    expect(placed.length).toBeGreaterThanOrEqual(2)
  }
  // The remaining panes only ever grow (no snap back to their old thirds).
  for (const id of [a, c]) {
    const widths = closing.flatMap((placed) => placed.filter((p) => p.tabId === id).map((p) => p.width))
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeGreaterThanOrEqual((widths[i - 1] ?? 0) - 1)
  }
  expect([a, c]).toContain(await activeTabId(orbit.app))
  // Reopening puts the pane straight back into the split: it is never placed alone.
  await orbit.shell.keyboard.press(`${MOD}+Shift+T`)
  await expect(orbit.shell.getByTestId('split-row').getByTestId('split-segment')).toHaveCount(3)
  await expectViewsOverPanes(orbit, [a, b, c])
  const reopening = await takePlacements(orbit.app)
  for (const placed of reopening) {
    expect(placed.map((p) => p.tabId)).not.toContain(x)
    expect(placed.length).toBeGreaterThanOrEqual(2)
  }
  expect(await activeTabId(orbit.app)).toBe(b)
})

/** Runs a main-process command for a given window (the helper `run` always uses the first window). */
async function runIn(app: ElectronApplication, windowIndex: number, name: string, args: unknown = {}) {
  return app.evaluate(
    async (_e, [n, a, i]) => {
      const g = globalThis as unknown as {
        __orbit: { run: (n: string, a: unknown, w?: string) => unknown; windowIds: () => string[] }
      }
      return g.__orbit.run(n as string, a, g.__orbit.windowIds()[i as number])
    },
    [name, args, windowIndex] as const,
  )
}

async function tabsHook<T>(app: ElectronApplication, name: string, arg?: unknown): Promise<T> {
  return app.evaluate(
    (_e, [n, a]) =>
      (globalThis as unknown as { __orbitTabs: Record<string, (x?: unknown) => unknown> }).__orbitTabs[n as string]?.(
        a,
      ) as T,
    [name, arg] as const,
  )
}

test('[SV-05] resting a dragged tab on the right half of a row makes a split there; Undo takes it back', async () => {
  const b = await openTab(orbit.app, 'Target')
  const a = await openTab(orbit.app, 'Dropped')
  const before = (await state(orbit.app)).spaces[(await state(orbit.app)).tabs[a]?.spaceId as string]?.today
  await settled(orbit.shell)
  const from = await orbit.shell.locator(`[data-testid="tab-row"][data-tab-id="${a}"]`).boundingBox()
  const to = await orbit.shell.locator(`[data-testid="tab-row"][data-tab-id="${b}"]`).boundingBox()
  if (!from || !to) throw new Error('rows')
  await orbit.shell.mouse.move(from.x + 30, from.y + from.height / 2)
  await orbit.shell.mouse.down()
  await orbit.shell.mouse.move(from.x + 40, from.y + from.height / 2 + 6, { steps: 3 })
  await orbit.shell.mouse.move(to.x + to.width * 0.75, to.y + to.height / 2, { steps: 8 })
  // The split indicator only shows once the pointer has rested on the row for a moment.
  await expect(orbit.shell.locator('.row-slot.is-split-right')).toHaveCount(0)
  await expect(orbit.shell.locator('.row-slot.is-split-right')).toHaveCount(1)
  await orbit.shell.mouse.up()
  await expect(orbit.shell.getByTestId('split-row')).toHaveCount(1)
  const split = await splitOf(orbit.app, b)
  expect(split && JSON.stringify(split.layout).match(/t-[a-z0-9]+/g)).toEqual([b, a])
  await expectViewsOverPanes(orbit, [a, b])
  // Undo (TB-18) puts both rows back where they were.
  expect(await run(orbit.app, 'tabs.undo', {})).toBe('Split View')
  await expect(orbit.shell.getByTestId('split-row')).toHaveCount(0)
  const after = await state(orbit.app)
  expect(after.spaces[after.tabs[a]?.spaceId as string]?.today).toEqual(before)
})

test('[SV-05] a quick drag across the middle of a row reorders, it does not make a split', async () => {
  const c = await openTab(orbit.app, 'Third')
  const b = await openTab(orbit.app, 'Second')
  const a = await openTab(orbit.app, 'First')
  await settled(orbit.shell)
  const from = await orbit.shell.locator(`[data-testid="tab-row"][data-tab-id="${a}"]`).boundingBox()
  const to = await orbit.shell.locator(`[data-testid="tab-row"][data-tab-id="${c}"]`).boundingBox()
  if (!from || !to) throw new Error('rows')
  await orbit.shell.mouse.move(from.x + 30, from.y + from.height / 2)
  await orbit.shell.mouse.down()
  await orbit.shell.mouse.move(from.x + 40, from.y + from.height / 2 + 6, { steps: 2 })
  // Straight to the lower part of the last row's middle band and released at once.
  await orbit.shell.mouse.move(to.x + to.width * 0.75, to.y + to.height * 0.7, { steps: 4 })
  await orbit.shell.mouse.up()
  await expect(orbit.shell.getByTestId('tab-row')).toHaveCount(3)
  expect(Object.keys((await state(orbit.app)).splits)).toHaveLength(0)
  const s = await state(orbit.app)
  const today = s.spaces[s.tabs[a]?.spaceId as string]?.today ?? []
  expect(today.indexOf(a)).toBeGreaterThan(today.indexOf(b))
})

test('[SV-05] leaving the list starts the rest over: back on the same row and released at once reorders (review W1)', async () => {
  const c = await openTab(orbit.app, 'Third')
  const b = await openTab(orbit.app, 'Second')
  const a = await openTab(orbit.app, 'First')
  // The last row goes up onto the first: rows above the dragged one stay put while it is away.
  await settled(orbit.shell)
  const from = await orbit.shell.locator(`[data-testid="tab-row"][data-tab-id="${c}"]`).boundingBox()
  const to = await orbit.shell.locator(`[data-testid="tab-row"][data-tab-id="${a}"]`).boundingBox()
  if (!from || !to) throw new Error('rows')
  // The right half of the row's middle band, on the side the drag comes from, where a rest arms.
  const over = { x: to.x + to.width * 0.75, y: to.y + to.height * 0.6 }
  await orbit.shell.mouse.move(from.x + 30, from.y + from.height / 2)
  await orbit.shell.mouse.down()
  await orbit.shell.mouse.move(from.x + 40, from.y + from.height / 2 - 6, { steps: 2 })
  await orbit.shell.mouse.move(over.x, over.y, { steps: 6 })
  // The split indicator shows: the rest has run its full time.
  await expect(orbit.shell.locator('.row-slot.is-split-right')).toHaveCount(1)
  // Out over the page and straight back onto the same spot, released at once.
  await orbit.shell.mouse.move(to.x + to.width + 300, over.y, { steps: 2 })
  await expect(orbit.shell.locator('.row-slot.is-split-right')).toHaveCount(0)
  await orbit.shell.mouse.move(over.x, over.y, { steps: 2 })
  await orbit.shell.mouse.up()
  // The drop is a move (committed once the row has settled), not a split.
  await expect
    .poll(async () => {
      const s = await state(orbit.app)
      const today = s.spaces[s.tabs[c]?.spaceId as string]?.today ?? []
      return today.includes(c) && today.indexOf(c) < today.indexOf(b)
    })
    .toBe(true)
  expect(Object.keys((await state(orbit.app)).splits)).toHaveLength(0)
})

/** Drags `from`'s row onto `onto`'s row, to `fy` of its height on the right half, and holds. */
async function restOnRow(from: string, onto: string, fy: number) {
  await settled(orbit.shell)
  const a = await orbit.shell.locator(`[data-testid="tab-row"][data-tab-id="${from}"]`).boundingBox()
  const to = await orbit.shell.locator(`[data-testid="tab-row"][data-tab-id="${onto}"]`).boundingBox()
  if (!a || !to) throw new Error('rows')
  const dy = to.y > a.y ? 6 : -6
  await orbit.shell.mouse.move(a.x + 30, a.y + a.height / 2)
  await orbit.shell.mouse.down()
  await orbit.shell.mouse.move(a.x + 40, a.y + a.height / 2 + dy, { steps: 2 })
  await orbit.shell.mouse.move(to.x + to.width * 0.75, to.y + to.height * fy, { steps: 10 })
  return to
}

for (const [dir, fy] of [
  ['down', 0.7],
  ['up', 0.3],
] as const) {
  test(`[SV-05] dragging ${dir}, a rest on the far half of a row's middle band (${fy * 100} %) makes a split: the row holds still (review W2)`, async () => {
    const d = await openTab(orbit.app, 'Fourth')
    await openTab(orbit.app, 'Third')
    const b = await openTab(orbit.app, 'Second')
    const a = await openTab(orbit.app, 'First')
    // Down: the first row onto the last. Up: the last row onto the second.
    const [from, onto] = dir === 'down' ? [a, d] : [d, b]
    const to = await restOnRow(from, onto, fy)
    await expect(orbit.shell.locator('.row-slot.is-split-right')).toHaveCount(1)
    const held = await orbit.shell.locator(`[data-testid="tab-row"][data-tab-id="${onto}"]`).boundingBox()
    expect(Math.abs((held?.y ?? 0) - to.y)).toBeLessThan(2)
    await orbit.shell.mouse.up()
    await expect(orbit.shell.getByTestId('split-row')).toHaveCount(1)
    const split = await splitOf(orbit.app, onto)
    expect(split && JSON.stringify(split.layout).match(/t-[a-z0-9]+/g)).toEqual([onto, from])
  })
}

test("[SV-05][FL-10] a quick drop of a Favorite on a row's lower half lands after the row: a tile opens no gap, so no row holds (review M1)", async () => {
  const r4 = await openTab(orbit.app, 'Fourth')
  const r3 = await openTab(orbit.app, 'Third')
  const r2 = await openTab(orbit.app, 'Second')
  const r1 = await openTab(orbit.app, 'First')
  const fav = await openTab(orbit.app, 'Fav')
  const s = await state(orbit.app)
  const spaceId = s.tabs[fav]?.spaceId as string
  const profileId = s.spaces[spaceId]?.profileId as string
  await run(orbit.app, 'tabs.move', { id: fav, to: { kind: 'favorites', profileId }, index: 0 })
  await expect(orbit.shell.getByTestId('favorite-tile')).toHaveCount(1)
  await settled(orbit.shell)
  const tile = await orbit.shell.locator(`[data-fav-id="${fav}"]`).boundingBox()
  const to = await orbit.shell.locator(`[data-testid="tab-row"][data-tab-id="${r2}"]`).boundingBox()
  if (!tile || !to) throw new Error('boxes')
  await orbit.shell.mouse.move(tile.x + tile.width / 2, tile.y + tile.height / 2)
  await orbit.shell.mouse.down()
  await orbit.shell.mouse.move(tile.x + tile.width / 2, tile.y + tile.height / 2 + 8, { steps: 2 })
  await orbit.shell.mouse.move(to.x + to.width * 0.75, to.y + to.height * 0.1, { steps: 10 })
  // Onto the lower half of the row's middle band, then let go long before a rest would make a split.
  await orbit.shell.mouse.move(to.x + to.width * 0.75, to.y + to.height * 0.7)
  await orbit.shell.mouse.up()
  await expect.poll(async () => (await state(orbit.app)).spaces[spaceId]?.today).toEqual([r1, r2, fav, r3, r4])
  await expect(orbit.shell.getByTestId('split-row')).toHaveCount(0)
})

test('[SV-06] Open in Split View from a multi-selection makes one split in sidebar order', async () => {
  const c = await openTab(orbit.app, 'Sel3')
  const b = await openTab(orbit.app, 'Sel2')
  const a = await openTab(orbit.app, 'Sel1')
  await run(orbit.app, 'tabs.setSelection', { tabIds: [c, a, b] })
  await run(orbit.app, 'tabs.contextMenu', { id: b, selection: [c, a, b] })
  // The row menu in the overlay (tabs lane, TB-14).
  expect((await tabsHook<{ labels: string[] }>(orbit.app, 'rowMenu'))?.labels).toContain('Open in Split View')
  expect(await tabsHook<boolean>(orbit.app, 'chooseRowMenu', 'Open in Split View')).toBe(true)
  await expect(orbit.shell.getByTestId('split-row').getByTestId('split-segment')).toHaveCount(3)
  const split = await splitOf(orbit.app, a)
  expect(split && JSON.stringify(split.layout).match(/t-[a-z0-9]+/g)).toEqual([a, b, c])
  await expectViewsOverPanes(orbit, [a, b, c])
})

test('[SV-24] Move to Space hands the selection on in the Space the split leaves (TB-11)', async () => {
  const x = await openTab(orbit.app, 'StaysHere')
  const b = await openTab(orbit.app, 'MovesB')
  const a = await openTab(orbit.app, 'MovesA')
  const splitId = (await run(orbit.app, 'split.create', { tabIds: [a, b] })) as string
  await expectViewsOverPanes(orbit, [a, b])
  const s1 = (await state(orbit.app)).tabs[a]?.spaceId as string
  const s2 = (await run(orbit.app, 'spaces.create', { name: 'Elsewhere', activate: false })) as string
  expect(await run(orbit.app, 'split.move', { splitId, to: { kind: 'today', spaceId: s2 }, index: 0 })).toBe(true)
  const s = await state(orbit.app)
  const win = Object.values(s.windows)[0]
  expect(win?.spaceId).toBe(s1)
  expect(win?.activeTab[s1]).toBe(x)
  expect(s.spaces[s2]?.today).toContain(splitId)
  await expect(orbit.shell.getByTestId('content-frame')).toHaveAttribute('data-split-id', '')
  await expect.poll(async () => (await tabView(orbit.app, x))?.visible).toBe(true)
})

test('[SV-24] two windows never share a split: the other window moves on and keeps its own page', async () => {
  const x = await openTab(orbit.app, 'OwnPage')
  const b = await openTab(orbit.app, 'SharedB')
  const a = await openTab(orbit.app, 'SharedA')
  await run(orbit.app, 'split.create', { tabIds: [a, b], focus: b })
  await expectViewsOverPanes(orbit, [a, b])
  await action(orbit.app, 'window.new')
  await expect
    .poll(
      async () =>
        (
          await orbit.app.evaluate(() =>
            (globalThis as unknown as { __orbit: { windowIds: () => string[] } }).__orbit.windowIds(),
          )
        ).length,
    )
    .toBe(2)
  const [w1, w2] = await orbit.app.evaluate(() =>
    (globalThis as unknown as { __orbit: { windowIds: () => string[] } }).__orbit.windowIds(),
  )
  await runIn(orbit.app, 1, 'tabs.activate', { tabId: a })
  const s = await state(orbit.app)
  const active1 = s.windows[w1 as string]?.activeTab[s.windows[w1 as string]?.spaceId as string]
  expect([a, b]).not.toContain(active1)
  expect(s.windows[w2 as string]?.activeTab[s.windows[w2 as string]?.spaceId as string]).toBe(a)
  // Both panes live in window 2; window 1 shows its own page, and stays that way after relayouts.
  const owner = (tabId: string) =>
    orbit.app.evaluate(
      (_e, id) =>
        (
          globalThis as unknown as { __orbit: { ctx: { windows: { windowOfTab: (t: string) => string } } } }
        ).__orbit.ctx.windows.windowOfTab(id),
      tabId,
    )
  await expect.poll(() => owner(a)).toBe(w2)
  await expect.poll(() => owner(b)).toBe(w2)
  await orbit.app.evaluate(({ BrowserWindow }) => {
    const first = BrowserWindow.getAllWindows()[0]
    first?.setSize(1000, 700)
  })
  await new Promise((r) => setTimeout(r, 400))
  expect(await owner(a)).toBe(w2)
  expect(await owner(b)).toBe(w2)
  expect(active1).toBe(x)
})

test('[SV-02] choosing a Space while filling an empty pane pulls nothing into the split', async () => {
  const a = await openTab(orbit.app, 'Base2')
  const s2 = (await run(orbit.app, 'spaces.create', { name: 'Other', activate: false })) as string
  const other = (await run(orbit.app, 'tabs.create', {
    url: fx.url('/page/OtherSpaceTab'),
    spaceId: s2,
    activate: false,
  })) as string
  // Space 2 remembers `other` as its selected tab.
  await orbit.app.evaluate(
    (_e, [spaceId, tabId]) => {
      const g = globalThis as unknown as {
        __orbit: {
          ctx: {
            store: {
              update: (f: (d: { windows: Record<string, { activeTab: Record<string, string> }> }) => void) => void
            }
          }
          windowIds: () => string[]
        }
      }
      const w = g.__orbit.windowIds()[0] as string
      g.__orbit.ctx.store.update((d) => {
        const win = d.windows[w]
        if (win) win.activeTab[spaceId as string] = tabId as string
      })
    },
    [s2, other] as const,
  )
  await action(orbit.app, 'split.add')
  await expect(orbit.shell.getByTestId('split-pane')).toHaveCount(2)
  // The command bar closes and the window switches Space in the same tick (a Space result).
  await orbit.app.evaluate(async (_e, id) => {
    const g = globalThis as unknown as {
      __orbit: {
        ctx: { commands: { run: (n: string, a: unknown, c: unknown) => Promise<unknown> } }
        windowIds: () => string[]
      }
    }
    const windowId = g.__orbit.windowIds()[0]
    void g.__orbit.ctx.commands.run('overlay.close', {}, { windowId })
    await g.__orbit.ctx.commands.run('spaces.switch', { spaceId: id }, { windowId })
  }, s2)
  await expect.poll(async () => Object.keys((await state(orbit.app)).splits).length).toBe(0)
  const s = await state(orbit.app)
  expect(splitOfTab(s, other)).toBeUndefined()
  expect(s.tabs[other]?.spaceId).toBe(s2)
  expect(s.tabs[a]).toBeDefined()
})

function splitOfTab(s: { splits: Record<string, { layout: SplitLayout }> }, tabId: string): string | undefined {
  for (const [id, split] of Object.entries(s.splits)) if (JSON.stringify(split.layout).includes(`"${tabId}"`)) return id
  return undefined
}

test('[SV-12][SV-22] the strip follows its pane when the panes move; Duplicate keeps the name', async () => {
  const b = await openTab(orbit.app, 'Moving')
  const a = await openTab(orbit.app, 'Fixed')
  const splitId = (await run(orbit.app, 'split.create', { tabIds: [a, b] })) as string
  await expectViewsOverPanes(orbit, [a, b])
  const shown = await showStrip(orbit.app, b)
  // Sizes any window can show: a 0.3 pane would be under the 240 px minimum in a small window.
  await run(orbit.app, 'split.resize', { splitId, path: [], sizes: [0.6, 0.4] })
  await expectViewsOverPanes(orbit, [a, b])
  // Moved right, and centred over the pane again (before the panes start moving, it is centred
  // where it was: slow frames on the macOS runner showed that).
  await expect
    .poll(async () => {
      const info = await stripInfo(orbit.app)
      const pb = await paneBox(orbit.shell, b)
      return (
        info.visible &&
        !!info.bounds &&
        info.bounds.x > shown.x &&
        Math.abs(info.bounds.x + info.bounds.width / 2 - (pb.x + pb.width / 2)) <= 1
      )
    })
    .toBe(true)
  await run(orbit.app, 'split.rename', { splitId, name: 'Pair' })
  const copy = (await run(orbit.app, 'split.duplicate', { splitId })) as string
  expect((await state(orbit.app)).splits[copy]?.name).toBe('Pair')
})

test('[SV-12] a window that closes while its pane strip fades out closes cleanly (D28)', async () => {
  const b = await openTab(orbit.app, 'Second')
  const a = await openTab(orbit.app, 'First')
  await run(orbit.app, 'split.create', { tabIds: [a, b] })
  await expectViewsOverPanes(orbit, [a, b])
  const windowIds = () =>
    orbit.app.evaluate(() => (globalThis as unknown as { __orbit: { windowIds: () => string[] } }).__orbit.windowIds())
  const [first] = await windowIds()
  // A second window keeps Orbit running once the first one closes.
  await action(orbit.app, 'window.new')
  await expect.poll(async () => (await windowIds()).length).toBe(2)
  await showStrip(orbit.app, a)
  // The strip starts fading out, and its window closes before the fade ends. The fade's timer used to
  // fire on a view that was gone and throw, and a throw nothing caught kept Orbit from quitting.
  await orbit.app.evaluate((_e, id) => {
    const g = globalThis as unknown as {
      __orbitSplit: { strip: { hide: (w: string) => void } }
      __orbit: { ctx: { windows: { get: (w: string) => { close: () => void } | undefined } } }
    }
    g.__orbitSplit.strip.hide(id)
    g.__orbit.ctx.windows.get(id)?.close()
  }, first as string)
  await expect.poll(async () => (await windowIds()).includes(first as string)).toBe(false)
  // Main-process timers fire in order: by the end of this one, the fade's has run.
  await orbit.app.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)))
  expect(orbit.takeUncaught()).toBe('')
})

test('[SV-08] a link opens in a new pane beside the page that holds it', async () => {
  const a = await openTab(orbit.app, 'Source')
  await expect.poll(async () => (await tabView(orbit.app, a))?.visible).toBe(true)
  const splitId = (await run(orbit.app, 'split.openUrl', { url: fx.url('/page/Linked'), target: a })) as string
  expect(splitId).toMatch(/^v-/)
  const split = await splitOf(orbit.app, a)
  const linked = JSON.stringify(split?.layout)
    .match(/t-[a-z0-9]+/g)
    ?.find((id) => id !== a) as string
  await expectViewsOverPanes(orbit, [a, linked])
  expect((await paneBox(orbit.shell, linked)).x).toBeGreaterThan((await paneBox(orbit.shell, a)).x)
  await expect.poll(async () => (await tabView(orbit.app, linked))?.url).toContain('/page/Linked')
})
