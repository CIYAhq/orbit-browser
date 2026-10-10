import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from '../../src/shared/defaults'
import { action, FRAME_SLACK, isMac, launchOrbit, MOD, type Orbit, state, tabPage, tabView, viewPage } from './helpers'
import {
  activeTab,
  chooseHistory,
  cmd,
  cmdIn,
  floatingInfo,
  floatingPage,
  HOST_ARGS,
  historyMenu,
  INSECURE_HOST,
  type NavFixtures,
  NEW_TAB_CLICK,
  openTab,
  pageCorner,
  pageMouse,
  pointerAt,
  setNativeFullScreen,
  shellMouseMove,
  shellRoundTrip,
  spyCommand,
  startNavFixtures,
  tabCount,
  visit,
  waitLoaded,
  windowState,
} from './nav-support'
import { settled } from './tabs-support'

let fx: NavFixtures
let orbit: Orbit

test.beforeAll(async () => {
  fx = await startNavFixtures()
})
test.afterAll(async () => {
  await fx.close()
})
test.beforeEach(async () => {
  orbit = await launchOrbit({ args: HOST_ARGS })
  // macOS keeps the clipboard between tests (even after the app quits): start empty.
  await orbit.app.evaluate(({ clipboard }) => clipboard.clear())
})
test.afterEach(async () => {
  await orbit.app.close()
})

const page = (title: string) => fx.url(`/page/${title}`)

/** Opens the first page in a new tab, then visits the others in that tab. Returns the tab. */
async function tabWithHistory(...titles: [string, ...string[]]): Promise<string> {
  const [first, ...rest] = titles
  const id = await openTab(orbit.app, page(first))
  for (const title of rest) await visit(orbit.app, id, page(title))
  return id
}

/** The tab ids other than the given ones. */
async function otherTabs(...known: string[]): Promise<string[]> {
  return Object.keys((await state(orbit.app)).tabs).filter((id) => !known.includes(id))
}

test('[SB-03][NV-01] Back and Forward grey out when there is nowhere to go and act on the active tab', async () => {
  const { app, shell } = orbit
  const back = shell.getByTestId('nav-back')
  const forward = shell.getByTestId('nav-forward')
  const reload = shell.getByTestId('nav-reload')
  // No tab yet: nothing to act on.
  await expect(back).toBeDisabled()
  await expect(forward).toBeDisabled()
  await expect(reload).toBeDisabled()

  const id = await tabWithHistory('Alpha')
  await expect(reload).toBeEnabled()
  await expect(back).toBeDisabled()
  await visit(app, id, page('Beta'))
  await expect(back).toBeEnabled()
  await expect(forward).toBeDisabled()

  await back.click()
  await waitLoaded(app, id, page('Alpha'))
  await expect(forward).toBeEnabled()
  await expect(back).toBeDisabled()
  await forward.click()
  await waitLoaded(app, id, page('Beta'))
  await expect(forward).toBeDisabled()
  // Tooltips name the keys (KS-08).
  await expect(back).toHaveAttribute('title', isMac ? 'Back (⌘[)' : 'Back (Alt+←)')
  await expect(forward).toHaveAttribute('title', isMac ? 'Forward (⌘])' : 'Forward (Alt+→)')
  await expect(reload).toHaveAttribute('title', isMac ? 'Reload (⌘R)' : 'Reload (Ctrl+R)')
})

test('[SB-03][NV-01] long-press on Back lists the history nearest first, with icons; choosing one goes there', async () => {
  const { app, shell } = orbit
  const id = await tabWithHistory('One', 'Two', 'Three', 'Four')
  const presses = await spyCommand(app, 'nav.press')
  await shell.getByTestId('nav-back').hover()
  await shell.mouse.down()
  await expect
    .poll(() => historyMenu(app))
    .toMatchObject({ direction: 'back', labels: ['Three', 'Two', 'One'], icons: [true, true, true] })
  await shell.mouse.up()
  await shellRoundTrip(shell)
  // The long-press opened the menu instead of going back.
  expect(await presses()).toBe(0)
  expect((await state(app)).tabs[id]?.url).toBe(page('Four'))

  expect(await chooseHistory(app, 'One')).toBe(true)
  await waitLoaded(app, id, page('One'))
  expect(await historyMenu(app)).toBeNull()
  // Forward's menu lists the pages ahead, nearest first.
  await shell.getByTestId('nav-forward').hover()
  await shell.mouse.down()
  await expect.poll(() => historyMenu(app)).toMatchObject({ direction: 'forward', labels: ['Two', 'Three', 'Four'] })
  await shell.mouse.up()
  expect(await chooseHistory(app, 'Three')).toBe(true)
  await waitLoaded(app, id, page('Three'))
})

test('[NV-01] right-click on Back opens the history menu at once; switching tab closes it', async () => {
  const { app, shell } = orbit
  const id = await tabWithHistory('Red', 'Green')
  const other = await cmd<string>(app, 'tabs.create', { url: page('Blue'), activate: false })
  expect((await activeTab(app)).id).toBe(id)
  await shell.getByTestId('nav-back').click({ button: 'right' })
  await expect.poll(() => historyMenu(app)).toMatchObject({ direction: 'back', labels: ['Red'] })
  await cmd(app, 'tabs.activate', { tabId: other })
  await expect.poll(() => historyMenu(app)).toBeNull()
  // Nothing left to choose: the menu of the old tab is gone.
  expect(await chooseHistory(app, 'Red')).toBe(false)
  expect((await state(app)).tabs[id]?.url).toBe(page('Green'))
})

test('[SB-03][NV-01] ⌘-click or middle-click on Back opens the previous page in a new tab; the tab stays', async () => {
  const { app, shell } = orbit
  const id = await tabWithHistory('Before', 'Current')
  const back = shell.getByTestId('nav-back')

  await back.click({ modifiers: [NEW_TAB_CLICK] })
  await expect.poll(async () => (await otherTabs(id)).length).toBe(1)
  const [first] = await otherTabs(id)
  await waitLoaded(app, first as string, page('Before'))
  // The original tab still shows its page and stays selected.
  expect((await activeTab(app)).id).toBe(id)
  expect((await state(app)).tabs[id]?.url).toBe(page('Current'))
  // The new tab keeps the history: Forward leads to the page the click was made on.
  await expect.poll(async () => (await state(app)).tabs[first as string]?.canGoForward).toBe(true)

  await back.click({ button: 'middle' })
  await expect.poll(async () => (await otherTabs(id)).length).toBe(2)
  const [second] = await otherTabs(id, first as string)
  await waitLoaded(app, second as string, page('Before'))
  expect((await activeTab(app)).id).toBe(id)

  // With ⇧ the new tab comes to the front.
  await back.click({ modifiers: [NEW_TAB_CLICK, 'Shift'] })
  await expect.poll(async () => (await otherTabs(id)).length).toBe(3)
  const [third] = await otherTabs(id, first as string, second as string)
  await expect.poll(async () => (await activeTab(app)).id).toBe(third)
  expect((await state(app)).tabs[id]?.url).toBe(page('Current'))
})

test('[SB-03][NV-03] ⌘-click or middle-click on Reload duplicates the tab; the original stays selected', async () => {
  const { app, shell } = orbit
  const id = await tabWithHistory('Origin', 'Twin')
  const reload = shell.getByTestId('nav-reload')
  const before = await tabCount(app)

  await reload.click({ modifiers: [NEW_TAB_CLICK] })
  await expect.poll(() => tabCount(app)).toBe(before + 1)
  const [copy] = await otherTabs(id)
  await waitLoaded(app, copy as string, page('Twin'))
  expect((await state(app)).tabs[id]?.url).toBe(page('Twin'))
  expect((await activeTab(app)).id).toBe(id)
  // The duplicate has the history too.
  await expect.poll(async () => (await state(app)).tabs[copy as string]?.canGoBack).toBe(true)

  await reload.click({ button: 'middle' })
  await expect.poll(() => tabCount(app)).toBe(before + 2)
  expect((await activeTab(app)).id).toBe(id)
})

test('[SB-03][NV-04] Reload turns into Stop while the page loads; clicking it stops the load', async () => {
  const { app, shell } = orbit
  const path = '/slow-reload/Slow'
  const id = await openTab(app, fx.url(path))
  const reload = shell.getByTestId('nav-reload')
  await reload.click()
  // The reload is under way (the server holds it): the button is Stop now.
  await expect.poll(() => fx.hits(path)).toBe(2)
  await expect(reload).toHaveAttribute('data-loading', 'true')
  await expect(reload).toHaveAttribute('title', 'Stop (Esc)')
  await expect(reload).toHaveAttribute('aria-label', 'Stop')
  await reload.click()
  await expect.poll(async () => (await state(app)).tabs[id]?.loading).toBe(false)
  await expect(reload).not.toHaveAttribute('data-loading')
  await expect(reload).toHaveAttribute('aria-label', 'Reload')
  // The page that was showing stays.
  const shown = await tabPage(app, path)
  expect(await shown.evaluate(() => sessionStorage.getItem('loads'))).toBe('1')
})

test('[SB-03][NV-04] double-clicking Reload stops loading', async () => {
  const { app, shell } = orbit
  const reload = shell.getByTestId('nav-reload')
  // While a navigation is under way.
  const id = await openTab(app, page('Start'))
  await cmd(app, 'tabs.navigate', { tabId: id, url: fx.url('/slow/Never') })
  await expect.poll(() => fx.hits('/slow/Never')).toBe(1)
  await expect(reload).toHaveAttribute('data-loading', 'true')
  await reload.dblclick()
  await expect.poll(async () => (await state(app)).tabs[id]?.loading).toBe(false)
  expect((await state(app)).tabs[id]?.url).toBe(page('Start'))

  // On a loaded page: the first click reloads, the second stops that reload.
  const path = '/slow-reload/Again'
  const other = await openTab(app, fx.url(path))
  await reload.dblclick()
  await expect.poll(async () => (await state(app)).tabs[other]?.loading).toBe(false)
  await expect(reload).not.toHaveAttribute('data-loading')
  const shown = await tabPage(app, path)
  expect(await shown.evaluate(() => sessionStorage.getItem('loads'))).toBe('1')
})

test('[SB-03] the sidebar-toggle button hides the sidebar', async () => {
  const { app, shell } = orbit
  const toggle = shell.getByTestId('toggle-sidebar')
  await expect(toggle).toHaveAttribute('title', isMac ? 'Hide sidebar (⌘S)' : 'Hide sidebar (Ctrl+S)')
  await toggle.click()
  await expect.poll(async () => (await windowState(app)).sidebar.visible).toBe(false)
})

test('[SB-03] at the narrowest sidebar Back, Forward and Reload stay; the toggle gives way first', async () => {
  const { app, shell } = orbit
  await tabWithHistory('Narrow', 'Narrower')
  const sidebar = shell.getByTestId('sidebar')
  const toggle = shell.getByTestId('toggle-sidebar')
  await expect(toggle).toBeVisible()
  await cmd(app, 'window.setSidebar', { width: 180 })
  await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBeLessThanOrEqual(180)
  await expect(toggle).toBeHidden()
  const box = await sidebar.boundingBox()
  if (!box) throw new Error('no sidebar')
  const lead = await shell.getByTestId(isMac ? 'traffic-space' : 'window-controls').boundingBox()
  for (const testId of ['nav-back', 'nav-forward', 'nav-reload']) {
    const button = shell.getByTestId(testId)
    await expect(button).toBeVisible()
    const b = await button.boundingBox()
    if (!b || !lead) throw new Error(`no box for ${testId}`)
    expect(b.width).toBeGreaterThanOrEqual(24)
    // Inside the sidebar, clear of the window controls.
    expect(b.x).toBeGreaterThanOrEqual(lead.x + lead.width)
    expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width)
  }
})

test('[SB-03] off macOS the window controls sit at the top left of the sidebar', async () => {
  test.skip(isMac, 'macOS draws its own traffic lights there')
  const { shell } = orbit
  const controls = shell.getByTestId('window-controls')
  await expect(controls).toBeVisible()
  for (const title of ['Close', 'Minimize', 'Maximize']) await expect(controls.getByTitle(title)).toBeVisible()
  const c = await controls.boundingBox()
  const back = await shell.getByTestId('nav-back').boundingBox()
  if (!c || !back) throw new Error('no boxes')
  expect(c.x).toBeLessThan(back.x)
})

test('[SB-04] the address shows only the host; clicking it edits the full URL in the command bar', async () => {
  const { app, shell } = orbit
  const url = fx.url('/page/Deep?x=1')
  await openTab(app, url)
  const pill = shell.getByTestId('address-pill')
  await expect(pill).toHaveText(`localhost:${fx.port}`)
  await expect(pill).toHaveAttribute('title', url)
  await pill.click()
  const overlay = await viewPage(app, 'overlay')
  const input = overlay.getByTestId('command-input')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue(url)
  expect((await windowState(app)).overlay).toMatchObject({ kind: 'commandbar', mode: 'edit-url' })
})

test('[SB-04][NV-04] while a page is on its way, editing the address starts from where it is going, as the address shows (review A-F3)', async () => {
  const { app, shell } = orbit
  const id = await openTab(app, page('Before'))
  const going = fx.url('/slow/After?ms=30000')
  await cmd(app, 'tabs.navigate', { tabId: id, url: going })
  const pill = shell.getByTestId('address-pill')
  await expect(pill).toHaveAttribute('title', going)
  await pill.click()
  const input = (await viewPage(app, 'overlay')).getByTestId('command-input')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue(going)
  expect((await state(app)).tabs[id]?.url).toBe(page('Before'))
})

test('[SB-04][NV-12] an address without a host says what it is: a page’s source, a data: page (review A-F2)', async () => {
  const { app, shell } = orbit
  const pill = shell.getByTestId('address-pill')
  await cmd(app, 'tabs.create', { url: `view-source:${page('Source')}` })
  await expect(pill).toHaveText(`view-source:localhost:${fx.port}`)
  await cmd(app, 'tabs.create', { url: 'data:text/html,<title>Data</title>Hello' })
  await expect(pill).toHaveText('data:text/html')
})

test('[SB-04] no padlock on pages; plain http to another machine shows a warning', async () => {
  const { app, shell } = orbit
  const address = shell.getByTestId('address')
  await expect(address).toHaveClass(/address--empty/)
  await openTab(app, fx.urlOn(INSECURE_HOST, '/page/Plain'))
  await expect(address).toHaveAttribute('data-connection', 'insecure')
  await expect(shell.getByTestId('insecure-icon')).toBeVisible()
  await expect(shell.getByTestId('address-pill')).toHaveText(`${INSECURE_HOST}:${fx.port}`)
  // This machine over http is a secure context: no warning, and never a padlock.
  await openTab(app, page('Local'))
  await expect(address).toHaveAttribute('data-connection', 'local')
  await expect(shell.getByTestId('insecure-icon')).toHaveCount(0)
  await expect(shell.getByTestId('site-controls-button')).toBeVisible()
  await expect(address.locator('.lucide-lock')).toHaveCount(0)
})

test('[SB-04][NV-17] the copy button copies the clean URL and confirms it', async () => {
  const { app, shell } = orbit
  await openTab(app, fx.url('/page/Shop?utm_source=x&id=7'))
  await shell.getByTestId('address').hover()
  const copy = shell.getByTestId('copy-url-button')
  await expect(copy).toHaveCSS('opacity', '1')
  await copy.click()
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(fx.url('/page/Shop?id=7'))
  await expect(shell.getByTestId('toast').filter({ hasText: 'Copied' })).toBeVisible()
  await expect(copy).toHaveClass(/is-copied/)
})

test('[NV-17] copying the address from the command bar shows a one-time tip about the shortcut', async () => {
  const { app, shell } = orbit
  const url = page('Hint')
  await openTab(app, url)
  const hints = await spyCommand(app, 'nav.copyHint')
  const tip = shell.getByTestId('toast').filter({ hasText: 'Tip:' })

  const copyFromBar = async () => {
    await shell.getByTestId('address-pill').click()
    const overlay = await viewPage(app, 'overlay')
    const input = overlay.getByTestId('command-input')
    await expect(input).toBeFocused()
    await expect(input).toHaveValue(url)
    // ⌘C reaches the field through the Edit menu on macOS, which calls copy() on the page.
    if (isMac) {
      await app.evaluate(({ webContents }) =>
        webContents
          .getAllWebContents()
          .find((w) => w.getURL().includes('view=overlay'))
          ?.copy(),
      )
    } else {
      await overlay.keyboard.press('Control+C')
    }
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(url)
    await overlay.keyboard.press('Escape')
    await expect.poll(async () => (await windowState(app)).overlay.kind).toBe('none')
  }

  await copyFromBar()
  await expect(tip).toBeVisible()
  await expect(tip).toContainText(isMac ? '⇧⌘C' : 'Ctrl+Shift+C')
  expect(await hints()).toBe(1)
  // Remembered for good (a file in the profile directory).
  const file = join(orbit.userData, 'orbit-site-prefs.json')
  await expect
    .poll(() => existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).hints?.['copy-url'] === true)
    .toBe(true)
  await expect(tip).toHaveCount(0)
  // The second time: no tip.
  await copyFromBar()
  await expect.poll(() => hints()).toBe(2)
  await expect(tip).toHaveCount(0)
})

test('[SB-04][SB-03] in split view the address and buttons follow the focused pane', async () => {
  const { app, shell } = orbit
  const left = await tabWithHistory('LeftOne', 'LeftTwo')
  const right = await openTab(app, fx.urlOn('127.0.0.1', '/page/Right'))
  await cmd(app, 'split.create', { tabIds: [left, right], focus: right })
  const pill = shell.getByTestId('address-pill')
  await expect(pill).toHaveText(`127.0.0.1:${fx.port}`)
  await expect(shell.getByTestId('nav-back')).toBeDisabled()
  await cmd(app, 'split.focusPane', { tabId: left })
  await expect(pill).toHaveText(`localhost:${fx.port}`)
  await shell.getByTestId('nav-back').click()
  await waitLoaded(app, left, page('LeftOne'))
  expect((await state(app)).tabs[right]?.url).toBe(fx.urlOn('127.0.0.1', '/page/Right'))
})

test('[NV-01][SB-03] Back on a fresh tab opened from a link closes it and returns to the opener', async () => {
  const { app, shell } = orbit
  const opener = await openTab(app, page('Parent'))
  const tab = await tabPage(app, '/page/Parent')
  await tab.click('#child')
  await expect.poll(async () => (await otherTabs(opener)).length).toBe(1)
  const [child] = await otherTabs(opener)
  await waitLoaded(app, child as string, page('Parent-child'))
  await expect.poll(async () => (await activeTab(app)).id).toBe(child)
  const back = shell.getByTestId('nav-back')
  await expect(back).toBeEnabled()
  await back.click()
  await expect.poll(async () => (await state(app)).tabs[child as string]).toBeUndefined()
  expect((await activeTab(app)).id).toBe(opener)
})

// ---------- Hiding, revealing and resizing the sidebar (SB-11, SB-12, SB-14, FL-02, FL-03) ----------

/** The card's margin with the sidebar hidden, and the band beside the floating card (SB-12, SB-19). */
const MARGIN_HIDDEN = 6
const FLOAT_BAND = 16

async function sidebarState() {
  return (await windowState(orbit.app)).sidebar
}

/** The first window's content size. */
function contentSize(): Promise<{ width: number; height: number }> {
  return orbit.app.evaluate(() => {
    const hooks = (
      globalThis as unknown as {
        __orbit: {
          ctx: { windows: { get: (id: string) => Electron.BrowserWindow | undefined } }
          windowIds: () => string[]
        }
      }
    ).__orbit
    const [width = 0, height = 0] = hooks.ctx.windows.get(hooks.windowIds()[0] as string)?.getContentSize() ?? []
    return { width, height }
  })
}

/** Hides the sidebar and waits until the docked one has slid away. */
async function hideSidebar(): Promise<void> {
  await cmd(orbit.app, 'window.setSidebar', { visible: false })
  await expect(orbit.shell.getByTestId('sidebar')).toBeHidden()
}

/** Brings the floating sidebar in from the window's left edge and returns its page. */
async function revealFloating(): Promise<Page> {
  // Into the edge from the page: a pointer resting there doesn't count.
  await orbit.shell.mouse.move(40, 300)
  await orbit.shell.mouse.move(2, 300)
  await expect.poll(async () => (await sidebarState()).peeking).toBe(true)
  const floating = await floatingPage(orbit.app)
  await expect(floating.getByTestId('floating-sidebar')).toHaveAttribute('data-out', 'true')
  return floating
}

/** macOS: where the window's traffic lights are. */
const windowButtons = () =>
  orbit.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getWindowButtonPosition() ?? null)

const clicksSeen = (tab: Page) =>
  tab.evaluate(() => (window as unknown as { __clicks: { x: number; y: number; button: number }[] }).__clicks)

test('[SB-11] ⌘S hides the sidebar and the page card takes the window; again brings it back as it was', async () => {
  const { app, shell } = orbit
  const id = await openTab(app, page('Wide'))
  for (let n = 0; n < 30; n++) await cmd(app, 'tabs.create', { url: `http://127.0.0.1:9/t${n}`, activate: false })
  await cmd(app, 'window.setSidebar', { width: 300 })
  const scroll = shell.getByTestId('sidebar-scroll')
  await expect.poll(() => scroll.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(200)
  // Scrolled once the rows have grown in and the sidebar has its new width: rows still growing
  // above the visible ones would move the scroll position (review A-F9).
  await expect.poll(async () => (await shell.getByTestId('sidebar').boundingBox())?.width).toBe(300)
  await settled(shell)
  await scroll.evaluate((el) => {
    el.scrollTop = 120
  })
  expect(await scroll.evaluate((el) => el.scrollTop)).toBe(120)
  const size = await contentSize()

  await shell.keyboard.press(`${MOD}+S`)
  await expect.poll(async () => (await sidebarState()).visible).toBe(false)
  // The card spans the window but for a thin margin on every side.
  await expect
    .poll(async () => (await tabView(app, id))?.bounds)
    .toEqual({
      x: MARGIN_HIDDEN,
      y: MARGIN_HIDDEN,
      width: size.width - 2 * MARGIN_HIDDEN,
      height: size.height - 2 * MARGIN_HIDDEN,
    })
  await expect(shell.getByTestId('sidebar')).toBeHidden()
  await expect(shell.getByTestId('nav-back')).toBeHidden()

  // Back at the same width, scroll position and selected tab.
  await shell.keyboard.press(`${MOD}+S`)
  await expect.poll(async () => (await sidebarState()).visible).toBe(true)
  await expect(shell.getByTestId('sidebar')).toBeVisible()
  await expect.poll(async () => (await tabView(app, id))?.bounds.x).toBe(300)
  expect((await shell.getByTestId('sidebar').boundingBox())?.width).toBe(300)
  expect(await scroll.evaluate((el) => el.scrollTop)).toBe(120)
  expect((await activeTab(app)).id).toBe(id)
})

test('[SB-11] Toggle Sidebar is an action in the command bar (and the View menu on macOS)', async () => {
  const { app, shell } = orbit
  await openTab(app, page('Menus'))
  await shell.keyboard.press(`${MOD}+T`)
  const overlay = await viewPage(app, 'overlay')
  await expect(overlay.getByTestId('command-input')).toBeFocused()
  await overlay.keyboard.type('Toggle Sidebar')
  await expect(overlay.getByTestId('command-result').first()).toContainText('Toggle Sidebar')
  await overlay.keyboard.press('Enter')
  await expect.poll(async () => (await sidebarState()).visible).toBe(false)
  if (isMac) {
    await app.evaluate(({ Menu }) => {
      const view = Menu.getApplicationMenu()?.items.find((i) => i.label === 'View')
      const item = view?.submenu?.items.find((i) => i.label === 'Toggle Sidebar')
      item?.click()
    })
    await expect.poll(async () => (await sidebarState()).visible).toBe(true)
  }
})

test('[SB-11][SB-14] each window keeps its own sidebar state and width, across a restart', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'orbit-e2e-sidebar-'))
  await orbit.app.close()
  orbit = await launchOrbit({ userData, args: HOST_ARGS })
  await openTab(orbit.app, page('Kept'))
  await cmd(orbit.app, 'window.setSidebar', { width: 320 })
  await hideSidebar()
  // A new window opens with its sidebar shown, whatever the others do.
  await action(orbit.app, 'window.new')
  await expect.poll(async () => Object.keys((await state(orbit.app)).windows).length).toBe(2)
  const firstId = (await windowState(orbit.app)).id
  const second = Object.values((await state(orbit.app)).windows).find((w) => w.id !== firstId)
  expect(second?.sidebar.visible).toBe(true)
  await orbit.app.close()

  orbit = await launchOrbit({ userData, args: HOST_ARGS })
  const windows = Object.values((await state(orbit.app)).windows)
  const first = windows.find((w) => !w.sidebar.visible)
  expect(first?.sidebar.width).toBe(320)
  expect(windows.filter((w) => w.sidebar.visible)).toHaveLength(windows.length - 1)
})

test('[FL-02] the sidebar slides out as the card widens, edge to edge in every frame; ⌘S again reverses it', async () => {
  const { app, shell } = orbit
  await openTab(app, page('Slide'))
  const width = (await sidebarState()).width
  /** The sidebar's right edge and the card's left edge, every frame for 700 ms after a toggle (and another at `reverseAt`). */
  const record = (reverseAt: number | null) =>
    shell.evaluate(async (at) => {
      const sidebar = document.querySelector('[data-testid="sidebar"]') as HTMLElement
      const frame = document.querySelector('[data-testid="content-frame"]') as HTMLElement
      const orbitApi = (window as unknown as { orbit: { invoke: (n: string, a: unknown) => Promise<unknown> } }).orbit
      const out: { t: number; right: number; left: number }[] = []
      const t0 = performance.now()
      void orbitApi.invoke('action.run', { id: 'sidebar.toggle' })
      if (at !== null) setTimeout(() => void orbitApi.invoke('action.run', { id: 'sidebar.toggle' }), at)
      await new Promise<void>((resolve) => {
        const tick = () => {
          const t = performance.now() - t0
          out.push({ t, right: sidebar.getBoundingClientRect().right, left: frame.getBoundingClientRect().left })
          if (t < 700) requestAnimationFrame(tick)
          else resolve()
        }
        requestAnimationFrame(tick)
      })
      return out
    }, reverseAt)

  const hide = await record(null)
  // One value drives both: the card's left edge stays at the sidebar's right edge plus the margin.
  for (const f of hide) {
    expect(f.left - f.right, `at ${Math.round(f.t)} ms`).toBeGreaterThanOrEqual(-1)
    expect(f.left - f.right, `at ${Math.round(f.t)} ms`).toBeLessThanOrEqual(MARGIN_HIDDEN + 1)
  }
  expect(hide.some((f) => f.right > 0 && f.right < width)).toBe(true)
  const gone = hide.find((f) => f.right <= 0.5)
  expect(gone?.t ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(300 * FRAME_SLACK + 50)
  expect(hide[hide.length - 1]?.left).toBe(MARGIN_HIDDEN)
  await expect.poll(async () => (await sidebarState()).visible).toBe(false)

  // Show, then ⌘S again part way: it turns back from where it is.
  const shown = await record(null)
  expect(shown[shown.length - 1]?.right).toBe(width)
  const reversed = await record(90)
  for (const f of reversed) {
    expect(f.left - f.right).toBeGreaterThanOrEqual(-1)
    expect(f.left - f.right).toBeLessThanOrEqual(MARGIN_HIDDEN + 1)
  }
  if (FRAME_SLACK === 1) expect(Math.min(...reversed.map((f) => f.right))).toBeGreaterThan(0)
  expect(reversed[reversed.length - 1]?.right).toBe(width)
  await expect.poll(async () => (await sidebarState()).visible).toBe(true)
})

test('[SB-11][FL-02] the page keeps out of the sliding sidebar’s way: hiding, it stays where it was until the sidebar has gone; showing, it goes at once to where it ends (review A-M4)', async () => {
  const { app, shell } = orbit
  const id = await openTab(app, page('Native'))
  const width = (await sidebarState()).width
  await expect.poll(async () => (await tabView(app, id))?.bounds.x).toBe(width)
  // Every place main puts the page's native view, and when (by the wall clock, which both processes share).
  await app.evaluate((_electron, tabId) => {
    const hooks = (
      globalThis as unknown as {
        __orbit: { ctx: { tabs: { get: (id: string) => Electron.WebContentsView | undefined } } }
      }
    ).__orbit
    const view = hooks.ctx.tabs.get(tabId)
    if (!view) throw new Error(`no view for ${tabId}`)
    const moves: { t: number; x: number }[] = []
    ;(globalThis as unknown as { __moves: typeof moves }).__moves = moves
    const setBounds = view.setBounds.bind(view)
    view.setBounds = (bounds: Electron.Rectangle) => {
      moves.push({ t: Date.now(), x: bounds.x })
      setBounds(bounds)
    }
  }, id)
  const takeMoves = () =>
    app.evaluate(() => (globalThis as unknown as { __moves: { t: number; x: number }[] }).__moves.splice(0))
  /** Toggles the sidebar from the shell: when, and when its column stopped sliding. */
  const toggle = () =>
    shell.evaluate(async () => {
      const el = document.querySelector('[data-testid="shell"]') as HTMLElement
      const orbitApi = (window as unknown as { orbit: { invoke: (n: string, a: unknown) => Promise<unknown> } }).orbit
      const ended = new Promise<number>((resolve) => {
        const done = (e: TransitionEvent) => {
          if (e.target !== el || e.propertyName !== 'grid-template-columns') return
          el.removeEventListener('transitionend', done)
          resolve(Date.now())
        }
        el.addEventListener('transitionend', done)
      })
      const start = Date.now()
      void orbitApi.invoke('action.run', { id: 'sidebar.toggle' })
      return { start, end: await ended }
    })

  // Hiding: the view stays at its start until the sidebar has gone, then takes the window.
  const hid = await toggle()
  expect(hid.end - hid.start).toBeGreaterThan(100)
  await expect.poll(async () => (await tabView(app, id))?.bounds.x).toBe(MARGIN_HIDDEN)
  const hiding = await takeMoves()
  const sliding = hiding.filter((m) => m.t < hid.end)
  expect(
    sliding.map((m) => m.x),
    'where main put the view while the sidebar slid out',
  ).toEqual(sliding.map(() => width))
  expect(hiding.at(-1)?.x).toBe(MARGIN_HIDDEN)

  // Showing: the first move already puts it where it ends, clear of the sidebar coming in.
  const shown = await toggle()
  expect(shown.end - shown.start).toBeGreaterThan(100)
  await expect.poll(async () => (await tabView(app, id))?.bounds.x).toBe(width)
  const showing = await takeMoves()
  expect(showing[0]?.x, 'the first place main put the view once the sidebar started to slide in').toBe(width)
  expect(showing[0]?.t ?? Number.POSITIVE_INFINITY).toBeLessThan(shown.end)
  expect(showing.every((m) => m.x === width)).toBe(true)
})

test('[SB-12][FL-03] with the sidebar hidden, the left edge brings it in over the page; it goes once the pointer moves on', async () => {
  const { app, shell } = orbit
  const id = await openTab(app, page('Under'))
  const tab = await tabPage(app, '/page/Under')
  await hideSidebar()
  await tab.evaluate(() => window.scrollTo(0, 300))
  const before = { bounds: (await tabView(app, id))?.bounds, width: await tab.evaluate(() => innerWidth) }
  const { height } = await contentSize()
  const { width } = await sidebarState()

  const floating = await revealFloating()
  const info = await floatingInfo(app)
  expect(info.placed).toBe(true)
  expect(info.bounds).toEqual({ x: 0, y: 0, width: MARGIN_HIDDEN + width + FLOAT_BAND, height })
  // A card inset from the window's edges, slid in (its timing, frame by frame: feel-sidebar.spec.ts).
  const slide = floating.locator('.float-sidebar__slide')
  await expect
    .poll(() => slide.evaluate((el) => getComputedStyle(el).transform))
    .toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/)
  const box = await slide.boundingBox()
  expect(box).toEqual({ x: MARGIN_HIDDEN, y: MARGIN_HIDDEN, width, height: height - 2 * MARGIN_HIDDEN })
  // Everything a docked sidebar has.
  await expect(floating.getByTestId('nav-reload')).toBeVisible()
  await expect(floating.getByTestId('address')).toContainText('localhost')
  await expect(floating.getByTestId('toggle-sidebar')).toHaveAttribute('title', /^Show sidebar/)
  // macOS: the traffic lights come in with the card, in its top row.
  if (isMac) expect(await windowButtons()).toEqual({ x: 16 + MARGIN_HIDDEN, y: 17 + MARGIN_HIDDEN })
  // The page neither moved, resized nor scrolled.
  expect((await tabView(app, id))?.bounds).toEqual(before.bounds)
  expect(await tab.evaluate(() => innerWidth)).toBe(before.width)
  expect(await tab.evaluate(() => scrollY)).toBe(300)
  void shell

  // The pointer moves on over the page: it stays a moment, then slides away and leaves the window.
  const left = Date.now()
  await pageMouse(app, '/page/Under', 'mouseMove', 700, 300)
  await expect.poll(async () => (await floatingInfo(app)).hold?.over ?? false).toBe(false)
  expect((await sidebarState()).peeking).toBe(true)
  await expect.poll(async () => (await sidebarState()).peeking).toBe(false)
  expect(Date.now() - left).toBeGreaterThanOrEqual(300)
  await expect(floating.getByTestId('floating-sidebar')).toHaveAttribute('data-out', 'false')
  await expect.poll(async () => (await floatingInfo(app)).placed).toBe(false)
  expect(Date.now() - left).toBeLessThan(1000 * FRAME_SLACK)
  expect((await tabView(app, id))?.bounds).toEqual(before.bounds)
})

test('[SB-12][FL-03] back over the card it stays; re-entering the edge as it leaves brings it back', async () => {
  const { app } = orbit
  await openTab(app, page('Return'))
  await hideSidebar()
  const floating = await revealFloating()
  // Over the page, then back over the card before the grace delay ends.
  await pageMouse(app, '/page/Return', 'mouseMove', 700, 300)
  await expect.poll(async () => (await floatingInfo(app)).hold?.over ?? true).toBe(false)
  await floating.mouse.move(100, 400)
  await expect.poll(async () => (await floatingInfo(app)).hold?.over ?? false).toBe(true)
  expect((await floatingInfo(app)).hold?.hiding).toBe(false)
  expect((await sidebarState()).peeking).toBe(true)
  // Leaving through the window's left edge counts as leaving.
  await floating.mouse.move(-5, 400)
  await expect.poll(async () => (await sidebarState()).peeking).toBe(false)
  // The edge again while it slides away: the same view turns back.
  const id = await floating.evaluate(() => performance.timeOrigin)
  await revealFloating()
  expect((await floatingInfo(app)).placed).toBe(true)
  expect(await (await floatingPage(app)).evaluate(() => performance.timeOrigin)).toBe(id)
})

test('[SB-12] a pointer passing through the edge on its way out of the window brings the sidebar in, and it goes again', async () => {
  const { app, shell } = orbit
  await openTab(app, page('Passing'))
  await hideSidebar()
  await revealFloating()
  await shell.mouse.move(-30, 300)
  await expect.poll(async () => (await floatingInfo(app)).hold?.over).toBe(false)
  await expect.poll(async () => (await sidebarState()).peeking).toBe(false)
  if (isMac) expect(await windowButtons()).toEqual({ x: 16, y: 17 })
})

test('[SB-12] a click into the page sends the floating sidebar away at once; a click beside it reaches the page', async () => {
  const { app } = orbit
  await openTab(app, page('Clicks'))
  const tab = await tabPage(app, '/page/Clicks')
  await hideSidebar()
  await revealFloating()
  const at = Date.now()
  await pageMouse(app, '/page/Clicks', 'mouseDown', 600, 200)
  await pageMouse(app, '/page/Clicks', 'mouseUp', 600, 200)
  await expect.poll(async () => (await sidebarState()).peeking).toBe(false)
  expect(Date.now() - at).toBeLessThan(400 * FRAME_SLACK)

  // In the band beside the card: the card goes and the page gets the click where it was made.
  const floating = await revealFloating()
  const { width } = await sidebarState()
  const x = MARGIN_HIDDEN + width + 8
  await floating.mouse.click(x, 250)
  await expect.poll(async () => (await sidebarState()).peeking).toBe(false)
  await expect.poll(() => clicksSeen(tab)).toContainEqual({ x: x - MARGIN_HIDDEN, y: 250 - MARGIN_HIDDEN, button: 0 })
})

test('[SB-12] the floating sidebar works like the docked one and stays while the command bar is open; ⌘S docks it', async () => {
  const { app, shell } = orbit
  const first = await openTab(app, page('One'))
  const second = await openTab(app, page('Two'))
  await hideSidebar()
  const floating = await revealFloating()
  // Switch tabs from it.
  await floating.locator(`[data-testid="tab-row"][data-tab-id="${first}"]`).click()
  await expect.poll(async () => (await activeTab(app)).id).toBe(first)
  expect((await sidebarState()).peeking).toBe(true)
  // New Tab opens the command bar over it; it stays, even once the pointer has gone over the page.
  await floating.getByTestId('new-tab-button').click()
  await expect.poll(async () => (await windowState(app)).overlay.kind).toBe('commandbar')
  await pageMouse(app, '/page/One', 'mouseMove', 700, 300)
  await expect.poll(async () => (await floatingInfo(app)).hold?.over).toBe(false)
  expect((await floatingInfo(app)).hold).toMatchObject({ overlay: true, hiding: false })
  expect((await sidebarState()).peeking).toBe(true)
  expect((await floatingInfo(app)).placed).toBe(true)
  // Closing the bar lets it go.
  const overlay = await viewPage(app, 'overlay')
  await overlay.keyboard.press('Escape')
  await expect.poll(async () => (await windowState(app)).overlay.kind).toBe('none')
  await expect.poll(async () => (await sidebarState()).peeking).toBe(false)

  // ⌘S while it is out docks it.
  await revealFloating()
  await floating.keyboard.press(`${MOD}+S`)
  await expect.poll(async () => (await sidebarState()).visible).toBe(true)
  await expect(shell.getByTestId('sidebar')).toBeVisible()
  await expect.poll(async () => (await floatingInfo(app)).placed).toBe(false)
  expect((await activeTab(app)).id).toBe(first)
  void second
})

test('[SB-12] renaming a tab in the floating sidebar keeps it out until done', async () => {
  const { app } = orbit
  const id = await openTab(app, page('Rename'))
  await hideSidebar()
  const floating = await revealFloating()
  await floating.locator(`[data-testid="tab-row"][data-tab-id="${id}"]`).dblclick()
  const input = floating.getByTestId('rename-field')
  await expect(input).toBeFocused()
  await expect.poll(async () => (await floatingInfo(app)).hold?.editing).toBe(true)
  // The pointer goes over the page: the field holds the card.
  await pageMouse(app, '/page/Rename', 'mouseMove', 700, 300)
  await expect.poll(async () => (await floatingInfo(app)).hold?.over).toBe(false)
  expect((await floatingInfo(app)).hold).toMatchObject({ editing: true, hiding: false })
  expect((await sidebarState()).peeking).toBe(true)
  await input.fill('Studio')
  await input.press('Enter')
  await expect.poll(async () => (await state(app)).tabs[id]?.customTitle).toBe('Studio')
  // Done: it slides away.
  await expect.poll(async () => (await sidebarState()).peeking).toBe(false)
})

test('[SB-12] the edge does nothing while the sidebar is docked or the command bar is open, nor for a pointer resting there', async () => {
  const { app, shell } = orbit
  await openTab(app, page('Quiet'))
  await shell.mouse.move(40, 300)
  await shell.mouse.move(2, 300)
  await shellRoundTrip(shell)
  expect((await sidebarState()).peeking).toBe(false)
  await expect(shell.getByTestId('sidebar-edge')).toHaveCount(0)
  // Hidden with the pointer at the edge: it doesn't come straight back.
  await hideSidebar()
  await expect(shell.getByTestId('sidebar-edge')).toHaveCount(1)
  await shellRoundTrip(shell)
  expect((await sidebarState()).peeking).toBe(false)
  await shell.keyboard.press(`${MOD}+T`)
  await expect.poll(async () => (await windowState(app)).overlay.kind).toBe('commandbar')
  await cmd(app, 'sidebar.reveal')
  await shell.mouse.move(2, 320)
  await shellRoundTrip(shell)
  expect((await sidebarState()).peeking).toBe(false)
})

test('[SB-12][FL-03] a pointer coming off the page brings the sidebar in with the first move the edge hears (review A-M2)', async () => {
  const { app } = orbit
  await openTab(app, page('Coming'))
  await hideSidebar()
  // Over the page, as a person's pointer is before it goes for the edge.
  await pageMouse(app, '/page/Coming', 'mouseMove', 400, 300)
  await pageMouse(app, '/page/Coming', 'mouseMove', 200, 300)
  // One move at the edge: the first the shell hears, so it has no movement of its own.
  await shellMouseMove(app, 3, 300)
  await expect.poll(async () => (await sidebarState()).peeking).toBe(true)
})

test('[SB-12][FL-03] a pointer that leaves the page for the window’s very edge, where nothing in the window hears it (Linux keeps it for resizing), brings the sidebar in (review A-M2)', async () => {
  const { app } = orbit
  const id = await openTab(app, page('Leaving'))
  await hideSidebar()
  await pageMouse(app, '/page/Leaving', 'mouseMove', 300, 300)
  const card = (await tabView(app, id))?.bounds
  if (!card) throw new Error('no page view')
  // The pointer jumps to x = 2 of the window: the page hears it leave, and nothing hears it arrive.
  await pageMouse(app, '/page/Leaving', 'mouseLeave', 2 - card.x, 300)
  await expect.poll(async () => (await sidebarState()).peeking).toBe(true)
  // Somewhere else, it doesn't: the right edge.
  await pageMouse(app, '/page/Leaving', 'mouseMove', 300, 300)
  await expect.poll(async () => (await sidebarState()).peeking).toBe(false)
  await pageMouse(app, '/page/Leaving', 'mouseLeave', card.width + 3, 300)
  await shellRoundTrip(orbit.shell)
  expect((await sidebarState()).peeking).toBe(false)
})

test('[SB-12][FL-03] the card the window’s very edge brought in goes again when the pointer leaves the window there, where nothing hears it (fix check A, M1)', async () => {
  const { app } = orbit
  const id = await openTab(app, page('Outward'))
  await hideSidebar()
  await pageMouse(app, '/page/Outward', 'mouseMove', 300, 300)
  const card = (await tabView(app, id))?.bounds
  if (!card) throw new Error('no page view')
  await pageMouse(app, '/page/Outward', 'mouseLeave', 2 - card.x, 300)
  await expect.poll(async () => (await sidebarState()).peeking).toBe(true)
  expect((await floatingInfo(app)).hold?.over).toBe(true)
  // On out of the window through its left edge: neither the card nor a page hears that.
  const left = Date.now()
  await pointerAt(app, -40, 300)
  await expect.poll(async () => (await sidebarState()).peeking, { timeout: 1000 * FRAME_SLACK }).toBe(false)
  expect(Date.now() - left).toBeLessThan(1000 * FRAME_SLACK)
  // A pointer still at the very edge keeps it out: main reads it every 20 ms, and it is in the window.
  await pageMouse(app, '/page/Outward', 'mouseMove', 300, 300)
  await pageMouse(app, '/page/Outward', 'mouseLeave', 2 - card.x, 300)
  await expect.poll(async () => (await sidebarState()).peeking).toBe(true)
  await pointerAt(app, 1, 320)
  await new Promise((r) => setTimeout(r, 300))
  expect((await floatingInfo(app)).hold).toMatchObject({ over: true, hiding: false })
  expect((await sidebarState()).peeking).toBe(true)
})

test('[SB-12][FL-03] a pointer that leaves the window from inside the card, where the card can’t tell it went, lets the card go; it stays while the pointer is in the window or a menu is up (round 2 fix check, M4)', async () => {
  const { app } = orbit
  await openTab(app, page('Inside'))
  await hideSidebar()
  const floating = await revealFloating()
  /** The pointer moves over the card, which hears it. */
  const overCard = async () => {
    await floating.mouse.move(100, 400)
    await floating.mouse.move(110, 410)
    await expect.poll(async () => (await floatingInfo(app)).hold?.over).toBe(true)
  }
  // The card's last word as the pointer goes over the window's resize border or the card's drag
  // region, where nothing hears it: a leave at x = 2, to nothing.
  const leaveCard = () =>
    floating.evaluate(() =>
      document.body.dispatchEvent(new MouseEvent('mouseout', { clientX: 2, clientY: 45, bubbles: true })),
    )
  await overCard()
  await leaveCard()
  // On out of the window: the card goes within a second.
  const left = Date.now()
  await pointerAt(app, -40, 300)
  await expect.poll(async () => (await sidebarState()).peeking, { timeout: 1000 * FRAME_SLACK }).toBe(false)
  expect(Date.now() - left).toBeLessThan(1000 * FRAME_SLACK)

  // Still in the window, over the card's drag region: the card stays.
  await revealFloating()
  await overCard()
  await leaveCard()
  await pointerAt(app, 3, 45)
  await new Promise((r) => setTimeout(r, 1000))
  expect((await floatingInfo(app)).hold).toMatchObject({ over: true, hiding: false })
  expect((await sidebarState()).peeking).toBe(true)

  // A menu from the card is up, reaching out of the window where the pointer went: the card stays
  // while the menu is up, and goes once it closes.
  await app.evaluate(({ Menu }) => {
    const o = (
      globalThis as unknown as {
        __orbit: { windowIds: () => string[]; ctx: { windows: { get: (w: string) => Electron.BrowserWindow } } }
      }
    ).__orbit
    const menu = Menu.buildFromTemplate([{ label: 'Kept' }, { label: 'Out' }])
    ;(globalThis as unknown as { __menu: Electron.Menu }).__menu = menu
    const [first] = o.windowIds()
    if (!first) throw new Error('no window')
    menu.popup({ window: o.ctx.windows.get(first), x: 120, y: 60 })
  })
  await pointerAt(app, -40, 300)
  await new Promise((r) => setTimeout(r, 1000))
  expect((await floatingInfo(app)).hold).toMatchObject({ over: true, hiding: false })
  expect((await sidebarState()).peeking).toBe(true)
  const closed = Date.now()
  await app.evaluate(() => (globalThis as unknown as { __menu: Electron.Menu }).__menu.closePopup())
  await expect.poll(async () => (await sidebarState()).peeking, { timeout: 1000 * FRAME_SLACK }).toBe(false)
  expect(Date.now() - closed).toBeLessThan(1000 * FRAME_SLACK)
})

type MenuHooks = {
  __orbit: { windowIds: () => string[]; ctx: { windows: { get: (w: string) => Electron.BrowserWindow } } }
  __menus?: Electron.Menu[]
  __heard?: string[]
}

/**
 * Asks for a native menu in each window given, in order and at once, as right-clicks close together
 * do. Returns what every menu asked for so far heard: `shown`, `closed`, and its popup() callback (`done`).
 */
function popMenus(...menus: [label: string, windowId: string][]): Promise<string[]> {
  return orbit.app.evaluate(({ Menu }, list) => {
    const g = globalThis as unknown as MenuHooks
    const heard = g.__heard ?? []
    const shown = g.__menus ?? []
    g.__heard = heard
    g.__menus = shown
    for (const [label, windowId] of list) {
      const menu = Menu.buildFromTemplate([{ label }])
      shown.push(menu)
      menu.on('menu-will-show', () => heard.push(`${label} shown`))
      menu.on('menu-will-close', () => heard.push(`${label} closed`))
      const window = g.__orbit.ctx.windows.get(windowId)
      menu.popup({ window, x: 120, y: 60, callback: () => heard.push(`${label} done`) })
    }
    return [...heard]
  }, menus)
}

/** Closes what `popMenus` showed that is still up (where the engine shows more than one menu at a time). */
function closeMenusUp(): Promise<void> {
  return orbit.app.evaluate(() => {
    const g = globalThis as unknown as MenuHooks
    const heard = g.__heard ?? []
    for (const menu of g.__menus ?? []) {
      const label = menu.items[0]?.label
      if (heard.includes(`${label} shown`) && !heard.includes(`${label} closed`)) menu.closePopup()
    }
  })
}

test('[SB-12][FL-03] a menu Chromium refuses holds no card: asked for while a menu is up, in this window or another, it shows nothing, and the card goes as the pointer leaves the window (round 3 fix check, M1)', async () => {
  const { app } = orbit
  await openTab(app, page('Refused'))
  await hideSidebar()
  const floating = await revealFloating()
  await floating.mouse.move(100, 400)
  await floating.mouse.move(110, 410)
  await expect.poll(async () => (await floatingInfo(app)).hold?.over).toBe(true)
  // The card's last word as the pointer goes where nothing hears it (as in the test before).
  await floating.evaluate(() =>
    document.body.dispatchEvent(new MouseEvent('mouseout', { clientX: 2, clientY: 45, bubbles: true })),
  )
  const [first] = await app.evaluate(() => (globalThis as unknown as MenuHooks).__orbit.windowIds())
  if (!first) throw new Error('no window')
  // Two menus at once, as two right-clicks close together ask: Chromium runs one native menu at a
  // time in the app, so asking for the second closes the first, and the second shows nothing.
  const heard = await popMenus(['First', first], ['Second', first])
  if (process.platform === 'linux') expect(heard).toEqual(['First shown', 'First closed', 'First done', 'Second done'])
  await closeMenusUp()
  // The events a closing menu sends the window (the pointer back over it) come in first.
  await new Promise((r) => setTimeout(r, 300))
  // Nothing is up: on out of the window, the card goes within a second.
  let left = Date.now()
  await pointerAt(app, -40, 300)
  await expect.poll(async () => (await sidebarState()).peeking, { timeout: 1000 * FRAME_SLACK }).toBe(false)
  expect(Date.now() - left).toBeLessThan(1000 * FRAME_SLACK)

  // A menu asked for in a second window while the first window has one up: the same.
  const before = [first]
  await action(app, 'window.new')
  let second = ''
  await expect
    .poll(async () => {
      const ids = await app.evaluate(() => (globalThis as unknown as MenuHooks).__orbit.windowIds())
      second = ids.find((id) => !before.includes(id)) ?? ''
      return second
    })
    .not.toBe('')
  const peekingIn = async (windowId: string) => (await state(app)).windows[windowId]?.sidebar.peeking
  const overlayIn = async (windowId: string) => (await state(app)).windows[windowId]?.overlay.kind
  // Its command bar closed once it opens, and its sidebar hidden, its card is out for a pointer it
  // can't place, in the window.
  await expect.poll(() => overlayIn(second)).not.toBe('none')
  await cmdIn(app, second, 'overlay.close')
  await expect.poll(() => overlayIn(second)).toBe('none')
  await cmdIn(app, second, 'window.setSidebar', { visible: false })
  await pointerAt(app, 300, 300, second)
  await cmdIn(app, second, 'window.setSidebar', { peeking: true })
  await cmdIn(app, second, 'sidebar.peekState', { over: null })
  await new Promise((r) => setTimeout(r, 600))
  expect((await floatingInfo(app, second)).hold).toEqual({ over: true, editing: false, overlay: false, hiding: false })
  expect(await peekingIn(second)).toBe(true)
  await popMenus(['Up in the first', first])
  await new Promise((r) => setTimeout(r, 300))
  const both = await popMenus(['Asked in the second', second])
  if (process.platform === 'linux') {
    expect(both.slice(heard.length)).toEqual([
      'Up in the first shown',
      'Up in the first closed',
      'Up in the first done',
      'Asked in the second done',
    ])
  }
  await closeMenusUp()
  await new Promise((r) => setTimeout(r, 300))
  left = Date.now()
  await pointerAt(app, -2000, -2000, second)
  await expect.poll(() => peekingIn(second), { timeout: 1000 * FRAME_SLACK }).toBe(false)
  expect(Date.now() - left).toBeLessThan(1000 * FRAME_SLACK)
})

test('[SB-14] dragging the edge sets the width 1:1 within limits; double-click resets; far left hides', async () => {
  const { app, shell } = orbit
  await openTab(app, page('Resize'))
  const handle = shell.getByTestId('sidebar-resize')
  const sidebar = shell.getByTestId('sidebar')
  const start = (await sidebarState()).width
  const box = await handle.boundingBox()
  if (!box) throw new Error('no resize edge')
  const x0 = box.x + box.width / 2
  const y0 = box.y + 200
  await expect(handle).toHaveCSS('cursor', 'col-resize')

  await shell.mouse.move(x0, y0)
  await shell.mouse.down()
  await shell.mouse.move(x0 + 52, y0, { steps: 4 })
  // Live, before the drag ends.
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(start + 52)
  // Past the maximum it stops; coming back it picks the pointer up again with no drift.
  await shell.mouse.move(x0 + 400, y0, { steps: 4 })
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(MAX_SIDEBAR_WIDTH)
  await shell.mouse.move(x0 + 52, y0, { steps: 4 })
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(start + 52)
  await shell.mouse.up()
  await expect.poll(async () => (await sidebarState()).width).toBe(start + 52)
  const id = (await activeTab(app)).id
  await expect.poll(async () => (await tabView(app, id))?.bounds.x).toBe(start + 52)

  // Below the minimum it stops too.
  const edge = x0 + 52
  await shell.mouse.move(edge, y0)
  await shell.mouse.down()
  await shell.mouse.move(edge - (start + 52 - MIN_SIDEBAR_WIDTH) - 30, y0, { steps: 4 })
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(MIN_SIDEBAR_WIDTH)
  expect((await sidebarState()).visible).toBe(true)
  await shell.mouse.up()
  await expect.poll(async () => (await sidebarState()).width).toBe(MIN_SIDEBAR_WIDTH)

  // Double-click: back to the default width (the edge glides there).
  await handle.dblclick()
  await expect.poll(async () => (await sidebarState()).width).toBe(DEFAULT_SIDEBAR_WIDTH)
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(DEFAULT_SIDEBAR_WIDTH)

  // Far left (40 px past the minimum): hidden, as ⌘S does, keeping the width it had.
  const back = await handle.boundingBox()
  if (!back) throw new Error('no resize edge')
  const bx = back.x + back.width / 2
  await shell.mouse.move(bx, y0)
  await shell.mouse.down()
  await shell.mouse.move(bx - (DEFAULT_SIDEBAR_WIDTH - MIN_SIDEBAR_WIDTH) - 45, y0, { steps: 6 })
  await expect.poll(async () => (await sidebarState()).visible).toBe(false)
  await shell.mouse.up()
  await expect(sidebar).toBeHidden()
  expect((await sidebarState()).width).toBe(DEFAULT_SIDEBAR_WIDTH)
  await shell.keyboard.press(`${MOD}+S`)
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(DEFAULT_SIDEBAR_WIDTH)
})

// ---------- The page card (SB-19) ----------

/** The card's margin with the sidebar shown: top, right and bottom (the sidebar's edge is the left). */
const MARGIN = 8
const RADIUS = 10

test('[SB-19] the page is a rounded card inset from the window in every state: loading, sidebar hidden or floating', async () => {
  const { app } = orbit
  const id = await openTab(app, page('Card'))
  const size = await contentSize()
  const { width } = await sidebarState()
  const docked = { x: width, y: MARGIN, width: size.width - width - MARGIN, height: size.height - 2 * MARGIN }
  await expect.poll(async () => (await tabView(app, id))?.bounds).toEqual(docked)
  expect(await pageCorner(app, id)).toBe(RADIUS)
  // Loading.
  await cmd(app, 'tabs.navigate', { tabId: id, url: fx.url('/slow/CardLoading') })
  await expect.poll(async () => (await state(app)).tabs[id]?.loading).toBe(true)
  expect(await pageCorner(app, id)).toBe(RADIUS)
  expect((await tabView(app, id))?.bounds).toEqual(docked)
  // Sidebar hidden: a thin margin on all four sides.
  await hideSidebar()
  const hidden = {
    x: MARGIN_HIDDEN,
    y: MARGIN_HIDDEN,
    width: size.width - 2 * MARGIN_HIDDEN,
    height: size.height - 2 * MARGIN_HIDDEN,
  }
  await expect.poll(async () => (await tabView(app, id))?.bounds).toEqual(hidden)
  expect(await pageCorner(app, id)).toBe(RADIUS)
  // The floating sidebar over it changes nothing.
  await revealFloating()
  expect((await tabView(app, id))?.bounds).toEqual(hidden)
  expect(await pageCorner(app, id)).toBe(RADIUS)
  // The shell's card under the page has the same corners and a fine edge.
  const pane = orbit.shell.locator(`[data-testid="split-pane"][data-tab-id="${id}"]`)
  await expect(pane).toHaveCSS('border-radius', `${RADIUS}px`)
  expect(await pane.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none')
})

test('[SB-19] native full screen takes the frame away; leaving brings it back', async () => {
  const { app } = orbit
  const id = await openTab(app, page('Screen'))
  const { width } = await sidebarState()
  await expect.poll(async () => (await tabView(app, id))?.bounds.x).toBe(width)
  await setNativeFullScreen(app, true)
  await expect
    .poll(async () => {
      const size = await contentSize()
      return (
        JSON.stringify((await tabView(app, id))?.bounds) ===
        JSON.stringify({ x: width, y: 0, width: size.width - width, height: size.height })
      )
    })
    .toBe(true)
  expect(await pageCorner(app, id)).toBe(0)
  await setNativeFullScreen(app, false)
  await expect.poll(async () => (await tabView(app, id))?.bounds.y).toBe(MARGIN)
  expect(await pageCorner(app, id)).toBe(RADIUS)
})

test('[SB-19] the card takes the page’s own background, so a resize uncovers no white', async () => {
  const { app, shell } = orbit
  const id = await openTab(app, fx.url('/page/Dark?bg=%23202124'))
  await expect.poll(async () => (await state(app)).tabs[id]?.pageColor).toBe('#202124')
  const pane = shell.locator(`[data-testid="split-pane"][data-tab-id="${id}"]`)
  await expect(pane).toHaveCSS('background-color', 'rgb(32, 33, 36)')
  // Another page, another colour: the card follows.
  await visit(app, id, page('Light'))
  await expect.poll(async () => (await state(app)).tabs[id]?.pageColor).toBe('#f2fbf5')
  await expect(pane).toHaveCSS('background-color', 'rgb(242, 251, 245)')
})

// ---------- Window layout and the sidebar's regions (SB-01, SB-02, SB-05) ----------

test('[SB-01] a window is the sidebar on the left and the page card beside it, with no tab strip across the top', async () => {
  const { app, shell } = orbit
  const id = await openTab(app, page('Layout'))
  const size = await contentSize()
  const sidebar = await shell.getByTestId('sidebar').boundingBox()
  expect(sidebar).toMatchObject({ x: 0, y: 0, height: size.height })
  const view = (await tabView(app, id))?.bounds
  expect(view?.x).toBe(sidebar?.width)
  // Above the card there is only the thin themed margin, nothing that holds tabs.
  expect(view?.y).toBe(MARGIN)
  const across = await shell.evaluate(() => {
    const el = document.elementFromPoint(innerWidth / 2, 3)
    return el ? !!el.closest('[data-testid="tab-row"], [role="tablist"], [data-testid="sidebar"]') : false
  })
  expect(across).toBe(false)
  // The tab is in the sidebar.
  await expect(shell.locator(`[data-testid="sidebar"] [data-testid="tab-row"][data-tab-id="${id}"]`)).toBeVisible()
})

test('[SB-02][SB-05] the sidebar’s regions run top to bottom in order; the middle scrolls, the top and bottom stay', async () => {
  const { app, shell } = orbit
  const favorite = await openTab(app, page('Fav'))
  expect(await cmd(app, 'tabs.favorite', { tabId: favorite })).toBe(true)
  for (const title of ['PinA', 'PinB']) await cmd(app, 'tabs.pin', { tabId: await openTab(app, page(title)) })
  for (const title of ['TodayA', 'TodayB', 'TodayC']) await openTab(app, page(title))
  const regions = [
    '[data-testid="topbar"] .topbar__row',
    '[data-testid="address"]',
    '[data-testid="favorites"]',
    '[data-testid="space-title-row"]',
    '[data-testid="pinned-list"]',
    '[data-testid="today-divider"]',
    '[data-testid="new-tab-button"]',
    '[data-testid="today-list"]',
    '[data-testid="sidebar-empty-area"]',
    '[data-testid="spacebar"]',
  ]
  const sidebar = shell.getByTestId('sidebar')
  const tops = async () => {
    const out: number[] = []
    for (const r of regions) out.push((await sidebar.locator(r).first().boundingBox())?.y ?? Number.NaN)
    return out
  }
  await expect(sidebar.locator('[data-testid="favorite-tile"]')).toHaveCount(1)
  await expect(sidebar.locator('[data-testid="pinned-list"] [data-testid="tab-row"]')).toHaveCount(2)
  await expect(sidebar.locator('[data-testid="today-list"] [data-testid="tab-row"]')).toHaveCount(3)
  const before = await tops()
  for (let i = 1; i < before.length; i++) {
    expect(before[i], `${regions[i]} below ${regions[i - 1]}`).toBeGreaterThan(before[i - 1] as number)
  }
  // Title row to the empty area scroll together; the top rows, Favorites and the bottom bar don't.
  const scroll = shell.getByTestId('sidebar-scroll')
  for (const r of regions.slice(3, 9)) await expect(scroll.locator(r)).toHaveCount(1)
  for (const r of [...regions.slice(0, 3), regions[9] as string]) await expect(scroll.locator(r)).toHaveCount(0)
  for (let n = 0; n < 30; n++) await cmd(app, 'tabs.create', { url: `http://127.0.0.1:9/r${n}`, activate: false })
  await expect.poll(() => scroll.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(100)
  await scroll.evaluate((el) => {
    el.scrollTop = 80
  })
  await expect.poll(async () => (await tops())[3]).toBe((before[3] as number) - 80)
  const after = await tops()
  for (const i of [0, 1, 2, 9]) expect(after[i], regions[i]).toBe(before[i])
})

test('[SB-05] Favorites stay in place across a switch to another Space of the same profile', async () => {
  const { app, shell } = orbit
  const favorite = await openTab(app, page('Shared'))
  expect(await cmd(app, 'tabs.favorite', { tabId: favorite })).toBe(true)
  const tile = shell.locator(`[data-testid="favorite-tile"][data-tab-id="${favorite}"]`)
  await expect(tile).toBeVisible()
  // Where the tile rests once its arrival animation is over.
  const rest = async () => {
    let last = ''
    await expect
      .poll(async () => {
        const now = JSON.stringify(await tile.boundingBox())
        const same = now === last
        last = now
        return same
      })
      .toBe(true)
    return JSON.parse(last) as { x: number; y: number; width: number; height: number }
  }
  const where = await rest()
  const other = (await cmd(app, 'spaces.create', { name: 'Elsewhere' })) as string
  await expect.poll(async () => (await windowState(app)).spaceId).toBe(other)
  await expect(tile).toBeVisible()
  expect(await rest()).toEqual(where)
})
