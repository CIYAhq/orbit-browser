/**
 * The finish-tabs lane: behaviours of tabs, folders, Favorites, Spaces and profiles finished after
 * the other lanes merged (lanes/finish-tabs.md).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import type { SearchResult } from '../../src/shared/commands/commandbar'
import { DEFAULT_PROFILE_ID } from '../../src/shared/defaults'
import { switcherOf } from '../../src/shared/tab-switcher'
import { engineForSpace, parseInput } from '../../src/shared/url'
import { type Box, bestOf, frameAfterWall, mainInputs, motionOf, ms, note, record, series, viewShown } from './frames'
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
import {
  choosePageMenu,
  clickInPage,
  closeWindow,
  flushState,
  pageMenu,
  pressInPage,
  uiPageOf,
  windowList,
} from './nav-support'
import { dialogPage, leaveInfo, pageDialogs, startInTab, startPagesFixtures, waitDialog } from './pages-support'
import { findPage, mainWindow, overlayOf, pressInTab, startSites } from './peek-helpers'
import { openSettings } from './settings-support'
import {
  act,
  activeId,
  closeOverlay,
  cmd,
  liveTabs,
  menuFor,
  newTab,
  type ResourceInfo,
  row,
  rowMenu,
  settled,
  space,
  tab,
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

test('[TB-14][KS-19][KS-16] a row menu opened while the sidebar has the keyboard gives it back to the sidebar, however it closes: Enter, a click or a bound key', async () => {
  const { app } = orbit
  const t = await newTab(app, fx.url('/page/MenuFromSidebar'))
  await waitTab(app, t, '/page/MenuFromSidebar')
  const overlay = await viewPage(app, 'overlay')
  const tabCount = async () => Object.keys((await state(app)).tabs).length
  const count = await tabCount()
  const fromSidebar = async () => {
    await act(app, 'sidebar.focus')
    await expect.poll(focusedUrl).toContain('view=shell')
    await cmd(app, 'tabs.contextMenu', { id: t, at: { x: 60, y: 220 } })
    await expect(menu(overlay)).toBeVisible()
    await expect.poll(focusedUrl).toContain('view=overlay')
  }
  // Where the keyboard is a moment after each way of closing the menu: all three are judged together.
  const went: Record<string, string> = {}
  const backInSidebar = async (how: string) => {
    await expect.poll(overlayKind, how).toBe('none')
    const at = async () => {
      const url = (await focusedUrl()) ?? 'nothing'
      return url.includes('view=shell') ? 'the sidebar' : url.includes('view=overlay') ? 'the overlay' : url
    }
    for (let i = 0; i < 20 && (await at()) !== 'the sidebar'; i++) await pause(100)
    await pause(300)
    went[how] = await at()
  }
  // Enter on an item.
  await fromSidebar()
  for (let i = 0; i < 20; i++) {
    await keys(['Down'])
    if ((await focusedItem(overlay).getAttribute('data-label', { timeout: 2_000 })) === 'Mute Tab') break
  }
  await expect(focusedItem(overlay)).toHaveAttribute('data-label', 'Mute Tab')
  await keys(['Enter'])
  await expect.poll(async () => (await state(app)).tabs[t]?.muted).toBe(true)
  await backInSidebar('Enter on Mute Tab')
  // A click on an item.
  await fromSidebar()
  await overlay.locator('[data-testid="row-menu-item"][data-label="Unmute Tab"]').click()
  await expect.poll(async () => (await state(app)).tabs[t]?.muted).toBeFalsy()
  await backInSidebar('a click on Unmute Tab')
  // A key bound to an Orbit action: it closes the menu, and nothing else.
  await fromSidebar()
  await keys(['W', [isMac ? 'meta' : 'control']])
  await backInSidebar(`${PRIMARY}+W`)
  expect(went).toEqual({
    'Enter on Mute Tab': 'the sidebar',
    'a click on Unmute Tab': 'the sidebar',
    [`${PRIMARY}+W`]: 'the sidebar',
  })
  expect(await tabCount()).toBe(count)
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

test('[TB-14][SV-22] a split row’s Change Icon…, though the page had the keyboard, gives it to the icon picker: what is typed finds the icon', async () => {
  const { app, shell } = orbit
  const t = await newTab(app, fx.url('/page/IconPage'))
  const c = await newTab(app, fx.url('/page/SplitL'), { activate: false })
  const d = await newTab(app, fx.url('/page/SplitR'), { activate: false })
  const split = await cmd<string>(app, 'split.create', { tabIds: [c, d] })
  await settled(shell)
  const overlay = await viewPage(app, 'overlay')
  await cmd(app, 'tabs.activate', { tabId: t })
  await cmd(app, 'tabs.focusPage', {})
  await expect.poll(focusedUrl).toBe(fx.url('/page/IconPage'))
  await shell.locator(`[data-testid="split-row"][data-split-id="${split}"]`).click({ button: 'right' })
  await expect(menu(overlay)).toHaveAttribute('data-key', split)
  await overlay.locator('[data-testid="row-menu-item"][data-label="Change Icon…"]').click()
  await expect.poll(overlayKind).toBe('none')
  const picker = shell.getByTestId('icon-picker')
  await expect(picker).toBeVisible()
  await expect.poll(focusedUrl).toContain('view=shell')
  await typeText('rocket')
  await expect(picker.getByTestId('emoji-search')).toHaveValue('rocket')
  await keys(['Enter'])
  await expect.poll(async () => (await state(app)).splits[split]?.icon).toBe('🚀')
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

test('[TB-09] a row only passing over a page tells it nothing: before a drop, its drag events list the link’s types with empty values', async () => {
  const { app, shell } = orbit
  const b = await newTab(app, fx.url('/page/Private'))
  const a = await newTab(app, fx.url('/page/Passed'))
  await waitTab(app, b, '/page/Private')
  await waitTab(app, a, '/page/Passed')
  await expect.poll(async () => (await tabView(app, a))?.visible).toBe(true)
  await settled(shell)
  const { note: field, chat, page } = await linkPlaces(a, 'Passed')
  // Everything the page's own listeners can read from the drag events it gets.
  await page.evaluate(() => {
    const seen: { type: string; types: string[]; values: string[] }[] = []
    ;(window as unknown as { seen: typeof seen }).seen = seen
    for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
      window.addEventListener(
        type,
        (e) => {
          const data = (e as DragEvent).dataTransfer
          const types = [...(data?.types ?? [])]
          seen.push({ type, types, values: types.map((t) => data?.getData(t) ?? '') })
        },
        true,
      )
    }
  })
  type Seen = { type: string; types: string[]; values: string[] }
  const seen = () => page.evaluate(() => (window as unknown as { seen: Seen[] }).seen)
  const frame = await shell.getByTestId('content-frame').boundingBox()
  if (!frame) throw new Error('missing the content frame')
  // Over the note field and the chat box on its way to the page's edge, and let go there: a split.
  await lift(b)
  await shell.mouse.move(field.x, field.y, { steps: 10 })
  await shell.mouse.move(field.x + 5, field.y, { steps: 2 })
  await expect(indicator()).toHaveCount(0)
  await shell.mouse.move(chat.x, chat.y, { steps: 4 })
  await shell.mouse.move(chat.x + 5, chat.y, { steps: 2 })
  await expect.poll(async () => (await seen()).filter((e) => e.type === 'dragover').length).toBeGreaterThan(2)
  await shell.mouse.move(frame.x + frame.width * 0.9, frame.y + frame.height / 2, { steps: 4 })
  await expect(indicator()).toBeVisible()
  await shell.mouse.up()
  await expect(shell.getByTestId('split-row')).toHaveCount(1)
  const events = await seen()
  expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['dragenter', 'dragover', 'dragleave']))
  expect(events.map((e) => e.type)).not.toContain('drop')
  for (const e of events) {
    expect(e.types.toSorted(), e.type).toEqual(['text/plain', 'text/uri-list'])
    expect(e.values, e.type).toEqual(['', ''])
  }
  expect(JSON.stringify(events)).not.toContain('/page/Private')
})

// ---------- NV-08: a link dragged from a page onto the sidebar ----------

/**
 * The system's drag and drop of a link over the sidebar, at window point `x`, `y`: the events a
 * link dragged from a page gives the element there, each carrying the link.
 */
function linkDrag(type: 'dragenter' | 'dragover' | 'dragleave' | 'drop', x: number, y: number, url: string) {
  return dragData(type, x, y, { 'text/uri-list': url, 'text/plain': url })
}

/** The same, with what the drag carries given by type: a page may offer any text, under either type. */
function dragData(
  type: 'dragenter' | 'dragover' | 'dragleave' | 'drop',
  x: number,
  y: number,
  carried: Record<string, string>,
) {
  return orbit.shell.evaluate(
    ([type, x, y, carried]) => {
      const el = document.elementFromPoint(x, y) ?? document.body
      const data = new DataTransfer()
      for (const [kind, value] of Object.entries(carried)) data.setData(kind, value)
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
    [type, x, y, carried] as const,
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

test('[NV-08][TB-02] what a page’s drag opens on the sidebar (D87): a web address only; other text a search on the list, and nothing on the Favorites; a data: address nothing anywhere', async () => {
  const { app, shell } = orbit
  const sp = await space(app)
  const t = await newTab(app, fx.url('/page/DropOnto'))
  await waitTab(app, t, '/page/DropOnto')
  await settled(shell)
  const box = await row(shell, t).boundingBox()
  const list = await shell.getByTestId('sidebar-scroll').boundingBox()
  if (!box || !list) throw new Error('missing the row or the list')
  const x = box.x + box.width / 2
  const onList = box.y + box.height * 0.75
  const onFavorites = list.y - 6
  const dropAt = async (y: number, carried: Record<string, string>) => {
    for (const type of ['dragenter', 'dragover', 'drop'] as const) await dragData(type, x, y, carried)
  }
  const urls = async () => Object.values((await state(app)).tabs).map((tb) => tb.url)
  const favorites = async () => (await state(app)).profiles[DEFAULT_PROFILE_ID]?.favorites ?? []
  const before = await urls()
  // A page-offered address of another scheme, as its link or as its text: on the list, nothing; on the Favorites, nothing.
  const offered = ['data:text/html,<h1>Offered</h1>', 'view-source:http://localhost/', 'javascript:alert(1)']
  for (const address of offered) {
    for (const y of [onList, onFavorites]) {
      await dropAt(y, { 'text/uri-list': address, 'text/plain': address })
      await dropAt(y, { 'text/plain': address })
    }
  }
  // Text that is no address, on the Favorites: nothing.
  const words = 'orbit dropped words'
  await dropAt(onFavorites, { 'text/plain': words })
  await expect(shell.getByTestId('favorite-placeholder')).toHaveCount(0)
  // On the list: a search for it, in a new tab where it was dropped, as if typed in the command bar.
  await dropAt(onList, { 'text/plain': words })
  const search = parseInput(words, engineForSpace(await state(app), sp.id)).url
  await expect.poll(urls).toEqual(expect.arrayContaining([search]))
  const made = (await urls()).filter((u) => !before.includes(u))
  expect(made).toEqual([search])
  expect(await favorites()).toEqual([])
  // A web address still opens, on the list or as a Favorite.
  await dropAt(onFavorites, { 'text/uri-list': fx.url('/page/Kept'), 'text/plain': fx.url('/page/Kept') })
  await expect
    .poll(async () => {
      const s = await state(app)
      return (s.profiles[DEFAULT_PROFILE_ID]?.favorites ?? []).map((id) => s.tabs[id]?.url)
    })
    .toEqual([fx.url('/page/Kept')])
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

test('[TB-17][TB-22] a blank window missing at load (a crash part-way through closing it): its Space goes, and its tabs go to the Archive', async () => {
  const { app, userData } = orbit
  const sp = (await space(app)).id
  await act(app, 'window.newBlank')
  await expect.poll(async () => (await windowIds()).length).toBe(2)
  const [first, id] = (await windowIds()) as [string, string]
  const blank = (await state(app)).windows[id]?.spaceId as string
  const lost = await cmd<string>(app, 'tabs.create', { url: fx.url('/page/Lost') }, 1)
  await waitTab(app, lost, '/page/Lost')
  await flushState(app)
  await app.close()
  // The state file as such a crash leaves it: the blank window's Space and its tab, with no window.
  const file = join(userData, 'orbit-state.json')
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { windows: Record<string, unknown> }
  delete saved.windows[id]
  writeFileSync(file, JSON.stringify(saved))

  orbit = await launchOrbit({ userData })
  await expect.poll(async () => (await state(orbit.app)).spaces[blank]).toBeUndefined()
  const s = await state(orbit.app)
  expect(Object.keys(s.windows)).toEqual([first])
  expect(s.tabs[lost]).toBeUndefined()
  expect(s.archive.map((e) => e.url)).toContain(fx.url('/page/Lost'))
  expect(s.spaceOrder).toEqual([sp])
})

test('[TB-17][NV-08][NV-12] a link a blank window’s page opens in a new window opens in a new blank window of its profile, where the page keeps its session (D88)', async () => {
  const { app } = orbit
  const first = (await shownSpace()) as string
  // The blank window comes from a Space in a profile of its own, and the first window then goes back to
  // the Default profile's Space: a normal window there would show the link in another session.
  const work = await cmd<string>(app, 'profiles.create', { name: 'Work' })
  await cmd(app, 'spaces.create', { name: 'Work', profileId: work })
  await act(app, 'window.newBlank')
  await expect.poll(async () => (await windowIds()).length).toBe(2)
  const blankId = (await windowIds())[1] as string
  await cmd(app, 'spaces.switch', { spaceId: first })
  expect((await state(app)).spaces[(await state(app)).windows[blankId]?.spaceId ?? '']?.profileId).toBe(work)
  const from = await cmd<string>(app, 'tabs.create', { url: fx.url('/page/Session') }, 1)
  await waitTab(app, from, '/page/Session')
  const page = await tabPage(app, '/page/Session')
  await page.evaluate(async () => {
    const jar = (window as unknown as { cookieStore: { set: (name: string, value: string) => Promise<void> } })
      .cookieStore
    await jar.set('kept', 'yes')
    const a = document.createElement('a')
    a.id = 'shifted'
    a.href = '/page/SessionShifted'
    a.textContent = 'Shifted'
    document.body.prepend(a)
  })
  /** The window opened last: a blank window of the Work profile, showing `url` in a page that has the cookie. */
  const opened = async (count: number, url: string) => {
    await expect.poll(async () => (await windowIds()).length).toBe(count)
    const id = (await windowIds())[count - 1] as string
    const s = await state(app)
    const spaceId = s.windows[id]?.spaceId as string
    expect(s.spaces[spaceId]?.blank, 'a blank window').toBe(true)
    expect(s.spaces[spaceId]?.profileId, 'its profile').toBe(work)
    expect(s.spaceOrder).not.toContain(spaceId)
    const shown = s.windows[id]?.activeTab[spaceId] as string
    expect(s.tabs[shown]?.url).toBe(url)
    await waitTab(app, shown, new URL(url).pathname)
    expect(await (await tabPage(app, new URL(url).pathname)).evaluate(() => document.cookie)).toContain('kept=yes')
  }
  // The page menu's Open Link in New Window.
  await clickInPage(app, fx.url('/page/Session'), '#next', [], 'right')
  await expect.poll(async () => (await pageMenu(app))?.labels ?? []).toContain('Open Link in New Window')
  expect(await choosePageMenu(app, 'Open Link in New Window')).toBe(true)
  await opened(3, fx.url('/page/Session-next'))
  // ⇧-click, with Peek's own ⇧-click turned off in Settings (peek.md): then it opens a new window (NV-08).
  await run(app, 'settings.update', { peekShiftClick: false })
  await clickInPage(app, fx.url('/page/Session'), '#shifted', ['shift'])
  await opened(4, fx.url('/page/SessionShifted'))
})

test('[TB-07][NV-11] tabs.recentlyClosed lists a private window’s closed tab to private windows only: not to a normal window, nor with no window', async () => {
  const { app } = orbit
  const mine = await newTab(app, fx.url('/page/ClosedHere'))
  await waitTab(app, mine, '/page/ClosedHere')
  await act(app, 'window.newPrivate')
  await expect.poll(async () => (await windowList(app)).map((w) => w.kind)).toEqual(['main', 'private'])
  const [normal, priv] = (await windowList(app)).map((w) => w.id) as [string, string]
  const secret = await cmd<string>(app, 'tabs.create', { url: fx.url('/page/ClosedPrivately') }, 1)
  await waitTab(app, secret, '/page/ClosedPrivately')
  await cmd(app, 'tabs.close', { tabId: secret }, 1)
  await cmd(app, 'tabs.close', { tabId: mine }, 0)
  await expect.poll(async () => (await state(app)).tabs[secret]).toBeUndefined()
  /** The command as a window sends it, or as main runs it with no window. */
  const listed = async (windowId: string | null) =>
    (
      (await app.evaluate(
        (_e, [w]) =>
          (
            globalThis as unknown as {
              __orbit: { run: (n: string, a: unknown, w?: string) => Promise<unknown> }
            }
          ).__orbit.run('tabs.recentlyClosed', {}, w ?? undefined),
        [windowId] as const,
      )) as { tabId: string }[]
    ).map((r) => r.tabId)
  const fromNormal = await listed(normal)
  expect(fromNormal).toContain(mine)
  expect(fromNormal).not.toContain(secret)
  const fromNone = await listed(null)
  expect(fromNone).toContain(mine)
  expect(fromNone).not.toContain(secret)
  expect(await listed(priv)).toContain(secret)
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
  // The spec's one frame, as the feel specs write it (feel-rows.spec.ts).
  const budget = FRAME_SLACK > 1 ? 2 : 1
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

// ---------- TB-13: what a selection's menu does ----------

/** The Space the first window shows. */
async function shownSpace(): Promise<string | undefined> {
  const id = (await windowIds())[0] as string
  return (await state(orbit.app)).windows[id]?.spaceId
}

test('[TB-13] a selection’s menu acts on every selected tab: pin, unpin, move to a Space, a new folder, and a split of up to four', async () => {
  const { app } = orbit
  const here = (await shownSpace()) as string
  const shown = async () => (await state(app)).spaces[here]
  const work = await cmd<string>(app, 'spaces.create', { name: 'Work', activate: false })
  const ids: string[] = []
  for (const n of [1, 2, 3, 4, 5]) ids.push(await newTab(app, fx.url(`/page/Sel${n}`), { activate: false }))
  const [a, b, c, d, e] = ids as [string, string, string, string, string]
  const choose = async (selection: string[], on: string, path: string) => {
    await cmd(app, 'tabs.setSelection', { tabIds: selection })
    await cmd(app, 'tabs.contextMenu', { id: on, selection })
    const labels = await menuFor(app, on)
    expect(labels, path).toContain(path)
    return tabsHook<boolean>(app, 'chooseRowMenu', path)
  }
  const sorted = (list: string[] | undefined) => [...(list ?? [])].sort()
  // Pin three, then unpin two of them.
  expect(await choose([a, b, c], b, 'Pin 3 Tabs')).toBe(true)
  await expect.poll(async () => sorted((await shown())?.pinned)).toEqual(sorted([a, b, c]))
  expect(await choose([a, b], a, 'Unpin 2 Tabs')).toBe(true)
  await expect.poll(async () => sorted((await shown())?.pinned)).toEqual([c])
  expect(sorted((await shown())?.today)).toEqual(sorted([a, b, d, e]))
  // Move two to another Space's Today; this Space stays in view.
  expect(await choose([d, e], d, 'Move to > Work > Today')).toBe(true)
  await expect.poll(async () => sorted((await state(app)).spaces[work]?.today)).toEqual(sorted([d, e]))
  expect(await shownSpace()).toBe(here)
  // A new folder with two.
  expect(await choose([a, b], b, 'New Folder with Tabs')).toBe(true)
  await expect
    .poll(async () => Object.values((await state(app)).folders).map((f) => sorted(f.children)))
    .toContainEqual(sorted([a, b]))
  // The new folder is pinned: it joins the pinned section.
  const folder = Object.values((await state(app)).folders).find(
    (f) => sorted(f.children).join() === sorted([a, b]).join(),
  )
  expect((await shown())?.pinned).toContain(folder?.id)
  expect((await shown())?.today).not.toContain(a)
  // Five can't share a split (four at most); two can.
  await cmd(app, 'tabs.activate', { tabId: c })
  const others = [await newTab(app, fx.url('/page/Sel6'), { activate: false })]
  others.push(await newTab(app, fx.url('/page/Sel7'), { activate: false }))
  others.push(await newTab(app, fx.url('/page/Sel8'), { activate: false }))
  others.push(await newTab(app, fx.url('/page/Sel9'), { activate: false }))
  const five = [c, ...others]
  await cmd(app, 'tabs.setSelection', { tabIds: five })
  await cmd(app, 'tabs.contextMenu', { id: c, selection: five })
  expect((await menuFor(app, c)).some((l) => l.startsWith('Open in Split View ('))).toBe(true)
  await closeOverlay(app)
  const [o1, o2] = others as [string, string]
  expect(await choose([o1, o2], o1, 'Open in Split View')).toBe(true)
  const panes = async () =>
    Object.values((await state(app)).splits).map((s) => sorted(JSON.stringify(s.layout).match(/t-[a-z0-9]+/g) ?? []))
  await expect.poll(panes).toContainEqual(sorted([o1, o2]))
})

// ---------- PR-09: renaming a profile ----------

test('[PR-09] a profile renamed in Settings has its new name at once in the Space menu, the badge, the switcher’s tooltip and Settings; Default can be renamed when it is the only one', async () => {
  const { app, shell } = orbit
  const page = await openSettings(app, { section: 'profiles' })
  const list = page.getByTestId('profile-list').getByRole('option')
  const name = page.getByTestId('profile-name')
  // Default, the only profile.
  await expect(list).toHaveCount(1)
  await name.fill('Personal')
  await name.press('Enter')
  await expect.poll(async () => (await state(app)).profiles[DEFAULT_PROFILE_ID]?.name).toBe('Personal')
  await expect(list.first()).toContainText('Personal')
  // Another profile, used by the Space on screen.
  const spaceId = await cmd<string>(app, 'spaces.create', { name: 'Client' })
  const work = await cmd<string>(app, 'profiles.create', { name: 'Work', assignSpaceId: spaceId })
  await page.getByTestId(`profile-${work}`).click()
  await expect(name).toHaveValue('Work')
  await name.fill('Studio')
  await name.press('Enter')
  await expect.poll(async () => (await state(app)).profiles[work]?.name).toBe('Studio')
  await expect(list.nth(1)).toContainText('Studio')
  await settled(shell)
  await shell.getByTestId('space-title-row').hover()
  await expect(shell.getByTestId('profile-badge')).toHaveText('S')
  await expect(shell.locator(`[data-testid="space-dot"][data-space-id="${spaceId}"]`)).toHaveAttribute(
    'title',
    /Client · Studio/,
  )
  await shell.getByTestId('space-menu-button').click()
  const overlay = await viewPage(app, 'overlay')
  await overlay.getByTestId('menu-profile').click()
  await expect(overlay.getByTestId(`menu-profile-${work}`)).toContainText('Studio')
  await expect(overlay.getByTestId(`menu-profile-${DEFAULT_PROFILE_ID}`)).toContainText('Personal')
  await overlay.keyboard.press('Escape')
})

// ---------- SP-11: ⌘Z after a Space reorder ----------

test('[SP-11][TB-18] ⌘Z after the Spaces are reordered puts them back and ⌘⇧Z again; the Space on screen stays', async () => {
  const { app, shell } = orbit
  const a = await shownSpace()
  const b = await cmd<string>(app, 'spaces.create', { name: 'Beta', activate: false })
  const c = await cmd<string>(app, 'spaces.create', { name: 'Gamma', activate: false })
  const order = async () => (await state(app)).spaceOrder
  const targets = () =>
    shell.getByTestId('space-dot').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.spaceId))
  const before = await order()
  expect([...before].sort()).toEqual([a, b, c].sort())
  await cmd(app, 'spaces.reorder', { spaceId: c, index: 0 })
  const after = await order()
  expect(after[0]).toBe(c)
  await expect.poll(targets).toEqual(after)
  const mod = isMac ? 'Meta' : 'Control'
  await shell.keyboard.press(`${mod}+Z`)
  await expect.poll(order).toEqual(before)
  await expect.poll(targets).toEqual(before)
  expect(await shownSpace()).toBe(a)
  await shell.keyboard.press(`${mod}+Shift+Z`)
  await expect.poll(order).toEqual(after)
  await expect.poll(targets).toEqual(after)
  expect(await shownSpace()).toBe(a)
})

// ---------- TB-15: an audible Favorite's notes ----------

/** Plays a quiet tone in the page whose URL has `urlPart`; closing its `window.__tone` stops it. */
async function playTone(urlPart: string): Promise<void> {
  await (await tabPage(orbit.app, urlPart)).evaluate(() => {
    const audio = new AudioContext()
    const tone = audio.createOscillator()
    const gain = audio.createGain()
    gain.gain.value = 0.05
    tone.connect(gain).connect(audio.destination)
    tone.start()
    ;(window as unknown as { __tone: AudioContext }).__tone = audio
  })
}

test('[TB-15] a Favorite playing sound shows small notes rising over its tile; muted, a still dot; silent again, nothing', async () => {
  const { app, shell } = orbit
  const id = await newTab(app, fx.url('/page/Tune'))
  await waitTab(app, id, '/page/Tune')
  await cmd(app, 'tabs.favorite', { tabId: id })
  const tile = shell.locator(`[data-testid="favorite-tile"][data-fav-id="${id}"]`)
  const notes = tile.getByTestId('favorite-notes')
  await expect(tile).toBeVisible()
  await expect(notes).toHaveCount(0)
  await playTone('/page/Tune')
  await expect.poll(async () => (await state(app)).tabs[id]?.audible).toBe(true)
  await expect(notes).toBeVisible()
  const motion = () =>
    notes.locator('.favorite__note').evaluateAll((els) => els.map((el) => getComputedStyle(el).animationName))
  expect(await motion()).toEqual(['favorite-note', 'favorite-note'])
  await cmd(app, 'tabs.setMuted', { tabId: id, muted: true })
  await expect(notes).toHaveCount(0)
  await expect(tile.locator('.favorite__audio')).toHaveCount(1)
  await cmd(app, 'tabs.setMuted', { tabId: id, muted: false })
  await expect(notes).toBeVisible()
  await (await tabPage(app, '/page/Tune')).evaluate(() =>
    (window as unknown as { __tone: AudioContext }).__tone.close(),
  )
  await expect.poll(async () => (await state(app)).tabs[id]?.audible).toBe(false)
  await expect(notes).toHaveCount(0)
  await expect(tile.locator('.favorite__audio')).toHaveCount(0)
})

// ---------- PR-08: a deleted profile's folder on disk ----------

test('[PR-08] deleting a profile in Settings removes its folder on disk at once, and at the next launch what its session wrote there as Orbit quit', async () => {
  const { app, userData } = orbit
  const client = await cmd<string>(app, 'spaces.create', { name: 'Client', activate: false })
  const work = await cmd<string>(app, 'profiles.create', { name: 'Work', assignSpaceId: client })
  // A page in the profile: its cookies, site data and cache have a folder of their own.
  const home = await shownSpace()
  await cmd(app, 'spaces.switch', { spaceId: client })
  const id = await newTab(app, fx.url('/page/Work'))
  await waitTab(app, id, '/page/Work')
  const folder = join(userData, 'Partitions', `orbit-${work}`)
  await expect.poll(() => existsSync(folder)).toBe(true)
  await cmd(app, 'spaces.switch', { spaceId: home })
  // The Space goes back to Default, so nothing uses the profile.
  await cmd(app, 'spaces.update', { spaceId: client, profileId: DEFAULT_PROFILE_ID })
  const page = await openSettings(app, { section: 'profiles' })
  await page.getByTestId(`profile-${work}`).click()
  await page.getByTestId('profile-delete').click()
  // It names the profile and what goes: logins, cookies, history, Favorites (no extensions yet).
  await expect(page.getByTestId('profile-delete-dialog')).toContainText('Work')
  await expect(page.getByTestId('profile-delete-dialog')).toContainText('logins, cookies, history, Favorites')
  await page.getByTestId('profile-delete-confirm').click()
  await expect.poll(async () => (await state(app)).profiles[work]).toBeUndefined()
  await expect.poll(() => existsSync(folder)).toBe(false)
  // Its session writes there again as Orbit quits: the next launch removes it.
  await app.close()
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'Cookies'), 'written as Orbit quit')
  orbit = await launchOrbit({ userData })
  expect(existsSync(folder)).toBe(false)
})

// ---------- FD-07: the folder glyph ----------

test('[FD-07][FL-12] a folder without an icon shows a folder in full colour, closed or open; opening cross-fades the two in about 150 ms', async () => {
  const { app, shell } = orbit
  const kids = [await newTab(app, fx.url('/page/In1'), { activate: false })]
  const spaceId = (await shownSpace()) as string
  const folderId = await cmd<string>(app, 'folders.create', {
    container: { kind: 'pinned', spaceId },
    name: 'Box',
    items: kids,
  })
  await cmd(app, 'folders.setCollapsed', { folderId, collapsed: true })
  const glyph = shell.locator(`[data-folder-id="${folderId}"] [data-testid="folder-glyph"]`).first()
  await expect(glyph).toBeVisible()
  // Filled with opaque colours, not drawn in lines or greys.
  const fills = await glyph.locator('path').evaluateAll((els) => els.map((el) => getComputedStyle(el).fill))
  for (const fill of fills) {
    // rgb(0–255) or, for a mixed colour, color(srgb 0–1).
    const unit = fill.startsWith('color(') ? 255 : 1
    const [r = 0, g = 0, b = 0, a = 1] = (fill.match(/[\d.]+/g) ?? []).map((n, i) => Number(n) * (i < 3 ? unit : 1))
    expect(a, fill).toBe(1)
    expect(Math.max(r, g, b) - Math.min(r, g, b), fill).toBeGreaterThan(20)
  }
  const fronts = () =>
    glyph.locator('.folder-glyph__front').evaluateAll((els) => els.map((el) => Number(getComputedStyle(el).opacity)))
  await expect.poll(fronts).toEqual([1, 0])
  // One round: the folder, closed, opened by a click. The time is judged on the best of up to three rounds (D46).
  const round = async () => {
    await cmd(app, 'folders.setCollapsed', { folderId, collapsed: true })
    await expect.poll(fronts).toEqual([1, 0])
    await settled(shell)
    const rec = await record(shell, {
      shut: `[data-folder-id="${folderId}"] .folder-glyph__shut`,
      lid: `[data-folder-id="${folderId}"] .folder-glyph__lid`,
    })
    await shell.locator(`[data-folder-id="${folderId}"] [data-testid="folder-row"]`).first().click()
    const r = await rec.until(600)
    await expect.poll(fronts).toEqual([0, 1])
    const fade = motionOf(
      series(r, 'lid', (b) => b.opacity * 100),
      1,
    )
    const both = r.frames.filter((f) => (f.els.lid?.opacity ?? 0) > 0.1 && (f.els.shut?.opacity ?? 0) > 0.1).length
    return { travel: fade.travel, moving: fade.moving, both, took: (fade.end ?? 0) - (fade.start ?? 0) }
  }
  const { best, all } = await bestOf(round, (m) => m.moving >= 3 && m.both >= 1 && m.took <= 250 * FRAME_SLACK)
  note(
    'FD-07',
    'folder icon, closed → open: cross-fade, first to last changing frame',
    best.took,
    'about 150 ms (FL-12)',
  )
  // It ends open every time.
  for (const m of all) expect(m.travel).toBeCloseTo(100, 0)
  // A cross-fade, not a swap: it changes over several frames, in some of which both show.
  expect(best.moving).toBeGreaterThanOrEqual(3)
  expect(best.both).toBeGreaterThanOrEqual(1)
  expect(best.took).toBeLessThanOrEqual(250 * FRAME_SLACK)
})

// ---------- TB-16: limits in the background beyond the sleep timer ----------

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** 1 GB, in KB as the system gives memory. */
const GB = 1024 * 1024

/** Keeps most of a core busy in a tab's page: 80 ms of work every 100 ms. */
async function busyPage(urlPart: string): Promise<void> {
  await (await tabPage(orbit.app, urlPart)).evaluate(() => {
    setInterval(() => {
      const end = performance.now() + 80
      while (performance.now() < end) {}
    }, 100)
  })
}

test('[TB-16] a tab in the background that keeps a core busy is frozen after three passes of it, and carries on when shown; one on screen never is', async () => {
  const { app } = orbit
  const busy = await newTab(app, fx.url('/page/Busy'))
  await waitTab(app, busy, '/page/Busy')
  await busyPage('/page/Busy')
  // Another site, so another process: the one on screen keeps a core busy too.
  const front = await newTab(app, fx.url('/page/Front').replace('//localhost:', '//127.0.0.1:'))
  await waitTab(app, front, '/page/Front')
  await busyPage('/page/Front')
  const pass = async () => {
    await pause(1_000)
    return tabsHook<ResourceInfo>(app, 'resources')
  }
  // The engine's reading is since the one before.
  await tabsHook(app, 'resources')
  let info = await pass()
  expect(info.usage[busy]).toBeGreaterThanOrEqual(50)
  // Not after one pass (the 10 s timer may have made one more).
  expect(info.frozen).toEqual([])
  for (let i = 0; i < 3 && !info.frozen.includes(busy); i++) info = await pass()
  expect(info.frozen).toEqual([busy])
  expect(info.usage[front]).toBeGreaterThanOrEqual(50)
  // Under Playwright every page counts as on screen (its focus emulation), and the engine freezes
  // no page on screen: here the page keeps running. Without Playwright it stops at once.
  await cmd(app, 'tabs.activate', { tabId: busy })
  await expect.poll(async () => (await tabsHook<ResourceInfo>(app, 'resources')).frozen.includes(busy)).toBe(false)
})

test('[TB-16][PK-01] an open Peek’s page is on screen: kept busy, it is never frozen; low on memory, it never sleeps', async () => {
  const { app } = orbit
  const under = await newTab(app, fx.url('/page/UnderBusyPeek'))
  await waitTab(app, under, '/page/UnderBusyPeek')
  // Another site, so another process.
  const url = fx.url('/page/BusyPeek').replace('//localhost:', '//127.0.0.1:')
  const peek = await cmd<string>(app, 'peek.open', { url })
  await expect.poll(focusedUrl).toBe(url)
  await busyPage('/page/BusyPeek')
  const pass = async () => {
    await pause(1_000)
    return tabsHook<ResourceInfo>(app, 'resources')
  }
  await tabsHook(app, 'resources')
  let info = await pass()
  expect(info.usage[peek]).toBeGreaterThanOrEqual(50)
  // Three passes freeze a page in the background: a few more.
  for (let i = 0; i < 4; i++) info = await pass()
  expect(info.frozen).not.toContain(peek)
  // Idle six minutes, with the system low on memory: tabs in the background sleep at once.
  await tabsHook(app, 'clockAhead', 6 * 60_000)
  expect((await tabsHook<ResourceInfo>(app, 'resources', { total: 8 * GB, available: 0.5 * GB })).lowMemory).toBe(true)
  await tabsHook(app, 'maintenance')
  expect(await overlayKind()).toBe('peek')
  expect((await state(app)).tabs[peek]?.asleep).toBeFalsy()
  expect(await liveTabs(app)).toContain(peek)
  // The page area changes (the sidebar hidden and shown): the card follows it, its page still there.
  await act(app, 'sidebar.toggle')
  await act(app, 'sidebar.toggle')
  await expect.poll(async () => Object.values((await state(app)).windows)[0]?.sidebar.visible).toBe(true)
  await pause(500)
  expect(orbit.takeUncaught(), "main's uncaught exceptions").toBe('')
  expect((await tabsHook<ResourceInfo>(app, 'resources', null)).lowMemory).toBe(false)
})

test('[TB-16] when the system is low on memory, tabs idle five minutes in the background sleep at once, whatever the timer', async () => {
  const { app } = orbit
  const a = await newTab(app, fx.url('/page/MemA'))
  await waitTab(app, a, '/page/MemA')
  const b = await newTab(app, fx.url('/page/MemB'))
  await waitTab(app, b, '/page/MemB')
  await tabsHook(app, 'clockAhead', 6 * 60_000)
  // The timer is 30 minutes.
  expect((await tabsHook<{ slept: string[] }>(app, 'maintenance')).slept).toEqual([])
  const low = await tabsHook<ResourceInfo>(app, 'resources', { total: 8 * GB, available: 0.5 * GB })
  expect(low.lowMemory).toBe(true)
  expect((await state(app)).tabs[a]?.asleep).toBe(true)
  expect(await liveTabs(app)).not.toContain(a)
  // On screen: awake.
  expect((await state(app)).tabs[b]?.asleep).toBeFalsy()
  expect((await tabsHook<ResourceInfo>(app, 'resources', null)).lowMemory).toBe(false)
})

test('[TB-16] below 20 % on battery power: a heads-up that the battery saver is on, and tabs in the background sleep sooner; it lifts above 20 % or on charge', async () => {
  const { app, shell } = orbit
  const a = await newTab(app, fx.url('/page/BatA'))
  await waitTab(app, a, '/page/BatA')
  const b = await newTab(app, fx.url('/page/BatB'))
  await waitTab(app, b, '/page/BatB')
  await tabsHook(app, 'clockAhead', 8 * 60_000)
  expect((await tabsHook<{ slept: string[] }>(app, 'maintenance')).slept).toEqual([])
  /** The engine's battery, as the window's page reads it, changed. */
  const battery = (level: number, charging: boolean) =>
    shell.evaluate(
      async ([l, c]) => {
        const it = await (navigator as unknown as { getBattery: () => Promise<EventTarget> }).getBattery()
        Object.defineProperty(it, 'level', { configurable: true, get: () => l })
        Object.defineProperty(it, 'charging', { configurable: true, get: () => c })
        it.dispatchEvent(new Event('levelchange'))
      },
      [level, charging] as const,
    )
  const saver = async () => (await tabsHook<ResourceInfo>(app, 'resources')).saver
  const headsUp = shell.getByTestId('toast').filter({ hasText: 'Battery saver is on' })
  await battery(0.15, false)
  await expect(headsUp).toBeVisible()
  expect(await saver()).toBe(true)
  // A quarter of the 30-minute timer: the tab idle 8 minutes sleeps at once.
  expect((await state(app)).tabs[a]?.asleep).toBe(true)
  expect((await state(app)).tabs[b]?.asleep).toBeFalsy()
  await battery(0.21, false)
  await expect.poll(saver).toBe(false)
  await battery(0.15, false)
  await expect.poll(saver).toBe(true)
  await battery(0.15, true)
  await expect.poll(saver).toBe(false)
})

test('[TB-16] tabs put to sleep give their memory back; a sleeping tab costs under 5 MB', async () => {
  const { app } = orbit
  /** All of Orbit's processes, in KB: the middle of three readings. */
  const memory = async () => {
    const readings: number[] = []
    for (let i = 0; i < 3; i++) {
      await pause(300)
      readings.push(
        await app.evaluate(({ app }) => app.getAppMetrics().reduce((n, m) => n + m.memory.workingSetSize, 0)),
      )
    }
    return readings.sort((x, y) => x - y)[1] as number
  }
  const processes = () => app.evaluate(({ app }) => app.getAppMetrics().length)
  const stay = await newTab(app, fx.url('/page/Stay'))
  await waitTab(app, stay, '/page/Stay')
  // A tab loaded and put to sleep first: Orbit's own views a load brings (its loading indicator,
  // its link pill) are made once, so they count before. Whatever was open sleeps too.
  const first = await newTab(app, fx.url('/page/First'))
  await waitTab(app, first, '/page/First')
  await cmd(app, 'tabs.activate', { tabId: stay })
  await tabsHook(app, 'clockAhead', 31 * 60_000)
  await tabsHook(app, 'maintenance')
  await expect.poll(async () => (await liveTabs(app)).length).toBe(1)
  await pause(1_000)
  const few = await processes()
  const before = await memory()
  const loaded: string[] = []
  for (let i = 0; i < 10; i++) {
    const id = await newTab(app, fx.url(`/page/Load${i}`))
    await waitTab(app, id, `/page/Load${i}`)
    loaded.push(id)
  }
  await cmd(app, 'tabs.activate', { tabId: stay })
  const awake = await memory()
  await tabsHook(app, 'clockAhead', 31 * 60_000)
  expect((await tabsHook<{ slept: string[] }>(app, 'maintenance')).slept.sort()).toEqual([...loaded].sort())
  // Their processes have gone (the engine may keep one spare).
  await expect.poll(processes).toBeLessThanOrEqual(few + 1)
  const slept = await memory()
  // 40 more, asleep from the start: what a sleeping tab costs, its sidebar row included.
  for (let i = 0; i < 40; i++) await newTab(app, fx.url(`/page/Never${i}`), { activate: false })
  await pause(1_000)
  const more = await memory()
  const each = (more - slept) / 40 / 1024
  const all = (more - before) / 50 / 1024
  note('TB-16', '10 loaded tabs put to sleep: memory given back', (awake - slept) / 1024, 'it drops', 'MB')
  note('TB-16', 'a sleeping tab, all processes, its sidebar row included (40 more asleep)', each, '< 5 MB', 'MB')
  note('TB-16', '… the same over all 50, with what loading the 10 left behind', all, '< 5 MB', 'MB')
  expect(awake - slept).toBeGreaterThan(10 * 1024)
  expect(each).toBeLessThan(5)
})

test('[AR-11][FD-01] a folder that comes back with its tabs in one update (Restore Data) draws its row in the frame its tabs first show, above them', async () => {
  const { app, shell } = orbit
  const tabs: string[] = []
  for (const name of ['Packing', 'Hotels']) {
    const t = await newTab(app, fx.url(`/page/${name}`))
    await waitTab(app, t, `/page/${name}`)
    tabs.push(t)
  }
  const folderId = (await run(app, 'folders.create', { name: 'Trip ideas', items: tabs })) as string
  await expect.poll(async () => (await state(app)).folders[folderId]?.children.length).toBe(2)
  const backup = (await run(app, 'backups.take')) as { id: string }
  await run(app, 'folders.delete', { folderId })
  await expect(shell.locator(`[data-slot][data-key="${folderId}"]`)).toHaveCount(0)
  await settled(shell)
  // Every row of the pinned section, nested ones too, in each frame as it is drawn.
  const rec = await record(shell, { slots: { selector: '[data-testid="pinned-list"] [data-slot]', key: 'data-key' } })
  // One store update brings back the folder and both its tabs.
  expect(await run(app, 'backups.restore', { id: backup.id })).toMatchObject({ restored: true })
  await expect.poll(async () => (await state(app)).folders[folderId]?.children.toSorted()).toEqual(tabs.toSorted())
  const r = await rec.until(1200)
  const drawn = (b: Box | undefined): b is Box => !!b && b.height > 1 && b.opacity > 0.02
  const firstShown = r.frames.find((f) => tabs.some((id) => drawn(f.lists.slots?.[id])))
  expect(firstShown, 'the restored tabs were drawn').toBeDefined()
  const orphans: string[] = []
  for (const f of r.frames) {
    const folder = f.lists.slots?.[folderId]
    for (const id of tabs) {
      const child = f.lists.slots?.[id]
      if (!drawn(child)) continue
      if (!drawn(folder) || folder.y + folder.height > child.y + 1) {
        const at = folder ? `${Math.round(folder.height)} px high, opacity ${folder.opacity.toFixed(2)}` : 'not there'
        orphans.push(`frame ${f.i}: tab row at ${Math.round(child.y)}, folder row ${at}`)
      }
    }
  }
  console.log(`[AR-11] tab rows drawn without their folder row: ${orphans.length} (first tab frame ${firstShown?.i})`)
  expect(orphans).toEqual([])
})

test('[NV-24][FL-09] ⌘W on a busy page with a leave listener shows the next tab at once; a page that warns shows again to ask, and Cancel keeps it (D77 (4))', async () => {
  const { app } = orbit
  const pages = await startPagesFixtures()
  try {
    const other = await newTab(app, pages.url('/page/Other'))
    await waitTab(app, other, '/page/Other')
    // A page that may warn: it was clicked (D77).
    const clicked = async (path: string) => {
      const url = pages.url(path)
      const id = await newTab(app, url)
      await waitTab(app, id, path)
      await clickInPage(app, url, '#area')
      await expect.poll(async () => (await leaveInfo(app, id))?.gestures ?? 0).toBeGreaterThan(0)
      return id
    }

    // Busy, with a leave listener that lets it go: the engine waits on the page's answer, up to its
    // limit (under test, with a debugger attached, until the page answers). The next tab shows meanwhile.
    const busy = await clicked('/page/Busy')
    await startInTab(
      app,
      busy,
      `addEventListener('beforeunload', () => {}); { const end = Date.now() + 2000; while (Date.now() < end) {} }`,
    )
    await new Promise((r) => setTimeout(r, 200))
    await act(app, 'tab.close')
    expect(await activeId(app), 'the next tab shows as the close starts').toBe(other)
    expect(await tab(app, busy), 'its page is still being let go').toBeTruthy()
    await expect.poll(async () => (await tabView(app, busy))?.visible ?? false, { timeout: 500 }).toBe(false)
    await expect.poll(async () => (await tabView(app, other))?.visible, { timeout: 500 }).toBe(true)
    await expect.poll(async () => await tab(app, busy)).toBeUndefined()
    expect(await activeId(app)).toBe(other)
    expect(await pageDialogs(app)).toEqual([])
    // ⌘Z reopens it where it showed (AR-09).
    expect(await cmd(app, 'tabs.undo')).toBe('Close Tab')
    await expect.poll(async () => await activeId(app)).toBe(busy)

    // A page that warns shows again, with the question over it: Cancel keeps it there, Leave closes it.
    const warns = await clicked('/warn')
    await act(app, 'tab.close')
    const asked = await waitDialog(app, (x) => x.tabId === warns && x.onScreen && x.kind === 'leave')
    expect(await activeId(app)).toBe(warns)
    await (await dialogPage(app, asked.id)).getByTestId('page-dialog-cancel').click()
    await expect.poll(async () => (await pageDialogs(app)).length).toBe(0)
    expect(await activeId(app)).toBe(warns)
    expect(await liveTabs(app)).toContain(warns)
    expect((await tabView(app, warns))?.visible).toBe(true)
    await act(app, 'tab.close')
    const again = await waitDialog(app, (x) => x.tabId === warns && x.onScreen && x.kind === 'leave')
    await (await dialogPage(app, again.id)).getByTestId('page-dialog-ok').click()
    await expect.poll(async () => await tab(app, warns)).toBeUndefined()
    const next = await activeId(app)
    expect(next).toBeTruthy()
    await expect.poll(async () => (await tabView(app, next as string))?.visible).toBe(true)
  } finally {
    await pages.close()
  }
})

test('[PN-05][PK-02][PK-03][PK-07][PK-12] in a Favorite, a same-site link stays in it and another site’s opens a Peek over it, which ⌘O makes a Today tab; with previews off it opens a Today tab, and Shift-click, under its own setting, still previews', async () => {
  const { app } = orbit
  const sites = await startSites()
  try {
    const win = await mainWindow(app)
    const profileId = (await state(app)).spaces[win.spaceId]?.profileId as string
    const container = { kind: 'favorites', profileId }
    const fav = (await run(app, 'tabs.create', { url: sites.url('/site/Fav'), container })) as string
    await run(app, 'tabs.activate', { tabId: fav })
    const page = await findPage(app, '/site/Fav')
    await expect(page.locator('#title')).toBeVisible()
    const today = async () => (await state(app)).spaces[win.spaceId]?.today ?? []
    const peekOpen = async () => {
      await expect.poll(async () => (await overlayOf(app)).kind).toBe('peek')
      const o = await overlayOf(app)
      return o.kind === 'peek' ? o : undefined
    }

    // The same site navigates in the Favorite, like an app.
    await page.locator('#same').click()
    await expect.poll(async () => (await state(app)).tabs[fav]?.url).toBe(sites.url('/site/Fav-Same'))
    expect((await overlayOf(app)).kind).toBe('none')
    // Another site opens a Peek over it, and the Favorite keeps its page.
    await page.locator('#other').click({ noWaitAfter: true })
    const peek = await peekOpen()
    expect(peek?.sourceTabId).toBe(fav)
    expect((await state(app)).tabs[peek?.tabId as string]?.url).toBe(sites.other('/site/Other'))
    // ⌘O: a selected Today tab, at the top of Today.
    await pressInTab(app, peek?.tabId as string, 'Mod+O')
    await expect.poll(async () => (await overlayOf(app)).kind).toBe('none')
    expect((await mainWindow(app)).activeTab[win.spaceId]).toBe(peek?.tabId)
    expect((await today())[0]).toBe(peek?.tabId)
    expect((await state(app)).tabs[fav]?.url).toBe(sites.url('/site/Fav-Same'))

    // Previews off (Links settings): another site opens a Today tab instead. (Clicks from here on
    // go through the browser's input: Playwright waits forever on a page whose link navigation
    // Orbit cancelled.)
    await run(app, 'settings.update', { peekExternalLinks: false })
    await run(app, 'tabs.activate', { tabId: fav })
    await clickInPage(app, '/site/Fav-Same', '#other')
    await expect.poll(async () => (await today()).length).toBe(2)
    expect((await state(app)).tabs[(await today())[0] as string]?.url).toBe(sites.other('/site/Other'))
    expect((await overlayOf(app)).kind).toBe('none')
    expect((await state(app)).tabs[fav]?.url).toBe(sites.url('/site/Fav-Same'))
    // Shift-click has its own setting: still on, it previews any link, the same site's too.
    await run(app, 'tabs.activate', { tabId: fav })
    await clickInPage(app, '/site/Fav-Same', '#next', ['shift'])
    const shifted = await peekOpen()
    expect(shifted?.sourceTabId).toBe(fav)
    expect((await state(app)).tabs[shifted?.tabId as string]?.url).toBe(sites.url('/site/Fav-Same-Next'))
  } finally {
    await sites.close()
  }
})

test('[PR-10][ST-12][ST-20] Settings acts for the profile of the Space it is opened from: Clear Browsing Data… is the Work profile’s from a Work Space, the Default profile’s from another', async () => {
  const { app } = orbit
  const home = (await mainWindow(app)).spaceId
  const spaceId = (await run(app, 'spaces.create', { name: 'Work', activate: false })) as string
  const work = (await run(app, 'profiles.create', { name: 'Work', assignSpaceId: spaceId })) as string
  for (const [space, profile, name] of [
    [spaceId, work, 'Work'],
    [home, DEFAULT_PROFILE_ID, 'Default'],
  ] as const) {
    await run(app, 'spaces.switch', { spaceId: space })
    const page = await openSettings(app, { section: 'privacy', item: 'clear-data' })
    await expect(page.getByTestId('clear-data-dialog')).toBeVisible()
    await expect(page.getByTestId('clear-data-profile')).toHaveValue(profile)
    await expect(page.getByTestId('setting-clear-data').locator('.st-scope')).toHaveText(name)
    await run(app, 'settings.close')
  }
})

test('[SV-26][TB-08] two Today rows become one split row in place, the one above closing up into it; separating it slides the second row out from under the first, with the reorder spring', async () => {
  const { app, shell } = orbit
  const a = await newTab(app, fx.url('/page/A'))
  const b = await newTab(app, fx.url('/page/B'))
  await newTab(app, fx.url('/page/C'))
  await settled(shell)
  // Today, top to bottom: C, B, A.
  const slots = '[data-list^="today:"] > [data-slot]'
  const drawn = (x: Box | undefined): x is Box => !!x && x.height > 1 && x.opacity > 0.02
  const firstDrawn = (frames: { lists: { slots?: Record<string, Box> } }[], key: string) =>
    frames.findIndex((f) => drawn(f.lists.slots?.[key]))

  // A joins B: one split row where they were.
  let rec = await record(shell, { slots: { selector: slots, key: 'data-key' } })
  const splitId = (await cmd(app, 'tabs.splitWith', { tabId: a, target: b, side: 'right' })) as string
  expect(splitId).toBeTruthy()
  let r = await rec.until(700)
  const was = { a: r.frames[0]?.lists.slots?.[a] as Box, b: r.frames[0]?.lists.slots?.[b] as Box }
  const shown = firstDrawn(r.frames, splitId)
  expect(shown, 'the split row was drawn').toBeGreaterThanOrEqual(0)
  const first = r.frames[shown]?.lists.slots?.[splitId] as Box
  const last = r.frames.at(-1)?.lists.slots?.[splitId] as Box
  expect(first.height, 'the split row is whole in its first frame').toBeGreaterThanOrEqual(last.height - 1)
  expect(first.y, 'it starts no lower than the row whose room it takes').toBeLessThanOrEqual(was.a.y + 1)
  expect(drawn(r.frames[shown]?.lists.slots?.[a]), 'that row is gone as it shows').toBe(false)
  expect(Math.abs(last.y - was.b.y), 'it ends where the row above was').toBeLessThanOrEqual(1)
  const closing = r.frames.map((f) => f.lists.slots?.[b]).filter(drawn)
  for (const box of closing) expect(Math.abs(box.x - was.b.x), 'the row above stays in place').toBeLessThanOrEqual(1)
  const merged = r.frames.findIndex(
    (f, i) => i >= shown && Math.abs((f.lists.slots?.[splitId]?.y ?? -99) - last.y) <= 0.5,
  )
  const settle = (r.frames[merged]?.t ?? Number.NaN) - (r.frames[shown]?.t ?? Number.NaN)
  note('SV-26', 'two rows into one split row: first drawn to settled', settle, '≈ 300 ms')

  // Separate: B in the split row's place at once, A sliding down out from under it.
  await settled(shell)
  rec = await record(shell, { slots: { selector: slots, key: 'data-key' } })
  await cmd(app, 'split.separate', { splitId })
  r = await rec.until(700)
  const split = r.frames[0]?.lists.slots?.[splitId] as Box
  const bAt = firstDrawn(r.frames, b)
  const aAt = firstDrawn(r.frames, a)
  expect(bAt).toBeGreaterThanOrEqual(0)
  expect(aAt).toBeGreaterThanOrEqual(0)
  const end = { a: r.frames.at(-1)?.lists.slots?.[a] as Box, b: r.frames.at(-1)?.lists.slots?.[b] as Box }
  const bFirst = r.frames[bAt]?.lists.slots?.[b] as Box
  expect(bFirst.height, 'the first row is whole in its first frame').toBeGreaterThanOrEqual(end.b.height - 1)
  expect(Math.abs(bFirst.y - split.y), 'in the split row’s place').toBeLessThanOrEqual(1)
  const aFirst = r.frames[aAt]?.lists.slots?.[a] as Box
  // Sliding down from there (a slow machine's first frame may come late in the slide).
  const from = FRAME_SLACK > 1 ? 1 : end.a.height / 2
  expect(aFirst.y, 'the second row starts under the first').toBeLessThan(end.a.y - from)
  expect(end.a.y).toBeGreaterThan(end.b.y)
  for (const f of r.frames.slice(Math.min(aAt, bAt))) expect(drawn(f.lists.slots?.[splitId])).toBe(false)
})
