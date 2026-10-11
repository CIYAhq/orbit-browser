import { expect, test } from '@playwright/test'
import { action, isMac, launchOrbit, type Orbit, state } from './helpers'
import { clickInPage, closeWindow, cmdIn, pressInPage, toolsPage, windowState } from './nav-support'
import {
  AUTH_PASSWORD,
  AUTH_USER,
  clickClosing,
  clickInFrame,
  dialogPage,
  inFrame,
  leaveInfo,
  type PagesFixtures,
  pageDialogs,
  startPagesFixtures,
  waitDialog,
} from './pages-support'
import { act, activeId, cmd, liveTabs, newTab, row, space, tab, tabsHook, waitTab } from './tabs-support'

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

type Rect = { x: number; y: number; width: number; height: number }

/** ⌘ on macOS, Ctrl elsewhere, for pressInPage. */
const MOD_KEY = isMac ? 'meta' : 'control'

/** Runs a script in the page whose URL is `url`, without waiting on what it starts. */
function inPage(app: Orbit['app'], url: string, code: string): Promise<unknown> {
  return app.evaluate(
    ({ webContents }, [u, c]) =>
      webContents
        .getAllWebContents()
        .find((w) => w.getURL() === u)
        ?.executeJavaScript(c),
    [url, code] as const,
  )
}

/** Waits until a tab's page title says what its `/ask` call returned. */
async function answered(tabId: string, text: string) {
  await expect.poll(async () => (await tab(orbit.app, tabId))?.title).toBe(`Answered ${text}`)
}

test('[NV-24] confirm shows over its page only; other tabs stay usable and it waits for its tab', async () => {
  const { app, shell } = orbit
  const other = await newTab(app, fx.url('/page/Other'))
  await waitTab(app, other, '/page/Other')
  const url = fx.url('/ask?kind=confirm&msg=Keep%20going%3F')
  const asking = await newTab(app, url)
  await waitTab(app, asking, '/ask')
  await clickInPage(app, url, '#ask')

  const shown = await waitDialog(app, (d) => d.tabId === asking && d.onScreen)
  expect(shown.kind).toBe('confirm')
  expect(shown.title).toBe(`localhost:${fx.port} says`)
  expect(shown.message).toBe('Keep going?')
  // Over the page's own area, and nothing else.
  const pageBounds = await app.evaluate((_e, id) => {
    const g = globalThis as unknown as { __orbit: { tabView: (id: string) => { bounds: unknown } | null } }
    return g.__orbit.tabView(id)?.bounds
  }, asking)
  expect(shown.bounds).toEqual(pageBounds)
  // It has the keyboard (KS-19).
  await expect.poll(async () => (await waitDialog(app, (d) => d.id === shown.id)).focused).toBe(true)

  // The sidebar still works: another tab comes up, and the dialog waits off screen.
  await row(shell, other).click()
  await expect.poll(async () => (await waitDialog(app, (d) => d.id === shown.id)).onScreen).toBe(false)
  // Back on its tab, it shows again.
  await row(shell, asking).click()
  await expect.poll(async () => (await waitDialog(app, (d) => d.id === shown.id)).onScreen).toBe(true)

  const view = await dialogPage(app, shown.id)
  await expect(view.getByTestId('page-dialog-title')).toHaveText(`localhost:${fx.port} says`)
  await expect(view.getByTestId('page-dialog-message')).toHaveText('Keep going?')
  await view.getByTestId('page-dialog-ok').click()
  await answered(asking, 'true')
  await expect.poll(async () => (await waitDialog(app, () => true, 1000).catch(() => null)) === null).toBe(true)
})

/** The URL of the page that has the keyboard. */
const focusedUrl = () =>
  orbit.app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL() ?? 'nothing')

test('[NV-24][KS-19][KS-16] prompt and alert: Enter answers, Esc cancels, and the page gets the keyboard back', async () => {
  const { app } = orbit
  const url = fx.url('/ask?kind=prompt&msg=Your%20name&value=first')
  const asking = await newTab(app, url)
  await waitTab(app, asking, '/ask')
  await clickInPage(app, url, '#ask')
  const first = await waitDialog(app, (d) => d.tabId === asking && d.onScreen)
  expect(first.kind).toBe('prompt')
  const view = await dialogPage(app, first.id)
  const field = view.getByTestId('page-dialog-input')
  await expect(field).toHaveValue('first')
  await expect(field).toBeFocused()
  // The page's text starts selected: typing replaces it.
  expect(await field.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 5])
  await field.fill('typed')
  await field.press('Enter')
  await answered(asking, '"typed"')
  await expect.poll(focusedUrl).toBe(url)

  await clickInPage(app, url, '#ask')
  const second = await waitDialog(app, (d) => d.tabId === asking && d.onScreen && d.id !== first.id)
  await (await dialogPage(app, second.id)).keyboard.press('Escape')
  await answered(asking, 'null')
  await expect.poll(focusedUrl).toBe(url)

  const alertUrl = fx.url('/ask?kind=alert&msg=Saved')
  const alerting = await newTab(app, alertUrl)
  await waitTab(app, alerting, '/ask')
  await clickInPage(app, alertUrl, '#ask')
  const alert = await waitDialog(app, (d) => d.tabId === alerting && d.onScreen)
  expect(alert.kind).toBe('alert')
  const alertView = await dialogPage(app, alert.id)
  // One button only.
  await expect(alertView.getByTestId('page-dialog-cancel')).toHaveCount(0)
  await expect(alertView.getByTestId('page-dialog-ok')).toBeFocused()
  await alertView.keyboard.press('Enter')
  await answered(alerting, 'undefined')
})

/**
 * Types each of `keys` (a character, or a key such as 'Enter') wherever the keyboard is, as the
 * keyboard does: Enter comes with its character too, which a form's submit button acts on.
 * Returns the address of the view that took each.
 */
function typeWhereKeyboardIs(keys: string[]): Promise<string[]> {
  return orbit.app.evaluate(
    ({ webContents }, list) =>
      list.map((key) => {
        const contents = webContents.getFocusedWebContents()
        if (!contents) return 'nothing'
        const char = key === 'Enter' ? '\r' : [...key].length === 1 ? key : null
        contents.sendInputEvent({ type: 'keyDown', keyCode: key })
        if (char) contents.sendInputEvent({ type: 'char', keyCode: char })
        contents.sendInputEvent({ type: 'keyUp', keyCode: key })
        return contents.getURL()
      }),
    keys,
  )
}

test('[NV-24][KS-19] a dialog the page times leaves the keyboard in a tab being renamed; it takes it when the keyboard goes back to the page (D72)', async () => {
  const { app, shell } = orbit
  const url = fx.url('/ask?kind=confirm&msg=Timed')
  const asking = await newTab(app, url)
  await waitTab(app, asking, '/ask')
  // The user renames the tab in the sidebar, which has the keyboard (as after a click there)...
  await row(shell, asking).getByTestId('tab-title').dblclick()
  const field = shell.getByTestId('rename-field')
  await expect(field).toBeFocused()
  await cmd(app, 'spaces.focusShell')
  await expect.poll(focusedUrl).toContain('view=shell')
  // ...as the page asks (review REPRO G).
  await inPage(app, url, 'setTimeout(ask, 0); 0')
  const shown = await waitDialog(app, (d) => d.tabId === asking && d.onScreen)
  expect(shown.focused).toBe(false)
  // What the user types goes on into the field, and Enter saves the name: the page isn't answered.
  const typed = await typeWhereKeyboardIs(['M', 'a', 'i', 'l', 'Enter'])
  expect(typed.every((at) => at.includes('view=shell'))).toBe(true)
  await expect(row(shell, asking).getByTestId('tab-title')).toHaveText('Mail')
  expect(await waitDialog(app, (d) => d.id === shown.id)).toMatchObject({ onScreen: true, focused: false })
  // Once the keyboard goes back to the page, the dialog has it, and Enter answers.
  await cmd(app, 'tabs.focusPage')
  await expect.poll(async () => (await waitDialog(app, (d) => d.id === shown.id)).focused).toBe(true)
  expect(await typeWhereKeyboardIs(['Enter'])).toEqual([expect.stringContaining('view=dialog')])
  await answered(asking, 'true')
})

test('[NV-24][KS-19][NV-05] a dialog the page times leaves the keyboard in the find bar; it takes it when the bar closes (D72)', async () => {
  const { app } = orbit
  const url = fx.url('/ask?kind=confirm&msg=Timed')
  const asking = await newTab(app, url)
  await waitTab(app, asking, '/ask')
  await pressInPage(app, url, 'F', [MOD_KEY])
  const input = (await toolsPage(app)).getByTestId('find-input')
  await expect(input).toBeFocused()
  await expect.poll(focusedUrl).toContain('view=tools')
  // The page asks while the user types a search (review REPRO H).
  await inPage(app, url, 'setTimeout(ask, 0); 0')
  const shown = await waitDialog(app, (d) => d.tabId === asking && d.onScreen)
  expect(shown.focused).toBe(false)
  const typed = await typeWhereKeyboardIs(['A', 's', 'k', 'Enter'])
  expect(typed.every((at) => at.includes('view=tools'))).toBe(true)
  await expect(input).toHaveValue('Ask')
  expect(await waitDialog(app, (d) => d.id === shown.id)).toMatchObject({ onScreen: true, focused: false })
  // Esc closes the bar and gives the page the keyboard: the dialog takes it, and Esc there cancels.
  expect(await typeWhereKeyboardIs(['Escape'])).toEqual([expect.stringContaining('view=tools')])
  await expect.poll(async () => (await waitDialog(app, (d) => d.id === shown.id)).focused).toBe(true)
  expect(await typeWhereKeyboardIs(['Escape'])).toEqual([expect.stringContaining('view=dialog')])
  await answered(asking, 'false')
})

test('[NV-24] a dialog from an empty tab or pop-up that its opener scripts names the opener’s site', async () => {
  const { app } = orbit
  for (const how of ['tab', 'popup'] as const) {
    const url = fx.url(`/blank-ask?how=${how}`)
    const opener = await newTab(app, url)
    await waitTab(app, opener, '/blank-ask')
    await clickInPage(app, url, '#go')
    // The empty page is about:blank, with its opener's origin (review REPRO I).
    const shown = await waitDialog(app, (d) => d.message === 'From the empty page' && d.host === how && d.onScreen)
    if (how === 'tab') expect(shown.tabId).not.toBe(opener)
    expect(shown.title).toBe(`localhost:${fx.port} says`)
    const view = await dialogPage(app, shown.id)
    await expect(view.getByTestId('page-dialog-title')).toHaveText(`localhost:${fx.port} says`)
    // A pop-up's dialog has a view of its own, which goes with the dialog.
    await clickClosing(view.getByTestId('page-dialog-ok'))
    await expect.poll(async () => (await pageDialogs(app)).some((d) => d.id === shown.id)).toBe(false)
  }
})

test('[NV-24] a background tab’s dialog waits until its tab shows', async () => {
  const { app, shell } = orbit
  const url = fx.url('/ask?kind=confirm&msg=Later')
  const asking = await newTab(app, url)
  await waitTab(app, asking, '/ask')
  const other = await newTab(app, fx.url('/page/Other'))
  await waitTab(app, other, '/page/Other')
  // The page asks from its own timer while another tab shows.
  await inPage(app, url, 'setTimeout(ask, 0); 0')
  const waiting = await waitDialog(app, (d) => d.tabId === asking)
  expect(waiting.onScreen).toBe(false)
  await row(shell, asking).click()
  await expect.poll(async () => (await waitDialog(app, (d) => d.id === waiting.id)).onScreen).toBe(true)
  await (await dialogPage(app, waiting.id)).getByTestId('page-dialog-cancel').click()
  await answered(asking, 'false')
})

test('[NV-24] a split pane’s dialog covers that pane only', async () => {
  const { app } = orbit
  const left = await newTab(app, fx.url('/page/Left'))
  await waitTab(app, left, '/page/Left')
  const url = fx.url('/ask?kind=confirm&msg=Right%20side')
  const right = await newTab(app, url)
  await waitTab(app, right, '/ask')
  await app.evaluate(
    (_e, ids) => {
      const g = globalThis as unknown as {
        __orbit: { run: (n: string, a: unknown, w?: string) => Promise<unknown>; windowIds: () => string[] }
      }
      return g.__orbit.run('split.create', { tabIds: ids, focus: ids[1] }, g.__orbit.windowIds()[0])
    },
    [left, right],
  )
  const boundsOf = (id: string) =>
    app.evaluate((_e, tabId) => {
      const g = globalThis as unknown as {
        __orbit: { tabView: (id: string) => { bounds: { x: number; y: number; width: number; height: number } } | null }
      }
      return g.__orbit.tabView(tabId)?.bounds ?? null
    }, id)
  // Side by side (the sidebar's order decides which pane is where).
  const apart = (a: Rect | null, b: Rect | null) =>
    !!a && !!b && a.width > 0 && b.width > 0 && (a.x + a.width <= b.x || b.x + b.width <= a.x)
  await expect.poll(async () => apart(await boundsOf(left), await boundsOf(right))).toBe(true)
  await clickInPage(app, url, '#ask')
  const shown = await waitDialog(app, (d) => d.tabId === right && d.onScreen)
  expect(shown.bounds).toEqual(await boundsOf(right))
  expect(apart(shown.bounds ?? null, await boundsOf(left))).toBe(true)
  await (await dialogPage(app, shown.id)).getByTestId('page-dialog-ok').click()
  await answered(right, 'true')
})

test('[NV-24] a Peek’s and a Mini Window’s page show their dialogs over themselves', async () => {
  const { app } = orbit
  const under = await newTab(app, fx.url('/page/Under'))
  await waitTab(app, under, '/page/Under')
  const peekTab = (await app.evaluate((_e, u) => {
    const g = globalThis as unknown as {
      __orbit: { run: (n: string, a: unknown, w?: string) => Promise<unknown>; windowIds: () => string[] }
    }
    return g.__orbit.run('peek.open', { url: u }, g.__orbit.windowIds()[0])
  }, fx.url('/ask?kind=confirm&msg=In%20a%20Peek&on=load'))) as string
  expect(peekTab).toBeTruthy()
  const peek = await waitDialog(app, (d) => d.tabId === peekTab && d.onScreen)
  expect(peek.host).toBe('floating')
  const pageBounds = (id: string) =>
    app.evaluate((_e, tabId) => {
      const g = globalThis as unknown as {
        __orbit: { tabView: (id: string) => { bounds: { x: number; y: number; width: number; height: number } } | null }
      }
      return g.__orbit.tabView(tabId)?.bounds ?? null
    }, id)
  // It follows the card as it springs open.
  await expect
    .poll(async () => JSON.stringify((await waitDialog(app, (d) => d.id === peek.id)).bounds))
    .toBe(JSON.stringify(await pageBounds(peekTab)))
  await clickClosing((await dialogPage(app, peek.id)).getByTestId('page-dialog-ok'))
  await answered(peekTab, 'true')

  await app.evaluate((_e, u) => {
    const g = globalThis as unknown as {
      __orbit: { run: (n: string, a: unknown, w?: string) => Promise<unknown>; windowIds: () => string[] }
    }
    return g.__orbit.run('mini.open', { url: u }, g.__orbit.windowIds()[0])
  }, fx.url('/ask?kind=confirm&msg=In%20a%20Mini%20Window&on=load'))
  const mini = await waitDialog(app, (d) => d.message === 'In a Mini Window' && d.onScreen)
  expect(mini.host).toBe('floating')
  const miniTab = mini.tabId as string
  expect((await tab(app, miniTab))?.floating).toBe('mini')
  await expect
    .poll(async () => JSON.stringify((await waitDialog(app, (d) => d.id === mini.id)).bounds))
    .toBe(JSON.stringify(await pageBounds(miniTab)))
  await clickClosing((await dialogPage(app, mini.id)).getByTestId('page-dialog-cancel'))
  await answered(miniTab, 'false')
})

/** Opens `/warn` in a new tab and clicks in it: a page warns only after the user did something there. */
async function warningTab(app: Orbit['app'], opts: { windowId?: string } = {}): Promise<string> {
  const url = fx.url('/warn')
  const id = opts.windowId ? await cmdIn<string>(app, opts.windowId, 'tabs.create', { url }) : await newTab(app, url)
  await waitTab(app, id, '/warn')
  await clickInPage(app, url, '#area')
  await expect.poll(async () => (await leaveInfo(app, id))?.gestures ?? 0).toBeGreaterThan(0)
  return id
}

/**
 * Opens `/framed` (its frame is a `/warn` page) in a new tab and clicks in the frame: the frame warns
 * before the page goes. `name` tells the pages apart.
 */
async function framedTab(app: Orbit['app'], name: string, opts: { windowId?: string } = {}) {
  const url = fx.url(`/framed?name=${name}`)
  const id = opts.windowId ? await cmdIn<string>(app, opts.windowId, 'tabs.create', { url }) : await newTab(app, url)
  await waitTab(app, id, '/framed')
  await clickInFrame(app, url)
  await expect.poll(async () => (await leaveInfo(app, id))?.gestures ?? 0).toBeGreaterThan(0)
  return { id, url }
}

/** Answers the leave-page dialog that shows next, over whichever tab; returns that tab. */
async function answerNextLeave(app: Orbit['app'], tabIds: string[], choice: 'ok' | 'cancel'): Promise<string> {
  const d = await waitDialog(app, (x) => !!x.tabId && tabIds.includes(x.tabId) && x.onScreen && x.kind === 'leave')
  await answerLeave(app, d.tabId as string, choice)
  return d.tabId as string
}

/** Answers the leave-page dialog over a tab's page. */
async function answerLeave(app: Orbit['app'], tabId: string, choice: 'ok' | 'cancel', kind = 'leave') {
  const d = await waitDialog(app, (x) => x.tabId === tabId && x.onScreen && x.kind === kind)
  const view = await dialogPage(app, d.id)
  if (kind === 'reload') {
    await expect(view.getByTestId('page-dialog-title')).toHaveText('Reload site?')
    await expect(view.getByTestId('page-dialog-ok')).toHaveText('Reload')
  } else {
    await expect(view.getByTestId('page-dialog-title')).toHaveText('Leave site?')
    await expect(view.getByTestId('page-dialog-ok')).toHaveText('Leave')
  }
  await expect(view.getByTestId('page-dialog-message')).toHaveText('Changes you made may not be saved.')
  await view.getByTestId(choice === 'ok' ? 'page-dialog-ok' : 'page-dialog-cancel').click()
  await expect.poll(async () => (await pageDialogs(app)).some((x) => x.id === d.id)).toBe(false)
}

test('[NV-24] leaving a page that warns asks first: a link, Orbit’s Reload and a form; Cancel stays, Leave goes on', async () => {
  const { app } = orbit
  const url = fx.url('/warn')
  const warn = await warningTab(app)

  // A link: Cancel stays on the page.
  await clickInPage(app, url, '#away')
  await answerLeave(app, warn, 'cancel')
  expect((await tab(app, warn))?.url).toBe(url)
  expect(fx.seen()).not.toContain('GET /page/Away')
  // Leave goes where the link goes.
  await clickInPage(app, url, '#away')
  await answerLeave(app, warn, 'ok')
  await waitTab(app, warn, '/page/Away')

  // Orbit's Reload: "Reload site?", and Reload reloads.
  await cmd(app, 'tabs.navigate', { tabId: warn, url })
  await waitTab(app, warn, '/warn')
  await clickInPage(app, url, '#area')
  const loads = () => fx.seen().filter((r) => r === 'GET /warn').length
  const before = loads()
  await act(app, 'nav.reload')
  await answerLeave(app, warn, 'cancel', 'reload')
  expect(loads()).toBe(before)
  await act(app, 'nav.reload')
  await answerLeave(app, warn, 'ok', 'reload')
  await expect.poll(loads).toBe(before + 1)
  await waitTab(app, warn, '/warn')

  // A form the page sends: Leave sends it.
  await clickInPage(app, url, '#send')
  await answerLeave(app, warn, 'ok')
  await waitTab(app, warn, '/posted')
  expect(fx.seen()).toContain('POST /posted')

  // A page nobody touched leaves without asking (Chromium's rule).
  await cmd(app, 'tabs.navigate', { tabId: warn, url })
  await waitTab(app, warn, '/warn')
  await cmd(app, 'tabs.navigate', { tabId: warn, url: fx.url('/page/Untouched') })
  await waitTab(app, warn, '/page/Untouched')
  expect(await pageDialogs(app)).toEqual([])
})

test('[NV-24][KS-16] a page’s confirm or prompt while it goes is ignored, as the engine’s is, and Orbit adds no handler that would slow it', async () => {
  const { app } = orbit
  const url = fx.url('/going')
  const beacons = (at: string) => fx.seen().filter((r) => r.startsWith(`POST /beacon?at=${at}&`))
  const going = await newTab(app, url)
  await waitTab(app, going, '/going')
  await clickInPage(app, url, '#area')
  await expect.poll(async () => (await leaveInfo(app, going))?.gestures ?? 0).toBeGreaterThan(0)
  // Its link: the page's beforeunload and pagehide ask, get the engine's answers at once, and it goes.
  await clickInPage(app, url, '#away')
  await waitTab(app, going, '/page/Away')
  await expect.poll(() => beacons('beforeunload')).toEqual([`POST /beacon?at=beforeunload&r=false`])
  await expect.poll(() => beacons('pagehide')).toEqual([`POST /beacon?at=pagehide&r=null`])
  expect(await pageDialogs(app)).toEqual([])

  // Closing a tab closes the page through the engine (D73): its beforeunload runs, and its confirm
  // is ignored there too.
  const closing = await newTab(app, url)
  await waitTab(app, closing, '/going')
  await clickInPage(app, url, '#area')
  await expect.poll(async () => (await leaveInfo(app, closing))?.gestures ?? 0).toBeGreaterThan(0)
  await act(app, 'tab.close')
  await expect.poll(async () => await tab(app, closing)).toBeUndefined()
  await expect.poll(() => beacons('beforeunload').length).toBe(2)
  expect(beacons('beforeunload')[1]).toBe(`POST /beacon?at=beforeunload&r=false`)
  expect(await pageDialogs(app)).toEqual([])

  // A busy page doesn't hold up a navigation Orbit starts: the engine runs a page's beforeunload
  // first only when it has a handler, and Orbit adds none (D60). Nor an unload one, which would
  // keep every page out of the back-forward cache.
  const plain = fx.url('/page/Plain')
  const id = await newTab(app, plain)
  await waitTab(app, id, '/page/Plain')
  const waited = await app.evaluate(
    async ({ webContents }, [u, next]) => {
      const page = webContents.getAllWebContents().find((w) => w.getURL() === u)
      if (!page) return -1
      void page.executeJavaScript('{ const end = Date.now() + 3000; while (Date.now() < end) {} }').catch(() => {})
      await new Promise((r) => setTimeout(r, 200))
      const t0 = Date.now()
      const started = new Promise<number>((resolve) => {
        page.once('did-start-navigation', () => resolve(Date.now() - t0))
      })
      page.loadURL(next).catch(() => {})
      return started
    },
    [plain, fx.url('/page/Next')] as const,
  )
  expect(waited).toBeGreaterThanOrEqual(0)
  expect(waited).toBeLessThan(1000)
  await waitTab(app, id, '/page/Next')
})

test('[NV-24] closing a tab whose page warns asks over it: Cancel keeps the tab, Leave closes it', async () => {
  const { app } = orbit
  const warn = await warningTab(app)
  const other = await newTab(app, fx.url('/page/Other'))
  await waitTab(app, other, '/page/Other')
  // Closing it from the background: it shows first, then asks.
  await cmd(app, 'tabs.close', { tabIds: [warn] })
  await answerLeave(app, warn, 'cancel')
  expect(await tab(app, warn)).toBeTruthy()
  expect(await activeId(app)).toBe(warn)
  await act(app, 'tab.close')
  await answerLeave(app, warn, 'ok')
  await expect.poll(async () => await tab(app, warn)).toBeUndefined()
  expect(await tab(app, other)).toBeTruthy()
  // A page nobody touched closes at once.
  const untouched = await newTab(app, fx.url('/warn'))
  await waitTab(app, untouched, '/warn')
  await act(app, 'tab.close')
  expect(await tab(app, untouched)).toBeUndefined()
})

test('[NV-24][KS-08] ⌘W (Ctrl+W) on a page whose frame warns asks too: Cancel keeps the tab and its page as they were, Leave closes it', async () => {
  const { app } = orbit
  const { id, url } = await framedTab(app, 'Close')
  await inFrame(app, url, `document.querySelector('input').value = 'typed'`)
  await pressInPage(app, url, 'W', [MOD_KEY])
  await answerLeave(app, id, 'cancel')
  expect(await tab(app, id)).toBeTruthy()
  expect(await liveTabs(app)).toContain(id)
  expect(await inFrame(app, url, `document.querySelector('input').value`)).toBe('typed')
  await pressInPage(app, url, 'W', [MOD_KEY])
  await answerLeave(app, id, 'ok')
  await expect.poll(async () => await tab(app, id)).toBeUndefined()
})

test('[NV-24] closing a window with pages that warn, from the page or a frame, asks over each: Cancel keeps the window, Leave on each closes it', async () => {
  const { app } = orbit
  const ids = () =>
    app.evaluate(() => (globalThis as unknown as { __orbit: { windowIds: () => string[] } }).__orbit.windowIds())
  const before = await ids()
  await action(app, 'window.new')
  let windowId = ''
  await expect
    .poll(async () => {
      windowId = (await ids()).find((w) => !before.includes(w)) ?? ''
      return windowId
    })
    .not.toBe('')
  const warn = await warningTab(app, { windowId })
  const framed = (await framedTab(app, 'Window', { windowId })).id
  await closeWindow(app, windowId)
  await answerNextLeave(app, [warn, framed], 'cancel')
  expect(await ids()).toContain(windowId)
  expect(await tab(app, warn)).toBeTruthy()
  expect(await tab(app, framed)).toBeTruthy()
  expect(await liveTabs(app)).toEqual(expect.arrayContaining([warn, framed]))
  expect(await pageDialogs(app)).toEqual([])

  await closeWindow(app, windowId)
  const first = await answerNextLeave(app, [warn, framed], 'ok')
  expect(await ids()).toContain(windowId)
  await answerNextLeave(app, [first === warn ? framed : warn], 'ok')
  await expect.poll(ids).not.toContain(windowId)
})

test('[NV-24][SP-12] deleting a Space with pages that warn, from the page or a frame, asks over each: Cancel keeps the Space, Leave on each deletes it', async () => {
  const { app } = orbit
  const home = (await space(app)).id
  const spaceId = await cmd<string>(app, 'spaces.create', { name: 'Drafts' })
  await expect.poll(async () => (await windowState(app)).spaceId).toBe(spaceId)
  const warn = await warningTab(app)
  const framed = (await framedTab(app, 'Space')).id
  await cmd(app, 'spaces.switch', { spaceId: home })
  await expect.poll(async () => (await windowState(app)).spaceId).toBe(home)

  // Each page shows (its Space with it) as it asks.
  const deleting = cmd<boolean>(app, 'spaces.delete', { spaceId })
  await answerNextLeave(app, [warn, framed], 'cancel')
  expect(await deleting).toBe(false)
  expect((await state(app)).spaces[spaceId]).toBeTruthy()
  expect(await liveTabs(app)).toEqual(expect.arrayContaining([warn, framed]))

  const again = cmd<boolean>(app, 'spaces.delete', { spaceId })
  const first = await answerNextLeave(app, [warn, framed], 'ok')
  await answerNextLeave(app, [first === warn ? framed : warn], 'ok')
  expect(await again).toBe(true)
  expect((await state(app)).spaces[spaceId]).toBeUndefined()
  expect(await tab(app, warn)).toBeUndefined()
  expect(await tab(app, framed)).toBeUndefined()
})

test('[NV-24][TD-01] auto-archive keeps a page that warns, from the page or a frame, or one waiting on its dialog, without asking', async () => {
  const { app } = orbit
  const warn = await warningTab(app)
  const framed = (await framedTab(app, 'Archive')).id
  const askUrl = fx.url('/ask?kind=confirm&msg=Still%20there%3F')
  const asking = await newTab(app, askUrl)
  await waitTab(app, asking, '/ask')
  // A page someone used that doesn't warn, and one nobody touched: both go.
  const used = fx.url('/page/Used')
  const touched = await newTab(app, used)
  await waitTab(app, touched, '/page/Used')
  await clickInPage(app, used, '#area')
  await expect.poll(async () => (await leaveInfo(app, touched))?.gestures ?? 0).toBeGreaterThan(0)
  const plain = await newTab(app, fx.url('/page/Plain'))
  await waitTab(app, plain, '/page/Plain')
  const shown = await newTab(app, fx.url('/page/Shown'))
  await waitTab(app, shown, '/page/Shown')
  await inPage(app, askUrl, 'setTimeout(ask, 0); 0')
  await waitDialog(app, (d) => d.tabId === asking)

  const later = Date.now() + 13 * 3600_000
  const first = await tabsHook<{ archived: string[]; slept: string[] }>(app, 'maintenance', later)
  expect(first.archived).not.toContain(asking)
  await expect.poll(async () => (await leaveInfo(app, framed))?.refused).toBe(true)
  await expect.poll(async () => (await leaveInfo(app, warn))?.refused).toBe(true)
  await expect.poll(async () => [await tab(app, touched), await tab(app, plain)]).toEqual([undefined, undefined])
  // Not asked again until it navigates or gets a new gesture.
  const second = await tabsHook<{ archived: string[]; slept: string[] }>(app, 'maintenance', later + 1)
  for (const id of [warn, framed, asking]) {
    expect(second.archived).not.toContain(id)
    expect(second.slept).not.toContain(id)
  }
  expect(await liveTabs(app)).toEqual(expect.arrayContaining([warn, framed, asking]))
  expect((await pageDialogs(app)).map((d) => d.tabId)).toEqual([asking])
})

test('[NV-24][TB-16] sleep keeps a page that warns, from the page or a frame, awake without asking, until it navigates or gets a new gesture', async () => {
  const { app } = orbit
  const warn = await warningTab(app)
  const { id: framed, url: framedUrl } = await framedTab(app, 'Sleep')
  const used = fx.url('/page/Used')
  const touched = await newTab(app, used)
  await waitTab(app, touched, '/page/Used')
  await clickInPage(app, used, '#area')
  await expect.poll(async () => (await leaveInfo(app, touched))?.gestures ?? 0).toBeGreaterThan(0)
  const shown = await newTab(app, fx.url('/page/Shown'))
  await waitTab(app, shown, '/page/Shown')

  // Past the sleep time, before the archive time.
  const later = Date.now() + 3600_000
  const first = await tabsHook<{ archived: string[]; slept: string[] }>(app, 'maintenance', later)
  expect(first.archived).toEqual([])
  await expect.poll(async () => (await leaveInfo(app, framed))?.refused).toBe(true)
  await expect.poll(async () => (await leaveInfo(app, warn))?.refused).toBe(true)
  await expect.poll(async () => (await tab(app, touched))?.asleep).toBe(true)
  expect(await liveTabs(app)).toEqual(expect.arrayContaining([warn, framed]))
  expect((await tab(app, framed))?.asleep).toBe(false)
  expect(await pageDialogs(app)).toEqual([])
  const second = await tabsHook<{ archived: string[]; slept: string[] }>(app, 'maintenance', later + 1)
  expect(second.slept).not.toContain(warn)
  expect(second.slept).not.toContain(framed)

  // A new gesture: the next pass asks the page again, and it still warns.
  await clickInFrame(app, framedUrl)
  await expect.poll(async () => (await leaveInfo(app, framed))?.refused).toBe(false)
  const third = await tabsHook<{ archived: string[]; slept: string[] }>(app, 'maintenance', later + 2)
  expect(third.slept).toContain(framed)
  await expect.poll(async () => (await leaveInfo(app, framed))?.refused).toBe(true)
  expect(await liveTabs(app)).toContain(framed)
  // Gone elsewhere (the user chose Leave): it may sleep.
  await cmd(app, 'tabs.activate', { tabId: warn })
  await cmd(app, 'tabs.navigate', { tabId: warn, url: fx.url('/page/Away') })
  await answerLeave(app, warn, 'ok')
  await waitTab(app, warn, '/page/Away')
  await cmd(app, 'tabs.activate', { tabId: shown })
  await tabsHook(app, 'maintenance', later + 3)
  await expect.poll(async () => (await tab(app, warn))?.asleep).toBe(true)
  expect(await pageDialogs(app)).toEqual([])
})

test('[NV-24] HTTP sign-in asks over the page: Cancel gets the server’s refusal, Sign in signs in', async () => {
  const { app } = orbit
  const url = fx.url('/auth')
  const t = await newTab(app, url)
  const first = await waitDialog(app, (d) => d.tabId === t && d.onScreen && d.kind === 'auth')
  expect(first.title).toBe('Sign in')
  expect(first.message).toBe(`http://localhost:${fx.port} requires a username and password.`)
  const view = await dialogPage(app, first.id)
  await expect(view.getByTestId('page-dialog-note')).toHaveText('Your connection to this site is not private.')
  await expect(view.getByTestId('page-dialog-user')).toBeFocused()
  await view.getByTestId('page-dialog-cancel').click()
  await expect.poll(async () => (await tab(app, t))?.title).toBe('No entry')

  await act(app, 'nav.reload')
  const second = await waitDialog(app, (d) => d.tabId === t && d.onScreen && d.kind === 'auth')
  const again = await dialogPage(app, second.id)
  await again.getByTestId('page-dialog-user').fill(AUTH_USER)
  await again.getByTestId('page-dialog-password').fill(AUTH_PASSWORD)
  await again.getByTestId('page-dialog-password').press('Enter')
  await expect.poll(async () => (await tab(app, t))?.title).toBe('Signed in')
})
