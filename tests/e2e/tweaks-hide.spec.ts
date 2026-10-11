import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { launchOrbit, type Orbit, run, state } from './helpers'
import { cmd } from './tabs-support'
import {
  editorInfo,
  editorPage,
  mark,
  marked,
  newDocument,
  openFixture,
  pickerInfo,
  startTweakFixtures,
  type TweakFixtures,
  waitEditor,
} from './tweaks-support'

/** Hide-element mode (BO-10). Feature IDs lead each title. */

let fx: TweakFixtures
let orbit: Orbit | undefined

test.beforeAll(async () => {
  fx = await startTweakFixtures()
})
test.afterAll(async () => {
  await fx.close()
})
test.afterEach(async () => {
  await orbit?.app.close()
  orbit = undefined
})

const openPage = (app: ElectronApplication, path: string) => openFixture(app, fx, path)

/** A new Tweak for a tab's site, made as New Tweak… does, its editor open (the intro already read). */
async function newTweak(app: ElectronApplication, tabId: string): Promise<{ id: string; view: Page }> {
  await run(app, 'tweaks.dismissIntro', {})
  const id = (await run(app, 'tweaks.create', { tabId })) as string
  await waitEditor(app, true)
  return { id, view: await editorPage(app) }
}

const hiddenOf = async (app: ElectronApplication, id: string) => (await state(app)).tweaks[id]?.style.hidden ?? []

/** How many of a selector's elements the page displays. */
const shown = (page: Page, selector: string) =>
  page.evaluate(
    (s) => [...document.querySelectorAll(s)].filter((el) => getComputedStyle(el).display !== 'none').length,
    selector,
  )

/** What the `/cards` page's first frame showed. */
const firstShown = (page: Page) => page.evaluate(() => (window as unknown as { __first?: unknown }).__first)

const clicks = (page: Page) => page.evaluate(() => (window as unknown as { __clicks?: number }).__clicks)

/** A point just inside an element's corner: in its own padding, not on a child. */
async function corner(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).first().boundingBox()
  if (!box) throw new Error(`no ${selector}`)
  return { x: box.x + 4, y: box.y + 4 }
}

/** Turns Hide-element mode on, and waits until the picker is in the page. */
async function hideMode(view: Page): Promise<void> {
  await view.getByTestId('tweak-hide-button').click()
  await expect(view.getByTestId('tweak-hide-hint')).toBeVisible()
  await expect(view.getByTestId('tweak-hide-button')).toHaveAttribute('aria-pressed', 'true')
}

/** Points at an element in the page and clicks it, as a hand does. */
async function pick(page: Page, selector: string): Promise<void> {
  const at = await corner(page, selector)
  await page.mouse.move(at.x, at.y)
  await page.mouse.click(at.x, at.y)
}

test('[BO-10] Hide-element mode outlines what is under the pointer and picks it on a click, the page acting on neither; "Hide this" hides it at once, as plain CSS, from the first frame of later loads and on the site’s other pages; the picker never runs in the page’s own world, and Done takes it away', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const { tabId, page } = await openPage(app, '/cards/Hide')
  const { id, view } = await newTweak(app, tabId)
  const url = page.url()
  await mark(page)
  await hideMode(view)
  // The picker lives in a world of its own: the page's sees nothing of it.
  expect(await page.evaluate(() => typeof (window as unknown as { __orbitHide?: unknown }).__orbitHide)).toBe(
    'undefined',
  )

  // What is under the pointer is outlined.
  const promo = await corner(page, '#promo')
  await page.mouse.move(promo.x, promo.y)
  await expect.poll(async () => (await pickerInfo(app, tabId))?.hovered).toBe('#promo')
  expect((await pickerInfo(app, tabId))?.outlined).toBe(1)
  const count = await corner(page, '#count')
  await page.mouse.move(count.x, count.y)
  await expect.poll(async () => (await pickerInfo(app, tabId))?.hovered).toBe('#count')

  // A click picks, and the page doesn't act on it: the button doesn't count, the link doesn't go.
  await page.mouse.click(count.x, count.y)
  await expect(view.getByTestId('tweak-hide-label')).toHaveText('Count')
  await page.mouse.click(promo.x, promo.y)
  await expect(view.getByTestId('tweak-hide-label')).toHaveText('Big promo')
  expect(await pickerInfo(app, tabId)).toEqual({ hovered: null, picked: '#promo', outlined: 1 })
  expect(await clicks(page)).toBeUndefined()
  expect([page.url(), await marked(page)]).toEqual([url, true])

  // Hide this: gone at once, saved as a plain selector; the mode stays for the next pick.
  await view.getByTestId('tweak-hide-this').click()
  await expect.poll(() => shown(page, '#promo')).toBe(0)
  expect(await hiddenOf(app, id)).toEqual([{ id: expect.any(String), selector: '#promo', label: 'Big promo' }])
  await expect(view.getByTestId('tweak-hide-hint')).toBeVisible()
  expect(await shown(page, '#weather, .story')).toBe(1 + 9)

  // Done: the picker and its layer leave the page, and the page takes clicks again.
  await view.getByTestId('tweak-hide-done').click()
  await expect(view.getByTestId('tweak-hide')).toHaveCount(0)
  await expect(view.getByTestId('tweak-hide-button')).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(() => pickerInfo(app, tabId)).toBeNull()
  expect(await page.evaluate(() => document.documentElement.children.length)).toBe(2)
  const button = await corner(page, '#count')
  await page.mouse.click(button.x, button.y)
  await expect.poll(() => clicks(page)).toBe(1)

  // From the first frame of a reload, and of the site's other pages.
  await cmd(app, 'tabs.reload', { tabId })
  await newDocument(page)
  expect(await firstShown(page)).toEqual({ promo: false, weather: true, stories: 9 })
  await mark(page)
  await cmd(app, 'tabs.navigate', { tabId, url: fx.url('/cards/Other') })
  await newDocument(page)
  expect(await firstShown(page)).toEqual({ promo: false, weather: true, stories: 9 })
})

test('[BO-10] "Hide all similar" hides the picked element and those like it, narrow to broad on a slider that counts them (and those the page shows, where fewer) and outlines them in the page; Esc in the page drops the pick, then leaves the mode; Esc in the panel does the same, then closes the editor', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  // The feed has a fifth story the page itself hides.
  const { tabId, page } = await openPage(app, '/cards/Similar?hidden=1')
  const { id, view } = await newTweak(app, tabId)
  await hideMode(view)
  await pick(page, 'main.feed article.story')
  await expect(view.getByTestId('tweak-hide-label')).toHaveText('Story one About one')

  // Narrowest first: the feed's five stories, four shown; then every story card, seven, six shown;
  // then all ten stories, nine shown. Only those shown have an outline.
  const count = view.getByTestId('tweak-hide-count')
  const breadth = view.getByTestId('tweak-hide-breadth')
  const outlined = async () => (await pickerInfo(app, tabId))?.outlined
  await expect(count).toHaveText('5 (4 shown)')
  await expect(breadth).toHaveAttribute('max', '2')
  await view.getByTestId('tweak-hide-similar').hover()
  await expect.poll(outlined).toBe(4)
  for (const [level, n] of [
    ['1', 7],
    ['2', 10],
    ['1', 7],
  ] as const) {
    await breadth.fill(level)
    await expect(count).toHaveText(`${n} (${n - 1} shown)`)
    await expect.poll(outlined).toBe(n - 1)
  }
  await view.getByTestId('tweak-hide-similar').click()
  await expect.poll(() => shown(page, 'article.story')).toBe(0)
  expect(await shown(page, 'li.story, #promo, #weather')).toBe(5)
  expect(await hiddenOf(app, id)).toEqual([
    { id: expect.any(String), selector: 'article.story', label: 'Story one About one and similar (7)' },
  ])
  // Where every match shows, the count is just the number.
  await pick(page, 'li.story')
  await expect(view.getByTestId('tweak-hide-label')).toHaveText('Link one')
  await expect(count).toHaveText('3')

  // Esc in the page: the pick goes first, then the mode.
  await pick(page, '#weather')
  await expect(view.getByTestId('tweak-hide-label')).toHaveText('Weather')
  await page.keyboard.press('Escape')
  await expect(view.getByTestId('tweak-hide-hint')).toBeVisible()
  expect((await pickerInfo(app, tabId))?.picked).toBeNull()
  await page.keyboard.press('Escape')
  await expect(view.getByTestId('tweak-hide')).toHaveCount(0)
  await expect.poll(() => pickerInfo(app, tabId)).toBeNull()
  expect(await shown(page, '#weather')).toBe(1)

  // Esc in the panel: the pick, then the mode, then the editor.
  await hideMode(view)
  await pick(page, '#weather')
  await expect(view.getByTestId('tweak-hide-label')).toHaveText('Weather')
  await view.getByTestId('tweak-hide-done').focus()
  await view.keyboard.press('Escape')
  await expect(view.getByTestId('tweak-hide-hint')).toBeVisible()
  await view.keyboard.press('Escape')
  await expect(view.getByTestId('tweak-hide')).toHaveCount(0)
  await expect.poll(() => pickerInfo(app, tabId)).toBeNull()
  expect((await editorInfo(app)).open).toBe(true)
  await view.keyboard.press('Escape')
  await waitEditor(app, false)
  expect(await hiddenOf(app, id)).toHaveLength(1)
})

test('[BO-10] the page can’t take Hide-element mode away: a layer it removes comes back, and its links don’t act even under a cover of its own; a page that keeps removing it ends the mode, and the panel says so', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const { tabId, page } = await openPage(app, '/cards/Layer')
  const { view } = await newTweak(app, tabId)
  const url = page.url()
  await mark(page)
  await hideMode(view)
  const extras = () =>
    page.evaluate(
      () => [...document.documentElement.children].filter((el) => el !== document.head && el !== document.body).length,
    )
  expect(await extras()).toBe(1)

  // The page takes out what it finds under its root beside its head and body: the picker's layer.
  // A click on the promo link then picks it, and the link doesn't go; the layer is back.
  await page.evaluate(() => {
    for (const el of [...document.documentElement.children])
      if (el !== document.head && el !== document.body) el.remove()
  })
  await pick(page, '#promo')
  await expect(view.getByTestId('tweak-hide-label')).toHaveText('Big promo')
  expect([page.url(), await marked(page)]).toEqual([url, true])
  expect(await extras()).toBe(1)

  // The page covers everything with a link of its own, over the layer: a click on it doesn't go,
  // nor does the button under it count, nor does Enter on the focused promo link go.
  await page.evaluate(() => {
    const cover = document.createElement('a')
    cover.id = 'cover'
    cover.title = 'Cover'
    cover.href = '/page/Covered'
    cover.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.01)'
    document.documentElement.append(cover)
  })
  const at = await corner(page, '#count')
  await page.mouse.click(at.x, at.y)
  await expect(view.getByTestId('tweak-hide-label')).toHaveText('Cover')
  await page.evaluate(() => document.getElementById('promo')?.focus())
  await page.keyboard.press('Enter')
  await page.evaluate(() => document.getElementById('cover')?.remove())
  expect([page.url(), await marked(page), await clicks(page)]).toEqual([url, true, undefined])

  // A page that takes the layer out every time it comes back ends the mode: the panel shows it
  // off, the picker is gone, and the page acts on clicks again.
  await page.evaluate(() => {
    const strip = () => {
      for (const el of [...document.documentElement.children])
        if (el !== document.head && el !== document.body) el.remove()
    }
    new MutationObserver(strip).observe(document.documentElement, { childList: true })
    strip()
  })
  await expect(view.getByTestId('tweak-hide-button')).toHaveAttribute('aria-pressed', 'false')
  await expect(view.getByTestId('tweak-hide')).toHaveCount(0)
  await expect.poll(() => pickerInfo(app, tabId)).toBeNull()
  const button = await corner(page, '#count')
  await page.mouse.click(button.x, button.y)
  await expect.poll(() => clicks(page)).toBe(1)
})

test('[BO-10] each hidden element has a restore marker in the panel: hovered, the element shows for the moment; clicked, it is back for good; another of the site’s pages ends the mode, the panel staying open', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const { tabId, page } = await openPage(app, '/cards/Restore')
  const { id, view } = await newTweak(app, tabId)
  await hideMode(view)
  await pick(page, '#promo')
  await view.getByTestId('tweak-hide-this').click()
  await expect.poll(() => shown(page, '#promo')).toBe(0)
  await pick(page, '#weather')
  await expect(view.getByTestId('tweak-hide-label')).toHaveText('Weather')
  await view.getByTestId('tweak-hide-this').click()
  await expect.poll(() => shown(page, '#weather')).toBe(0)
  const markers = view.getByTestId('tweak-restore-marker')
  await expect(markers).toHaveText(['Big promo', 'Weather'])

  // Hovered, the promo shows again; the pointer gone, it hides again. The widget stays hidden.
  await markers.first().hover()
  await expect.poll(() => shown(page, '#promo')).toBe(1)
  expect(await shown(page, '#weather')).toBe(0)
  await view.getByTestId('tweak-name').hover()
  await expect.poll(() => shown(page, '#promo')).toBe(0)

  // Clicked, it is back for good.
  await markers.first().click()
  await expect(markers).toHaveText(['Weather'])
  await expect.poll(() => shown(page, '#promo')).toBe(1)
  await view.getByTestId('tweak-name').hover()
  expect(await shown(page, '#promo')).toBe(1)
  expect((await hiddenOf(app, id)).map((h) => h.selector)).toEqual(['#weather'])

  // Another of the site's pages: the mode ends with the document it was in; the panel stays.
  await mark(page)
  await cmd(app, 'tabs.navigate', { tabId, url: fx.url('/cards/Next') })
  await newDocument(page)
  expect(await firstShown(page)).toEqual({ promo: true, weather: false, stories: 9 })
  await expect(view.getByTestId('tweak-hide')).toHaveCount(0)
  await expect(view.getByTestId('tweak-hide-button')).toHaveAttribute('aria-pressed', 'false')
  expect((await editorInfo(app)).open).toBe(true)
  // It starts again in the new page.
  await hideMode(view)
  await pick(page, '#promo')
  await expect(view.getByTestId('tweak-hide-label')).toHaveText('Big promo')
})
