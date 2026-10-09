import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { isMac, launchOrbit, MOD, type Orbit, state, tabPage, tabView, viewPage } from './helpers'
import {
  cmd,
  focusedUrl,
  type NavFixtures,
  openTab,
  pressInPage,
  shellRoundTrip,
  sideButton,
  startNavFixtures,
  toolsInfo,
  toolsPage,
  visit,
  waitLoaded,
  windowState,
  zoomOf,
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

// ---------- Find in page (NV-05) ----------

const WORDS = 'orbit one. orbit two. orbit three.'
/** A page with "orbit" in it three times. */
const findPage = (title: string) => fx.url(`/page/${title}?text=${encodeURIComponent(WORDS)}`)

/** ⌘F in a tab's page; resolves with the page tools once the find bar has keyboard focus. */
async function openFind(part: string): Promise<Page> {
  await pressInPage(orbit.app, part, 'F', [mod])
  const tools = await toolsPage(orbit.app)
  await expect(tools.getByTestId('find-bar')).toBeVisible()
  await expect(tools.getByTestId('find-input')).toBeFocused()
  return tools
}

/** The page tools sit over the top-right corner of a tab's page: 10 px in, plus their 8 px shadow margin. */
async function expectToolsOver(tabId: string): Promise<void> {
  await expect
    .poll(async () => {
      const [info, view] = [await toolsInfo(orbit.app), await tabView(orbit.app, tabId)]
      const b = info.bounds
      const v = view?.bounds
      if (!info.placed || !b || !v) return null
      return { right: b.x + b.width - (v.x + v.width), top: b.y - v.y }
    })
    .toEqual({ right: -2, top: 2 })
}

test('[NV-05][KS-08] ⌘F finds as you type; Enter and ⌘G go on, ⇧Enter and ⇧⌘G go back; Esc closes and keeps the match selected', async () => {
  const { app } = orbit
  const id = await openTab(app, findPage('Find'))
  const tab = await tabPage(app, '/page/Find')
  const tools = await openFind('/page/Find')
  await expectToolsOver(id)
  const count = tools.getByTestId('find-count')
  await tools.keyboard.type('orbit')
  await expect(count).toHaveText('1/3')
  await tools.keyboard.press('Enter')
  await expect(count).toHaveText('2/3')
  await tools.keyboard.press(`${MOD}+G`)
  await expect(count).toHaveText('3/3')
  // Past the last match it starts again from the first.
  await tools.keyboard.press(`${MOD}+G`)
  await expect(count).toHaveText('1/3')
  await tools.keyboard.press('Shift+Enter')
  await expect(count).toHaveText('3/3')
  await tools.keyboard.press(`${MOD}+Shift+G`)
  await expect(count).toHaveText('2/3')
  if (!isMac) {
    await tools.keyboard.press('F3')
    await expect(count).toHaveText('3/3')
    await tools.keyboard.press('Shift+F3')
    await expect(count).toHaveText('2/3')
  }
  // The buttons do the same.
  await tools.getByTestId('find-next').click()
  await expect(count).toHaveText('3/3')
  await tools.getByTestId('find-prev').click()
  await expect(count).toHaveText('2/3')
  // No match says so.
  const input = tools.getByTestId('find-input')
  await input.fill('orbits')
  await expect(count).toHaveText('No matches')
  await expect(count).toHaveAttribute('data-empty', 'true')
  await expect(tools.getByTestId('find-next')).toBeDisabled()
  await input.fill('orbit')
  await expect(count).toHaveText('1/3')
  await tools.keyboard.press('Enter')
  await expect(count).toHaveText('2/3')
  await tools.keyboard.press('Escape')
  await expect.poll(async () => (await toolsInfo(app)).placed).toBe(false)
  // The highlights are gone, the second match stays selected and the page has the keyboard again.
  await expect
    .poll(() =>
      tab.evaluate(() => {
        const s = getSelection()
        return s && s.rangeCount > 0 ? [String(s), s.getRangeAt(0).startOffset] : null
      }),
    )
    .toEqual(['orbit', 11])
  await expect.poll(() => focusedUrl(app)).toContain('/page/Find')
  expect((await toolsInfo(app)).find).toMatchObject({ open: false, matches: 0 })
})

test('[NV-05] find is per tab: another tab hides the bar, coming back brings it with its text and place', async () => {
  const { app } = orbit
  const first = await openTab(app, findPage('FindA'))
  const tools = await openFind('/page/FindA')
  const input = tools.getByTestId('find-input')
  const count = tools.getByTestId('find-count')
  await tools.keyboard.type('orbit')
  await expect(count).toHaveText('1/3')
  await tools.keyboard.press('Enter')
  await expect(count).toHaveText('2/3')
  const second = await openTab(app, page('Plain'))
  await expect.poll(async () => (await toolsInfo(app)).placed).toBe(false)
  await cmd(app, 'tabs.activate', { tabId: first })
  await expectToolsOver(first)
  await expect(input).toHaveValue('orbit')
  await expect(count).toHaveText('2/3')
  // The other tab has a bar of its own.
  await cmd(app, 'tabs.activate', { tabId: second })
  await expect.poll(async () => (await toolsInfo(app)).placed).toBe(false)
  await openFind('/page/Plain')
  await expect(input).toHaveValue('')
  await expect(count).toBeHidden()
  // Closing a tab with its bar open is fine; the other tab's bar comes back with it.
  await cmd(app, 'tabs.close', { tabId: second })
  await expect.poll(async () => (await windowState(app)).activeTab[(await windowState(app)).spaceId]).toBe(first)
  await expectToolsOver(first)
  await expect(input).toHaveValue('orbit')
  // The bar follows the page when the sidebar hides.
  await cmd(app, 'action.run', { id: 'sidebar.toggle' })
  await expect.poll(async () => (await windowState(app)).sidebar.visible).toBe(false)
  await expectToolsOver(first)
})

test('[NV-05] ⌘F starts from the selected text, else the tab’s last search; an input method’s text is searched once committed', async () => {
  const { app } = orbit
  await openTab(app, findPage('FindSel'))
  const tab = await tabPage(app, '/page/FindSel')
  // Select "two" on the page.
  await tab.evaluate(() => {
    const text = document.getElementById('text')?.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 17)
    range.setEnd(text, 20)
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(range)
  })
  const tools = await openFind('/page/FindSel')
  const input = tools.getByTestId('find-input')
  const count = tools.getByTestId('find-count')
  await expect(input).toHaveValue('two')
  await expect(count).toHaveText('1/1')
  // Selected, so typing replaces it.
  await expect
    .poll(() => input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]))
    .toEqual([0, 3])
  await tools.keyboard.press('Escape')
  await expect.poll(async () => (await toolsInfo(app)).placed).toBe(false)
  await tab.evaluate(() => getSelection()?.removeAllRanges())
  const again = await openFind('/page/FindSel')
  expect(again).toBe(tools)
  await expect(input).toHaveValue('two')
  await expect(count).toHaveText('1/1')
  await expect
    .poll(() => input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]))
    .toEqual([0, 3])
  // An input method composes "orb" first (nothing is searched), then commits "orbit".
  const cdp = await tools.context().newCDPSession(tools)
  try {
    await cdp.send('Input.imeSetComposition', { text: 'orb', selectionStart: 3, selectionEnd: 3 })
    await expect(input).toHaveValue('orb')
    await shellRoundTrip(tools)
    expect((await toolsInfo(app)).find.query).toBe('two')
    await cdp.send('Input.insertText', { text: 'orbit' })
  } finally {
    await cdp.detach()
  }
  await expect(input).toHaveValue('orbit')
  // A new search goes on from where the last one was (Chromium): past "two" comes the third.
  await expect(count).toHaveText('3/3')
})

test('[NV-05][KS-08] Jump to Selection (⌘J on macOS) scrolls the page back to the selected text', async () => {
  const { app } = orbit
  await openTab(app, findPage('Jump'))
  const tab = await tabPage(app, '/page/Jump')
  await tab.evaluate(() => {
    const text = document.getElementById('text')?.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 5)
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(range)
    window.scrollTo(0, 1500)
  })
  await expect.poll(() => tab.evaluate(() => window.scrollY)).toBeGreaterThan(1000)
  if (isMac) await pressInPage(app, '/page/Jump', 'J', ['meta'])
  else await cmd(app, 'action.run', { id: 'page.jumpToSelection' })
  await expect.poll(() => tab.evaluate(() => window.scrollY)).toBeLessThan(200)
  expect(await tab.evaluate(() => String(getSelection()))).toBe('orbit')
})

// ---------- Page zoom (NV-06) ----------

test('[NV-06][KS-08] ⌘+ and ⌘− step through the zoom levels with an indicator; the site’s other tabs follow; ⌘0 resets', async () => {
  const { app } = orbit
  const first = await openTab(app, page('ZoomA'))
  await pressInPage(app, '/page/ZoomA', '=', [mod])
  await pressInPage(app, '/page/ZoomA', '=', [mod])
  const tools = await toolsPage(app)
  const percent = tools.getByTestId('zoom-percent')
  await expect(percent).toHaveText('125%')
  await expect.poll(() => zoomOf(app, '/page/ZoomA')).toBeCloseTo(1.25)
  await expectToolsOver(first)
  // A new tab on the same site opens zoomed; another site doesn't.
  const second = await openTab(app, page('ZoomB'))
  expect(await zoomOf(app, '/page/ZoomB')).toBeCloseTo(1.25)
  await openTab(app, fx.urlOn('127.0.0.1', '/page/ZoomC'))
  expect(await zoomOf(app, '/page/ZoomC')).toBeCloseTo(1)
  await pressInPage(app, '/page/ZoomC', '-', [mod])
  await expect(percent).toHaveText('90%')
  await expect.poll(() => zoomOf(app, '/page/ZoomC')).toBeCloseTo(0.9)
  // The indicator's Reset button goes back to 100%. It stays while the pointer is on it.
  await tools.getByTestId('zoom-reset').click()
  await expect(percent).toHaveText('100%')
  await expect(tools.getByTestId('zoom-reset')).toHaveCount(0)
  await expect.poll(() => zoomOf(app, '/page/ZoomC')).toBeCloseTo(1)
  await expect.poll(async () => (await toolsInfo(app)).hovered).toBe(true)
  await tools.mouse.move(1, 1)
  await expect.poll(async () => (await toolsInfo(app)).hovered).toBe(false)
  // ⌘0 resets the site in all its tabs.
  await cmd(app, 'tabs.activate', { tabId: second })
  await pressInPage(app, '/page/ZoomB', '0', [mod])
  await expect.poll(() => zoomOf(app, '/page/ZoomB')).toBeCloseTo(1)
  await expect.poll(() => zoomOf(app, '/page/ZoomA')).toBeCloseTo(1)
  // The indicator goes on its own after about a second and a half.
  const shown = Date.now()
  await expect.poll(async () => (await toolsInfo(app)).zoom, { timeout: 8000 }).toBeNull()
  expect(Date.now() - shown).toBeGreaterThan(900)
  await expect.poll(async () => (await toolsInfo(app)).placed).toBe(false)
})

test('[NV-06] zoom is remembered per site and profile across a restart', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'orbit-e2e-zoom-'))
  await orbit.app.close()
  orbit = await launchOrbit({ userData })
  let { app } = orbit
  const personal = (await windowState(app)).spaceId
  await openTab(app, page('Keep'))
  await pressInPage(app, '/page/Keep', '=', [mod])
  await expect.poll(() => zoomOf(app, '/page/Keep')).toBeCloseTo(1.1)
  // Another profile has its own zoom for the same site.
  const profileId = await cmd<string>(app, 'profiles.create', { name: 'Work' })
  const work = await cmd<string>(app, 'spaces.create', { name: 'Work', profileId })
  await expect.poll(async () => (await windowState(app)).spaceId).toBe(work)
  await openTab(app, page('KeepWork'))
  expect(await zoomOf(app, '/page/KeepWork')).toBeCloseTo(1)
  await orbit.app.close()
  orbit = await launchOrbit({ userData })
  app = orbit.app
  await cmd(app, 'spaces.switch', { spaceId: personal })
  await expect.poll(async () => (await windowState(app)).spaceId).toBe(personal)
  await openTab(app, page('KeepAgain'))
  await expect.poll(() => zoomOf(app, '/page/KeepAgain')).toBeCloseTo(1.1)
  await cmd(app, 'spaces.switch', { spaceId: work })
  await expect.poll(async () => (await windowState(app)).spaceId).toBe(work)
  await openTab(app, page('KeepWorkAgain'))
  expect(await zoomOf(app, '/page/KeepWorkAgain')).toBeCloseTo(1)
})

test('[NV-06] ⌘0 also undoes a pinch zoom', async () => {
  const { app } = orbit
  await openTab(app, page('Pinch'))
  const tab = await tabPage(app, '/page/Pinch')
  const scale = () => tab.evaluate(() => window.visualViewport?.scale ?? 1)
  const cdp = await tab.context().newCDPSession(tab)
  try {
    await cdp.send('Input.synthesizePinchGesture', {
      x: 200,
      y: 200,
      scaleFactor: 2,
      relativeSpeed: 800,
      // A trackpad's pinch.
      gestureSourceType: 'mouse',
    })
  } finally {
    await cdp.detach()
  }
  await expect.poll(scale).toBeGreaterThan(1.3)
  await pressInPage(app, '/page/Pinch', '0', [mod])
  await expect.poll(scale).toBe(1)
})

test('[NV-06] Ctrl and the mouse wheel zoom the page under the pointer (Windows, Linux)', async () => {
  test.skip(isMac, 'macOS zooms with a pinch')
  const { app } = orbit
  await openTab(app, page('Wheel'))
  // One notch of the wheel. Electron sends a synthetic wheel event twice (as the scroll begins and
  // ends), each with the ticks given, so half a tick each makes the one notch.
  const wheel = (deltaY: number) =>
    app.evaluate(({ webContents }, dy) => {
      const contents = webContents.getAllWebContents().find((w) => w.getURL().includes('/page/Wheel'))
      contents?.sendInputEvent({
        type: 'mouseWheel',
        x: 200,
        y: 200,
        deltaX: 0,
        deltaY: dy,
        wheelTicksX: 0,
        wheelTicksY: Math.sign(dy) / 2,
        canScroll: true,
        modifiers: ['control'],
      })
    }, deltaY)
  await wheel(120)
  const tools = await toolsPage(app)
  await expect(tools.getByTestId('zoom-percent')).toHaveText('110%')
  await expect.poll(() => zoomOf(app, '/page/Wheel')).toBeCloseTo(1.1)
  await wheel(-120)
  await expect.poll(() => zoomOf(app, '/page/Wheel')).toBeCloseTo(1)
})
