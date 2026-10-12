/**
 * Downloads and DevTools (DL-01, DL-02, DL-05, DL-10, DL-15, DL-16, DT-01, DT-02, DT-03, DT-14), about
 * 80 s, for the "feels right" sign-off (D48). Links on a page download: each file flies into the Library
 * button, one flight per file. Hovering the button shows the recent files. A download cut off offers
 * Resume and goes on where it stopped. The Library's Downloads: a running download paused and resumed,
 * search by name, and a PDF and a picture previewed in a Peek. A private window's download is listed in
 * that window only, and leaves with it. DevTools: F12 docks them in the page's view and closes them; the
 * console key; docked at the bottom, with the find bar on the page's own area; each tab with its own; the
 * element picker from the command bar; ⇧⌘R reloads.
 *
 * Every file comes from the fixture server's /dl/ (record.mjs). Test runs never start another app, and a
 * download's menu never shows (ORBIT_E2E): the scenario picks Pause through the downloads test hook,
 * as the e2e tests do. DevTools' dock menu is DevTools' own: the scenario calls what it does.
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

/** The pointer to the middle of a locator, in a view placed at `offset` on the display. */
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

/** A click where the on-screen pointer is, as a person's. */
const xClick = () => new Promise((r) => execFile('xdotool', ['click', '1'], () => r()))

/** Points at a control of a view placed at `offset` and clicks it. */
async function click(control, offset, steps = 14) {
  await pointAt(control, offset, steps)
  await control.click()
}

const MOD = process.platform === 'darwin' ? 'meta' : 'control'

/** A key pressed in a tab's page, as with the page focused. */
const press = (t, tabId, keyCode, modifiers = []) =>
  t.app.evaluate(
    (_e, [id, key, mods]) => {
      const page = globalThis.__orbit.ctx.tabs.get(id).webContents
      page.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: mods })
      page.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: mods })
    },
    [tabId, keyCode, modifiers],
  )

/** Where a tab's page sits in its window. */
const tabBounds = (t, tabId) => t.app.evaluate((_e, id) => globalThis.__orbit.ctx.tabs.get(id).getBounds(), tabId)

/** The pointer to a file's link on a tab's page, in a window whose content starts at `offset`; then a click. */
async function clickFile(t, tabId, file, offset = { x: 0, y: 0 }, steps = 18) {
  const view = await tabBounds(t, tabId)
  const box = await t.app.evaluate(
    (_e, [id, f]) =>
      globalThis.__orbit.ctx.tabs
        .get(id)
        .webContents.executeJavaScript(
          `(() => { const r = document.querySelector('[data-file="${f}"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`,
        ),
    [tabId, file],
  )
  await pointerTo(offset.x + view.x + box.x, offset.y + view.y + box.y, steps)
  await t.sleep(250)
  await xClick()
}

const downloads = (t, profileId) => t.run('downloads.list', profileId ? { profileId } : {})
const download = async (t, file) => (await downloads(t)).find((d) => d.filename === file)

/** The window's view of a kind (`library`, `tools`, `overlay`…), by its page's address. */
const viewPage = (t, view) =>
  waitFor(t, () => t.app.windows().find((p) => !p.isClosed() && p.url().includes(`view=${view}`)))

/** The page of one window's view (`shell`, `overlay`…). */
const viewOf = (t, view, windowId) =>
  waitFor(t, async () => {
    for (const p of t.app.windows()) {
      if (p.isClosed() || !p.url().includes(`view=${view}`)) continue
      if ((await p.evaluate(() => globalThis.orbit?.windowId).catch(() => '')) === windowId) return p
    }
  })

/** Runs a script in a tab's DevTools, while they are open. */
const inDevtools = (t, tabId, code) =>
  t.app.evaluate(
    (_e, [id, script]) => {
      const page = globalThis.__orbit.ctx.tabs.get(id)?.webContents
      return page?.isDevToolsOpened() ? page.devToolsWebContents.executeJavaScript(script) : null
    },
    [tabId, code],
  )

let mainId = ''
let notes = ''
let kit = ''
let filesUrl = ''

/** Unrecorded: a Field notes tab (slow to answer, so a reload shows) and the Field kit page of files, shown. */
export async function setup(t) {
  const s = await t.state()
  const main = Object.values(s.windows).find((w) => w.kind === 'main')
  mainId = main.id
  // A tab loads once it is shown: each is shown in turn.
  notes = await t.run('tabs.create', {
    url: `${t.fx.url('Field notes')}?wait=700`,
    spaceId: main.spaceId,
    activate: false,
  })
  await t.run('tabs.activate', { tabId: notes })
  await waitFor(t, async () => (await t.state()).tabs[notes]?.title === 'Field notes')
  filesUrl = new URL('files/Field%20kit', t.fx.url('')).href
  kit = await t.run('tabs.create', { url: filesUrl, spaceId: main.spaceId, activate: false })
  await t.run('tabs.activate', { tabId: kit })
  await waitFor(t, async () => (await t.state()).tabs[kit]?.title === 'Field kit')
  await t.sleep(600)
}

export default async function (t) {
  t0 = performance.now()
  const { shell } = t
  await pointerTo(760, 470, 1)
  await t.sleep(400)

  // DL-01, DL-02: a link downloads its file, which flies into the Library button.
  mark('download')
  await clickFile(t, kit, 'Survey report.pdf')
  await waitFor(t, async () => (await download(t, 'Survey report.pdf'))?.state === 'completed')
  await t.sleep(1500)

  // DL-02: one flight per download; the long one keeps going.
  mark('two')
  await clickFile(t, kit, 'Site photo.png', undefined, 12)
  await clickFile(t, kit, 'Field recordings.zip', undefined, 10)
  await waitFor(t, async () => (await download(t, 'Field recordings.zip'))?.state === 'progressing')
  await t.sleep(1600)

  // DL-05: hovering the Library button shows the recent files; they go when the pointer leaves.
  mark('recent')
  const button = shell.getByTestId('library-button')
  await pointAt(button, undefined, 22)
  await button.hover()
  const recent = shell.getByTestId('recent-files')
  await recent.waitFor({ timeout: 4000 })
  await t.sleep(1300)
  const first = recent.getByTestId('recent-file').first()
  await pointAt(first, undefined, 10)
  await first.hover()
  await t.sleep(1200)
  await pointerTo(760, 470, 18)
  await shell.mouse.move(760, 470)
  await t.sleep(1000)

  // DL-15: a download cut off offers Resume, and goes on where it stopped.
  mark('cut')
  await clickFile(t, kit, 'Station log.csv', undefined, 16)
  await waitFor(t, async () => (await download(t, 'Station log.csv'))?.state === 'interrupted', 20_000)
  await t.sleep(1400)
  t.fx.repair('Station log.csv')
  const cutRow = shell.locator('[data-testid="download-row"][title="Station log.csv"]')
  await cutRow.waitFor({ timeout: 4000 })
  await pointAt(cutRow, undefined, 18)
  await cutRow.hover()
  await t.sleep(500)
  await click(cutRow.getByTestId('download-resume'), undefined, 8)
  await waitFor(t, async () => (await download(t, 'Station log.csv'))?.state === 'progressing')
  await t.sleep(1200)

  // DL-10: the Library's Downloads, newest first, the running ones with their progress.
  mark('library')
  await click(button, undefined, 18)
  const lib = await viewPage(t, 'library')
  await lib.getByTestId('library').waitFor({ timeout: 8000 })
  const libAt = await t.app.evaluate((_e, w) => globalThis.__orbit.ctx.windows.pageArea(w), mainId)
  const nav = lib.locator('[data-testid="library-nav-item"][data-section-id="downloads"]')
  if ((await lib.getByTestId('library-section').getAttribute('data-section-id')) !== 'downloads') {
    await t.sleep(600)
    await click(nav, libAt, 16)
  }
  await lib.getByTestId('downloads-section').waitFor({ timeout: 8000 })
  await t.sleep(1500)

  // DL-15: Pause from the row's menu, then the row's Resume.
  mark('pause')
  const row = (file) => lib.locator(`[data-testid="library-download"][title="${file}"]`)
  const long = row('Field recordings.zip')
  await pointAt(long, libAt, 16)
  await long.hover()
  await t.sleep(500)
  await click(long.getByTestId('library-download-more'), libAt, 8)
  await t.app.evaluate(() => globalThis.__orbitDownloads.clickMenu('Pause'))
  await waitFor(t, async () => (await long.getAttribute('data-state')) === 'paused')
  await t.sleep(1800)
  await click(long.getByTestId('library-download-resume'), libAt, 6)
  await waitFor(t, async () => (await long.getAttribute('data-state')) === 'progressing')
  await t.sleep(1300)

  // DL-10: search by name.
  mark('search')
  const search = lib.getByTestId('downloads-search')
  await click(search, libAt, 18)
  await t.type(lib, 'photo', 120)
  await t.sleep(1400)
  await lib.keyboard.press(`${t.mod}+A`)
  await lib.keyboard.press('Backspace')
  await t.sleep(900)

  // DL-10: a row previews its file in a Peek over the Library: a PDF, then a picture.
  mark('preview')
  await click(row('Survey report.pdf'), libAt, 18)
  await waitFor(
    t,
    async () => Object.values((await t.state()).windows).find((w) => w.id === mainId)?.overlay.kind === 'peek',
  )
  await t.sleep(2400)
  await t.run('peek.close')
  await t.sleep(900)
  await click(row('Site photo.png'), libAt, 12)
  await waitFor(
    t,
    async () => Object.values((await t.state()).windows).find((w) => w.id === mainId)?.overlay.kind === 'peek',
  )
  await t.sleep(2200)
  await t.run('peek.close')
  await t.sleep(900)
  await lib.keyboard.press('Escape')
  await waitFor(t, async () => (await lib.getByTestId('library').getAttribute('data-open')) === 'false')
  await waitFor(t, async () => (await downloads(t)).every((d) => d.state === 'completed'), 30_000)
  await t.sleep(900)

  // DL-16: a private window lists its own download only, and it leaves with the window.
  mark('private')
  await t.key('Mod+Shift+N')
  const priv = await waitFor(t, async () => Object.values((await t.state()).windows).find((w) => w.kind === 'private'))
  const privShell = await viewOf(t, 'shell', priv.id)
  const privBar = await viewOf(t, 'overlay', priv.id)
  const privAt = await t.app.evaluate((_e, w) => globalThis.__orbit.ctx.windows.get(w)?.getContentBounds(), priv.id)
  await waitFor(t, () => privBar.getByTestId('command-input').isVisible())
  await t.sleep(600)
  await t.type(privBar, filesUrl.replace('http://', ''), 40)
  await t.sleep(300)
  await privBar.keyboard.press('Enter')
  const privTab = await waitFor(t, async () =>
    Object.entries((await t.state()).tabs).find(
      ([, tab]) => tab.spaceId === priv.spaceId && tab.title === 'Field kit' && tab.loading === false,
    ),
  )
  await t.sleep(900)
  // A private window has no Library button: its sidebar's row and its Downloads list (Ctrl+J here, DL-14)
  // show its own session's downloads (DL-16).
  mark('private-download')
  await clickFile(t, privTab[0], 'Site photo.png', privAt, 18)
  await waitFor(t, async () => (await privShell.getByTestId('downloads-tray').getAttribute('data-count')) === '1')
  await t.sleep(1500)
  const flyoutNames = async (shellPage, overlayPage) => {
    await shellPage.keyboard.press(`${t.mod}+J`)
    await overlayPage.getByTestId('downloads-flyout').waitFor({ timeout: 4000 })
    return overlayPage.getByTestId('flyout-download-name').allTextContents()
  }
  console.error(`[check] private window's downloads: ${(await flyoutNames(privShell, privBar)).join(', ')}`)
  await t.sleep(2000)
  await privShell.keyboard.press(`${t.mod}+J`)
  await t.sleep(800)
  mark('private-close')
  await t.app.evaluate(async (_e, id) => {
    await new Promise((r) => setImmediate(r))
    globalThis.__orbit.ctx.windows.get(id)?.close()
  }, priv.id)
  await t.sleep(1000)
  mark('after-private')
  const mainBar = await viewOf(t, 'overlay', mainId)
  console.error(`[check] main window's downloads after: ${(await flyoutNames(shell, mainBar)).join(', ')}`)
  await t.sleep(2000)
  await shell.keyboard.press(`${t.mod}+J`)
  await t.sleep(800)

  // DT-01: F12 docks DevTools in the page's view, and closes them; the console key opens the Console.
  mark('devtools')
  const notesRow = shell.getByTestId('tab-row').filter({ hasText: 'Field notes' })
  await click(notesRow, undefined, 22)
  await waitFor(t, async () => (await t.state()).tabs[notes]?.loading === false)
  await pointerTo(900, 600, 16)
  await t.sleep(900)
  await t.key('F12')
  await waitFor(t, async () => (await t.run('devtools.state', { tabId: notes }))?.open)
  await t.sleep(2200)
  await t.key('F12')
  await waitFor(t, async () => !(await t.run('devtools.state', { tabId: notes }))?.open)
  await t.sleep(1000)
  await t.key('Shift+Mod+J')
  await waitFor(t, async () => (await t.run('devtools.state', { tabId: notes }))?.open)
  await t.sleep(2000)

  // DT-03: docked at the bottom (what DevTools' dock menu does); the find bar stays on the page's area.
  mark('dock')
  await waitFor(t, () =>
    inDevtools(
      t,
      notes,
      `(async () => { const legacy = await import('./ui/legacy/legacy.js'); legacy.DockController.DockController.instance().setDockSide('bottom'); return true })()`,
    ),
  )
  await t.sleep(1800)
  await press(t, notes, 'F', [MOD])
  const tools = await viewPage(t, 'tools')
  await waitFor(t, () => tools.getByTestId('find-input').isVisible())
  await t.sleep(300)
  await t.type(tools, 'demo', 120)
  await t.sleep(1300)
  await tools.keyboard.press('Escape')
  await t.sleep(800)
  // Each tab has its own DevTools, shown and hidden with its page.
  mark('tabs')
  const kitRow = shell.getByTestId('tab-row').filter({ hasText: 'Field kit' })
  await click(kitRow, undefined, 18)
  await t.sleep(1300)
  await click(notesRow, undefined, 10)
  await t.sleep(1500)

  // DT-02: the element picker from the command bar; what's under the pointer is picked.
  mark('inspect')
  await t.key('Mod+T')
  const bar = await t.overlay()
  await waitFor(t, () => bar.getByTestId('command-input').isVisible())
  await t.sleep(300)
  await t.type(bar, 'Inspect element', 90)
  await waitFor(t, async () =>
    (await bar.getByTestId('command-result').first().innerText()).includes('Inspect Element'),
  )
  await t.sleep(600)
  await bar.keyboard.press('Enter')
  await t.sleep(700)
  const view = await tabBounds(t, notes)
  const card = async (n) =>
    t.app.evaluate(
      (_e, [id, i]) =>
        globalThis.__orbit.ctx.tabs
          .get(id)
          .webContents.executeJavaScript(
            `(() => { const r = document.querySelectorAll('.card')[${i}].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`,
          ),
      [notes, n],
    )
  const one = await card(0)
  await pointerTo(view.x + one.x, view.y + one.y, 20)
  await t.sleep(1100)
  const two = await card(1)
  await pointerTo(view.x + two.x, view.y + two.y, 14)
  await t.sleep(900)
  await xClick()
  await t.sleep(1800)

  // DT-14: ⇧⌘R reloads the page, bypassing the cache.
  mark('hard-reload')
  await t.key('Shift+Mod+R')
  await waitFor(t, async () => (await t.state()).tabs[notes]?.loading === true, 3000).catch(() => {})
  await waitFor(t, async () => (await t.state()).tabs[notes]?.loading === false)
  await t.sleep(1600)
  mark('close-devtools')
  await t.key('F12')
  await waitFor(t, async () => !(await t.run('devtools.state', { tabId: notes }))?.open)
  await t.sleep(1200)
  mark('end')
}
