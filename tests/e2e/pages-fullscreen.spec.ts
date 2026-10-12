import { type ElectronApplication, expect, test } from '@playwright/test'
import { action, isMac, launchOrbit, MOD, type Orbit, run, state, tabPage, tabView, viewPage } from './helpers'
import { floatingInfo, focusedUrl, pageMouse, pressInPage, sendToPage } from './nav-support'
import {
  crashTab,
  fullScreenInfo,
  type PagesFixtures,
  type SilentServer,
  startPagesFixtures,
  startSilentServer,
  waitScreen,
} from './pages-support'
import { openSettings } from './settings-support'
import { newTab, waitTab } from './tabs-support'

/**
 * Window full screen (NV-20). Xvfb has no window manager: the window gets the full-screen events and
 * state but never really fills a screen, so these tests check what Orbit keeps and lays out.
 */

let fx: PagesFixtures
let silent: SilentServer
let orbit: Orbit

test.beforeAll(async () => {
  fx = await startPagesFixtures()
  silent = await startSilentServer()
})
test.afterAll(async () => {
  await fx.close()
  await silent.close()
})
test.beforeEach(async () => {
  orbit = await launchOrbit()
})
test.afterEach(async () => {
  await orbit.app.close()
})

type Mod = 'shift' | 'control' | 'alt' | 'meta'

/** Toggle Full Screen's keys: ⌃⌘F on macOS; F11 and Alt+Shift+F on Windows and Linux. */
const TOGGLE_KEYS: [string, Mod[]][] = isMac
  ? [['F', ['control', 'meta']]]
  : [
      ['F11', []],
      ['F', ['alt', 'shift']],
    ]

const windowIds = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { __orbit: { windowIds: () => string[] } }).__orbit.windowIds())

const firstWindow = async (app: ElectronApplication) => (await windowIds(app))[0] as string

/** A window as the state has it: in full screen or not, and its sidebar. */
async function win(app: ElectronApplication, windowId?: string) {
  const id = windowId ?? (await firstWindow(app))
  const w = (await state(app)).windows[id]
  if (!w) throw new Error(`no window ${id}`)
  return { fullscreen: w.fullscreen, sidebar: w.sidebar.visible, peeking: w.sidebar.peeking }
}

/** The first window's content size. */
const contentSize = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    const shell = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('view=shell'))
    const [width = 0, height = 0] = shell?.getContentSize() ?? []
    return { width, height }
  })

/** A tab on the `/esc` page (`prevent`: the page uses Esc), loaded, with the keyboard. */
async function escPage(app: ElectronApplication, prevent = true) {
  const path = `/esc${prevent ? '?prevent=1' : ''}`
  const tabId = await newTab(app, fx.url(path))
  await waitTab(app, tabId, '/esc')
  const page = await tabPage(app, '/esc')
  await expect.poll(() => focusedUrl(app)).toBe(fx.url(path))
  return { tabId, page, escapes: () => page.evaluate(() => (window as unknown as { __escapes: string[] }).__escapes) }
}

/**
 * Presses Esc the way the keyboard does (through the browser process), in the view at `urlPart`;
 * `repeats`: held that long. `presses` presses go in one call, so no wait comes between them.
 */
function pressEscape(app: ElectronApplication, urlPart: string, repeats = 0, presses = 1): Promise<void> {
  const press = [
    { type: 'keyDown', keyCode: 'Escape' },
    ...Array.from({ length: repeats }, () => ({ type: 'keyDown', keyCode: 'Escape', modifiers: ['isAutoRepeat'] })),
    { type: 'keyUp', keyCode: 'Escape' },
  ]
  return sendToPage(app, urlPart, Array.from({ length: presses }, () => press).flat())
}

/**
 * Presses Esc in a tab's page, as the keyboard does: while it loads another address too.
 * `presses` presses go in one call, so no wait comes between them.
 */
function pressEscapeInTab(app: ElectronApplication, tabId: string, presses = 1): Promise<void> {
  return app.evaluate(
    (_e, [id, count]) => {
      const g = globalThis as unknown as {
        __orbit: { ctx: { tabs: { contents: (id: string) => Electron.WebContents } } }
      }
      const page = g.__orbit.ctx.tabs.contents(id)
      for (let i = 0; i < count; i++) {
        page.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
        page.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      }
    },
    [tabId, presses] as const,
  )
}

/** The Esc presses Orbit waited on while a tab loaded, oldest first (keys lane, NV-04). */
const escapeLog = (app: ElectronApplication) =>
  app.evaluate(() =>
    (
      globalThis as unknown as { __orbitKeys: { escapes: () => { url: string; used: boolean; stopped: boolean }[] } }
    ).__orbitKeys.escapes(),
  )

/** Into full screen with the first toggle key, pressed in the page at `urlPart`. */
async function enterFullScreen(app: ElectronApplication, urlPart: string): Promise<void> {
  const [key, mods] = TOGGLE_KEYS[0] as [string, Mod[]]
  await pressInPage(app, urlPart, key, mods)
  await expect.poll(() => win(app)).toMatchObject({ fullscreen: true, sidebar: false })
}

test('[NV-20] ⌃⌘F (F11 and Alt+Shift+F on Windows and Linux) toggles full screen: the sidebar hides and the page fills the screen; the left edge brings the sidebar in over it; leaving docks it again', async () => {
  const { app, shell } = orbit
  const { tabId } = await escPage(app)
  const windowId = await firstWindow(app)
  const docked = (await tabView(app, tabId))?.bounds
  expect(docked?.x).toBeGreaterThan(0)
  for (const [key, mods] of TOGGLE_KEYS) {
    await pressInPage(app, '/esc', key, mods)
    await expect.poll(() => win(app)).toMatchObject({ fullscreen: true, sidebar: false })
    expect(await fullScreenInfo(app, windowId)).toEqual({ fullScreen: true, sidebarHidden: true })
    // The page has the whole window: no sidebar, no frame.
    await expect
      .poll(async () => {
        const size = await contentSize(app)
        return JSON.stringify((await tabView(app, tabId))?.bounds) === JSON.stringify({ x: 0, y: 0, ...size })
      })
      .toBe(true)
    await expect(shell.getByTestId('sidebar')).toBeHidden()

    // The window's left edge, reached in the page, brings the sidebar in over the page; it goes as the pointer moves on.
    await pageMouse(app, '/esc', 'mouseMove', 300, 300)
    await pageMouse(app, '/esc', 'mouseMove', 2, 300)
    await expect.poll(async () => (await win(app)).peeking).toBe(true)
    await expect.poll(async () => (await floatingInfo(app)).placed).toBe(true)
    await pageMouse(app, '/esc', 'mouseMove', 700, 300)
    await expect.poll(async () => (await win(app)).peeking).toBe(false)

    // A held key toggles once (three repeats: toggling on each would end back in full screen).
    await sendToPage(app, '/esc', [
      { type: 'keyDown', keyCode: key, modifiers: mods },
      ...Array.from({ length: 3 }, () => ({ type: 'keyDown', keyCode: key, modifiers: [...mods, 'isAutoRepeat'] })),
      { type: 'keyUp', keyCode: key, modifiers: mods },
    ])
    await expect.poll(() => win(app)).toMatchObject({ fullscreen: false, sidebar: true })
    expect(await fullScreenInfo(app, windowId)).toEqual({ fullScreen: false, sidebarHidden: false })
    await expect.poll(async () => (await tabView(app, tabId))?.bounds).toEqual(docked)
  }
  // The other key leaves what one entered.
  if (TOGGLE_KEYS.length > 1) {
    const [[enter, enterMods], [leave, leaveMods]] = TOGGLE_KEYS as [[string, Mod[]], [string, Mod[]]]
    await pressInPage(app, '/esc', enter, enterMods)
    await expect.poll(() => win(app)).toMatchObject({ fullscreen: true, sidebar: false })
    await pressInPage(app, '/esc', leave, leaveMods)
    await expect.poll(() => win(app)).toMatchObject({ fullscreen: false, sidebar: true })
  }

  // The command bar has it, with its keys.
  await shell.keyboard.press(`${MOD}+T`)
  const overlay = await viewPage(app, 'overlay')
  await expect(overlay.getByTestId('command-input')).toBeFocused()
  await overlay.keyboard.type('Toggle Full Screen')
  const top = overlay.getByTestId('command-result').first()
  await expect(top).toHaveAttribute('data-kind', 'action')
  await expect(top.getByTestId('command-result-title')).toHaveText('Toggle Full Screen')
  await expect(top.getByTestId('command-shortcut')).toHaveText(isMac ? '⌃⌘F' : 'F11')
  await overlay.keyboard.press('Enter')
  await expect.poll(() => win(app)).toMatchObject({ fullscreen: true, sidebar: false })
  if (isMac) {
    const item = await app.evaluate(({ Menu }) => {
      const view = Menu.getApplicationMenu()?.items.find((i) => i.label === 'View')
      return view?.submenu?.items.find((i) => i.label === 'Toggle Full Screen')?.accelerator ?? null
    })
    expect(item).toMatch(/F$/)
  }
})

test('[NV-20][KS-02] Esc goes to the page first: one press keeps full screen, and so do presses a second apart; a second press within a second leaves, and the page never gets it', async () => {
  const { app } = orbit
  const { escapes } = await escPage(app)
  await enterFullScreen(app, '/esc')
  // The page uses Esc (a web app closing its own menu): it gets it, and full screen stays.
  await pressEscape(app, '/esc')
  await expect.poll(escapes).toEqual(['keydown', 'keyup'])
  expect(await win(app)).toMatchObject({ fullscreen: true, sidebar: false })
  // A second later, it is a first press again.
  await new Promise((r) => setTimeout(r, 1_200))
  await pressEscape(app, '/esc')
  await expect.poll(escapes).toEqual(['keydown', 'keyup', 'keydown', 'keyup'])
  expect(await win(app)).toMatchObject({ fullscreen: true, sidebar: false })
  // Two presses at once: full screen ends, and the page doesn't get the press that ends it. (Which
  // of the two that is depends on how long the check above took: a press within a second of the
  // one before leaves, and out of full screen the next press is the page's.)
  const pair = ['keydown', 'keyup', 'keydown', 'keyup', 'keydown', 'keyup']
  await pressEscape(app, '/esc', 0, 2)
  await expect.poll(() => win(app)).toMatchObject({ fullscreen: false, sidebar: true })
  await expect.poll(escapes).toEqual(pair)
  // Out of full screen, Esc is the page's alone.
  await pressEscape(app, '/esc', 0, 2)
  await expect.poll(async () => (await escapes()).length).toBe(10)
  expect(await win(app)).toMatchObject({ fullscreen: false, sidebar: true })
})

test('[KS-02][NV-20] a first Esc the page used in full screen gets a toast offering Exit Full Screen; one it left alone gets none', async () => {
  const { app } = orbit
  const { tabId, escapes } = await escPage(app)
  await enterFullScreen(app, '/esc')
  // The page uses it (its preload says so, D59): full screen stays, and the toast offers the action.
  await pressEscape(app, '/esc')
  await expect.poll(escapes).toEqual(['keydown', 'keyup'])
  // The sidebar is hidden: toasts show in a view of their own, made for the first (SB-13).
  const toast = (await viewPage(app, 'toasts')).getByTestId('toast').filter({ hasText: 'The page used Esc' })
  await expect(toast).toHaveCount(1)
  expect(await win(app)).toMatchObject({ fullscreen: true, sidebar: false })
  await expect(toast.getByTestId('toast-action')).toHaveText('Exit Full Screen')
  await toast.getByTestId('toast-action').click()
  await expect.poll(() => win(app)).toMatchObject({ fullscreen: false, sidebar: true })
  await expect(toast).toHaveCount(0)

  // A page that leaves Esc alone: full screen stays (one press never leaves, D60), and no toast.
  await run(app, 'tabs.navigate', { tabId, url: fx.url('/esc') })
  await waitTab(app, tabId, '/esc')
  await expect.poll(() => focusedUrl(app)).toBe(fx.url('/esc'))
  await enterFullScreen(app, '/esc')
  await pressEscape(app, '/esc')
  await expect.poll(escapes).toEqual(['keydown', 'keyup'])
  // Longer than Orbit waits for the page's answer (250 ms).
  await new Promise((r) => setTimeout(r, 600))
  await expect(toast).toHaveCount(0)
  expect(await win(app)).toMatchObject({ fullscreen: true, sidebar: false })
})

test('[NV-20] holding Esc leaves full screen: the page gets the press, not its repeats', async () => {
  const { app } = orbit
  const { escapes } = await escPage(app, false)
  await enterFullScreen(app, '/esc')
  await pressEscape(app, '/esc', 4)
  await expect.poll(() => win(app)).toMatchObject({ fullscreen: false, sidebar: true })
  // Nor its release: the engine keeps a key's release from a page once the browser took its repeat.
  await expect.poll(escapes).toEqual(['keydown'])
  // Held again out of full screen: the page gets it all.
  await pressEscape(app, '/esc', 2)
  await expect.poll(escapes).toEqual(['keydown', 'keydown', 'keydown (repeat)', 'keydown (repeat)', 'keyup'])
  expect(await win(app)).toMatchObject({ fullscreen: false, sidebar: true })
})

test('[NV-20][KS-02][ST-08] Settings → Shortcuts lists Exit Full Screen, preferring websites; set to prefer Orbit, one Esc leaves at once and the page never sees it', async () => {
  const { app } = orbit
  const settings = await openSettings(app, { section: 'shortcuts' })
  await settings.getByTestId('shortcuts-search').fill('exit')
  const row = settings.getByTestId('setting-shortcut-window.exitFullScreen')
  await expect(row).toContainText('Exit Full Screen')
  await expect(row).toContainText('Websites first')
  await row.click({ button: 'right' })
  const menu = settings.getByTestId('shortcut-menu')
  await expect(menu.getByTestId('shortcut-menu-websites')).toHaveAttribute('aria-checked', 'true')
  await menu.getByTestId('shortcut-menu-orbit').click()
  await expect
    .poll(async () => (await state(app)).settings.shortcutPriority)
    .toEqual({ 'window.exitFullScreen': 'orbit' })
  await settings.close()

  const { escapes } = await escPage(app)
  await enterFullScreen(app, '/esc')
  await pressEscape(app, '/esc', 3)
  await expect.poll(() => win(app)).toMatchObject({ fullscreen: false, sidebar: true })
  // Nothing of the press reached the page: not its repeats, nor its release.
  expect(await escapes()).toEqual([])
  await pressEscape(app, '/esc')
  await expect.poll(escapes).toEqual(['keydown', 'keyup'])
})

test('[NV-20] a video’s own full screen inside the window’s: Esc leaves only the video, and a quick Esc after goes to the page; the toggle keys leave both', async () => {
  const { app } = orbit
  const { page, escapes } = await escPage(app)
  const windowId = await firstWindow(app)
  await enterFullScreen(app, '/esc')
  const inVideo = () =>
    app.evaluate(
      (_e, id) =>
        (
          globalThis as unknown as { __orbit: { ctx: { windows: { inHtmlFullscreen: (id: string) => boolean } } } }
        ).__orbit.ctx.windows.inHtmlFullscreen(id),
      windowId,
    )
  await page.evaluate(() => document.documentElement.requestFullscreen())
  await expect.poll(inVideo).toBe(true)
  // The engine's Esc: the video's full screen ends, the window's stays, with its sidebar hidden.
  await pressEscape(app, '/esc')
  await expect.poll(inVideo).toBe(false)
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false)
  expect(await win(app)).toMatchObject({ fullscreen: true, sidebar: false })
  // The page gets the next press, however soon.
  const before = (await escapes()).length
  await pressEscape(app, '/esc')
  await expect.poll(async () => (await escapes()).slice(before)).toEqual(['keydown', 'keyup'])
  expect(await win(app)).toMatchObject({ fullscreen: true, sidebar: false })

  // In the video's full screen again, the toggle keys leave both: the page's first, then the window's.
  await page.evaluate(() => document.documentElement.requestFullscreen())
  await expect.poll(inVideo).toBe(true)
  const [key, mods] = TOGGLE_KEYS[0] as [string, Mod[]]
  await pressInPage(app, '/esc', key, mods)
  await expect.poll(() => win(app)).toMatchObject({ fullscreen: false, sidebar: true })
  await expect.poll(inVideo).toBe(false)
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false)
})

test('[NV-20][SB-28] in full screen the loading indicator still shows a page loading', async () => {
  const { app } = orbit
  const { tabId } = await escPage(app)
  const windowId = await firstWindow(app)
  await enterFullScreen(app, '/esc')
  const loading = () =>
    app.evaluate(
      (_e, id) =>
        (
          globalThis as unknown as { __orbitNav: { loading: (id: string) => { visible: boolean; tabId?: string } } }
        ).__orbitNav.loading(id),
      windowId,
    )
  await run(app, 'tabs.navigate', { tabId, url: silent.url('/never') })
  await expect.poll(loading).toMatchObject({ visible: true, tabId })
  expect(await win(app)).toMatchObject({ fullscreen: true, sidebar: false })
})

test('[NV-20][NV-04] on a loading page, the Esc that leaves full screen stops nothing', async () => {
  const { app } = orbit
  const { tabId } = await escPage(app)
  await enterFullScreen(app, '/esc')
  await run(app, 'tabs.navigate', { tabId, url: silent.url('/never') })
  await expect.poll(async () => (await state(app)).tabs[tabId]?.loading).toBe(true)
  // The page uses the first press, so the load goes on (NV-04); the second, in the same call, leaves
  // full screen.
  await pressEscapeInTab(app, tabId, 2)
  await expect.poll(() => escapeLog(app)).toMatchObject([{ used: true, stopped: false }])
  await expect.poll(() => win(app)).toMatchObject({ fullscreen: false, sidebar: true })
  // Longer than Orbit waits for a page's answer to an Esc (250 ms): no wait for that press, no stop.
  await new Promise((r) => setTimeout(r, 600))
  expect(await escapeLog(app)).toHaveLength(1)
  expect((await state(app)).tabs[tabId]?.loading).toBe(true)
})

test('[NV-20][NV-10] a window opened in full screen opens in full screen with its sidebar hidden, and docks it when it leaves', async () => {
  const { app } = orbit
  await escPage(app)
  const first = await firstWindow(app)
  await enterFullScreen(app, '/esc')
  await action(app, 'window.new')
  await expect.poll(async () => (await windowIds(app)).length).toBe(2)
  const second = (await windowIds(app)).find((id) => id !== first) as string
  await expect.poll(() => win(app, second)).toMatchObject({ fullscreen: true, sidebar: false })
  await app.evaluate(
    (_e, id) =>
      (globalThis as unknown as { __orbit: { action: (a: string, w?: string) => Promise<void> } }).__orbit.action(
        'window.toggleFullScreen',
        id,
      ),
    second,
  )
  await expect.poll(() => win(app, second)).toMatchObject({ fullscreen: false, sidebar: true })
  expect(await win(app, first)).toMatchObject({ fullscreen: true, sidebar: false })
})

test('[NV-20][SB-11] ⌘S in full screen docks the sidebar, and it stays as the user left it; quitting in full screen keeps the docked sidebar for next time', async () => {
  const { app } = orbit
  await escPage(app)
  const windowId = await firstWindow(app)
  await enterFullScreen(app, '/esc')
  await action(app, 'sidebar.toggle')
  await expect.poll(() => win(app)).toMatchObject({ fullscreen: true, sidebar: true })
  expect(await fullScreenInfo(app, windowId)).toEqual({ fullScreen: true, sidebarHidden: false })
  await action(app, 'window.toggleFullScreen')
  await expect.poll(() => win(app)).toMatchObject({ fullscreen: false, sidebar: true })
  // Hidden by the user in full screen: hidden after it, too.
  await action(app, 'window.toggleFullScreen')
  await expect.poll(() => win(app)).toMatchObject({ fullscreen: true, sidebar: false })
  await action(app, 'sidebar.toggle')
  await action(app, 'sidebar.toggle')
  await expect.poll(() => win(app)).toMatchObject({ fullscreen: true, sidebar: false })
  await action(app, 'window.toggleFullScreen')
  await expect.poll(() => win(app)).toMatchObject({ fullscreen: false, sidebar: false })
  await action(app, 'sidebar.toggle')
  await expect.poll(() => win(app)).toMatchObject({ fullscreen: false, sidebar: true })

  // Quit in full screen: the window comes back with its sidebar docked.
  await action(app, 'window.toggleFullScreen')
  await expect.poll(() => win(app)).toMatchObject({ fullscreen: true, sidebar: false })
  const { userData } = orbit
  await orbit.app.close()
  orbit = await launchOrbit({ userData })
  await expect.poll(() => win(orbit.app)).toMatchObject({ fullscreen: false, sidebar: true })
})

test('[NV-20][NV-14] over a crash screen in full screen, Esc twice leaves full screen too', async () => {
  const { app } = orbit
  const { tabId } = await escPage(app)
  await enterFullScreen(app, '/esc')
  await crashTab(app, tabId)
  const shown = await waitScreen(app, (s) => s.tabId === tabId && s.onScreen)
  await expect.poll(async () => (await waitScreen(app, (s) => s.id === shown.id)).focused).toBe(true)
  await pressEscape(app, 'view=screen')
  expect(await win(app)).toMatchObject({ fullscreen: true, sidebar: false })
  await pressEscape(app, 'view=screen')
  await expect.poll(() => win(app)).toMatchObject({ fullscreen: false, sidebar: true })
})
