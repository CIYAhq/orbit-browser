import { expect, test } from '@playwright/test'
import type { MainContext } from '../../src/main/context'
import { type Fixtures, launchOrbit, type Orbit, run, startFixtures, state, tabPage } from './helpers'

/**
 * Core main-process behaviour (store, sessions, windows, persistence). Titles carry
 * the review item they guard (PR-1 review: M*, F*) after any spec feature IDs.
 */

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
  await orbit.app.close().catch(() => {})
})

/** The main process's test handle (src/main/test-hooks.ts), for app.evaluate() bodies. */
type OrbitGlobal = { __orbit: { ctx: MainContext } }

test('[NV-15] permission checks report only what the user allowed, per profile (review M5)', async () => {
  const url = fx.url('/page/Perm')
  const tabId = (await run(orbit.app, 'tabs.create', { url })) as string
  const page = await tabPage(orbit.app, '/page/Perm')
  await expect(page.locator('#title')).toHaveText('Perm')
  const probe = () =>
    page.evaluate(async () => ({
      notification: Notification.permission,
      notifications: (await navigator.permissions.query({ name: 'notifications' })).state,
      geolocation: (await navigator.permissions.query({ name: 'geolocation' })).state,
    }))
  // Electron's check handler is boolean, so "not decided" reads as 'denied' rather than Chromium's
  // 'default'. What matters: nothing is reported granted before the user allows it.
  const fresh = await probe()
  expect(fresh.notification).not.toBe('granted')
  expect(fresh.notifications).not.toBe('granted')
  expect(fresh.geolocation).not.toBe('granted')

  // Allowing notifications for this origin in this profile grants exactly that.
  const s = await state(orbit.app)
  const partition = s.profiles[s.tabs[tabId]?.profileId as string]?.partition as string
  await orbit.app.evaluate(
    (_e, [p, o]) => (globalThis as unknown as OrbitGlobal).__orbit.ctx.sessions.decide(p, o, 'notifications', true),
    [partition, new URL(url).origin] as const,
  )
  const allowed = await probe()
  expect(allowed.notification).toBe('granted')
  expect(allowed.geolocation).not.toBe('granted')

  // Another profile does not inherit the decision.
  const profileId = (await run(orbit.app, 'profiles.create', { name: 'Work' })) as string
  const spaceId = (await run(orbit.app, 'spaces.create', { name: 'Work', profileId })) as string
  await run(orbit.app, 'tabs.create', { url: `${url}?bg=%23eeeeee`, spaceId })
  const other = await tabPage(orbit.app, '/page/Perm?bg')
  await expect(other.locator('#title')).toHaveText('Perm')
  expect(await other.evaluate(() => Notification.permission)).not.toBe('granted')
})
