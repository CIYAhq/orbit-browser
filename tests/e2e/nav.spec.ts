import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
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
  type ToolsInfo,
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

test('[NV-05][PK-11] ⌘F and ⌘G with a Peek open leave the tab under it alone: no find bar comes, and the keyboard stays in the Peek (review A-M3)', async () => {
  const { app } = orbit
  await openTab(app, findPage('Under'))
  // The tab under the Peek has a search of its own, which ⌘G would bring back.
  const tools = await openFind('/page/Under')
  await tools.keyboard.type('orbit')
  await expect(tools.getByTestId('find-count')).toHaveText('1/3')
  await tools.keyboard.press('Escape')
  await expect.poll(async () => (await toolsInfo(app)).placed).toBe(false)
  const peekUrl = findPage('Peeked')
  const peekTab = await cmd<string>(app, 'peek.open', { url: peekUrl })
  await waitLoaded(app, peekTab, peekUrl)
  await expect.poll(() => focusedUrl(app)).toContain('/page/Peeked')
  const peek = await tabPage(app, '/page/Peeked')
  await pressInPage(app, '/page/Peeked', 'F', [mod])
  await pressInPage(app, '/page/Peeked', 'G', [mod])
  // Keys reach main in order: once the page has a later key, Orbit has dealt with ⌘F and ⌘G.
  await pressInPage(app, '/page/Peeked', 'End')
  await expect.poll(() => keysSeen(peek)).toContain('End')
  expect(await focusedUrl(app)).toContain('/page/Peeked')
  expect(await toolsInfo(app)).toMatchObject({ placed: false, find: { open: false } })
  expect((await windowState(app)).overlay.kind).toBe('peek')
})

test('[NV-05][NV-06] with the Library open, ⌘G, F3 and ⌘+ leave the tab under it alone: no find bar, no zoom, and the keyboard stays in the Library (fix check A, M2)', async () => {
  const { app } = orbit
  await openTab(app, findPage('Covered'))
  // The tab has a search of its own, which ⌘G or F3 would bring back.
  const tools = await openFind('/page/Covered')
  await tools.keyboard.type('orbit')
  await expect(tools.getByTestId('find-count')).toHaveText('1/3')
  await tools.keyboard.press('Escape')
  await expect.poll(async () => (await toolsInfo(app)).placed).toBe(false)
  await cmd(app, 'library.open')
  await expect.poll(() => cmd(app, 'library.testInfo')).toMatchObject({ open: true, visible: true })
  await expect.poll(() => focusedUrl(app)).toContain('view=library')
  const library = app.windows().find((p) => p.url().includes('view=library'))
  if (!library) throw new Error('no Library page')
  await library.evaluate(() => {
    const w = window as unknown as { __keys: string[] }
    w.__keys = []
    addEventListener('keydown', (e) => w.__keys.push(e.key), true)
  })
  await pressInPage(app, 'view=library', 'G', [mod])
  await pressInPage(app, 'view=library', 'F3')
  await pressInPage(app, 'view=library', '=', [mod])
  // Keys reach main in order: once the Library has a later key, Orbit has dealt with those.
  await pressInPage(app, 'view=library', 'End')
  await expect.poll(() => library.evaluate(() => (window as unknown as { __keys: string[] }).__keys)).toContain('End')
  expect(await focusedUrl(app)).toContain('view=library')
  expect(await toolsInfo(app)).toMatchObject({ placed: false, find: { open: false } })
  expect(await zoomOf(app, '/page/Covered')).toBeCloseTo(1, 3)
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

test('[NV-06][PK-11] zoom in a Peek takes the tab steps and says the new zoom; the site’s tabs follow and keep it (review A-F4)', async () => {
  const { app, shell } = orbit
  await openTab(app, page('Under'))
  const peekUrl = page('PeekZoom')
  const peekTab = await cmd<string>(app, 'peek.open', { url: peekUrl })
  await waitLoaded(app, peekTab, peekUrl)
  await expect.poll(() => focusedUrl(app)).toContain('/page/PeekZoom')
  await pressInPage(app, '/page/PeekZoom', '=', [mod])
  await pressInPage(app, '/page/PeekZoom', '=', [mod])
  await expect.poll(() => zoomOf(app, '/page/PeekZoom')).toBeCloseTo(1.25, 3)
  await expect(shell.getByTestId('toast').last()).toHaveText('Zoom 125%')
  expect((await windowState(app)).overlay.kind).toBe('peek')
  // The tab under the Peek is on the same site: it follows.
  expect(await zoomOf(app, '/page/Under')).toBeCloseTo(1.25, 3)
  // Kept for the site: a new tab on it opens at that zoom.
  await openTab(app, page('AfterPeek'))
  await expect.poll(() => zoomOf(app, '/page/AfterPeek')).toBeCloseTo(1.25, 3)
  expect(await zoomOf(app, '/page/Under')).toBeCloseTo(1.25, 3)
})

/** The zoom Orbit has saved for a host in a profile (NV-06), once its file has it; undefined is 100%. */
function savedZoom(userData: string, profileId: string, host: string): number | undefined {
  try {
    const saved = JSON.parse(readFileSync(join(userData, 'orbit-site-prefs.json'), 'utf8')) as {
      zoom?: Record<string, Record<string, number>>
    }
    return saved.zoom?.[profileId]?.[host]
  } catch {
    return undefined
  }
}

test('[NV-06] zoom in a Mini Window takes the tab steps; the site’s tabs follow, and the site keeps it until ⌘0 (fix check A, F3)', async () => {
  const { app, userData } = orbit
  await openTab(app, page('BesideMini'))
  const url = page('MiniZoom')
  await cmd<string>(app, 'mini.open', { url })
  let miniTab = ''
  await expect
    .poll(async () => {
      miniTab = Object.values((await state(app)).tabs).find((t) => t.url === url)?.id ?? ''
      return miniTab
    })
    .not.toBe('')
  await waitLoaded(app, miniTab, url)
  const profileId = (await state(app)).tabs[miniTab]?.profileId ?? ''
  const host = new URL(url).hostname
  // Chromium's steps, as in a tab: 110%, then 125%.
  await pressInPage(app, '/page/MiniZoom', '=', [mod])
  await expect.poll(() => zoomOf(app, '/page/MiniZoom')).toBeCloseTo(1.1, 3)
  await pressInPage(app, '/page/MiniZoom', '=', [mod])
  await expect.poll(() => zoomOf(app, '/page/MiniZoom')).toBeCloseTo(1.25, 3)
  // The site's tab in the main window follows, and Orbit keeps the zoom for the site.
  expect(await zoomOf(app, '/page/BesideMini')).toBeCloseTo(1.25, 3)
  await expect.poll(() => savedZoom(userData, profileId, host)).toBeCloseTo(1.25, 3)
  // ⌘0 in the Mini Window resets the site in all its tabs, and Orbit forgets it.
  await pressInPage(app, '/page/MiniZoom', '0', [mod])
  await expect.poll(() => zoomOf(app, '/page/MiniZoom')).toBeCloseTo(1, 3)
  await expect.poll(() => zoomOf(app, '/page/BesideMini')).toBeCloseTo(1, 3)
  await expect.poll(() => savedZoom(userData, profileId, host)).toBeUndefined()
})

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

test('[NV-06] deleting a profile forgets its sites’ zoom; the other profiles keep theirs (review B-F7)', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'orbit-e2e-forget-'))
  await orbit.app.close()
  orbit = await launchOrbit({ userData })
  const { app } = orbit
  const personal = (await windowState(app)).spaceId
  const kept = (await state(app)).spaces[personal]?.profileId
  await openTab(app, page('Stay'))
  await pressInPage(app, '/page/Stay', '=', [mod])
  await expect.poll(() => zoomOf(app, '/page/Stay')).toBeCloseTo(1.1)
  const profileId = await cmd<string>(app, 'profiles.create', { name: 'Work' })
  const work = await cmd<string>(app, 'spaces.create', { name: 'Work', profileId })
  await expect.poll(async () => (await windowState(app)).spaceId).toBe(work)
  await openTab(app, page('Gone'))
  await pressInPage(app, '/page/Gone', '=', [mod])
  await expect.poll(() => zoomOf(app, '/page/Gone')).toBeCloseTo(1.1)
  // Its Space goes, then the profile.
  await cmd(app, 'spaces.switch', { spaceId: personal })
  expect(await cmd(app, 'spaces.delete', { spaceId: work })).toBe(true)
  expect(await cmd(app, 'profiles.delete', { profileId })).toBe(true)
  await app.close()
  const saved = JSON.parse(readFileSync(join(userData, 'orbit-site-prefs.json'), 'utf8')) as {
    zoom: Record<string, Record<string, number>>
  }
  expect(Object.keys(saved.zoom)).toEqual([kept])
  orbit = await launchOrbit({ userData })
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

// ---- A new window's page tools and the keyboard (round 2 fix check, M3 and F4) ----

/** A window's page tools, as main sees them. */
function toolsIn(windowId: string): Promise<ToolsInfo & { ready: boolean }> {
  return orbit.app.evaluate(
    (_e, w) =>
      (
        globalThis as unknown as { __orbitNav: { tools: (w: string) => ToolsInfo & { ready: boolean } } }
      ).__orbitNav.tools(w),
    windowId,
  )
}

/** Where a key typed with nothing holding the keyboard goes, as `typeAnywhere` says. */
const NOWHERE = '(nothing has the keyboard)'
/** As `typeAnywhere` says of a web contents whose page hasn't loaded yet (it has no address). */
const LOADING = '(a page still loading)'

/**
 * Types each of `keys` (a character, or a key such as 'Backspace') wherever the keyboard is, as the
 * keyboard does. Returns the address of what took each key, or NOWHERE, or LOADING.
 */
function typeAnywhere(keys: string[]): Promise<string[]> {
  return orbit.app.evaluate(
    ({ webContents }, [list, nowhere, loading]) =>
      list.map((key) => {
        const contents = webContents.getFocusedWebContents()
        if (!contents) return nowhere
        contents.sendInputEvent({ type: 'keyDown', keyCode: key })
        if ([...key].length === 1) contents.sendInputEvent({ type: 'char', keyCode: key })
        contents.sendInputEvent({ type: 'keyUp', keyCode: key })
        return contents.getURL() || loading
      }),
    [keys, NOWHERE, LOADING] as const,
  )
}

/**
 * Records each web contents that takes the keyboard (its `focus` event). Read by address, once
 * known: a view's page may not have loaded when it takes the keyboard.
 */
async function watchKeyboard(): Promise<() => Promise<string[]>> {
  await orbit.app.evaluate(({ app: electronApp, webContents }) => {
    const g = globalThis as unknown as { __tookKeyboard: number[] }
    g.__tookKeyboard = []
    const watch = (contents: Electron.WebContents) => contents.on('focus', () => g.__tookKeyboard.push(contents.id))
    for (const contents of webContents.getAllWebContents()) watch(contents)
    electronApp.on('web-contents-created', (_e, contents) => watch(contents))
  })
  return () =>
    orbit.app.evaluate(({ webContents }) =>
      (globalThis as unknown as { __tookKeyboard: number[] }).__tookKeyboard.map(
        (id) => webContents.fromId(id)?.getURL() ?? '',
      ),
    )
}

/** What a window's zoom indicator says on screen: in the window, and its text. */
function zoomShown(windowId: string): Promise<{ placed: boolean; text: string | null }> {
  return orbit.app.evaluate(async (_e, w) => {
    const windows = (
      globalThis as unknown as {
        __orbit: {
          ctx: {
            windows: {
              toolsInfo: (w: string) => { placed: boolean }
              toolsContents: (w: string) => Electron.WebContents
            }
          }
        }
      }
    ).__orbit.ctx.windows
    const text: string | null = await windows
      .toolsContents(w)
      .executeJavaScript(`document.querySelector('[data-testid=zoom-percent]')?.textContent ?? null`)
    return { placed: windows.toolsInfo(w).placed, text }
  }, windowId)
}

interface FreshWindow {
  windowId: string
  tabId: string
  /** How long after the window showed `act` came. */
  at: number
  /** The page tools' page had loaded by then. */
  toolsReady: boolean
  /** Where each key typed right after `act` went, as `typeAnywhere` says. */
  typedInto: string[]
}

/**
 * As fast as a person could, in main: opens a window as ⌘N does, opens `url` there in a new tab,
 * closes the command bar and puts the keyboard in the page's text field (#box). Then does `act`,
 * ⌘+ or ⌘F as pressed in the page, and types `keys` wherever the keyboard is, at once.
 */
function freshWindow(url: string, act: 'zoom' | 'find', keys: string[]): Promise<FreshWindow> {
  return orbit.app.evaluate(
    async ({ webContents }, [address, what, list, modifier, nowhere, loading]) => {
      type Orbit = {
        action: (id: string, w?: string) => Promise<void>
        run: (name: string, args: unknown, w?: string) => Promise<unknown>
        windowIds: () => string[]
        ctx: {
          windows: {
            get: (w: string) => Electron.BrowserWindow | undefined
            toolsInfo: (w: string) => { ready: boolean }
          }
          tabs: { contents: (id: string) => Electron.WebContents | undefined }
        }
      }
      const o = (globalThis as unknown as { __orbit: Orbit }).__orbit
      const before = o.windowIds()
      await o.action('window.new', before[0])
      const windowId = o.windowIds().find((w) => !before.includes(w))
      const win = windowId ? o.ctx.windows.get(windowId) : undefined
      if (!windowId || !win) throw new Error('no new window')
      const shownAt = await new Promise<number>((resolve) => {
        if (win.isVisible()) resolve(Date.now())
        else win.once('show', () => resolve(Date.now()))
      })
      const tabId = String(await o.run('tabs.create', { url: address }, windowId))
      await o.run('overlay.close', {}, windowId)
      let page = o.ctx.tabs.contents(tabId)
      for (let i = 0; i < 500 && (!page || page.getURL() !== address || page.isLoading()); i++) {
        await new Promise((r) => setTimeout(r, 10))
        page = o.ctx.tabs.contents(tabId)
      }
      if (!page) throw new Error(`no page for ${tabId}`)
      page.focus()
      await page.executeJavaScript(`document.getElementById('box').focus()`)
      const at = Date.now() - shownAt
      const toolsReady = o.ctx.windows.toolsInfo(windowId).ready
      if (what === 'zoom') {
        await o.action('page.zoomIn', windowId)
      } else {
        page.sendInputEvent({ type: 'keyDown', keyCode: 'F', modifiers: [modifier] })
        page.sendInputEvent({ type: 'keyUp', keyCode: 'F', modifiers: [modifier] })
      }
      const typedInto = list.map((key) => {
        const contents = webContents.getFocusedWebContents()
        if (!contents) return nowhere
        contents.sendInputEvent({ type: 'keyDown', keyCode: key })
        if ([...key].length === 1) contents.sendInputEvent({ type: 'char', keyCode: key })
        contents.sendInputEvent({ type: 'keyUp', keyCode: key })
        return contents.getURL() || loading
      })
      return { windowId, tabId, at, toolsReady, typedInto }
    },
    [url, act, keys, mod, NOWHERE, LOADING] as const,
  )
}

/** The first of up to three fresh windows (D46) where `act` came before the page tools' page had loaded. */
async function earlyWindow(url: string, act: 'zoom' | 'find', keys: string[]): Promise<FreshWindow> {
  const tries: number[] = []
  for (let n = 0; n < 3; n++) {
    const fresh = await freshWindow(url, act, keys)
    if (!fresh.toolsReady) return fresh
    tries.push(fresh.at)
    await orbit.app.evaluate((_e, w) => {
      ;(
        globalThis as unknown as { __orbit: { ctx: { windows: { get: (w: string) => Electron.BrowserWindow } } } }
      ).__orbit.ctx.windows
        .get(w)
        ?.close()
    }, fresh.windowId)
  }
  throw new Error(`the page tools were ready before ${act} in 3 windows (at ${tries.join(', ')} ms)`)
}

/** The value of a tab's text field (#box). */
function fieldValue(tabId: string): Promise<string | null> {
  return orbit.app.evaluate(
    (_e, id) =>
      (
        globalThis as unknown as {
          __orbit: { ctx: { tabs: { contents: (id: string) => Electron.WebContents | undefined } } }
        }
      ).__orbit.ctx.tabs
        .contents(id)
        ?.executeJavaScript(`document.getElementById('box').value`) ?? null,
    tabId,
  )
}

test('[NV-06] zoom in a new window’s first moments never takes the keyboard: keys reach the page’s field before, while and after the indicator shows (round 2 fix check, M3)', async () => {
  const tookKeyboard = await watchKeyboard()
  const fresh = await earlyWindow(page('Fresh'), 'zoom', ['a', 'b'])
  expect(fresh.typedInto).toEqual([page('Fresh'), page('Fresh')])
  // The indicator shows once its page has loaded.
  await expect.poll(() => zoomShown(fresh.windowId)).toEqual({ placed: true, text: '110%' })
  expect(await typeAnywhere(['c', 'd'])).toEqual([page('Fresh'), page('Fresh')])
  await expect.poll(async () => (await toolsIn(fresh.windowId)).placed, { timeout: 10_000 }).toBe(false)
  expect(await typeAnywhere(['e', 'f'])).toEqual([page('Fresh'), page('Fresh')])
  await expect.poll(() => fieldValue(fresh.tabId)).toBe('abcdef')
  expect((await tookKeyboard()).filter((url) => url.includes('view=tools'))).toEqual([])
})

test('[NV-05] keys typed right after ⌘F in a new window’s first moments reach the find bar once it is in, not the page (round 2 fix check, M3 and F4)', async () => {
  const fresh = await earlyWindow(findPage('Early'), 'find', ['o', 'r', 'x', 'Backspace', 'b'])
  // The page keeps the keyboard until the bar is in the window; what is typed for the bar meanwhile waits for it.
  expect(fresh.typedInto).toEqual(Array(5).fill(findPage('Early')))
  await expect.poll(async () => (await toolsIn(fresh.windowId)).find).toMatchObject({ open: true, query: 'orb' })
  await expect.poll(() => focusedUrl(orbit.app)).toContain('view=tools')
  const input = () =>
    orbit.app.evaluate(
      (_e, w) =>
        (
          globalThis as unknown as {
            __orbit: { ctx: { windows: { toolsContents: (w: string) => Electron.WebContents } } }
          }
        ).__orbit.ctx.windows
          .toolsContents(w)
          .executeJavaScript(`document.querySelector('[data-testid=find-input]')?.value ?? null`),
      fresh.windowId,
    )
  await expect.poll(input).toBe('orb')
  // Typing goes on in the bar; the page heard none of it.
  expect(await typeAnywhere(['i', 't'])).toEqual([
    expect.stringContaining('view=tools'),
    expect.stringContaining('view=tools'),
  ])
  await expect.poll(input).toBe('orbit')
  await expect.poll(async () => (await toolsIn(fresh.windowId)).find).toMatchObject({ query: 'orbit', matches: 3 })
  expect(await fieldValue(fresh.tabId)).toBe('')
})

// ---- Held keys (round 3 fix check, F2) ----

/** The value of a window's find field, as its page has it. */
function findInput(windowId: string): Promise<string | null> {
  return orbit.app.evaluate(
    (_e, w) =>
      (
        globalThis as unknown as {
          __orbit: { ctx: { windows: { toolsContents: (w: string) => Electron.WebContents } } }
        }
      ).__orbit.ctx.windows
        .toolsContents(w)
        .executeJavaScript(`document.querySelector('[data-testid=find-input]')?.value ?? null`),
    windowId,
  )
}

/** The first window's id. */
const firstWindow = () =>
  orbit.app.evaluate(
    () => (globalThis as unknown as { __orbit: { windowIds: () => string[] } }).__orbit.windowIds()[0] ?? '',
  )

/**
 * Keeps a window's page tools' page busy for `ms` (a script that runs that long). Resolves with
 * when it began, by main's clock.
 */
function busyTools(windowId: string, ms: number): Promise<number> {
  return orbit.app.evaluate(
    (_e, [w, t]) => {
      const tools = (
        globalThis as unknown as {
          __orbit: { ctx: { windows: { toolsContents: (w: string) => Electron.WebContents } } }
        }
      ).__orbit.ctx.windows.toolsContents(w)
      const began = new Promise<number>((resolve) => {
        const said = (...args: unknown[]) => {
          const busy = args.some(
            (a) =>
              a === 'orbit-busy' ||
              (typeof a === 'object' && !!a && (a as { message?: unknown }).message === 'orbit-busy'),
          )
          if (!busy) return
          tools.off('console-message', said)
          resolve(Date.now())
        }
        tools.on('console-message', said)
      })
      void tools.executeJavaScript(
        `console.log('orbit-busy'); { const until = Date.now() + ${t}; while (Date.now() < until) {} }`,
      )
      return began
    },
    [windowId, ms] as const,
  )
}

/** Records the name main hears for each key pressed in any web contents; returns a reader. */
async function watchKeyNames(): Promise<() => Promise<string[]>> {
  await orbit.app.evaluate(({ app: electronApp, webContents }) => {
    const g = globalThis as unknown as { __keyNames: string[] }
    g.__keyNames = []
    const watch = (contents: Electron.WebContents) =>
      contents.on('before-input-event', (_e, input) => {
        if (input.type === 'keyDown') g.__keyNames.push(input.key)
      })
    for (const contents of webContents.getAllWebContents()) watch(contents)
    electronApp.on('web-contents-created', (_e, contents) => watch(contents))
  })
  return () => orbit.app.evaluate(() => (globalThis as unknown as { __keyNames: string[] }).__keyNames)
}

/**
 * The real X keyboard on the test's display (xdotool and xmodmap, Linux), or null where there is none.
 * `addKeys` puts keysyms on spare keys, as a keyboard that has them does, until the returned undo.
 */
const xkeyboard = (() => {
  if (process.platform !== 'linux' || !process.env.DISPLAY) return null
  try {
    execFileSync('xdotool', ['version'], { stdio: 'ignore' })
    execFileSync('xmodmap', ['-pke'], { stdio: 'ignore' })
  } catch {
    return null
  }
  return {
    type: (text: string) => execFileSync('xdotool', ['type', '--delay', '40', text], { stdio: 'ignore' }),
    addKeys: (...keysyms: string[]): (() => void) => {
      const spare = execFileSync('xmodmap', ['-pke'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n')
        .map((line) => /^keycode\s+(\d+)\s*=\s*$/.exec(line)?.[1])
        .filter((code): code is string => !!code && Number(code) > 8)
        .slice(0, keysyms.length)
      if (spare.length < keysyms.length) throw new Error('no spare keys in the keymap')
      execFileSync(
        'xmodmap',
        spare.flatMap((code, i) => ['-e', `keycode ${code} = ${keysyms[i]}`]),
        { stdio: 'ignore' },
      )
      return () =>
        execFileSync(
          'xmodmap',
          spare.flatMap((code) => ['-e', `keycode ${code} =`]),
          { stdio: 'ignore' },
        )
    },
  }
})()

test('[NV-05] keys typed for the find bar while its page is busy arrive whole: “aBéßz” from a keyboard that has é and ß (round 3 fix check, F2)', async () => {
  test.skip(!xkeyboard, 'é and ß have to come from a keyboard that has them: test input names them no key')
  const x = xkeyboard as NonNullable<typeof xkeyboard>
  const { app } = orbit
  const url = fx.url(`/page/Busy?text=${encodeURIComponent('orbit aBéßz')}`)
  await openTab(app, url)
  const tab = await tabPage(app, '/page/Busy')
  // The bar's page has loaded; the page has the keyboard again.
  const tools = await openFind('/page/Busy')
  await cmd(app, 'find.close')
  await expect.poll(() => focusedUrl(app)).toContain('/page/Busy')
  const names = await watchKeyNames()
  const undo = x.addKeys('eacute', 'ssharp')
  try {
    // Chromium names the new keys once it has the new keymap (before, it names them "\u0000").
    const clearBox = () =>
      tab.evaluate(() => {
        const box = document.getElementById('box') as HTMLInputElement
        box.value = ''
        box.focus()
      })
    let named: string[] = []
    for (let i = 0; i < 10 && named.join() !== 'é'; i++) {
      await clearBox()
      const typed = (await names()).length
      x.type('é')
      await expect.poll(async () => (await names()).length).toBeGreaterThan(typed)
      named = (await names()).slice(typed)
    }
    expect(named).toEqual(['é'])
    await clearBox()
    const windowId = await firstWindow()
    const BUSY_MS = 2500
    const began = await busyTools(windowId, BUSY_MS)
    const before = (await names()).length
    await pressInPage(app, '/page/Busy', 'F', [mod])
    x.type('aBéßz')
    // Typed while the bar's page was busy: its field couldn't have had the keys.
    expect(Date.now() - began).toBeLessThan(BUSY_MS)
    await expect.poll(() => findInput(windowId), { timeout: 10_000 }).toBe('aBéßz')
    await expect.poll(async () => (await toolsInfo(app)).find).toMatchObject({ query: 'aBéßz', matches: 1 })
    expect((await names()).slice(before).filter((name) => name !== 'Shift')).toEqual(['f', 'a', 'B', 'é', 'ß', 'z'])
    expect(await tab.evaluate(() => (document.getElementById('box') as HTMLInputElement).value)).toBe('')
    await expect(tools.getByTestId('find-input')).toBeFocused()
  } finally {
    undo()
  }
})

test('[NV-05] a find bar whose page tools load after its keys were let go still takes the keyboard when it shows (round 3 fix check, F2)', async () => {
  // The next page tools' page starts loading late, as from a slow renderer: long after ⌘F.
  const LATE_MS = 8000
  await orbit.app.evaluate(({ webContents }, ms) => {
    type Load = (
      this: Electron.WebContents,
      where: string,
      options?: { query?: Record<string, string> },
    ) => Promise<void>
    const proto = Object.getPrototypeOf(webContents.getAllWebContents()[0]) as { loadFile: Load; loadURL: Load }
    const originals = { loadFile: proto.loadFile, loadURL: proto.loadURL }
    const g = globalThis as unknown as { __lateTools: number }
    for (const method of ['loadFile', 'loadURL'] as const) {
      const load = originals[method]
      proto[method] = function (this: Electron.WebContents, where, options) {
        if (options?.query?.view !== 'tools' && !where.includes('view=tools')) return load.call(this, where, options)
        Object.assign(proto, originals)
        this.once('did-finish-load', () => {
          g.__lateTools = Date.now()
        })
        setTimeout(() => void load.call(this, where, options).catch(() => {}), ms)
        return Promise.resolve()
      }
    }
  }, LATE_MS)
  const fresh = await earlyWindow(findPage('Late'), 'find', [])
  const asked = Date.now()
  expect((await toolsIn(fresh.windowId)).find).toMatchObject({ open: true })
  await expect.poll(async () => (await toolsIn(fresh.windowId)).placed, { timeout: LATE_MS + 10_000 }).toBe(true)
  // The page tools loaded after the keys held for the bar were let go (F4: 5 s).
  const loaded = await orbit.app.evaluate(() => (globalThis as unknown as { __lateTools: number }).__lateTools)
  expect(loaded - asked).toBeGreaterThan(5000)
  // The bar takes the keyboard all the same: typing goes on in it, not in the page.
  await expect.poll(() => focusedUrl(orbit.app)).toContain('view=tools')
  expect(await typeAnywhere(['o', 'r', 'b'])).toEqual(Array(3).fill(expect.stringContaining('view=tools')))
  await expect.poll(() => findInput(fresh.windowId)).toBe('orb')
  await expect.poll(async () => (await toolsIn(fresh.windowId)).find).toMatchObject({ query: 'orb', matches: 3 })
  expect(await fieldValue(fresh.tabId)).toBe('')
})
