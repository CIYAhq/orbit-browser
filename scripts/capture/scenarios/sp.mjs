/**
 * Spaces and the sidebar (SP, SB), about 60 s, for the "feels right" sign-off (D48). A click on a Space's
 * icon in the bottom bar slides to it, and so do ⌃⌥← and ⌃⌥→ and a two-finger swipe over the sidebar;
 * New Space opens a new, empty Space; a click on its name renames a Space; the theme picker recolours it;
 * ⌃S hides the sidebar and the pointer at the window's edge brings it back over the page; a tab dragged
 * onto another Space's icon moves there; Delete Space… asks first, and Undo brings the Space back.
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

/** Moves Playwright's pointer and the on-screen one together, in eased steps. */
let at = { x: 700, y: 420 }
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

/** A click as a person makes it: the pointer travels there first. */
async function click(t, locator, opts = {}) {
  const b = await box(locator)
  await glide(t, b.cx, b.cy, opts.steps ?? 16)
  await t.sleep(120)
  await t.shell.mouse.click(b.cx, b.cy, { clickCount: opts.clickCount ?? 1 })
}

const row = (t, id) => t.shell.locator(`[data-testid="tab-row"][data-tab-id="${id}"]`)
const dot = (t, id) => t.shell.locator(`[data-testid="space-dot"][data-space-id="${id}"]`)

/** The window's Space, once the strip has come to rest. */
async function restingOn(t, spaceId) {
  await waitFor(t, async () => {
    const s = await t.state()
    const w = Object.values(s.windows)[0]
    if (w?.spaceId !== spaceId) return false
    return t.shell.evaluate(() => {
      const track = document.querySelector('.space-strip__track')
      return !!track && track.style.transform === '' && document.querySelectorAll('[data-preview-space]').length === 0
    })
  })
}

// Made in setup, before the recording starts; the clip uses them.
let home
let work
const tabs = {}

/** Personal and Work, each tab shown once so it has its title and icon (a tab never shown doesn't load). */
export async function setup(t) {
  home = (await t.state()).spaceOrder[0]
  await t.run('spaces.update', { spaceId: home, name: 'Personal' })
  const shown = async (id, name) => {
    await t.run('tabs.activate', { tabId: id })
    await waitFor(t, async () => {
      const tab = (await t.state()).tabs[id]
      return tab?.title === name && !tab.loading
    })
  }
  work = await t.run('spaces.create', { name: 'Work', activate: false })
  for (const n of ['Wiki', 'Tracker']) {
    tabs[n] = await t.run('tabs.create', { url: t.fx.url(n), spaceId: work, activate: false })
    await shown(tabs[n], n)
  }
  for (const n of ['Travel', 'Recipes', 'News']) {
    tabs[n] = await t.run('tabs.create', { url: t.fx.url(n), spaceId: home, activate: false })
    await shown(tabs[n], n)
  }
}

export default async function (t) {
  t0 = performance.now()
  await restingOn(t, home)
  await glide(t, 700, 420, 4)
  await t.sleep(1500)

  // SP-07, SP-10, SP-19: a click on a Space's icon slides to it.
  mark('switch-click')
  await click(t, dot(t, work))
  await restingOn(t, work)
  await t.sleep(1200)
  await click(t, dot(t, home))
  await restingOn(t, home)
  await t.sleep(1200)

  // SP-09: ⌃⌥→ and ⌃⌥←.
  mark('switch-keys')
  await t.key('Mod+Alt+ArrowRight')
  await restingOn(t, work)
  await t.sleep(1100)
  await t.key('Mod+Alt+ArrowLeft')
  await restingOn(t, home)
  await t.sleep(1100)

  // SP-08: a two-finger swipe over the sidebar follows the fingers, then settles on the next Space.
  mark('swipe')
  const strip = await box(t.shell.getByTestId('space-strip'))
  await glide(t, strip.cx, strip.y + Math.min(160, strip.height / 2), 14)
  await t.sleep(300)
  for (let i = 0; i < 16; i++) {
    await t.shell.mouse.wheel(12, 0)
    await t.sleep(16)
  }
  await restingOn(t, work)
  await t.sleep(1200)
  for (let i = 0; i < 16; i++) {
    await t.shell.mouse.wheel(-12, 0)
    await t.sleep(16)
  }
  await restingOn(t, home)
  await t.sleep(1200)

  // SP-02: New Space opens the flow past the last Space, its name field ready; Create makes the Space.
  mark('new-space')
  const before = new Set((await t.state()).spaceOrder)
  await t.action('space.new')
  await waitFor(t, () => t.shell.getByTestId('new-space-flow').isVisible())
  await t.sleep(900)
  await t.type(t.shell, 'Ideas', 110)
  await t.sleep(500)
  await click(t, t.shell.getByTestId('new-space-create'), { steps: 18 })
  const made = await waitFor(t, async () => (await t.state()).spaceOrder.find((id) => !before.has(id)))
  await restingOn(t, made)
  await t.sleep(1200)

  // SP-03: a click on the Space's name renames it, with the whole name selected.
  mark('rename-space')
  await click(t, t.shell.getByTestId('space-name'))
  const input = t.shell.getByTestId('space-rename-input')
  await waitFor(t, () => input.isVisible())
  await t.sleep(300)
  await t.shell.keyboard.press('Control+A')
  await t.type(t.shell, 'Reading', 90)
  await t.sleep(250)
  await t.shell.keyboard.press('Enter')
  await t.sleep(1100)

  // SP-14: the theme picker; a preset recolours the Space as it's chosen.
  mark('theme')
  await t.action('space.theme')
  const overlay = await t.overlay()
  const picker = overlay.getByTestId('theme-picker')
  await waitFor(t, () => picker.isVisible())
  await t.sleep(700)
  const presets = overlay.getByTestId('theme-preset')
  const count = Math.min(await presets.count(), 3)
  for (let i = 0; i < count; i++) {
    const b = await box(presets.nth(i))
    await glide(t, b.cx, b.cy, 10)
    await t.sleep(150)
    await overlay.mouse.click(b.cx, b.cy)
    await t.sleep(800)
  }
  await overlay.keyboard.press('Escape')
  await t.sleep(1200)

  // SB-11, SB-12: ⌃S hides the sidebar; the pointer at the window's edge brings it over the page.
  mark('hide')
  await click(t, dot(t, home))
  await restingOn(t, home)
  await t.sleep(600)
  await t.key('Mod+S')
  await t.sleep(1200)
  mark('reveal')
  await glide(t, 3, 420, 22)
  // The card over the page is a view of its own.
  const floating = await waitFor(t, async () => t.app.windows().find((p) => p.url().includes('view=sidebar')))
  await waitFor(
    t,
    async () =>
      (await floating
        .getByTestId('floating-sidebar')
        .getAttribute('data-out')
        .catch(() => null)) === 'true',
  )
  await t.sleep(1400)
  await glide(t, 760, 420, 22)
  await t.sleep(1400)
  mark('show')
  await t.key('Mod+S')
  await t.sleep(1300)

  // TB-09, SP-21: a tab dropped on another Space's icon moves there.
  mark('move-to-space')
  const from = await box(row(t, tabs.Recipes))
  const to = await box(dot(t, work))
  await glide(t, from.cx, from.cy, 14)
  await t.sleep(120)
  await t.shell.mouse.down()
  await glide(t, from.cx, from.cy + 8, 3)
  await glide(t, to.cx, to.cy, 26)
  await t.sleep(500)
  await t.shell.mouse.up()
  await t.sleep(1500)

  // SP-12: Delete Space… asks first; Undo brings the Space back.
  mark('delete-space')
  await click(t, dot(t, made))
  await restingOn(t, made)
  await t.sleep(600)
  await t.action('space.delete')
  // The dialog is in Orbit's overlay, which covers the window from its corner.
  const dialog = await t.overlay()
  const confirm = dialog.getByTestId('space-delete-confirm')
  await waitFor(t, () => confirm.isVisible())
  await t.sleep(900)
  const c = await box(confirm)
  await glide(t, c.cx, c.cy, 10)
  await t.sleep(150)
  await dialog.mouse.click(c.cx, c.cy)
  await waitFor(t, async () => !(await t.state()).spaceOrder.includes(made))
  await t.sleep(1400)
  const undo = t.shell.getByTestId('space-undo-button')
  if (await undo.isVisible().catch(() => false)) {
    await click(t, undo, { steps: 12 })
    await t.sleep(1500)
  }
  mark('end')
}
