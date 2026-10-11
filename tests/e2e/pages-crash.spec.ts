import { type ElectronApplication, expect, test } from '@playwright/test'
import { launchOrbit, MOD, type Orbit } from './helpers'
import {
  crashTab,
  dialogPage,
  emitOnTab,
  type PagesFixtures,
  pageDialogs,
  screenPage,
  startInTab,
  startPagesFixtures,
  tabCrashed,
  waitDialog,
  waitNoScreen,
  waitScreen,
} from './pages-support'
import { newTab, row, tab, waitTab } from './tabs-support'

let fx: PagesFixtures
let orbit: Orbit

test.beforeAll(async () => {
  fx = await startPagesFixtures()
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

/** A tab on fixture page `name`, loaded, with its icon. */
async function tabOn(app: ElectronApplication, name: string): Promise<string> {
  const tabId = await newTab(app, fx.url(`/page/${name}`))
  await waitTab(app, tabId, `/page/${name}`)
  await expect.poll(async () => (await tab(app, tabId))?.favicon).toBeTruthy()
  return tabId
}

/** Keeps a tab's page busy for `ms`: it answers nothing meanwhile. */
const keepBusy = (app: ElectronApplication, tabId: string, ms: number) =>
  startInTab(app, tabId, `{ const end = Date.now() + ${ms}; while (Date.now() < end) {} }`)

/** Whether a tab's page answers a script within `ms`. */
const answers = (app: ElectronApplication, tabId: string, ms = 1_000) =>
  app.evaluate(
    (_e, [id, wait]) => {
      const g = globalThis as unknown as {
        __orbit: { ctx: { tabs: { contents: (id: string) => Electron.WebContents | undefined } } }
      }
      const page = g.__orbit.ctx.tabs.contents(id)
      if (!page) return false
      return Promise.race([
        page.executeJavaScript('true').catch(() => false),
        new Promise<boolean>((r) => setTimeout(() => r(false), wait)),
      ])
    },
    [tabId, ms] as const,
  )

test('[NV-14] a page that crashes shows “This page crashed” with Reload in its place; its row keeps its title and icon; Reload brings it back', async () => {
  const { app, shell } = orbit
  const tabId = await tabOn(app, 'Crashy')
  const before = await tab(app, tabId)
  await crashTab(app, tabId)
  const shown = await waitScreen(app, (s) => s.tabId === tabId && s.onScreen)
  expect(shown).toMatchObject({
    kind: 'crash',
    title: 'This page crashed',
    message: 'Something went wrong while showing it.',
    site: `localhost:${fx.port}`,
    code: 'CRASHED',
    host: 'tab',
  })
  // It has the keyboard, on Reload.
  await expect.poll(async () => (await waitScreen(app, (s) => s.id === shown.id)).focused).toBe(true)
  const view = await screenPage(app, shown.id)
  await expect(view.getByTestId('page-screen-title')).toHaveText('This page crashed')
  const reload = view.getByTestId('page-screen-action')
  await expect(reload).toHaveText('Reload')
  await expect(reload).toBeFocused()
  // The row stays, with its title and icon.
  await expect(row(shell, tabId)).toContainText('Crashy')
  expect(await tab(app, tabId)).toMatchObject({ title: 'Crashy', favicon: before?.favicon, url: before?.url })
  // Enter reloads: the page is back, and the screen goes.
  await view.keyboard.press('Enter')
  await waitNoScreen(app, tabId)
  await waitTab(app, tabId, '/page/Crashy')
  expect(await tabCrashed(app, tabId)).toBe(false)
})

test('[NV-14] a page that crashed behind another shows its crash screen when its row is selected, and stays so until ⌘⇧R reloads it', async () => {
  const { app, shell } = orbit
  const behind = await tabOn(app, 'Behind')
  const front = await tabOn(app, 'Front')
  await crashTab(app, behind)
  const shown = await waitScreen(app, (s) => s.tabId === behind)
  // Its tab isn't on screen, so neither is its screen.
  expect(shown.onScreen).toBe(false)
  await row(shell, behind).click()
  await expect.poll(async () => (await waitScreen(app, (s) => s.id === shown.id)).onScreen).toBe(true)
  // Selecting it doesn't reload it: the crash screen shows until the user reloads.
  expect(await tabCrashed(app, behind)).toBe(true)
  await expect.poll(async () => (await waitScreen(app, (s) => s.id === shown.id)).focused).toBe(true)
  expect(await tabCrashed(app, behind)).toBe(true)
  const view = await screenPage(app, shown.id)
  await view.keyboard.press(`Shift+${MOD}+R`)
  await waitNoScreen(app, behind)
  await waitTab(app, behind, '/page/Behind')
  expect(await tabCrashed(app, behind)).toBe(false)
  expect(await tabCrashed(app, front)).toBe(false)
})

// A busy page that gets input tells main (`unresponsive`) after about 15 s, and again when it
// answers (`responsive`). The engine says nothing while a debugger is attached to the page, and
// Playwright attaches to every page, so these tests make a page busy and emit what the engine would.

test('[NV-14] a page that stops responding gets “Page unresponsive” over it, with Wait or Close page; it goes by itself when the page answers again', async () => {
  const { app } = orbit
  const tabId = await tabOn(app, 'Busy')
  await keepBusy(app, tabId, 3_000)
  expect(await answers(app, tabId, 500)).toBe(false)
  await emitOnTab(app, tabId, 'unresponsive')
  const hang = await waitDialog(app, (d) => d.tabId === tabId && d.kind === 'hang' && d.onScreen)
  expect(hang).toMatchObject({
    title: 'Page unresponsive',
    message: `localhost:${fx.port} isn’t responding. You can wait for it, or close the page.`,
  })
  // It has the keyboard, on Wait.
  await expect.poll(async () => (await waitDialog(app, (d) => d.id === hang.id)).focused).toBe(true)
  const view = await dialogPage(app, hang.id)
  await expect(view.getByTestId('page-dialog-ok')).toHaveText('Wait')
  await expect(view.getByTestId('page-dialog-ok')).toBeFocused()
  await expect(view.getByTestId('page-dialog-cancel')).toHaveText('Close page')
  // The page answers again: the dialog goes by itself, and the page is as it was.
  await expect.poll(() => answers(app, tabId), { timeout: 15_000 }).toBe(true)
  await emitOnTab(app, tabId, 'responsive')
  await expect.poll(async () => (await pageDialogs(app)).some((d) => d.kind === 'hang')).toBe(false)
  expect(await tabCrashed(app, tabId)).toBe(false)

  // Wait (Esc gives it too): the dialog goes, and the page carries on.
  await keepBusy(app, tabId, 3_000)
  await emitOnTab(app, tabId, 'unresponsive')
  const again = await waitDialog(app, (d) => d.tabId === tabId && d.kind === 'hang' && d.id !== hang.id && d.onScreen)
  await (await dialogPage(app, again.id)).keyboard.press('Escape')
  await expect.poll(async () => (await pageDialogs(app)).some((d) => d.kind === 'hang')).toBe(false)
  await expect.poll(() => answers(app, tabId), { timeout: 15_000 }).toBe(true)
  expect(await tabCrashed(app, tabId)).toBe(false)
})

test('[NV-14] Close page ends a page that stopped responding; its screen says so, and Reload brings it back', async () => {
  const { app } = orbit
  const tabId = await tabOn(app, 'Stuck')
  await keepBusy(app, tabId, 10 * 60_000)
  expect(await answers(app, tabId, 500)).toBe(false)
  await emitOnTab(app, tabId, 'unresponsive')
  const hang = await waitDialog(app, (d) => d.tabId === tabId && d.kind === 'hang' && d.onScreen)
  await (await dialogPage(app, hang.id)).getByTestId('page-dialog-cancel').click()
  const shown = await waitScreen(app, (s) => s.tabId === tabId && s.onScreen)
  expect(shown).toMatchObject({
    kind: 'crash',
    title: 'This page was closed',
    message: 'It stopped responding, so Orbit closed it.',
    code: 'HUNG',
  })
  expect(await tabCrashed(app, tabId)).toBe(true)
  await (await screenPage(app, shown.id)).getByTestId('page-screen-action').click()
  await waitNoScreen(app, tabId)
  await waitTab(app, tabId, '/page/Stuck')
  expect(await tabCrashed(app, tabId)).toBe(false)
})
