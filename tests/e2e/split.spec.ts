import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import type { SplitLayout } from '../../src/shared/state'
import {
  action,
  activeTabId,
  type Fixtures,
  launchOrbit,
  type Orbit,
  run,
  startFixtures,
  state,
  tabPage,
  tabView,
  viewPage,
} from './helpers'

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

type Box = { x: number; y: number; width: number; height: number }

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
          const pane = await paneBox(o.shell, tabId)
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
  for (let i = 1; i <= 10; i++) await orbit.shell.mouse.move(x + i * 12, y)
  // Mid-drag the views already follow the pointer, while the stored layout (and so every
  // state subscriber, e.g. the sidebar) is untouched until the drag ends.
  await expect.poll(async () => (await tabView(orbit.app, a))?.bounds.width).toBeGreaterThan(before.width + 100)
  const midDrag = (await splitOf(orbit.app, a))?.layout
  expect(midDrag?.type === 'row' && midDrag.sizes).toEqual([0.5, 0.5])
  await orbit.shell.mouse.up()
  await expectViewsOverPanes(orbit, [a, b])
  const after = (await tabView(orbit.app, a))?.bounds as Box
  expect(after.width - before.width).toBeGreaterThan(100)
  await expect
    .poll(async () => {
      const layout = (await splitOf(orbit.app, a))?.layout
      return layout && layout.type !== 'leaf' ? (layout.sizes[0] ?? 0) : 0
    })
    .toBeGreaterThan(0.55)
  // The right pane stops at its minimum width.
  const d2 = await orbit.shell.getByTestId('split-divider').boundingBox()
  if (!d2) throw new Error('no divider')
  await orbit.shell.mouse.move(d2.x + 4, d2.y + d2.height / 2)
  await orbit.shell.mouse.down()
  await orbit.shell.mouse.move(d2.x + 2000, d2.y + d2.height / 2, { steps: 5 })
  await orbit.shell.mouse.up()
  await expect.poll(async () => (await tabView(orbit.app, b))?.bounds.width).toBeGreaterThanOrEqual(239)
  expect((await tabView(orbit.app, b))?.bounds.width).toBeLessThanOrEqual(242)
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
  await orbit.shell.keyboard.press('Control+T')
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
  await expectViewsOverPanes(orbit, [a, bottom])
  expect((await paneBox(orbit.shell, bottom)).y).toBeGreaterThan((await paneBox(orbit.shell, a)).y)
  await action(orbit.app, 'split.flip')
  await expect.poll(async () => (await splitOf(orbit.app, a))?.layout.type).toBe('row')
  await expectViewsOverPanes(orbit, [a, bottom])
  expect((await paneBox(orbit.shell, bottom)).x).toBeGreaterThan((await paneBox(orbit.shell, a)).x)
})

test('[SV-04][SV-25] dragging a tab row onto the page makes a split; a full split refuses', async () => {
  const b = await openTab(orbit.app, 'Dragged')
  const a = await openTab(orbit.app, 'Shown')
  await expect.poll(async () => (await tabView(orbit.app, a))?.visible).toBe(true)
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

test('[SV-17] Ctrl+W closes only the focused pane and keeps the others’ arrangement', async () => {
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
  await orbit.shell.keyboard.press('Control+W')
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
  for (let i = 0; i < 3; i++) await action(orbit.app, 'tab.reopenClosed')
  await expect(orbit.shell.getByTestId('split-row').getByTestId('split-segment')).toHaveCount(3)
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
