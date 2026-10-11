/**
 * Settings and updates (ST-01, ST-02, ST-04, ST-05, ST-06, ST-09, ST-17, UP-10, UP-12, AP-05), about 60 s,
 * for the "feels right" sign-off (D48). ⌘, opens the one Settings window. Profiles: Default renamed in
 * place, and Work, whose Delete is off while a Space uses it, and says why. Archive timing per profile:
 * Work follows Default until set. The default search engine, which the command bar then names. The
 * command bar's Link Settings brings the same Settings window back, at Links: where links from other apps
 * open, and Peek's options. About: the version and engine, and Check Now finding a newer version. ⌘W
 * closes Settings only. The sidebar's update pill opens on hover, and opens the release's page in a tab;
 * a security release says so. A private window: near-black, with hover readable on it. Last, ⌘, opens
 * Settings at the section it showed last.
 *
 * The update feed is the fixture server's /feed.json, set by command before the recording (it stands in
 * for typing its address into General → Update feed), so every check stays on this computer. Until the
 * scenario offers a version there, Orbit is up to date.
 *
 * Each step prints a `[mark] <name> <ms>` line on stderr: its time since the scenario began.
 * record.mjs begins it 0.7 s after the recording starts, so a step shows about 0.7 s later in the clip.
 */
import { execFile } from 'node:child_process'

let t0 = 0
const mark = (name) => console.error(`[mark] ${name} ${Math.round(performance.now() - t0)}`)

/** Moves the on-screen pointer (display coordinates) in eased steps. */
let at = null
async function pointerTo(x, y, steps = 16) {
  const from = at ?? { x, y }
  for (let i = 1; i <= steps; i++) {
    const k = 0.5 - 0.5 * Math.cos((Math.PI * i) / steps)
    await new Promise((r) =>
      execFile(
        'xdotool',
        ['mousemove', String(Math.round(from.x + (x - from.x) * k)), String(Math.round(from.y + (y - from.y) * k))],
        () => r(),
      ),
    )
  }
  at = { x, y }
}

/** The pointer to the middle of a locator, in a page whose content starts at `offset` on the display. */
async function pointAt(locator, offset = { x: 0, y: 0 }, steps = 16) {
  const box = await locator.boundingBox()
  if (box) await pointerTo(offset.x + box.x + box.width / 2, offset.y + box.y + box.height / 2, steps)
}

async function waitFor(t, test, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await test()
    if (v) return v
    await t.sleep(40)
  }
  throw new Error('timed out')
}

/** The Settings window's page, drawn, and where its content is on the display. */
async function settingsWindow(t) {
  const page = await waitFor(t, () => t.app.windows().find((p) => p.url().includes('view=settings') && !p.isClosed()))
  await page.getByTestId('settings').waitFor({ timeout: 8000 })
  const offset = await t.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.webContents.getURL().includes('view=settings'),
    )
    return win ? win.getContentBounds() : { x: 0, y: 0 }
  })
  return { page, offset }
}

/** How many Settings windows exist (ST-01: one at most). */
const settingsCount = (t) =>
  t.app.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.webContents.getURL().includes('view=settings'))
        .length,
  )

/** Points at a control of a window's page, brought into its view first, and clicks it. */
async function click(control, offset, steps = 12) {
  await control.scrollIntoViewIfNeeded()
  await pointAt(control, offset, steps)
  await control.click()
}

/** Points at a select and picks an option by its label. */
async function choose(select, offset, label, steps = 12) {
  await select.scrollIntoViewIfNeeded()
  await pointAt(select, offset, steps)
  await select.selectOption({ label })
}

/** Brings the browser window to the front, as a click on it would with a window manager. */
const focusBrowser = (t, id) =>
  t.app.evaluate((_e, w) => {
    globalThis.__orbit.ctx.windows.get(w)?.focus()
  }, id)

/** A click where the on-screen pointer is, as a person's: it moves the keyboard to what it lands on. */
const xClick = () => new Promise((r) => execFile('xdotool', ['click', '1'], () => r()))

/** The page of one window's view (`shell`, `overlay`…). */
const viewOf = (t, view, windowId) =>
  waitFor(t, async () => {
    for (const p of t.app.windows()) {
      if (p.isClosed() || !p.url().includes(`view=${view}`)) continue
      if ((await p.evaluate(() => globalThis.orbit?.windowId).catch(() => '')) === windowId) return p
    }
  })

let mainId = ''
let work = ''
let next = ''
let security = ''

/**
 * Unrecorded: a tab, so the page area isn't empty; a Client Space that uses a Work profile; the update
 * feed, checked once: up to date.
 */
export async function setup(t) {
  const s = await t.state()
  const main = Object.values(s.windows).find((w) => w.kind === 'main')
  mainId = main.id
  const tab = await t.run('tabs.create', { url: t.fx.url('Field notes'), spaceId: main.spaceId, activate: false })
  await t.run('tabs.activate', { tabId: tab })
  await waitFor(t, async () => (await t.state()).tabs[tab]?.title === 'Field notes')
  const client = await t.run('spaces.create', { name: 'Client', activate: false })
  work = await t.run('profiles.create', { name: 'Work', assignSpaceId: client })
  // Two releases newer than this build: a plain one, then a security one.
  const { version } = await t.run('settings.buildInfo')
  const [major, minor] = version.split(/[.-]/).map(Number)
  next = `${major}.${minor + 1}.0`
  security = `${major}.${minor + 1}.1`
  await t.run('updates.setFeed', { url: t.fx.url('feed.json') })
  await waitFor(t, async () => (await t.state()).updates?.state === 'current')
  await t.sleep(600)
}

export default async function (t) {
  t0 = performance.now()
  const { shell } = t
  await pointerTo(760, 470, 1)
  await t.sleep(400)

  // ST-01: ⌘, opens Settings, a window of its own.
  mark('open')
  await t.key('Mod+Comma')
  let { page, offset } = await settingsWindow(t)
  await t.sleep(1400)

  // ST-04: Profiles, Default first. Default is renamed in place, with no Save button.
  mark('profiles')
  await click(page.getByTestId('settings-tab-profiles'), offset, 18)
  await page.getByTestId('profile-list').waitFor({ timeout: 8000 })
  await t.sleep(1000)
  const name = page.getByTestId('profile-name')
  await click(name, offset, 14)
  await page.keyboard.press(`${t.mod}+A`)
  await t.type(page, 'Personal', 110)
  await page.keyboard.press('Enter')
  await t.sleep(1000)
  // Work is used by the Client Space: its Delete is off, and says why.
  mark('work')
  await click(page.getByTestId(`profile-${work}`), offset, 14)
  await t.sleep(700)
  const del = page.getByTestId('profile-delete')
  await del.scrollIntoViewIfNeeded()
  await t.sleep(300)
  await pointAt(del, offset, 14)
  await t.sleep(1600)

  // ST-05: archive timing per profile. Default to 7 days; Work follows Default until set.
  mark('archive')
  await click(page.getByTestId('profile-list').getByRole('option').first(), offset, 16)
  await t.sleep(600)
  await choose(page.getByTestId('archive-after-p-default'), offset, '7 days', 14)
  await t.sleep(1000)
  await click(page.getByTestId(`profile-${work}`), offset, 14)
  await t.sleep(600)
  await pointAt(page.getByTestId(`archive-after-${work}`), offset, 14)
  await t.sleep(1500)

  // ST-06: the default search engine, which the command bar then names.
  mark('search')
  await click(page.getByTestId('settings-tab-search'), offset, 16)
  await t.sleep(900)
  await choose(page.getByTestId('search-engine-p-default'), offset, 'DuckDuckGo', 14)
  await t.sleep(1000)
  await pointerTo(150, 420, 18)
  await focusBrowser(t, mainId)
  await t.sleep(700)
  mark('search-bar')
  await t.key('Mod+T')
  const bar = await t.overlay()
  await waitFor(t, () => bar.getByTestId('command-input').isVisible())
  await t.sleep(300)
  await t.type(bar, 'tide tables', 110)
  await waitFor(t, async () => (await bar.getByTestId('command-result').first().innerText()).includes('DuckDuckGo'))
  await t.sleep(1500)
  await bar.keyboard.press('Escape')
  await t.sleep(800)

  // ST-02, ST-01: the command bar's Link Settings brings the same Settings window back, at Links.
  mark('link-settings')
  await t.key('Mod+T')
  await waitFor(t, () => bar.getByTestId('command-input').isVisible())
  await t.sleep(300)
  await t.type(bar, 'Link settings', 90)
  const action = bar.getByTestId('command-result').first()
  await waitFor(t, async () => (await action.innerText()).includes('Link Settings'))
  await t.sleep(700)
  await bar.keyboard.press('Enter')
  ;({ page, offset } = await settingsWindow(t))
  await waitFor(t, async () => (await page.getByTestId('settings-content').getAttribute('data-section')) === 'links')
  console.error(`[check] settings windows: ${await settingsCount(t)}`)
  await t.sleep(1300)

  // ST-09: links from other apps open in the most recent Space; Peek's shift-click off.
  mark('links')
  await choose(page.getByTestId('external-links'), offset, 'The most recent Space', 16)
  await t.sleep(1000)
  await click(page.getByTestId('peek-shift-click'), offset, 14)
  await t.sleep(1300)

  // ST-17: About: the version and engine; Check Now finds a newer version (UP-10).
  mark('about')
  await click(page.getByTestId('settings-tab-about'), offset, 18)
  await page.getByTestId('about-version').waitFor({ timeout: 8000 })
  await t.sleep(1500)
  t.fx.offer({ version: next, summary: 'Faster Spaces and a tidier Library.' })
  mark('check')
  await click(page.getByTestId('updates-check'), offset, 16)
  await waitFor(t, async () => (await page.getByTestId('updates-status').getAttribute('data-state')) === 'available')
  await t.sleep(1800)

  // ST-01: ⌘W in Settings closes Settings only.
  mark('close')
  const tabsBefore = Object.keys((await t.state()).tabs).length
  const closed = page.waitForEvent('close')
  await page.keyboard.press(`${t.mod}+W`).catch((err) => {
    if (!page.isClosed()) throw err
  })
  await closed
  console.error(`[check] tabs before ⌘W: ${tabsBefore}, after: ${Object.keys((await t.state()).tabs).length}`)
  await t.sleep(1200)

  // UP-10: the sidebar's pill opens on hover; a click opens the release's page in a tab.
  mark('banner')
  const pill = shell.getByTestId('update-banner-open')
  await pill.waitFor({ timeout: 8000 })
  await pointAt(pill, undefined, 22)
  await t.sleep(1600)
  await pill.click()
  await waitFor(t, async () =>
    Object.values((await t.state()).tabs).some((tab) => tab.title === `Orbit ${next}` && tab.loading === false),
  )
  await t.sleep(1200)
  // A click on the release's page, which takes the keyboard from the pill.
  await pointerTo(900, 560, 18)
  await xClick()
  await t.sleep(1200)

  // UP-12: a security release says so.
  mark('security')
  t.fx.offer({ version: security, security: true })
  await t.run('updates.check')
  await waitFor(t, async () => (await shell.getByTestId('update-banner').getAttribute('data-kind')) === 'security')
  await t.sleep(1600)
  await pointAt(pill, undefined, 20)
  await t.sleep(1800)
  await pointerTo(760, 470, 18)
  await t.sleep(500)

  // AP-05: a private window: near-black, labelled Private, with hover readable on black.
  mark('private')
  await t.key('Mod+Shift+N')
  const priv = await waitFor(t, async () => Object.values((await t.state()).windows).find((w) => w.kind === 'private'))
  const privShell = await viewOf(t, 'shell', priv.id)
  const privBar = await viewOf(t, 'overlay', priv.id)
  const privAt = await t.app.evaluate((_e, w) => globalThis.__orbit.ctx.windows.get(w)?.getContentBounds(), priv.id)
  // Its command bar is open, as in any empty window: two pages, typed there.
  for (const [i, name] of ['Recipes', 'Atlas'].entries()) {
    if (i > 0) await privShell.keyboard.press(`${t.mod}+T`)
    await waitFor(t, () => privBar.getByTestId('command-input').isVisible())
    await t.sleep(700)
    await t.type(privBar, t.fx.url(name).replace('http://', ''), 45)
    await t.sleep(400)
    await privBar.keyboard.press('Enter')
    await waitFor(t, async () =>
      Object.values((await t.state()).tabs).some((tab) => tab.spaceId === priv.spaceId && tab.title === name),
    )
    await t.sleep(900)
  }
  mark('private-hover')
  const rows = privShell.getByTestId('tab-row')
  await waitFor(t, async () => (await rows.count()) >= 2)
  await pointAt(rows.nth(0), privAt, 20)
  await t.sleep(900)
  await pointAt(rows.nth(1), privAt, 10)
  await t.sleep(1100)
  mark('private-close')
  await t.app.evaluate(async (_e, id) => {
    await new Promise((r) => setImmediate(r))
    globalThis.__orbit.ctx.windows.get(id)?.close()
  }, priv.id)
  await t.sleep(1200)

  // ST-01: Settings opens again at the section it showed last.
  mark('reopen')
  await t.key('Mod+Comma')
  ;({ page } = await settingsWindow(t))
  await t.sleep(1800)
  const gone = page.waitForEvent('close')
  await page.keyboard.press(`${t.mod}+W`).catch((err) => {
    if (!page.isClosed()) throw err
  })
  await gone
  await t.sleep(900)
  mark('end')
}
