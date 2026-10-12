/**
 * More of the sidebar's rows (TB, PN, FV, TD, FD), about 80 s, for the "feels right" sign-off (D48), after
 * `tb`. ⌘-click and ⇧-click select several tabs and ⌘⇧C copies their links; the row menu duplicates a tab,
 * gives it an icon and archives the tabs below it, and ⌘Z brings them back; a tab playing sound shows a
 * speaker that mutes it. A pinned tab that leaves its page shows where it is, and a click on its icon takes
 * it back; its pinned address is edited in place; renamed, it keeps its name; ⌘W unloads it but keeps its
 * row; the caret folds the pinned tabs away. A Favorite shows its menu, moves along the grid, shows that it
 * has left its page until a double-click takes it back, answers ⌘1 to ⌘3, and dragged into Today becomes a
 * tab. A folder is renamed by a double-click, takes an icon, finds a tab from its search, holds a folder
 * made from two of its tabs, and Delete Folder… sends it to the Archive until ⌘Z.
 *
 * Each step prints a `[mark] <name> <ms>` line on stderr: its time since the scenario began.
 * record.mjs begins it 0.7 s after the recording starts, so a step shows about 0.7 s later in the clip.
 */
import { execFile } from 'node:child_process'

let t0 = 0
const mark = (name) => console.error(`[mark] ${name} ${Math.round(performance.now() - t0)}`)

async function waitFor(t, test, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await test()
    if (v) return v
    await t.sleep(40)
  }
  throw new Error('timed out')
}

/** The on-screen pointer, moved with xdotool (the window is at 0, 0, and the sidebar's view too). */
const xPointer = (x, y) =>
  new Promise((r) => execFile('xdotool', ['mousemove', String(Math.round(x)), String(Math.round(y))], () => r()))

/** Moves Playwright's pointer and the on-screen one together, in eased steps, holding the button or not. */
let at = { x: 600, y: 400 }
async function glide(t, x, y, steps = 18) {
  const from = at
  for (let i = 1; i <= steps; i++) {
    const k = 0.5 - 0.5 * Math.cos((Math.PI * i) / steps)
    const px = from.x + (x - from.x) * k
    const py = from.y + (y - from.y) * k
    await t.shell.mouse.move(px, py)
    await xPointer(px, py)
  }
  at = { x, y }
}

async function box(locator) {
  const b = await locator.boundingBox()
  if (!b) throw new Error('not on screen')
  return { ...b, cx: b.x + b.width / 2, cy: b.y + b.height / 2 }
}

const row = (t, id) => t.shell.locator(`[data-testid="tab-row"][data-tab-id="${id}"]`)
const tile = (t, id) => t.shell.locator(`[data-testid="favorite-tile"][data-fav-id="${id}"]`)
const folderRow = (t, id) => t.shell.locator(`[data-folder-id="${id}"] [data-testid="folder-row"]`).first()

/** Waits until the sidebar's rows have finished growing in or out. */
async function settled(t) {
  await waitFor(t, () =>
    t.shell.evaluate(async () => {
      const sample = () =>
        [...document.querySelectorAll('.row-slot')]
          .map((el) => `${el.dataset.exiting ? 'x' : ''}${el.offsetHeight}`)
          .join(',')
      const a = sample()
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      return a === sample() && !document.querySelector('.row-slot[data-exiting]')
    }),
  )
}

/** A drag as a person makes it: onto the row, press, lift, travel, a beat over the target, let go. */
async function drag(t, from, to) {
  await settled(t)
  const start = await box(from)
  await glide(t, start.cx, start.cy, 14)
  await t.sleep(120)
  await t.shell.mouse.down()
  await glide(t, start.cx, start.cy + 8, 3)
  await glide(t, to.x, to.y, 26)
  await t.sleep(260)
  await t.shell.mouse.up()
  await waitFor(t, async () => (await t.shell.getByTestId('drag-ghost').count()) === 0)
}

/** The pointer comes to rest over a locator. */
async function hover(t, locator, steps = 16) {
  const b = await box(locator)
  await glide(t, b.cx, b.cy, steps)
}

/** A click as a person makes it: the pointer travels there first, with any keys held through the click. */
async function click(t, locator, opts = {}) {
  const b = await box(locator)
  await glide(t, b.cx, b.cy, opts.steps ?? 16)
  await t.sleep(120)
  for (const k of opts.keys ?? []) await t.shell.keyboard.down(k)
  await t.shell.mouse.click(b.cx, b.cy, { button: opts.button ?? 'left', clickCount: opts.clickCount ?? 1 })
  for (const k of opts.keys ?? []) await t.shell.keyboard.up(k)
}

/** Right-clicks a row and chooses an item of Orbit's menu, through a submenu when `path` has two labels. */
async function choose(t, target, ...path) {
  await click(t, target, { button: 'right' })
  const menu = await t.overlay()
  await waitFor(t, () => menu.getByTestId('row-menu').isVisible())
  await t.sleep(450)
  for (const [level, label] of path.entries()) {
    const item = menu.locator(`[data-row-menu-level="${level}"] [data-testid="row-menu-item"][data-label="${label}"]`)
    await waitFor(t, () => item.isVisible())
    const b = await box(item)
    await glide(t, b.cx, b.cy, level === 0 ? 10 : 8)
    await t.sleep(level < path.length - 1 ? 500 : 220)
    if (level === path.length - 1) await menu.mouse.click(b.cx, b.cy)
  }
}

/** A tab's page, and where its view sits in the window. */
async function pageOf(t, id) {
  const url = (await t.state()).tabs[id]?.url
  const page = await waitFor(t, async () => t.app.windows().find((p) => p.url() === url))
  const origin = await t.app.evaluate(({ BrowserWindow }, want) => {
    const find = (view, ox, oy) => {
      const b = view.getBounds()
      const x = ox + b.x
      const y = oy + b.y
      if (view.webContents && view.webContents.getURL() === want) return { x, y }
      for (const child of view.children ?? []) {
        const hit = find(child, x, y)
        if (hit) return hit
      }
      return null
    }
    for (const w of BrowserWindow.getAllWindows()) {
      const hit = find(w.contentView, 0, 0)
      if (hit) return hit
    }
    return null
  }, url)
  if (!origin) throw new Error('page not in a window')
  return { page, origin }
}

/** Clicks a link in the page's header, the pointer travelling there on screen. */
async function follow(t, id, text) {
  const { page, origin } = await pageOf(t, id)
  const b = await box(page.locator('header nav a', { hasText: text }))
  await glide(t, origin.x + b.cx, origin.y + b.cy, 18)
  await t.sleep(160)
  await page.mouse.click(b.cx, b.cy)
  await waitFor(t, async () => (await t.state()).tabs[id]?.url.endsWith(`/${text}`))
}

/** The tab with this title that isn't one of `known`. */
const newTabTitled = async (t, title, known) => {
  const s = await t.state()
  return Object.keys(s.tabs).find((id) => s.tabs[id].title === title && !known.has(id))
}

// Made in setup, before the recording starts; the clip uses them.
let sp
let folder
const ids = {}

/**
 * Three Favorites, two pinned tabs, a pinned folder of three and six Today tabs, each shown once so it has
 * its title and icon (a tab never shown doesn't load).
 */
export async function setup(t) {
  const s0 = await t.state()
  sp = s0.spaces[s0.spaceOrder[0]]
  const shown = async (id, name) => {
    await t.run('tabs.activate', { tabId: id })
    await waitFor(t, async () => {
      const tab = (await t.state()).tabs[id]
      return tab?.title === name && !tab.loading
    })
  }
  for (const n of ['Mail', 'Chat', 'Maps']) {
    ids[n] = await t.run('tabs.create', { url: t.fx.url(n), spaceId: sp.id, activate: false })
    await shown(ids[n], n)
    await t.run('tabs.favorite', { tabId: ids[n] })
  }
  for (const n of ['Docs', 'Notes']) {
    ids[n] = await t.run('tabs.create', {
      url: t.fx.url(n),
      spaceId: sp.id,
      container: { kind: 'pinned', spaceId: sp.id },
      activate: false,
    })
    await shown(ids[n], n)
  }
  for (const n of ['Alpha', 'Beta', 'Gamma']) {
    ids[n] = await t.run('tabs.create', { url: t.fx.url(n), spaceId: sp.id, activate: false })
    await shown(ids[n], n)
  }
  folder = await t.run('folders.create', {
    container: { kind: 'pinned', spaceId: sp.id },
    name: 'Projects',
    items: [ids.Alpha, ids.Beta, ids.Gamma],
  })
  for (const n of ['Music', 'Design', 'Calendar', 'Inbox', 'Photos', 'Weather']) {
    ids[n] = await t.run('tabs.create', { url: t.fx.url(n), spaceId: sp.id, activate: false })
    await shown(ids[n], n)
  }
}

export default async function (t) {
  t0 = performance.now()
  await settled(t)
  await glide(t, 700, 420, 4)
  await t.sleep(1500)

  // TB-13, TB-20: ⌘-click and ⇧-click select several rows; ⌘⇧C copies their links; Esc clears them.
  mark('multi-select')
  await click(t, row(t, ids.Photos))
  await t.sleep(600)
  await click(t, row(t, ids.Calendar), { keys: [t.mod] })
  await t.sleep(600)
  await click(t, row(t, ids.Design), { keys: ['Shift'] })
  await t.sleep(900)
  await t.key('Mod+Shift+C')
  await t.sleep(1500)
  await t.shell.keyboard.press('Escape')
  await t.sleep(900)

  // TB-10: Duplicate puts the copy right below the tab.
  mark('duplicate')
  const known = new Set(Object.keys((await t.state()).tabs))
  await choose(t, row(t, ids.Calendar), 'Duplicate')
  ids.Calendar2 = await waitFor(t, () => newTabTitled(t, 'Calendar', known))
  await settled(t)
  await t.sleep(1200)

  // TB-12: Change Icon… gives a tab an emoji in place of its icon.
  mark('tab-icon')
  await choose(t, row(t, ids.Photos), 'Change Icon…')
  await waitFor(t, () => t.shell.getByTestId('icon-picker').isVisible())
  await t.sleep(500)
  await t.type(t.shell, 'camera', 120)
  await t.sleep(600)
  await t.shell.keyboard.press('Enter')
  await waitFor(t, async () => (await t.state()).tabs[ids.Photos]?.icon)
  await t.sleep(1200)

  // TD-05, TB-18: Archive Tabs Below; ⌘Z brings them back.
  mark('archive-below')
  await choose(t, row(t, ids.Inbox), 'Archive Tabs Below')
  await settled(t)
  await t.sleep(1300)
  mark('archive-undo')
  await t.key('Mod+Z')
  await settled(t)
  await t.sleep(1300)

  // TB-15: a tab playing sound shows a speaker; a click on it mutes the tab.
  mark('audio')
  // Weather: the tabs Archive Tabs Below took came back unloaded.
  const { page: weather } = await pageOf(t, ids.Weather)
  await weather.evaluate(() => {
    const audio = new AudioContext()
    const tone = audio.createOscillator()
    const gain = audio.createGain()
    gain.gain.value = 0.05
    tone.connect(gain).connect(audio.destination)
    tone.start()
    window.__tone = audio
  })
  const speaker = row(t, ids.Weather).getByTestId('tab-audio')
  await waitFor(t, () => speaker.isVisible())
  await t.sleep(1200)
  await click(t, speaker)
  await waitFor(t, async () => (await t.state()).tabs[ids.Weather]?.muted)
  await t.sleep(1300)

  // PN-03, PN-05: a pinned tab follows a link on its own site, and its row shows where it went.
  mark('pinned-away')
  await click(t, row(t, ids.Docs))
  await t.sleep(900)
  await follow(t, ids.Docs, 'Updates')
  await t.sleep(1400)
  // PN-04: the icon offers the way back, and a click on it takes the tab back to its pinned page.
  mark('pinned-reset')
  await hover(t, row(t, ids.Docs).getByTestId('tab-icon'))
  await t.sleep(1300)
  await t.shell.mouse.click(at.x, at.y)
  await waitFor(t, async () => (await t.state()).tabs[ids.Docs]?.url.endsWith('/Docs'))
  await t.sleep(1300)

  // PN-07: Pinned URL ▸ Edit… edits the pinned address in the row.
  mark('pinned-edit')
  await choose(t, row(t, ids.Docs), 'Pinned URL', 'Edit…')
  await waitFor(t, () => t.shell.getByTestId('rename-field').isVisible())
  await t.sleep(1600)
  await t.shell.keyboard.press('Escape')
  await t.sleep(900)

  // PN-08: a renamed pinned tab keeps its name, and shows it before the page it went to.
  mark('pinned-rename')
  await click(t, row(t, ids.Notes), { clickCount: 2 })
  await waitFor(t, () => t.shell.getByTestId('rename-field').isVisible())
  await t.sleep(300)
  await t.shell.keyboard.press('Control+A')
  await t.type(t.shell, 'Team notes', 90)
  await t.sleep(250)
  await t.shell.keyboard.press('Enter')
  await t.sleep(900)
  await follow(t, ids.Notes, 'Team')
  await t.sleep(1400)

  // PN-06: ⌘W on a pinned tab unloads it but keeps its row; a click opens its pinned page again.
  mark('pinned-close')
  await t.key('Mod+W')
  await waitFor(t, async () => (await t.state()).tabs[ids.Notes]?.asleep)
  await t.sleep(1500)
  await click(t, row(t, ids.Notes))
  await waitFor(t, async () => {
    const tab = (await t.state()).tabs[ids.Notes]
    return tab && !tab.asleep && tab.url.endsWith('/Notes')
  })
  await t.sleep(1300)

  // PN-09: the caret folds the pinned tabs away; the selected one stays as a single row.
  mark('pinned-collapse')
  await hover(t, t.shell.getByTestId('space-header'))
  await t.sleep(500)
  await click(t, t.shell.getByTestId('pinned-toggle'), { steps: 8 })
  await settled(t)
  await t.sleep(1600)
  await click(t, t.shell.getByTestId('pinned-toggle'), { steps: 4 })
  await settled(t)
  await t.sleep(1300)

  // FV-07: a tile's title on hover, and its menu.
  mark('fav-menu')
  await hover(t, tile(t, ids.Chat))
  await t.sleep(1300)
  await click(t, tile(t, ids.Chat), { button: 'right', steps: 2 })
  const menu = await t.overlay()
  await waitFor(t, () => menu.getByTestId('row-menu').isVisible())
  await t.sleep(500)
  const items = menu.locator('[data-row-menu-level="0"] [data-testid="row-menu-item"]')
  const n = Math.min(await items.count(), 4)
  for (let i = 0; i < n; i++) {
    const b = await box(items.nth(i))
    await glide(t, b.cx, b.cy, 8)
    await t.sleep(260)
  }
  await menu.keyboard.press('Escape')
  await t.sleep(900)

  // FV-05: a tile dragged along the grid; its neighbours make room.
  mark('fav-reorder')
  const maps = await box(tile(t, ids.Maps))
  await drag(t, tile(t, ids.Mail), { x: maps.x + maps.width - 8, y: maps.cy })
  await settled(t)
  await t.sleep(1200)

  // FV-06: a Favorite that left its page says so; a double-click on the tile takes it back.
  mark('fav-away')
  await click(t, tile(t, ids.Chat))
  await t.sleep(800)
  await follow(t, ids.Chat, 'About')
  await waitFor(t, () => tile(t, ids.Chat).getByTestId('favorite-away').isVisible())
  await t.sleep(1400)
  await click(t, tile(t, ids.Chat), { clickCount: 2 })
  await waitFor(t, async () => (await t.state()).tabs[ids.Chat]?.url.endsWith('/Chat'))
  await t.sleep(1300)

  // FV-10: ⌘1 to ⌘3 count the Favorites first.
  mark('fav-keys')
  for (const k of ['1', '2', '3']) {
    await t.key(`Mod+${k}`)
    await t.sleep(800)
  }
  await t.sleep(400)

  // FV-04: a tile dragged into Today becomes a tab there.
  mark('fav-remove')
  const first = await box(row(t, (await t.state()).spaces[sp.id].today[0]))
  await drag(t, tile(t, ids.Maps), { x: first.cx, y: first.y + 4 })
  await settled(t)
  await t.sleep(1300)

  // FD-03: a double-click on a folder renames it (its first click's fold is put back).
  mark('folder-rename')
  await click(t, folderRow(t, folder), { clickCount: 2 })
  await waitFor(t, () => t.shell.getByTestId('rename-field').isVisible())
  await t.sleep(300)
  await t.shell.keyboard.press('Control+A')
  await t.type(t.shell, 'Launch', 90)
  await t.sleep(250)
  await t.shell.keyboard.press('Enter')
  await t.sleep(1000)

  // FD-07: Change Icon… gives the folder an emoji.
  mark('folder-icon')
  await choose(t, folderRow(t, folder), 'Change Icon…')
  await waitFor(t, () => t.shell.getByTestId('icon-picker').isVisible())
  await t.sleep(500)
  await t.type(t.shell, 'rocket', 110)
  await t.sleep(600)
  await t.shell.keyboard.press('Enter')
  await waitFor(t, async () => (await t.state()).folders[folder]?.icon)
  await t.sleep(1200)

  // FD-08, FD-04: folded, the folder's search finds a tab, which shows under the folder.
  mark('folder-search')
  await click(t, folderRow(t, folder))
  await settled(t)
  await t.sleep(700)
  const search = folderRow(t, folder).getByTestId('folder-search-button')
  await waitFor(t, () => search.isVisible())
  await t.sleep(300)
  await click(t, search, { steps: 6 })
  await waitFor(t, () => t.shell.getByTestId('folder-search-input').isVisible())
  await t.sleep(500)
  await t.type(t.shell, 'gam', 140)
  await t.sleep(700)
  await t.shell.keyboard.press('Enter')
  await settled(t)
  await t.sleep(1500)

  // FD-06: two of its tabs, selected, make a folder inside it.
  mark('nested')
  await click(t, folderRow(t, folder))
  await settled(t)
  await t.sleep(700)
  await click(t, row(t, ids.Alpha))
  await t.sleep(400)
  await click(t, row(t, ids.Beta), { keys: ['Shift'] })
  await t.sleep(600)
  const before = new Set(Object.keys((await t.state()).folders))
  await choose(t, row(t, ids.Beta), 'New Folder with Tabs')
  const inner = await waitFor(t, async () => Object.keys((await t.state()).folders).find((id) => !before.has(id)))
  await settled(t)
  await t.sleep(1400)

  // FD-09, FD-10: the folder's menu; Delete Folder… sends it and its tabs to the Archive, and ⌘Z brings them back.
  mark('folder-delete')
  await choose(t, folderRow(t, inner), 'Delete Folder…')
  await waitFor(t, async () => !(await t.state()).folders[inner])
  await settled(t)
  await t.sleep(1300)
  mark('folder-undo')
  await t.key('Mod+Z')
  await waitFor(t, async () => !!(await t.state()).folders[inner])
  await settled(t)
  await t.sleep(1500)
  mark('end')
}
