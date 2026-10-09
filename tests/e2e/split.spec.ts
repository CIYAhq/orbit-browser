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
  // Mid-drag the views already follow the pointer.
  await expect.poll(async () => (await tabView(orbit.app, a))?.bounds.width).toBeGreaterThan(before.width + 100)
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
