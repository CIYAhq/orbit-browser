import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { action, launchOrbit, MOD, type Orbit } from './helpers'
import { clickInPage } from './nav-support'
import {
  canMakeCertificate,
  countNavigations,
  networkSwitch,
  type PagesFixtures,
  pageBounds,
  pageScreens,
  screenPage,
  startPagesFixtures,
  startSecureFixtures,
  startSilentServer,
  waitNoScreen,
  waitScreen,
} from './pages-support'
import { cmd, newTab, row, tab, waitTab } from './tabs-support'

/** A host no rule answers (D26): with the dead proxy out of its way, its lookup fails. */
const MISSING_HOST = 'nonexistent.invalid'
/** Orbit's time limit for a navigation's first answer, in these tests (ORBIT_E2E_LOAD_TIMEOUT_MS). */
const TIME_LIMIT = 2_000

let fx: PagesFixtures
let orbit: Orbit | undefined

test.beforeAll(async () => {
  fx = await startPagesFixtures()
})
test.afterAll(async () => {
  await fx.close()
})
test.afterEach(async () => {
  await orbit?.app.close()
  orbit = undefined
})

/** A tab on fixture page `name`, with a page before it. */
async function tabOn(app: ElectronApplication, name: string): Promise<string> {
  const tabId = await newTab(app, fx.url('/page/First'))
  await waitTab(app, tabId, '/page/First')
  await cmd(app, 'tabs.navigate', { tabId, url: fx.url(`/page/${name}`) })
  await waitTab(app, tabId, `/page/${name}`)
  return tabId
}

/** Waits for a screen on a tab's page that is on screen. */
const shownOn = (app: ElectronApplication, tabId: string) => waitScreen(app, (s) => s.tabId === tabId && s.onScreen)

/** Dispatches the engine's `online` event in a screen view, as when the network comes back. */
const backOnline = (view: Page) => view.evaluate(() => window.dispatchEvent(new Event('online')))

/** The address of the web contents that has the keyboard. */
const focusedUrl = (app: ElectronApplication) =>
  app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL() ?? '')

test('[NV-13] a host that doesn’t resolve: the page’s area says so with the host and Try again, the address keeps it, ⌘R tries again and Back leaves it', async () => {
  orbit = await launchOrbit({ args: [`--proxy-bypass-list=${MISSING_HOST}`] })
  const { app, shell } = orbit
  const tabId = await tabOn(app, 'Start')
  const url = `http://${MISSING_HOST}/`
  await cmd(app, 'tabs.navigate', { tabId, url })
  const shown = await shownOn(app, tabId)
  expect(shown).toMatchObject({
    kind: 'error',
    title: 'This site can’t be reached',
    message: 'Orbit couldn’t find the server at this address.',
    site: MISSING_HOST,
    code: 'ERR_NAME_NOT_RESOLVED',
    url,
    timedOut: false,
    host: 'tab',
  })
  // Over the page's own area only, and it has the keyboard.
  expect(shown.bounds).toEqual(await pageBounds(app, tabId))
  await expect.poll(async () => (await waitScreen(app, (s) => s.id === shown.id)).focused).toBe(true)
  // The address keeps the host that failed, and the row names it: it showed another site.
  await expect(shell.getByTestId('address')).toContainText(MISSING_HOST)
  await expect.poll(async () => (await tab(app, tabId))?.title).toBe(MISSING_HOST)
  expect(await tab(app, tabId)).toMatchObject({ url })
  expect((await tab(app, tabId))?.favicon).toBeUndefined()

  const view = await screenPage(app, shown.id)
  await expect(view.getByTestId('page-screen-title')).toHaveText('This site can’t be reached')
  await expect(view.getByTestId('page-screen-message')).toHaveText('Orbit couldn’t find the server at this address.')
  await expect(view.getByTestId('page-screen-site')).toHaveText(MISSING_HOST)
  await expect(view.getByTestId('page-screen-code')).toHaveText('ERR_NAME_NOT_RESOLVED')
  const tryAgain = view.getByTestId('page-screen-action')
  await expect(tryAgain).toHaveText('Try again')
  await expect(tryAgain).toBeFocused()

  // Try again asks again: it fails again, and its screen takes the last one's place.
  const navigations = await countNavigations(app, tabId)
  await tryAgain.click()
  const again = await waitScreen(app, (s) => s.tabId === tabId && s.id !== shown.id)
  expect(again).toMatchObject({ code: 'ERR_NAME_NOT_RESOLVED', url, onScreen: true })
  expect(await navigations()).toBe(1)
  // ⌘R too, from the screen, which has the keyboard.
  await view.keyboard.press(`${MOD}+r`)
  await waitScreen(app, (s) => s.tabId === tabId && s.id > again.id)
  expect(await navigations()).toBe(2)

  // Back leaves it: the page before, with its title.
  await action(app, 'nav.back')
  await waitNoScreen(app, tabId)
  await waitTab(app, tabId, '/page/Start')
  await expect.poll(async () => (await tab(app, tabId))?.title).toBe('Start')
  await expect(shell.getByTestId('address')).toContainText(`localhost:${fx.port}`)
})

test('[NV-13] a refused connection: the row keeps the site’s title and icon, and Try again loads the page once its server is back', async () => {
  orbit = await launchOrbit()
  const { app, shell } = orbit
  const site = await startPagesFixtures(3360)
  const url = site.url('/page/Kept')
  const tabId = await newTab(app, url)
  await waitTab(app, tabId, '/page/Kept')
  await expect.poll(async () => (await tab(app, tabId))?.favicon).toBeTruthy()
  const icon = (await tab(app, tabId))?.favicon
  // Its server goes, so nothing listens on that port now: ⌘R is refused.
  await site.close()
  await action(app, 'nav.reload')
  const shown = await shownOn(app, tabId)
  expect(shown).toMatchObject({
    kind: 'error',
    title: 'This site can’t be reached',
    message: 'The server refused to connect.',
    site: `localhost:${site.port}`,
    code: 'ERR_CONNECTION_REFUSED',
    url,
  })
  // The row keeps the site's title and icon, and the tab its address.
  expect(await tab(app, tabId)).toMatchObject({ title: 'Kept', favicon: icon, url })
  await expect(row(shell, tabId)).toContainText('Kept')
  // Back on its port: Try again loads the page.
  const back = await startPagesFixtures(3360, { port: site.port })
  try {
    await (await screenPage(app, shown.id)).getByTestId('page-screen-action').click()
    await waitNoScreen(app, tabId)
    await waitTab(app, tabId, '/page/Kept')
    expect(back.seen()).toContain('GET /page/Kept')
  } finally {
    await back.close()
  }
})

test('[NV-13] a server that never answers: Orbit stops waiting and says so; the address keeps it, Try again and ⌘R ask again, and Back shows the page before', async () => {
  orbit = await launchOrbit({ env: { ORBIT_E2E_LOAD_TIMEOUT_MS: String(TIME_LIMIT) } })
  const { app, shell } = orbit
  const silent = await startSilentServer()
  try {
    // The tab's first page: Back has no entry to go to, and still leads back here.
    const tabId = await newTab(app, fx.url('/page/Start'))
    await waitTab(app, tabId, '/page/Start')
    const url = silent.url('/never')
    await cmd(app, 'tabs.navigate', { tabId, url })
    const shown = await shownOn(app, tabId)
    expect(shown).toMatchObject({
      kind: 'error',
      title: 'This site can’t be reached',
      message: 'The server took too long to respond.',
      site: `localhost:${silent.port}`,
      code: 'ERR_TIMED_OUT',
      url,
      timedOut: true,
    })
    expect(silent.hits('/never')).toBe(1)
    // It stopped loading; the address keeps where it was going, and Back is on.
    const tabNow = async () => {
      const t = await tab(app, tabId)
      return { loading: t?.loading, pendingUrl: t?.pendingUrl, canGoBack: t?.canGoBack, title: t?.title }
    }
    await expect
      .poll(tabNow)
      .toEqual({ loading: false, pendingUrl: url, canGoBack: true, title: `localhost:${silent.port}` })
    await expect(shell.getByTestId('address')).toContainText(`localhost:${silent.port}`)

    // Try again asks again, and gives up again.
    const view = await screenPage(app, shown.id)
    await view.getByTestId('page-screen-action').click()
    await expect.poll(() => silent.hits('/never')).toBe(2)
    const again = await waitScreen(app, (s) => s.tabId === tabId && s.id !== shown.id)
    expect(again).toMatchObject({ timedOut: true, url })
    // ⌘R asks again too.
    await view.keyboard.press(`${MOD}+r`)
    await expect.poll(() => silent.hits('/never')).toBe(3)
    // Back, while it waits again: the page before, which never went away.
    await action(app, 'nav.back')
    await waitNoScreen(app, tabId)
    await expect.poll(tabNow).toEqual({ loading: false, pendingUrl: undefined, canGoBack: false, title: 'Start' })
    await expect(shell.getByTestId('address')).toContainText(`localhost:${fx.port}`)
    expect(silent.hits('/never')).toBe(3)
  } finally {
    await silent.close()
  }
})

test('[NV-13] Back from a timeout shows the page as it was, even an error page with its screen', async () => {
  orbit = await launchOrbit({
    args: [`--proxy-bypass-list=${MISSING_HOST}`],
    env: { ORBIT_E2E_LOAD_TIMEOUT_MS: String(TIME_LIMIT) },
  })
  const { app } = orbit
  const silent = await startSilentServer()
  try {
    const tabId = await tabOn(app, 'Start')
    const missing = `http://${MISSING_HOST}/`
    await cmd(app, 'tabs.navigate', { tabId, url: missing })
    const error = await shownOn(app, tabId)
    // From the error page, an address whose server never answers.
    const never = silent.url('/never')
    await cmd(app, 'tabs.navigate', { tabId, url: never })
    await waitScreen(app, (s) => s.tabId === tabId && s.timedOut && s.url === never)
    await expect.poll(async () => (await tab(app, tabId))?.title).toBe(`localhost:${silent.port}`)
    // Back: the error page, with its screen and its row as they were.
    await action(app, 'nav.back')
    const again = await waitScreen(app, (s) => s.tabId === tabId && !s.timedOut)
    expect(again).toMatchObject({ id: error.id, code: 'ERR_NAME_NOT_RESOLVED', url: missing, onScreen: true })
    expect(await tab(app, tabId)).toMatchObject({ title: MISSING_HOST, url: missing, loading: false })
    expect((await tab(app, tabId))?.pendingUrl).toBeUndefined()
    // Back again: the page before it.
    await action(app, 'nav.back')
    await waitNoScreen(app, tabId)
    await waitTab(app, tabId, '/page/Start')
  } finally {
    await silent.close()
  }
})

test('[NV-13] a screen that comes up while the user types in Orbit’s own UI leaves the keyboard there', async () => {
  orbit = await launchOrbit({ args: [`--proxy-bypass-list=${MISSING_HOST}`] })
  const { app, shell } = orbit
  const tabId = await tabOn(app, 'Start')
  // The user names a new folder in the sidebar, which has the keyboard (as after a click there)...
  await action(app, 'folder.new')
  const field = shell.getByTestId('rename-field')
  await expect(field).toBeFocused()
  await cmd(app, 'spaces.focusShell')
  await expect.poll(() => focusedUrl(app)).toContain('view=shell')
  // ...as the page fails to load: its screen shows, and the keyboard stays in the field.
  await cmd(app, 'tabs.navigate', { tabId, url: `http://${MISSING_HOST}/` })
  const shown = await shownOn(app, tabId)
  expect(shown.focused).toBe(false)
  expect(await focusedUrl(app)).toContain('view=shell')
  await expect(field).toBeFocused()
})

test('[NV-13] a form still on its way isn’t stopped by Orbit’s time limit: it may be uploading', async () => {
  orbit = await launchOrbit({ env: { ORBIT_E2E_LOAD_TIMEOUT_MS: String(TIME_LIMIT) } })
  const { app } = orbit
  const silent = await startSilentServer()
  try {
    const form = fx.url(`/upload?to=${encodeURIComponent(silent.url('/upload'))}`)
    const sending = await newTab(app, form)
    await waitTab(app, sending, '/upload')
    await clickInPage(app, form, '#send')
    await expect.poll(() => silent.hits('/upload')).toBe(1)
    // A plain load from the same server, started after the form: Orbit gives up on that one, and
    // would have given up on the form first.
    const plain = await newTab(app, silent.url('/plain'))
    await waitScreen(app, (s) => s.tabId === plain)
    expect((await pageScreens(app)).filter((s) => s.tabId === sending)).toEqual([])
    expect((await tab(app, sending))?.loading).toBe(true)
  } finally {
    await silent.close()
  }
})

test('[NV-13] a certificate no one trusts: “Your connection is not private” with Back to safety on the keyboard; going on takes Advanced, then Proceed, and is remembered for the site', async () => {
  test.skip(!canMakeCertificate(), 'needs openssl to make a certificate')
  orbit = await launchOrbit()
  const { app } = orbit
  const secure = await startSecureFixtures()
  try {
    const host = `localhost:${secure.port}`
    const tabId = await tabOn(app, 'Start')
    const url = secure.url('/page/Secret')
    await cmd(app, 'tabs.navigate', { tabId, url })
    const shown = await shownOn(app, tabId)
    expect(shown).toMatchObject({
      kind: 'cert',
      title: 'Your connection is not private',
      site: host,
      code: 'ERR_CERT_AUTHORITY_INVALID',
      url,
    })
    const view = await screenPage(app, shown.id)
    await expect(view.getByTestId('page-screen-message')).toHaveText(
      'Someone might be trying to steal your information from this site, such as passwords, messages or card numbers.',
    )
    const safety = view.getByTestId('page-screen-action')
    await expect(safety).toHaveText('Back to safety')
    await expect(safety).toBeFocused()
    // Going on is behind Advanced.
    await expect(view.getByTestId('page-screen-proceed')).toHaveCount(0)
    // Enter goes back to safety: the page before. Nothing reached the site.
    await view.keyboard.press('Enter')
    await waitNoScreen(app, tabId)
    await waitTab(app, tabId, '/page/Start')
    expect(secure.seen()).toEqual([])

    // A tab with nowhere to go back to closes.
    const fresh = await newTab(app, url)
    const freshScreen = await shownOn(app, fresh)
    expect(freshScreen.kind).toBe('cert')
    await (await screenPage(app, freshScreen.id)).getByTestId('page-screen-action').click()
    await expect.poll(async () => (await tab(app, fresh)) === undefined).toBe(true)

    // Advanced, then Proceed: the page loads.
    await cmd(app, 'tabs.navigate', { tabId, url })
    const again = await shownOn(app, tabId)
    const view2 = await screenPage(app, again.id)
    await view2.getByTestId('page-screen-advanced').click()
    await expect(view2.getByTestId('page-screen-details')).toContainText(
      `The server couldn’t prove that it’s ${host}: its security certificate isn’t trusted by your device.`,
    )
    const proceed = view2.getByTestId('page-screen-proceed')
    await expect(proceed).toHaveText(`Proceed to ${host} (unsafe)`)
    await proceed.click()
    await waitNoScreen(app, tabId)
    await waitTab(app, tabId, '/page/Secret')
    // Remembered for the site until Orbit quits: another of its pages loads at once.
    const other = await newTab(app, secure.url('/page/Other'))
    await waitTab(app, other, '/page/Other')
    expect((await pageScreens(app)).filter((s) => s.tabId === other)).toEqual([])
  } finally {
    await secure.close()
  }
})

test('[NV-13] offline: “No internet”; when the network comes back while it shows, the page loads again, once', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const tabId = await tabOn(app, 'Start')
  const network = await networkSwitch(app, '/page/Start')
  await network.offline(true)
  try {
    await cmd(app, 'tabs.navigate', { tabId, url: fx.url('/page/Later') })
    const shown = await shownOn(app, tabId)
    expect(shown).toMatchObject({
      kind: 'offline',
      title: 'No internet',
      message: 'Your device isn’t connected to the internet.',
      code: 'ERR_INTERNET_DISCONNECTED',
    })
    // The network comes back. The engine tells Orbit's view (`online`; the emulation here is the
    // page's only, so the test says it), and the page loads again by itself.
    await network.offline(false)
    await backOnline(await screenPage(app, shown.id))
    await waitNoScreen(app, tabId)
    await waitTab(app, tabId, '/page/Later')

    // Once: a retry that fails as well waits for Try again.
    await network.offline(true)
    await cmd(app, 'tabs.navigate', { tabId, url: fx.url('/page/Again') })
    const first = await shownOn(app, tabId)
    const navigations = await countNavigations(app, tabId)
    const view = await screenPage(app, first.id)
    await backOnline(view)
    const second = await waitScreen(app, (s) => s.tabId === tabId && s.id !== first.id)
    expect(await navigations()).toBe(1)
    await backOnline(view)
    // What the view sends reaches main in order: once this is answered, so was `online`.
    await view.evaluate(() =>
      (window as unknown as { orbit: { invoke: (n: string, a: unknown) => Promise<unknown> } }).orbit.invoke(
        'pages.screenContent',
        {},
      ),
    )
    expect(await navigations()).toBe(1)
    expect((await waitScreen(app, (s) => s.tabId === tabId)).id).toBe(second.id)
    await network.offline(false)
    await view.getByTestId('page-screen-action').click()
    await waitNoScreen(app, tabId)
    await waitTab(app, tabId, '/page/Again')
  } finally {
    await network.close()
  }
})
