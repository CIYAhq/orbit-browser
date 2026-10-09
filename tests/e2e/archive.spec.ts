import { expect, test } from '@playwright/test'
import type { ArchivePage } from '../../src/shared/commands/archive'
import { type Fixtures, launchOrbit, MOD, type Orbit, run, startFixtures, state, tabPage } from './helpers'
import { newTab, space, waitTab } from './tabs-support'

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

const query = (o: Orbit, args: Record<string, unknown> = {}) =>
  run(o.app, 'archive.query', args) as Promise<ArchivePage>

test('[AR-01] a closed Today tab is the newest Archive entry, tagged closed, with its Space and its history, across a restart', async () => {
  const { app, shell, userData } = orbit
  const sp = await space(app)
  const t = await newTab(app, fx.url('/page/Kept'))
  await waitTab(app, t, '/page/Kept')
  await (await tabPage(app, '/page/Kept')).click('#next')
  await waitTab(app, t, '/page/Kept-next')
  await shell.keyboard.press(`${MOD}+W`)
  await expect.poll(async () => (await state(app)).tabs[t]).toBeUndefined()
  await expect
    .poll(async () => (await query(orbit)).rows[0])
    .toMatchObject({
      url: fx.url('/page/Kept-next'),
      reason: 'closed',
      section: 'today',
      spaceId: sp.id,
      spaceName: sp.name,
      hasHistory: true,
    })
  // The entry and its history live outside OrbitState too, so they outlast a restart.
  await app.close()
  orbit = await launchOrbit({ userData })
  const after = await query(orbit)
  expect(after.rows[0]).toMatchObject({ url: fx.url('/page/Kept-next'), hasHistory: true })
  expect(after.total).toBe(1)
})
