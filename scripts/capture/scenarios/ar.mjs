/**
 * Archive (AR-01, AR-02, AR-03, AR-04, AR-05, AR-07, AR-08, AR-11), about 50 s, for the "feels right"
 * sign-off (D48). ⌘W on a Today tab and a deleted folder send their tabs to the Archive; the Library
 * button opens the Library at the Archive, newest first under day headings; Restore shows on the row
 * under the pointer; the source filter and search narrow the list as you click and type; Restore sends
 * a tab of another Space back there, and a toast says so; Clear Archive asks first, Cancel keeps
 * everything, and the empty Archive says how long entries are kept; Restore Data brings the deleted
 * folder back from a sidebar backup; Esc closes the Library.
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

/** The pointer to the middle of a locator, in a view placed at `offset` in the window (the window is at 0, 0). */
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

const MOD = process.platform === 'darwin' ? 'meta' : 'control'

/** A key pressed in a tab's page, as with the page focused. */
const press = (t, id, key, mods = []) =>
  t.app.evaluate(
    (_e, [tabId, keyCode, modifiers]) => {
      const page = globalThis.__orbit.ctx.tabs.get(tabId).webContents
      page.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      page.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    },
    [id, key, mods],
  )

/** A tab of the fixture page `name`, shown (a tab never shown doesn't load) until it has its title. */
async function open(t, name, spaceId) {
  const id = await t.run('tabs.create', { url: t.fx.url(name), spaceId, activate: false })
  await t.run('tabs.activate', { tabId: id })
  await waitFor(t, async () => {
    const tab = (await t.state()).tabs[id]
    return tab?.title === name && !tab.loading
  })
  return id
}

/** A command typed into the command bar (⌘T), as a person would, and run with Enter. */
async function command(t, text) {
  await t.key('Mod+T')
  const bar = await t.overlay()
  await waitFor(t, () => bar.getByTestId('command-input').isVisible())
  await t.sleep(250)
  await t.type(bar, text, 55)
  await waitFor(t, () => bar.getByTestId('command-result').filter({ hasText: text }).first().isVisible())
  await t.sleep(350)
  await bar.keyboard.press('Enter')
}

let tab = ''
let folder = ''
let backup = ''

/**
 * Unrecorded: six days of earlier closes (for the day headings), a tab closed in a second Space, a
 * folder in the pinned section with a sidebar backup taken while it was there, and two Today tabs.
 */
export async function setup(t) {
  const s = await t.state()
  const home = Object.values(s.windows).find((w) => w.kind === 'main').spaceId
  // Every tenth seeded entry (the "lantern" pages) closed in a Mini Window, for the source filter.
  await t.run('archive.testSeed', {
    base: t.fx.url('').replace(/\/$/, ''),
    count: 28,
    days: 6,
    spaceId: home,
    prefix: 'Saved',
  })
  const travel = await t.run('spaces.create', { name: 'Travel' })
  await t.run('tabs.close', { tabId: await open(t, 'Flight deals', travel) })
  await waitFor(t, async () => (await t.run('archive.query', {})).rows.some((r) => r.title === 'Flight deals'))
  await t.run('spaces.switch', { spaceId: home })
  const packing = await open(t, 'Packing list', home)
  const hotels = await open(t, 'Hotel shortlist', home)
  folder = await t.run('folders.create', { name: 'Trip ideas', items: [packing, hotels] })
  backup = (await t.run('backups.take')).id
  await open(t, 'Field notes', home)
  tab = await open(t, 'Trail map', home)
  await t.sleep(900)
}

export default async function (t) {
  t0 = performance.now()
  const { shell } = t
  await pointerTo(900, 560, 1)
  await t.sleep(500)

  // AR-01: ⌘W on a Today tab sends it to the Archive.
  mark('close-tab')
  await press(t, tab, 'W', [MOD])
  await waitFor(t, async () => !(await t.state()).tabs[tab])
  await t.sleep(1000)
  // AR-01: so does deleting a folder (as from its menu): its tabs go there.
  mark('delete-folder')
  await t.run('folders.delete', { folderId: folder })
  await t.sleep(1100)

  // AR-02: the Library button, bottom-left, opens the Library at the Archive.
  const button = shell.getByTestId('library-button')
  await pointAt(button, undefined, 22)
  await t.sleep(250)
  mark('library')
  await button.click()
  const lib = await waitFor(t, () => t.app.windows().find((p) => p.url().includes('view=library')))
  await waitFor(t, async () => (await lib.getByTestId('library').getAttribute('data-open')) === 'true')
  const view = (await t.run('library.testInfo')).bounds
  await t.sleep(1300)

  // AR-03: newest first under day headings; Restore shows on the row under the pointer.
  mark('hover')
  const rows = lib.getByTestId('archive-row')
  await pointAt(rows.nth(0), view, 18)
  await t.sleep(700)
  await pointAt(rows.nth(1), view, 8)
  await t.sleep(500)
  await pointAt(rows.nth(3), view, 10)
  await t.sleep(700)
  // AR-03: the source filter: the tabs closed in a Mini Window, then all again.
  mark('filter')
  const mini = lib.getByTestId('archive-source-mini')
  await pointAt(mini, view, 16)
  await mini.click()
  await t.sleep(1300)
  const all = lib.getByTestId('archive-source-all')
  await pointAt(all, view, 8)
  await all.click()
  await t.sleep(900)

  // AR-04: search narrows the list as you type, by title and address.
  mark('search')
  const search = lib.getByTestId('archive-search')
  await pointAt(search, view, 14)
  await search.click()
  await t.type(lib, 'garden', 120)
  await t.sleep(1500)
  for (let i = 0; i < 'garden'.length; i++) {
    await lib.keyboard.press('Backspace')
    await t.sleep(70)
  }
  await waitFor(t, async () => (await rows.filter({ hasText: 'Flight deals' }).count()) > 0)
  await t.sleep(800)

  // AR-05: Restore on the tab from Travel puts it back in Travel; a toast says so and offers to go there.
  mark('restore')
  const deals = rows.filter({ hasText: 'Flight deals' })
  await pointAt(deals, view, 16)
  await t.sleep(450)
  const restore = deals.getByTestId('archive-restore')
  await pointAt(restore, view, 8)
  await restore.click()
  await lib.getByTestId('library-toast').waitFor({ timeout: 8000 })
  await t.sleep(2400)

  // AR-07: Clear Archive asks first, saying it can't be undone; Cancel keeps everything.
  mark('clear-ask')
  await command(t, 'Clear Archive')
  const cancel = lib.getByTestId('archive-clear-cancel')
  await cancel.waitFor({ timeout: 8000 })
  await t.sleep(1600)
  await pointAt(cancel, view, 14)
  mark('clear-cancel')
  await cancel.click()
  await t.sleep(1100)
  // Asked again, and cleared: the empty Archive says so, and how long entries are kept (AR-08).
  mark('clear')
  await command(t, 'Clear Archive')
  const ok = lib.getByTestId('archive-clear-ok')
  await ok.waitFor({ timeout: 8000 })
  await t.sleep(900)
  await pointAt(ok, view, 12)
  await ok.click()
  await lib.getByTestId('archive-empty').waitFor({ timeout: 8000 })
  await t.sleep(2300)

  // AR-11: Restore Data lists the sidebar's backups; the one from before the folder went brings it back.
  mark('restore-data')
  await command(t, 'Restore Data')
  const row = lib.locator(`[data-testid="backup-row"][data-id="${backup}"]`)
  await row.waitFor({ timeout: 8000 })
  await t.sleep(1200)
  await pointAt(row, view, 16)
  await row.click()
  await t.sleep(500)
  const again = row.getByTestId('backup-restore')
  await pointAt(again, view, 8)
  await again.click()
  const yes = lib.getByTestId('backup-confirm-ok')
  await yes.waitFor({ timeout: 8000 })
  await t.sleep(1300)
  await pointAt(yes, view, 10)
  mark('restore-ok')
  await yes.click()
  await waitFor(t, async () => (await t.state()).folders[folder])
  await t.sleep(2300)

  // AR-02: Esc closes the Library.
  mark('close-library')
  await lib.keyboard.press('Escape')
  await t.sleep(1500)
  mark('end')
}
