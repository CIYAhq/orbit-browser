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

test('[FL-01] every CSS animation in the shell and the overlay names keyframes defined in that page', async () => {
  for (const view of ['shell', 'overlay'] as const) {
    const page = await viewPage(orbit.app, view)
    const { used, missing } = await page.evaluate(() => {
      const defined = new Set<string>()
      const used = new Set<string>()
      const walk = (rules: CSSRuleList) => {
        for (const rule of rules) {
          if (rule instanceof CSSKeyframesRule) defined.add(rule.name)
          else if (rule instanceof CSSStyleRule) {
            for (const name of rule.style.animationName.split(',').map((n) => n.trim())) {
              if (name && name !== 'none') used.add(name)
            }
          }
          const nested = (rule as Partial<CSSGroupingRule>).cssRules
          if (nested && !(rule instanceof CSSKeyframesRule)) walk(nested)
        }
      }
      for (const sheet of document.styleSheets) {
        try {
          walk(sheet.cssRules)
        } catch {
          // A sheet the page can't read (none expected).
        }
      }
      return { used: used.size, missing: [...used].filter((name) => !defined.has(name)) }
    })
    // Some animations were read at all (a sheet that couldn't be read would pass with nothing checked).
    expect(used, `${view}: animations found`).toBeGreaterThan(0)
    expect(missing, `${view}: animations without keyframes`).toEqual([])
  }
})
