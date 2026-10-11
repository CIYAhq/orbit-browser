/**
 * The finish-tabs lane: behaviours of tabs, folders, Favorites, Spaces and profiles finished after
 * the other lanes merged (lanes/finish-tabs.md).
 */
import { expect, type Page, test } from '@playwright/test'
import type { SearchResult } from '../../src/shared/commands/commandbar'
import { DEFAULT_PROFILE_ID } from '../../src/shared/defaults'
import { switcherOf } from '../../src/shared/tab-switcher'
import { bestOf, frameAfterWall, mainInputs, ms, note, record, viewShown } from './frames'
import {
  type Fixtures,
  FRAME_SLACK,
  isMac,
  launchOrbit,
  type Orbit,
  run,
  startFixtures,
  state,
  tabPage,
  tabView,
  viewPage,
} from './helpers'
import { closeWindow, flushState, pressInPage, uiPageOf, windowList } from './nav-support'
import { openSettings } from './settings-support'
import {
  act,
  activeId,
  closeOverlay,
  cmd,
  menuFor,
  newTab,
  row,
  rowMenu,
  settled,
  space,
  tabsHook,
  toastView,
  waitTab,
} from './tabs-support'

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

const PRIMARY = isMac ? 'Cmd' : 'Ctrl'

/** The first window's overlay state. */
async function overlayKind(): Promise<string | undefined> {
  return Object.values((await state(orbit.app)).windows)[0]?.overlay.kind
}

/** The web contents with the keyboard. */
function focusedUrl(): Promise<string | undefined> {
  return orbit.app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL())
}

type Mod = 'shift' | 'control' | 'alt' | 'meta'

/** Key presses, each sent to whatever has the keyboard at that moment, as the keyboard does. */
function keys(...presses: [keyCode: string, modifiers?: Mod[]][]): Promise<void> {
  return orbit.app.evaluate(({ webContents }, list) => {
    for (const [keyCode, modifiers = []] of list) {
      webContents.getFocusedWebContents()?.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      webContents.getFocusedWebContents()?.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    }
  }, presses)
}

/** The open row menu in the overlay page. */
function menu(overlay: Page) {
  return overlay.getByTestId('row-menu')
}

/** The label of the focused item of the menu's deepest open level. */
function focusedItem(overlay: Page) {
  return overlay.locator('[data-testid="row-menu-level"]').last().locator('[data-testid="row-menu-item"][data-focused]')
}

/** The menu's background against the overlay's theme surface (the Space's colours, SP-16). */
function menuColours(overlay: Page) {
  return overlay.evaluate(() => {
    const level = document.querySelector('[data-testid="row-menu-level"]') as HTMLElement
    const probe = document.createElement('div')
    probe.style.background = 'var(--surface)'
    ;(document.querySelector('[data-testid="overlay"]') as HTMLElement).appendChild(probe)
    const surface = getComputedStyle(probe).backgroundColor
    probe.remove()
    return { menu: getComputedStyle(level).backgroundColor, surface }
  })
}

// ---------- TB-14: row menus in Orbit's overlay ----------

test('[TB-14][SP-16][KS-18] a row’s right-click menu opens in the overlay in the Space’s colours, and its keys follow a remap the next time it opens', async () => {
  const { app, shell } = orbit
  const t = await newTab(app, fx.url('/page/Tinted'))
  await settled(shell)
  await row(shell, t).click({ button: 'right' })
  const overlay = await viewPage(app, 'overlay')
  await expect(menu(overlay)).toHaveAttribute('data-key', t)
  await expect(overlay.locator('[data-testid="row-menu-item"][data-label="Close Tab"]')).toBeVisible()
  const neutral = await menuColours(overlay)
  expect(neutral.menu).toBe(neutral.surface)
  // KS-18: the keys the keymap has now.
  const pin = overlay.locator('[data-testid="row-menu-item"][data-label="Pin Tab"] .row-menu__hint')
  await expect(pin).toHaveText(isMac ? '⌘D' : 'Ctrl+D')
  await overlay.keyboard.press('Escape')
  await expect.poll(overlayKind).toBe('none')

  // A coloured Space: the menu takes its surface.
  await run(app, 'spaces.update', {
    spaceId: (await space(app)).id,
    theme: { colors: ['#2f6bff'], intensity: 1, grain: 0 },
  })
  expect(
    await run(app, 'keys.bind', { actionId: 'tab.togglePin', accel: `${PRIMARY}+Shift+P`, replace: `${PRIMARY}+D` }),
  ).toEqual({
    ok: true,
  })
  await row(shell, t).click({ button: 'right' })
  await expect(menu(overlay)).toHaveAttribute('data-key', t)
  await expect.poll(async () => (await menuColours(overlay)).menu).not.toBe(neutral.menu)
  const tinted = await menuColours(overlay)
  expect(tinted.menu).toBe(tinted.surface)
  await expect(pin).toHaveText(isMac ? '⇧⌘P' : 'Ctrl+Shift+P')
  expect((await rowMenu(app))?.hints).toEqual(expect.arrayContaining([`Pin Tab=${isMac ? '⇧⌘P' : 'Ctrl+Shift+P'}`]))
})

test('[TB-14] the menu keeps what users expect: arrows wrap, letters jump, → and ← open and close a submenu, Enter chooses, Esc and a click outside close it', async () => {
  const { app, shell } = orbit
  const t = await newTab(app, fx.url('/page/Keyboard'))
  await settled(shell)
  await row(shell, t).click({ button: 'right' })
  const overlay = await viewPage(app, 'overlay')
  await expect(menu(overlay)).toBeVisible()
  // The overlay has the keyboard.
  await expect.poll(focusedUrl).toContain('view=overlay')
  await keys(['Down'])
  await expect(focusedItem(overlay)).toHaveAttribute('data-label', 'Pin Tab')
  await keys(['Up'])
  await expect(focusedItem(overlay)).toHaveAttribute('data-label', 'Close Tab')
  // Type-ahead: a letter goes to the next item it starts; the same letter again to the one after.
  await keys(['C'])
  await expect(focusedItem(overlay)).toHaveAttribute('data-label', 'Change Icon…')
  await keys(['C'])
  await expect(focusedItem(overlay)).toHaveAttribute('data-label', 'Copy Link')
  await overlay.waitForTimeout(800)
  await keys(['M'], ['O'])
  await expect(focusedItem(overlay)).toHaveAttribute('data-label', 'Move to')
  // → opens the submenu with its first item; → again goes a level deeper; ← and Esc come back.
  await keys(['Right'])
  await expect(overlay.getByTestId('row-menu-level')).toHaveCount(2)
  await expect(focusedItem(overlay)).toHaveAttribute('data-label', 'Favorites')
  await keys(['Down'], ['Right'])
  await expect(overlay.getByTestId('row-menu-level')).toHaveCount(3)
  await expect(focusedItem(overlay)).toHaveAttribute('data-label', 'Pinned')
  await keys(['Left'])
  await expect(overlay.getByTestId('row-menu-level')).toHaveCount(2)
  await keys(['Escape'])
  await expect(overlay.getByTestId('row-menu-level')).toHaveCount(1)
  await expect(focusedItem(overlay)).toHaveAttribute('data-label', 'Move to')
  await keys(['Escape'])
  await expect.poll(overlayKind).toBe('none')
  await expect(menu(overlay)).toHaveCount(0)

  // A click outside closes it, and does nothing else.
  await row(shell, t).click({ button: 'right' })
  await expect(menu(overlay)).toBeVisible()
  const box = await overlay.getByTestId('row-menu-level').boundingBox()
  if (!box) throw new Error('no menu')
  await overlay.mouse.click(box.x + box.width + 300, box.y + 40)
  await expect.poll(overlayKind).toBe('none')
  expect((await state(app)).tabs[t]).toBeDefined()

  // Enter chooses the focused item: Duplicate.
  const before = Object.keys((await state(app)).tabs).length
  await row(shell, t).click({ button: 'right' })
  await expect(menu(overlay)).toBeVisible()
  await keys(['D'], ['U'], ['Return'])
  await expect.poll(async () => Object.keys((await state(app)).tabs).length).toBe(before + 1)
  await expect.poll(overlayKind).toBe('none')

  // The pointer: hovering a submenu's item opens it, and a click in it chooses.
  await row(shell, t).click({ button: 'right' })
  await overlay.locator('[data-testid="row-menu-item"][data-label="Move to"]').hover()
  await expect(overlay.getByTestId('row-menu-level')).toHaveCount(2)
  const spaceName = (await space(app)).name
  await overlay.locator(`[data-row-menu-level="1"] [data-testid="row-menu-item"][data-label="${spaceName}"]`).hover()
  await expect(overlay.getByTestId('row-menu-level')).toHaveCount(3)
  await overlay.locator('[data-row-menu-level="2"] [data-testid="row-menu-item"][data-label="Pinned"]').click()
  await expect.poll(async () => (await space(app)).pinned).toContain(t)
  await expect.poll(overlayKind).toBe('none')
})

test('[TB-14][KS-19][KS-16] while a row menu is open it has the keyboard: no key reaches the page, ⌘W closes the menu and not the tab, and the keyboard goes back to the page after', async () => {
  const { app } = orbit
  const t = await newTab(app, fx.url('/page/KeyLog'))
  const page = await tabPage(app, '/page/KeyLog')
  await page.evaluate(() => {
    const w = window as unknown as { pressed: string[] }
    w.pressed = []
    window.addEventListener('keydown', (e) => w.pressed.push(e.key), true)
  })
  const pressed = () => page.evaluate(() => (window as unknown as { pressed: string[] }).pressed)
  const tabCount = async () => Object.keys((await state(app)).tabs).length
  await cmd(app, 'tabs.focusPage', {})
  await expect.poll(focusedUrl).toBe(fx.url('/page/KeyLog'))

  // Arrows, letters and Tab move in the menu, and none reaches the page.
  await cmd(app, 'tabs.contextMenu', { id: t, at: { x: 60, y: 220 } })
  await menuFor(app, t)
  const overlay = await viewPage(app, 'overlay')
  await expect(menu(overlay)).toBeVisible()
  await expect.poll(focusedUrl).toContain('view=overlay')
  await keys(['Down'], ['Down'], ['Down'], ['Tab'])
  await expect(focusedItem(overlay)).toHaveAttribute('data-label', 'Rename…')
  await keys(['D'])
  await expect(focusedItem(overlay)).toHaveAttribute('data-label', 'Duplicate')
  // ⌘W (Ctrl+W) closes the menu, not the tab under it.
  const count = await tabCount()
  await keys(['W', [isMac ? 'meta' : 'control']])
  await expect.poll(overlayKind).toBe('none')
  expect((await state(app)).tabs[t]).toBeDefined()
  expect(await tabCount()).toBe(count)
  // The keyboard is the page's again (KS-16), and nothing typed in the menu got there.
  await expect.poll(focusedUrl).toBe(fx.url('/page/KeyLog'))
  expect(await pressed()).toEqual([])
  await keys(['X'])
  await expect.poll(pressed).toEqual(['x'])

  // Esc closes the menu and stays in it; Enter chooses without the page seeing it.
  await cmd(app, 'tabs.contextMenu', { id: t, at: { x: 60, y: 220 } })
  await expect.poll(focusedUrl).toContain('view=overlay')
  await keys(['Escape'])
  await expect.poll(overlayKind).toBe('none')
  await expect.poll(focusedUrl).toBe(fx.url('/page/KeyLog'))
  await cmd(app, 'tabs.contextMenu', { id: t, at: { x: 60, y: 220 } })
  await expect.poll(focusedUrl).toContain('view=overlay')
  await keys(['D'], ['Enter'])
  await expect.poll(tabCount).toBe(count + 1)
  expect(await pressed()).toEqual(['x'])
})

test('[TB-14][FL-21] a row’s menu keeps its row drawn: scrolled far out of sight, the menu stays where it opened and acts on that row', async () => {
  const { app, shell } = orbit
  test.setTimeout(120_000)
  await app.evaluate(async () => {
    const g = globalThis as unknown as {
      __orbit: { run: (n: string, a: unknown, w?: string) => Promise<unknown>; windowIds: () => string[] }
    }
    const w = g.__orbit.windowIds()[0]
    for (let i = 0; i < 150; i++) await g.__orbit.run('tabs.create', { url: `about:blank#t${i}`, activate: false }, w)
  })
  const list = shell.getByTestId('today-list')
  await expect(list.locator(':scope > [data-slot]')).toHaveCount(150, { timeout: 30_000 })
  await settled(shell, 30_000)
  const today = (await space(app)).today
  const [first, second] = today as [string, string]
  await row(shell, first).click({ button: 'right' })
  const overlay = await viewPage(app, 'overlay')
  await expect(menu(overlay)).toHaveAttribute('data-key', first)
  const level = overlay.getByTestId('row-menu-level')
  await expect(level).toBeVisible()
  const opened = await level.boundingBox()
  // The list scrolls to its end: the rows near the top are no longer drawn, except this one.
  await shell.getByTestId('sidebar-scroll').evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect(row(shell, second)).toHaveCount(0)
  await expect(row(shell, first)).toHaveCount(1)
  await expect(row(shell, first)).toHaveClass(/is-menu-open/)
  expect(await row(shell, first).evaluate((el) => el.getBoundingClientRect().bottom)).toBeLessThan(0)
  expect(await level.boundingBox()).toEqual(opened)
  // It still works, on that row.
  await overlay.locator('[data-testid="row-menu-item"][data-label="Pin Tab"]').click()
  await expect.poll(async () => (await space(app)).pinned).toContain(first)
  await expect.poll(overlayKind).toBe('none')
})

test('[TB-14] the pinned, Favorite, folder, multi-selection and split rows’ menus open in the overlay too', async () => {
  const { app, shell } = orbit
  const overlay = await viewPage(app, 'overlay')
  const openMenu = async (target: ReturnType<Page['locator']>, key: string, item: string) => {
    await target.click({ button: 'right' })
    await expect(menu(overlay)).toHaveAttribute('data-key', key)
    await expect(overlay.locator(`[data-testid="row-menu-item"][data-label="${item}"]`)).toBeVisible()
    await overlay.keyboard.press('Escape')
    await expect.poll(overlayKind).toBe('none')
  }
  const pinned = await newTab(app, fx.url('/page/PinnedRow'), { activate: false })
  await cmd(app, 'tabs.pin', { tabId: pinned })
  const fav = await newTab(app, fx.url('/page/FavTile'), { activate: false })
  await cmd(app, 'tabs.favorite', { tabId: fav })
  const folder = await cmd<string>(app, 'folders.create', { name: 'Box' })
  const a = await newTab(app, fx.url('/page/SelA'), { activate: false })
  const b = await newTab(app, fx.url('/page/SelB'), { activate: false })
  const c = await newTab(app, fx.url('/page/SplitC'), { activate: false })
  const d = await newTab(app, fx.url('/page/SplitD'), { activate: false })
  const split = await cmd<string>(app, 'split.create', { tabIds: [c, d] })
  await settled(shell)
  const today = shell.getByTestId('today-list')
  await openMenu(shell.getByTestId('pinned-list').locator(`[data-tab-id="${pinned}"]`), pinned, 'Unpin Tab')
  await openMenu(shell.locator(`[data-fav-id="${fav}"]`), fav, 'Remove from Favorites')
  await openMenu(shell.locator(`[data-folder-id="${folder}"] .folder-row`).first(), folder, 'Delete Folder…')
  await today.locator(`[data-tab-id="${a}"]`).click()
  await today.locator(`[data-tab-id="${b}"]`).click({ modifiers: [isMac ? 'Meta' : 'Control'] })
  await openMenu(today.locator(`[data-tab-id="${b}"]`), b, 'Close 2 Tabs')
  await openMenu(shell.locator(`[data-testid="split-row"][data-split-id="${split}"]`), split, 'Separate Tabs')
})

test('[TB-14][PK-13] with a Peek open, a row’s menu is the system’s, and the Peek stays open', async () => {
  const { app, shell } = orbit
  const t = await newTab(app, fx.url('/page/UnderPeek'))
  await cmd(app, 'peek.open', { url: fx.url('/page/Peeked') })
  await expect.poll(focusedUrl).toBe(fx.url('/page/Peeked'))
  await row(shell, t).click({ button: 'right' })
  await expect.poll(async () => (await rowMenu(app))?.key).toBe(t)
  expect((await rowMenu(app))?.native).toBe(true)
  expect(await overlayKind()).toBe('peek')
  expect(await tabsHook(app, 'chooseRowMenu', 'Mute Tab')).toBe(true)
  await expect.poll(async () => (await state(app)).tabs[t]?.muted).toBe(true)
  expect(await overlayKind()).toBe('peek')
})

/** Types text into whatever has the keyboard, as the keyboard does. */
function typeText(text: string): Promise<void> {
  return orbit.app.evaluate(({ webContents }, t) => {
    for (const ch of t) {
      const contents = webContents.getFocusedWebContents()
      contents?.sendInputEvent({ type: 'keyDown', keyCode: ch })
      contents?.sendInputEvent({ type: 'char', keyCode: ch })
      contents?.sendInputEvent({ type: 'keyUp', keyCode: ch })
    }
  }, text)
}

test('[TB-14][KS-16] Rename… in a row’s menu gives the sidebar the keyboard, though the page had it: what is typed names the tab, or the split', async () => {
  const { app, shell } = orbit
  const t = await newTab(app, fx.url('/page/RenameMe'))
  const c = await newTab(app, fx.url('/page/SplitL'), { activate: false })
  const d = await newTab(app, fx.url('/page/SplitR'), { activate: false })
  const split = await cmd<string>(app, 'split.create', { tabIds: [c, d] })
  await settled(shell)
  const overlay = await viewPage(app, 'overlay')
  const renameFrom = async (target: ReturnType<Page['locator']>, key: string, name: string) => {
    await cmd(app, 'tabs.activate', { tabId: t })
    await cmd(app, 'tabs.focusPage', {})
    await expect.poll(focusedUrl).toBe(fx.url('/page/RenameMe'))
    await target.click({ button: 'right' })
    await expect(menu(overlay)).toHaveAttribute('data-key', key)
    await overlay.locator('[data-testid="row-menu-item"][data-label="Rename…"]').click()
    await expect.poll(overlayKind).toBe('none')
    await expect.poll(focusedUrl).toContain('view=shell')
    await typeText(name)
    await keys(['Enter'])
  }
  await renameFrom(row(shell, t), t, 'Named')
  await expect.poll(async () => (await state(app)).tabs[t]?.customTitle).toBe('Named')
  await renameFrom(shell.locator(`[data-testid="split-row"][data-split-id="${split}"]`), split, 'Pair')
  await expect.poll(async () => (await state(app)).splits[split]?.name).toBe('Pair')
})

// ---------- SB-13, SP-02, SP-16: toasts over the page while the sidebar is hidden, in the Space's colours ----------

/** A toast's colours against the theme its view has (`root` holds the palette's variables, SP-16). */
function toastColours(page: Page, root: string) {
  return page.evaluate((sel) => {
    const toast = document.querySelector('[data-testid="toast"]')
    if (!toast) return { background: 'no toast', text: '', surface: '', themeText: '' }
    const probe = document.createElement('div')
    probe.style.background = 'var(--surface)'
    probe.style.color = 'var(--text)'
    ;(document.querySelector(sel) as HTMLElement).appendChild(probe)
    const theme = getComputedStyle(probe)
    const out = {
      background: getComputedStyle(toast).backgroundColor,
      text: getComputedStyle(toast).color,
      surface: theme.backgroundColor,
      themeText: theme.color,
    }
    probe.remove()
    return out
  }, root)
}

const RED = { colors: ['#d4322c'], intensity: 1, grain: 0 }

/** The toasts' view sits over the bottom centre of `card`: centred, its stack 16 px above the card's foot (FL-22). */
async function expectOver(card: { x: number; y: number; width: number; height: number }) {
  await expect.poll(async () => (await toastView(orbit.app)).visible).toBe(true)
  const { bounds } = await toastView(orbit.app)
  if (!bounds) throw new Error('no toast view')
  expect(Math.abs(bounds.x + bounds.width / 2 - (card.x + card.width / 2))).toBeLessThanOrEqual(1)
  // The view is the stack and a 24 px margin.
  expect(Math.abs(bounds.y + bounds.height - 24 - (card.y + card.height - 16))).toBeLessThanOrEqual(1)
}

test('[SP-02][SB-13][SP-16] New Space with the sidebar hidden says so over the page card, in the Space’s colours; Show shows the sidebar', async () => {
  const { app } = orbit
  const t = await newTab(app, fx.url('/page/UnderToast'))
  await waitTab(app, t, '/page/UnderToast')
  await run(app, 'window.setSidebar', { visible: false })
  await cmd(app, 'tabs.focusPage', {})
  await expect.poll(focusedUrl).toBe(fx.url('/page/UnderToast'))
  await act(app, 'space.new')
  const toasts = await viewPage(app, 'toasts')
  const toast = toasts.getByTestId('toast')
  await expect(toast).toContainText('Created “Space 2”')
  await expect(toast.getByTestId('toast-action')).toHaveText('Show')
  // Over the bottom centre of the page card (the new Space is empty: its frame); the keyboard stays
  // where it was (KS-16).
  const windowId = Object.keys((await state(app)).windows)[0] as string
  const frame = await orbit.shell.getByTestId('content-frame').boundingBox()
  if (!frame) throw new Error('no page frame')
  await expectOver(frame)
  expect((await focusedUrl()) ?? '').not.toContain('view=toasts')
  // In the Space's colours, and they follow its theme.
  await toast.hover()
  const before = await toastColours(toasts, '[data-testid="toast-view"]')
  expect(before.background).toBe(before.surface)
  expect(before.text).toBe(before.themeText)
  await run(app, 'spaces.update', { spaceId: (await state(app)).windows[windowId]?.spaceId, theme: RED })
  await expect
    .poll(async () => (await toastColours(toasts, '[data-testid="toast-view"]')).background)
    .not.toBe(before.background)
  const red = await toastColours(toasts, '[data-testid="toast-view"]')
  expect(red.background).toBe(red.surface)
  // Show: the sidebar comes back; the toast goes, and the view with its last toast.
  await toast.getByTestId('toast-action').click()
  await expect.poll(async () => (await state(app)).windows[windowId]?.sidebar.visible).toBe(true)
  await expect(toast).toHaveCount(0)
  await expect.poll(async () => (await toastView(app)).visible).toBe(false)
})

test('[SB-13][FL-22][NV-08] a ⌘-clicked link with the sidebar hidden: the toast over the page is clickable as a whole and goes to the new tab', async () => {
  const { app } = orbit
  const t = await newTab(app, fx.url('/page/Links'))
  await waitTab(app, t, '/page/Links')
  await run(app, 'window.setSidebar', { visible: false })
  const page = await tabPage(app, '/page/Links')
  await page.click('#next', { modifiers: [isMac ? 'Meta' : 'Control'] })
  await expect.poll(async () => (await space(app)).today.length).toBe(2)
  const bg = (await space(app)).today[0] as string
  const toasts = await viewPage(app, 'toasts')
  const toast = toasts.getByTestId('toast').last()
  await expect(toast).toContainText('Opened in a new tab')
  await expect(toast.getByTestId('toast-action')).toHaveText('Show')
  const view = await tabView(app, t)
  if (!view) throw new Error('no page view')
  await expectOver(view.bounds)
  // The page keeps the keyboard (KS-16).
  expect(await focusedUrl()).toContain('/page/Links')
  expect(await activeId(app)).toBe(t)
  // A click on its words, not on its button, goes to the tab.
  await toast.click({ position: { x: 8, y: 8 } })
  await expect.poll(() => activeId(app)).toBe(bg)
  await expect(toasts.getByTestId('toast')).toHaveCount(0)
  await expect.poll(async () => (await toastView(app)).visible).toBe(false)
})

test('[SB-13][NV-03] ⌘-clicking Reload with the sidebar hidden copies the tab behind it; the toast’s Show goes to the copy', async () => {
  const { app } = orbit
  const t = await newTab(app, fx.url('/page/Again'))
  await waitTab(app, t, '/page/Again')
  await run(app, 'window.setSidebar', { visible: false })
  const copy = await cmd<string>(app, 'nav.press', { button: 'reload', newTab: true })
  expect(copy).not.toBe(t)
  expect(await activeId(app)).toBe(t)
  const toast = (await viewPage(app, 'toasts')).getByTestId('toast')
  await expect(toast).toContainText('Opened in a new tab')
  await toast.getByTestId('toast-action').click()
  await expect.poll(() => activeId(app)).toBe(copy)
})

test('[FL-22][SB-13] in a split, the toasts go over the pane being used, and move with it', async () => {
  const { app, shell } = orbit
  const c = await newTab(app, fx.url('/page/PaneL'))
  const d = await newTab(app, fx.url('/page/PaneR'), { activate: false })
  await cmd(app, 'split.create', { tabIds: [c, d] })
  await cmd(app, 'tabs.activate', { tabId: d })
  await settled(shell)
  await run(app, 'window.setSidebar', { visible: false })
  await cmd(app, 'tabs.copyLinks', { tabIds: [d] })
  const toasts = await viewPage(app, 'toasts')
  await expect(toasts.getByTestId('toast')).toContainText('Copied')
  await toasts.getByTestId('toast').hover()
  const used = await tabView(app, d)
  if (!used) throw new Error('no pane view')
  await expectOver(used.bounds)
  // The other pane in use: the toasts follow.
  await cmd(app, 'tabs.activate', { tabId: c })
  const other = await tabView(app, c)
  if (!other) throw new Error('no pane view')
  const centre = (r: { x: number; width: number }) => Math.round(r.x + r.width / 2)
  expect(Math.abs(centre(other.bounds) - centre(used.bounds))).toBeGreaterThan(200)
  await expect
    .poll(async () => {
      const b = (await toastView(app)).bounds
      return b ? Math.abs(centre(b) - centre(other.bounds)) <= 1 : null
    })
    .toBe(true)
})

test('[SP-16] a toast over the sidebar takes the Space’s colours too', async () => {
  const { app, shell } = orbit
  const t = await newTab(app, fx.url('/page/CopyMe'))
  await waitTab(app, t, '/page/CopyMe')
  await run(app, 'spaces.update', { spaceId: (await space(app)).id, theme: RED })
  await cmd(app, 'tabs.copyLinks', { tabIds: [t] })
  await expect(shell.getByTestId('toast')).toContainText('Copied')
  // While it shows (3 s).
  await expect
    .poll(
      async () => {
        const c = await toastColours(shell, '[data-testid="shell"]')
        return c.background === c.surface && c.text === c.themeText
      },
      { timeout: 2000 },
    )
    .toBe(true)
  // Red-family: more red than blue.
  const [r = 0, , b = 0] = ((await toastColours(shell, '[data-testid="shell"]')).background.match(/\d+/g) ?? []).map(
    Number,
  )
  expect(r).toBeGreaterThan(b)
})

// ---------- SP-14: ⌘Z after the theme picker closes ----------

test('[SP-14][TB-18] ⌘Z after the theme picker closed puts the Space’s theme back, from the page or the sidebar; ⌘⇧Z puts the change back', async () => {
  const { app, shell } = orbit
  const t = await newTab(app, fx.url('/page/Painted'))
  await waitTab(app, t, '/page/Painted')
  const spaceId = (await space(app)).id
  await run(app, 'spaces.update', { spaceId, theme: RED })
  const colours = async () => (await state(app)).spaces[spaceId]?.theme.colors
  await act(app, 'space.theme')
  const overlay = await viewPage(app, 'overlay')
  await expect(overlay.getByTestId('theme-picker')).toBeVisible()
  await overlay.getByTestId('theme-preset').nth(2).click()
  await expect.poll(colours).toEqual(['#2fbf8f'])
  await overlay.keyboard.press('Escape')
  await expect.poll(overlayKind).toBe('none')
  // From the page: the key goes through the browser process, as a person's does.
  const mod = isMac ? 'meta' : 'control'
  await pressInPage(app, '/page/Painted', 'Z', [mod])
  await expect.poll(colours).toEqual(['#d4322c'])
  await pressInPage(app, '/page/Painted', 'Z', [mod, 'shift'])
  await expect.poll(colours).toEqual(['#2fbf8f'])
  // And from the sidebar.
  await shell.keyboard.press(`${isMac ? 'Meta' : 'Control'}+Z`)
  await expect.poll(colours).toEqual(['#d4322c'])
})

// ---------- SB-24, SP-15: the neutral theme over the window's material ----------

/** The alpha of the shell's own drawing at a window point (each page is a view of its own, not in it). */
function shellAlphaAt(x: number, y: number): Promise<number> {
  return orbit.app.evaluate(
    async ({ BrowserWindow }, [px, py]) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return -1
      const image = await win.webContents.capturePage({ x: px, y: py, width: 1, height: 1 })
      return image.toBitmap()[3] ?? -1
    },
    [x, y] as const,
  )
}

test('[SB-24][SP-15] over the window’s material the neutral theme lets it through under a veil; a coloured theme and the page card stay solid', async () => {
  // Linux has none: the run names one so the rest of the way is checked here (macOS: vibrancy).
  await orbit.app.close()
  orbit = await launchOrbit({ env: { ORBIT_MATERIAL: 'vibrancy' } })
  const { app } = orbit
  const t = await newTab(app, fx.url('/page/Glass'))
  await waitTab(app, t, '/page/Glass')
  const spaceId = (await space(app)).id
  // The neutral theme: no colours.
  const neutral = { colors: [], intensity: 0.6, grain: 0 }
  await run(app, 'spaces.update', { spaceId, theme: neutral })
  const card = (await tabView(app, t))?.bounds
  if (!card) throw new Error('no page card')
  // The margin left of the page card: the theme's background, nothing over it.
  const x = card.x - 3
  const y = card.y + Math.round(card.height / 2)
  await expect.poll(() => shellAlphaAt(x, y)).toBeLessThan(255)
  // A veil of the neutral grey, not a hole.
  expect(await shellAlphaAt(x, y)).toBeGreaterThan(64)
  // The page card's backdrop is solid.
  expect(await shellAlphaAt(card.x + 40, card.y + 40)).toBe(255)
  await run(app, 'spaces.update', { spaceId, theme: RED })
  await expect.poll(() => shellAlphaAt(x, y)).toBe(255)
  await run(app, 'spaces.update', { spaceId, theme: neutral })
  await expect.poll(() => shellAlphaAt(x, y)).toBeLessThan(255)
})

test('[SB-24][SP-15] without a material (Linux) the neutral theme stays a solid grey', async () => {
  await orbit.app.close()
  orbit = await launchOrbit({ env: { ORBIT_MATERIAL: 'none' } })
  const { app } = orbit
  const t = await newTab(app, fx.url('/page/Solid'))
  await waitTab(app, t, '/page/Solid')
  await run(app, 'spaces.update', { spaceId: (await space(app)).id, theme: { colors: [], intensity: 0.6, grain: 0 } })
  const card = (await tabView(app, t))?.bounds
  if (!card) throw new Error('no page card')
  await expect.poll(() => shellAlphaAt(card.x - 3, card.y + Math.round(card.height / 2))).toBe(255)
})

// ---------- TD-03: archive timing per profile, applied at once ----------

test('[TD-03][ST-05] archive timing set per profile in Settings applies at once: Default at 7 days keeps a tab idle 13 h; Work at 12 h archives only its Spaces’ tabs', async () => {
  const { app } = orbit
  const work = (await run(app, 'profiles.create', { name: 'Work' })) as string
  const office = await cmd<string>(app, 'spaces.create', { name: 'Office', profileId: work, activate: false })
  const homeTab = await newTab(app, fx.url('/page/HomeIdle'), { activate: false })
  const workTab = await newTab(app, fx.url('/page/WorkIdle'), { spaceId: office, activate: false })
  const page = await openSettings(app, { section: 'profiles' })
  await page.getByTestId(`archive-after-${DEFAULT_PROFILE_ID}`).selectOption({ label: '7 days' })
  await expect.poll(async () => (await state(app)).profiles[DEFAULT_PROFILE_ID]?.archiveAfterMs).toBe(7 * 86_400_000)
  // 13 hours on (after the pass at launch, so only a change can archive now): Default's 7 days,
  // which Work follows, keeps both.
  await expect.poll(() => tabsHook<boolean>(app, 'launchPassDone')).toBe(true)
  await tabsHook(app, 'clockAhead', 13 * 3_600_000)
  expect((await tabsHook<{ archived: string[] }>(app, 'maintenance')).archived).toEqual([])
  await page.getByTestId(`profile-${work}`).click()
  const own = page.getByTestId(`archive-after-${work}`)
  await expect(own.locator('option:checked')).toHaveText('Same as Default (7 days)')
  // Work at 12 hours: its Space's idle tab goes to the Archive at once, not at the next pass.
  await own.selectOption({ label: '12 hours' })
  await expect.poll(async () => (await state(app)).tabs[workTab], { timeout: 3000 }).toBeUndefined()
  const s = await state(app)
  expect(s.tabs[homeTab]).toBeTruthy()
  expect(s.archive.find((a) => a.url.includes('/page/WorkIdle'))?.reason).toBe('auto')
})

// ---------- KS-05: sidebar undo and redo in the keymap ----------

/** The key the command bar shows for the first action a search finds (KS-18). */
async function expectBarKey(query: string, key: string): Promise<void> {
  await act(orbit.app, 'tab.new')
  const overlay = await viewPage(orbit.app, 'overlay')
  const bar = overlay.getByTestId('command-bar')
  await expect(bar.getByTestId('command-input')).toBeFocused()
  await overlay.keyboard.type(query)
  const top = bar.getByTestId('command-result').first()
  await expect(top).toHaveAttribute('data-kind', 'action')
  await expect(top.getByTestId('command-shortcut')).toHaveText(key)
  await overlay.keyboard.press('Escape')
  await expect.poll(overlayKind).toBe('none')
}

test('[KS-05][TB-18][KS-16][KS-18] sidebar undo and redo are in the keymap: remapped, the new keys work from a page and the sidebar, the old ones undo no sidebar change, and the command bar shows them', async () => {
  const { app, shell } = orbit
  const t = await newTab(app, fx.url('/page/Undone'))
  await waitTab(app, t, '/page/Undone')
  const title = async () => (await state(app)).tabs[t]?.customTitle
  // ⌘Z and ⌘⇧Z by default (Ctrl elsewhere).
  await expectBarKey('undo sidebar', isMac ? '⌘Z' : 'Ctrl+Z')
  await expectBarKey('redo sidebar', isMac ? '⇧⌘Z' : 'Ctrl+Shift+Z')
  expect(await run(app, 'keys.bind', { actionId: 'tab.undo', accel: 'F7', replace: `${PRIMARY}+Z` })).toEqual({
    ok: true,
  })
  expect(await run(app, 'keys.bind', { actionId: 'tab.redo', accel: 'F8', replace: `${PRIMARY}+Shift+Z` })).toEqual({
    ok: true,
  })
  await expectBarKey('undo sidebar', 'F7')
  await expectBarKey('redo sidebar', 'F8')
  await run(app, 'tabs.rename', { tabId: t, title: 'First' })
  await run(app, 'tabs.rename', { tabId: t, title: 'Second' })
  // The old key, from the page (through the browser process, as a person's) and from the sidebar.
  await pressInPage(app, '/page/Undone', 'Z', [isMac ? 'meta' : 'control'])
  await shell.keyboard.press(`${isMac ? 'Meta' : 'Control'}+Z`)
  await shell.waitForTimeout(500)
  expect(await title()).toBe('Second')
  // The new ones, from the page: each undoes or redoes one change.
  await pressInPage(app, '/page/Undone', 'F7')
  await expect.poll(title).toBe('First')
  await pressInPage(app, '/page/Undone', 'F8')
  await expect.poll(title).toBe('Second')
  // And from the sidebar.
  await shell.keyboard.press('F7')
  await expect.poll(title).toBe('First')
  await shell.keyboard.press('F8')
  await expect.poll(title).toBe('Second')
  // While the note after a Space delete shows, the new key in the sidebar brings the Space back,
  // and does only that (SP-12).
  const gone = await cmd<string>(app, 'spaces.create', { name: 'Gone', activate: false })
  await run(app, 'spaces.delete', { spaceId: gone })
  await expect(shell.getByTestId('space-undo')).toBeVisible()
  await pressInPage(app, 'view=shell', 'F7')
  await expect.poll(async () => (await state(app)).spaceOrder).toContain(gone)
  await shell.waitForTimeout(500)
  expect(await title()).toBe('Second')
})

// ---------- TB-09: a row dragged onto the page ----------

type Point = { x: number; y: number }

/**
 * Puts a note field and a chat box on page `name` (tab `tabId`): the chat box handles a dropped link
 * itself, as a chat app does, and logs the drag events it gets. Returns their middles in the window.
 */
async function linkPlaces(tabId: string, name: string): Promise<{ note: Point; chat: Point; page: Page }> {
  const page = await tabPage(orbit.app, `/page/${name}`)
  const boxes = await page.evaluate(() => {
    const note = document.createElement('textarea')
    note.id = 'note'
    note.style.cssText = 'position:fixed;left:50%;top:30%;width:220px;height:70px'
    const chat = document.createElement('div')
    chat.id = 'chat'
    chat.style.cssText = 'position:fixed;left:30%;top:58%;width:260px;height:70px'
    const box = document.createElement('div')
    box.contentEditable = 'true'
    box.style.cssText = 'width:100%;height:100%'
    chat.append(box)
    document.body.append(note, chat)
    const log: { events: string[]; dropped: string[] } = { events: [], dropped: [] }
    ;(window as unknown as { chatLog: typeof log }).chatLog = log
    for (const type of ['dragenter', 'dragover', 'dragleave']) {
      chat.addEventListener(type, (e) => {
        if (log.events.at(-1) !== type) log.events.push(type)
        if (type === 'dragover') e.preventDefault()
      })
    }
    chat.addEventListener('drop', (e) => {
      e.preventDefault()
      log.dropped.push((e as DragEvent).dataTransfer?.getData('text/uri-list') ?? '')
    })
    const mid = (el: Element) => {
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    }
    return { note: mid(note), chat: mid(chat) }
  })
  const view = await tabView(orbit.app, tabId)
  if (!view) throw new Error('no page view')
  const at = (p: Point) => ({ x: view.bounds.x + p.x, y: view.bounds.y + p.y })
  return { note: at(boxes.note), chat: at(boxes.chat), page }
}

/** Presses tab `tabId`'s row and lifts it off the sidebar, once the last drag's row is back. */
async function lift(tabId: string): Promise<void> {
  await expect(orbit.shell.getByTestId('drag-ghost')).toHaveCount(0)
  await settled(orbit.shell)
  const from = await row(orbit.shell, tabId).boundingBox()
  if (!from) throw new Error('missing the row')
  await orbit.shell.mouse.move(from.x + 40, from.y + from.height / 2)
  await orbit.shell.mouse.down()
  await orbit.shell.mouse.move(from.x + 60, from.y + from.height / 2, { steps: 3 })
}

const indicator = () => orbit.shell.getByTestId('split-drop-indicator')

test('[TB-09][SV-04] a row dragged onto the page: over a text field it drops its link there, over a chat box the page takes it, elsewhere the page’s edge makes a split', async () => {
  const { app, shell } = orbit
  const b = await newTab(app, fx.url('/page/Dragged'))
  const a = await newTab(app, fx.url('/page/Shown'))
  await waitTab(app, b, '/page/Dragged')
  await waitTab(app, a, '/page/Shown')
  await expect.poll(async () => (await tabView(app, a))?.visible).toBe(true)
  await settled(shell)
  const url = (await state(app)).tabs[b]?.url as string
  const { note, chat, page } = await linkPlaces(a, 'Shown')
  const frame = await shell.getByTestId('content-frame').boundingBox()
  if (!frame) throw new Error('missing the content frame')

  // Over the plain page the split's preview shows; over the note field it doesn't, and the page
  // is back as it was. Released there, the field gets the link, and the keyboard.
  await lift(b)
  await shell.mouse.move(frame.x + frame.width * 0.1, frame.y + frame.height / 2, { steps: 8 })
  await shell.mouse.move(frame.x + frame.width * 0.1 + 5, frame.y + frame.height / 2, { steps: 2 })
  await expect(indicator()).toBeVisible()
  await shell.mouse.move(note.x, note.y, { steps: 8 })
  await expect(indicator()).toHaveCount(0)
  await expect.poll(async () => (await tabView(app, a))?.bounds.width).toBeGreaterThan(frame.width * 0.9)
  await shell.mouse.up()
  await expect.poll(() => page.evaluate(() => (document.getElementById('note') as HTMLTextAreaElement).value)).toBe(url)
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('note')
  await expect.poll(focusedUrl).toContain('/page/Shown')
  expect(Object.keys((await state(app)).splits)).toHaveLength(0)
  expect(await activeId(app)).toBe(a)

  // Over the chat box the page is told of the row (it shows where the link would go) and, released
  // there, handles the link itself: nothing is typed into the box.
  await lift(b)
  // The first move over the page shows the page the drag began on again (FL-05); the next ones are over it.
  await shell.mouse.move(chat.x, chat.y, { steps: 10 })
  await shell.mouse.move(chat.x + 5, chat.y, { steps: 2 })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { chatLog: { events: string[] } }).chatLog.events))
    .toEqual(['dragenter', 'dragover'])
  await expect(indicator()).toHaveCount(0)
  // Off it, the page is told the row left.
  await shell.mouse.move(frame.x + frame.width * 0.9, frame.y + frame.height / 2, { steps: 4 })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { chatLog: { events: string[] } }).chatLog.events))
    .toEqual(['dragenter', 'dragover', 'dragleave'])
  await expect(indicator()).toBeVisible()
  await shell.mouse.move(chat.x, chat.y, { steps: 4 })
  await expect(indicator()).toHaveCount(0)
  await shell.mouse.up()
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { chatLog: { dropped: string[] } }).chatLog.dropped))
    .toEqual([url])
  expect(await page.evaluate(() => document.querySelector('#chat [contenteditable]')?.textContent)).toBe('')
  expect(Object.keys((await state(app)).splits)).toHaveLength(0)

  // Released on the page's edge, away from both, the row makes a split, as SV-04 has it.
  await lift(b)
  await shell.mouse.move(frame.x + frame.width * 0.9, frame.y + frame.height / 2, { steps: 8 })
  await shell.mouse.move(frame.x + frame.width * 0.9 + 5, frame.y + frame.height / 2, { steps: 2 })
  await expect(indicator()).toHaveAttribute('data-side', 'right')
  await shell.mouse.up()
  await expect(shell.getByTestId('split-row')).toHaveCount(1)
  const split = Object.values((await state(app)).splits)[0]
  expect(JSON.stringify(split?.layout)).toBe(
    JSON.stringify({
      type: 'row',
      children: [
        { type: 'leaf', tabId: a },
        { type: 'leaf', tabId: b },
      ],
      sizes: [0.5, 0.5],
    }),
  )
  // The page got no more of the row.
  expect(await page.evaluate(() => (window as unknown as { chatLog: { dropped: string[] } }).chatLog.dropped)).toEqual([
    url,
  ])
})

test('[TB-09][SV-14] in a split, the pane whose field takes a dropped link becomes the focused pane, with the keyboard', async () => {
  const { app, shell } = orbit
  const b = await newTab(app, fx.url('/page/Dragged'))
  const c = await newTab(app, fx.url('/page/Right'))
  const a = await newTab(app, fx.url('/page/Left'))
  for (const [id, name] of [
    [b, 'Dragged'],
    [c, 'Right'],
    [a, 'Left'],
  ] as const) {
    await waitTab(app, id, `/page/${name}`)
  }
  await run(app, 'split.create', { tabIds: [a, c] })
  await expect.poll(async () => (await tabView(app, c))?.visible).toBe(true)
  await expect.poll(() => activeId(app)).toBe(a)
  await settled(shell)
  const url = (await state(app)).tabs[b]?.url as string
  const { note, page } = await linkPlaces(c, 'Right')
  await lift(b)
  await shell.mouse.move(note.x, note.y, { steps: 10 })
  await shell.mouse.move(note.x + 5, note.y, { steps: 2 })
  await expect(indicator()).toHaveCount(0)
  await shell.mouse.up()
  await expect.poll(() => page.evaluate(() => (document.getElementById('note') as HTMLTextAreaElement).value)).toBe(url)
  await expect.poll(() => activeId(app)).toBe(c)
  // Also once the row is back in the sidebar.
  await expect(shell.getByTestId('drag-ghost')).toHaveCount(0)
  await expect.poll(focusedUrl).toContain('/page/Right')
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('note')
  // The split is as it was; the dragged tab is still a tab of its own.
  const splits = Object.values((await state(app)).splits)
  expect(splits).toHaveLength(1)
  expect(JSON.stringify(splits[0]?.layout)).not.toContain(b)
})

// ---------- NV-08: a link dragged from a page onto the sidebar ----------

/**
 * The system's drag and drop of a link over the sidebar, at window point `x`, `y`: the events a
 * link dragged from a page gives the element there, each carrying the link.
 */
function linkDrag(type: 'dragenter' | 'dragover' | 'dragleave' | 'drop', x: number, y: number, url: string) {
  return orbit.shell.evaluate(
    ([type, x, y, url]) => {
      const el = document.elementFromPoint(x, y) ?? document.body
      const data = new DataTransfer()
      data.setData('text/uri-list', url)
      data.setData('text/plain', url)
      el.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: x,
          clientY: y,
          dataTransfer: data,
        }),
      )
    },
    [type, x, y, url] as const,
  )
}

/** Window y of tab `tabId`'s row as drawn (with the room a drag opens). */
async function rowTop(tabId: string): Promise<number> {
  return (await row(orbit.shell, tabId).boundingBox())?.y ?? Number.NaN
}

test('[NV-08][TB-02] a link dragged from a page onto the sidebar opens as a tab where it is dropped: rows make room there, a folder takes it in, Favorites open a place', async () => {
  const { app, shell } = orbit
  const sp = await space(app)
  const ids: string[] = []
  for (const name of ['One', 'Two', 'Three']) {
    const id = await newTab(app, fx.url(`/page/${name}`))
    await waitTab(app, id, `/page/${name}`)
    ids.push(id)
  }
  const folderId = await cmd<string>(app, 'folders.create', {
    name: 'Box',
    container: { kind: 'today', spaceId: sp.id },
    index: 3,
  })
  await run(app, 'folders.setCollapsed', { folderId, collapsed: true })
  await settled(shell)
  const today = async () => (await space(app)).today
  const [first, second] = (await today()) as [string, string]
  const box = await row(shell, first).boundingBox()
  if (!box) throw new Error('missing the first row')
  const x = box.x + box.width / 2
  const secondTop = await rowTop(second)

  // Over the first row's lower half: the rows below it make room for one row; it stays.
  const linked = fx.url('/page/Linked')
  await linkDrag('dragenter', x, box.y + box.height * 0.75, linked)
  await linkDrag('dragover', x, box.y + box.height * 0.75, linked)
  await expect.poll(async () => (await rowTop(second)) - secondTop).toBeGreaterThan(box.height * 0.9)
  expect(await rowTop(first)).toBeCloseTo(box.y, 0)
  // Off the sidebar, the room closes and nothing opens.
  await linkDrag('dragleave', x, box.y + box.height * 0.75, linked)
  await expect.poll(async () => Math.abs((await rowTop(second)) - secondTop)).toBeLessThan(1)

  // Back, and dropped: the link opens there, between the two rows, drawn whole at once as the
  // room closes.
  await linkDrag('dragenter', x, box.y + box.height * 0.75, linked)
  await linkDrag('dragover', x, box.y + box.height * 0.75, linked)
  await expect.poll(async () => (await rowTop(second)) - secondTop).toBeGreaterThan(box.height * 0.9)
  const count = Object.keys((await state(app)).tabs).length
  await shell.evaluate(() => {
    const w = window as unknown as { grown: string[] }
    w.grown = []
    new MutationObserver((list) => {
      for (const m of list) {
        for (const node of m.addedNodes) {
          if (node instanceof HTMLElement && node.matches('[data-slot]') && node.classList.contains('is-growing')) {
            w.grown.push(node.dataset.key ?? '')
          }
        }
      }
    }).observe(document.querySelector('[data-testid="today-list"]') as Node, { childList: true })
  })
  await linkDrag('drop', x, box.y + box.height * 0.75, linked)
  await expect.poll(async () => Object.keys((await state(app)).tabs).length).toBe(count + 1)
  const opened = (await today())[1] as string
  expect((await state(app)).tabs[opened]?.url).toBe(linked)
  await expect(row(shell, opened)).toBeVisible()
  expect(await shell.evaluate(() => (window as unknown as { grown: string[] }).grown)).toEqual([])
  expect(await rowTop(second)).toBeCloseTo(secondTop + box.height + 1, 0)

  // Over a closed folder's middle: the folder takes it in, and no row moves.
  const folder = shell.locator(`[data-testid="folder"][data-folder-id="${folderId}"] [data-testid="folder-row"]`)
  await folder.scrollIntoViewIfNeeded()
  const f = await folder.boundingBox()
  if (!f) throw new Error('missing the folder row')
  const into = fx.url('/page/Into')
  await linkDrag('dragenter', x, f.y + f.height / 2, into)
  await linkDrag('dragover', x, f.y + f.height / 2, into)
  await expect(folder).toHaveClass(/is-drop-into/)
  await linkDrag('drop', x, f.y + f.height / 2, into)
  await expect
    .poll(async () => {
      const s = await state(app)
      return (s.folders[folderId]?.children ?? []).map((id) => s.tabs[id]?.url)
    })
    .toEqual([into])
  await expect(folder).not.toHaveClass(/is-drop-into/)

  // Over the Favorites, above the list: a place opens there, and the link is a Favorite.
  const list = await shell.getByTestId('sidebar-scroll').boundingBox()
  if (!list) throw new Error('missing the list')
  const fav = fx.url('/page/Fav')
  await linkDrag('dragenter', x, list.y - 6, fav)
  await linkDrag('dragover', x, list.y - 6, fav)
  await expect(shell.getByTestId('favorite-placeholder')).toBeVisible()
  await linkDrag('drop', x, list.y - 6, fav)
  await expect
    .poll(async () => {
      const s = await state(app)
      return (s.profiles[DEFAULT_PROFILE_ID]?.favorites ?? []).map((id) => s.tabs[id]?.url)
    })
    .toEqual([fav])
  await expect(shell.getByTestId('favorite-placeholder')).toHaveCount(0)

  // On another Space's icon: it opens there, out of sight, and this window stays where it is.
  const other = await cmd<string>(app, 'spaces.create', { name: 'Other', activate: false })
  const icon = shell.locator(`[data-space-id="${other}"]`)
  await expect(icon).toBeVisible()
  const i = await icon.boundingBox()
  if (!i) throw new Error('missing the Space icon')
  const away = fx.url('/page/Away')
  await linkDrag('dragenter', i.x + i.width / 2, i.y + i.height / 2, away)
  await linkDrag('dragover', i.x + i.width / 2, i.y + i.height / 2, away)
  await linkDrag('drop', i.x + i.width / 2, i.y + i.height / 2, away)
  await expect
    .poll(async () => {
      const s = await state(app)
      return (s.spaces[other]?.today ?? []).map((id) => s.tabs[id]?.url)
    })
    .toEqual([away])
  expect(Object.values((await state(app)).windows).map((w) => w.spaceId)).toEqual([sp.id])
})

// ---------- TB-17: the blank window ----------

/** Window ids in the order they opened. */
function windowIds(): Promise<string[]> {
  return orbit.app.evaluate(() =>
    (globalThis as unknown as { __orbit: { windowIds: () => string[] } }).__orbit.windowIds(),
  )
}

/** The tabs (`tab`), Spaces or folders the command bar of window `w` offers for `query`. */
async function barFinds(w: number, query: string, kind: 'tab' | 'space' | 'folder'): Promise<string[]> {
  const { results } = await cmd<{ results: SearchResult[] }>(orbit.app, 'search.query', { query, mode: 'new-tab' }, w)
  return results
    .filter((r) => r.kind === kind)
    .map((r) => (kind === 'tab' ? r.tabId : kind === 'space' ? r.spaceId : r.folderId) ?? '')
}

test('[TB-17][NV-10][KS-05] New Blank Window, from the command bar (⌃⌘N on macOS): a sidebar of its own that starts empty, a step down and right, with the command bar open; what opens there stays there', async () => {
  const { app, shell } = orbit
  const sp = (await space(app)).id
  const pinned = await newTab(app, fx.url('/page/Pinned'), {
    container: { kind: 'pinned', spaceId: sp },
    activate: false,
  })
  const elsewhere = await cmd<string>(app, 'spaces.create', { name: 'Elsewhere', activate: false })
  const mine = await newTab(app, fx.url('/page/Mine'))
  await waitTab(app, mine, '/page/Mine')
  const first = (await windowIds())[0] as string
  // In the command bar everywhere: ⌃⌘N on macOS, no key elsewhere.
  await act(app, 'tab.new')
  const overlay = await viewPage(app, 'overlay')
  const bar = overlay.getByTestId('command-bar')
  await expect(bar.getByTestId('command-input')).toBeFocused()
  await overlay.keyboard.type('new blank window')
  const top = bar.getByTestId('command-result').first()
  await expect(top).toHaveAttribute('data-kind', 'action')
  await expect(top).toContainText('New Blank Window')
  if (isMac) await expect(top.getByTestId('command-shortcut')).toHaveText('⌃⌘N')
  else await expect(top.getByTestId('command-shortcut')).toHaveCount(0)
  await overlay.keyboard.press('Enter')
  await expect.poll(async () => (await windowIds()).length).toBe(2)
  const id = (await windowIds())[1] as string
  const s = await state(app)
  const blank = s.windows[id]?.spaceId as string
  expect(s.windows[id]?.kind).toBe('main')
  expect(s.spaces[blank]?.blank).toBe(true)
  expect(s.spaces[blank]?.profileId).toBe(s.spaces[sp]?.profileId)
  // Its Space is no Space of the user's.
  expect(s.spaceOrder).toEqual([sp, elsewhere])
  const [a, b] = await windowList(app)
  expect([b?.bounds?.x, b?.bounds?.y]).not.toEqual([a?.bounds?.x, a?.bounds?.y])

  // A sidebar of its own, empty: no Spaces, pinned tabs or Favorites, none of the first window's tabs.
  const side = await uiPageOf(app, 'shell', id)
  await expect(side.getByTestId('sidebar')).toHaveAttribute('data-blank', 'true')
  await expect(side.getByTestId('new-tab-button')).toBeVisible()
  await expect(side.getByTestId('tab-row')).toHaveCount(0)
  await expect(side.getByTestId('spacebar')).toHaveCount(0)
  await expect(side.getByTestId('space-strip')).toHaveCount(0)
  await expect(side.locator('[data-fav-id]')).toHaveCount(0)
  // The command bar is open for a first tab, which opens there.
  await expect.poll(async () => (await state(app)).windows[id]?.overlay.kind).toBe('commandbar')
  const there = await uiPageOf(app, 'overlay', id)
  const input = there.getByTestId('command-input')
  await expect(input).toBeFocused()
  await input.fill(fx.url('/page/Thrown'))
  await expect(there.getByTestId('command-result').filter({ hasText: 'Thrown' }).first()).toBeVisible()
  await input.press('Enter')
  await expect
    .poll(async () => {
      const t = await state(app)
      const shown = t.windows[id]?.activeTab[blank]
      return shown ? t.tabs[shown]?.url : undefined
    })
    .toBe(fx.url('/page/Thrown'))
  const thrown = (await state(app)).windows[id]?.activeTab[blank] as string
  await expect(side.locator(`[data-testid="tab-row"][data-tab-id="${thrown}"]`)).toBeVisible()
  const second = await cmd<string>(app, 'tabs.create', { url: fx.url('/page/Second') }, 1)
  await waitTab(app, second, '/page/Second')
  expect((await state(app)).spaces[blank]?.today).toEqual([second, thrown])

  // The first window doesn't list its tabs, can't show them, and its command bar doesn't offer them.
  await expect(shell.locator(`[data-tab-id="${thrown}"]`)).toHaveCount(0)
  await cmd(app, 'tabs.activate', { tabId: thrown })
  expect((await state(app)).windows[first]?.activeTab[sp]).toBe(mine)
  expect(await barFinds(0, 'Thrown', 'tab')).toEqual([])
  expect(await barFinds(0, 'Pinned', 'tab')).toEqual([pinned])
  expect(await barFinds(0, 'Elsewhere', 'space')).toEqual([elsewhere])
  // Its own command bar offers its tabs only, and no Space.
  expect(await barFinds(1, 'Thrown', 'tab')).toEqual([thrown])
  expect(await barFinds(1, 'Pinned', 'tab')).toEqual([])
  expect(await barFinds(1, 'Elsewhere', 'space')).toEqual([])
  await cmd(app, 'tabs.activate', { tabId: mine }, 1)
  expect((await state(app)).windows[id]?.activeTab[blank]).toBe(second)

  // Spaces, pinning and Favorites aren't there.
  await act(app, 'tab.togglePin', 1)
  await act(app, 'tab.favorite', 1)
  await act(app, 'space.next', 1)
  // Nor is a Space there to delete, or a folder to make.
  await act(app, 'space.delete', 1)
  await act(app, 'folder.new', 1)
  const after = await state(app)
  expect(after.spaces[blank]?.pinned).toEqual([])
  expect(after.spaces[blank]?.today).toEqual([second, thrown])
  expect(after.profiles[DEFAULT_PROFILE_ID]?.favorites).toEqual([])
  expect(after.windows[id]?.spaceId).toBe(blank)
  expect(after.windows[id]?.overlay.kind).toBe('none')
  expect(Object.keys(after.folders)).toEqual([])
  // Nor are they in its rows' menus.
  await side.locator(`[data-testid="tab-row"][data-tab-id="${thrown}"]`).click({ button: 'right' })
  const labels = await menuFor(app, thrown, 1)
  expect(labels).toContain('Close Tab')
  expect(labels.filter((l) => /^(Pin |Add to Favorites|Move to)/.test(l))).toEqual([])
  await closeOverlay(app, 1)
  // ⌘N there opens a normal window, on a Space of the user's.
  await act(app, 'window.new', 1)
  await expect.poll(async () => (await windowIds()).length).toBe(3)
  const normal = (await windowIds())[2] as string
  expect((await state(app)).windows[normal]?.spaceId).toBe(sp)
  const third = await uiPageOf(app, 'shell', normal)
  await expect(third.locator(`[data-testid="tab-row"][data-tab-id="${pinned}"]`)).toBeVisible()
  await expect(third.locator(`[data-tab-id="${thrown}"]`)).toHaveCount(0)
})

test('[TB-17][TB-22][TB-07] a blank window open at quit comes back with its tabs after a relaunch; closed, it is gone and its tabs are in the Archive, not in Reopen Closed Tab', async () => {
  const { app, userData } = orbit
  const sp = (await space(app)).id
  const kept = await newTab(app, fx.url('/page/Kept'))
  await waitTab(app, kept, '/page/Kept')
  await act(app, 'window.newBlank')
  await expect.poll(async () => (await windowIds()).length).toBe(2)
  const [first, id] = (await windowIds()) as [string, string]
  const blank = (await state(app)).windows[id]?.spaceId as string
  const away = await cmd<string>(app, 'tabs.create', { url: fx.url('/page/Away') }, 1)
  const far = await cmd<string>(app, 'tabs.create', { url: fx.url('/page/Far') }, 1)
  await waitTab(app, far, '/page/Far')
  expect((await state(app)).spaces[blank]?.today).toEqual([far, away])
  await flushState(app)
  await app.close()

  orbit = await launchOrbit({ userData })
  const s = await state(orbit.app)
  expect(Object.keys(s.windows).sort()).toEqual([first, id].sort())
  expect(s.windows[id]?.spaceId).toBe(blank)
  expect(s.spaces[blank]?.blank).toBe(true)
  expect(s.spaces[blank]?.today).toEqual([far, away])
  expect(s.spaceOrder).toEqual([sp])
  const side = await uiPageOf(orbit.app, 'shell', id)
  await expect(side.getByTestId('sidebar')).toHaveAttribute('data-blank', 'true')
  await expect(side.getByTestId('tab-row')).toHaveCount(2)
  const main = await uiPageOf(orbit.app, 'shell', first)
  await expect(main.locator(`[data-testid="tab-row"][data-tab-id="${kept}"]`)).toBeVisible()
  await expect(main.locator(`[data-tab-id="${far}"]`)).toHaveCount(0)

  // Closed: its Space goes, and its tabs go to the Archive; Reopen Closed Tab doesn't bring them back.
  await closeWindow(orbit.app, id)
  await expect.poll(async () => (await state(orbit.app)).spaces[blank]).toBeUndefined()
  const after = await state(orbit.app)
  expect(Object.keys(after.windows)).toEqual([first])
  expect(after.tabs[far]).toBeUndefined()
  expect(after.tabs[away]).toBeUndefined()
  expect(after.archive.map((e) => e.url)).toEqual(expect.arrayContaining([fx.url('/page/Away'), fx.url('/page/Far')]))
  await act(orbit.app, 'tab.reopenClosed')
  await main.waitForTimeout(300)
  const urls = Object.values((await state(orbit.app)).tabs).map((t) => t.url)
  expect(urls).not.toContain(fx.url('/page/Far'))
  expect(urls).not.toContain(fx.url('/page/Away'))
})

// ---------- TB-05: the recent-tab switcher (⌃Tab) ----------

type KeyEvent = [type: 'keyDown' | 'keyUp', keyCode: string, modifiers: Mod[]]

/** Key events, each sent to whatever has the keyboard at that moment, as the keyboard does. */
function keyEvents(...events: KeyEvent[]): Promise<void> {
  return orbit.app.evaluate(({ webContents }, list) => {
    for (const [type, keyCode, modifiers] of list) {
      webContents.getFocusedWebContents()?.sendInputEvent({ type, keyCode, modifiers })
    }
  }, events)
}

const CTRL: Mod[] = ['control']
const CTRL_DOWN: KeyEvent = ['keyDown', 'Control', CTRL]
const CTRL_UP: KeyEvent = ['keyUp', 'Control', []]
const TAB: KeyEvent[] = [
  ['keyDown', 'Tab', CTRL],
  ['keyUp', 'Tab', CTRL],
]

/** The first window's switcher: the tabs it lists, the highlighted one and whether its list is drawn. */
async function switcher(): Promise<{ tabs: string[]; highlighted: string | undefined; shown: boolean } | null> {
  const list = switcherOf(Object.values((await state(orbit.app)).windows)[0]?.overlay)
  return list ? { tabs: list.tabs, highlighted: list.tabs[list.index], shown: list.shown } : null
}

/** Opens a page for each name, each shown in turn, and gives the last one's page the keyboard. */
async function usedInTurn(names: string[]): Promise<string[]> {
  const ids: string[] = []
  for (const name of names) {
    const id = await newTab(orbit.app, fx.url(`/page/${name}`))
    await waitTab(orbit.app, id, `/page/${name}`)
    ids.push(id)
  }
  await cmd(orbit.app, 'tabs.focusPage', {})
  await expect.poll(focusedUrl).toBe(fx.url(`/page/${names.at(-1)}`))
  return ids
}

/** Shows the tabs in turn, so the last is the one shown and the order of use is theirs. */
async function useInTurn(ids: string[], last: string): Promise<void> {
  for (const id of ids) await cmd(orbit.app, 'tabs.activate', { tabId: id })
  await cmd(orbit.app, 'tabs.focusPage', {})
  await expect.poll(focusedUrl).toBe(fx.url(`/page/${last}`))
}

/** The switcher's list and its tabs in the overlay. */
const switcherList = (overlay: Page) => overlay.getByTestId('tab-switcher')
const switcherItem = (overlay: Page, tabId: string) =>
  overlay.locator(`[data-testid="tab-switcher-item"][data-tab-id="${tabId}"]`)

/** Watches the overlay page for the switcher's list ever being drawn; returns a reader. */
async function listEverShown(overlay: Page): Promise<() => Promise<boolean>> {
  await overlay.evaluate(() => {
    const w = window as unknown as { __switcherSeen?: boolean; __switcherWatch?: MutationObserver }
    w.__switcherSeen = !!document.querySelector('[data-testid="tab-switcher"]')
    w.__switcherWatch?.disconnect()
    w.__switcherWatch = new MutationObserver(() => {
      if (document.querySelector('[data-testid="tab-switcher"]')) w.__switcherSeen = true
    })
    w.__switcherWatch.observe(document.body, { subtree: true, childList: true })
  })
  return () => overlay.evaluate(() => !!(window as unknown as { __switcherSeen?: boolean }).__switcherSeen)
}

test('[TB-05][SP-16] held, ⌃Tab lists the five most recent tabs in the middle of the window, the second highlighted, in the Space’s colours over a page that is not dimmed; a quick tap goes straight back and shows nothing', async () => {
  const { app } = orbit
  const names = ['SwitchA', 'SwitchB', 'SwitchC', 'SwitchD', 'SwitchE', 'SwitchF']
  const [a, b, c, d, e, f] = (await usedInTurn(names)) as [string, string, string, string, string, string]
  const overlay = await viewPage(app, 'overlay')
  // A quick tap and release: the tab used before, at once, and no list.
  const seen = await listEverShown(overlay)
  await keyEvents(CTRL_DOWN, ...TAB, CTRL_UP)
  await expect.poll(() => activeId(app)).toBe(e)
  await expect.poll(focusedUrl).toBe(fx.url('/page/SwitchE'))
  await overlay.waitForTimeout(400)
  expect(await seen(), 'a quick tap shows no list').toBe(false)
  expect(await overlayKind()).toBe('none')

  // Held in a coloured Space: after a moment the list shows, most recent first, the second highlighted.
  await run(app, 'spaces.update', { spaceId: (await space(app)).id, theme: RED })
  await keyEvents(CTRL_DOWN, ...TAB)
  await expect(switcherList(overlay)).toBeVisible()
  expect(await switcher()).toEqual({ tabs: [e, f, d, c, b], highlighted: f, shown: true })
  const items = overlay.getByTestId('tab-switcher-item')
  await expect(items).toHaveCount(5)
  expect(await items.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.tabId))).toEqual([e, f, d, c, b])
  await expect(items.nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(overlay.locator('[data-testid="tab-switcher-item"][aria-selected="true"]')).toHaveCount(1)
  await expect(switcherItem(overlay, d)).toContainText('SwitchD')
  expect(await switcherItem(overlay, a).count(), 'only five').toBe(0)
  // In the middle of the window, in the Space’s colours, and nothing dims the page.
  const look = await overlay.evaluate(() => {
    const list = document.querySelector('[data-testid="tab-switcher"]') as HTMLElement
    const root = document.querySelector('[data-testid="overlay"]') as HTMLElement
    const probe = document.createElement('div')
    probe.style.background = 'var(--surface)'
    root.appendChild(probe)
    const surface = getComputedStyle(probe).backgroundColor
    probe.remove()
    const r = list.getBoundingClientRect()
    // Everything under the window's corners is see-through.
    const corners = [
      [2, 2],
      [innerWidth - 3, innerHeight - 3],
    ].flatMap(([x, y]) => document.elementsFromPoint(x as number, y as number))
    return {
      dx: r.x + r.width / 2 - innerWidth / 2,
      dy: r.y + r.height / 2 - innerHeight / 2,
      list: getComputedStyle(list).backgroundColor,
      surface,
      under: corners.map((el) => getComputedStyle(el).backgroundColor),
    }
  })
  expect(Math.abs(look.dx)).toBeLessThanOrEqual(1)
  expect(Math.abs(look.dy)).toBeLessThanOrEqual(1)
  expect(look.list).toBe(look.surface)
  // Red-family, as the Space is: more red than blue.
  const [red = 0, , blue = 0] = (look.list.match(/\d+/g) ?? []).map(Number)
  expect(red).toBeGreaterThan(blue)
  expect(look.under.every((bg) => bg === 'rgba(0, 0, 0, 0)')).toBe(true)
  // The page stays as it was until Control is let go; then the highlighted tab's page has the keyboard.
  expect(await activeId(app)).toBe(e)
  await keyEvents(CTRL_UP)
  await expect.poll(() => activeId(app)).toBe(f)
  await expect.poll(overlayKind).toBe('none')
  await expect.poll(focusedUrl).toBe(fx.url('/page/SwitchF'))
})

test('[TB-05][KS-19][KS-16] the list has the keyboard while it shows: Esc, a click beside it or another action ends it with no switch; a click on a tab switches to it; the page has the keyboard back after', async () => {
  const { app } = orbit
  const [a, b, c] = (await usedInTurn(['EscA', 'EscB', 'EscC'])) as [string, string, string]
  const overlay = await viewPage(app, 'overlay')
  // Esc.
  await keyEvents(CTRL_DOWN, ...TAB)
  await expect(switcherList(overlay)).toBeVisible()
  await expect.poll(focusedUrl).toContain('view=overlay')
  await keyEvents(['keyDown', 'Escape', CTRL], ['keyUp', 'Escape', CTRL])
  await expect.poll(overlayKind).toBe('none')
  await expect.poll(focusedUrl).toBe(fx.url('/page/EscC'))
  await keyEvents(CTRL_UP)
  await overlay.waitForTimeout(200)
  expect(await activeId(app)).toBe(c)
  // A click beside the list.
  await keyEvents(CTRL_DOWN, ...TAB)
  await expect(switcherList(overlay)).toBeVisible()
  const box = await switcherList(overlay).boundingBox()
  if (!box) throw new Error('no list')
  await overlay.mouse.click(box.x + box.width / 2, Math.max(4, box.y - 40))
  await expect.poll(overlayKind).toBe('none')
  await keyEvents(CTRL_UP)
  await overlay.waitForTimeout(200)
  expect(await activeId(app)).toBe(c)
  await expect.poll(focusedUrl).toBe(fx.url('/page/EscC'))
  // Another action: it runs, and the switch ends where it was.
  await keyEvents(CTRL_DOWN, ...TAB)
  await expect(switcherList(overlay)).toBeVisible()
  await act(app, 'sidebar.toggle')
  await expect.poll(overlayKind).toBe('none')
  await expect.poll(async () => Object.values((await state(app)).windows)[0]?.sidebar.visible).toBe(false)
  await keyEvents(CTRL_UP)
  await overlay.waitForTimeout(200)
  expect(await activeId(app)).toBe(c)
  await act(app, 'sidebar.toggle')
  // A click on a tab of the list (with Control still held): that tab, at once.
  await cmd(app, 'tabs.focusPage', {})
  await expect.poll(focusedUrl).toBe(fx.url('/page/EscC'))
  await keyEvents(CTRL_DOWN, ...TAB, ...TAB)
  await expect.poll(async () => (await switcher())?.highlighted).toBe(a)
  await switcherItem(overlay, b).click()
  await expect.poll(() => activeId(app)).toBe(b)
  await expect.poll(overlayKind).toBe('none')
  await expect.poll(focusedUrl).toBe(fx.url('/page/EscB'))
  await keyEvents(CTRL_UP)
  await overlay.waitForTimeout(200)
  expect(await activeId(app)).toBe(b)
})

test('[TB-05][MD-11] the list shows which tabs use the camera or microphone and which play sound, as their rows do', async () => {
  await orbit.app.close()
  orbit = await launchOrbit({ args: ['--use-fake-device-for-media-stream'] })
  const { app } = orbit
  const [call, loud, hush, plain] = (await usedInTurn(['Call', 'Loud', 'Hush', 'Plain'])) as [
    string,
    string,
    string,
    string,
  ]
  // A call: camera and microphone, allowed for the site, in a self view (what Orbit's page script sees).
  await cmd(app, 'site.setPermission', { tabId: call, kind: 'camera', allowed: true })
  await cmd(app, 'site.setPermission', { tabId: call, kind: 'microphone', allowed: true })
  const callPage = await tabPage(app, '/page/Call')
  expect(
    await callPage.evaluate(() =>
      navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then(
        (stream) => {
          const self = document.createElement('video')
          self.muted = true
          self.playsInline = true
          self.width = 160
          self.height = 90
          self.srcObject = stream
          document.body.append(self)
          return self.play().then(() => 'ok')
        },
        (err: Error) => err.name,
      ),
    ),
  ).toBe('ok')
  await expect.poll(async () => (await state(app)).tabs[call]?.media).toMatchObject({ camera: true, mic: true })
  // Sound: a tone in one page, and another muted.
  for (const urlPart of ['/page/Loud', '/page/Hush']) {
    await (await tabPage(app, urlPart)).evaluate(() => {
      const audio = new AudioContext()
      const tone = audio.createOscillator()
      const gain = audio.createGain()
      gain.gain.value = 0.05
      tone.connect(gain).connect(audio.destination)
      tone.start()
      ;(window as unknown as { __audio: AudioContext }).__audio = audio
    })
  }
  await cmd(app, 'tabs.setMuted', { tabId: hush, muted: true })
  await expect.poll(async () => (await state(app)).tabs[loud]?.audible).toBe(true)
  await expect.poll(async () => (await state(app)).tabs[hush]?.muted).toBe(true)
  await cmd(app, 'tabs.focusPage', {})
  await expect.poll(focusedUrl).toBe(fx.url('/page/Plain'))

  const overlay = await viewPage(app, 'overlay')
  await keyEvents(CTRL_DOWN, ...TAB)
  await expect(switcherList(overlay)).toBeVisible()
  await expect(switcherItem(overlay, call).getByTestId('tab-capture')).toBeVisible()
  await expect(switcherItem(overlay, call).getByTestId('tab-capture')).toHaveAttribute(
    'aria-label',
    'Using camera and microphone',
  )
  await expect(switcherItem(overlay, loud).getByTestId('tab-switcher-audio')).toHaveAttribute(
    'aria-label',
    'Playing sound',
  )
  await expect(switcherItem(overlay, hush).getByTestId('tab-switcher-audio')).toHaveAttribute('aria-label', 'Muted')
  for (const quiet of [plain, call]) {
    await expect(switcherItem(overlay, quiet).getByTestId('tab-switcher-audio')).toHaveCount(0)
  }
  for (const still of [plain, loud, hush]) {
    await expect(switcherItem(overlay, still).getByTestId('tab-capture')).toHaveCount(0)
  }
  await keyEvents(['keyDown', 'Escape', CTRL], ['keyUp', 'Escape', CTRL], CTRL_UP)
  await expect.poll(overlayKind).toBe('none')
})

/** Records, in main, when the overlay's layer is hidden (on the wall clock); returns a reader. */
async function overlayHidden(): Promise<() => Promise<number[]>> {
  await orbit.app.evaluate(({ BrowserWindow }) => {
    type View = Electron.View & {
      webContents?: Electron.WebContents
      setVisible: (on: boolean) => void
      getVisible: () => boolean
      __hidden?: number[]
    }
    const views = BrowserWindow.getAllWindows().flatMap((w) => w.contentView.children as View[])
    const view = views.find((v) => v.webContents?.getURL().includes('view=overlay'))
    if (!view) throw new Error('no overlay view')
    if (view.__hidden) {
      view.__hidden.length = 0
      return
    }
    const hidden: number[] = []
    view.__hidden = hidden
    const setVisible = view.setVisible.bind(view)
    view.setVisible = (on: boolean) => {
      const was = view.getVisible()
      setVisible(on)
      if (!on && was) hidden.push(performance.timeOrigin + performance.now())
    }
  })
  return () =>
    orbit.app.evaluate(({ BrowserWindow }) => {
      type View = Electron.View & { webContents?: Electron.WebContents; __hidden?: number[] }
      const views = BrowserWindow.getAllWindows().flatMap((w) => w.contentView.children as View[])
      return [...(views.find((v) => v.webContents?.getURL().includes('view=overlay'))?.__hidden ?? [])]
    })
}

test('[FL-26][TB-05] the list appears in a frame at the second Tab, or after a hold of about 150 ms, fading in without a slide; each Tab moves the highlight in a frame; letting go hides it and shows the page in the same frame', async () => {
  const { app } = orbit
  const FRAME = 1000 / 60
  const ids = await usedInTurn(['FeelA', 'FeelB', 'FeelC', 'FeelD'])
  const [a, b] = ids as [string, string, string, string]
  const overlay = await viewPage(app, 'overlay')
  const keys = await mainInputs(app)
  const hidden = await overlayHidden()
  const drawn = () =>
    overlay.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
  const lit =
    (tabId: string) => (f: { lists: Record<string, Record<string, { attrs?: Record<string, string | null> }>> }) =>
      f.lists.items?.[tabId]?.attrs?.['aria-selected'] === 'true'
  // One round: two quick Tabs show the list, a third moves the highlight to A, letting go shows A;
  // then a single held Tab shows the list after the hold, and Esc ends it. Times are judged on the
  // best of up to three rounds (D46); what holds every time holds in every round.
  const round = async () => {
    await useInTurn(ids, 'FeelD')
    await keys()
    await hidden()
    const shownA = await viewShown(app, a)
    const rec = await record(
      overlay,
      {
        list: '[data-testid="tab-switcher"]',
        items: { selector: '[data-testid="tab-switcher-item"]', key: 'data-tab-id', attrs: ['aria-selected'] },
      },
      { maxMs: 10_000, hidden: true },
    )
    await keyEvents(CTRL_DOWN, ...TAB, ...TAB)
    await expect(switcherList(overlay)).toBeVisible()
    await expect(switcherItem(overlay, b)).toHaveAttribute('aria-selected', 'true')
    await drawn()
    await keyEvents(...TAB)
    await expect(switcherItem(overlay, a)).toHaveAttribute('aria-selected', 'true')
    await drawn()
    await overlay.waitForTimeout(150)
    await keyEvents(CTRL_UP)
    await expect.poll(() => activeId(app)).toBe(a)
    await expect.poll(focusedUrl).toBe(fx.url('/page/FeelA'))
    // Held: one Tab, then the list after the hold.
    await keyEvents(CTRL_DOWN, ...TAB)
    await expect(switcherList(overlay)).toBeVisible()
    await drawn()
    await keyEvents(['keyDown', 'Escape', CTRL], ['keyUp', 'Escape', CTRL], CTRL_UP)
    await expect.poll(overlayKind).toBe('none')
    const r = await rec.stop()
    const seen = await keys()
    const tabs = seen.filter((k) => k.type === 'keyDown' && k.key === 'Tab')
    const release = seen.find((k) => k.type === 'keyUp' && k.key === 'Control')
    const [, second, third, held] = tabs
    if (tabs.length !== 4 || !second || !third || !held || !release)
      throw new Error(`keys main saw: ${seen.map((k) => `${k.type} ${k.key}`).join(', ')}`)
    const drawnList = (from: number) => r.frames.find((f) => f.i >= from && (f.els.list?.opacity ?? 0) > 0)
    // Appears: the first frame with the list after the second Tab, counted from the first frame drawn after it.
    const after2 = frameAfterWall(r, second.wall)
    const first = drawnList(after2)
    const fromThird = frameAfterWall(r, third.wall)
    const moved = r.frames.find((f) => f.i >= fromThird && lit(a)(f))
    // Fades in (opacity only) and never slides: one box in every frame it is drawn in, until let go.
    const releaseFrame = frameAfterWall(r, release.wall)
    const showing = r.frames.filter((f) => f.i >= (first?.i ?? 0) && f.i < releaseFrame && f.els.list)
    const full = showing.find((f) => (f.els.list?.opacity ?? 0) >= 0.999)
    const xs = showing.map((f) => f.els.list?.x ?? 0)
    const ys = showing.map((f) => f.els.list?.y ?? 0)
    // Let go: the layer is hidden and A's page shown in one go (main does both in the same task).
    const shown = (await shownA()).find((w) => w >= release.wall)
    const before = (await shownA()).filter((w) => w < release.wall)
    const hide = (await hidden()).find((w) => w >= release.wall)
    const heldList = drawnList(frameAfterWall(r, held.wall))
    return {
      appear: first ? first.i - after2 + 1 : Number.POSITIVE_INFINITY,
      appearMs: first ? r.wall0 + first.run - second.wall : undefined,
      highlight: moved ? moved.i - fromThird + 1 : Number.POSITIVE_INFINITY,
      fade: first && full ? full.t - first.t : Number.POSITIVE_INFINITY,
      slide: Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)),
      apart: shown !== undefined && hide !== undefined ? hide - shown : Number.POSITIVE_INFINITY,
      pageBefore: before.length,
      hold: heldList ? r.wall0 + heldList.run - held.wall : Number.POSITIVE_INFINITY,
    }
  }
  const budget = FRAME_SLACK > 1 ? 3 : 2
  // The list's first frame shows it before its fade's clock starts, so frame to frame the fade
  // reads one frame longer than it is (as feel-reduced.spec.ts allows).
  const fadeBudget = (100 + FRAME) * FRAME_SLACK
  const { best, all } = await bestOf(
    round,
    (m) =>
      m.appear <= budget &&
      m.highlight <= budget &&
      m.fade <= fadeBudget &&
      m.apart <= FRAME / 2 &&
      m.hold <= (150 + 3 * FRAME) * FRAME_SLACK,
  )
  console.log(
    `[feel] FL-26 rounds: ${all.map((m) => `list ${m.appear} frames, highlight ${m.highlight}, fade ${ms(m.fade)}, hide and page ${ms(m.apart)} apart, hold ${ms(m.hold)}`).join('; ')}`,
  )
  note('FL-26', 'second Tab → list in a frame', best.appearMs, '1 frame (16.7 ms)')
  note('FL-26', 'frames from the second Tab to the list', best.appear, '1', 'frames')
  note('FL-26', 'frames from a Tab to the highlight moving', best.highlight, '1 (at once)', 'frames')
  note('FL-26', 'fade in, first frame to full', best.fade, '≤ 100 ms (90 ms set)')
  note('FL-26', 'list moved while it showed', best.slide, '0 (no slide)', 'px')
  note('FL-26', 'letting go: layer hidden after the page shown', best.apart, '0 (same frame)')
  note('FL-26', 'held Tab → list in a frame', best.hold, '≈ 150 ms')
  for (const m of all) {
    expect(m.slide, 'the list never slides').toBeLessThanOrEqual(0.5)
    expect(m.pageBefore, 'no page changes before Control is let go').toBe(0)
    expect(m.apart, 'the layer goes after the page shows, never before').toBeGreaterThanOrEqual(0)
    expect(m.hold, 'a held Tab shows the list only after the hold').toBeGreaterThanOrEqual(150 - FRAME)
  }
  expect(best.appear, 'frames from the second Tab to the list').toBeLessThanOrEqual(budget)
  expect(best.highlight, 'frames from a Tab to the highlight').toBeLessThanOrEqual(budget)
  expect(best.fade).toBeLessThanOrEqual(fadeBudget)
  expect(best.apart, 'the layer hidden in the frame the page shows').toBeLessThanOrEqual(FRAME / 2)
  expect(best.hold).toBeLessThanOrEqual((150 + 3 * FRAME) * FRAME_SLACK)
  expect(await activeId(app)).toBe(a)
  expect(await switcher()).toBeNull()
})
