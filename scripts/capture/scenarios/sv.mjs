/**
 * Split view (SV-02, SV-11, SV-13, SV-17, SV-19, SV-26; FL-18), about 17 s, for the "feels right" sign-off (D48).
 * A pane added beside the page grows in with the command bar to fill it; a second pane goes below;
 * the divider follows the pointer; the layout flips; panes close and the others grow back.
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
  for (const name of ['Design review', 'Metrics', 'Standup notes', 'Changelog']) {
    tabs.push(await t.run('tabs.create', { url: t.fx.url(name), spaceId: win.spaceId, activate: false }))
  }
  for (const tabId of tabs) {
    await t.run('tabs.activate', { tabId })
    await t.sleep(450)
  }
}

/** Fills the new pane: the command bar opens with it, and Enter on a match puts that tab there. */
async function fill(t, text) {
  const overlay = await t.overlay()
  await t.sleep(500)
  await t.type(overlay, text, 100)
  await t.sleep(600)
  await overlay.keyboard.press('Enter')
}

export default async function (t) {
  t0 = performance.now()
  await t.sleep(600)

  // SV-02, FL-18: a pane added on the right grows in; the page makes room with it, and an open tab fills it.
  mark('add-right')
  await t.action('split.addRight')
  await fill(t, 'metr')
  await t.sleep(1500)

  // SV-02, SV-11: a third pane below the focused one.
  mark('add-below')
  await t.action('split.addBelow')
  await fill(t, 'stand')
  await t.sleep(1500)

  // SV-13, FL-18: the divider follows the pointer 1:1.
  const divider = t.shell.getByTestId('split-divider').first()
  await t.point(divider)
  const box = await divider.boundingBox()
  if (box) {
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    mark('resize')
    await t.shell.mouse.down()
    for (let i = 1; i <= 20; i++) {
      await t.shell.mouse.move(x - 8 * i, y)
      await t.sleep(16)
    }
    for (let i = 1; i <= 20; i++) {
      await t.shell.mouse.move(x - 160 + 8 * i, y)
      await t.sleep(16)
    }
    await t.shell.mouse.up()
  }
  await t.sleep(1200)

  // SV-11, SV-26, FL-18: flip the orientation; the panes move to their new places.
  mark('flip')
  await t.action('split.flip')
  await t.sleep(1500)

  // SV-17, SV-26, FL-18: close the focused pane; the others grow back into its space. Then SV-19: close the
  // whole split.
  mark('close-pane')
  await t.action('split.close')
  await t.sleep(1500)
  mark('close-split')
  await t.action('split.closeSplit')
  await t.sleep(1500)
  mark('end')
}
