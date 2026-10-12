/**
 * The sidebar's controls (SB), about 70 s, for the "feels right" sign-off (D48), after `sp`. The address
 * shows the host only; Back, Forward and Reload each answer a click with their own press; a click on the
 * address opens the command bar on the current address, and a slow page shows the loading indicator at
 * the top centre of its card while Reload is Stop, which stops the next one. + New Tab presses and opens
 * the command bar. A file downloaded from a page lands on the Library button, a hover shows it among the
 * recent files, and a click opens the Library; the + at the other end lists what is new. In a long Today,
 * ⌘9 scrolls the last tab into view, and scrolled away a pill points back to it. ⌘⇧E puts the keyboard
 * in the sidebar: the arrows move, Enter opens and Esc gives the page the keys back. ⌘⇧N opens a private
 * window: dark, labelled Private, with only its own tabs.
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

/** Moves a page's pointer and the on-screen one together, in eased steps; `origin` is where the page is. */
let at = { x: 700, y: 420 }
async function glide(t, x, y, steps = 18, page = t.shell, origin = { x: 0, y: 0 }) {
  const from = at
  const to = { x: origin.x + x, y: origin.y + y }
  for (let i = 1; i <= steps; i++) {
    const k = 0.5 - 0.5 * Math.cos((Math.PI * i) / steps)
    const sx = from.x + (to.x - from.x) * k
    const sy = from.y + (to.y - from.y) * k
    await page.mouse.move(sx - origin.x, sy - origin.y)
    await xPointer(sx, sy)
  }
  at = to
}

async function box(locator) {
  const b = await locator.boundingBox()
  if (!b) throw new Error('not on screen')
  return { ...b, cx: b.x + b.width / 2, cy: b.y + b.height / 2 }
}

/** A click as a person makes it: the pointer travels there first. */
async function click(t, locator, opts = {}) {
  const page = opts.page ?? t.shell
  const b = await box(locator)
  await glide(t, b.cx, b.cy, opts.steps ?? 16, page, opts.origin)
  await t.sleep(120)
  await page.mouse.click(b.cx, b.cy)
}

const row = (t, id) => t.shell.locator(`[data-testid="tab-row"][data-tab-id="${id}"]`)

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

/** A window's overlay page, found by the window it belongs to. */
async function overlayOf(t, windowId) {
  return waitFor(t, async () => {
    for (const p of t.app.windows()) {
      if (!p.url().includes('view=overlay')) continue
      const id = await p.evaluate(() => window.orbit?.windowId).catch(() => undefined)
      if (id === windowId) return p
    }
    return null
  })
}

const windowIds = (t) => t.app.evaluate(() => globalThis.__orbit.windowIds())

/** The sidebar's list has stopped scrolling. */
const scrollRests = (t) =>
  waitFor(t, () =>
    t.shell.getByTestId('sidebar-scroll').evaluate(async (el) => {
      const a = el.scrollTop
      await new Promise((r) => setTimeout(r, 150))
      return a === el.scrollTop
    }),
  )

const NAMES = [
  'Atlas',
  'Bakery',
  'Cinema',
  'Dentist',
  'Energy',
  'Florist',
  'Garden',
  'Harbor',
  'Insurance',
  'Journal',
  'Kitchen',
  'Library',
  'Market',
  'Notebook',
  'Office',
  'Podcast',
  'Quarterly',
  'Recipes',
  'Studio',
  'Tickets',
  'Utilities',
  'Vacation',
  'Workshop',
  'Yoga',
]

export default async function (t) {
  t0 = performance.now()
  const s0 = await t.state()
  const sp = s0.spaces[s0.spaceOrder[0]]
  const [main] = await windowIds(t)
  // A long Today, a page of files and two Favorites, each tab shown once so it has its title and icon (a
  // tab never shown doesn't load), made before the clip has much to show. The newest is on top.
  const ids = {}
  const shown = async (id, name) => {
    await t.run('tabs.activate', { tabId: id })
    await waitFor(t, async () => {
      const tab = (await t.state()).tabs[id]
      return tab?.title === name && !tab.loading
    })
  }
  for (const n of ['Mail', 'Chat']) {
    ids[n] = await t.run('tabs.create', { url: t.fx.url(n), spaceId: sp.id, activate: false })
    await shown(ids[n], n)
    await t.run('tabs.favorite', { tabId: ids[n] })
  }
  for (const n of NAMES) {
    ids[n] = await t.run('tabs.create', { url: t.fx.url(n), spaceId: sp.id, activate: false })
    await shown(ids[n], n)
  }
  ids.Files = await t.run('tabs.create', {
    url: new URL('files/Field%20kit', t.fx.url('')).href,
    spaceId: sp.id,
    activate: false,
  })
  await shown(ids.Files, 'Field kit')
  ids.Docs = await t.run('tabs.create', { url: t.fx.url('Docs'), spaceId: sp.id, activate: false })
  await shown(ids.Docs, 'Docs')
  await scrollRests(t)
  await glide(t, 760, 430, 4)
  await t.sleep(1500)

  // SB-03, SB-04: the address shows the host only; a link, then Back, Forward and Reload, each pressed.
  mark('nav')
  const docs = await pageOf(t, ids.Docs)
  const link = await box(docs.page.locator('header nav a', { hasText: 'Updates' }))
  await glide(t, docs.origin.x + link.cx, docs.origin.y + link.cy, 18)
  await t.sleep(160)
  await docs.page.mouse.click(link.cx, link.cy)
  await waitFor(t, async () => (await t.state()).tabs[ids.Docs]?.url.endsWith('/Updates'))
  await t.sleep(900)
  for (const [id, path] of [
    ['nav-back', '/Docs'],
    ['nav-forward', '/Updates'],
  ]) {
    await click(t, t.shell.getByTestId(id), { steps: 18 })
    await waitFor(t, async () => (await t.state()).tabs[ids.Docs]?.url.endsWith(path))
    await t.sleep(900)
  }
  await click(t, t.shell.getByTestId('nav-reload'), { steps: 10 })
  await t.sleep(1100)

  // SB-04, SB-28: a click on the address opens the command bar on it; a slow page shows the loading
  // indicator at the top centre of its card, and Reload is Stop until the page is in.
  mark('slow')
  await click(t, t.shell.getByTestId('address'), { steps: 14 })
  const bar = await overlayOf(t, main)
  const input = bar.getByTestId('command-input')
  await waitFor(t, () => input.isVisible())
  await t.sleep(700)
  await t.type(bar, `${t.fx.url('Forecast')}?wait=2600`, 40)
  await t.sleep(300)
  await bar.keyboard.press('Enter')
  await waitFor(t, async () => (await t.state()).tabs[ids.Docs]?.url.includes('/Forecast'), 12000)
  await t.sleep(1000)

  // SB-03: Stop stops a slow load; the page that was there stays.
  mark('stop')
  await t.run('tabs.navigate', { tabId: ids.Docs, url: `${t.fx.url('Archive')}?wait=8000` })
  await waitFor(t, async () => (await t.state()).tabs[ids.Docs]?.loading)
  await t.sleep(1300)
  await click(t, t.shell.getByTestId('nav-reload'), { steps: 14 })
  await waitFor(t, async () => !(await t.state()).tabs[ids.Docs]?.loading)
  await t.sleep(1200)

  // SB-07: + New Tab presses and opens the command bar.
  mark('new-tab')
  await click(t, t.shell.getByTestId('new-tab-button'), { steps: 16 })
  await waitFor(t, () => input.isVisible())
  await t.sleep(1100)
  await bar.keyboard.press('Escape')
  await t.sleep(800)

  // SB-09: a file from a page lands on the Library button; a hover shows the recent files, a click opens
  // the Library; the + at the other end lists what is new.
  mark('library')
  await click(t, row(t, ids.Files), { steps: 16 })
  await t.sleep(700)
  const files = await pageOf(t, ids.Files)
  const file = await box(files.page.locator('a.file[data-file="Survey report.pdf"]'))
  await glide(t, files.origin.x + file.cx, files.origin.y + file.cy, 18)
  await t.sleep(160)
  await files.page.mouse.click(file.cx, file.cy)
  await t.sleep(1500)
  const button = t.shell.getByTestId('library-button')
  const lb = await box(button)
  await glide(t, lb.cx, lb.cy, 22)
  await button.hover()
  const recent = t.shell.getByTestId('recent-files')
  await recent.waitFor({ timeout: 4000 })
  await t.sleep(1300)
  await click(t, button, { steps: 4 })
  await t.sleep(1600)
  // The button closes it again.
  await t.shell.mouse.click(lb.cx, lb.cy)
  await t.sleep(1000)
  await click(t, t.shell.getByTestId('sidebar-plus'), { steps: 22 })
  const plus = bar.getByTestId('plus-menu')
  await waitFor(t, () => plus.isVisible())
  await t.sleep(400)
  const items = plus.getByRole('menuitem')
  for (let i = 0; i < Math.min(await items.count(), 4); i++) {
    const b = await box(items.nth(i))
    await glide(t, b.cx, b.cy, 6, bar)
    await t.sleep(240)
  }
  await bar.keyboard.press('Escape')
  await t.sleep(800)

  // SB-23: ⌘9 selects the last tab, out of sight: the list scrolls it in. Scrolled away, a pill points
  // back to it, and a click on the pill brings it into view.
  mark('reveal')
  await glide(t, 120, 520, 16)
  await t.key('Mod+9')
  await waitFor(t, async () => {
    const s = await t.state()
    return s.windows[main]?.activeTab[sp.id] === ids.Atlas
  })
  await scrollRests(t)
  await t.sleep(900)
  for (let i = 0; i < 14; i++) {
    await t.shell.mouse.wheel(0, -90)
    await t.sleep(30)
  }
  const pill = t.shell.getByTestId('reveal-active')
  await waitFor(t, () => pill.isVisible())
  await t.sleep(900)
  await click(t, pill, { steps: 14 })
  await scrollRests(t)
  await t.sleep(1000)

  // SB-22: ⌘⇧E puts the keyboard in the sidebar; the arrows move, Enter opens, Esc gives the page the keys.
  mark('keys')
  await glide(t, 760, 430, 14)
  await t.key('Mod+Shift+E')
  await t.sleep(700)
  for (let i = 0; i < 3; i++) {
    await t.shell.keyboard.press('ArrowUp')
    await t.sleep(380)
  }
  await t.shell.keyboard.press('Enter')
  await t.sleep(900)
  await t.shell.keyboard.press('Escape')
  await t.sleep(1000)

  // SB-25: ⌘⇧N opens a private window, its command bar ready; what is typed opens there.
  mark('private')
  await t.key('Mod+Shift+N')
  const priv = await waitFor(t, async () => (await windowIds(t)).find((id) => id !== main))
  const privBar = await overlayOf(t, priv)
  await waitFor(t, () => privBar.getByTestId('command-input').isVisible())
  await t.sleep(1000)
  await t.type(privBar, t.fx.url('Secret'), 40)
  await t.sleep(300)
  await privBar.keyboard.press('Enter')
  await waitFor(t, async () => {
    const s = await t.state()
    const w = s.windows[priv]
    const id = w ? w.activeTab[w.spaceId] : undefined
    return id && s.tabs[id]?.title === 'Secret'
  })
  await t.sleep(1600)
  mark('private-close')
  await t.app.evaluate((_e, id) => globalThis.__orbit.action('window.close', id), priv)
  await waitFor(t, async () => (await windowIds(t)).length === 1)
  await t.sleep(1300)
  mark('end')
}
