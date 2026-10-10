import { expect, test } from '@playwright/test'
import { action, isMac, launchOrbit, MOD, type Orbit, run, state, viewPage } from './helpers'
import { cmd, type NavFixtures, openTab, startNavFixtures } from './nav-support'
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
