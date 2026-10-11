/**
 * Import (IM-04, IM-06, IM-07, IM-12, IM-13, IM-15), about 65 s, for the "feels right" sign-off (D48).
 * The command bar's Import from Another Browser: Chrome's Work profile; its bookmarks chosen in their
 * tree, with a count that follows each change and Select none / all; a new Space to receive them; the
 * import, its summary, and Done, which shows the pinned folder. The history came too: a familiar site
 * completes in the command bar at once. A pasted list of links becomes a pinned folder the person names;
 * the same list pasted on the sidebar opens the import at it, and makes a second folder, " (2)". A
 * bookmarks file chosen with From a file… goes the same way.
 *
 * The browsers are the made-up ones under tests/fixtures/import, never one on this computer, and the
 * system's file picker is stood in for (as the e2e tests do), so nothing waits for a person.
 *
 * Each step prints a `[mark] <name> <ms>` line on stderr: its time since the scenario began.
 * record.mjs begins it 0.7 s after the recording starts, so a step shows about 0.7 s later in the clip.
 */
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'

let t0 = 0
const mark = (name) => console.error(`[mark] ${name} ${Math.round(performance.now() - t0)}`)

const FIXTURES = resolve(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'import')
export const env = {
  ORBIT_IMPORT_PLACES: JSON.stringify([
    { browser: 'chrome', dir: resolve(FIXTURES, 'chrome') },
    { browser: 'firefox', dir: resolve(FIXTURES, 'firefox') },
  ]),
}

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

/** The import window's page, drawn, and where its content is on the display. */
async function importWindow(t) {
  const page = await waitFor(t, () => t.app.windows().find((p) => p.url().includes('view=import') && !p.isClosed()))
  await page.getByTestId('import-flow').waitFor({ timeout: 8000 })
  const offset = await t.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.webContents.getURL().includes('view=import'),
    )
    return win ? win.getContentBounds() : { x: 0, y: 0 }
  })
  return { page, offset }
}

/** Points at a control of the import window and clicks it. */
async function click(page, offset, testId, steps = 12) {
  const control = page.getByTestId(testId)
  await pointAt(control, offset, steps)
  await control.click()
}

/** On through the steps (with a look at each) until the import has run, then Done, which closes the window. */
async function finish(t, page, offset) {
  for (let i = 0; i < 4; i++) {
    if ((await page.getByTestId('import-flow').getAttribute('data-step')) === 'progress') break
    await click(page, offset, 'import-next', 10)
    await t.sleep(900)
  }
  await waitFor(
    t,
    async () => (await page.getByTestId('import-progress').getAttribute('data-phase')) === 'done',
    30_000,
  )
  await t.sleep(1700)
  mark('done')
  const closed = page.waitForEvent('close')
  await click(page, offset, 'import-done').catch((err) => {
    if (!page.isClosed()) throw err
  })
  await closed
}

let links = ''

/** Unrecorded: a tab, so the page area isn't empty; the list of links a person copied elsewhere. */
export async function setup(t) {
  const s = await t.state()
  const home = Object.values(s.windows).find((w) => w.kind === 'main').spaceId
  const tab = await t.run('tabs.create', { url: t.fx.url('Field notes'), spaceId: home, activate: false })
  await t.run('tabs.activate', { tabId: tab })
  await waitFor(t, async () => (await t.state()).tabs[tab]?.title === 'Field notes')
  links = [
    `Morning paper — ${t.fx.url('Morning paper')}`,
    `Trail map — ${t.fx.url('Trail map')}`,
    `${t.fx.url('Bread baking')}`,
    `Hotel shortlist — ${t.fx.url('Hotel shortlist')}`,
    `Packing list — ${t.fx.url('Packing list')}`,
  ].join('\n')
  await t.sleep(600)
}

export default async function (t) {
  t0 = performance.now()
  const { shell } = t
  await pointerTo(900, 520, 1)
  await t.sleep(400)

  // The way in: the command bar's Import from Another Browser.
  mark('open')
  await t.key('Mod+T')
  const bar = await t.overlay()
  await waitFor(t, () => bar.getByTestId('command-input').isVisible())
  await t.sleep(250)
  await t.type(bar, 'Import from', 80)
  const action = bar.getByTestId('command-result').filter({ hasText: 'Import from Another Browser' }).first()
  await waitFor(t, () => action.isVisible())
  await t.sleep(450)
  await action.click()
  let { page, offset } = await importWindow(t)
  await waitFor(t, () => page.getByTestId('import-source-chrome').isVisible())
  await t.sleep(1000)

  // Chrome, then only its Work profile.
  mark('chrome')
  await click(page, offset, 'import-source-chrome', 18)
  await t.sleep(450)
  await click(page, offset, 'import-next')
  await page.getByTestId('import-profiles').waitFor({ timeout: 8000 })
  await t.sleep(800)
  for (const row of await page.getByTestId('import-profiles').locator('label').all()) {
    const name = await row.locator('span').last().innerText()
    const box = row.getByRole('checkbox')
    if ((name === 'Work') !== (await box.isChecked())) {
      await pointAt(box, offset, 12)
      await box.click()
      await t.sleep(400)
    }
  }
  await click(page, offset, 'import-next')
  await page.getByTestId('import-step-types').waitFor({ timeout: 8000 })
  await waitFor(t, async () => (await page.getByTestId('import-inspecting').count()) === 0)
  await t.sleep(1500)
  await click(page, offset, 'import-next')

  // IM-04: the profile's bookmark tree, all chosen; the count follows each change; Select none, then all.
  mark('bookmarks')
  await page.getByTestId('import-count').waitFor({ timeout: 8000 })
  await t.sleep(1000)
  const news = page.getByRole('checkbox', { name: 'Import News' })
  await pointAt(news, offset, 16)
  await news.click()
  await t.sleep(1000)
  await click(page, offset, 'import-select-none')
  await t.sleep(900)
  await click(page, offset, 'import-select-all', 8)
  await t.sleep(1000)
  await click(page, offset, 'import-next')

  // IM-06: where they go: a new Space, named here.
  mark('target')
  const space = page.getByTestId('import-target-space')
  await space.waitFor({ timeout: 8000 })
  await t.sleep(900)
  await pointAt(space, offset, 14)
  await space.selectOption('new')
  const named = page.getByTestId('import-new-space')
  await named.waitFor({ timeout: 8000 })
  await pointAt(named, offset, 10)
  await named.click()
  await page.keyboard.press(`${t.mod}+A`)
  await t.type(page, 'From Chrome', 90)
  await t.sleep(600)
  mark('import')
  await finish(t, page, offset)
  await t.sleep(1800)

  // IM-07: the history came over too: a familiar site completes in the command bar at once.
  mark('history')
  await t.key('Mod+T')
  await waitFor(t, () => bar.getByTestId('command-input').isVisible())
  await t.sleep(300)
  await t.type(bar, 'news', 160)
  await t.sleep(1700)
  await bar.keyboard.press('Escape')
  await t.sleep(800)

  // IM-12: a pasted list of links becomes one pinned folder, named by the person, in the order pasted.
  mark('paste')
  await t.run('import.open', {})
  ;({ page, offset } = await importWindow(t))
  await t.sleep(900)
  await click(page, offset, 'import-paste', 18)
  const text = page.getByTestId('import-links-text')
  await text.waitFor({ timeout: 8000 })
  await t.app.evaluate(({ clipboard }, s) => clipboard.writeText(s), links)
  await pointAt(text, offset, 10)
  await text.click()
  await t.sleep(400)
  await page.keyboard.press(`${t.mod}+V`)
  await waitFor(t, async () => (await page.getByTestId('import-links-count').innerText()) === '5 links')
  await t.sleep(1000)
  const folder = page.getByTestId('import-folder-name')
  await pointAt(folder, offset, 10)
  await folder.click()
  await page.keyboard.press(`${t.mod}+A`)
  await t.type(page, 'Weekend reading', 90)
  await t.sleep(600)
  await finish(t, page, offset)
  await t.sleep(1500)

  // IM-12, IM-15: the same list pasted on the sidebar opens the import at it; it makes a second folder.
  mark('paste-sidebar')
  await shell.getByTestId('sidebar-scroll').evaluate((el) => el.focus())
  await t.key('Mod+V')
  ;({ page, offset } = await importWindow(t))
  await page.getByTestId('import-step-links').waitFor({ timeout: 8000 })
  await t.sleep(1000)
  const again = page.getByTestId('import-folder-name')
  await pointAt(again, offset, 12)
  await again.click()
  await page.keyboard.press(`${t.mod}+A`)
  await t.type(page, 'Weekend reading', 70)
  await t.sleep(500)
  await finish(t, page, offset)
  await t.sleep(1500)

  // IM-13: a bookmarks file, chosen with From a file….
  mark('file')
  await t.app.evaluate(
    ({ dialog }, picked) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] })
    },
    resolve(FIXTURES, 'files', 'bookmarks.htm'),
  )
  await t.run('import.open', {})
  ;({ page, offset } = await importWindow(t))
  await t.sleep(900)
  await click(page, offset, 'import-from-file', 18)
  await page.getByTestId('import-count').waitFor({ timeout: 8000 })
  await t.sleep(1400)
  await finish(t, page, offset)
  await t.sleep(1800)
  mark('end')
}
