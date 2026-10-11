/**
 * FL-28 / AP-17: Orbit's own Reduce motion setting. Off follows the system; on forces reduced motion
 * in every Orbit view whatever the system says. Checks of single surfaces are here (toasts) or in
 * the feel specs of those surfaces (the Space cross-fade, the command bar's fade).
 */
import { expect, type Page, test } from '@playwright/test'
import { motionOf, note, type Recording, record, series } from './frames'
import { action, launchOrbit, type Orbit, state, viewPage } from './helpers'
import { openSettings } from './settings-support'

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
  test(`[FL-28][FL-22] reduced motion (${how === 'switch' ? 'Orbit’s switch' : 'the system setting'}): a toast fades in where it rests, at its size, and pushes the older one up at once`, async () => {
    const { shell } = orbit
    await reduce(how, shell)
    const rec = await record(
      shell,
      { toasts: { selector: '[data-testid="toast"]', key: 'data-toast-id' } },
      { maxMs: 3000 },
    )
    await toast('First toast')
    await shell.waitForTimeout(400)
    await toast('Second toast')
    await shell.waitForTimeout(400)
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
    // Pushed up as the second comes: the frames in which the older toast moves.
    const pushed = motionOf(series(r, 'toasts', (b) => b.y, one).filter((p) => p.t >= (alone.at(-1)?.t ?? 0)))
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
    expect(Math.abs(rise), 'no rise').toBeLessThanOrEqual(0.5)
    expect(scale0, 'no scale').toBeGreaterThanOrEqual(0.995)
    expect(peak, 'no spring').toBeLessThanOrEqual(1.005)
    expect(pushed.travel, 'the older toast moves up').toBeGreaterThan(20)
    expect(pushed.moving, 'the older toast moves up at once').toBe(1)
  })
}
