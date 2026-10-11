import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { activeTabId, isMac, launchOrbit, MOD, type Orbit, run, state, viewPage } from './helpers'
import { choosePageMenu, clickInPage, focusedUrl, pageMenu, pressInPage } from './nav-support'
import { type PagesFixtures, startPagesFixtures } from './pages-support'
import { newTab, waitTab } from './tabs-support'

/** View source (DT-04): the page's source in a new tab, as the engine shows it. */

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

/** ⌥⌘U on macOS, Ctrl+U elsewhere, for pressInPage. */
const SOURCE_KEYS: ('alt' | 'meta' | 'control')[] = isMac ? ['meta', 'alt'] : ['control']

/** The tab showing `url`'s source, once it's there and active. */
async function sourceTab(app: ElectronApplication, url: string): Promise<string> {
  let found: string | undefined
  await expect
    .poll(async () => {
      found = Object.values((await state(app)).tabs).find((t) => t.url === `view-source:${url}`)?.id
      return !!found && (await activeTabId(app)) === found
    })
    .toBe(true)
  return found as string
}

/** The id of the window that shows the page at `url` (its webContents' own URL). */
const windowWithPage = (app: ElectronApplication, url: string) =>
  app.evaluate(
    ({ BrowserWindow }, u) =>
      BrowserWindow.getAllWindows().find((w) =>
        w.contentView.children.some((v) => (v as Electron.WebContentsView).webContents?.getURL() === u),
      )?.id ?? null,
    url,
  )
const focusedWindowId = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? null)

/** The engine's source view of `url`. Its page reports `url` itself, as the page's own tab does. */
async function sourcePage(app: ElectronApplication, url: string): Promise<Page> {
  let found: Page | undefined
  await expect
    .poll(async () => {
      for (const page of app.windows().filter((p) => p.url() === url)) {
        if (await page.evaluate(() => !!document.querySelector('td.line-number')).catch(() => false)) found = page
      }
      return !!found
    })
    .toBe(true)
  return found as Page
}

test('[DT-04][KS-08] ⌥⌘U (Ctrl+U) opens the page’s source in a new tab: read-only, coloured, with line numbers', async () => {
  const { app } = orbit
  const url = fx.url('/page/Source')
  const tabId = await newTab(app, url)
  await waitTab(app, tabId, '/page/Source')
  await expect.poll(() => focusedUrl(app)).toBe(url)

  await pressInPage(app, '/page/Source', 'U', SOURCE_KEYS)
  const source = await sourceTab(app, url)
  expect(source).not.toBe(tabId)
  // Shown at once, with the keyboard.
  await expect.poll(() => focusedUrl(app)).toBe(`view-source:${url}`)
  // The page's own tab is as it was.
  expect((await state(app)).tabs[tabId]?.url).toBe(url)

  const view = await sourcePage(app, url)
  const lines = (await (await fetch(url)).text()).trimEnd().split('\n').length
  expect(lines).toBeGreaterThan(1)
  expect(
    await view.evaluate(() => ({
      lines: document.querySelectorAll('td.line-number').length,
      coloured: !!document.querySelector('.html-tag') && !!document.querySelector('.html-attribute-name'),
      text: document.body.innerText.includes('<h1 id="title">Source</h1>'),
      editable: document.designMode !== 'off' || document.body.isContentEditable,
    })),
  ).toEqual({ lines, coloured: true, text: true, editable: false })
})

test('[DT-04] the command bar’s View Source and the page menu open it; a Peek’s or a Mini Window’s ⌥⌘U shows that page’s source', async () => {
  const { app, shell } = orbit
  const url = fx.url('/page/Listed')
  const tabId = await newTab(app, url)
  await waitTab(app, tabId, '/page/Listed')
  await shell.keyboard.press(`${MOD}+T`)
  const overlay = await viewPage(app, 'overlay')
  await expect(overlay.getByTestId('command-input')).toBeFocused()
  await overlay.keyboard.type('View source')
  const top = overlay.getByTestId('command-result').first()
  await expect(top.getByTestId('command-result-title')).toHaveText('View Source')
  await expect(top.getByTestId('command-shortcut')).toHaveText(isMac ? '⌥⌘U' : 'Ctrl+U')
  await overlay.keyboard.press('Enter')
  await sourceTab(app, url)

  // The page menu's View Page Source.
  const menuUrl = fx.url('/page/Menu')
  const menuTab = await newTab(app, menuUrl)
  await waitTab(app, menuTab, '/page/Menu')
  await clickInPage(app, '/page/Menu', 'h1', [], 'right')
  await expect.poll(async () => (await pageMenu(app))?.labels ?? []).toContain('View Page Source')
  expect(await choosePageMenu(app, 'View Page Source')).toBe(true)
  await sourceTab(app, menuUrl)

  // A Peek over the tab: its own page's source, not the tab's.
  await run(app, 'tabs.activate', { tabId })
  const peekUrl = fx.url('/page/Peeked')
  const peekTab = (await run(app, 'peek.open', { url: peekUrl })) as string
  await waitTab(app, peekTab, '/page/Peeked')
  await expect.poll(() => focusedUrl(app)).toBe(peekUrl)
  await pressInPage(app, '/page/Peeked', 'U', SOURCE_KEYS)
  await sourceTab(app, peekUrl)
  expect(Object.values((await state(app)).tabs).filter((t) => t.url === `view-source:${url}`)).toHaveLength(1)

  // A Mini Window's page: its source opens in the main window, which comes to the front even with
  // its command bar open (the keyboard stays in the command bar, and goes to the source after).
  await run(app, 'peek.close', {})
  await shell.keyboard.press(`${MOD}+T`)
  await expect(overlay.getByTestId('command-input')).toBeFocused()
  const main = await focusedWindowId(app)
  const miniUrl = fx.url('/page/Small')
  await run(app, 'mini.open', { url: miniUrl })
  let mini = ''
  await expect
    .poll(async () => {
      mini = Object.values((await state(app)).tabs).find((t) => t.url === miniUrl)?.id ?? ''
      return mini
    })
    .not.toBe('')
  await waitTab(app, mini, '/page/Small')
  await expect.poll(() => focusedWindowId(app)).toBe(await windowWithPage(app, miniUrl))
  await pressInPage(app, '/page/Small', 'U', SOURCE_KEYS)
  const fromMini = await sourceTab(app, miniUrl)
  const s = await state(app)
  expect(s.windows[Object.keys(s.windows)[0] as string]?.kind).toBe('main')
  expect(s.tabs[fromMini]?.floating).toBeFalsy()
  expect(await windowWithPage(app, `view-source:${miniUrl}`)).toBe(main)
  await expect.poll(() => focusedWindowId(app)).toBe(main)
  await expect(overlay.getByTestId('command-input')).toBeFocused()
  await overlay.keyboard.press('Escape')
  await expect.poll(() => focusedUrl(app)).toBe(`view-source:${miniUrl}`)
})
