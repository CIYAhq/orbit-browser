/**
 * Tweaks (BO-01 to BO-14, BO-18, BO-21), about 50 s, for the "feels right" sign-off (D48). One local site:
 * New Tweak… from the command bar and its intro; the wheel's big handle dragged round, then its rim handle
 * (the page recolours as they move); invert; the advanced sliders; Reset; two fonts; the size; the text
 * case through its four steps; Hide-element mode (Hide this, Hide all similar, a restore marker); a CSS rule
 * typed into the code area; Done. Then a hard reload, the site controls' toggle off and on, the editor
 * reopened from there, and View Tweaks.
 *
 * Each step prints a `[mark] <name> <ms>` line on stderr: its time since the scenario began.
 * record.mjs begins it 0.7 s after the recording starts, so a step shows about 0.7 s later in the clip.
 * Drags use the on-screen pointer and its button only (xdotool), as a person's hand would, and print
 * `[check]` lines with the values they end on.
 */
import { execFile } from 'node:child_process'

const SITE = 'Field notes'
let t0 = 0
const mark = (name) => console.error(`[mark] ${name} ${Math.round(performance.now() - t0)}`)

async function waitFor(t, test, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await test().catch(() => null)
    if (v) return v
    await t.sleep(40)
  }
  throw new Error('timed out')
}

/** The on-screen pointer, moved with xdotool. */
const xPointer = (x, y) =>
  new Promise((r) => execFile('xdotool', ['mousemove', String(Math.round(x)), String(Math.round(y))], () => r()))

/** The on-screen pointer's button, pressed (`mousedown`) or let go (`mouseup`), as a person's. */
const xButton = (action) => new Promise((r) => execFile('xdotool', [action, '1'], () => r()))

/**
 * A view's page, found by its address, and where its corner is on the display: the window's content
 * origin plus the view's place in it (views nest).
 */
async function viewOf(t, match) {
  const page = await waitFor(t, async () => t.app.windows().find((p) => match(p.url())))
  const want = page.url()
  const origin = await waitFor(t, () =>
    t.app.evaluate(({ BrowserWindow }, url) => {
      const find = (view, ox, oy) => {
        const b = view.getBounds()
        const x = ox + b.x
        const y = oy + b.y
        if (view.webContents && view.webContents.getURL() === url) return b.width > 0 ? { x, y } : null
        for (const child of view.children ?? []) {
          const hit = find(child, x, y)
          if (hit) return hit
        }
        return null
      }
      for (const w of BrowserWindow.getAllWindows()) {
        const c = w.getContentBounds()
        const hit = find(w.contentView, c.x, c.y)
        if (hit) return hit
      }
      return null
    }, want),
  )
  return { page, x: origin.x, y: origin.y }
}

/** The shell is the window's own page, at its content's corner. */
async function shellOf(t) {
  const c = await t.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds())
  return { page: t.shell, x: c.x, y: c.y }
}
const overlayOf = (t) => viewOf(t, (u) => u.includes('view=overlay'))
const editorOf = (t) => viewOf(t, (u) => u.includes('view=tweak'))

/** Moves a page's pointer and the on-screen one together, in eased steps. `on` is the page and its corner. */
let at = { x: 700, y: 420 }
async function glide(on, x, y, steps = 16) {
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
async function hover(on, locator, steps = 16) {
  const b = await box(locator)
  await glide(on, b.cx, b.cy, steps)
}

/** A click as a person makes it: the pointer travels there first. */
async function click(t, on, locator, steps = 16) {
  const b = await box(locator)
  await glide(on, b.cx, b.cy, steps)
  await t.sleep(140)
  await on.page.mouse.click(b.cx, b.cy)
}

/**
 * A drag with the on-screen pointer and its button only, through `points` (page coordinates of `on`),
 * a step every `ms`. A native control's drag ends at the first move of a pointer with no button held.
 */
async function drag(t, on, points, ms = 16) {
  await glide(on, points[0].x, points[0].y, 12)
  await t.sleep(140)
  await xButton('mousedown')
  try {
    for (const p of points.slice(1)) {
      await xPointer(on.x + p.x, on.y + p.y)
      await t.sleep(ms)
    }
  } finally {
    await t.sleep(80)
    await xButton('mouseup')
  }
  const last = points[points.length - 1]
  at = { x: on.x + last.x, y: on.y + last.y }
}

/** A range input's thumb dragged to `to` (0 to 100, along its track). Prints the value it ends on. */
async function slide(t, on, input, to) {
  const b = await box(input)
  const [min, max, value] = await input.evaluate((el) => [Number(el.min), Number(el.max), Number(el.value)])
  const x = (v) => b.x + 8 + ((b.width - 16) * v) / 100
  const from = ((value - min) / (max - min)) * 100
  const points = []
  for (let i = 0; i <= 22; i++) {
    const k = 0.5 - 0.5 * Math.cos((Math.PI * i) / 22)
    points.push({ x: x(from + (to - from) * k), y: b.cy })
  }
  await drag(t, on, points, 18)
  const name = await input.getAttribute('data-testid')
  console.error(`[check] ${name}: ${value} → ${await input.inputValue()} (asked ${to}% of ${min}–${max})`)
}

/** Points on the editor's wheel, as the Tweaks tests find them: a hue (degrees from the top) and a strength (0 to 1). */
async function wheelOf(view) {
  const b = await box(view.getByTestId('tweak-wheel'))
  const rad = (deg) => (deg * Math.PI) / 180
  const point = (deg, r) => ({ x: b.cx + r * Math.sin(rad(deg)), y: b.cy - r * Math.cos(rad(deg)) })
  return {
    cx: b.cx,
    cy: b.cy,
    main: (hue, dist) => point(hue, (b.width / 2 - 16) * dist),
    rim: (deg) => point(deg, b.width / 2 - 7),
  }
}

let tab = ''

/** Unrecorded: the site's page in a tab of its own, loaded. */
export async function setup(t) {
  tab = await t.run('tabs.create', { url: t.fx.url(SITE) })
  await waitFor(t, async () => (await t.state()).tabs[tab]?.loading === false)
  await t.sleep(1200)
}

export default async function (t) {
  t0 = performance.now()
  const shell = await shellOf(t)
  await t.sleep(600)

  // BO-01, BO-21: New Tweak… from the command bar, found by "customize". The editor opens over the page's
  // top-right corner with its intro, once.
  mark('new-tweak')
  await t.key('Mod+T')
  let overlay = await overlayOf(t)
  await t.sleep(300)
  await t.type(overlay.page, 'customize', 100)
  await t.sleep(700)
  const row = overlay.page.getByTestId('command-result').filter({ hasText: 'New Tweak…' }).first()
  await click(t, overlay, row, 14)
  let editor = await editorOf(t)
  await waitFor(t, () => editor.page.getByTestId('tweak-intro').isVisible())
  await t.sleep(1600)
  mark('intro-start')
  await click(t, editor, editor.page.getByTestId('tweak-intro-start'))
  await waitFor(t, () => editor.page.getByTestId('tweak-wheel').isVisible())
  editor = await editorOf(t)
  await t.sleep(900)

  // BO-03: the big handle, from near the middle out to red, then round through yellow and green to blue.
  // The page recolours as it moves.
  mark('wheel')
  let wheel = await wheelOf(editor.page)
  const path = [wheel.main(0, 0.1)]
  for (let i = 1; i <= 20; i++) path.push(wheel.main(0, 0.1 + (0.55 * i) / 20))
  for (let i = 1; i <= 90; i++) path.push(wheel.main((220 * i) / 90, 0.65))
  await drag(t, editor, path, 18)
  await t.sleep(1200)

  // BO-03: the rim handle, a sixth of a turn round from where it sits.
  mark('accent')
  wheel = await wheelOf(editor.page)
  const accent = await box(editor.page.getByTestId('tweak-wheel-accent'))
  const from = (Math.atan2(accent.cx - wheel.cx, wheel.cy - accent.cy) * 180) / Math.PI
  const turn = []
  for (let i = 0; i <= 40; i++) turn.push(wheel.rim(from + (60 * i) / 40))
  await drag(t, editor, turn, 18)
  await t.sleep(1200)

  // BO-04: invert lightness, on and off.
  mark('invert')
  await click(t, editor, editor.page.getByTestId('tweak-invert'))
  await t.sleep(1800)
  await click(t, editor, editor.page.getByTestId('tweak-invert'), 8)
  await t.sleep(900)

  // BO-05: the advanced sliders, contrast and the page's own saturation.
  mark('sliders')
  await click(t, editor, editor.page.getByTestId('tweak-sliders'))
  await waitFor(t, () => editor.page.getByTestId('tweak-contrast').isVisible())
  editor = await editorOf(t)
  await t.sleep(600)
  await slide(t, editor, editor.page.getByTestId('tweak-contrast'), 80)
  await t.sleep(500)
  await slide(t, editor, editor.page.getByTestId('tweak-saturation'), 15)
  await t.sleep(1000)

  // BO-06: Reset gives the site its own colours back.
  mark('reset-colors')
  await click(t, editor, editor.page.getByTestId('tweak-color-reset'))
  await t.sleep(1400)

  // BO-07: two fonts, then the site's own again.
  mark('font')
  await click(t, editor, editor.page.getByTestId('tweak-font-serif'))
  await t.sleep(1300)
  await click(t, editor, editor.page.getByTestId('tweak-font-mono'))
  await t.sleep(1300)

  // BO-08: the size, two steps up.
  mark('size')
  await click(t, editor, editor.page.getByTestId('tweak-size-up'))
  await t.sleep(900)
  await click(t, editor, editor.page.getByTestId('tweak-size-up'), 6)
  await t.sleep(1300)

  // BO-09: the text case through its four steps, back to the page's own.
  mark('case')
  for (let i = 0; i < 4; i++) {
    await click(t, editor, editor.page.getByTestId('tweak-case'), i === 0 ? 16 : 4)
    await t.sleep(900)
  }

  // BO-10: Hide-element mode. The outline follows the pointer over the page; a click picks; Hide this.
  mark('hide')
  await click(t, editor, editor.page.getByTestId('tweak-hide-button'))
  await t.sleep(600)
  const page = await viewOf(t, (u) => u.startsWith(t.fx.url(SITE)))
  const card = (name) => page.page.locator('.card', { hasText: name })
  await hover(page, card('Overview'), 20)
  await t.sleep(500)
  await hover(page, card('Recent'), 14)
  await t.sleep(500)
  await hover(page, card('Ideas'), 18)
  await t.sleep(400)
  await page.page.mouse.click(at.x - page.x, at.y - page.y)
  await waitFor(t, () => editor.page.getByTestId('tweak-hide-this').isVisible())
  await t.sleep(700)
  mark('hide-this')
  await click(t, editor, editor.page.getByTestId('tweak-hide-this'))
  await t.sleep(1200)

  // BO-10: Hide all similar, first from a card's heading, which has no class of its own.
  mark('hide-similar')
  await hover(page, card('Starred').locator('h3'), 18)
  await t.sleep(400)
  await page.page.mouse.click(at.x - page.x, at.y - page.y)
  await waitFor(t, () => editor.page.getByTestId('tweak-hide-similar').isVisible())
  await t.sleep(500)
  await hover(editor, editor.page.getByTestId('tweak-hide-similar'))
  await t.sleep(1600)
  console.error(
    `[check] Starred's title: Hide all similar ${(await editor.page.getByTestId('tweak-hide-similar').isEnabled()) ? 'on' : 'off'}, count ${await editor.page.getByTestId('tweak-hide-count').innerText()}`,
  )
  await click(t, editor, editor.page.getByTestId('tweak-hide-cancel'), 4)
  await t.sleep(700)
  // A card's icon, which has a class: the panel counts the six, and Hide all similar takes them all.
  mark('hide-similar-icon')
  await hover(page, card('Recent').locator('.dot'), 18)
  await t.sleep(400)
  await page.page.mouse.click(at.x - page.x, at.y - page.y)
  await waitFor(t, () => editor.page.getByTestId('tweak-hide-similar').isEnabled())
  await t.sleep(600)
  console.error(
    `[check] Recent's icon: count ${await editor.page.getByTestId('tweak-hide-count').innerText()}, slider ${(await editor.page.getByTestId('tweak-hide-breadth').isVisible()) ? 'shown' : 'not shown'}`,
  )
  await hover(editor, editor.page.getByTestId('tweak-hide-similar'))
  await t.sleep(1200)
  await click(t, editor, editor.page.getByTestId('tweak-hide-similar'), 4)
  await t.sleep(1400)

  // BO-10 (D86): a restore marker in the panel, hovered (the element shows for the moment), then clicked.
  mark('restore')
  const marker = editor.page.getByTestId('tweak-restore-marker').last()
  await hover(editor, marker)
  await t.sleep(1300)
  await click(t, editor, marker, 4)
  await t.sleep(1000)
  await click(t, editor, editor.page.getByTestId('tweak-hide-done'))
  await t.sleep(900)

  // BO-11: a CSS rule, typed; it applies as soon as it parses.
  mark('code')
  await click(t, editor, editor.page.getByTestId('tweak-code-button'))
  await waitFor(t, () => editor.page.getByTestId('tweak-css-input').isVisible())
  editor = await editorOf(t)
  await click(t, editor, editor.page.getByTestId('tweak-css-input'))
  await t.type(editor.page, 'h1 { color: #b4235a; letter-spacing: 4px }', 60)
  await t.sleep(1500)

  // BO-13: Shuffle, twice, from the name's ▾ menu, which stays open for another.
  mark('shuffle')
  await click(t, editor, editor.page.getByTestId('tweak-name'))
  await waitFor(t, () => editor.page.getByTestId('tweak-menu-shuffle').isVisible())
  await t.sleep(400)
  for (let i = 0; i < 2; i++) {
    await click(t, editor, editor.page.getByTestId('tweak-menu-shuffle'), i === 0 ? 8 : 3)
    await t.sleep(1700)
  }
  // BO-12: Rename…, from the same menu, typed over the selected name.
  mark('rename')
  await click(t, editor, editor.page.getByTestId('tweak-menu-rename'), 8)
  await waitFor(t, () => editor.page.getByTestId('tweak-name-input').isVisible())
  await t.sleep(300)
  await t.type(editor.page, 'Quiet reading', 80)
  await editor.page.keyboard.press('Enter')
  await t.sleep(1100)

  // BO-02: Done keeps every edit.
  mark('done')
  await click(t, editor, editor.page.getByTestId('tweak-done'))
  await t.sleep(1400)

  // BO-18: a hard reload shows no frame without the Tweak.
  mark('reload')
  await t.key('Shift+Mod+R')
  await t.sleep(2200)

  // BO-17: the Tweak is for the site's pages, so a link to another of them opens with it.
  mark('other-page')
  await click(t, page, page.page.getByRole('link', { name: 'Updates' }))
  await waitFor(t, async () => {
    const now = (await t.state()).tabs[tab]
    return now?.url.endsWith('/Updates') && !now.loading
  })
  await t.sleep(1800)

  // BO-14: the site controls list the site's Tweak; its name turns it off and on, with no reload.
  mark('site-controls')
  await click(t, shell, shell.page.getByTestId('site-controls-button'))
  overlay = await overlayOf(t)
  const toggle = overlay.page.getByTestId('site-controls').getByTestId('site-tweak-toggle').first()
  await waitFor(t, () => toggle.isVisible())
  await t.sleep(700)
  mark('toggle-off')
  await click(t, overlay, toggle)
  await t.sleep(1600)
  mark('toggle-on')
  await click(t, overlay, toggle, 4)
  await t.sleep(1600)

  // BO-02: the chevron reopens the editor as it was; Esc closes it.
  mark('reopen')
  await click(t, overlay, overlay.page.getByTestId('site-controls').getByTestId('site-tweak-edit').first())
  editor = await editorOf(t)
  await waitFor(t, () => editor.page.getByTestId('tweak-panel').isVisible())
  await t.sleep(1800)
  mark('escape')
  await editor.page.keyboard.press('Escape')
  await t.sleep(1200)

  // BO-15, BO-21: View Tweaks opens the Library on its Tweaks section.
  mark('library')
  await t.action('tweak.view')
  await t.sleep(2600)
  mark('end')
}
