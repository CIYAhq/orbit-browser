/**
 * The command bar (CB-02, CB-03, CB-09, CB-10, CB-13, CB-22; FL-16, FL-17), about 12 s, for the "feels right"
 * sign-off (D48). ⌘T opens the bar; typing narrows the results as each key lands; ↓ moves the
 * highlight; Enter switches to an open tab; ⌘L edits the current page's address; Escape closes;
 * an action runs by name.
 *
 * Each step prints a `[mark] <name> <ms>` line on stderr: its time from the start of the recording,
 * so frames around it can be cut from the clip.
 */

let t0 = 0
const mark = (name) => console.error(`[mark] ${name} ${Math.round(performance.now() - t0)}`)

/** Unrecorded: a Space with a few open tabs, each visited once so it has its title and icon. */
export async function setup(t) {
  const s = await t.state()
  const win = Object.values(s.windows).find((w) => w.kind === 'main')
  const tabs = []
  for (const name of ['Recipes', 'Reading list', 'Budget', 'Trip planning', 'Team wiki']) {
    tabs.push(await t.run('tabs.create', { url: t.fx.url(name), spaceId: win.spaceId, activate: false }))
  }
  for (const tabId of tabs) {
    await t.run('tabs.activate', { tabId })
    await t.sleep(450)
  }
}

export default async function (t) {
  t0 = performance.now()
  await t.sleep(600)

  // CB-02, CB-22, FL-16: ⌘T shows the bar in the first frame, fading and scaling in.
  mark('open')
  await t.key('Mod+T')
  let overlay = await t.overlay()
  await t.sleep(700)

  // CB-22, FL-17: each key is echoed in its frame, and the results follow; CB-10: ↓ and ↑ move the highlight.
  mark('type')
  await t.type(overlay, 'rec', 110)
  await t.sleep(700)
  mark('down')
  await overlay.keyboard.press('ArrowDown')
  await t.sleep(500)
  await overlay.keyboard.press('ArrowUp')
  await t.sleep(600)

  // CB-09: Enter on an open tab switches to it; the bar hides at once.
  mark('enter')
  await overlay.keyboard.press('Enter')
  await t.sleep(1400)

  // CB-03: ⌘L opens the bar on the current page's address, selected.
  mark('cmd-l')
  await t.key('Mod+L')
  overlay = await t.overlay()
  await t.sleep(1200)

  // FL-16: Escape fades and shrinks it out.
  mark('escape')
  await overlay.keyboard.press('Escape')
  await t.sleep(1200)

  // CB-13: an action by name.
  mark('action')
  await t.key('Mod+T')
  overlay = await t.overlay()
  await t.sleep(400)
  await t.type(overlay, 'new spa', 110)
  await t.sleep(1100)
  mark('action-escape')
  await overlay.keyboard.press('Escape')
  await t.sleep(1200)
  mark('end')
}
