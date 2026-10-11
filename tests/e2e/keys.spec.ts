import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, type Page, test } from '@playwright/test'
import { FOCUS_IS_EDITABLE } from '../../src/main/nav/focus'
import { switcherOf } from '../../src/shared/tab-switcher'
import { action, isMac, launchOrbit, MOD, type Orbit, run, state, tabPage, viewPage } from './helpers'
import {
  cmd,
  cmdIn,
  type NavFixtures,
  NEW_TAB_CLICK,
  openTab,
  pressInPage,
  setNativeFullScreen,
  startNavFixtures,
  uiPageOf,
  visit,
  waitLoaded,
  windowList,
  windowState,
  zoomOf,
} from './nav-support'
import { openSettings, osWindows, pageOfView } from './settings-support'
import { activeSpace, createSpace } from './spaces-support'

let fx: NavFixtures
let orbit: Orbit

test.beforeAll(async () => {
  fx = await startNavFixtures(3370, 3389)
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

/** Toggle Sidebar set to prefer websites: its default on Windows and Linux; macOS prefers Orbit (D60). */
async function sidebarPrefersWebsites(): Promise<void> {
  if (isMac) await run(orbit.app, 'keys.setPriority', { actionId: 'sidebar.toggle', priority: 'websites' })
}

test('[KS-02][SB-11] preferring websites, a page that uses ⌘S / Ctrl+S gets the first press and a toast offers Toggle Sidebar; a second press within a second runs it', async () => {
  const { app, shell } = orbit
  await sidebarPrefersWebsites()
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

test('[KS-02][SB-11] preferring websites, a page that leaves ⌘S / Ctrl+S alone sees each press, and each press toggles the sidebar', async () => {
  await sidebarPrefersWebsites()
  const page = await pageWithKeys('Reader', { code: 'KeyS', use: false })
  await pressMod('s')
  await expect.poll(sidebarVisible).toBe(false)
  expect(await presses(page)).toBe(1)
  await pressMod('s')
  await expect.poll(sidebarVisible).toBe(true)
  expect(await presses(page)).toBe(2)
})

test('[KS-02][ST-08] ⌘S prefers Orbit on macOS (D60) and Ctrl+S websites on Windows and Linux; preferring Orbit, the sidebar toggles at once and the page never sees the key', async () => {
  const { app } = orbit
  // Prefer Orbit: macOS's default; on Windows and Linux a choice that is stored.
  if (!isMac) await run(app, 'keys.setPriority', { actionId: 'sidebar.toggle', priority: 'orbit' })
  expect((await state(app)).settings.shortcutPriority).toEqual(isMac ? undefined : { 'sidebar.toggle': 'orbit' })
  const page = await pageWithKeys('Editor', { code: 'KeyS', use: true })
  await pressMod('s')
  await expect.poll(sidebarVisible).toBe(false)
  expect(await presses(page)).toBe(0)
  // Prefer websites (back to the default on Windows and Linux): the page has the first press.
  await run(app, 'keys.setPriority', { actionId: 'sidebar.toggle', priority: 'websites' })
  expect((await state(app)).settings.shortcutPriority).toEqual(isMac ? { 'sidebar.toggle': 'websites' } : undefined)
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
  await focusKnown('/page/FieldC', 'main', 'field')
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

test('[KS-16][NV-01] a web component’s text field counts as one: ⌘[ / Alt+← there goes back only when the page leaves the key alone, and ⌘← / ⌘→ stay its own (keys fix check K1)', async () => {
  const { app } = orbit
  const [key, mods] = isMac ? (['[', ['meta']] as const) : (['Left', ['alt']] as const)
  const id = await openTab(app, fx.url('/page/ShadowA'))
  await visit(app, id, fx.url('/page/ShadowB'))
  await visit(app, id, fx.url('/page/ShadowC'))
  const c = await tabPage(app, '/page/ShadowC')
  // A field inside a web component (an open shadow root), whose editor outdents with the key.
  await c.evaluate(() => {
    customElements.define(
      'x-editor',
      class extends HTMLElement {
        constructor() {
          super()
          const field = document.createElement('input')
          field.id = 'inner'
          this.attachShadow({ mode: 'open' }).append(field)
        }
      },
    )
    const editor = document.createElement('x-editor')
    document.body.append(editor)
    addEventListener('keydown', (e) => {
      const inField = editor.shadowRoot?.activeElement?.id === 'inner'
      if (inField && (e.code === 'BracketLeft' || e.code === 'ArrowLeft')) e.preventDefault()
    })
  })
  await c.locator('#inner').focus()
  await focusKnown('/page/ShadowC', 'main', 'field')
  // What ⌘← / ⌘→ ask before they go back or forward (macOS): a text field, so they don't.
  expect(await c.evaluate(FOCUS_IS_EDITABLE)).toBe(true)
  await pressInPage(app, '/page/ShadowC', key, [...mods])
  await expect
    .poll(() => c.evaluate(() => (window as unknown as { __keys: string[] }).__keys))
    .toContain(isMac ? '[' : 'ArrowLeft')
  // Outside the field the key is Orbit's: one page back. Had the first press gone back too, this
  // would land on A.
  await c.locator('#inner').blur()
  await focusKnown('/page/ShadowC', 'main', 'page')
  expect(await c.evaluate(FOCUS_IS_EDITABLE)).toBe(false)
  await pressInPage(app, '/page/ShadowC', key, [...mods])
  await expect.poll(async () => (await state(app)).tabs[id]?.url).toBe(fx.url('/page/ShadowB'))
})

test('[KS-02][KS-16] while a page is on its way, Orbit takes its keys at once: ⌘S / Ctrl+S toggles the sidebar, and ⌘[ / Alt+← in a text field goes back', async () => {
  const { app } = orbit
  await sidebarPrefersWebsites()
  const [key, mods] = isMac ? (['[', ['meta']] as const) : (['Left', ['alt']] as const)
  const id = await openTab(app, fx.url('/page/WayA'))
  await visit(app, id, fx.url('/page/WayB'))
  const b = await tabPage(app, '/page/WayB')
  await b.focus('#box')
  await slowLoad(id, '/slow/WayC')
  await pressInPage(app, '/page/WayB', 's', [isMac ? 'meta' : 'control'])
  await expect.poll(sidebarVisible).toBe(false)
  await pressInPage(app, '/page/WayB', key, [...mods])
  await expect.poll(async () => (await state(app)).tabs[id]?.url).toBe(fx.url('/page/WayA'))
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

// ---------- Keyboard focus in a frame, and pages that are busy (KS-16, KS-02, D60) ----------

type KeysHooks = {
  __orbitKeys: {
    focusIn: (urlPart: string) => { frame: string; where: string | null } | null
    escapes: () => { url: string; used: boolean; stopped: boolean }[]
  }
}

/**
 * Waits until Orbit knows where the keyboard is in the page at `urlPart`: in `frame` ('main' for
 * the page itself, else the frame's address), on a text field or elsewhere on it ('page').
 */
async function focusKnown(urlPart: string, frame: string, where: 'field' | 'page'): Promise<void> {
  await expect
    .poll(() =>
      orbit.app.evaluate((_e, part) => (globalThis as unknown as KeysHooks).__orbitKeys.focusIn(part), urlPart),
    )
    .toEqual({ frame, where })
}

const [BACK_KEY, BACK_MODS] = isMac ? (['[', ['meta']] as const) : (['Left', ['alt']] as const)

/** Runs a script in a frame of the page at `urlPart`, in the frame's own world. */
function inFrame<T>(urlPart: string, frameUrl: string, code: string): Promise<T> {
  return orbit.app.evaluate(
    async ({ webContents }, [part, url, js]) => {
      const page = webContents.getAllWebContents().find((w) => w.getURL().includes(part))
      const frame = page?.mainFrame.framesInSubtree.find((f) => f.url === url)
      if (!frame) throw new Error(`no frame ${url} in ${part}`)
      return await frame.executeJavaScript(js)
    },
    [urlPart, frameUrl, code] as const,
  ) as Promise<T>
}

/**
 * Puts a frame at the top of the page at `urlPart`, showing `/page/<inner>` from the page's own
 * origin or another one, with a plain button (#plain) in it; returns the frame's address.
 */
async function addFrame(urlPart: string, inner: string, crossOrigin: boolean): Promise<string> {
  const src = crossOrigin ? fx.urlOn('127.0.0.1', `/page/${inner}`) : fx.url(`/page/${inner}`)
  const page = await tabPage(orbit.app, urlPart)
  await page.evaluate(
    (url) =>
      new Promise<void>((resolve) => {
        const frame = document.createElement('iframe')
        frame.style.cssText = 'display:block;width:520px;height:320px;border:0'
        frame.addEventListener('load', () => resolve(), { once: true })
        frame.src = url
        document.body.prepend(frame)
      }),
    src,
  )
  await inFrame(urlPart, src, `document.body.insertAdjacentHTML('afterbegin', '<button id="plain">Plain</button>')`)
  return src
}

/** Clicks an element in a frame as the mouse does, which gives it the keyboard. */
async function clickInFrame(urlPart: string, frameUrl: string, selector: '#plain' | '#box'): Promise<void> {
  const page = await tabPage(orbit.app, urlPart)
  const frame = await page.locator(`iframe[src="${frameUrl}"]`).boundingBox()
  const at = await inFrame<{ x: number; y: number }>(
    urlPart,
    frameUrl,
    `(() => { const r = document.querySelector('${selector}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`,
  )
  if (!frame) throw new Error('no frame')
  await page.mouse.click(frame.x + at.x, frame.y + at.y)
  await expect
    .poll(() =>
      inFrame(urlPart, frameUrl, 'document.hasFocus() && document.activeElement && document.activeElement.id'),
    )
    .toBe(selector.slice(1))
}

/** A tab at `<title>-C` that came from `<title>-A` and `<title>-B`, with the keyboard, and a frame in it. */
async function framedTab(title: string, crossOrigin: boolean): Promise<{ id: string; at: string; frame: string }> {
  const { app } = orbit
  const id = await openTab(app, fx.url(`/page/${title}-A`))
  await visit(app, id, fx.url(`/page/${title}-B`))
  await visit(app, id, fx.url(`/page/${title}-C`))
  await cmd(app, 'tabs.focusPage', {})
  await expect.poll(focusedUrl).toBe(fx.url(`/page/${title}-C`))
  const frame = await addFrame(`/page/${title}-C`, `${title}-Inner`, crossOrigin)
  return { id, at: `/page/${title}-C`, frame }
}

const urlOf = async (tabId: string) => (await state(orbit.app)).tabs[tabId]?.url

for (const crossOrigin of [false, true]) {
  const kind = crossOrigin ? 'cross-origin' : 'same-origin'
  const tag = crossOrigin ? 'X' : 'S'

  test(`[KS-16][NV-01] keyboard on a button in a ${kind} frame: ⌘[ / Alt+← goes back, at once`, async () => {
    const { app } = orbit
    const { id, at, frame } = await framedTab(`FrameButton${tag}`, crossOrigin)
    await clickInFrame(at, frame, '#plain')
    await focusKnown(at, frame, 'page')
    await pressInPage(app, at, BACK_KEY, [...BACK_MODS])
    await expect.poll(() => urlOf(id)).toBe(fx.url(`/page/FrameButton${tag}-B`))
  })

  test(`[KS-16][NV-01] keyboard in a text field of a ${kind} frame that leaves ⌘[ / Alt+← alone: it goes back`, async () => {
    const { app } = orbit
    const { id, at, frame } = await framedTab(`FrameField${tag}`, crossOrigin)
    await clickInFrame(at, frame, '#box')
    await focusKnown(at, frame, 'field')
    await pressInPage(app, at, BACK_KEY, [...BACK_MODS])
    await expect.poll(() => urlOf(id)).toBe(fx.url(`/page/FrameField${tag}-B`))
  })
}

test('[KS-16][NV-01] a text field in a frame whose page uses ⌘[ / Alt+← keeps it; on the frame’s button the key goes back one page', async () => {
  const { app } = orbit
  const { id, at, frame } = await framedTab('FrameEditor', false)
  // An editor in the frame that outdents with the key while its field has focus.
  await inFrame(
    at,
    frame,
    `addEventListener('keydown', (e) => {
      if (document.activeElement?.id === 'box' && (e.code === 'BracketLeft' || e.code === 'ArrowLeft')) e.preventDefault()
    })`,
  )
  await clickInFrame(at, frame, '#box')
  await focusKnown(at, frame, 'field')
  await pressInPage(app, at, BACK_KEY, [...BACK_MODS])
  await expect.poll(() => inFrame<string[]>(at, frame, 'window.__keys')).toContain(isMac ? '[' : 'ArrowLeft')
  // On the frame's button the key goes back: one page. Had the first press gone back too, this
  // would land on A.
  await clickInFrame(at, frame, '#plain')
  await focusKnown(at, frame, 'page')
  await pressInPage(app, at, BACK_KEY, [...BACK_MODS])
  await expect.poll(() => urlOf(id)).toBe(fx.url('/page/FrameEditor-B'))
})

test('[KS-02][SB-11] keyboard in a frame: Toggle Sidebar, preferring websites, toggles on the first press when the frame leaves ⌘S / Ctrl+S alone; a frame that uses it gets it first', async () => {
  const { app } = orbit
  await sidebarPrefersWebsites()
  const { at, frame } = await framedTab('FrameSave', false)
  await clickInFrame(at, frame, '#box')
  await focusKnown(at, frame, 'field')
  await pressInPage(app, at, 'S', PRIMARY_MOD)
  await expect.poll(sidebarVisible).toBe(false)
  expect(await inFrame<string[]>(at, frame, 'window.__keys')).toContain('s')
  // A frame that saves with the key: the first press is the frame's, and the toast says so.
  await inFrame(at, frame, `addEventListener('keydown', (e) => { if (e.code === 'KeyS') e.preventDefault() })`)
  await pressInPage(app, at, 'S', PRIMARY_MOD)
  // The sidebar is hidden: the toast shows over the page (SB-13).
  const toast = (await viewPage(app, 'toasts')).getByTestId('toast').filter({ hasText: `The page used ${SAVE}` })
  await expect(toast).toHaveCount(1)
  expect(await sidebarVisible()).toBe(false)
  await pressInPage(app, at, 'S', PRIMARY_MOD)
  await expect.poll(sidebarVisible).toBe(true)
})

/**
 * Keeps the renderer of the page at `urlPart` busy for 1.5 s, presses a key there once it is, and
 * returns how long after the press Orbit `acted`: started a navigation, or toggled the sidebar.
 */
function busyPress(
  urlPart: string,
  key: string,
  mods: readonly Mod[],
  acted: 'navigation' | 'sidebar',
): Promise<number> {
  return orbit.app.evaluate(
    async ({ webContents }, [part, keyCode, modifiers, what]) => {
      const page = webContents.getAllWebContents().find((w) => w.getURL().includes(part))
      if (!page) throw new Error(`no page ${part}`)
      type Windows = Record<string, { sidebar: { visible: boolean } }>
      const hooks = (globalThis as unknown as { __orbit: { state: () => { windows: Windows } } }).__orbit
      const sidebar = () => Object.values(hooks.state().windows)[0]?.sidebar.visible
      // The page says it is busy just before it is.
      const busy = new Promise((resolve) => page.once('page-title-updated', resolve))
      void page.executeJavaScript(
        `document.title = 'Busy'; { const end = Date.now() + 1500; while (Date.now() < end); }`,
      )
      await busy
      const before = sidebar()
      const navigated = new Promise<void>((resolve) => page.once('did-start-navigation', () => resolve()))
      const start = performance.now()
      page.sendInputEvent({ type: 'keyDown', keyCode, modifiers: [...modifiers] })
      page.sendInputEvent({ type: 'keyUp', keyCode, modifiers: [...modifiers] })
      if (what === 'navigation') await navigated
      else while (sidebar() === before) await new Promise((r) => setTimeout(r, 2))
      return performance.now() - start
    },
    [urlPart, key, mods, acted] as const,
  )
}

test('[KS-16][NV-01] on a busy page, ⌘[ / Alt+← outside a text field goes back at once: Orbit does not wait for the page (D60)', async () => {
  const { app } = orbit
  const id = await openTab(app, fx.url('/page/BusyBackA'))
  await visit(app, id, fx.url('/page/BusyBackB'))
  await cmd(app, 'tabs.focusPage', {})
  await expect.poll(focusedUrl).toBe(fx.url('/page/BusyBackB'))
  await focusKnown('/page/BusyBackB', 'main', 'page')
  expect(await busyPress('/page/BusyBackB', BACK_KEY, BACK_MODS, 'navigation')).toBeLessThan(200)
  await expect.poll(() => urlOf(id)).toBe(fx.url('/page/BusyBackA'))
})

test('[KS-02][SB-11] on a busy page, a key that prefers websites waits at most 250 ms for the page, then Orbit acts (D60)', async () => {
  await sidebarPrefersWebsites()
  await pageWithKeys('BusySave', { code: 'KeyS', use: false })
  await focusKnown('/page/BusySave', 'main', 'page')
  expect(await busyPress('/page/BusySave', 'S', PRIMARY_MOD, 'sidebar')).toBeLessThan(600)
  expect(await sidebarVisible()).toBe(false)
})

// ---------- Tab, window, split and overlay keys (KS-05, KS-06, KS-09, KS-19) ----------

type Mod = 'shift' | 'control' | 'alt' | 'meta'

/** Key events, each sent to whatever has the keyboard at that moment, as the keyboard does. */
function keyEvents(events: [type: 'keyDown' | 'keyUp', keyCode: string, modifiers: Mod[]][]): Promise<void> {
  return orbit.app.evaluate(({ webContents }, list) => {
    for (const [type, keyCode, modifiers] of list) {
      webContents.getFocusedWebContents()?.sendInputEvent({ type, keyCode, modifiers })
    }
  }, events)
}

/** Selects a tab and gives its page the keyboard. */
async function selectPage(tabId: string, url: string): Promise<void> {
  await cmd(orbit.app, 'tabs.activate', { tabId })
  await cmd(orbit.app, 'tabs.focusPage', {})
  await expect.poll(focusedUrl).toBe(url)
}

/** The active tab of the first window. */
async function activeTab(): Promise<string | undefined> {
  const win = Object.values((await state(orbit.app)).windows)[0]
  return win?.activeTab[win.spaceId] ?? undefined
}

/** The tab the recent-tab switcher of the first window highlights, once its list shows (TB-05). */
async function highlighted(): Promise<string | undefined> {
  const list = switcherOf(Object.values((await state(orbit.app)).windows)[0]?.overlay)
  return list?.tabs[list.index]
}

test('[KS-05][PN-02][TB-07] from a page: ⌘D pins a Today tab and ⌘D again puts it back on top of Today; ⌘⇧T after ⌘W restores a closed tab in its place', async () => {
  const { app } = orbit
  const spaceId = await activeSpace(app)
  const today = async () => (await state(app)).spaces[spaceId]?.today ?? []
  const pinned = async () => (await state(app)).spaces[spaceId]?.pinned ?? []
  const c = await openTab(app, fx.url('/page/Third'))
  const b = await openTab(app, fx.url('/page/Second'))
  const a = await openTab(app, fx.url('/page/First'))
  expect(await today()).toEqual([a, b, c])
  await selectPage(b, fx.url('/page/Second'))
  await pressMod('D')
  await expect.poll(pinned).toEqual([b])
  expect(await today()).toEqual([a, c])
  await pressMod('D')
  await expect.poll(today).toEqual([b, a, c])
  expect(await pinned()).toEqual([])
  // The bottom tab closes and comes back where it was, selected.
  await selectPage(c, fx.url('/page/Third'))
  await pressMod('W')
  await expect.poll(today).toEqual([b, a])
  // The keyboard is somewhere else now (the next selected tab).
  await expect
    .poll(async () => {
      const url = await focusedUrl()
      return !!url && url !== fx.url('/page/Third')
    })
    .toBe(true)
  await pressMod('T', true)
  await expect.poll(async () => (await today()).length).toBe(3)
  const back = (await today())[2] as string
  expect((await state(app)).tabs[back]?.url).toBe(fx.url('/page/Third'))
  await expect.poll(activeTab).toBe(back)
})

test('[KS-06][TB-04][FV-10] from a page, with 2 Favorites, 1 pinned and 2 Today tabs: ⌘3 is the pinned tab, ⌘9 the last Today tab, ⌘⌥↓ goes on to the first Today tab, the ⌘⇧] / Ctrl+PgDn aliases step too, and ⌘9 can be the ninth item', async () => {
  const { app } = orbit
  const spaceId = await activeSpace(app)
  const favorites = { kind: 'favorites', profileId: 'p-default' }
  await cmd(app, 'tabs.create', { url: fx.url('/page/Fav1'), container: favorites, activate: false })
  await cmd(app, 'tabs.create', { url: fx.url('/page/Fav2'), container: favorites, activate: false })
  const pin = await cmd<string>(app, 'tabs.create', {
    url: fx.url('/page/Pin'),
    container: { kind: 'pinned', spaceId },
    activate: false,
  })
  const last = await openTab(app, fx.url('/page/TodayLast'))
  const first = await openTab(app, fx.url('/page/TodayFirst'))
  await selectPage(first, fx.url('/page/TodayFirst'))
  const mod: Mod = isMac ? 'meta' : 'control'
  await pressMod('3')
  await expect.poll(activeTab).toBe(pin)
  await pressMod('9')
  await expect.poll(activeTab).toBe(last)
  await selectPage(pin, fx.url('/page/Pin'))
  await pressAnywhere('Down', [mod, 'alt'])
  await expect.poll(activeTab).toBe(first)
  await expect.poll(focusedUrl).toBe(fx.url('/page/TodayFirst'))
  if (isMac) await pressAnywhere(']', ['meta', 'shift'])
  else await pressAnywhere('PageDown', ['control'])
  await expect.poll(activeTab).toBe(last)
  await expect.poll(focusedUrl).toBe(fx.url('/page/TodayLast'))
  if (isMac) await pressAnywhere('[', ['meta', 'shift'])
  else await pressAnywhere('PageUp', ['control'])
  await expect.poll(activeTab).toBe(first)
  // With eleven items, ⌘9 is the last one, or the ninth when set so (Settings → Shortcuts).
  const more: string[] = []
  for (let n = 1; n <= 6; n++) {
    more.push(await cmd<string>(app, 'tabs.create', { url: fx.url(`/page/More${n}`), activate: false }))
  }
  await expect.poll(focusedUrl).toBe(fx.url('/page/TodayFirst'))
  await pressMod('9')
  await expect.poll(activeTab).toBe(last)
  await cmd(app, 'keys.setOptions', { lastTabOnCmd9: false })
  await expect.poll(focusedUrl).toBe(fx.url('/page/TodayLast'))
  await pressMod('9')
  // Favorites 1–2, pinned 3, then Today from the top: More6 … More1, TodayFirst, TodayLast.
  await expect.poll(activeTab).toBe(more[0])
})

test('[KS-06][TB-05] holding ⌃: Tab and ⇧Tab step through recent tabs, W closes the highlighted one and switching goes on from the next, and letting go settles', async () => {
  const { app } = orbit
  const a = await openTab(app, fx.url('/page/RecentA'))
  const b = await openTab(app, fx.url('/page/RecentB'))
  const c = await openTab(app, fx.url('/page/RecentC'))
  const d = await openTab(app, fx.url('/page/RecentD'))
  // Most recent first: D, A, C, B. The sidebar shows D, C, B, A.
  await selectPage(a, fx.url('/page/RecentA'))
  await selectPage(d, fx.url('/page/RecentD'))
  const ctrl: Mod[] = ['control']
  const tab = (mods: Mod[]): [type: 'keyDown' | 'keyUp', keyCode: string, modifiers: Mod[]][] => [
    ['keyDown', 'Tab', mods],
    ['keyUp', 'Tab', mods],
  ]
  // Held, the list shows with A highlighted; the page stays D's until Control is let go.
  await keyEvents([['keyDown', 'Control', ctrl], ...tab(ctrl)])
  await expect.poll(highlighted).toBe(a)
  await keyEvents(tab(ctrl))
  await expect.poll(highlighted).toBe(c)
  await keyEvents([['keyDown', 'Shift', ['control', 'shift']], ...tab(['control', 'shift']), ['keyUp', 'Shift', ctrl]])
  await expect.poll(highlighted).toBe(a)
  // W closes A; C, next in the switcher, is highlighted in its place.
  await keyEvents([
    ['keyDown', 'W', ctrl],
    ['keyUp', 'W', ctrl],
  ])
  await expect.poll(async () => (await state(app)).tabs[a]).toBeUndefined()
  await expect.poll(highlighted).toBe(c)
  await keyEvents(tab(ctrl))
  await expect.poll(highlighted).toBe(b)
  expect(await activeTab()).toBe(d)
  await keyEvents([['keyUp', 'Control', []]])
  await expect.poll(activeTab).toBe(b)
  // Settled on B: a quick ⌃Tab goes back to D, the tab used before it.
  await keyEvents([['keyDown', 'Control', ctrl], ...tab(ctrl), ['keyUp', 'Control', []]])
  await expect.poll(activeTab).toBe(d)
  expect(Object.keys((await state(app)).tabs).sort()).toEqual([b, c, d].sort())
})

test('[KS-06][TB-05] ⌃` steps back in the recent-tab switcher on every platform, and only while it is up (D60)', async () => {
  const a = await openTab(orbit.app, fx.url('/page/TickA'))
  const b = await openTab(orbit.app, fx.url('/page/TickB'))
  const c = await openTab(orbit.app, fx.url('/page/TickC'))
  // Most recent first: C, B, A.
  await selectPage(a, fx.url('/page/TickA'))
  await selectPage(b, fx.url('/page/TickB'))
  await selectPage(c, fx.url('/page/TickC'))
  const ctrl: Mod[] = ['control']
  const tick: [type: 'keyDown' | 'keyUp', keyCode: string, modifiers: Mod[]][] = [
    ['keyDown', '`', ctrl],
    ['keyUp', '`', ctrl],
  ]
  // With no switcher up, the key is the page's.
  const page = await tabPage(orbit.app, '/page/TickC')
  await keyEvents(tick)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __keys: string[] }).__keys)).toContain('`')
  expect(await activeTab()).toBe(c)
  // ⌃Tab ⌃Tab highlights A; ⌃` steps back to B, and letting go settles there.
  await keyEvents([
    ['keyDown', 'Control', ctrl],
    ['keyDown', 'Tab', ctrl],
    ['keyUp', 'Tab', ctrl],
    ['keyDown', 'Tab', ctrl],
    ['keyUp', 'Tab', ctrl],
  ])
  await expect.poll(highlighted).toBe(a)
  await keyEvents(tick)
  await expect.poll(highlighted).toBe(b)
  expect(await activeTab()).toBe(c)
  await keyEvents([['keyUp', 'Control', []]])
  await expect.poll(focusedUrl).toBe(fx.url('/page/TickB'))
  expect(await activeTab()).toBe(b)
})

test('[KS-09][SV-02][SV-16] from a page: ⌃⇧= then Enter on a result shows two panes, ⌃⇧1 focuses the left pane, ⌃⇧] and ⌃⇧[ step, and ⌃⇧− closes the focused pane', async () => {
  const { app, shell } = orbit
  const left = await openTab(app, fx.url('/page/LeftPane'))
  await selectPage(left, fx.url('/page/LeftPane'))
  const split: Mod[] = ['control', 'shift']
  await pressAnywhere('=', split)
  const input = (await viewPage(app, 'overlay')).getByTestId('command-input')
  await expect(input).toBeFocused()
  await input.fill(fx.url('/page/RightPane'))
  await input.press('Enter')
  await expect(shell.getByTestId('split-row').getByTestId('split-segment')).toHaveCount(2)
  const right = (await activeTab()) as string
  expect(right).not.toBe(left)
  await expect.poll(focusedUrl).toBe(fx.url('/page/RightPane'))
  await pressAnywhere('1', split)
  await expect.poll(activeTab).toBe(left)
  await expect.poll(focusedUrl).toBe(fx.url('/page/LeftPane'))
  await pressAnywhere(']', split)
  await expect.poll(activeTab).toBe(right)
  await expect.poll(focusedUrl).toBe(fx.url('/page/RightPane'))
  await pressAnywhere('[', split)
  await expect.poll(activeTab).toBe(left)
  await expect.poll(focusedUrl).toBe(fx.url('/page/LeftPane'))
  await pressAnywhere('-', split)
  await expect.poll(async () => (await state(app)).tabs[left]).toBeUndefined()
  await expect.poll(activeTab).toBe(right)
})

test('[KS-19][PK-09][NV-04] with a Peek open, Esc closes the Peek and the tab under it keeps loading', async () => {
  const { app } = orbit
  const id = await openTab(app, fx.url('/page/Under'))
  await slowLoad(id, '/slow/UnderNext')
  await cmd(app, 'peek.open', { url: fx.url('/page/Peeked') })
  await expect.poll(focusedUrl).toBe(fx.url('/page/Peeked'))
  await pressAnywhere('Escape')
  await expect.poll(async () => Object.values((await state(app)).windows)[0]?.overlay.kind).toBe('none')
  expect((await state(app)).tabs[id]?.loading).toBe(true)
  await finishLoad(id, '/slow/UnderNext')
})

/** Esc pressed on pages that were loading, as main saw it: whether the page used it, and whether the load stopped. */
function escapes(): Promise<{ url: string; used: boolean; stopped: boolean }[]> {
  return orbit.app.evaluate(() => (globalThis as unknown as KeysHooks).__orbitKeys.escapes())
}

/** A tab with the keyboard whose page has run its scripts and is still loading: it waits for an image from `/slow/<title>`. */
async function stillLoading(title: string): Promise<{ id: string; path: string; image: string }> {
  const { app } = orbit
  const image = `/slow/${title}Image`
  const path = `/page/${title}?wait=${encodeURIComponent(image)}`
  const id = await cmd<string>(app, 'tabs.create', { url: fx.url(path) })
  await expect.poll(() => fx.hits(image)).toBe(1)
  await cmd(app, 'tabs.focusPage', {})
  await expect.poll(focusedUrl).toBe(fx.url(path))
  expect((await state(app)).tabs[id]?.loading).toBe(true)
  return { id, path, image }
}

test('[KS-19][NV-04] Esc on a loading page that uses Esc itself goes to the page, and the load goes on (D59)', async () => {
  const { app } = orbit
  const { id, path, image } = await stillLoading('EscUsed')
  const page = await tabPage(app, `/page/EscUsed`)
  await page.evaluate(() => {
    const w = window as unknown as { escapes: number }
    w.escapes = 0
    addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      w.escapes++
      e.preventDefault()
    })
  })
  await pressInPage(app, path, 'Escape')
  await expect.poll(escapes).toEqual([{ url: fx.url(path), used: true, stopped: false }])
  expect(await page.evaluate(() => (window as unknown as { escapes: number }).escapes)).toBe(1)
  expect((await state(app)).tabs[id]?.loading).toBe(true)
  fx.release(image)
  await expect.poll(async () => (await state(app)).tabs[id]?.loading).toBe(false)
})

test('[KS-19][NV-04] Esc on a loading page that leaves Esc alone stops the load (D59)', async () => {
  const { app } = orbit
  const { id, path } = await stillLoading('EscLeft')
  await pressInPage(app, path, 'Escape')
  await expect.poll(async () => (await state(app)).tabs[id]?.loading).toBe(false)
  expect(await escapes()).toEqual([{ url: fx.url(path), used: false, stopped: true }])
})

test('[KS-19][NV-04] what a page tells main about Esc counts only for an Esc pressed there: one sent without a press does nothing (D59)', async () => {
  const { app } = orbit
  const { id, path } = await stillLoading('EscStray')
  // Sent as the page's preload sends it, from the tab's main frame, with no Esc pressed.
  await app.evaluate(({ ipcMain, webContents }, part) => {
    const page = webContents.getAllWebContents().find((w) => w.getURL().includes(part))
    if (!page) throw new Error('no page')
    ipcMain.emit('orbit-page:escape', { sender: page, senderFrame: page.mainFrame }, true)
  }, path)
  expect(await escapes()).toEqual([])
  expect((await state(app)).tabs[id]?.loading).toBe(true)
  // The next Esc, left alone by the page, stops the load: the bit sent before it didn't count for it.
  await pressInPage(app, path, 'Escape')
  await expect.poll(async () => (await state(app)).tabs[id]?.loading).toBe(false)
  expect(await escapes()).toEqual([{ url: fx.url(path), used: false, stopped: true }])
})

test('[KS-05][TB-12][TB-11] Rename Tab, Move Tab to Space… and Archive Tab have no keys until given some, then work from a page', async () => {
  const { app, shell } = orbit
  const spaceId = await activeSpace(app)
  await createSpace(app, { name: 'Other', activate: false })
  for (const [actionId, accel] of [
    ['tab.rename', 'F2'],
    ['tab.pickSpace', 'F7'],
    ['tab.archive', 'F8'],
  ]) {
    expect(await run(app, 'keys.bind', { actionId, accel })).toEqual({ ok: true })
  }
  const id = await cmd<string>(app, 'tabs.create', {
    url: fx.url('/page/Named'),
    container: { kind: 'pinned', spaceId },
  })
  await expect.poll(async () => (await state(app)).tabs[id]?.loading).toBe(false)
  await selectPage(id, fx.url('/page/Named'))
  // Renaming shows a hidden sidebar: the name is edited in the tab's row.
  await action(app, 'sidebar.toggle')
  await expect.poll(sidebarVisible).toBe(false)
  await pressAnywhere('F2')
  await expect.poll(sidebarVisible).toBe(true)
  const field = shell.getByTestId('rename-field')
  await expect(field).toBeFocused()
  await field.fill('Mine')
  await field.press('Enter')
  await expect(shell.locator(`[data-testid="tab-row"][data-tab-id="${id}"]`).getByTestId('tab-title')).toHaveText(
    'Mine',
  )
  await selectPage(id, fx.url('/page/Named'))
  await pressAnywhere('F7')
  const overlay = await viewPage(app, 'overlay')
  await expect(overlay.getByTestId('command-input')).toHaveValue('Move to ')
  await expect(overlay.getByTestId('command-result').first().getByTestId('command-result-title')).toHaveText(
    'Move to Other',
  )
  await overlay.getByTestId('command-input').press('Escape')
  await selectPage(id, fx.url('/page/Named'))
  await pressAnywhere('F8')
  await expect.poll(async () => (await state(app)).spaces[spaceId]?.pinned).toEqual([])
  expect((await state(app)).archive.at(-1)?.url).toBe(fx.url('/page/Named'))
})

// ---------- Pointer bindings (KS-17): the rows no other test covered ----------

test('[KS-17][NV-01][SB-03] ⌘-click or middle-click on Forward opens the next page in a new tab; the tab stays', async () => {
  const { app, shell } = orbit
  const id = await openTab(app, fx.url('/page/AheadA'))
  await visit(app, id, fx.url('/page/AheadB'))
  await action(app, 'nav.back')
  await waitLoaded(app, id, fx.url('/page/AheadA'))
  await expect.poll(async () => (await state(app)).tabs[id]?.canGoForward).toBe(true)
  const others = async () => Object.keys((await state(app)).tabs).filter((t) => t !== id)
  const forward = shell.getByTestId('nav-forward')
  await forward.click({ modifiers: [NEW_TAB_CLICK] })
  await expect.poll(async () => (await others()).length).toBe(1)
  const [first] = await others()
  await waitLoaded(app, first as string, fx.url('/page/AheadB'))
  await forward.click({ button: 'middle' })
  await expect.poll(async () => (await others()).length).toBe(2)
  const second = (await others()).find((t) => t !== first)
  await waitLoaded(app, second as string, fx.url('/page/AheadB'))
  // The tab clicked from keeps its page and stays selected.
  expect(await activeTab()).toBe(id)
  expect(await urlOf(id)).toBe(fx.url('/page/AheadA'))
})

test('[KS-17][SB-08][CB-02] double-clicking the empty part of the sidebar opens the command bar for a new tab', async () => {
  const { app, shell } = orbit
  await shell.getByTestId('sidebar-empty-area').dblclick()
  await expect.poll(async () => (await windowState(app)).overlay).toMatchObject({ kind: 'commandbar', mode: 'new-tab' })
  await expect((await viewPage(app, 'overlay')).getByTestId('command-input')).toBeFocused()
})

// ---------- Settings → Shortcuts (ST-08) ----------

/**
 * A key press in the Settings window as the keyboard sends it there, through Orbit's key router
 * (which records it while Settings → Shortcuts listens for a new binding).
 */
function pressInSettings(keyCode: string, modifiers: Mod[] = []): Promise<void> {
  return orbit.app.evaluate(
    ({ webContents }, [code, mods]) => {
      const contents = webContents.getAllWebContents().find((c) => c.getURL().includes('view=settings'))
      if (!contents) throw new Error('no Settings window')
      contents.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers: mods })
      contents.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers: mods })
    },
    [keyCode, modifiers] as const,
  )
}

const PRIMARY_MOD: Mod[] = [isMac ? 'meta' : 'control']
const shortcutRow = (page: Page, actionId: string) => page.getByTestId(`setting-shortcut-${actionId}`)
const keysOf = async () => (await state(orbit.app)).settings.shortcuts
const prioritiesOf = async () => (await state(orbit.app)).settings.shortcutPriority

test('[ST-08][KS-01][KS-12] Shortcut Settings opens the list; search finds an action, and clicking its key then pressing new keys remaps it everywhere', async () => {
  const { app, shell } = orbit
  await action(app, 'settings.shortcuts')
  const page = await pageOfView(app, 'settings')
  await expect(page.getByTestId('settings-tab-shortcuts')).toHaveAttribute('aria-selected', 'true')
  await page.getByTestId('shortcuts-search').fill('sidebar tog')
  const row = shortcutRow(page, 'sidebar.toggle')
  await expect(row).toBeVisible()
  await expect(shortcutRow(page, 'tab.new')).toHaveCount(0)
  const keys = row.getByTestId('shortcut-binding')
  await expect(keys).toHaveText([isMac ? '⌘S' : 'Ctrl+S'])
  await keys.first().click()
  await expect(keys.first()).toHaveText('Type shortcut')
  await pressInSettings('B', [...PRIMARY_MOD, 'shift'])
  await expect(keys).toHaveText([SHIFT_B])
  expect(await keysOf()).toEqual({ 'sidebar.toggle': [`${PRIMARY}+Shift+B`] })
  await expect(shell.getByTestId('toggle-sidebar')).toHaveAttribute('title', `Hide sidebar (${SHIFT_B})`)
  await onlyShiftBToggles()

  // Another binding: a key without a modifier is refused and Settings keeps listening; F-keys may stand alone.
  await row.getByTestId('shortcut-add').click()
  await pressInSettings('B')
  await expect(row.getByTestId('shortcut-problem')).toContainText('A shortcut starts with')
  await pressInSettings('F7')
  await expect(keys).toHaveText([SHIFT_B, 'F7'])
  // Esc leaves a binding as it was; ⌫ removes it.
  await keys.nth(1).click()
  await pressInSettings('Escape')
  await expect(keys).toHaveText([SHIFT_B, 'F7'])
  await keys.nth(1).click()
  await pressInSettings('Backspace')
  await expect(keys).toHaveText([SHIFT_B])
  expect(await keysOf()).toEqual({ 'sidebar.toggle': [`${PRIMARY}+Shift+B`] })
})

test('[ST-08][KS-01] keys another action has: Settings warns and offers Swap or Remove, and while it listens the keys run nothing', async () => {
  const { app } = orbit
  const page = await openSettings(app, { section: 'shortcuts' })
  const sidebar = shortcutRow(page, 'sidebar.toggle')
  const dialog = page.getByTestId('shortcut-conflict')
  // Close Tab's keys would close the Settings window: here they only ask.
  await sidebar.getByTestId('shortcut-binding').click()
  await pressInSettings('W', PRIMARY_MOD)
  await expect(dialog).toContainText('is used by “Close Tab”')
  expect(await osWindows(app, 'settings')).toHaveLength(1)
  await dialog.getByTestId('shortcut-conflict-cancel').click()
  await expect(dialog).toHaveCount(0)
  expect(await keysOf()).toBeUndefined()

  // Swap: Toggle Sidebar takes New Tab's keys and New Tab gets Toggle Sidebar's.
  await sidebar.getByTestId('shortcut-binding').click()
  await pressInSettings('T', PRIMARY_MOD)
  await dialog.getByTestId('shortcut-conflict-swap').click()
  await expect.poll(keysOf).toEqual({ 'sidebar.toggle': [`${PRIMARY}+T`], 'tab.new': [`${PRIMARY}+S`] })
  await expect(shortcutRow(page, 'tab.new').getByTestId('shortcut-binding')).toHaveText([isMac ? '⌘S' : 'Ctrl+S'])

  // Remove: Duplicate Tab, which has no keys, takes New Window's, which is left with none.
  await shortcutRow(page, 'tab.duplicate').getByTestId('shortcut-record').click()
  await pressInSettings('N', PRIMARY_MOD)
  await expect(dialog.getByTestId('shortcut-conflict-swap')).toHaveCount(0)
  await dialog.getByTestId('shortcut-conflict-clear').click()
  await expect.poll(keysOf).toMatchObject({ 'tab.duplicate': [`${PRIMARY}+N`], 'window.new': [] })
  await expect(shortcutRow(page, 'window.new').getByTestId('shortcut-record')).toBeVisible()
})

test('[ST-08][KS-02][TB-04] right-click an action to prefer websites or Orbit and to reset it; Reset All asks first; the Go to Tab options', async () => {
  const { app } = orbit
  expect(await run(app, 'keys.bind', { actionId: 'sidebar.toggle', accel: 'F7' })).toEqual({ ok: true })
  const page = await openSettings(app, { section: 'shortcuts' })
  const row = shortcutRow(page, 'sidebar.toggle')
  const menu = page.getByTestId('shortcut-menu')
  // Toggle Sidebar prefers websites on Windows and Linux, Orbit on macOS (D60).
  const [byDefault, other] = isMac ? (['orbit', 'websites'] as const) : (['websites', 'orbit'] as const)
  const websitesFirst = (on: boolean) =>
    on ? expect(row).toContainText('Websites first') : expect(row).not.toContainText('Websites first')
  await websitesFirst(byDefault === 'websites')
  await row.click({ button: 'right' })
  await expect(menu.getByTestId(`shortcut-menu-${byDefault}`)).toHaveAttribute('aria-checked', 'true')
  await menu.getByTestId(`shortcut-menu-${other}`).click()
  await expect.poll(prioritiesOf).toEqual({ 'sidebar.toggle': other })
  await websitesFirst(other === 'websites')
  await row.click({ button: 'right' })
  await menu.getByTestId('shortcut-menu-reset').click()
  await expect.poll(keysOf).toBeUndefined()
  expect(await prioritiesOf()).toBeUndefined()
  await expect(row.getByTestId('shortcut-binding')).toHaveText([isMac ? '⌘S' : 'Ctrl+S'])
  await websitesFirst(byDefault === 'websites')
  // At its defaults there is nothing to reset; Esc closes the menu.
  await row.click({ button: 'right' })
  await expect(menu.getByTestId('shortcut-menu-reset')).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  await run(app, 'keys.bind', { actionId: 'tab.duplicate', accel: 'F7' })
  await run(app, 'keys.setPriority', { actionId: 'tab.new', priority: 'websites' })
  await page.getByTestId('shortcuts-reset-all').click()
  await page.getByTestId('shortcuts-reset-all-confirm').click()
  await expect.poll(keysOf).toBeUndefined()
  expect(await prioritiesOf()).toBeUndefined()
  await expect(page.getByTestId('shortcuts-reset-all')).toBeDisabled()

  // Go to Tab: Favorites counted first or not, and the last item or the ninth for ⌘9.
  await page.getByTestId('shortcut-count-favorites').click()
  await expect.poll(async () => (await state(app)).settings.countFavoritesInShortcuts).toBe(false)
  await page.getByTestId('shortcut-last-tab').selectOption('ninth')
  await expect.poll(async () => (await state(app)).settings.lastTabOnCmd9).toBe(false)
  await expect(shortcutRow(page, 'tab.goto.9')).toContainText('Go to Tab 9')
})

test('[ST-08][KS-03][ST-02] keys the system keeps are marked until the action gets others; Settings search finds shortcuts by name', async () => {
  const { app } = orbit
  // The Space 1 keys, as macOS's Mission Control or a Linux desktop may keep them.
  const accel = isMac ? 'Ctrl+1' : 'Alt+1'
  await app.evaluate(
    (_electron, list) =>
      (
        globalThis as unknown as { __orbitKeys: { setSystemClashes: (l: unknown) => void } }
      ).__orbitKeys.setSystemClashes(list),
    [{ accel, owner: 'Switch to Desktop 1' }],
  )
  const page = await openSettings(app, { section: 'shortcuts' })
  const row = shortcutRow(page, 'space.goto.1')
  await expect(page.getByTestId('shortcuts-system-notice')).toBeVisible()
  await expect(row.getByTestId('shortcut-clash')).toContainText('your system uses it for Switch to Desktop 1')
  await row.getByTestId('shortcut-binding').click()
  await pressInSettings('F9')
  await expect(row.getByTestId('shortcut-binding')).toHaveText(['F9'])
  await expect(row.getByTestId('shortcut-clash')).toHaveCount(0)
  await expect(page.getByTestId('shortcuts-system-notice')).toHaveCount(0)

  await page.getByTestId('settings-search').fill('switch to space 1')
  const results = page.getByTestId('settings-results')
  await expect(results.getByTestId('setting-shortcut-space.goto.1')).toBeVisible()
  await expect(results.getByTestId('setting-shortcut-space.goto.2')).toBeHidden()
  await expect(results.getByTestId('shortcuts-search')).toBeHidden()
})

// ---------- Shortcut hints in right-click menus (KS-18) ----------

/** The keys the right-click menu built last showed, as "Label=Accelerator". */
const menuHints = () =>
  orbit.app.evaluate(() =>
    (globalThis as unknown as { __orbitKeys: { lastMenuHints: () => string[] } }).__orbitKeys.lastMenuHints(),
  )

/** A binding as a menu writes it. */
const menuKey = (key: string) => `${isMac ? 'Command' : 'Control'}+${key}`

test('[KS-18] remap Pin to ⌘⇧P: the command bar’s row and the tab’s right-click menu show it; the page menu shows the keys it has as it opens', async () => {
  const { app } = orbit
  const pin = `${PRIMARY}+Shift+P`
  expect(await run(app, 'keys.bind', { actionId: 'tab.togglePin', accel: pin, replace: `${PRIMARY}+D` })).toEqual({
    ok: true,
  })
  const id = await openTab(app, fx.url('/page/Hints'))
  const { overlay, top } = await actionRow('pin tab', 'Pin / Unpin Tab')
  await expect(top.getByTestId('command-shortcut')).toHaveText(isMac ? '⇧⌘P' : 'Ctrl+Shift+P')
  await overlay.keyboard.press('Escape')
  await cmd(app, 'tabs.contextMenu', { id })
  expect(await menuHints()).toEqual(
    expect.arrayContaining([`Pin Tab=${menuKey('Shift+P')}`, `Close Tab=${menuKey('W')}`]),
  )
  // The row menu is Orbit's own, in the overlay (TB-14): it draws the key as the keymap has it.
  const pinHint = overlay.locator('[data-testid="row-menu-item"][data-label="Pin Tab"] .row-menu__hint')
  await expect(pinHint).toHaveText(isMac ? '⇧⌘P' : 'Ctrl+Shift+P')
  await overlay.keyboard.press('Escape')
  await expect(overlay.getByTestId('row-menu')).toHaveCount(0)

  // The page's own menu: Reload shows its keys, and another key once remapped.
  const page = await tabPage(app, '/page/Hints')
  await page.mouse.click(12, 12, { button: 'right' })
  await expect.poll(menuHints).toContain(`Reload=${menuKey('R')}`)
  expect(await run(app, 'keys.bind', { actionId: 'nav.reload', accel: 'F9', replace: `${PRIMARY}+R` })).toEqual({
    ok: true,
  })
  await page.mouse.click(12, 12, { button: 'right' })
  await expect.poll(menuHints).toContain('Reload=F9')
})

// ---------- Help → Keyboard Shortcuts (OB-12) ----------

test('[OB-12][KS-18][KS-12] Help → Keyboard Shortcuts shows the essential keys as they are now; Esc or Close Tab’s keys close it; its link opens Settings → Shortcuts', async () => {
  const { app } = orbit
  expect(await run(app, 'keys.bind', { actionId: 'sidebar.toggle', accel: `${PRIMARY}+Shift+B` })).toEqual({ ok: true })
  await run(app, 'keys.unbind', { actionId: 'sidebar.toggle', accel: `${PRIMARY}+S` })
  const tab = await openTab(app, fx.url('/page/Sheet'))
  if (isMac) {
    const help = await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()
        ?.items.find((i) => i.role === 'help')
        ?.submenu?.items.map((i) => i.label),
    )
    expect(help).toContain('Keyboard Shortcuts')
  }
  await action(app, 'help.shortcuts')
  const overlay = await viewPage(app, 'overlay')
  const sheet = overlay.getByTestId('shortcut-sheet')
  await expect(sheet.getByTestId('shortcut-sheet-group').locator('h3')).toHaveText([
    'Everyday',
    'Navigation',
    'Spaces',
    'Split View',
  ])
  const row = (title: string) => sheet.getByTestId('shortcut-sheet-row').filter({ hasText: title })
  await expect(row('Toggle Sidebar').getByTestId('shortcut-sheet-keys')).toHaveText(SHIFT_B)
  await expect(row('Go to Tab 1–8')).toContainText(isMac ? '⌘1–⌘8' : 'Ctrl+1–Ctrl+8')
  await expect(sheet).toBeFocused()
  await pressAnywhere('Escape')
  await expect(sheet).toHaveCount(0)
  await expect.poll(async () => Object.values((await state(app)).windows)[0]?.overlay.kind).toBe('none')

  // From the command bar too; Close Tab's keys close the sheet, and the tab under it stays.
  const { top } = await actionRow('keyboard shortcuts', 'Keyboard Shortcuts')
  await top.click()
  await expect(sheet).toBeVisible()
  await pressAnywhere('W', PRIMARY_MOD)
  await expect(sheet).toHaveCount(0)
  expect((await state(app)).tabs[tab]).toBeDefined()

  // The link at the bottom: the full, editable list.
  await action(app, 'help.shortcuts')
  await sheet.getByTestId('shortcut-sheet-settings').click()
  const settings = await pageOfView(app, 'settings')
  await expect(settings.getByTestId('settings-tab-shortcuts')).toHaveAttribute('aria-selected', 'true')
  await expect.poll(async () => Object.values((await state(app)).windows)[0]?.overlay.kind).toBe('none')
})

// ---------- Keys in special windows (KS-20) ----------

type ActionHook = { __orbit: { action: (id: string, windowId?: string) => Promise<void> } }

/** Runs an action as if from this window (its menu, its command bar). */
function actionIn(windowId: string, id: string): Promise<void> {
  return orbit.app.evaluate(async (_e, [w, a]) => (globalThis as unknown as ActionHook).__orbit.action(a, w), [
    windowId,
    id,
  ] as const)
}

/** Counts the hints main shows from now on, by message. */
async function countHints(): Promise<() => Promise<Record<string, number>>> {
  await orbit.app.evaluate(() => {
    const g = globalThis as unknown as {
      __orbit: { ctx: { toast: (w: string | undefined, m: string) => void } }
      __hints?: Record<string, number>
    }
    const seen: Record<string, number> = {}
    g.__hints = seen
    const show = g.__orbit.ctx.toast.bind(g.__orbit.ctx)
    g.__orbit.ctx.toast = (w, m) => {
      seen[m] = (seen[m] ?? 0) + 1
      show(w, m)
    }
  })
  return () => orbit.app.evaluate(() => ({ ...(globalThis as unknown as { __hints: Record<string, number> }).__hints }))
}

test('[KS-20][SB-25] in a private window the keys for pinning, Spaces and Clear do nothing and say so; tab keys still work', async () => {
  const { app, shell } = orbit
  await createSpace(app, { name: 'Other', activate: false })
  await openTab(app, fx.url('/page/Normal'))
  await shell.keyboard.press(`${MOD}+Shift+N`)
  await expect.poll(async () => (await windowList(app)).map((w) => w.kind)).toEqual(['main', 'private'])
  const [main, priv] = await windowList(app)
  if (!main || !priv) throw new Error('no private window')
  await cmdIn(app, priv.id, 'overlay.close')
  const first = await cmdIn<string>(app, priv.id, 'tabs.create', { url: fx.url('/page/PrivOne') })
  const second = await cmdIn<string>(app, priv.id, 'tabs.create', { url: fx.url('/page/PrivTwo') })
  await expect.poll(() => fx.hits('/page/PrivTwo')).toBe(1)
  await expect.poll(async () => (await state(app)).tabs[second]?.loading).toBe(false)
  const where = async () => {
    const s = await state(app)
    const space = s.spaces[priv.spaceId]
    return {
      privateSpace: s.windows[priv.id]?.spaceId,
      mainSpace: s.windows[main.id]?.spaceId,
      pinned: space?.pinned.length,
      today: space?.today.length,
      spaces: s.spaceOrder.length,
    }
  }
  const before = await where()
  expect(before).toMatchObject({ privateSpace: priv.spaceId, mainSpace: main.spaceId, pinned: 0, today: 2 })
  const hints = await countHints()
  const HINT = 'Not available in a private window'
  const keys: [name: string, key: string, mods: Mod[]][] = [
    ['Pin', 'D', PRIMARY_MOD],
    ['Space 2', '2', isMac ? ['control'] : ['alt']],
    ['Next Space', 'Right', isMac ? ['meta', 'alt'] : ['control', 'alt']],
    ['Clear Today', 'K', [...PRIMARY_MOD, 'shift']],
  ]
  for (const [i, [name, key, mods]] of keys.entries()) {
    await pressInPage(app, '/page/PrivTwo', key, mods)
    await expect.poll(async () => (await hints())[HINT], name).toBe(i + 1)
    expect(await where(), name).toEqual(before)
  }
  // The hint shows in the private window.
  const sidebar = await uiPageOf(app, 'shell', priv.id)
  await expect(sidebar.getByTestId('toast').filter({ hasText: HINT }).first()).toBeVisible()
  // The same from its menus and command bar, the Archive's included.
  await actionIn(priv.id, 'space.new')
  await expect.poll(async () => (await hints())[HINT]).toBe(keys.length + 1)
  await actionIn(priv.id, 'app.archive')
  await expect.poll(async () => (await hints())[HINT]).toBe(keys.length + 2)
  expect(await where()).toEqual(before)
  // Its sidebar has no Clear button next to Today: nothing there archives its tabs.
  await expect(sidebar.getByTestId('today-divider')).toBeVisible()
  await expect(sidebar.getByTestId('new-tab-button')).toBeVisible()
  await expect(sidebar.getByTestId('clear-today')).toHaveCount(0)
  // Keys for its own tabs work: ⌘2 selects the second, the one opened first.
  expect((await state(app)).spaces[priv.spaceId]?.today).toEqual([second, first])
  await pressInPage(app, '/page/PrivTwo', '2', PRIMARY_MOD)
  await expect.poll(async () => (await state(app)).windows[priv.id]?.activeTab[priv.spaceId]).toBe(first)
})

test('[KS-20][KS-10][OB-12] in a Mini Window keys act on its page: ⌘L edits its address, ⌘R and zoom work, sidebar and Space keys do nothing, ⌘⌥O offers the Spaces and ⌘W closes it', async () => {
  const { app } = orbit
  await createSpace(app, { name: 'Elsewhere', activate: false })
  const main = Object.values((await state(app)).windows)[0]
  if (!main) throw new Error('no window')
  const path = '/page/InMini'
  await app.evaluate(({ app: a }, u) => a.emit('open-url', { preventDefault() {} }, u), fx.url(path))
  const miniOf = async () => Object.values((await state(app)).windows).find((w) => w.kind === 'mini')
  await expect.poll(async () => (await miniOf())?.id).toBeTruthy()
  const mini = (await miniOf()) as NonNullable<Awaited<ReturnType<typeof miniOf>>>
  await expect.poll(() => fx.hits(path)).toBe(1)
  await expect.poll(async () => (await state(app)).tabs[mini.activeTab[mini.spaceId] ?? '']?.loading).toBe(false)
  // Native menus are recorded rather than shown.
  await app.evaluate(({ Menu }) => {
    const g = globalThis as unknown as { __popups: string[][] }
    g.__popups = []
    Menu.prototype.popup = function (this: Electron.Menu) {
      g.__popups.push(this.items.map((i) => i.label))
    }
  })
  const popups = () => app.evaluate(() => (globalThis as unknown as { __popups: string[][] }).__popups)

  // Sidebar and Space keys do nothing; the zoom after them shows they were taken in order.
  await pressInPage(app, path, 'S', PRIMARY_MOD)
  await pressInPage(app, path, '2', isMac ? ['control'] : ['alt'])
  await pressInPage(app, path, '=', PRIMARY_MOD)
  await expect.poll(() => zoomOf(app, path)).toBeCloseTo(1.1, 3)
  const s = await state(app)
  expect(s.windows[main.id]?.sidebar.visible).toBe(main.sidebar.visible)
  expect(s.windows[main.id]?.spaceId).toBe(main.spaceId)
  // ⌘R reloads its page.
  await pressInPage(app, path, 'R', PRIMARY_MOD)
  await expect.poll(() => fx.hits(path)).toBe(2)
  // ⌘⌥O offers the Spaces to move the page into (MW-05).
  await pressInPage(app, path, 'O', [...PRIMARY_MOD, 'alt'])
  await expect.poll(popups).toEqual([expect.arrayContaining([expect.stringContaining('Elsewhere')])])
  // ⌘L edits its address, and the keyboard goes with it: what is typed next goes into the field.
  await pressInPage(app, path, 'L', PRIMARY_MOD)
  const ui = app.windows().find((p) => p.url().includes('view=mini'))
  if (!ui) throw new Error('no Mini Window UI')
  const address = ui.getByTestId('mini-address-input')
  await expect(address).toBeFocused()
  await expect.poll(focusedUrl).toContain('view=mini')
  expect(await typeAnywhere(['q'])).toEqual([expect.stringContaining('view=mini')])
  await expect(address).toHaveValue('q')
  // Esc closes the field and gives the keyboard back to the page: what is typed next goes there.
  await ui.keyboard.press('Escape')
  await expect(address).toHaveCount(0)
  await expect.poll(focusedUrl).toBe(fx.url(path))
  expect(await typeAnywhere(['z'])).toEqual([fx.url(path)])
  const inMini = await tabPage(app, path)
  await expect.poll(() => inMini.evaluate(() => (window as unknown as { __keys: string[] }).__keys)).toContain('z')
  // ⌘Y / Ctrl+H shows History in a tab of the browser window behind (AR-10).
  await pressInPage(app, path, isMac ? 'Y' : 'H', PRIMARY_MOD)
  await expect
    .poll(async () => {
      const now = await state(app)
      const w = now.windows[main.id]
      return w ? now.tabs[w.activeTab[w.spaceId] ?? '']?.url : undefined
    })
    .toBe('orbit://history/')
  // Help → Keyboard Shortcuts asked with the Mini Window in front opens over the browser window.
  await actionIn(mini.id, 'help.shortcuts')
  await expect
    .poll(async () => (await state(app)).windows[main.id]?.overlay)
    .toMatchObject({ kind: 'panel', panel: 'shortcuts' })
  expect((await state(app)).windows[mini.id]).toBeDefined()
  await cmdIn(app, main.id, 'overlay.close')
  // ⌘W closes it, and only it.
  await pressInPage(app, path, 'W', PRIMARY_MOD)
  await expect.poll(miniOf).toBeUndefined()
  expect((await state(app)).windows[main.id]).toBeDefined()
})

test('[KS-20][KS-06] in full screen with the sidebar hidden, ⌘1–9 and ⌘⌥↑ / ⌘⌥↓ switch tabs without it', async () => {
  const { app } = orbit
  const spaceId = await activeSpace(app)
  const c = await openTab(app, fx.url('/page/FsThird'))
  const b = await openTab(app, fx.url('/page/FsSecond'))
  const a = await openTab(app, fx.url('/page/FsFirst'))
  expect((await state(app)).spaces[spaceId]?.today).toEqual([a, b, c])
  // Full screen hides the sidebar by itself (NV-20).
  await setNativeFullScreen(app, true)
  await expect.poll(async () => (await windowState(app)).sidebar.visible).toBe(false)
  await selectPage(a, fx.url('/page/FsFirst'))
  const mod: Mod = isMac ? 'meta' : 'control'
  await pressMod('3')
  await expect.poll(activeTab).toBe(c)
  await expect.poll(focusedUrl).toBe(fx.url('/page/FsThird'))
  await pressAnywhere('Up', [mod, 'alt'])
  await expect.poll(activeTab).toBe(b)
  await expect.poll(focusedUrl).toBe(fx.url('/page/FsSecond'))
  await pressAnywhere('Down', [mod, 'alt'])
  await expect.poll(activeTab).toBe(c)
  await expect.poll(focusedUrl).toBe(fx.url('/page/FsThird'))
  await pressMod('1')
  await expect.poll(activeTab).toBe(a)
  const win = await windowState(app)
  expect(win.fullscreen).toBe(true)
  expect(win.sidebar.visible).toBe(false)
})

// ---------- Open File (KS-12) and F1 (KS-15) ----------

/** The next Open dialogs answer with these files (none: cancelled); returns how often one was asked. */
async function answerOpenDialog(files: string[]): Promise<() => Promise<number>> {
  await orbit.app.evaluate(({ dialog }, list) => {
    const g = globalThis as unknown as { __openAsked: number }
    g.__openAsked = 0
    dialog.showOpenDialog = (async () => {
      g.__openAsked++
      return { canceled: list.length === 0, filePaths: list }
    }) as typeof dialog.showOpenDialog
  }, files)
  return () => orbit.app.evaluate(() => (globalThis as unknown as { __openAsked: number }).__openAsked)
}

test('[KS-12] ⌘O / Ctrl+O with no Peek open, and Open File… from a Mini Window, open files from the disk in new tabs, the last one selected', async () => {
  const { app } = orbit
  const dir = mkdtempSync(join(tmpdir(), 'orbit-open-'))
  const one = join(dir, 'one.html')
  const two = join(dir, 'two file.html')
  writeFileSync(one, '<title>First File</title><p>one</p>')
  writeFileSync(two, '<title>Second File</title><p>two</p>')
  const spaceId = await activeSpace(app)
  const start = await openTab(app, fx.url('/page/Start'))
  await selectPage(start, fx.url('/page/Start'))
  const tabWith = async (file: string) =>
    Object.values((await state(app)).tabs).find((t) => t.url === pathToFileURL(file).href)
  let asked = await answerOpenDialog([one, two])
  await pressMod('O')
  await expect.poll(async () => (await tabWith(two))?.title).toBe('Second File')
  // The first one opened behind it.
  expect(await tabWith(one)).toBeDefined()
  expect(await asked()).toBe(1)
  await expect.poll(activeTab).toBe((await tabWith(two))?.id)
  expect((await state(app)).spaces[spaceId]?.today).toHaveLength(3)

  // Cancelled: nothing opens.
  asked = await answerOpenDialog([])
  await selectPage(start, fx.url('/page/Start'))
  await pressMod('O')
  await expect.poll(asked).toBe(1)
  expect((await state(app)).spaces[spaceId]?.today).toHaveLength(3)
  await expect.poll(activeTab).toBe(start)

  // File → Open File… with a Mini Window in front: the file opens in the browser window.
  const main = Object.values((await state(app)).windows).find((w) => w.kind === 'main')
  await app.evaluate(({ app: a }, u) => a.emit('open-url', { preventDefault() {} }, u), fx.url('/page/InMini'))
  const miniOf = async () => Object.values((await state(app)).windows).find((w) => w.kind === 'mini')
  await expect.poll(async () => (await miniOf())?.id).toBeTruthy()
  const mini = (await miniOf()) as NonNullable<Awaited<ReturnType<typeof miniOf>>>
  const three = join(dir, 'three.html')
  writeFileSync(three, '<title>Third File</title>')
  asked = await answerOpenDialog([three])
  await actionIn(mini.id, 'file.open')
  await expect.poll(async () => (await tabWith(three))?.title).toBe('Third File')
  const s = await state(app)
  expect(s.spaces[spaceId]?.today).toContain((await tabWith(three))?.id)
  expect(s.windows[main?.id ?? '']?.activeTab[spaceId]).toBe((await tabWith(three))?.id)
  expect(s.windows[mini.id]).toBeDefined()
})

test('[KS-12][KS-15][ST-08] Settings → Shortcuts: Open File… shows the ⌘O it has where no Peek is open; F1 for Help can’t be changed on Windows and Linux', async () => {
  const { app } = orbit
  const page = await openSettings(app, { section: 'shortcuts' })
  const open = shortcutRow(page, 'file.open')
  await expect(open.getByTestId('shortcut-note')).toHaveText(
    `Also ${isMac ? '⌘O' : 'Ctrl+O'} (the keys of Open Peek as Tab), where no Peek or Mini Window is open.`,
  )
  await expect(open.getByTestId('shortcut-record')).toBeVisible()
  // The note follows Open Peek as Tab's keys.
  expect(
    await run(app, 'keys.bind', { actionId: 'peek.expand', accel: `${PRIMARY}+Shift+E`, onConflict: 'clear' }),
  ).toEqual({ ok: true })
  await run(app, 'keys.unbind', { actionId: 'peek.expand', accel: `${PRIMARY}+O` })
  await expect(open.getByTestId('shortcut-note')).toContainText(isMac ? 'Also ⇧⌘E (' : 'Also Ctrl+Shift+E (')
  const help = shortcutRow(page, 'help.open')
  if (isMac) {
    await expect(help.getByTestId('shortcut-record')).toBeVisible()
  } else {
    await expect(help.getByTestId('shortcut-binding')).toHaveText(['F1'])
    await expect(help).toContainText('This shortcut can’t be changed.')
    await expect(help.getByTestId('shortcut-record')).toHaveCount(0)
  }
})
