/**
 * The finish-tabs lane: behaviours of tabs, folders, Favorites, Spaces and profiles finished after
 * the other lanes merged (lanes/finish-tabs.md).
 */
import { expect, type Page, test } from '@playwright/test'
import { type Fixtures, isMac, launchOrbit, type Orbit, run, startFixtures, state, tabPage, viewPage } from './helpers'
import { cmd, menuFor, newTab, row, rowMenu, settled, space, tabsHook } from './tabs-support'

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
