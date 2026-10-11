import { type ElectronApplication, expect, test } from '@playwright/test'
import type { MediaTestHooks } from '../../src/main/media'
import type { PlayerInfo } from '../../src/main/media/player'
import { isMac, launchOrbit, type Orbit, tabPage } from './helpers'
import { clickInPage, pressInPage } from './nav-support'
import {
  crashTab,
  dialogPage,
  type PagesFixtures,
  PRINTERS_ENV,
  printDialogs,
  printPage,
  screenPage,
  startPagesFixtures,
  waitDialog,
  waitNoScreen,
  waitPrint,
  waitScreen,
} from './pages-support'
import { cmd, newTab, waitTab } from './tabs-support'

/**
 * Orbit's floating player keeps clear of what covers a page (MD-06): the page's own dialogs
 * (NV-24), the print dialog (NV-07) and the page's screens (NV-13, NV-14), as of Orbit's alerts.
 */

let fx: PagesFixtures
let orbit: Orbit

test.beforeAll(async () => {
  fx = await startPagesFixtures()
})
test.afterAll(async () => {
  await fx.close()
})
test.beforeEach(async () => {
  orbit = await launchOrbit({ env: PRINTERS_ENV })
})
test.afterEach(async () => {
  await orbit.app.close()
})

type Box = { x: number; y: number; width: number; height: number }

/** ⌘ on macOS, Ctrl elsewhere, for pressInPage. */
const MOD_KEY = isMac ? 'meta' : 'control'

/** Orbit's floating player, as the main process sees it. */
function player(app: ElectronApplication): Promise<PlayerInfo> {
  return app.evaluate(() =>
    (globalThis as unknown as { __orbitMedia: MediaTestHooks }).__orbitMedia.manager.player.info(),
  )
}

/** The player's place for a corner of the work area (16 px margins). */
function cornerBox(area: Box, corner: string, width: number, height: number): Box {
  const left = corner.endsWith('left')
  const top = corner.startsWith('top')
  return {
    x: left ? area.x + 16 : area.x + area.width - 16 - width,
    y: top ? area.y + 16 : area.y + area.height - 16 - height,
    width,
    height,
  }
}

/** Moves Orbit's first window, as the user would drag it. */
function placeWindow(app: ElectronApplication, bounds: Box): Promise<void> {
  return app.evaluate((_e, b) => {
    const { __orbit } = globalThis as unknown as {
      __orbit: {
        windowIds: () => string[]
        ctx: { windows: { get: (id: string) => Electron.BrowserWindow | undefined } }
      }
    }
    __orbit.ctx.windows.get(__orbit.windowIds()[0] as string)?.setBounds(b)
  }, bounds)
}

test('[MD-06][NV-24][NV-07][NV-14] the player keeps clear of a page’s dialog, the print dialog and a crash screen while they show, and goes back when they close', async () => {
  const { app } = orbit
  // A video plays in a tab; another tab comes up, and the video goes on in the player.
  const video = await newTab(app, fx.url('/video/Film'))
  await waitTab(app, video, '/video/Film')
  const film = await tabPage(app, '/video/Film')
  await expect.poll(() => film.evaluate(() => document.body.dataset.state ?? ''), { timeout: 20_000 }).toBe('playing')
  const url = fx.url('/ask?kind=confirm&msg=Go%20on%3F')
  const asking = await newTab(app, url)
  await waitTab(app, asking, '/ask')
  await expect
    .poll(async () => {
      const p = await player(app)
      return p.tabId === video && p.visible && p.holdsView && !p.animating
    })
    .toBe(true)
  const area = (await player(app)).workArea as Box
  const home = cornerBox(area, 'bottom-right', 320, 180)
  const aside = cornerBox(area, 'top-right', 320, 180)
  /** Where the player shows: null when it is out of sight. */
  const where = async () => {
    const p = await player(app)
    return p.tabId === video && p.visible && !p.animating ? p.bounds : null
  }
  expect(await where()).toEqual(home)

  // Orbit's window sits in the bottom-right of the screen, under the player: the window alone
  // doesn't move it.
  await placeWindow(app, { x: area.x + area.width - 600, y: area.y + area.height - 500, width: 600, height: 500 })
  expect(await where()).toEqual(home)

  // The page asks: the player moves to the nearest corner clear of the dialog, the top-right one.
  await clickInPage(app, url, '#ask')
  const asked = await waitDialog(app, (d) => d.tabId === asking && d.onScreen)
  await expect.poll(where).toEqual(aside)
  // While the dialog waits off screen, its tab in the background, the player goes back...
  const other = await newTab(app, fx.url('/page/Other'))
  await waitTab(app, other, '/page/Other')
  await expect.poll(async () => (await waitDialog(app, (d) => d.id === asked.id)).onScreen).toBe(false)
  await expect.poll(where).toEqual(home)
  // ...and moves aside again when it shows.
  await cmd(app, 'tabs.activate', { tabId: asking })
  await expect.poll(async () => (await waitDialog(app, (d) => d.id === asked.id)).onScreen).toBe(true)
  await expect.poll(where).toEqual(aside)
  // Answered, the dialog goes, and the player goes back.
  await (await dialogPage(app, asked.id)).getByTestId('page-dialog-ok').click()
  await expect.poll(where).toEqual(home)

  // The print dialog over the page: the same.
  await pressInPage(app, url, 'P', [MOD_KEY])
  const printing = await waitPrint(app, (d) => d.tabId === asking && d.onScreen)
  await expect.poll(where).toEqual(aside)
  await (await printPage(app, printing.dialog)).getByTestId('print-cancel').click()
  await expect.poll(() => printDialogs(app)).toEqual([])
  await expect.poll(where).toEqual(home)

  // The page crashes: its screen shows in its place, and the player keeps clear of it until Reload.
  await crashTab(app, asking)
  const crashed = await waitScreen(app, (s) => s.tabId === asking && s.onScreen)
  await expect.poll(where).toEqual(aside)
  await (await screenPage(app, crashed.id)).getByTestId('page-screen-action').click()
  await waitNoScreen(app, asking)
  await expect.poll(where).toEqual(home)
  // The video played on throughout.
  expect(await film.evaluate(() => (document.getElementById('v') as HTMLVideoElement).paused)).toBe(false)
})
