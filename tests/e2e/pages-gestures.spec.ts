import { execFileSync } from 'node:child_process'
import { type ElectronApplication, expect, test } from '@playwright/test'
import { isMac, launchOrbit, type Orbit, state, tabPage } from './helpers'
import { pressInPage } from './nav-support'
import {
  APPS_ENV,
  appLinks,
  clickInOtherSiteFrame,
  dialogPage,
  inFrame,
  launchedLinks,
  leaveInfo,
  otherSite,
  type PagesFixtures,
  pageDialogs,
  startPagesFixtures,
  waitDialog,
} from './pages-support'
import { liveTabs, newTab, tab, waitTab } from './tabs-support'

/**
 * A press in a frame from another site is a user gesture in its page (D77): the leave-page warning
 * (NV-24), links to other apps (NV-19) and pop-ups (NV-09) count it as one in the page's own frame.
 * Such a frame has a process of its own: Playwright's click reaches it through the browser, and only
 * the real keyboard's keys do (xdotool, Linux).
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
  orbit = await launchOrbit({ env: APPS_ENV })
})
test.afterEach(async () => {
  await orbit.app.close()
})

/** ⌘ on macOS, Ctrl elsewhere, for pressInPage. */
const MOD_KEY = isMac ? 'meta' : 'control'

/** The real X keyboard on the test's display (xdotool, Linux), or null where there is none. */
const keyboard = (() => {
  if (process.platform !== 'linux' || !process.env.DISPLAY) return null
  try {
    execFileSync('xdotool', ['version'], { stdio: 'ignore' })
  } catch {
    return null
  }
  return {
    type: (text: string) => execFileSync('xdotool', ['type', '--delay', '40', text], { stdio: 'ignore' }),
    press: (key: string) => execFileSync('xdotool', ['key', key], { stdio: 'ignore' }),
  }
})()
const NO_KEYBOARD = 'the keys have to come from the real keyboard: test input never reaches a frame from another site'

/** A `/framed` page whose frame is `path` on another site. */
const framedUrl = (name: string, path = '/warn') =>
  fx.url(`/framed?name=${name}&src=${encodeURIComponent(otherSite(fx, path))}`)

/** Runs a script in the page whose URL is `url`, as its own: no user gesture. */
function inPage(app: ElectronApplication, url: string, code: string): Promise<unknown> {
  return app.evaluate(
    ({ webContents }, [u, c]) =>
      webContents
        .getAllWebContents()
        .find((w) => w.getURL() === u)
        ?.executeJavaScript(c),
    [url, code] as const,
  )
}

/**
 * Puts the keyboard on an element of the frame of the page whose URL is `url`, from the page's and
 * the frame's own scripts: no user gesture.
 */
async function keyboardInFrame(app: ElectronApplication, url: string, selector: string): Promise<void> {
  await expect.poll(() => inFrame(app, url, 'document.readyState')).toBe('complete')
  await app.evaluate(
    ({ webContents }, u) =>
      webContents
        .getAllWebContents()
        .find((w) => w.getURL() === u)
        ?.focus(),
    url,
  )
  await expect
    .poll(() => app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL() ?? ''))
    .toBe(url)
  await inPage(app, url, `document.getElementById('frame').focus(); 0`)
  const target = `document.querySelector(${JSON.stringify(selector)})`
  await inFrame(app, url, `${target}.focus(); 0`)
  await expect.poll(() => inFrame(app, url, `document.hasFocus() && document.activeElement === ${target}`)).toBe(true)
}

/** Answers the leave-page dialog over a tab's page. */
async function answerLeave(app: ElectronApplication, tabId: string, choice: 'ok' | 'cancel'): Promise<void> {
  const d = await waitDialog(app, (x) => x.tabId === tabId && x.onScreen && x.kind === 'leave')
  const view = await dialogPage(app, d.id)
  await view.getByTestId(choice === 'ok' ? 'page-dialog-ok' : 'page-dialog-cancel').click()
  await expect.poll(async () => (await pageDialogs(app)).some((x) => x.id === d.id)).toBe(false)
}

test('[NV-24][KS-08] a click in a frame from another site counts: ⌘W (Ctrl+W) on its page asks when the frame warns; ⌘W is no gesture, so a page nobody touched closes at once (D77)', async () => {
  const { app } = orbit
  const url = framedUrl('Clicked')
  const id = await newTab(app, url)
  await waitTab(app, id, '/framed')
  await clickInOtherSiteFrame(app, url)
  await pressInPage(app, url, 'W', [MOD_KEY])
  await answerLeave(app, id, 'cancel')
  expect(await liveTabs(app)).toContain(id)
  await pressInPage(app, url, 'W', [MOD_KEY])
  await answerLeave(app, id, 'ok')
  await expect.poll(() => tab(app, id)).toBeUndefined()

  // A page that warns but nobody touched: ⌘W, a key Orbit takes, gives it no gesture, and the
  // engine (which counts the close as one) is never asked. It closes at once.
  const untouchedUrl = fx.url('/warn?name=Untouched')
  const untouched = await newTab(app, untouchedUrl)
  await waitTab(app, untouched, '/warn')
  expect((await leaveInfo(app, untouched))?.gestures).toBe(0)
  await pressInPage(app, untouchedUrl, 'W', [MOD_KEY])
  await expect.poll(() => tab(app, untouched)).toBeUndefined()
  expect(await pageDialogs(app)).toEqual([])
})

test('[NV-24][KS-08] typing in a frame from another site counts: ⌘W (Ctrl+W) on its page asks when the frame warns, and Cancel keeps what was typed (D77)', async () => {
  test.skip(!keyboard, NO_KEYBOARD)
  const keys = keyboard as NonNullable<typeof keyboard>
  const { app } = orbit
  const url = framedUrl('Typed')
  const id = await newTab(app, url)
  await waitTab(app, id, '/framed')
  const field = `document.querySelector('input')`
  await expect.poll(() => inFrame(app, url, `${field}.value = ''`)).toBe('')
  await keyboardInFrame(app, url, 'input')
  expect((await leaveInfo(app, id))?.gestures).toBe(0)
  keys.type('note')
  await expect.poll(() => inFrame(app, url, `${field}.value`)).toBe('note')
  keys.press('ctrl+w')
  await answerLeave(app, id, 'cancel')
  expect(await liveTabs(app)).toContain(id)
  expect(await inFrame(app, url, `${field}.value`)).toBe('note')
  await pressInPage(app, url, 'W', [MOD_KEY])
  await answerLeave(app, id, 'ok')
  await expect.poll(() => tab(app, id)).toBeUndefined()
})

test('[NV-19] a key in a frame from another site is a new user gesture: after the page’s question, a link there asks again (D77)', async () => {
  test.skip(!keyboard, NO_KEYBOARD)
  const keys = keyboard as NonNullable<typeof keyboard>
  const { app } = orbit
  const frameSite = `127.0.0.1:${fx.port}`
  const url = fx.url(`/apps?frame=${encodeURIComponent(otherSite(fx, '/app-frame'))}`)
  const tabId = await newTab(app, url)
  await waitTab(app, tabId, '/apps')
  const page = await tabPage(app, url)
  // The page asks once: Cancel. Until a new gesture, it asks nothing more.
  await page.locator('#mail').click()
  const asked = await waitDialog(app, (d) => d.tabId === tabId && d.kind === 'app' && d.focused)
  await (await dialogPage(app, asked.id)).getByTestId('page-dialog-cancel').click()
  await expect.poll(async () => (await pageDialogs(app)).length).toBe(0)
  // The keyboard goes to the frame's link from the pages' own scripts; Enter there follows it.
  await keyboardInFrame(app, url, '#frame-mail')
  keys.press('Return')
  const framed = await waitDialog(app, (d) => d.tabId === tabId && d.kind === 'app' && d.id > asked.id && d.onScreen)
  expect(framed.message).toBe(`${frameSite} wants to open this application.`)
  expect(await appLinks(app)).toEqual([
    { url: 'mailto:someone@example.com?subject=Hello%20there', outcome: 'asked' },
    { url: 'mailto:frame@example.com', outcome: 'asked' },
  ])
  await (await dialogPage(app, framed.id)).getByTestId('page-dialog-cancel').click()
  await expect.poll(async () => (await pageDialogs(app)).length).toBe(0)
  expect(await launchedLinks(app)).toEqual([])
})

test('[NV-09] a click in a frame from another site lets the frame open a pop-up (D77)', async () => {
  const { app } = orbit
  const popped = otherSite(fx, '/page/Popped')
  const url = framedUrl('Opener', `/opener?to=${encodeURIComponent('/page/Popped')}`)
  const id = await newTab(app, url)
  await waitTab(app, id, '/framed')
  await expect.poll(() => inFrame(app, url, 'document.readyState')).toBe('complete')
  const popUps = () =>
    app.evaluate(
      ({ BrowserWindow }, u) =>
        BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.webContents.getURL() === u).length,
      popped,
    )
  await (await tabPage(app, url)).frameLocator('#frame').locator('#open').click()
  await expect.poll(popUps).toBe(1)
  expect((await state(app)).tabs[id]?.blockedPopups).toBeUndefined()
})

test('[NV-09] in a pop-up window, a click in a frame from another site lets that frame open a tab (D77)', async () => {
  const { app } = orbit
  // The tab opens a pop-up window whose page has a frame from another site; that frame opens a page.
  const target = otherSite(fx, '/page/FromPopUp')
  // Not the pop-up's own name (`popup`), which would load the page in the pop-up itself.
  const inner = framedUrl('Inner', `/opener?to=${encodeURIComponent('/page/FromPopUp')}&as=another`)
  const url = fx.url(`/opener?to=${encodeURIComponent(inner)}`)
  const id = await newTab(app, url)
  await waitTab(app, id, '/opener')
  await (await tabPage(app, url)).locator('#open').click()
  const popUp = await tabPage(app, inner)
  await expect.poll(() => inFrame(app, inner, 'document.readyState')).toBe('complete')
  const opened = async () => Object.values((await state(app)).tabs).filter((t) => t.url === target).length
  expect(await opened()).toBe(0)
  // A pop-up window's own opens become tabs, one per click or key in any of its frames (NV-09).
  await popUp.frameLocator('#frame').locator('#open').click()
  await expect.poll(opened).toBe(1)
})
