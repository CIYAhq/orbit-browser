/** Minimal capture check: open two local pages from the command bar and switch between them. */
export default async function smoke(t) {
  for (const name of ['Inbox', 'Calendar']) {
    await t.key('Mod+T')
    const overlay = await t.overlay()
    await t.sleep(250)
    await t.type(overlay, t.fx.url(name), 25)
    await t.sleep(200)
    await overlay.keyboard.press('Enter')
    await t.sleep(900)
  }
  await t.shot('two-tabs')
  const rows = t.shell.getByTestId('tab-row')
  await t.point(rows.nth(1))
  await rows.nth(1).click()
  await t.sleep(700)
  await t.point(rows.nth(0))
  await rows.nth(0).click()
  await t.sleep(700)
}
