/**
 * The finish-tabs lane: behaviours of tabs, folders, Favorites, Spaces and profiles finished after
 * the other lanes merged (lanes/finish-tabs.md).
 */
import { expect, type Page, test } from '@playwright/test'
import { DEFAULT_PROFILE_ID } from '../../src/shared/defaults'
import {
  type Fixtures,
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
import { pressInPage } from './nav-support'
import { openSettings } from './settings-support'
import {
  act,
  activeId,
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
