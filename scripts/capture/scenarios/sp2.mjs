/**
 * More of Spaces and profiles (SP, PR, SB), about 80 s, for the "feels right" sign-off (D48), after `sp`.
 * Hovering the Space's title row shows its … button, which opens the Space menu; a right-click on another
 * Space's icon opens that Space's menu without leaving. Change Icon… finds an emoji by name and the
 * switcher shows it. The theme picker's presets, intensity and grain recolour the Space as they move, reset
 * goes back to neutral, and Dark and Automatic apply to every Space. An inactive window dims its sidebar.
 * New Profile… gives the Space a profile at once: its pages reload in the new session, the Favorites are
 * the profile's own, and hovering the title row shows the profile's badge. Swiping between two Spaces of
 * one profile leaves the Favorites still; between profiles they cross-fade. Profile ▸ moves a Space to
 * another profile and back. ⌘N opens a second window on the same Space with the command bar, and that
 * window switches Space on its own.
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

/** The on-screen pointer, moved with xdotool. */
const xPointer = (x, y) =>
  new Promise((r) => execFile('xdotool', ['mousemove', String(Math.round(x)), String(Math.round(y))], () => r()))

/**
 * Moves a page's pointer and the on-screen one together, in eased steps. `on` is the page and where its
 * corner is on screen: the first window and its views are at 0, 0.
 */
let at = { x: 700, y: 420 }
async function glide(t, x, y, steps = 18, on = { page: t.shell, x: 0, y: 0 }) {
  const from = at
  const to = { x: on.x + x, y: on.y + y }
  for (let i = 1; i <= steps; i++) {
    const k = 0.5 - 0.5 * Math.cos((Math.PI * i) / steps)
    const sx = from.x + (to.x - from.x) * k
    const sy = from.y + (to.y - from.y) * k
    await on.page.mouse.move(sx - on.x, sy - on.y)
    await xPointer(sx, sy)
  }
  at = to
}

async function box(locator) {
  const b = await locator.boundingBox()
  if (!b) throw new Error('not on screen')
  return { ...b, cx: b.x + b.width / 2, cy: b.y + b.height / 2 }
}

/** The pointer comes to rest over a locator. */
async function hover(t, locator, opts = {}) {
  const b = await box(locator)
  await glide(t, b.cx, b.cy, opts.steps ?? 16, opts.on)
}

/** A click as a person makes it: the pointer travels there first. */
async function click(t, locator, opts = {}) {
  const on = opts.on ?? { page: t.shell, x: 0, y: 0 }
  const b = await box(locator)
  await glide(t, b.cx, b.cy, opts.steps ?? 16, on)
  await t.sleep(120)
  await on.page.mouse.click(b.cx, b.cy, { button: opts.button ?? 'left' })
}

/** The on-screen pointer's button, pressed (`mousedown`) or let go (`mouseup`), as a person's. */
const xButton = (action) => new Promise((r) => execFile('xdotool', [action, '1'], () => r()))

/**
 * A range input's thumb dragged from where it is to `to` (0 to 100), with the on-screen pointer and its
 * button only. A native slider's drag ends at the first move of a pointer with no button held, so a drag
 * by the page's pointer stops at the on-screen pointer's next move. Prints the value it ends on.
 */
async function slide(t, on, input, to) {
  const b = await box(input)
  const value = Number(await input.inputValue())
  const x = (v) => b.x + 8 + ((b.width - 16) * v) / 100
  await glide(t, x(value), b.cy, 10, on)
  await t.sleep(120)
  await xButton('mousedown')
  const from = at
  const end = { x: on.x + x(to), y: on.y + b.cy }
  for (let i = 1; i <= 22; i++) {
    const k = 0.5 - 0.5 * Math.cos((Math.PI * i) / 22)
    await xPointer(from.x + (end.x - from.x) * k, from.y + (end.y - from.y) * k)
    await t.sleep(16)
  }
  at = end
  await t.sleep(100)
  await xButton('mouseup')
  const name = await input.getAttribute('data-testid')
  console.error(`[check] ${name}: ${value} → ${await input.inputValue()} (asked ${to})`)
}

const dot = (t, id, page = t.shell) => page.locator(`[data-testid="space-dot"][data-space-id="${id}"]`)

/** A window's shell or overlay page, found by the window it belongs to. */
async function uiPage(t, view, windowId) {
  return waitFor(t, async () => {
    for (const p of t.app.windows()) {
      if (!p.url().includes(`view=${view}`)) continue
      const id = await p.evaluate(() => window.orbit?.windowId).catch(() => undefined)
      if (id === windowId) return p
    }
    return null
  })
}

const windowIds = (t) => t.app.evaluate(() => globalThis.__orbit.windowIds())

/** The first window's Space, once its strip has come to rest. */
async function restingOn(t, spaceId) {
  await waitFor(t, async () => {
    const s = await t.state()
    const w = s.windows[(await windowIds(t))[0]]
    if (w?.spaceId !== spaceId) return false
    return t.shell.evaluate(() => {
      const track = document.querySelector('.space-strip__track')
      return !!track && track.style.transform === '' && document.querySelectorAll('[data-preview-space]').length === 0
    })
  })
}

/** The pointer comes to rest on the title row's right end, by its … button (the name has a tooltip). */
async function hoverTitleRow(t) {
  const b = await box(t.shell.getByTestId('space-title-row'))
  await glide(t, b.x + b.width - 56, b.cy, 18)
}

/** Hovers the title row and opens the Space menu from its … button. */
async function openSpaceMenu(t, overlayPage) {
  await hoverTitleRow(t)
  await t.sleep(650)
  await click(t, t.shell.getByTestId('space-menu-button'), { steps: 8 })
  await waitFor(t, () => overlayPage.getByTestId('space-menu').isVisible())
  await t.sleep(450)
}

/** Chooses an item of the open Space menu, through the Profile submenu when `sub` is given. */
async function chooseMenu(t, overlayPage, id, sub) {
  const on = { page: overlayPage, x: 0, y: 0 }
  await hover(t, overlayPage.getByTestId(`menu-${id}`), { steps: 10, on })
  if (!sub) {
    await t.sleep(220)
    await click(t, overlayPage.getByTestId(`menu-${id}`), { steps: 2, on })
    return
  }
  const item = overlayPage.getByTestId(`menu-${sub}`)
  await waitFor(t, () => item.isVisible())
  await t.sleep(500)
  const b = await box(item)
  // Along the parent row first, then down into the submenu, as a hand keeps the submenu open.
  await glide(t, b.x + 12, at.y, 8, on)
  await glide(t, b.cx, b.cy, 8, on)
  await t.sleep(220)
  await overlayPage.mouse.click(b.cx, b.cy)
}

/** Two-finger swipe over the sidebar, one Space to the right (`dir` 1) or left (-1). */
async function swipe(t, dir) {
  const strip = await box(t.shell.getByTestId('space-strip'))
  await glide(t, strip.cx, strip.y + Math.min(160, strip.height / 2), 12)
  await t.sleep(250)
  for (let i = 0; i < 16; i++) {
    await t.shell.mouse.wheel(12 * dir, 0)
    await t.sleep(16)
  }
}

/** Fakes the window losing or getting focus, as the tests do: Xvfb has no window manager to move it. */
const focusEvent = (t, kind) =>
  t.app.evaluate(({ BrowserWindow }, k) => {
    for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('view=shell')) w.emit(k)
  }, kind)

export default async function (t) {
  t0 = performance.now()
  const s0 = await t.state()
  const home = s0.spaceOrder[0]
  const [main] = await windowIds(t)
  const overlay = await uiPage(t, 'overlay', main)
  const onOverlay = { page: overlay, x: 0, y: 0 }
  await t.run('spaces.update', { spaceId: home, name: 'Personal' })
  // Two Favorites in the Default profile; Personal, then Client, then Work, each with tabs shown once so they
  // have their titles and icons (a tab never shown doesn't load), made before the clip has much to show.
  const tabs = {}
  const shown = async (id, name) => {
    await t.run('tabs.activate', { tabId: id })
    await waitFor(t, async () => {
      const tab = (await t.state()).tabs[id]
      return tab?.title === name && !tab.loading
    })
  }
  const client = await t.run('spaces.create', { name: 'Client', activate: false, afterSpaceId: home })
  const work = await t.run('spaces.create', { name: 'Work', activate: false, afterSpaceId: client })
  for (const [n, space] of [
    ['Wiki', work],
    ['Tracker', work],
    ['Brief', client],
    ['Invoices', client],
  ]) {
    tabs[n] = await t.run('tabs.create', { url: t.fx.url(n), spaceId: space, activate: false })
    await shown(tabs[n], n)
  }
  for (const n of ['Mail', 'Chat']) {
    tabs[n] = await t.run('tabs.create', { url: t.fx.url(n), spaceId: home, activate: false })
    await shown(tabs[n], n)
    await t.run('tabs.favorite', { tabId: tabs[n] })
  }
  for (const n of ['Travel', 'Recipes']) {
    tabs[n] = await t.run('tabs.create', { url: t.fx.url(n), spaceId: home, activate: false })
    await shown(tabs[n], n)
  }
  await restingOn(t, home)
  await glide(t, 700, 420, 4)
  await t.sleep(1500)

  // SP-04, SB-06: hovering the title row shows the … button, which opens the Space menu; a right-click on
  // another Space's icon opens its menu without leaving this Space.
  mark('space-menu')
  await openSpaceMenu(t, overlay)
  for (const id of ['theme', 'icon', 'profile', 'rename', 'manage', 'delete']) {
    await hover(t, overlay.getByTestId(`menu-${id}`), { steps: 6, on: onOverlay })
    await t.sleep(230)
  }
  await t.sleep(300)
  await overlay.keyboard.press('Escape')
  await t.sleep(700)
  await click(t, dot(t, work), { button: 'right' })
  await waitFor(t, () => overlay.getByTestId('space-menu').isVisible())
  await t.sleep(1100)
  await overlay.keyboard.press('Escape')
  await t.sleep(800)

  // SP-05, SP-06: Change Icon… opens the emoji picker; categories, then a search; the switcher shows the icon.
  mark('space-icon')
  await openSpaceMenu(t, overlay)
  await chooseMenu(t, overlay, 'icon')
  const search = overlay.getByTestId('emoji-search')
  await waitFor(t, () => search.isVisible())
  await t.sleep(600)
  const categories = overlay.getByTestId('emoji-category')
  for (const i of [2, 5]) {
    await click(t, categories.nth(i), { steps: 10, on: onOverlay })
    await t.sleep(700)
  }
  await click(t, search, { steps: 12, on: onOverlay })
  await t.sleep(200)
  await t.type(overlay, 'rocket', 110)
  await t.sleep(500)
  await click(t, overlay.getByTestId('emoji-option').first(), { steps: 10, on: onOverlay })
  await waitFor(t, async () => (await t.state()).spaces[home]?.icon === '🚀')
  await t.sleep(1300)

  // SP-14, SP-17, SP-18: the theme picker; presets, intensity and grain recolour the Space as they move;
  // reset goes back to neutral; Dark and Automatic apply to every Space.
  mark('theme')
  await openSpaceMenu(t, overlay)
  await chooseMenu(t, overlay, 'theme')
  const picker = overlay.getByTestId('theme-picker')
  await waitFor(t, () => picker.isVisible())
  await t.sleep(700)
  const presets = overlay.getByTestId('theme-preset')
  for (const i of [1, 4]) {
    await click(t, presets.nth(i), { steps: 10, on: onOverlay })
    await t.sleep(800)
  }
  mark('theme-sliders')
  await slide(t, onOverlay, overlay.getByTestId('theme-intensity'), 25)
  await t.sleep(600)
  await slide(t, onOverlay, overlay.getByTestId('theme-intensity'), 90)
  await t.sleep(600)
  await slide(t, onOverlay, overlay.getByTestId('theme-grain'), 70)
  await t.sleep(700)
  mark('theme-reset')
  await click(t, overlay.getByTestId('theme-reset'), { steps: 12, on: onOverlay })
  await t.sleep(1000)
  await click(t, presets.nth(4), { steps: 10, on: onOverlay })
  await t.sleep(800)
  mark('appearance')
  await click(t, overlay.getByTestId('appearance-dark'), { steps: 12, on: onOverlay })
  await t.sleep(1500)
  await click(t, overlay.getByTestId('appearance-system'), { steps: 10, on: onOverlay })
  await t.sleep(1300)
  await overlay.keyboard.press('Escape')
  await t.sleep(900)

  // SB-21: the window loses focus and its sidebar dims; focus brings it back at once.
  mark('blur')
  await glide(t, 760, 430, 12)
  await focusEvent(t, 'blur')
  await t.sleep(1400)
  await focusEvent(t, 'focus')
  await t.sleep(1200)

  // PR-02, PR-03, PR-07: New Profile… from the Space menu; the Space's pages reload in its session, its
  // Favorites are the new profile's own (none yet), and the title row shows the profile's badge.
  mark('new-profile')
  await click(t, dot(t, work))
  await restingOn(t, work)
  await t.sleep(900)
  await openSpaceMenu(t, overlay)
  await chooseMenu(t, overlay, 'profile', 'profile-new')
  const name = overlay.getByTestId('profile-name')
  await waitFor(t, () => name.isVisible())
  await t.sleep(500)
  await t.type(overlay, 'Acme', 120)
  await t.sleep(400)
  await click(t, overlay.getByTestId('profile-create'), { steps: 12, on: onOverlay })
  const acme = await waitFor(t, async () => {
    const id = (await t.state()).spaces[work]?.profileId
    return id && id !== 'p-default' ? id : null
  })
  await t.sleep(1400)
  mark('badge')
  await hoverTitleRow(t)
  await waitFor(t, () => t.shell.getByTestId('profile-badge').isVisible())
  await t.sleep(1200)
  await hover(t, dot(t, work), { steps: 16 })
  await t.sleep(1600)
  // The new profile's first Favorite.
  mark('acme-favorite')
  await t.run('tabs.favorite', { tabId: tabs.Tracker })
  await t.sleep(1400)

  // PR-06: between Spaces of one profile the Favorites stay still; between profiles they cross-fade.
  mark('profile-swipe')
  await click(t, dot(t, home))
  await restingOn(t, home)
  await t.sleep(1000)
  await swipe(t, 1)
  await restingOn(t, client)
  await t.sleep(1100)
  await swipe(t, 1)
  await restingOn(t, work)
  await t.sleep(1100)
  await swipe(t, -1)
  await restingOn(t, client)
  await t.sleep(1100)

  // PR-03: Profile ▸ moves a Space to another profile: its tabs restart there and the Favorites follow.
  mark('assign-profile')
  await openSpaceMenu(t, overlay)
  await chooseMenu(t, overlay, 'profile', `profile-${acme}`)
  await waitFor(t, async () => (await t.state()).spaces[client]?.profileId === acme)
  await t.sleep(1600)
  await openSpaceMenu(t, overlay)
  await chooseMenu(t, overlay, 'profile', 'profile-p-default')
  await waitFor(t, async () => (await t.state()).spaces[client]?.profileId === 'p-default')
  await t.sleep(1500)

  // SP-24, SP-23: ⌘N opens a window on the same Space with the command bar; it switches Space on its own.
  mark('new-window')
  await glide(t, 760, 430, 10)
  await t.key('Mod+N')
  const second = await waitFor(t, async () => (await windowIds(t)).find((id) => id !== main))
  const overlay2 = await uiPage(t, 'overlay', second)
  await waitFor(t, () => overlay2.getByTestId('command-input').isVisible())
  await t.sleep(1600)
  await overlay2.keyboard.press('Escape')
  await t.sleep(800)
  const shell2 = await uiPage(t, 'shell', second)
  const bounds = (await t.state()).windows[second]?.bounds ?? { x: 0, y: 0 }
  const on2 = { page: shell2, x: bounds.x, y: bounds.y }
  mark('second-switch')
  await click(t, dot(t, home, shell2), { on: on2 })
  await waitFor(t, async () => (await t.state()).windows[second]?.spaceId === home)
  await t.sleep(1500)
  mark('second-close')
  await t.app.evaluate((_e, id) => globalThis.__orbit.action('window.close', id), second)
  await waitFor(t, async () => (await windowIds(t)).length === 1)
  await t.sleep(1500)
  mark('end')
}
