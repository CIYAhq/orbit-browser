/**
 * Feel fixes 2 (D91): the gaps sign-off 5 held back in the sidebar, Spaces and profiles, each with a
 * test that fails without its fix (D18).
 */
import { expect, type Page, test } from '@playwright/test'
import { type Recording, record, type Target } from './frames'
import { action, type Fixtures, launchOrbit, type Orbit, openViaCommandBar, startFixtures } from './helpers'
import { act, activeId, cmd, drag, newTab, row, rowIds, settled } from './tabs-support'

let fx: Fixtures
let orbit: Orbit | undefined

test.beforeAll(async () => {
  fx = await startFixtures()
})
test.afterAll(async () => {
  await fx.close()
})
test.afterEach(async () => {
  await orbit?.app.close()
  orbit = undefined
})

async function launch(): Promise<Orbit> {
  orbit = await launchOrbit()
  return orbit
}

// ---------- FL-06: a background tab's row glows once, as it first appears ----------

/** Every tab row, keyed by its tab, with its running animations. */
const ROWS: Record<string, Target> = {
  rows: { selector: '[data-testid="tab-row"]', key: 'data-tab-id', animations: true, matches: ['.is-active'] },
}
const GLOW = 'row-glow'

/** The rows that run their glow now. */
function glowingRows(shell: Page): Promise<string[]> {
  return shell.evaluate((name) => {
    return [...document.querySelectorAll<HTMLElement>('[data-testid="tab-row"]')]
      .filter((el) =>
        el
          .getAnimations()
          .some((a) => a.playState === 'running' && (a instanceof CSSAnimation ? a.animationName : a.id) === name),
      )
      .map((el) => el.dataset.tabId ?? '')
  }, GLOW)
}

/**
 * What a recording shows of one row's glow: the frames that draw the row, those in which it glows,
 * and how many glows it played (each play has a start time of its own: a glow played again, or a CSS
 * animation restarted, has a new one).
 */
function glowOf(rec: Recording, tabId: string) {
  const drawn: number[] = []
  const glowing: number[] = []
  const starts = new Set<number | null>()
  let glowWhileSelected = 0
  for (const f of rec.frames) {
    const box = f.lists.rows?.[tabId]
    if (!box) continue
    drawn.push(f.i)
    const glows = (box.animations ?? []).filter((a) => a.name === GLOW)
    if (!glows.length) continue
    glowing.push(f.i)
    for (const g of glows) starts.add(g.start)
    if (box.matched?.includes('.is-active')) glowWhileSelected++
  }
  // A glow seen before its first frame (no start time yet) and after it is one glow.
  if (starts.size > 1) starts.delete(null)
  return { drawn, glowing, plays: starts.size, glowWhileSelected }
}

/** The tab row the first window shows selected, once main's state and the sidebar agree. */
async function selected(o: Orbit, tabId: string): Promise<void> {
  await expect.poll(() => activeId(o.app)).toBe(tabId)
  await expect(row(o.shell, tabId)).toHaveClass(/is-active/)
}

test('[FL-06][FL-05][TB-04][TB-05][TB-08][SB-22] a background tab’s row glows once, as it first appears: selected, left, dragged past, left by the keyboard, by ⌃Tab or for a new tab, no row glows again, and a tab made selected never glows', async () => {
  const o = await launch()
  const { app, shell } = o
  // A tab made selected, then three made in the background as Orbit starts: their glows play now.
  const first = await newTab(app, fx.url('/page/First'))
  const made: string[] = []
  for (const n of ['GlowA', 'GlowB', 'GlowC']) made.push(await newTab(app, fx.url(`/page/${n}`), { activate: false }))
  const [a, b, c] = made as [string, string, string]
  await expect.poll(() => rowIds(shell, 'today-list')).toEqual([c, b, a, first])
  await settled(shell)
  await expect.poll(() => glowingRows(shell)).toEqual([])

  const rec = await record(shell, ROWS, { maxMs: 90_000 })
  // A tab made in the background: its row glows as it appears.
  const fresh = await newTab(app, fx.url('/page/Fresh'), { activate: false })
  await expect(row(shell, fresh)).toBeVisible()
  await settled(shell)
  await expect.poll(() => glowingRows(shell)).toEqual([])
  // TB-04: a click selects it, and another selects a row beside it.
  await row(shell, fresh).click()
  await selected(o, fresh)
  await row(shell, a).click()
  await selected(o, a)
  // TB-08: a row dragged from the bottom to the top passes it and the rest (a reorder moves their rows).
  const top = await row(shell, fresh).boundingBox()
  if (!top) throw new Error('no row')
  await drag(shell, row(shell, first), { x: top.x + top.width / 2, y: top.y + 4 })
  await expect.poll(() => rowIds(shell, 'today-list')).toEqual([first, fresh, c, b, a])
  await selected(o, first)
  // SB-22: the keyboard in the sidebar moves down a row and Enter opens it.
  await act(app, 'sidebar.focus')
  await expect(row(shell, first)).toHaveClass(/is-focused/)
  await shell.keyboard.press('ArrowDown')
  await expect(row(shell, fresh)).toHaveClass(/is-focused/)
  await shell.keyboard.press('Enter')
  await selected(o, fresh)
  // TB-05: a quick ⌃Tab goes back to the tab used before.
  await cmd(app, 'tabs.focusPage', {})
  await expect
    .poll(() => app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL()))
    .toBe(fx.url('/page/Fresh'))
  // Each key goes to whatever has the keyboard: from the first Tab on, the switcher's overlay.
  await app.evaluate(({ webContents }) => {
    const keys = [
      ['keyDown', 'Control', true],
      ['keyDown', 'Tab', true],
      ['keyUp', 'Tab', true],
      ['keyUp', 'Control', false],
    ] as const
    for (const [type, keyCode, control] of keys) {
      webContents.getFocusedWebContents()?.sendInputEvent({ type, keyCode, modifiers: control ? ['control'] : [] })
    }
  })
  await selected(o, first)
  // A new tab from the command bar: made selected, it doesn't glow, nor does the row it leaves.
  await openViaCommandBar(o, fx.url('/page/Typed'))
  await expect.poll(async () => (await activeId(app)) !== first).toBe(true)
  const typed = (await activeId(app)) as string
  await expect(row(shell, typed)).toHaveClass(/is-active/)
  // FL-07: a background tab moved to Pinned as it glows doesn't glow again in its new place.
  const moved = await newTab(app, fx.url('/page/Moved'), { activate: false })
  await expect(row(shell, moved)).toBeVisible()
  await cmd(app, 'tabs.pin', { tabId: moved })
  await expect(shell.getByTestId('pinned-list').locator(`[data-tab-id="${moved}"]`)).toBeVisible()
  // FL-05: a background tab pressed while it glows, as its row grows in, shows its highlight at once.
  const pressed = await newTab(app, fx.url('/page/Pressed'), { activate: false })
  const slot = shell.locator(`[data-slot][data-key="${pressed}"]`)
  await expect.poll(async () => (await slot.boundingBox())?.height ?? 0).toBeGreaterThan(3)
  const box = await slot.boundingBox()
  if (!box) throw new Error('no row')
  // The row's top shows first, and the rows above it don't move.
  await shell.mouse.click(box.x + box.width / 2, box.y + 2)
  await selected(o, pressed)
  await settled(shell)
  await expect.poll(() => glowingRows(shell)).toEqual([])
  const frames = await rec.stop()

  const glow = (id: string) => glowOf(frames, id)
  // The new background tab's row glowed, once, from the first frame that drew it.
  const f = glow(fresh)
  expect(f.drawn.length, 'the background tab’s row was drawn').toBeGreaterThan(0)
  expect.soft(f.plays, 'its row glowed once').toBe(1)
  expect.soft(f.glowing[0], 'from the first frame that drew it').toBe(f.drawn[0])
  // No row glowed again: not when it was left, dragged past, or left by the keyboard, ⌃Tab or a new tab.
  for (const [name, id] of Object.entries({ first, a, b, c })) {
    expect.soft(glow(id).plays, `${name}’s row, made before the recording, doesn’t glow again`).toBe(0)
  }
  expect.soft(glow(typed).plays, 'a tab made selected never glows').toBe(0)
  expect.soft(glow(moved).plays, 'a row moved as it glows doesn’t glow again').toBe(1)
  expect.soft(glow(pressed).plays, 'the pressed row glowed').toBe(1)
  expect.soft(glow(pressed).glowWhileSelected, 'selected, it shows its highlight, not the glow').toBe(0)
})

for (const how of ['switch', 'system'] as const) {
  test(`[FL-06][FL-28] reduced motion (${how === 'switch' ? 'Orbit’s switch' : 'the system setting'}): a background tab’s row appears without the glow`, async () => {
    const o = await launch()
    const { app, shell } = o
    if (how === 'switch') await action(app, 'app.toggleReduceMotion')
    else await shell.emulateMedia({ reducedMotion: 'reduce' })
    await expect(shell.locator('html')).toHaveClass(/\breduce-motion\b/)
    const began = Date.now()
    const rec = await record(shell, ROWS, { maxMs: 30_000 })
    const quiet = await newTab(app, fx.url('/page/Quiet'), { activate: false })
    await expect(row(shell, quiet)).toBeVisible()
    // Longer than the glow would last after the row showed.
    const frames = await rec.until(Date.now() - began + 800)
    const g = glowOf(frames, quiet)
    expect(g.drawn.length, 'the row was drawn').toBeGreaterThan(0)
    expect(g.glowing, 'and never glowed').toEqual([])
  })
}
