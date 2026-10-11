/**
 * Navigation (NV-01, NV-03, NV-04, NV-05, NV-06, NV-11, NV-15, NV-17, NV-19), about 40 s, for the "feels
 * right" sign-off (D48). Back and Forward from their buttons; ⌘R; a slow address typed and stopped with
 * Esc; find in page; zoom with its indicator; Copy URL's toast; a site asking for the location; a mailto:
 * link that asks first; and a private window.
 *
 * Each step prints a `[mark] <name> <ms>` line on stderr: its time since the scenario began.
 * record.mjs begins it 0.7 s after the recording starts, so a step shows about 0.7 s later in the clip.
 */
import { execFile } from 'node:child_process'

let t0 = 0
const mark = (name) => console.error(`[mark] ${name} ${Math.round(performance.now() - t0)}`)

/** A Mail app for mailto: links, as the e2e tests give one (ORBIT_E2E_APPS): asked about, never started. */
const MAIL_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%232a7de1'/%3E%3Cpath d='M7 11h18v11H7z' fill='%23fff'/%3E%3Cpath d='M7 11l9 7 9-7' fill='none' stroke='%232a7de1' stroke-width='2'/%3E%3C/svg%3E"
export const env = { ORBIT_E2E_APPS: JSON.stringify({ mailto: { name: 'Mail', icon: MAIL_ICON } }) }

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

let tab = ''
const MOD = process.platform === 'darwin' ? 'meta' : 'control'

/** A key pressed in the tab's page, as with the page focused. */
const press = (t, key, mods = []) =>
  t.app.evaluate(
    (_e, [id, keyCode, modifiers]) => {
      const page = globalThis.__orbit.ctx.tabs.get(id).webContents
      page.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      page.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    },
    [tab, key, mods],
  )

const tabNow = async (t) => (await t.state()).tabs[tab]
/** Where the tab's page sits in the window. */
const tabBounds = (t) => t.app.evaluate((_e, id) => globalThis.__orbit.ctx.tabs.get(id).getBounds(), tab)
/** The tab's page in Playwright, once it shows an address that starts with `url`. */
const pageAt = (t, url) => waitFor(t, () => t.app.windows().find((p) => p.url().startsWith(url)))

/** Unrecorded: a tab that has been to two pages, so Back and Forward have somewhere to go. */
export async function setup(t) {
  const s = await t.state()
  const win = Object.values(s.windows).find((w) => w.kind === 'main')
  tab = await t.run('tabs.create', { url: t.fx.url('Field notes'), spaceId: win.spaceId, activate: false })
  await t.run('tabs.activate', { tabId: tab })
  await waitFor(t, async () => (await tabNow(t))?.loading === false)
  await t.sleep(500)
  await t.run('tabs.navigate', { tabId: tab, url: t.fx.url('Trail map') })
  await waitFor(t, async () => {
    const now = await tabNow(t)
    return now?.url === t.fx.url('Trail map') && now.loading === false
  })
  await t.sleep(600)
}

export default async function (t) {
  t0 = performance.now()
  const { shell } = t
  await pointerTo(860, 520, 1)
  await t.sleep(500)

  // NV-01: Back and Forward, from the buttons by the address.
  mark('back')
  const back = shell.getByTestId('nav-back')
  await pointAt(back, undefined, 20)
  await back.click()
  await waitFor(t, async () => (await tabNow(t))?.url === t.fx.url('Field notes'))
  await t.sleep(900)
  mark('forward')
  const forward = shell.getByTestId('nav-forward')
  await pointAt(forward, undefined, 8)
  await forward.click()
  await waitFor(t, async () => (await tabNow(t))?.url === t.fx.url('Trail map'))
  await t.sleep(700)
  await pointerTo(900, 600, 16)

  // NV-03: ⌘R reloads the page.
  mark('reload')
  await press(t, 'R', [MOD])
  await t.sleep(1200)

  // NV-04: a slow address, typed: the address shows where it is going at once; Esc stops the load, and
  // the address stays at the pending page.
  mark('type-slow')
  await press(t, 'L', [MOD])
  const bar = await t.overlay()
  await t.sleep(350)
  await t.type(bar, `${t.fx.url('Slow page')}?wait=15000`, 22)
  await t.sleep(250)
  await bar.keyboard.press('Enter')
  await t.sleep(1800)
  mark('stop')
  await press(t, 'Escape')
  await waitFor(t, async () => (await tabNow(t))?.loading === false)
  await t.sleep(1500)

  // NV-05: ⌘F finds as you type, with the count; Enter goes on; Esc closes it.
  mark('find')
  await press(t, 'F', [MOD])
  const tools = await waitFor(t, () => t.app.windows().find((p) => p.url().includes('view=tools')))
  await waitFor(t, () => tools.getByTestId('find-input').isVisible())
  await t.sleep(300)
  await t.type(tools, 'demo', 120)
  await t.sleep(800)
  await tools.keyboard.press('Enter')
  await t.sleep(550)
  await tools.keyboard.press('Enter')
  await t.sleep(800)
  await tools.keyboard.press('Escape')
  await t.sleep(900)

  // NV-06: ⌘+ twice zooms in by steps, with the indicator; ⌘0 goes back to 100%.
  mark('zoom')
  await press(t, '=', [MOD])
  await t.sleep(450)
  await press(t, '=', [MOD])
  await t.sleep(1700)
  mark('zoom-reset')
  await press(t, '0', [MOD])
  await t.sleep(2600)

  // NV-05 again, once the zoom indicator has gone: the find bar comes in the same corner.
  mark('find-again')
  await press(t, 'F', [MOD])
  await t.sleep(1300)
  await tools.keyboard.press('Escape')
  await t.sleep(900)

  // NV-17: ⌘⇧C copies the address without its tracking parameters, and a toast says so.
  const reading = t.fx.url('Reading list')
  await t.run('tabs.navigate', { tabId: tab, url: `${reading}?utm_source=newsletter&id=7` })
  await waitFor(t, async () => {
    const now = await tabNow(t)
    return now?.url.startsWith(reading) && now.loading === false
  })
  await t.sleep(900)
  mark('copy')
  await press(t, 'C', [MOD, 'shift'])
  const copied = await waitFor(t, async () => {
    const text = await t.app.evaluate(({ clipboard }) => clipboard.readText())
    return text.startsWith(reading) ? text : null
  })
  console.error(`[copied] ${copied}`)
  await t.sleep(1800)

  // NV-15: the site asks for the location; the prompt hangs under the address; Never allow.
  const page = await pageAt(t, reading)
  await page.evaluate(() => {
    const b = document.createElement('button')
    b.id = 'where'
    b.textContent = 'Find a shop near me'
    b.style.cssText =
      'font:600 15px system-ui;padding:10px 16px;border-radius:10px;border:0;background:#1d1d1f;color:#fff;margin:0 16px 24px 0'
    b.onclick = () =>
      navigator.geolocation.getCurrentPosition(
        () => {},
        () => {},
      )
    const a = document.createElement('a')
    a.id = 'mail'
    a.href = 'mailto:hello@example.com?subject=Hello'
    a.textContent = 'Email the team'
    a.style.cssText = 'font:600 15px system-ui;color:#3e63dd'
    const row = document.createElement('div')
    row.append(b, a)
    document.querySelector('.lead').after(row)
  })
  await t.sleep(700)
  const view = await tabBounds(t)
  mark('ask-location')
  const where = page.locator('#where')
  await pointAt(where, view, 18)
  await where.click()
  const prompt = shell.getByTestId('permission-prompt')
  await prompt.waitFor({ timeout: 8000 })
  await t.sleep(1300)
  const never = prompt.getByTestId('permission-block')
  await pointAt(never, undefined, 16)
  await t.sleep(250)
  mark('never-allow')
  await never.click()
  await t.sleep(1200)

  // NV-19: a mailto: link asks first, in a dialog over the page; Esc (Cancel) leaves the page as it was.
  mark('mailto')
  const mail = page.locator('#mail')
  await pointAt(mail, view, 18)
  await mail.click()
  const dialog = await waitFor(t, async () => {
    for (const p of t.app.windows()) {
      if (!p.url().includes('view=dialog')) continue
      if (await p.getByTestId('page-dialog-cancel').isVisible()) return p
    }
    return null
  })
  await t.sleep(1800)
  mark('mailto-cancel')
  await dialog.keyboard.press('Escape')
  await t.sleep(1200)

  // NV-11: ⌘⇧N opens a private window: dark, labelled Private.
  mark('private')
  await press(t, 'N', [MOD, 'shift'])
  const priv = await waitFor(t, async () => Object.values((await t.state()).windows).find((w) => w.kind === 'private'))
  await t.sleep(2600)
  mark('private-close')
  await t.app.evaluate(async (_e, id) => {
    await new Promise((r) => setImmediate(r))
    globalThis.__orbit.ctx.windows.get(id)?.close()
  }, priv.id)
  await t.sleep(1200)
  mark('end')
}
