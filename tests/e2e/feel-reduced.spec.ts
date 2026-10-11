/**
 * FL-28 / AP-17: Orbit's own Reduce motion setting. Off follows the system; on forces reduced motion
 * in every Orbit view whatever the system says. Checks of single surfaces are here (toasts) or in
 * the feel specs of those surfaces (the Space cross-fade, the command bar's fade).
 */
import { expect, type Page, test } from '@playwright/test'
import { motionOf, note, type Recording, record, rotation, series } from './frames'
import { action, FRAME_SLACK, launchOrbit, type Orbit, run, state, tabPage, viewPage } from './helpers'
import { openSettings } from './settings-support'
import { settled } from './tabs-support'

let orbit: Orbit

test.beforeEach(async () => {
  orbit = await launchOrbit()
})
test.afterEach(async () => {
  await orbit.app.close()
})

const reduced = /\breduce-motion\b/

test('[FL-28][AP-17] the Settings switch forces reduced motion in every view, and off follows the system again', async () => {
  const { app, shell } = orbit
  const overlay = await viewPage(app, 'overlay')
  await expect(shell.locator('html')).not.toHaveClass(reduced)
  const settings = await openSettings(app, { section: 'appearance' })
  const toggle = settings.getByTestId('settings-reduce-motion')
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect.poll(async () => (await state(app)).settings.reduceMotion).toBe(true)
  for (const page of [shell, overlay, settings]) await expect(page.locator('html')).toHaveClass(reduced)
  await toggle.click()
  await expect.poll(async () => (await state(app)).settings.reduceMotion).toBe(false)
  for (const page of [shell, overlay, settings]) await expect(page.locator('html')).not.toHaveClass(reduced)
  // Off follows the system: a system asking for reduced motion turns it on without the setting.
  await shell.emulateMedia({ reducedMotion: 'reduce' })
  await expect(shell.locator('html')).toHaveClass(reduced)
  await shell.emulateMedia({ reducedMotion: 'no-preference' })
  await expect(shell.locator('html')).not.toHaveClass(reduced)
})

test('[FL-28] "Toggle Reduce Motion" turns the setting on and off', async () => {
  const { app, shell } = orbit
  await action(app, 'app.toggleReduceMotion')
  await expect.poll(async () => (await state(app)).settings.reduceMotion).toBe(true)
  await expect(shell.locator('html')).toHaveClass(reduced)
  await action(app, 'app.toggleReduceMotion')
  await expect.poll(async () => (await state(app)).settings.reduceMotion).toBe(false)
  await expect(shell.locator('html')).not.toHaveClass(reduced)
})

/** Shows a toast in the shell the way main does (`windows.sendToWindow(…, 'toast', …)`). */
async function toast(message: string): Promise<void> {
  await orbit.app.evaluate(({ webContents }, text) => {
    const shell = webContents.getAllWebContents().find((w) => w.getURL().includes('view=shell'))
    if (!shell) throw new Error('no shell')
    shell.send('orbit:toast', { message: text })
  }, message)
}

/** Turns reduced motion on: Orbit's switch, or the system's setting as the shell's renderer sees it. */
async function reduce(how: 'switch' | 'system', shell: Page): Promise<void> {
  if (how === 'switch') await action(orbit.app, 'app.toggleReduceMotion')
  else await shell.emulateMedia({ reducedMotion: 'reduce' })
  await expect(shell.locator('html')).toHaveClass(reduced)
}

for (const how of ['switch', 'system'] as const) {
  test(`[FL-28][FL-22] reduced motion (${how === 'switch' ? 'Orbit’s switch' : 'the system setting'}): a toast fades in where it rests, at its size, pushes the older one up at once, and fades out where it rests`, async () => {
    const { shell } = orbit
    await reduce(how, shell)
    const rec = await record(
      shell,
      { toasts: { selector: '[data-testid="toast"]', key: 'data-toast-id' } },
      { maxMs: 6000 },
    )
    await toast('First toast')
    await shell.waitForTimeout(400)
    await toast('Second toast')
    // The first leaves 3 s after it came (FL-22).
    await expect(shell.getByTestId('toast')).toHaveCount(1, { timeout: 6000 })
    const r = await rec.stop()
    const seen: string[] = []
    for (const f of r.frames)
      for (const key of Object.keys(f.lists.toasts ?? {})) if (!seen.includes(key)) seen.push(key)
    expect(seen, 'toasts seen').toHaveLength(2)
    const [one, two] = seen as [string, string]
    type F = Recording['frames'][number]
    const firstIn = r.frames.find((f) => f.lists.toasts?.[one]) as F
    const secondIn = r.frames.find((f) => f.lists.toasts?.[two]) as F
    const alone = r.frames.filter((f) => f.i < secondIn.i && f.lists.toasts?.[one])
    const start = firstIn.lists.toasts?.[one]
    const end = alone.at(-1)?.lists.toasts?.[one]
    if (!start || !end) throw new Error('the first toast was not drawn')
    // In: where it rests and at its size from its first frame (motion's rise and scale are moves).
    const rise = start.y - end.y
    const scale0 = start.width / end.width
    const peak = Math.max(...alone.map((f) => (f.lists.toasts?.[one]?.width ?? 0) / end.width))
    const opaque = alone.find((f) => (f.lists.toasts?.[one]?.opacity ?? 0) >= 0.99)
    // Pushed up as the second comes: the frames in which the older toast moves, until it has long
    // settled (it leaves about 2.6 s after the second came).
    const settled = secondIn.t + 1000
    const pushed = motionOf(
      series(r, 'toasts', (b) => b.y, one).filter((p) => p.t >= (alone.at(-1)?.t ?? 0) && p.t <= settled),
    )
    note('FL-28', `toast (${how}): first frame below its place`, rise, '0 px (no rise)', 'px')
    note('FL-28', `toast (${how}): first frame scale`, scale0, '1 (no scale)', '×')
    note('FL-28', `toast (${how}): largest scale`, peak, '1 (no spring)', '×')
    note(
      'FL-28',
      `toast (${how}): fade in`,
      opaque ? opaque.t - firstIn.t : undefined,
      'a short fade (≈ 100–150 ms) or none',
    )
    note('FL-28', `toast (${how}): frames the older toast moves when pushed`, pushed.moving, '1 (at once)', 'frames')
    // Out: it fades where it rests (FL-22's 8 px drop is a move).
    const later = r.frames.filter((f) => f.t >= settled && (f.lists.toasts?.[one]?.opacity ?? 0) > 0.01)
    const rest = later[0]?.lists.toasts?.[one]
    if (!rest) throw new Error('the first toast was gone before it settled')
    const drop = Math.max(...later.map((f) => Math.abs((f.lists.toasts?.[one]?.y ?? rest.y) - rest.y)))
    const fading = later.filter((f) => (f.lists.toasts?.[one]?.opacity ?? 1) < 0.99)
    note('FL-28', `toast (${how}): furthest from its place while it fades out`, drop, '0 px (no drop)', 'px')
    note('FL-28', `toast (${how}): frames of the fade out`, fading.length, 'a fade (≥ 2)', 'frames')
    expect(Math.abs(rise), 'no rise').toBeLessThanOrEqual(0.5)
    expect(scale0, 'no scale').toBeGreaterThanOrEqual(0.995)
    expect(peak, 'no spring').toBeLessThanOrEqual(1.005)
    expect(pushed.travel, 'the older toast moves up').toBeGreaterThan(20)
    expect(pushed.moving, 'the older toast moves up at once').toBe(1)
    expect(drop, 'no drop as it leaves').toBeLessThanOrEqual(0.5)
    expect(fading.length, 'it fades out').toBeGreaterThanOrEqual(2)
  })
}

/**
 * Reduced motion is switched on while Orbit runs, so it must reach what is already on screen, not
 * only what mounts after it: motion reads its config once, as each element is made (fix check N1).
 */
const settingName = (how: 'switch' | 'system') => (how === 'switch' ? 'Orbit’s switch' : 'the system setting')

/** Waits until the Favorites tiles stand still: the same boxes and opacity two frames apart. */
async function tilesStill(shell: Page): Promise<void> {
  await expect
    .poll(() =>
      shell.evaluate(async () => {
        const boxes = () =>
          [...document.querySelectorAll('[data-testid="favorite-tile"]')]
            .map((el) => {
              const b = el.getBoundingClientRect()
              return `${b.x},${b.y},${b.width},${b.height},${getComputedStyle(el).opacity}`
            })
            .join(';')
        const before = boxes()
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        return before === boxes()
      }),
    )
    .toBe(true)
}

const TILES = { selector: '[data-testid="favorite-tile"]', key: 'data-fav-id' }

/** The tiles' edges that moved more than 2 px in a recording, each with the frames it moved in. */
function tileMoves(r: Recording, ids: string[]) {
  return ids
    .flatMap((id) =>
      (['x', 'y', 'width'] as const).map((k) => ({ id, k, ...motionOf(series(r, 'tiles', (b) => b[k], id)) })),
    )
    .filter((m) => m.travel > 2)
}

for (const how of ['switch', 'system'] as const) {
  test(`[FL-28][FL-20] reduced motion turned on (${settingName(how)}) while the Favorites show: a new tile fades in at its size, the others move at once, and a removed tile fades where it was, at its size`, async () => {
    const { app, shell } = orbit
    const tabs: string[] = []
    for (let k = 0; k < 4; k++)
      tabs.push((await run(app, 'tabs.create', { url: `about:blank#fav${k}`, activate: false })) as string)
    for (const id of tabs.slice(0, 3)) await run(app, 'tabs.favorite', { tabId: id })
    await expect(shell.getByTestId('favorite-tile')).toHaveCount(3)
    await settled(shell)
    await tilesStill(shell)
    // The tiles are on screen; reduced motion comes on while they stay.
    await reduce(how, shell)

    const added = await record(shell, { tiles: TILES })
    await run(app, 'tabs.favorite', { tabId: tabs[3] })
    await expect(shell.getByTestId('favorite-tile')).toHaveCount(4)
    const a = await added.until(700)
    const fresh = tabs[3] as string
    const drawn = a.frames.filter((f) => f.lists.tiles?.[fresh])
    const first = drawn[0]?.lists.tiles?.[fresh]
    const end = drawn.at(-1)?.lists.tiles?.[fresh]
    if (!first || !end) throw new Error('the new tile never showed')
    const grown = drawn.map((f) => (f.lists.tiles?.[fresh]?.width ?? 0) / end.width)
    const reflow = tileMoves(a, tabs.slice(0, 3))

    await tilesStill(shell)
    const removed = await record(shell, { tiles: TILES })
    await run(app, 'tabs.unfavorite', { tabId: tabs[0] })
    await expect(shell.getByTestId('favorite-tile')).toHaveCount(3)
    const rm = await removed.until(600)
    const gone = tabs[0] as string
    const size0 = rm.frames[0]?.lists.tiles?.[gone]?.width ?? 0
    const leaving = rm.frames.map((f) => f.lists.tiles?.[gone]).filter((b) => !!b && b.opacity > 0.01)
    const sizes = leaving.map((b) => (b?.width ?? 0) / size0)
    const fading = rm.frames.filter((f) => {
      const b = f.lists.tiles?.[gone]
      return !!b && b.opacity > 0.01 && b.opacity < 0.99
    })
    // From the frame before the first faded one to the last: each frame shows for one frame.
    const fadeMs = (fading.at(-1)?.t ?? 0) - (fading[0]?.t ?? 0) + 1000 / 60
    const closing = tileMoves(rm, tabs.slice(1))

    const what = `Favorites (${how}, on after they showed)`
    note('FL-28', `${what}: new tile, first frame scale`, first.width / end.width, '1 (no pop)', '×')
    note('FL-28', `${what}: new tile, largest scale`, Math.max(...grown), '1 (no pop)', '×')
    note(
      'FL-28',
      `${what}: other tiles, frames moving`,
      Math.max(0, ...reflow.map((m) => m.moving)),
      '1 (at once)',
      'frames',
    )
    note('FL-28', `${what}: removed tile, smallest scale`, Math.min(...sizes), '1 (no shrink)', '×')
    note('FL-28', `${what}: removed tile, frames shown faded`, fadeMs, '≤ 150 ms (a 120 ms fade)')
    note(
      'FL-28',
      `${what}: closing up, frames moving`,
      Math.max(0, ...closing.map((m) => m.moving)),
      '1 (at once)',
      'frames',
    )
    expect(first.width / end.width, 'the new tile shows at its size').toBeGreaterThanOrEqual(0.995)
    expect(Math.max(...grown), 'no pop').toBeLessThanOrEqual(1.005)
    expect(reflow.length, 'the other tiles make room').toBeGreaterThan(0)
    for (const m of reflow) expect(m.moving, `tile ${m.id}'s ${m.k} moves at once`).toBe(1)
    expect(sizes.length, 'the removed tile is drawn as it goes').toBeGreaterThan(0)
    expect(Math.min(...sizes), 'the removed tile keeps its size').toBeGreaterThanOrEqual(0.995)
    expect(Math.max(...sizes), 'the removed tile keeps its size').toBeLessThanOrEqual(1.005)
    expect(fading.length, 'the removed tile fades').toBeGreaterThanOrEqual(1)
    expect(fadeMs, 'a short fade (about 100–150 ms)').toBeLessThanOrEqual((150 + 1000 / 60) * FRAME_SLACK)
    expect(closing.length, 'the grid closes up').toBeGreaterThan(0)
    for (const m of closing) expect(m.moving, `tile ${m.id}'s ${m.k} closes up at once`).toBe(1)
  })
}

test('[FL-28][FL-12] reduced motion turned on after a folder was opened: closing it, the content below moves up at once and the chevron turns at once; the pinned section collapses the same way', async () => {
  const { app, shell } = orbit
  const tabs: string[] = []
  for (let k = 0; k < 6; k++)
    tabs.push((await run(app, 'tabs.create', { url: `about:blank#g${k}`, activate: false })) as string)
  const space = Object.values((await state(app)).windows)[0]?.spaceId as string
  await run(app, 'folders.create', { container: { kind: 'pinned', spaceId: space }, name: 'Box', items: tabs })
  const folderRow = shell.getByTestId('folder-row')
  await expect(folderRow).toBeVisible()
  if ((await folderRow.getAttribute('aria-expanded')) !== 'true') {
    await folderRow.click()
    await expect(folderRow).toHaveAttribute('aria-expanded', 'true')
  }
  await settled(shell)
  await shell.waitForTimeout(300)
  // The folder is open and the pinned section shown; reduced motion comes on while they stay.
  await reduce('switch', shell)
  const targets = {
    chevron: { selector: '[data-testid="folder-row"] .folder-row__chevron-wrap', style: ['transform'] },
    caret: { selector: '[data-testid="pinned-toggle"] .space-header__caret-glyph', style: ['transform'] },
    divider: '[data-testid="today-divider"]',
  }
  const turn = (r: Recording, el: 'chevron' | 'caret') =>
    motionOf(r.frames.map((f) => ({ t: f.t, v: rotation(f.els[el]?.style?.transform) })))

  const close = await record(shell, targets)
  await folderRow.click()
  await expect(folderRow).toHaveAttribute('aria-expanded', 'false')
  const c = await close.until(600)
  const below = motionOf(series(c, 'divider', (b) => b.y))
  const chevron = turn(c, 'chevron')

  await settled(shell)
  await shell.waitForTimeout(300)
  const toggle = shell.getByTestId('pinned-toggle')
  const collapse = await record(shell, targets)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  const p = await collapse.until(600)
  const pinnedBelow = motionOf(series(p, 'divider', (b) => b.y))
  const caret = turn(p, 'caret')

  note(
    'FL-28',
    'folder (on after it opened) closing: content below, frames moving',
    below.moving,
    '1 (at once)',
    'frames',
  )
  note('FL-28', 'folder (on after it opened) closing: chevron, frames turning', chevron.moving, '1 (at once)', 'frames')
  note(
    'FL-28',
    'pinned section (on after it showed) collapsing: content below, frames moving',
    pinnedBelow.moving,
    '1 (at once)',
    'frames',
  )
  note(
    'FL-28',
    'pinned section (on after it showed) collapsing: caret, frames turning',
    caret.moving,
    '1 (at once)',
    'frames',
  )
  expect(below.travel, 'the content below moves up by the six rows').toBeGreaterThan(150)
  expect(below.moving, 'the content below moves up at once').toBe(1)
  expect(chevron.travel, 'the chevron turns a quarter').toBeCloseTo(90, 0)
  expect(chevron.moving, 'the chevron turns at once').toBe(1)
  expect(pinnedBelow.travel, 'the content below moves up by the folder row').toBeGreaterThan(20)
  expect(pinnedBelow.moving, 'the content below moves up at once').toBe(1)
  expect(caret.travel, 'the caret turns a quarter').toBeCloseTo(90, 0)
  expect(caret.moving, 'the caret turns at once').toBe(1)
})

test('[FL-28][FL-15] reduced motion turned on while the sidebar shows: pressing the "+" or a Favorite doesn’t nudge it', async () => {
  const { app, shell } = orbit
  const tab = (await run(app, 'tabs.create', { url: 'about:blank#press', activate: false })) as string
  await run(app, 'tabs.favorite', { tabId: tab })
  await expect(shell.getByTestId('favorite-tile')).toHaveCount(1)
  await settled(shell)
  await reduce('switch', shell)
  /** The element's scale while the pointer holds it down for 250 ms (a press scales within 150 ms). */
  const pressed = async (selector: string) => {
    const box = await shell.locator(selector).boundingBox()
    if (!box) throw new Error(`${selector} isn't drawn`)
    await shell.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await shell.mouse.down()
    await shell.waitForTimeout(250)
    const scale = await shell.locator(selector).evaluate((el) => {
      const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(el).transform)
      const [a = 1, b = 0] = m ? (m[1] as string).split(',').map(Number) : []
      return Math.hypot(a, b)
    })
    await shell.mouse.up()
    return scale
  }
  const tile = await pressed(`[data-testid="favorite-tile"][data-fav-id="${tab}"]`)
  const plus = await pressed('.new-tab-button__plus')
  note('FL-28', 'Favorite tile pressed (on after it showed): scale', tile, '1 (no nudge)', '×')
  note('FL-28', '"+" pressed (on after it showed): scale', plus, '1 (no nudge)', '×')
  expect(tile, 'a pressed Favorite keeps its size').toBeCloseTo(1, 3)
  expect(plus, 'the pressed "+" keeps its size').toBeCloseTo(1, 3)
})

test('[FL-28][FL-26][TB-05] reduced motion turned on after the overlay is up: the recent-tab list shows at full strength in its first frame', async () => {
  const { app } = orbit
  const overlay = await viewPage(app, 'overlay')
  for (const name of ['a', 'b', 'c']) await run(app, 'tabs.create', { url: `about:blank#${name}` })
  await run(app, 'tabs.focusPage', {})
  const focused = () => app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL() ?? '')
  await expect.poll(focused).toBe('about:blank#c')
  await action(app, 'app.toggleReduceMotion')
  await expect(overlay.locator('html')).toHaveClass(reduced)
  type Mod = 'control'
  const keys = (...events: [type: 'keyDown' | 'keyUp', keyCode: string, modifiers: Mod[]][]) =>
    app.evaluate(({ webContents }, list) => {
      for (const [type, keyCode, modifiers] of list)
        webContents.getFocusedWebContents()?.sendInputEvent({ type, keyCode, modifiers })
    }, events)
  const rec = await record(overlay, { list: '[data-testid="tab-switcher"]' }, { maxMs: 5000, hidden: true })
  // Held ⌃, two quick Tabs: the list at once.
  await keys(
    ['keyDown', 'Control', ['control']],
    ['keyDown', 'Tab', ['control']],
    ['keyUp', 'Tab', ['control']],
    ['keyDown', 'Tab', ['control']],
    ['keyUp', 'Tab', ['control']],
  )
  await expect(overlay.getByTestId('tab-switcher')).toBeVisible()
  await overlay.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
  const r = await rec.stop()
  const first = r.frames.find((f) => f.els.list)
  note(
    'FL-28',
    'recent-tab list (on after the overlay was up): opacity in its first frame',
    first?.els.list?.opacity,
    '1',
    '',
  )
  expect(first?.els.list?.opacity, 'the list shows at once, at full strength').toBeGreaterThanOrEqual(0.999)
  await keys(['keyDown', 'Escape', ['control']], ['keyUp', 'Escape', ['control']], ['keyUp', 'Control', []])
  await expect.poll(async () => Object.values((await state(app)).windows)[0]?.overlay.kind).toBe('none')
})

test('[FL-28][TB-15] reduced motion turned on while a Favorite plays sound: its notes stand still', async () => {
  const { app, shell } = orbit
  const tab = (await run(app, 'tabs.create', { url: 'about:blank#tune', activate: true })) as string
  await run(app, 'tabs.favorite', { tabId: tab })
  await (await tabPage(app, 'about:blank#tune')).evaluate(() => {
    const audio = new AudioContext()
    const tone = audio.createOscillator()
    const gain = audio.createGain()
    gain.gain.value = 0.05
    tone.connect(gain).connect(audio.destination)
    tone.start()
  })
  const notes = shell.locator(`[data-fav-id="${tab}"] .favorite__note`)
  await expect(notes).toHaveCount(2)
  const looks = () =>
    notes.evaluateAll((els) => els.map((el) => `${getComputedStyle(el).animationName} ${getComputedStyle(el).opacity}`))
  expect((await looks()).map((l) => l.split(' ')[0])).toEqual(['favorite-note', 'favorite-note'])
  await reduce('switch', shell)
  await expect.poll(looks).toEqual(['none 1', 'none 1'])
})
