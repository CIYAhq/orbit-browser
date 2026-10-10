import { expect, type Page, test } from '@playwright/test'
import { action, isMac, launchOrbit, MOD, type Orbit, run, state, tabPage, viewPage } from './helpers'
import { cmd, type NavFixtures, openTab, pressInPage, startNavFixtures, visit } from './nav-support'
import { activeSpace, createSpace } from './spaces-support'

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

/**
 * Types each key wherever the keyboard is, as the keyboard does (to the web contents that has
 * focus, not to a page the test picks); returns the URL of what took each key.
 */
function typeAnywhere(keys: string[]): Promise<string[]> {
  return orbit.app.evaluate(
    ({ webContents }, list) =>
      list.map((key) => {
        const contents = webContents.getFocusedWebContents()
        if (!contents) return '(nothing)'
        contents.sendInputEvent({ type: 'keyDown', keyCode: key })
        if ([...key].length === 1) contents.sendInputEvent({ type: 'char', keyCode: key })
        contents.sendInputEvent({ type: 'keyUp', keyCode: key })
        return contents.getURL()
      }),
    keys,
  )
}

/** Starts a slow load in a tab: the page commits only when the test releases it. */
async function slowLoad(tabId: string, path: string): Promise<void> {
  await cmd(orbit.app, 'tabs.navigate', { tabId, url: fx.url(path) })
  await expect.poll(() => fx.hits(path)).toBe(1)
}

/** Lets the slow page in and waits until its tab has finished loading. */
async function finishLoad(tabId: string, path: string): Promise<void> {
  fx.release(path)
  await expect.poll(async () => (await state(orbit.app)).tabs[tabId]?.loading).toBe(false)
  await expect.poll(async () => (await state(orbit.app)).tabs[tabId]?.url).toBe(fx.url(path))
}

test('[KS-16] keys typed into the command bar while a slow page finishes loading all reach the bar', async () => {
  const { app, shell } = orbit
  const id = await openTab(app, fx.url('/page/Start'))
  await slowLoad(id, '/slow/Late')
  await shell.keyboard.press(`${MOD}+T`)
  const input = (await viewPage(app, 'overlay')).getByTestId('command-input')
  await expect(input).toBeFocused()
  const before = await typeAnywhere(['a', 'b', 'c'])
  await finishLoad(id, '/slow/Late')
  const after = await typeAnywhere(['d', 'e', 'f'])
  // Every key went to the command bar's view, none to the page that finished loading.
  expect(new Set([...before, ...after]).size).toBe(1)
  expect(after[0]).toContain('view=overlay')
  await expect(input).toHaveValue('abcdef')
})

test('[KS-16] a page that finishes loading leaves a sidebar field being typed in alone', async () => {
  const { app, shell } = orbit
  const id = await openTab(app, fx.url('/page/Start'))
  await slowLoad(id, '/slow/Renamed')
  // Double-clicking the tab's row gives the sidebar the keyboard and opens the name field.
  await run(app, 'tabs.focusSidebar')
  await shell.locator(`[data-testid="tab-row"][data-tab-id="${id}"]`).dblclick()
  const field = shell.getByTestId('rename-field')
  await expect(field).toBeFocused()
  await typeAnywhere(['a', 'b'])
  await finishLoad(id, '/slow/Renamed')
  await typeAnywhere(['c', 'd'])
  await expect(field).toBeVisible()
  await expect(field).toHaveValue('abcd')
})

test('[KS-16] a tab in the background that loads again does not take the keyboard from the page in front', async () => {
  const { app } = orbit
  const back = await openTab(app, fx.url('/page/Back'))
  await slowLoad(back, '/slow/BackAgain')
  const front = await openTab(app, fx.url('/page/Front'))
  await expect.poll(async () => (await state(app)).tabs[front]?.loading).toBe(false)
  expect(await typeAnywhere(['a'])).toEqual([fx.url('/page/Front')])
  await finishLoad(back, '/slow/BackAgain')
  expect(await typeAnywhere(['b', 'c'])).toEqual([fx.url('/page/Front'), fx.url('/page/Front')])
})

// ---------- One keymap: remapping, several bindings, persistence (KS-01, KS-18) ----------

/** The primary modifier as bindings write it. */
const PRIMARY = isMac ? 'Cmd' : 'Ctrl'
const SHIFT_B = isMac ? '⇧⌘B' : 'Ctrl+Shift+B'

async function sidebarVisible(): Promise<boolean | undefined> {
  return Object.values((await state(orbit.app)).windows)[0]?.sidebar.visible
}

/** Opens the command bar, types `text` and returns the top row once it is the action `title`. */
async function actionRow(text: string, title: string) {
  await orbit.shell.keyboard.press(`${MOD}+T`)
  const overlay = await viewPage(orbit.app, 'overlay')
  await expect(overlay.getByTestId('command-input')).toBeFocused()
  await overlay.keyboard.type(text)
  const top = overlay.getByTestId('command-result').first()
  await expect(top).toHaveAttribute('data-kind', 'action')
  await expect(top.getByTestId('command-result-title')).toHaveText(title)
  return { overlay, top }
}

/** ⌘⇧B toggles the sidebar, and ⌘S no longer does. */
async function onlyShiftBToggles(): Promise<void> {
  const { shell } = orbit
  await shell.keyboard.press(`${MOD}+Shift+B`)
  await expect.poll(sidebarVisible).toBe(false)
  // Were ⌘S still bound, these two presses would toggle twice and leave the sidebar hidden.
  await shell.keyboard.press(`${MOD}+S`)
  await shell.keyboard.press(`${MOD}+Shift+B`)
  await expect.poll(sidebarVisible).toBe(true)
}

test('[KS-01][KS-18] remapping Toggle Sidebar to ⌘⇧B moves the key and every hint, and the remap and a Space key survive a restart', async () => {
  const { app, shell, userData } = orbit
  const bound = await run(app, 'keys.bind', {
    actionId: 'sidebar.toggle',
    accel: `${PRIMARY}+Shift+B`,
    replace: `${PRIMARY}+S`,
  })
  expect(bound).toEqual({ ok: true })
  // A bare function key may be a binding on its own: Space 2 moves to F8.
  const defaultSpaceKey = isMac ? 'Ctrl+2' : 'Alt+2'
  expect(await run(app, 'keys.bind', { actionId: 'space.goto.2', accel: 'F8', replace: defaultSpaceKey })).toEqual({
    ok: true,
  })
  // The sidebar button's tooltip follows the remap at once.
  await expect(shell.getByTestId('toggle-sidebar')).toHaveAttribute('title', `Hide sidebar (${SHIFT_B})`)
  await onlyShiftBToggles()
  // So does the command bar's row for the action.
  const { overlay, top } = await actionRow('Toggle Sidebar', 'Toggle Sidebar')
  await expect(top.getByTestId('command-shortcut')).toHaveText(SHIFT_B)
  await overlay.keyboard.press('Escape')
  if (isMac) {
    const menuKey = await app.evaluate(
      ({ Menu }) =>
        Menu.getApplicationMenu()
          ?.items.find((i) => i.label === 'View')
          ?.submenu?.items.find((i) => i.label === 'Toggle Sidebar')?.accelerator,
    )
    expect(menuKey).toBe('Command+Shift+B')
  }
  const first = await activeSpace(app)
  const second = await createSpace(app, { name: 'Second', activate: false })
  await shell.keyboard.press('F8')
  await expect.poll(() => activeSpace(app)).toBe(second)

  await orbit.app.close()
  orbit = await launchOrbit({ userData })
  expect((await state(orbit.app)).settings.shortcuts).toEqual({
    'sidebar.toggle': [`${PRIMARY}+Shift+B`],
    'space.goto.2': ['F8'],
  })
  await expect(orbit.shell.getByTestId('toggle-sidebar')).toHaveAttribute('title', `Hide sidebar (${SHIFT_B})`)
  await onlyShiftBToggles()
  await action(orbit.app, 'space.goto.1')
  await expect.poll(() => activeSpace(orbit.app)).toBe(first)
  await orbit.shell.keyboard.press('F8')
  await expect.poll(() => activeSpace(orbit.app)).toBe(second)
})

test('[KS-01] an action keeps several bindings, or none and the command bar still runs it; a binding needs a modifier and a free key', async () => {
  const { app, shell } = orbit
  expect(await run(app, 'keys.bind', { actionId: 'sidebar.toggle', accel: 'F7' })).toEqual({ ok: true })
  await shell.keyboard.press('F7')
  await expect.poll(sidebarVisible).toBe(false)
  await shell.keyboard.press(`${MOD}+S`)
  await expect.poll(sidebarVisible).toBe(true)

  // No modifier, or a key another action has: refused, and nothing changes.
  const bare = await run(app, 'keys.bind', { actionId: 'sidebar.toggle', accel: 'B' })
  expect(bare).toMatchObject({ ok: false, problem: expect.stringContaining('A shortcut starts with') })
  const taken = await run(app, 'keys.bind', { actionId: 'sidebar.toggle', accel: `${PRIMARY}+T` })
  expect(taken).toEqual({ ok: false, conflict: { actionId: 'tab.new', title: 'New Tab' } })
  expect((await state(app)).settings.shortcuts).toEqual({ 'sidebar.toggle': [`${PRIMARY}+S`, 'F7'] })

  await run(app, 'keys.unbind', { actionId: 'sidebar.toggle', accel: `${PRIMARY}+S` })
  await run(app, 'keys.unbind', { actionId: 'sidebar.toggle', accel: 'F7' })
  expect((await state(app)).settings.shortcuts).toEqual({ 'sidebar.toggle': [] })
  await expect(shell.getByTestId('toggle-sidebar')).toHaveAttribute('title', 'Hide sidebar')
  // ⌘S does nothing now; the command bar's row, with no shortcut shown, still toggles the sidebar.
  await shell.keyboard.press(`${MOD}+S`)
  const { overlay, top } = await actionRow('Toggle Sidebar', 'Toggle Sidebar')
  await expect(top.getByTestId('command-shortcut')).toHaveCount(0)
  await overlay.keyboard.press('Enter')
  await expect.poll(sidebarVisible).toBe(false)
})

// ---------- Platform mapping and the window keys (KS-03, KS-05) ----------

/** Presses a key wherever the keyboard is (the focused web contents), as a person would. */
function pressAnywhere(keyCode: string, modifiers: ('shift' | 'control' | 'alt' | 'meta')[] = []): Promise<string> {
  return orbit.app.evaluate(
    ({ webContents }, [code, mods]) => {
      const contents = webContents.getFocusedWebContents()
      if (!contents) return '(nothing)'
      contents.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers: mods })
      contents.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers: mods })
      return contents.getURL()
    },
    [keyCode, modifiers] as const,
  )
}

/** The URL of the web contents that has the keyboard. */
function focusedUrl(): Promise<string | undefined> {
  return orbit.app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL())
}

test('[KS-03][KS-06][KS-07] Linux and Windows: Alt+2 switches to Space 2 and Ctrl+2 selects the second sidebar item (macOS: ⌃2 and ⌘2)', async () => {
  const { app, shell } = orbit
  const space = await activeSpace(app)
  const second = (await run(app, 'tabs.create', { url: fx.url('/page/Second'), activate: false })) as string
  const first = (await run(app, 'tabs.create', { url: fx.url('/page/First'), activate: false })) as string
  expect((await state(app)).spaces[space]?.today.slice(0, 2)).toEqual([first, second])
  const other = await createSpace(app, { name: 'Other', activate: false })
  await shell.keyboard.press(`${MOD}+2`)
  await expect
    .poll(async () => {
      const win = Object.values((await state(app)).windows)[0]
      return win?.activeTab[space]
    })
    .toBe(second)
  await shell.keyboard.press(isMac ? 'Control+2' : 'Alt+2')
  await expect.poll(() => activeSpace(app)).toBe(other)
})

test('[KS-05] ⌘⇧W / Ctrl+Shift+W closes the window, and F6 moves the keyboard between the page and the sidebar', async () => {
  const { app } = orbit
  const id = await openTab(app, fx.url('/page/Focus'))
  await expect.poll(async () => (await state(app)).tabs[id]?.loading).toBe(false)
  await cmd(app, 'tabs.focusPage', {})
  await expect.poll(focusedUrl).toBe(fx.url('/page/Focus'))
  expect(await pressAnywhere('F6')).toBe(fx.url('/page/Focus'))
  await expect.poll(focusedUrl).toContain('view=shell')
  await pressAnywhere('F6')
  await expect.poll(focusedUrl).toBe(fx.url('/page/Focus'))

  const firstWindow = Object.keys((await state(app)).windows)[0]
  await action(app, 'window.new')
  await expect.poll(async () => Object.keys((await state(app)).windows).length).toBe(2)
  // The window closes on the key going down: the page is gone before the key comes up.
  await orbit.shell.keyboard.press(`${MOD}+Shift+W`).catch(() => {})
  await expect
    .poll(async () => Object.keys((await state(app)).windows))
    .toEqual([expect.not.stringMatching(`^${firstWindow}$`)])
})

// ---------- Pages that use Orbit's keys (KS-02) ----------

const SAVE = isMac ? '⌘S' : 'Ctrl+S'

/**
 * Opens a page with the keyboard. It counts its presses of ⌘/Ctrl + `code` (with Shift when
 * `shift`), and with `use` takes them for itself (preventDefault), as a web editor does with ⌘S.
 */
async function pageWithKeys(title: string, keys: { code: string; shift?: boolean; use: boolean }): Promise<Page> {
  const { app } = orbit
  const id = await openTab(app, fx.url(`/page/${title}`))
  await expect.poll(async () => (await state(app)).tabs[id]?.loading).toBe(false)
  const page = await tabPage(app, `/page/${title}`)
  await page.evaluate(
    ({ code, shift, use }) => {
      const w = window as unknown as { presses: number }
      w.presses = 0
      addEventListener('keydown', (e) => {
        if (e.code !== code || !(e.metaKey || e.ctrlKey) || e.shiftKey !== shift) return
        w.presses++
        if (use) e.preventDefault()
      })
    },
    { shift: false, ...keys },
  )
  await cmd(app, 'tabs.focusPage', {})
  await expect.poll(focusedUrl).toBe(fx.url(`/page/${title}`))
  return page
}

/**
 * ⌘/Ctrl + `key` (and Shift), pressed as the keyboard does. Playwright's own key presses reach
 * the page's renderer without passing Orbit's key router, so they can't show who gets the key.
 */
function pressMod(key: string, shift = false): Promise<string> {
  return pressAnywhere(key, [isMac ? 'meta' : 'control', ...(shift ? (['shift'] as const) : [])])
}

function presses(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { presses: number }).presses)
}

test('[KS-02][SB-11] a page that uses ⌘S / Ctrl+S gets the first press and a toast offers Toggle Sidebar; a second press within a second runs it', async () => {
  const { app, shell } = orbit
  const page = await pageWithKeys('Editor', { code: 'KeyS', use: true })
  await pressMod('s')
  await expect.poll(() => presses(page)).toBe(1)
  const toast = shell.getByTestId('toast').filter({ hasText: `The page used ${SAVE}` })
  await expect(toast).toHaveCount(1)
  expect(await sidebarVisible()).toBe(true)
  // The toast's button runs the action.
  await expect(toast.getByTestId('toast-action')).toHaveText('Toggle Sidebar')
  await toast.getByTestId('toast-action').click()
  await expect.poll(sidebarVisible).toBe(false)
  await action(app, 'sidebar.toggle')
  await expect.poll(sidebarVisible).toBe(true)

  // Pressed again soon after the page took it, the key toggles the sidebar and stays from the page.
  await cmd(app, 'tabs.focusPage', {})
  await expect.poll(focusedUrl).toBe(fx.url('/page/Editor'))
  await pressMod('s')
  await expect.poll(() => presses(page)).toBe(2)
  await expect(toast).toHaveCount(1)
  await pressMod('s')
  await expect.poll(sidebarVisible).toBe(false)
  expect(await presses(page)).toBe(2)
})

test('[KS-02][SB-11] a page that leaves ⌘S / Ctrl+S alone sees each press, and each press toggles the sidebar', async () => {
  const page = await pageWithKeys('Reader', { code: 'KeyS', use: false })
  await pressMod('s')
  await expect.poll(sidebarVisible).toBe(false)
  expect(await presses(page)).toBe(1)
  await pressMod('s')
  await expect.poll(sidebarVisible).toBe(true)
  expect(await presses(page)).toBe(2)
})

test('[KS-02][ST-08] set to prefer Orbit, ⌘S / Ctrl+S toggles the sidebar at once and the page never sees it', async () => {
  const { app } = orbit
  await run(app, 'keys.setPriority', { actionId: 'sidebar.toggle', priority: 'orbit' })
  expect((await state(app)).settings.shortcutPriority).toEqual({ 'sidebar.toggle': 'orbit' })
  const page = await pageWithKeys('Editor', { code: 'KeyS', use: true })
  await pressMod('s')
  await expect.poll(sidebarVisible).toBe(false)
  expect(await presses(page)).toBe(0)
  // Back to the default: the page has the first press again.
  await run(app, 'keys.setPriority', { actionId: 'sidebar.toggle', priority: 'websites' })
  expect((await state(app)).settings.shortcutPriority).toBeUndefined()
  await pressMod('s')
  await expect.poll(() => presses(page)).toBe(1)
  expect(await sidebarVisible()).toBe(false)
})

test('[KS-02][NV-17] Windows and Linux: a page that uses Ctrl+Shift+C gets it first and the toast offers Copy URL (macOS copies at once)', async () => {
  const { app, shell } = orbit
  const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText())
  await app.evaluate(({ clipboard }) => clipboard.writeText('before'))
  const page = await pageWithKeys('Sheet', { code: 'KeyC', shift: true, use: true })
  await pressMod('c', true)
  if (isMac) {
    await expect.poll(clipboard).toBe(fx.url('/page/Sheet'))
    expect(await presses(page)).toBe(0)
    return
  }
  await expect.poll(() => presses(page)).toBe(1)
  const toast = shell.getByTestId('toast').filter({ hasText: 'The page used Ctrl+Shift+C' })
  await expect(toast.getByTestId('toast-action')).toHaveText('Copy URL')
  expect(await clipboard()).toBe('before')
  await pressMod('c', true)
  await expect.poll(clipboard).toBe(fx.url('/page/Sheet'))
  expect(await presses(page)).toBe(1)
})

test('[KS-16][NV-01] in a page text field, ⌘[ / Alt+← goes back only when the page leaves the key alone', async () => {
  const { app } = orbit
  const [key, mods] = isMac ? (['[', ['meta']] as const) : (['Left', ['alt']] as const)
  const id = await openTab(app, fx.url('/page/FieldA'))
  await visit(app, id, fx.url('/page/FieldB'))
  await visit(app, id, fx.url('/page/FieldC'))
  const c = await tabPage(app, '/page/FieldC')
  // An editor that outdents with the key while its field has focus.
  await c.evaluate(() => {
    addEventListener('keydown', (e) => {
      if (document.activeElement?.id === 'box' && (e.code === 'BracketLeft' || e.code === 'ArrowLeft'))
        e.preventDefault()
    })
  })
  await c.focus('#box')
  await pressInPage(app, '/page/FieldC', key, [...mods])
  await expect
    .poll(() => c.evaluate(() => (window as unknown as { __keys: string[] }).__keys))
    .toContain(isMac ? '[' : 'ArrowLeft')
  // Outside the field the key is Orbit's: one page back. Had the first press gone back too, this
  // would land on A.
  await c.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await pressInPage(app, '/page/FieldC', key, [...mods])
  await expect.poll(async () => (await state(app)).tabs[id]?.url).toBe(fx.url('/page/FieldB'))
  // In the field of a page that leaves the key alone, it goes back.
  const b = await tabPage(app, '/page/FieldB')
  await b.focus('#box')
  await pressInPage(app, '/page/FieldB', key, [...mods])
  await expect.poll(async () => (await state(app)).tabs[id]?.url).toBe(fx.url('/page/FieldA'))
})

/**
 * Waits until main has had the answers to every page script it sent `urlPart`'s page before now:
 * the page answers in order.
 */
function pageScriptsAnswered(urlPart: string): Promise<void> {
  return orbit.app.evaluate(async ({ webContents }, part) => {
    const page = webContents.getAllWebContents().find((w) => w.getURL().includes(part))
    await page?.executeJavaScriptInIsolatedWorld(999, [{ code: '1' }])
  }, urlPart)
}

test('[KS-16][TB-18] ⌘Z / Ctrl+Z in a page text field undoes the typing, not the last sidebar change', async () => {
  const { app } = orbit
  const mod = isMac ? 'meta' : 'control'
  const a = await openTab(app, fx.url('/page/UndoA'))
  const b = await openTab(app, fx.url('/page/UndoB'))
  const id = await openTab(app, fx.url('/page/Typing'))
  await expect.poll(async () => (await state(app)).tabs[id]?.loading).toBe(false)
  await cmd(app, 'tabs.close', { tabId: a })
  await cmd(app, 'tabs.close', { tabId: b })
  const urls = async () => Object.values((await state(app)).tabs).map((t) => t.url)
  expect(await urls()).toEqual([fx.url('/page/Typing')])
  const page = await tabPage(app, '/page/Typing')
  await page.focus('#box')
  await page.keyboard.type('hello')
  await expect(page.locator('#box')).toHaveValue('hello')
  await pressInPage(app, '/page/Typing', 'z', [mod])
  await expect(page.locator('#box')).toHaveValue('')
  await pageScriptsAnswered('/page/Typing')
  expect(await urls()).toEqual([fx.url('/page/Typing')])
  // Outside the field the key undoes the last sidebar change: B comes back, and only B.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await pressInPage(app, '/page/Typing', 'z', [mod])
  await expect.poll(async () => (await urls()).sort()).toEqual([fx.url('/page/Typing'), fx.url('/page/UndoB')].sort())
})
