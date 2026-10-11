import { type ElectronApplication, expect, test } from '@playwright/test'
import { isMac, launchOrbit, MOD, type Orbit, run, state, tabPage, viewPage } from './helpers'
import { choosePageMenu, clickInPage, focusedUrl, pageMenu, pressInPage } from './nav-support'
import {
  type PagesFixtures,
  PRINTERS_ENV,
  pageBounds,
  printDialogs,
  printedJobs,
  printPage,
  startPagesFixtures,
  waitPrint,
} from './pages-support'
import { newTab, tab, waitTab } from './tabs-support'

/**
 * Print (NV-07): Orbit's print dialog over the page. Test runs print nothing and save nothing: the
 * one place Orbit sends a job out records it instead, and the OS's printers are ORBIT_E2E_PRINTERS.
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

/** ⌘ on macOS, Ctrl elsewhere, for pressInPage. */
const MOD_KEY = isMac ? 'meta' : 'control'

/** A tab on the print fixture, loaded, with the keyboard in its field; `scrolled`, a little way down. */
async function printTab(app: ElectronApplication, scrolled = false) {
  const tabId = await newTab(app, fx.url('/print'))
  await waitTab(app, tabId, '/print')
  const page = await tabPage(app, '/print')
  await expect.poll(() => focusedUrl(app)).toBe(fx.url('/print'))
  await page.evaluate(
    (y) => {
      document.getElementById('field')?.focus()
      window.scrollTo(0, y)
    },
    scrolled ? 300 : 0,
  )
  /** What a person would see change on the page. */
  const pageState = () =>
    page.evaluate(() => ({
      url: location.href,
      y: Math.round(scrollY),
      value: (document.getElementById('field') as HTMLInputElement).value,
      focus: document.activeElement?.id ?? null,
      loads: (window as unknown as { __print: { loads: number } }).__print.loads,
    }))
  return { tabId, page, pageState }
}

/** Pages titled "Receipt copy" that are open: the copies `/receipt` writes and prints. */
function receiptCopies(app: ElectronApplication): Promise<number> {
  return app.evaluate(
    ({ webContents }) =>
      webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getTitle() === 'Receipt copy').length,
  )
}

/** A tab's history: its entries' addresses, and which one it's on. */
function tabHistory(app: ElectronApplication, url: string): Promise<{ urls: string[]; index: number } | null> {
  return app.evaluate(({ webContents }, u) => {
    const page = webContents.getAllWebContents().find((w) => w.getURL() === u)
    if (!page) return null
    const history = page.navigationHistory
    return { urls: history.getAllEntries().map((e) => e.url), index: history.getActiveIndex() }
  }, url)
}

/** Presses Esc where the keyboard is, as the keyboard does (through the browser process). */
function pressEscape(app: ElectronApplication): Promise<void> {
  return app.evaluate(({ webContents }) => {
    const focused = webContents.getFocusedWebContents()
    focused?.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    focused?.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  })
}

test('[NV-07][KS-19] ⌘P (Ctrl+P) opens the print dialog over the page, showing the page as it prints; Esc closes it, and the page is as it was', async () => {
  const { app } = orbit
  const { tabId, pageState } = await printTab(app, true)
  const before = await pageState()
  expect(before).toMatchObject({ y: 300, focus: 'field' })

  await pressInPage(app, '/print', 'P', [MOD_KEY])
  const dialog = await waitPrint(app)
  expect(dialog).toMatchObject({ tabId, host: 'tab', busy: false, error: null })
  expect(dialog.pages).toBeGreaterThanOrEqual(3)
  // Over that page's area only, with the keyboard.
  expect(JSON.stringify(dialog.bounds)).toBe(JSON.stringify(await pageBounds(app, tabId)))
  await expect.poll(async () => (await printDialogs(app))[0]?.focused).toBe(true)
  const view = await printPage(app, dialog.dialog)
  await expect(view.getByTestId('print-dialog')).toBeVisible()
  await expect(view.getByTestId('print-preview')).toHaveAttribute('data-pages', String(dialog.pages))
  await expect(view.getByTestId('print-preview-frame')).toHaveAttribute('src', /^blob:/)
  // The engine's PDF viewer shows it (the view's page lets it load).
  await expect
    .poll(() => view.frames().some((f) => /^chrome-extension:\/\/[a-z]+\/index\.html/.test(f.url())))
    .toBe(true)
  await expect(view.getByTestId('print-paper')).toHaveText(`${dialog.pages} pages`)
  await expect(view.getByTestId('print-destination').locator('option')).toHaveText(['Save as PDF', 'Office Printer'])
  await expect(view.getByTestId('print-ok')).toHaveText('Save')
  await expect(view.getByTestId('print-ok')).toBeFocused()

  await pressEscape(app)
  await expect.poll(() => printDialogs(app)).toEqual([])
  // The keyboard is back in the page's field, and nothing on the page changed or printed.
  await expect.poll(() => focusedUrl(app)).toBe(fx.url('/print'))
  expect(await pageState()).toEqual(before)
  expect(await printedJobs(app)).toEqual([])
})

test('[NV-07] the page’s window.print() opens the same dialog and returns at once; Print sends the page to the printer chosen with the settings, and the next dialog starts from them', async () => {
  const { app } = orbit
  const { page } = await printTab(app)
  await clickInPage(app, '/print', '#print')
  const dialog = await waitPrint(app)
  expect(await page.evaluate(() => (window as unknown as { __print: { returned: boolean } }).__print.returned)).toBe(
    true,
  )
  const view = await printPage(app, dialog.dialog)
  await view.getByTestId('print-destination').selectOption('Office')
  await expect(view.getByTestId('print-ok')).toHaveText('Print')
  await view.getByTestId('print-copies').fill('2')
  await view.getByTestId('print-color').selectOption('gray')
  await expect(view.getByTestId('print-preview-frame')).toHaveClass(/is-gray/)
  // A new layout: the preview is made again.
  await view.getByTestId('print-layout').selectOption('landscape')
  await waitPrint(app, (d) => d.preview === 'ready' && d.settings.landscape)
  await view.getByTestId('print-pages').selectOption('custom')
  await view.getByTestId('print-ranges').fill('1-2')
  await expect(view.getByTestId('print-paper')).toHaveText('4 sheets of paper')
  await view.getByTestId('print-ok').click()

  await expect.poll(() => printDialogs(app)).toEqual([])
  expect(await printedJobs(app)).toEqual([
    {
      kind: 'printer',
      url: fx.url('/print'),
      options: {
        deviceName: 'Office',
        copies: 2,
        landscape: true,
        color: false,
        printBackground: false,
        pageRanges: [{ from: 0, to: 1 }],
        header: 'Print',
        footer: fx.url('/print'),
      },
    },
  ])
  await expect.poll(() => focusedUrl(app)).toBe(fx.url('/print'))

  // The next dialog starts from those choices, with every page and one copy.
  await pressInPage(app, '/print', 'P', [MOD_KEY])
  const next = await waitPrint(app)
  expect(next.settings).toMatchObject({
    destination: 'Office',
    landscape: true,
    color: false,
    allPages: true,
    copies: 1,
  })
})

test('[NV-07][KS-08] the command bar’s Print… opens it; Save as PDF saves the pages chosen, and pages the page doesn’t have can’t be printed', async () => {
  const { app, shell } = orbit
  await printTab(app)
  await shell.keyboard.press(`${MOD}+T`)
  const overlay = await viewPage(app, 'overlay')
  await expect(overlay.getByTestId('command-input')).toBeFocused()
  await overlay.keyboard.type('Print')
  const top = overlay.getByTestId('command-result').first()
  await expect(top.getByTestId('command-result-title')).toHaveText('Print…')
  await expect(top.getByTestId('command-shortcut')).toHaveText(isMac ? '⌘P' : 'Ctrl+P')
  await overlay.keyboard.press('Enter')
  const dialog = await waitPrint(app)
  await expect.poll(async () => (await printDialogs(app))[0]?.focused).toBe(true)

  const view = await printPage(app, dialog.dialog)
  const pages = dialog.pages ?? 0
  await view.getByTestId('print-pages').selectOption('custom')
  const ranges = view.getByTestId('print-ranges')
  await ranges.fill(String(pages + 1))
  await expect(view.getByTestId('print-problem')).toHaveText(`Out of bounds page reference, limit is ${pages}`)
  await expect(view.getByTestId('print-ok')).toBeDisabled()
  await ranges.fill('two')
  await expect(view.getByTestId('print-problem')).toHaveText('Invalid page range, use e.g. 1-5, 8, 11-13')
  await ranges.fill('2-3')
  await expect(view.getByTestId('print-problem')).toHaveCount(0)
  await expect(view.getByTestId('print-paper')).toHaveText('2 pages')
  // Enter saves.
  await ranges.press('Enter')

  await expect.poll(() => printDialogs(app)).toEqual([])
  const jobs = await printedJobs(app)
  expect(jobs).toEqual([{ kind: 'pdf', url: fx.url('/print'), name: 'Print.pdf', bytes: expect.any(Number), pages: 2 }])
  expect(jobs[0]?.bytes).toBeGreaterThan(1000)

  // macOS: File → Print… shows ⌘P.
  if (isMac) {
    const accelerator = await app.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu()?.items.find((i) => i.label === 'File')
      return file?.submenu?.items.find((i) => i.label === 'Print…')?.accelerator ?? null
    })
    expect(accelerator).toMatch(/P$/)
  }
})

test('[NV-07] the page menu’s Print… and a Peek’s ⌘P open it over that page; it waits while its tab isn’t shown, and goes when the page does', async () => {
  const { app } = orbit
  const { tabId, page } = await printTab(app)
  await clickInPage(app, '/print', 'h1', [], 'right')
  await expect.poll(async () => (await pageMenu(app))?.labels ?? []).toContain('Print…')
  expect(await choosePageMenu(app, 'Print…')).toBe(true)
  await waitPrint(app)

  // Another tab: the dialog waits; back on the tab, it shows again, with the keyboard.
  const other = await newTab(app, fx.url('/page/Other'))
  await waitTab(app, other, '/page/Other')
  await expect.poll(async () => (await printDialogs(app))[0]?.onScreen).toBe(false)
  await run(app, 'tabs.activate', { tabId })
  await expect
    .poll(async () => {
      const [d] = await printDialogs(app)
      return d?.onScreen && d.focused
    })
    .toBe(true)
  // The page going elsewhere takes its dialog with it.
  await page.evaluate(() => location.assign('/page/Elsewhere'))
  await expect.poll(() => printDialogs(app)).toEqual([])
  await waitTab(app, tabId, '/page/Elsewhere')

  // A Peek's page prints over itself; Esc closes the dialog, and the Peek stays.
  const peekTab = (await run(app, 'peek.open', { url: fx.url('/print') })) as string
  expect(peekTab).toBeTruthy()
  await waitTab(app, peekTab, '/print')
  await expect.poll(() => focusedUrl(app)).toBe(fx.url('/print'))
  await pressInPage(app, '/print', 'P', [MOD_KEY])
  const peek = await waitPrint(app, (d) => d.tabId === peekTab && d.onScreen && d.preview === 'ready')
  expect(peek.host).toBe('floating')
  expect(JSON.stringify(peek.bounds)).toBe(JSON.stringify(await pageBounds(app, peekTab)))
  await expect.poll(async () => (await printDialogs(app))[0]?.focused).toBe(true)
  await pressEscape(app)
  await expect.poll(() => printDialogs(app)).toEqual([])
  const windowId = Object.keys((await state(app)).windows)[0] as string
  expect((await state(app)).windows[windowId]?.overlay.kind).toBe('peek')
  expect(await printedJobs(app)).toEqual([])
})

test('[NV-07] a pop-up window the page writes, prints and closes at once shows the print dialog over it; the window closes once the dialog has printed', async () => {
  const { app } = orbit
  const url = fx.url('/receipt?how=popup')
  const tabId = await newTab(app, url)
  await waitTab(app, tabId, '/receipt')
  await clickInPage(app, url, '#go')
  // The page's close waits for the dialog, as it would behind the engine's print(), which returns
  // only once its dialog has closed.
  const dialog = await waitPrint(app, (d) => d.host === 'popup' && d.onScreen && d.preview === 'ready')
  expect(await receiptCopies(app)).toBe(1)
  const view = await printPage(app, dialog.dialog)
  await view.getByTestId('print-destination').selectOption('Office')
  await view.getByTestId('print-ok').click()
  await expect.poll(() => receiptCopies(app)).toBe(0)
  expect(await printedJobs(app)).toEqual([expect.objectContaining({ kind: 'printer', url: 'about:blank' })])
  expect(await printDialogs(app)).toEqual([])
  expect(await tab(app, tabId)).toBeTruthy()
})

test('[NV-07] a new tab the page writes, prints and closes at once shows the print dialog over it; Cancel closes the dialog, and then the tab', async () => {
  const { app } = orbit
  const url = fx.url('/receipt?how=tab')
  const tabId = await newTab(app, url)
  await waitTab(app, tabId, '/receipt')
  await clickInPage(app, url, '#go')
  const opened = await waitPrint(app, (d) => d.host === 'tab' && !!d.tabId && d.tabId !== tabId)
  const copy = opened.tabId as string
  await run(app, 'tabs.activate', { tabId: copy })
  const dialog = await waitPrint(app, (d) => d.tabId === copy && d.onScreen && d.preview === 'ready')
  expect(await tab(app, copy)).toBeTruthy()
  const view = await printPage(app, dialog.dialog)
  await view.getByTestId('print-cancel').click()
  await expect.poll(async () => await tab(app, copy)).toBeUndefined()
  expect(await printedJobs(app)).toEqual([])
  expect(await tab(app, tabId)).toBeTruthy()
})

test('[NV-07] a page that prints and goes to another page at once shows the print dialog first; once it closes, the page goes on as it would have, to a new history entry', async () => {
  const { app } = orbit
  const url = fx.url('/receipt?how=nav')
  const tabId = await newTab(app, url)
  await waitTab(app, tabId, '/receipt')
  await clickInPage(app, url, '#go')
  const dialog = await waitPrint(app, (d) => d.tabId === tabId && d.onScreen && d.preview === 'ready')
  expect((await tab(app, tabId))?.url).toBe(url)
  const view = await printPage(app, dialog.dialog)
  await view.getByTestId('print-cancel').click()
  await waitTab(app, tabId, '/page/Printed')
  expect(await printDialogs(app)).toEqual([])
  expect(await tabHistory(app, fx.url('/page/Printed'))).toEqual({ urls: [url, fx.url('/page/Printed')], index: 1 })
})

test('[NV-07] the page’s print() while a dialog ⌘P opened shows returns at once and holds nothing: the page goes on to another page at once, and the dialog goes with it (D76)', async () => {
  const { app } = orbit
  const { tabId, page } = await printTab(app)
  await pressInPage(app, '/print', 'P', [MOD_KEY])
  const dialog = await waitPrint(app, (d) => d.tabId === tabId && d.onScreen)
  // The page prints and goes on: as in Chromium, its print() doesn't wait for a dialog it didn't open.
  await page.evaluate(() => {
    window.print()
    ;(window as unknown as { __print: { returned: boolean } }).__print.returned = true
    setTimeout(() => {
      location.href = '/page/Printed'
    }, 0)
  })
  await waitTab(app, tabId, '/page/Printed')
  await expect.poll(async () => (await printDialogs(app)).some((d) => d.dialog === dialog.dialog)).toBe(false)
  expect(await tabHistory(app, fx.url('/page/Printed'))).toEqual({
    urls: [fx.url('/print'), fx.url('/page/Printed')],
    index: 1,
  })
  expect(await printedJobs(app)).toEqual([])
})
