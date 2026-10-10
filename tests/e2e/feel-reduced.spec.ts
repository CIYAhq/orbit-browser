/**
 * FL-28 / AP-17: Orbit's own Reduce motion setting. Off follows the system; on forces reduced motion
 * in every Orbit view whatever the system says. The per-surface checks (the Space cross-fade, the
 * command bar's fade) are in the feel specs of those surfaces.
 */
import { expect, test } from '@playwright/test'
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
