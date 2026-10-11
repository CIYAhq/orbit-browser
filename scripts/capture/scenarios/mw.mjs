/**
 * The Mini Window (MW-02, MW-04 to MW-06, MW-09, MW-15), about 16 s, for the "feels right" sign-off
 * (D48). A link from another app opens a Mini Window with a quick scale-and-fade; "Open in…" moves its
 * page into the main window, where its row slides into the sidebar; ⌘⌥N opens a blank one whose lookup
 * bar takes the keys typed at once; closing it fades it out.
 *
 * Each step prints a `[mark] <name> <ms>` line on stderr: its time from the start of the recording,
 * so frames around it can be cut from the clip.
 */

let t0 = 0
const mark = (name) => console.error(`[mark] ${name} ${Math.round(performance.now() - t0)}`)

/** The Mini Windows open now, with whether each one shows. */
const minis = (t) =>
  t.app.evaluate(({ BrowserWindow }) => {
    const ctx = globalThis.__orbit.ctx
    return Object.values(ctx.store.state.windows)
      .filter((w) => w.kind === 'mini')
      .map((w) => {
        const win = BrowserWindow.getAllWindows().find(
          (b) => !b.isDestroyed() && ctx.windows.isUi(b.webContents) && ctx.windows.windowIdFor(b.webContents) === w.id,
        )
        return { id: w.id, visible: !!win?.isVisible() }
      })
  })

async function waitFor(t, test, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await test()
    if (v) return v
    await t.sleep(40)
  }
  throw new Error('timed out')
}

/** A Mini Window's own UI page (its top bar and lookup bar). */
async function miniUi(t, windowId) {
  return waitFor(t, async () => {
    for (const p of t.app.windows()) {
      if (!p.url().includes('view=mini')) continue
      const id = await p.evaluate(() => window.orbit.windowId).catch(() => '')
      if (id === windowId) return p
    }
    return null
  })
}

/** Runs a command from a Mini Window's UI, as its buttons do, without waiting on it (it may close the window). */
async function fromMini(t, windowId, name, args) {
  const ui = await miniUi(t, windowId)
  await ui.evaluate(([n, a]) => void window.orbit.invoke(n, a), [name, args]).catch(() => {})
}

let spaceId = ''

/** Unrecorded: two tabs in the main window, and a blank Mini Window kept warm as Orbit does after launch. */
export async function setup(t) {
  const s = await t.state()
  const win = Object.values(s.windows).find((w) => w.kind === 'main')
  spaceId = win.spaceId
  const tabs = []
  for (const name of ['Inbox', 'Calendar']) {
    tabs.push(await t.run('tabs.create', { url: t.fx.url(name), spaceId, activate: false }))
  }
  for (const tabId of tabs) {
    await t.run('tabs.activate', { tabId })
    await t.sleep(450)
  }
  await t.run('mini.prepare', {})
  await t.sleep(1500)
}

export default async function (t) {
  t0 = performance.now()
  await t.sleep(600)

  // MW-02, MW-04: a link from another app opens a Mini Window with a quick scale-and-fade.
  mark('open-link')
  const shared = t.fx.url('Shared doc').replace('127.0.0.1', 'localhost')
  await t.app.evaluate(({ app }, u) => app.emit('open-url', { preventDefault() {} }, u), shared)
  const [first] = await waitFor(t, async () => {
    const list = await minis(t)
    return list.length === 1 && list[0].visible ? list : null
  })
  await t.sleep(1800)

  // MW-05, MW-15: "Open in…" moves the page into the main window; its row slides into the sidebar.
  mark('open-in')
  await fromMini(t, first.id, 'mini.moveToSpace', { spaceId })
  await waitFor(t, async () => (await minis(t)).length === 0)
  await t.sleep(1500)

  // MW-06, MW-15: ⌘⌥N opens a blank Mini Window; every key typed at once lands in its lookup bar.
  mark('blank')
  await t.key('Mod+Alt+N')
  const [blank] = await waitFor(t, async () => {
    const list = await minis(t)
    return list.length === 1 ? list : null
  })
  const ui = await miniUi(t, blank.id)
  await t.type(ui, t.fx.url('Lookup').replace('http://', ''), 45)
  await t.sleep(400)
  mark('lookup-enter')
  await ui.keyboard.press('Enter')
  await t.sleep(1800)

  // MW-09, MW-15: closing fades the window out.
  mark('close')
  await fromMini(t, blank.id, 'mini.control', { op: 'close' })
  await waitFor(t, async () => (await minis(t)).every((m) => !m.visible))
  await t.sleep(1200)
  mark('end')
}
