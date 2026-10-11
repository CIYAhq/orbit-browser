import { expect, type Page, test } from '@playwright/test'
import { launchOrbit, type Orbit, state, tabPage } from './helpers'
import { type PagesFixtures, pageBounds, startPagesFixtures, swipeInfo, swipeOverPage } from './pages-support'
import { activeSpace, createSpace, hoverSidebar, swipe } from './spaces-support'
import { newTab, waitTab } from './tabs-support'

/**
 * Two-finger swipe back and forward over the page (NV-02), with synthetic trackpad scroll events
 * sent through the browser process. A real trackpad's gesture, with the OS's momentum after the
 * fingers lift, is for a person to check on macOS.
 */

let fx: PagesFixtures
let orbit: Orbit

test.beforeAll(async () => {
  fx = await startPagesFixtures()
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

/** The arrow's view: its circle and the room for its shadow (HISTORY_SWIPE.size). */
const SIZE = 56
/** The travel that brings the arrow fully in (HISTORY_SWIPE.distance). */
const DISTANCE = 112

/** A tab that went from `first` to `then`, so it can go back; its window. */
async function tabWithHistory(first: string, then: string) {
  const { app } = orbit
  const tabId = await newTab(app, fx.url(first))
  await waitTab(app, tabId, first)
  await (await tabPage(app, first)).evaluate((to) => location.assign(to), then)
  await waitTab(app, tabId, then)
  const windowId = Object.keys((await state(app)).windows)[0] as string
  const card = (await pageBounds(app, tabId)) as Electron.Rectangle
  return { tabId, windowId, card }
}

/** The arrow's own view. */
async function arrowView() {
  let found: Page | undefined
  await expect
    .poll(() => {
      found = orbit.app.windows().find((p) => p.url().includes('view=swipe'))
      return !!found
    })
    .toBe(true)
  return found as Page
}

/** The swipe has ended and its arrow has gone. */
async function arrowGone(windowId: string) {
  await expect.poll(async () => (await swipeInfo(orbit.app, windowId)).visible).toBe(false)
  await expect.poll(async () => (await swipeInfo(orbit.app, windowId)).tabId).toBeNull()
}

test('[NV-02] a two-finger swipe right over the page goes back once its arrow is fully in; let go sooner, it stays; the other way goes forward', async () => {
  const { app } = orbit
  const { tabId, windowId, card } = await tabWithHistory('/page/One', '/page/Two')
  const two = fx.url('/page/Two')
  const at = { x: 300, y: 300 }
  const top = card.y + Math.round((card.height - SIZE) / 2)

  // 40 px: the arrow comes that far in from the page's left edge, the rest of it past the edge.
  const short = await swipeOverPage(app, windowId, two, at, [-10, -10, -10, -10])
  expect(short).toMatchObject({ visible: true, tabId, direction: 'back', travel: 40, armed: false })
  expect(short?.bounds).toEqual({ x: card.x, y: top, width: 40, height: SIZE })
  const arrow = (await arrowView()).getByTestId('swipe-arrow')
  await expect(arrow).toHaveAttribute('data-direction', 'back')
  await expect(arrow).toHaveAttribute('data-armed', 'false')
  // Let go there: nothing happens.
  await arrowGone(windowId)
  expect((await swipeInfo(app, windowId)).last).toEqual({ direction: 'back', travel: 40, went: false })
  expect((await state(app)).tabs[tabId]?.url).toBe(two)

  // Further: the arrow is fully in and stops there; let go, the page goes back.
  const full = await swipeOverPage(app, windowId, two, at, Array(8).fill(-16))
  expect(full).toMatchObject({ visible: true, direction: 'back', travel: DISTANCE, armed: true })
  expect(full?.bounds).toEqual({ x: card.x + DISTANCE - SIZE, y: top, width: SIZE, height: SIZE })
  await waitTab(app, tabId, '/page/One')
  expect((await swipeInfo(app, windowId)).last).toEqual({ direction: 'back', travel: DISTANCE, went: true })
  // The arrow filled once it was fully in.
  await expect(arrow).toHaveAttribute('data-armed', 'true')
  await arrowGone(windowId)

  // The other way, from the right edge: forward.
  const forward = await swipeOverPage(app, windowId, fx.url('/page/One'), at, Array(8).fill(16))
  expect(forward).toMatchObject({ visible: true, direction: 'forward', armed: true })
  expect(forward?.bounds).toEqual({ x: card.x + card.width - DISTANCE, y: top, width: SIZE, height: SIZE })
  await waitTab(app, tabId, '/page/Two')
  await arrowGone(windowId)

  // Nowhere further forward: no arrow, and nothing happens.
  expect(await swipeOverPage(app, windowId, two, at, Array(8).fill(16))).toBeNull()
  expect((await swipeInfo(app, windowId)).visible).toBe(false)
  expect((await state(app)).tabs[tabId]?.url).toBe(two)
})

test('[NV-02] the page gets the swipe first: a strip that can still scroll that way, or a page that uses the wheel, keeps it; over the sidebar the swipe switches Space and the page stays', async () => {
  const { app, shell } = orbit
  const { tabId, windowId } = await tabWithHistory('/page/Start', '/swipe')
  const url = fx.url('/swipe')
  const page = await tabPage(app, '/swipe')
  const centre = (id: string) =>
    page.evaluate((el) => {
      const r = (document.getElementById(el) as HTMLElement).getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    }, id)
  const stripAt = () => page.evaluate(() => (document.getElementById('strip') as HTMLElement).scrollLeft)

  // The strip can scroll left: it does, and there's no arrow.
  const strip = await centre('strip')
  expect(await swipeOverPage(app, windowId, url, strip, Array(8).fill(-16))).toBeNull()
  await expect.poll(stripAt).toBeLessThan(1000)
  // At its left edge, the same swipe is the page's back.
  await page.evaluate(() => {
    ;(document.getElementById('strip') as HTMLElement).scrollLeft = 0
  })
  await arrowGone(windowId)
  expect(await swipeOverPage(app, windowId, url, strip, [-10, -10, -10, -10])).toMatchObject({
    visible: true,
    direction: 'back',
  })
  await arrowGone(windowId)

  // An area that uses the wheel itself keeps the swipe.
  expect(await swipeOverPage(app, windowId, url, await centre('grab'), Array(8).fill(-16))).toBeNull()
  expect((await state(app)).tabs[tabId]?.url).toBe(url)

  // Over the sidebar the swipe switches Space, and the page stays where it is.
  const space = await activeSpace(app)
  const next = await createSpace(app, { name: 'Beta', activate: false })
  expect(next).not.toBe(space)
  await hoverSidebar(shell)
  await swipe(shell, 10, 13, 10)
  await expect.poll(() => activeSpace(app), { timeout: 3000 }).toBe(next)
  expect((await swipeInfo(app, windowId)).last).toEqual({ direction: 'back', travel: 40, went: false })
  expect((await state(app)).tabs[tabId]?.url).toBe(url)
})
