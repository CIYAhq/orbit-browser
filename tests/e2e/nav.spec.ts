import { expect, type Page, test } from '@playwright/test'
import { isMac, launchOrbit, MOD, type Orbit, state, tabPage, viewPage } from './helpers'
import {
  cmd,
  focusedUrl,
  type NavFixtures,
  openTab,
  pressInPage,
  sideButton,
  startNavFixtures,
  visit,
  waitLoaded,
  windowState,
} from './nav-support'

let fx: NavFixtures
let orbit: Orbit

test.beforeAll(async () => {
  fx = await startNavFixtures()
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

const page = (title: string) => fx.url(`/page/${title}`)
/** ⌘ on macOS, Ctrl elsewhere, as a modifier for `pressInPage`. */
const mod = isMac ? 'meta' : 'control'

/** Opens the first page in a new tab, then visits the others in that tab. Returns the tab. */
async function tabWithHistory(...titles: [string, ...string[]]): Promise<string> {
  const [first, ...rest] = titles
  const id = await openTab(orbit.app, page(first))
  for (const title of rest) await visit(orbit.app, id, page(title))
  return id
}

const keysSeen = (tab: Page) => tab.evaluate(() => (window as unknown as { __keys: string[] }).__keys)
/** How many times the page has loaded in this tab (null while a reload swaps the document). */
const loads = (tab: Page) => tab.evaluate(() => sessionStorage.getItem('loads')).catch(() => null)

/** Gives keyboard focus to the web contents whose URL contains `part` (a tab, or `view=shell`). */
async function focusContents(part: string): Promise<void> {
  await orbit.app.evaluate(({ webContents }, p) => {
    webContents
      .getAllWebContents()
      .find((w) => w.getURL().includes(p))
      ?.focus()
  }, part)
  await expect.poll(() => focusedUrl(orbit.app)).toContain(part)
}

test('[NV-01][KS-08] the Back and Forward keys work from the page and from the sidebar', async () => {
  const { app, shell } = orbit
  const id = await tabWithHistory('KeyA', 'KeyB')
  // In the page: ⌘[ ⌘] on macOS, Alt+← Alt+→ elsewhere.
  await pressInPage(app, '/page/KeyB', isMac ? '[' : 'Left', [isMac ? 'meta' : 'alt'])
  await waitLoaded(app, id, page('KeyA'))
  await pressInPage(app, '/page/KeyA', isMac ? ']' : 'Right', [isMac ? 'meta' : 'alt'])
  await waitLoaded(app, id, page('KeyB'))
  // In the sidebar.
  await shell.keyboard.press(isMac ? 'Meta+BracketLeft' : 'Alt+ArrowLeft')
  await waitLoaded(app, id, page('KeyA'))
  await shell.keyboard.press(isMac ? 'Meta+BracketRight' : 'Alt+ArrowRight')
  await waitLoaded(app, id, page('KeyB'))
})

test('[NV-01][KS-08] ⌘← and ⌘→ go back and forward, but not while a text field has focus', async () => {
  test.skip(!isMac, '⌘← and ⌘→ are macOS keys')
  const { app } = orbit
  const id = await tabWithHistory('ArrowA', 'ArrowB', 'ArrowC')
  const tab = await tabPage(app, '/page/ArrowC')
  await tab.click('#box')
  await pressInPage(app, '/page/ArrowC', 'Left', ['meta'])
  // In the field the key is the page's (it moves the caret there).
  await expect.poll(() => keysSeen(tab)).toContain('ArrowLeft')
  // Outside it, ⌘← goes back one page: had the first press gone back too, this would land on A.
  await tab.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await pressInPage(app, '/page/ArrowC', 'Left', ['meta'])
  await waitLoaded(app, id, page('ArrowB'))
  await pressInPage(app, '/page/ArrowB', 'Right', ['meta'])
  await waitLoaded(app, id, page('ArrowC'))
})

test('[NV-01] the mouse back and forward buttons over the page go back and forward one page', async () => {
  const { app } = orbit
  const id = await tabWithHistory('MouseA', 'MouseB', 'MouseC')
  const tab = await tabPage(app, '/page/MouseC')
  await sideButton(tab, 'back')
  // One page, not two.
  await waitLoaded(app, id, page('MouseB'))
  await sideButton(tab, 'forward')
  await waitLoaded(app, id, page('MouseC'))
})

test('[NV-01] Backspace does not go back', async () => {
  const { app } = orbit
  const id = await tabWithHistory('BsA', 'BsB')
  const tab = await tabPage(app, '/page/BsB')
  await pressInPage(app, '/page/BsB', 'Backspace')
  await expect.poll(() => keysSeen(tab)).toContain('Backspace')
  expect(await tab.evaluate(() => location.pathname)).toBe('/page/BsB')
  expect((await state(app)).tabs[id]?.url).toBe(page('BsB'))
})

test('[NV-03][KS-08] after Reload the keyboard is in the page, from the page or the sidebar', async () => {
  const { app, shell } = orbit
  const url = page('Typing')
  const id = await openTab(app, url)
  const tab = await tabPage(app, '/page/Typing')
  // Typing in the page's text box, then the Reload key.
  await focusContents('/page/Typing')
  await tab.click('#box')
  await tab.keyboard.type('abc')
  await pressInPage(app, '/page/Typing', 'R', [mod])
  await expect.poll(() => loads(tab)).toBe('2')
  await waitLoaded(app, id, url)
  expect(await focusedUrl(app)).toBe(url)

  // The Reload button in the sidebar hands the keyboard to the page.
  await focusContents('view=shell')
  await shell.getByTestId('nav-reload').click()
  await expect.poll(() => loads(tab)).toBe('3')
  await expect.poll(() => focusedUrl(app)).toBe(url)

  // So does the key pressed while the sidebar has focus.
  await focusContents('view=shell')
  await shell.keyboard.press(`${MOD}+R`)
  await expect.poll(() => loads(tab)).toBe('4')
  await expect.poll(() => focusedUrl(app)).toBe(url)
})

test('[NV-03][KS-08] Reload revalidates the page; hard reload bypasses the cache', async () => {
  const { app } = orbit
  const path = '/page/Fresh'
  const url = fx.url(path)
  const id = await openTab(app, url)
  const tab = await tabPage(app, path)
  let count = 1
  const press = async (key: string, modifiers: ('shift' | 'control' | 'meta')[], cacheControl: string) => {
    await pressInPage(app, path, key, modifiers)
    count++
    await expect.poll(() => loads(tab)).toBe(String(count))
    expect(fx.hits(path)).toBe(count)
    expect(fx.cacheControl(path), `${modifiers.join('+')}+${key}`).toBe(cacheControl)
    await waitLoaded(app, id, url)
  }
  await press('R', [mod], 'max-age=0')
  await press('R', [mod, 'shift'], 'no-cache')
  if (!isMac) {
    await press('F5', [], 'max-age=0')
    await press('F5', ['shift'], 'no-cache')
    await press('F5', ['control'], 'no-cache')
  }
})

test('[NV-04][KS-08] Esc in the page stops loading; with the command bar open, Esc closes the bar first', async () => {
  const { app, shell } = orbit
  const id = await openTab(app, page('Steady'))
  const tab = await tabPage(app, '/page/Steady')
  await cmd(app, 'tabs.navigate', { tabId: id, url: fx.url('/slow/Pending') })
  await expect.poll(() => fx.hits('/slow/Pending')).toBe(1)
  await expect.poll(async () => (await state(app)).tabs[id]?.loading).toBe(true)

  await shell.keyboard.press(`${MOD}+L`)
  const overlay = await viewPage(app, 'overlay')
  await expect(overlay.getByTestId('command-input')).toBeFocused()
  await overlay.keyboard.press('Escape')
  await expect.poll(async () => (await windowState(app)).overlay.kind).toBe('none')
  expect((await state(app)).tabs[id]?.loading).toBe(true)

  // Esc in the page stops the load, and the page still gets the key.
  await pressInPage(app, '/page/Steady', 'Escape')
  await expect.poll(async () => (await state(app)).tabs[id]?.loading).toBe(false)
  expect(await keysSeen(tab)).toContain('Escape')
  expect(await tab.evaluate(() => location.pathname)).toBe('/page/Steady')
})

test('[NV-04][KS-08] ⌘. stops loading on macOS', async () => {
  test.skip(!isMac, '⌘. is a macOS key')
  const { app } = orbit
  const id = await openTab(app, page('Halt'))
  await cmd(app, 'tabs.navigate', { tabId: id, url: fx.url('/slow/Halting') })
  await expect.poll(() => fx.hits('/slow/Halting')).toBe(1)
  await expect.poll(async () => (await state(app)).tabs[id]?.loading).toBe(true)
  await pressInPage(app, '/page/Halt', '.', ['meta'])
  await expect.poll(async () => (await state(app)).tabs[id]?.loading).toBe(false)
})
