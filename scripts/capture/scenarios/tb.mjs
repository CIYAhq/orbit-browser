/**
 * Tabs, pinned tabs, Favorites, folders and Today (TB, PN, FV, FD, TD), about 70 s, for the "feels right"
 * sign-off (D48). A new tab from ⌘T grows in at the top of Today; a click and a held ⌃Tab switch tabs; a
 * drag reorders Today, and a tab dropped above the divider is pinned; ⌘D pins and unpins; a tab dragged
 * onto the Favorites becomes a tile; New Folder names a folder, a tab dropped on it goes in, and a click
 * collapses and opens it; a double-click renames a row; the row menu opens in Orbit's overlay and Esc
 * closes it; ⌘W closes a tab and ⌘⇧T brings it back; Clear sends Today to the Archive and ⌘Z brings it
 * back.
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

/** A click as a person makes it: the pointer travels there first. */
async function click(t, locator, opts = {}) {
  const b = await box(locator)
  await glide(t, b.cx, b.cy, opts.steps ?? 16)
  await t.sleep(120)
  await t.shell.mouse.click(b.cx, b.cy, { button: opts.button ?? 'left', clickCount: opts.clickCount ?? 1 })
}

const space = async (t) => {
  const s = await t.state()
  return s.spaces[s.spaceOrder[0]]
}

/** Held keys go to whatever has the keyboard, as a person's would (the switcher needs ⌃ held). */
const keyEvents = (t, events) =>
  t.app.evaluate(({ webContents }, list) => {
    for (const [type, keyCode, modifiers] of list) {
      webContents.getFocusedWebContents()?.sendInputEvent({ type, keyCode, modifiers })
    }
  }, events)

export default async function (t) {
  t0 = performance.now()
  const sp = await space(t)
  // Five Today tabs and two Favorites, each shown once so it has its title and icon (a tab never shown
  // doesn't load), made before the clip has much to show.
  const ids = {}
  const shown = async (id, name) => {
    await t.run('tabs.activate', { tabId: id })
    await waitFor(t, async () => {
      const tab = (await t.state()).tabs[id]
      return tab?.title === name && !tab.loading
    })
  }
  for (const n of ['Mail', 'Chat']) {
    const id = await t.run('tabs.create', { url: t.fx.url(n), spaceId: sp.id, activate: false })
    await shown(id, n)
    await t.run('tabs.favorite', { tabId: id })
  }
  for (const n of ['Music', 'Design', 'Docs', 'Calendar', 'Inbox']) {
    ids[n] = await t.run('tabs.create', { url: t.fx.url(n), spaceId: sp.id, activate: false })
    await shown(ids[n], n)
  }
  await settled(t)
  await glide(t, 700, 420, 4)
  await t.sleep(1500)

  // TB-02, TB-03: a new tab from the command bar, at the top of Today.
  mark('new-tab')
  await t.key('Mod+T')
  const bar = await t.overlay()
  await waitFor(t, () => bar.getByTestId('command-input').isVisible())
  await t.sleep(300)
  await t.type(bar, t.fx.url('Weather'), 45)
  await t.sleep(300)
  await bar.keyboard.press('Enter')
  ids.Weather = await waitFor(t, async () => {
    const s = await t.state()
    return Object.keys(s.tabs).find((id) => s.tabs[id].title === 'Weather' && !s.tabs[id].loading)
  })
  await settled(t)
  await t.sleep(1200)

  // TB-04: a click switches tabs.
  mark('switch-click')
  await click(t, row(t, ids.Docs))
  await t.sleep(1000)
  await click(t, row(t, ids.Calendar))
  await t.sleep(1000)

  // TB-05: ⌃Tab held shows the recent tabs; let go on the one highlighted.
  mark('switcher')
  await keyEvents(t, [
    ['keyDown', 'Control', ['control']],
    ['keyDown', 'Tab', ['control']],
    ['keyUp', 'Tab', ['control']],
  ])
  await t.sleep(900)
  await keyEvents(t, [
    ['keyDown', 'Tab', ['control']],
    ['keyUp', 'Tab', ['control']],
  ])
  await t.sleep(700)
  await keyEvents(t, [['keyUp', 'Control', []]])
  await t.sleep(1200)

  // TB-08: a drag reorders Today.
  mark('reorder')
  const today = (await space(t)).today
  const top = await box(row(t, today[0]))
  await drag(t, row(t, ids.Music), { x: top.cx, y: top.y + 4 })
  await settled(t)
  await t.sleep(1000)

  // PN-02: dropped above the divider, a tab is pinned.
  mark('pin-drag')
  const divider = await box(t.shell.getByTestId('today-divider'))
  await drag(t, row(t, ids.Design), { x: divider.cx, y: divider.y + 2 })
  await settled(t)
  await t.sleep(1000)

  // PN-02: ⌘D pins the selected tab, and again unpins it.
  mark('pin-key')
  await click(t, row(t, ids.Weather))
  await t.sleep(500)
  await t.key('Mod+D')
  await settled(t)
  await t.sleep(1100)
  await t.key('Mod+D')
  await settled(t)
  await t.sleep(1100)

  // FV-03: a tab dragged onto the Favorites becomes a tile.
  mark('favorite')
  const favs = await box(t.shell.getByTestId('favorites'))
  await drag(t, row(t, ids.Calendar), { x: favs.x + favs.width - 24, y: favs.cy })
  await settled(t)
  await t.sleep(1200)

  // FD-02: New Folder, named as it appears.
  mark('folder')
  await t.action('folder.new')
  const field = t.shell.getByTestId('rename-field')
  await waitFor(t, () => field.isVisible())
  await t.sleep(400)
  await t.type(t.shell, 'Reading', 90)
  await t.sleep(250)
  await field.press('Enter')
  await settled(t)
  await t.sleep(900)

  // FD-05: a tab dropped on the folder goes in.
  mark('into-folder')
  const folder = await box(t.shell.getByTestId('folder-row'))
  await drag(t, row(t, ids.Docs), { x: folder.cx, y: folder.cy })
  await settled(t)
  await t.sleep(1100)

  // FD-04: a click collapses the folder, another opens it.
  mark('collapse')
  await click(t, t.shell.getByTestId('folder-row'))
  await settled(t)
  await t.sleep(1000)
  await click(t, t.shell.getByTestId('folder-row'))
  await settled(t)
  await t.sleep(1000)

  // TB-12: a double-click renames a row.
  mark('rename')
  await click(t, row(t, ids.Weather), { clickCount: 2 })
  await waitFor(t, () => t.shell.getByTestId('rename-field').isVisible())
  await t.sleep(300)
  await t.shell.keyboard.press('Control+A')
  await t.type(t.shell, 'Forecast', 90)
  await t.sleep(250)
  await t.shell.keyboard.press('Enter')
  await t.sleep(1000)

  // TB-14: the row menu, in Orbit's overlay; Esc closes it.
  mark('row-menu')
  await click(t, row(t, ids.Inbox), { button: 'right' })
  const menu = await t.overlay()
  await waitFor(t, () => menu.getByTestId('row-menu').isVisible())
  await t.sleep(500)
  const items = menu.getByTestId('row-menu-item')
  const n = Math.min(await items.count(), 4)
  for (let i = 0; i < n; i++) {
    const b = await box(items.nth(i))
    await glide(t, b.cx, b.cy, 8)
    await t.sleep(260)
  }
  await t.sleep(300)
  await menu.keyboard.press('Escape')
  await t.sleep(900)

  // TB-06, TB-07: ⌘W closes the selected tab; ⌘⇧T brings it back.
  mark('close')
  await click(t, row(t, ids.Inbox))
  await t.sleep(500)
  await t.key('Mod+W')
  await settled(t)
  await t.sleep(1100)
  mark('reopen')
  await t.key('Mod+Shift+T')
  await settled(t)
  await t.sleep(1200)

  // TD-04, TB-18: Clear sends Today to the Archive; ⌘Z brings it back in order.
  mark('clear')
  const div = await box(t.shell.getByTestId('today-divider'))
  await glide(t, div.cx, div.cy, 14)
  const clear = t.shell.getByTestId('clear-today')
  await waitFor(t, () => clear.isVisible())
  await t.sleep(400)
  await click(t, clear, { steps: 8 })
  await settled(t)
  await t.sleep(1200)
  mark('undo')
  await t.key('Mod+Z')
  await settled(t)
  await t.sleep(1500)
  mark('end')
}
