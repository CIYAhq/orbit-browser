/**
 * Peek (PK-02, PK-05 to PK-07, PK-09, PK-10; FL-19), about 25 s, for the "feels right" sign-off (D48).
 * A link to another site in a pinned tab opens a Peek that grows out of the link; Escape closes it;
 * ⌘Z brings it back; a short two-finger swipe down moves the card with the fingers and lets it spring
 * back, and a long one dismisses it; a last Peek expands into a full tab with ⌘O.
 *
 * Each step prints a `[mark] <name> <ms>` line on stderr: its time from the start of the recording,
 * so frames around it can be cut from the clip.
 */
import { execFile } from 'node:child_process'

const SOURCE = 'Journal'
let t0 = 0
const mark = (name) => console.error(`[mark] ${name} ${Math.round(performance.now() - t0)}`)

/** A tab's page view: its bounds in the window's content, and the content's place on the display. */
const viewOf = (t, tabId) =>
  t.app.evaluate(({ BrowserWindow }, id) => {
    const view = globalThis.__orbit.ctx.tabs.get(id)
    const win = BrowserWindow.getAllWindows()[0]
    return { bounds: view?.getBounds() ?? null, origin: win.getContentBounds() }
  }, tabId)

/** The overlay view's place in the window's content (it draws the Peek's card). */
const overlayOrigin = (t) =>
  t.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    const view = win.contentView.children.find((v) => v.webContents?.getURL().includes('view=overlay'))
    return { bounds: view?.getBounds() ?? { x: 0, y: 0 }, origin: win.getContentBounds() }
  })

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

/** The Peek showing in the main window, or '' once there is none. */
async function peekTab(t) {
  const s = await t.state()
  const win = Object.values(s.windows).find((w) => w.kind === 'main')
  return win?.overlay?.kind === 'peek' ? win.overlay.tabId : ''
}

async function waitFor(t, test, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await test()
    if (v) return v
    await t.sleep(40)
  }
  throw new Error('timed out')
}

/** Presses keys in a tab's page through the browser's input handling, where Orbit's shortcuts listen. */
const press = (t, tabId, accel) =>
  t.app.evaluate(
    (_e, [id, keys, mac]) => {
      const contents = globalThis.__orbit.ctx.tabs.get(id)?.webContents
      const parts = keys.split('+')
      const keyCode = parts.pop()
      const modifiers = parts.map((m) => (m === 'Mod' ? (mac ? 'meta' : 'control') : m.toLowerCase()))
      contents.focus()
      contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    },
    [tabId, accel, process.platform === 'darwin'],
  )

/** Clicks a point of a tab's page through the browser's input handling. */
const clickIn = (t, tabId, x, y) =>
  t.app.evaluate(
    (_e, [id, px, py]) => {
      const contents = globalThis.__orbit.ctx.tabs.get(id)?.webContents
      contents.sendInputEvent({ type: 'mouseMove', x: px, y: py })
      contents.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 })
      contents.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 })
    },
    [tabId, x, y],
  )

/** The centre of an element of a tab's page, in page coordinates. */
const centreOf = (t, tabId, selector) =>
  t.app.evaluate(
    (_e, [id, sel]) =>
      globalThis.__orbit.ctx.tabs
        .get(id)
        .webContents.executeJavaScript(
          `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`,
        ),
    [tabId, selector],
  )

let source = ''

/** Unrecorded: a pinned tab whose page has two links to another site (localhost and 127.0.0.1 are two sites). */
export async function setup(t) {
  const s = await t.state()
  const win = Object.values(s.windows).find((w) => w.kind === 'main')
  source = await t.run('tabs.create', { url: t.fx.url(SOURCE), container: { kind: 'pinned', spaceId: win.spaceId } })
  await t.run('tabs.activate', { tabId: source })
  await t.sleep(900)
  const other = t.fx.url('Field notes').replace('127.0.0.1', 'localhost')
  const later = t.fx.url('Travel guide').replace('127.0.0.1', 'localhost')
  await t.app.evaluate(
    (_e, [id, a, b]) =>
      globalThis.__orbit.ctx.tabs.get(id).webContents.executeJavaScript(`(() => {
        const p = document.createElement('p')
        p.style.cssText = 'font-size:20px;margin:0 0 24px'
        p.innerHTML = 'Read <a id="other" href="${a}">the field notes on another site</a>, or <a id="later" href="${b}">the travel guide</a>.'
        document.querySelector('.lead').after(p)
      })()`),
    [source, other, later],
  )
  await t.sleep(400)
}

async function clickLink(t, selector) {
  const { bounds, origin } = await viewOf(t, source)
  const c = await centreOf(t, source, selector)
  await pointerTo(origin.x + bounds.x + c.x, origin.y + bounds.y + c.y)
  await t.sleep(250)
  await clickIn(t, source, c.x, c.y)
}

export default async function (t) {
  t0 = performance.now()
  // PK-02, FL-19: the card grows out of the clicked link.
  mark('open')
  await clickLink(t, '#other')
  const peek = await waitFor(t, () => peekTab(t))
  await t.sleep(1600)

  // PK-09, FL-19: Escape shrinks and fades the card out.
  mark('escape')
  await press(t, peek, 'Escape')
  await waitFor(t, async () => !(await peekTab(t)))
  await t.sleep(1000)

  // PK-10: ⌘Z brings the Peek back with the open motion.
  mark('reopen')
  await press(t, source, 'Mod+Z')
  await waitFor(t, () => peekTab(t))
  await t.sleep(1500)

  // PK-06, FL-19: a short two-finger swipe down beside the card moves it with the fingers and springs
  // back; a long one dismisses it. Fingers moving down scroll content up, so the wheel deltas are negative.
  const ov = await t.overlay()
  const { bounds, origin } = await overlayOrigin(t)
  const card = await ov.getByTestId('peek-card').boundingBox()
  const sx = Math.max(8, Math.round(card.x / 2))
  const sy = Math.round(card.y + card.height / 2)
  await pointerTo(origin.x + bounds.x + sx, origin.y + bounds.y + sy)
  await ov.mouse.move(sx, sy)
  const swipe = async (total, steps) => {
    for (let i = 0; i < steps; i++) {
      await ov.mouse.wheel(0, -total / steps)
      await t.sleep(16)
    }
  }
  mark('swipe-short')
  await swipe(card.height * 0.12, 8)
  await t.sleep(1400)
  mark('swipe-long')
  await swipe(card.height * 0.4, 14)
  await waitFor(t, async () => !(await peekTab(t)))
  await t.sleep(1200)

  // PK-07, FL-19: ⌘O grows the card to the page card's edges; it becomes a tab, and its row inserts.
  mark('open-2')
  await clickLink(t, '#later')
  const second = await waitFor(t, () => peekTab(t))
  await t.sleep(1500)
  mark('expand')
  await press(t, second, 'Mod+O')
  await waitFor(t, async () => !(await peekTab(t)))
  await t.sleep(1800)
  mark('end')
}
