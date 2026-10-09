import { expect, test } from '@playwright/test'
import {
  activeTabId,
  type Fixtures,
  launchOrbit,
  type Orbit,
  openViaCommandBar,
  startFixtures,
  state,
  tabPage,
  tabView,
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

test('launches with the sidebar and an empty frame', async () => {
  await expect(orbit.shell.getByTestId('sidebar')).toBeVisible()
  await expect(orbit.shell.getByTestId('empty-state')).toBeVisible()
  await expect(orbit.shell.getByTestId('space-name')).toHaveText('Personal')
})

test('opens a page from the command bar into a real web view', async () => {
  await openViaCommandBar(orbit, fx.url('/page/Alpha'))
  const row = orbit.shell.getByTestId('tab-row').first()
  await expect(row).toContainText('Alpha')
  await expect(row).toHaveClass(/is-active/)
  const page = await tabPage(orbit.app, '/page/Alpha')
  await expect(page.locator('#title')).toHaveText('Alpha')
  const id = await activeTabId(orbit.app)
  expect(id).toBeTruthy()
  const view = await tabView(orbit.app, id as string)
  const frame = await orbit.shell.getByTestId('content-frame').boundingBox()
  expect(view?.visible).toBe(true)
  // The native view sits exactly over the shell's content frame.
  expect(Math.abs((view?.bounds.x ?? 0) - (frame?.x ?? 0))).toBeLessThanOrEqual(1)
  expect(Math.abs((view?.bounds.width ?? 0) - (frame?.width ?? 0))).toBeLessThanOrEqual(1)
  await expect(orbit.shell.getByTestId('address-pill')).toContainText('localhost')
  const s = await state(orbit.app)
  expect(Object.keys(s.tabs)).toHaveLength(1)
})
