import { expect, test } from '@playwright/test'
import {
  type Fixtures,
  launchOrbit,
  MOD,
  type Orbit,
  startFixtures,
  state,
  tabPage,
  tabView,
  viewPage,
} from './helpers'
import {
  act,
  activeId,
  center,
  cmd,
  drag,
  liveTabs,
  newTab,
  PROFILE,
  row,
  rowIds,
  setState,
  settled,
  space,
  tab,
  tabsHook,
  waitTab,
} from './tabs-support'

let fx: Fixtures
let orbit: Orbit

test.beforeAll(async () => {
  fx = await startFixtures()
})
test.afterAll(async () => {
  await fx.close()
})
test.beforeEach(async () => {
  orbit = await launchOrbit()
})
test.afterEach(async () => {
  await orbit.app.close()
})

const FAV = { kind: 'favorites', profileId: PROFILE }

test('[TB-01][TB-02][TB-03][SB-07] the New Tab row opens the command bar and new tabs land selected at the top of Today', async () => {
  const { app, shell } = orbit
  await shell.getByTestId('new-tab-button').click()
  const overlay = await viewPage(app, 'overlay')
  const input = overlay.getByTestId('command-input')
  await expect(input).toBeFocused()
  await input.fill(fx.url('/page/First'))
  await expect(overlay.getByTestId('command-result').first()).toBeVisible()
  await input.press('Enter')
  const first = (await space(app)).today[0] as string
  await waitTab(app, first, '/page/First')
  const second = await newTab(app, fx.url('/page/Second'))
  await waitTab(app, second, '/page/Second')
  // Newest first, directly under "+ New Tab"; exactly one selected row.
  expect((await space(app)).today).toEqual([second, first])
  await expect.poll(() => rowIds(shell, 'today-list')).toEqual([second, first])
  await expect(row(shell, second)).toHaveClass(/is-active/)
  await expect(shell.locator('.tab-row.is-active')).toHaveCount(1)
  // Row anatomy: favicon, title, close button on hover.
  const r = row(shell, first)
  await expect(r.getByTestId('tab-title')).toHaveText('First')
  await expect(r.locator('img.favicon')).toHaveCount(1)
  const close = r.getByTestId('tab-close')
  await expect(close).toHaveCSS('opacity', '0')
  await r.hover()
  await expect(close).toHaveCSS('opacity', '1')
  const box = await r.boundingBox()
  expect(box?.height).toBeGreaterThanOrEqual(30)
  expect(box?.height).toBeLessThanOrEqual(36)
  // A background tab is not selected but still goes to the top.
  const bg = await newTab(app, fx.url('/page/Background'), { activate: false })
  expect((await space(app)).today[0]).toBe(bg)
  expect(await activeId(app)).toBe(second)
  await expect(row(shell, bg)).toHaveClass(/is-asleep/)
})

test('[TB-04][FV-10] click, numbered and next/previous switching follow sidebar order', async () => {
  const { app, shell } = orbit
  const f1 = await newTab(app, fx.url('/page/F1'), { container: FAV, activate: false })
  await newTab(app, fx.url('/page/F2'), { container: FAV, activate: false })
  const p1 = await newTab(app, fx.url('/page/P1'), {
    container: { kind: 'pinned', spaceId: (await space(app)).id },
    activate: false,
  })
  const t2 = await newTab(app, fx.url('/page/T2'), { activate: false })
  const t1 = await newTab(app, fx.url('/page/T1'), { activate: false })
  // Click selects at once and the page view moves into the frame.
  await row(shell, t1).click()
  await expect(row(shell, t1)).toHaveClass(/is-active/)
  await waitTab(app, t1, '/page/T1')
  await expect.poll(async () => (await tabView(app, t1))?.visible).toBe(true)
  // ⌘3 with two Favorites is the first pinned tab.
  await act(app, 'tab.goto.3')
  expect(await activeId(app)).toBe(p1)
  await act(app, 'tab.goto.1')
  expect(await activeId(app)).toBe(f1)
  // ⌘9 is the last tab.
  await act(app, 'tab.goto.9')
  expect(await activeId(app)).toBe(t2)
  // Excluding Favorites from the numbering makes ⌘1 the pinned tab.
  await setState(app, 'd.settings.countFavoritesInShortcuts = false')
  await act(app, 'tab.goto.1')
  expect(await activeId(app)).toBe(p1)
  // Next / previous in sidebar order (⌘⌥↓ / Ctrl+Alt+↓) via the real keyboard path.
  await shell.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+ArrowDown' : 'Control+Alt+ArrowDown')
  await expect.poll(() => activeId(app)).toBe(t1)
  await act(app, 'tab.previous')
  expect(await activeId(app)).toBe(p1)
})

test('[TB-06][TB-07] closing a Today tab archives it, selects the tab below and ⌘⇧T restores it with history', async () => {
  const { app, shell } = orbit
  const below = await newTab(app, fx.url('/page/Below'), { activate: false })
  const t = await newTab(app, fx.url('/page/A'))
  await waitTab(app, t, '/page/A')
  const page = await tabPage(app, '/page/A')
  await page.click('#next')
  await waitTab(app, t, '/page/A-next')
  const page2 = await tabPage(app, '/page/A-next')
  await page2.click('#next')
  await waitTab(app, t, '/page/A-next-next')
  // Close with the row's ×.
  await row(shell, t).hover()
  await row(shell, t).getByTestId('tab-close').click()
  await expect(row(shell, t)).toHaveCount(0)
  let s = await state(app)
  expect(s.tabs[t]).toBeUndefined()
  const newest = s.archive[s.archive.length - 1]
  expect(newest?.url).toContain('/page/A-next-next')
  expect(newest?.reason).toBe('closed')
  expect(await activeId(app)).toBe(below)
  expect(await liveTabs(app)).not.toContain(t)
  // ⌘⇧T brings it back selected, in place, with its back history.
  await shell.keyboard.press(`${MOD}+Shift+T`)
  await expect.poll(() => activeId(app)).toBe(t)
  s = await state(app)
  expect(s.spaces[s.spaceOrder[0] as string]?.today).toEqual([t, below])
  expect(s.archive.some((a) => a.id === newest?.id)).toBe(false)
  await waitTab(app, t, '/page/A-next-next')
  await act(app, 'nav.back')
  await waitTab(app, t, '/page/A-next')
  expect((await tab(app, t))?.url.endsWith('/page/A-next')).toBe(true)
  await act(app, 'nav.back')
  await expect.poll(async () => (await tab(app, t))?.url.endsWith('/page/A')).toBe(true)
  // Middle-click closes too.
  await row(shell, below).click({ button: 'middle' })
  await expect(row(shell, below)).toHaveCount(0)
})

test('[PN-01][PN-02] ⌘D pins to the end of the pinned section and back to the top of Today', async () => {
  const { app, shell } = orbit
  const sp = (await space(app)).id
  const p0 = await newTab(app, fx.url('/page/P0'), { container: { kind: 'pinned', spaceId: sp }, activate: false })
  const other = await newTab(app, fx.url('/page/Other'), { activate: false })
  const t = await newTab(app, fx.url('/page/Pin'))
  await waitTab(app, t, '/page/Pin')
  await shell.keyboard.press(`${MOD}+D`)
  await expect.poll(async () => (await space(app)).pinned).toEqual([p0, t])
  expect((await tab(app, t))?.pinnedUrl).toContain('/page/Pin')
  expect(await activeId(app)).toBe(t)
  await expect.poll(() => rowIds(shell, 'pinned-list')).toEqual([p0, t])
  // ⌘D again: back to the top of Today, no longer pinned.
  await shell.keyboard.press(`${MOD}+D`)
  await expect.poll(async () => (await space(app)).today).toEqual([t, other])
  expect((await tab(app, t))?.pinnedUrl).toBeUndefined()
  // No rename field opened along the way.
  await expect(shell.getByTestId('rename-field')).toHaveCount(0)
})

test('[PN-03][PN-04] a pinned tab that navigates away shows a breadcrumb; its favicon resets it', async () => {
  const { app, shell } = orbit
  const sp = (await space(app)).id
  const p = await newTab(app, fx.url('/page/Docs'), { container: { kind: 'pinned', spaceId: sp } })
  await waitTab(app, p, '/page/Docs')
  await expect(row(shell, p).getByTestId('tab-title')).toHaveText('Docs')
  const page = await tabPage(app, '/page/Docs')
  await page.click('#next')
  await waitTab(app, p, '/page/Docs-next')
  await expect(row(shell, p).getByTestId('tab-title')).toHaveText('Docs / Docs-next')
  // Hovering the favicon offers the way back.
  await row(shell, p).getByTestId('tab-icon').hover()
  await expect(row(shell, p).getByTestId('reset-pinned')).toBeVisible()
  await expect(row(shell, p)).toContainText('Return to pinned page')
  await row(shell, p).getByTestId('tab-icon').click()
  await waitTab(app, p, '/page/Docs')
  expect((await tab(app, p))?.url.endsWith('/page/Docs')).toBe(true)
  await shell.mouse.move(600, 600)
  await expect(row(shell, p).getByTestId('tab-title')).toHaveText('Docs')
  // ⌘-click resets too and keeps the page you were on as a new Today tab.
  const page3 = await tabPage(app, '/page/Docs')
  await page3.click('#next')
  await waitTab(app, p, '/page/Docs-next')
  await row(shell, p)
    .getByTestId('tab-icon')
    .click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] })
  await waitTab(app, p, '/page/Docs')
  const today = (await space(app)).today
  expect(today).toHaveLength(1)
  expect((await tab(app, today[0] as string))?.url).toContain('/page/Docs-next')
})

test('[PN-06] closing a pinned tab keeps its row, unloads it and reopens at the pinned URL', async () => {
  const { app, shell } = orbit
  const sp = (await space(app)).id
  const other = await newTab(app, fx.url('/page/Other'), { activate: false })
  const p = await newTab(app, fx.url('/page/Home'), { container: { kind: 'pinned', spaceId: sp } })
  await waitTab(app, p, '/page/Home')
  const page = await tabPage(app, '/page/Home')
  await page.click('#next')
  await waitTab(app, p, '/page/Home-next')
  await shell.keyboard.press(`${MOD}+W`)
  await expect.poll(async () => (await tab(app, p))?.asleep).toBe(true)
  expect((await space(app)).pinned).toEqual([p])
  expect((await tab(app, p))?.url).toContain('/page/Home')
  expect((await tab(app, p))?.url).not.toContain('next')
  expect(await liveTabs(app)).not.toContain(p)
  expect(await activeId(app)).toBe(other)
  await expect(row(shell, p)).toHaveClass(/is-asleep/)
  await expect(row(shell, p)).not.toHaveClass(/is-active/)
  // Clicking loads the pinned URL fresh.
  await row(shell, p).click()
  await waitTab(app, p, '/page/Home')
  expect((await tab(app, p))?.canGoBack).toBe(false)
})

test('[TB-08][PN-02] drag reorders Today, pins above the divider, unpins below, and Escape cancels', async () => {
  const { app, shell } = orbit
  const ids: string[] = []
  for (const n of [1, 2, 3, 4, 5]) ids.unshift(await newTab(app, fx.url(`/page/R${n}`), { activate: false }))
  // ids is top-to-bottom: R5..R1. Drag the 5th row (R1) to the top.
  await expect.poll(() => rowIds(shell, 'today-list')).toEqual(ids)
  await settled(shell)
  const fifth = row(shell, ids[4] as string)
  const top = await center(row(shell, ids[0] as string))
  await drag(shell, fifth, { x: top.x, y: top.box.y + 4 })
  const reordered = [ids[4], ids[0], ids[1], ids[2], ids[3]] as string[]
  await expect.poll(async () => (await space(app)).today).toEqual(reordered)
  await expect.poll(() => rowIds(shell, 'today-list')).toEqual(reordered)
  // Above the divider: pinned.
  const divider = await center(shell.getByTestId('today-divider'))
  await drag(shell, row(shell, ids[2] as string), { x: divider.x, y: divider.box.y + 2 })
  await expect.poll(async () => (await space(app)).pinned).toEqual([ids[2]])
  expect((await tab(app, ids[2] as string))?.pinnedUrl).toBeTruthy()
  // Back below the divider (top of Today): unpinned.
  const firstToday = await center(row(shell, reordered[0] as string))
  await drag(shell, row(shell, ids[2] as string), { x: firstToday.x, y: firstToday.box.y + 6 })
  await expect.poll(async () => (await space(app)).pinned).toEqual([])
  expect((await space(app)).today[0]).toBe(ids[2])
  expect((await tab(app, ids[2] as string))?.pinnedUrl).toBeUndefined()
  // Escape mid-drag springs back and changes nothing.
  const before = (await space(app)).today
  const last = row(shell, before[before.length - 1] as string)
  await drag(shell, last, { x: firstToday.x, y: firstToday.box.y + 2 }, { hold: true })
  await expect(shell.getByTestId('drag-ghost')).toBeVisible()
  // The source row is not drawn while its ghost is lifted (only the gap remains).
  await expect(last).toBeHidden()
  await shell.keyboard.press('Escape')
  await shell.mouse.up()
  await expect(shell.getByTestId('drag-ghost')).toHaveCount(0)
  expect((await space(app)).today).toEqual(before)
  await expect(shell.getByTestId('rename-field')).toHaveCount(0)
  // ⌘Z undoes the last move (the unpin).
  await tabsHook(app, 'undo')
  await expect.poll(async () => (await space(app)).pinned).toEqual([ids[2]])
})

test('[FD-01][FD-02][FD-03][FD-04][FD-05] folders: create, rename, collapse, drop into closed and open folders', async () => {
  const { app, shell } = orbit
  const sp = (await space(app)).id
  const pinned = await newTab(app, fx.url('/page/Pinned'), {
    container: { kind: 'pinned', spaceId: sp },
    activate: false,
  })
  const a = await newTab(app, fx.url('/page/A'), { activate: false })
  const b = await newTab(app, fx.url('/page/B'))
  await waitTab(app, b, '/page/B')
  // New Folder: at the end of the pinned section, in rename mode.
  await act(app, 'folder.new')
  const field = shell.getByTestId('rename-field')
  await expect(field).toBeFocused()
  const s1 = await space(app)
  const folderId = s1.pinned[1] as string
  expect(s1.pinned[0]).toBe(pinned)
  expect(folderId).toMatch(/^f-/)
  await field.fill('Work')
  await field.press('Enter')
  await expect(shell.getByTestId('folder-title')).toHaveText('Work')
  // Double-click renames; Escape cancels and keeps the old name.
  await shell.getByTestId('folder-title').dblclick()
  await shell.getByTestId('rename-field').fill('Nope')
  await shell.getByTestId('rename-field').press('Escape')
  await expect(shell.getByTestId('folder-title')).toHaveText('Work')
  // Click collapses (state persists in the folder).
  await shell.getByTestId('folder-row').click()
  await expect.poll(async () => (await state(app)).folders[folderId]?.collapsed).toBe(true)
  await expect(shell.getByTestId('folder-row')).toHaveAttribute('aria-expanded', 'false')
  // Drop the selected Today tab onto the closed folder: it goes in, gets pinned, and peeks.
  const folderRow = await center(shell.getByTestId('folder-row'))
  await drag(shell, row(shell, b), { x: folderRow.x, y: folderRow.y })
  await expect.poll(async () => (await state(app)).folders[folderId]?.children).toEqual([b])
  expect((await state(app)).folders[folderId]?.collapsed).toBe(true)
  expect((await tab(app, b))?.pinnedUrl).toBeTruthy()
  await expect(shell.getByTestId('folder-peek')).toBeVisible()
  await expect(shell.getByTestId('folder-peek').locator('[data-tab-id]')).toHaveAttribute('data-tab-id', b)
  // Selecting another tab tucks it away.
  await row(shell, a).click()
  await expect(shell.getByTestId('folder-peek')).toHaveCount(0)
  // Expand and drop A between... at the top of the open folder.
  await shell.getByTestId('folder-row').click()
  await expect(row(shell, b)).toBeVisible()
  const child = await center(row(shell, b))
  await drag(shell, row(shell, a), { x: child.x, y: child.box.y + 4 })
  await expect.poll(async () => (await state(app)).folders[folderId]?.children).toEqual([a, b])
  expect((await space(app)).today).toEqual([])
})

test('[TB-11][TB-14] context menus by tab type; Move to another Space selects the next tab here', async () => {
  const { app, shell } = orbit
  const sA = (await space(app)).id
  const sB = await cmd<string>(app, 'spaces.create', { name: 'Work', activate: false })
  const pinned = await newTab(app, fx.url('/page/Pinned'), {
    container: { kind: 'pinned', spaceId: sA },
    activate: false,
  })
  const below = await newTab(app, fx.url('/page/Below'), { activate: false })
  const t = await newTab(app, fx.url('/page/Mover'))
  await waitTab(app, t, '/page/Mover')
  await row(shell, t).click({ button: 'right' })
  const today = await tabsHook<string[]>(app, 'lastMenu')
  for (const label of [
    'Pin Tab',
    'Add to Favorites',
    'Rename…',
    'Change Icon…',
    'Copy Link',
    'Copy Link as Markdown',
    'Duplicate',
    'Mute Tab',
    'Move to > Favorites',
    'Move to > Work > Pinned',
    'Move to > Work > Today',
    'Archive Tabs Below',
    'Close Tab',
  ]) {
    expect(today).toContain(label)
  }
  expect(today).not.toContain('Unpin Tab')
  await row(shell, pinned).click({ button: 'right' })
  const pin = await tabsHook<string[]>(app, 'lastMenu')
  for (const label of [
    'Unpin Tab',
    'Reset to Pinned URL',
    'Pinned URL > Replace with Current URL',
    'Pinned URL > Edit…',
    'Delete from Sidebar',
  ]) {
    expect(pin).toContain(label)
  }
  expect(pin).not.toContain('Pin Tab')
  // Move the selected Today tab to Work's pinned section from the menu.
  await row(shell, t).click({ button: 'right' })
  expect(await tabsHook<boolean>(app, 'clickMenu', 'Move to > Work > Pinned')).toBe(true)
  await expect.poll(async () => (await state(app)).spaces[sB]?.pinned).toEqual([t])
  const s = await state(app)
  expect(s.spaces[sA]?.today).toEqual([below])
  const win = Object.values(s.windows)[0]
  expect(win?.spaceId).toBe(sA)
  expect(win?.activeTab[sA]).toBe(below)
  await expect(row(shell, t)).toHaveCount(0)
  // The moved page is no longer drawn here.
  await expect.poll(async () => (await tabView(app, t))?.visible ?? false).toBe(false)
})

test('[FV-01][FV-02][FV-03][FV-04][FV-05][FV-06] Favorites: add by drag, reorder, cap at 12, reset, remove', async () => {
  const { app, shell } = orbit
  const t = await newTab(app, fx.url('/page/Mail'))
  await waitTab(app, t, '/page/Mail')
  // Drag up above the Space title (no Favorites yet): it becomes the first Favorite.
  const title = await center(shell.getByTestId('space-name'))
  await drag(shell, row(shell, t), { x: title.x, y: title.box.y - 8 })
  await expect.poll(async () => (await state(app)).profiles[PROFILE]?.favorites).toEqual([t])
  await expect(shell.getByTestId('favorite-tile')).toHaveCount(1)
  expect((await tab(app, t))?.pinnedUrl).toContain('/page/Mail')
  // More Favorites from the command path; the grid shows up to 4 per row.
  const more: string[] = []
  for (const n of [2, 3, 4, 5]) more.push(await newTab(app, fx.url(`/page/Fav${n}`), { activate: false }))
  for (const id of more) expect(await cmd(app, 'tabs.favorite', { tabId: id })).toBe(true)
  const tiles = shell.getByTestId('favorite-tile')
  await expect(tiles).toHaveCount(5)
  // Four per row, the fifth wraps (wait for the pop-in to settle).
  await expect
    .poll(async () => {
      const [b0, b3, b4] = await Promise.all([0, 3, 4].map((i) => tiles.nth(i).boundingBox()))
      return Math.abs((b0?.y ?? 0) - (b3?.y ?? 99)) < 2 && (b4?.y ?? 0) > (b0?.y ?? 0) + 20
    })
    .toBe(true)
  // Reorder: drag the last tile before the first.
  const firstTile = await center(tiles.nth(0))
  await drag(shell, tiles.nth(4), { x: firstTile.box.x + 4, y: firstTile.y })
  await expect.poll(async () => (await state(app)).profiles[PROFILE]?.favorites?.[0]).toBe(more[3])
  // Cap: 12 per profile; a 13th is refused.
  for (const n of [6, 7, 8, 9, 10, 11, 12]) {
    const id = await newTab(app, fx.url(`/page/Fav${n}`), { activate: false })
    expect(await cmd(app, 'tabs.favorite', { tabId: id })).toBe(true)
  }
  const extra = await newTab(app, fx.url('/page/Extra'), { activate: false })
  expect(await cmd(app, 'tabs.favorite', { tabId: extra })).toBe(false)
  expect((await state(app)).profiles[PROFILE]?.favorites).toHaveLength(12)
  await expect(shell.getByTestId('toast').last()).toContainText('Favorites are full')
  // FV-06: navigate inside a Favorite, double-click the tile, and the saved URL loads.
  await shell.locator(`[data-fav-id="${t}"]`).click()
  await waitTab(app, t, '/page/Mail')
  const page = await tabPage(app, '/page/Mail')
  await page.click('#next')
  await waitTab(app, t, '/page/Mail-next')
  await expect(shell.locator(`[data-fav-id="${t}"]`).getByTestId('favorite-away')).toBeVisible()
  await shell.locator(`[data-fav-id="${t}"]`).dblclick()
  await expect.poll(async () => (await tab(app, t))?.url.endsWith('/page/Mail')).toBe(true)
  // FV-04: drag the tile down into Today.
  const divider = await center(shell.getByTestId('today-divider'))
  await drag(shell, shell.locator(`[data-fav-id="${t}"]`), { x: divider.x, y: divider.box.y + divider.box.height - 4 })
  await expect.poll(async () => (await space(app)).today[0]).toBe(t)
  expect((await state(app)).profiles[PROFILE]?.favorites).not.toContain(t)
  expect((await tab(app, t))?.pinnedUrl).toBeUndefined()
  // FV-01: a Space on another profile shows its own (empty) set.
  const work = await cmd<string>(app, 'profiles.create', { name: 'Work' })
  const sW = await cmd<string>(app, 'spaces.create', { name: 'W', profileId: work })
  await expect
    .poll(async () => (await state(app)).windows[Object.keys((await state(app)).windows)[0] as string]?.spaceId)
    .toBe(sW)
  await expect(shell.getByTestId('favorite-tile')).toHaveCount(0)
})

test('[TD-01][TD-02][TD-03][TD-06] idle Today tabs move to the Archive in every Space; pinned, playing and selected tabs stay', async () => {
  const { app } = orbit
  const sA = (await space(app)).id
  const sB = await cmd<string>(app, 'spaces.create', { name: 'B', activate: false })
  const idle = await newTab(app, fx.url('/page/Idle'), { activate: false })
  const loud = await newTab(app, fx.url('/page/Loud'), { activate: false })
  const pinned = await newTab(app, fx.url('/page/Pinned'), {
    container: { kind: 'pinned', spaceId: sA },
    activate: false,
  })
  const otherSpace = await newTab(app, fx.url('/page/InB'), { spaceId: sB, activate: false })
  const shown = await newTab(app, fx.url('/page/Shown'))
  await waitTab(app, shown, '/page/Shown')
  await setState(app, `d.tabs[arg].audible = true`, loud)
  const now = Date.now()
  // Not yet idle for 12 hours: nothing happens.
  expect((await tabsHook<{ archived: string[] }>(app, 'maintenance', now + 11 * 3600_000)).archived).toEqual([])
  const r = await tabsHook<{ archived: string[] }>(app, 'maintenance', now + 13 * 3600_000)
  expect(r.archived.sort()).toEqual([idle, otherSpace].sort())
  const s = await state(app)
  expect(s.tabs[idle]).toBeUndefined()
  expect(s.tabs[otherSpace]).toBeUndefined()
  expect(s.tabs[loud]).toBeTruthy()
  expect(s.tabs[pinned]).toBeTruthy()
  expect(s.tabs[shown]).toBeTruthy()
  const auto = s.archive.filter((a) => a.reason === 'auto').map((a) => a.url)
  expect(auto.some((u) => u.includes('/page/Idle'))).toBe(true)
  expect(auto.some((u) => u.includes('/page/InB'))).toBe(true)
  // TD-03: a longer period on the profile keeps a tab idle for 13 h.
  const again = await newTab(app, fx.url('/page/Again'), { activate: false })
  await setState(app, `d.profiles['${PROFILE}'].archiveAfterMs = 7 * 24 * 3600000`)
  expect((await tabsHook<{ archived: string[] }>(app, 'maintenance', Date.now() + 13 * 3600_000)).archived).toEqual([])
  expect((await state(app)).tabs[again]).toBeTruthy()
})

test('[TD-04][TD-06][TB-18] Clear archives this Space’s Today tabs only and ⌘Z brings them back in order', async () => {
  const { app, shell } = orbit
  const sA = (await space(app)).id
  const sB = await cmd<string>(app, 'spaces.create', { name: 'B', activate: false })
  const inB = await newTab(app, fx.url('/page/InB'), { spaceId: sB, activate: false })
  const pinned = await newTab(app, fx.url('/page/Pinned'), { container: { kind: 'pinned', spaceId: sA } })
  await waitTab(app, pinned, '/page/Pinned')
  const ids: string[] = []
  for (const n of [1, 2, 3]) ids.unshift(await newTab(app, fx.url(`/page/C${n}`), { activate: n === 3 }))
  await waitTab(app, ids[0] as string, '/page/C3')
  const archivedBefore = (await state(app)).archive.length
  await shell.getByTestId('today-divider').hover()
  await expect(shell.getByTestId('clear-today')).toBeVisible()
  await shell.getByTestId('clear-today').click()
  await expect.poll(async () => (await space(app)).today).toEqual([])
  const s = await state(app)
  expect(s.archive.length - archivedBefore).toBe(3)
  // The first Today tab is the newest Archive entry.
  expect(s.archive[s.archive.length - 1]?.url).toContain('/page/C3')
  expect(s.archive.slice(-3).every((a) => a.reason === 'cleared')).toBe(true)
  expect(s.spaces[sB]?.today).toEqual([inB])
  expect(s.spaces[sA]?.pinned).toEqual([pinned])
  // Selection moves to the last used pinned tab.
  expect(await activeId(app)).toBe(pinned)
  await expect(shell.getByTestId('today-list').locator('[data-slot="item"]:not([data-exiting])')).toHaveCount(0)
  // ⌘Z restores the batch in its original order.
  await shell.keyboard.press(`${MOD}+Z`)
  await expect.poll(async () => (await space(app)).today).toEqual(ids)
  expect((await state(app)).archive.length).toBe(archivedBefore)
})

test('[TB-22] relaunch restores windows, Spaces, pinned, Favorites, Today, folders and the selected tab', async () => {
  const { app, shell, userData } = orbit
  const sA = (await space(app)).id
  const fav = await newTab(app, fx.url('/page/Fav'), { container: FAV, activate: false })
  const pinned = await newTab(app, fx.url('/page/Pinned'), {
    container: { kind: 'pinned', spaceId: sA },
    activate: false,
  })
  const folderId = await cmd<string>(app, 'folders.create', { name: 'Box', items: [pinned] })
  await cmd(app, 'folders.setCollapsed', { folderId, collapsed: true })
  const t1 = await newTab(app, fx.url('/page/One'), { activate: false })
  const t2 = await newTab(app, fx.url('/page/Two'))
  await waitTab(app, t2, '/page/Two')
  await shell.keyboard.press('Escape')
  // The window's size comes back on relaunch.
  const bw = await app.browserWindow(shell)
  // Small enough for a 1024×768 CI screen (macOS clamps windows to the work area).
  await bw.evaluate((w) => w.setBounds({ x: 40, y: 40, width: 900, height: 600 }))
  await app.close()

  orbit = await launchOrbit({ userData })
  const after = await state(orbit.app)
  const sp = after.spaces[sA]
  expect(sp?.today).toEqual([t2, t1])
  expect(sp?.pinned).toEqual([folderId])
  expect(after.folders[folderId]?.collapsed).toBe(true)
  expect(after.folders[folderId]?.children).toEqual([pinned])
  expect(after.profiles[PROFILE]?.favorites).toEqual([fav])
  const w = Object.values(after.windows)[0]
  expect(w?.activeTab[sA]).toBe(t2)
  const shown = await (await orbit.app.browserWindow(orbit.shell)).evaluate((bw) => bw.getBounds())
  expect(shown.width).toBe(900)
  expect(shown.height).toBe(600)
  // Only the selected tab comes back loaded.
  await waitTab(orbit.app, t2, '/page/Two')
  expect(await liveTabs(orbit.app)).toEqual([t2])
  await expect(row(orbit.shell, t2)).toHaveClass(/is-active/)
  await expect(row(orbit.shell, t1)).toHaveClass(/is-asleep/)
})

test('[TB-09][SB-09] drop a tab on another Space’s switcher icon, then drag one out to a new window', async () => {
  const { app, shell } = orbit
  const sA = (await space(app)).id
  const sB = await cmd<string>(app, 'spaces.create', { name: 'B', activate: false })
  const keep = await newTab(app, fx.url('/page/Keep'), { activate: false })
  const t = await newTab(app, fx.url('/page/Travel'))
  await waitTab(app, t, '/page/Travel')
  const dot = await center(shell.locator(`[data-space-id="${sB}"]`))
  await drag(shell, row(shell, t), { x: dot.x, y: dot.y })
  await expect.poll(async () => (await state(app)).spaces[sB]?.today).toEqual([t])
  const s = await state(app)
  expect(s.spaces[sA]?.today).toEqual([keep])
  expect(Object.values(s.windows)[0]?.spaceId).toBe(sA)
  // Out of the window: a new window shows the tab as it was.
  await row(shell, keep).click()
  await waitTab(app, keep, '/page/Keep')
  const start = await center(row(shell, keep))
  await shell.mouse.move(start.x, start.y)
  await shell.mouse.down()
  await shell.mouse.move(start.x - 20, start.y + 4, { steps: 3 })
  await shell.mouse.move(-120, start.y + 40, { steps: 10 })
  await shell.mouse.up()
  await expect.poll(async () => Object.keys((await state(app)).windows).length).toBe(2)
  const s2 = await state(app)
  const wins = Object.values(s2.windows)
  const created = wins.find((w) => w.activeTab[sA] === keep)
  expect(created).toBeTruthy()
  const original = wins.find((w) => w !== created)
  expect(original?.activeTab[sA]).not.toBe(keep)
  await expect.poll(async () => (await tabView(app, keep))?.visible).toBe(true)
})

test('[SB-22][SB-23] the selected tab is scrolled into view; keyboard focus moves through rows', async () => {
  const { app, shell } = orbit
  const ids: string[] = []
  for (let n = 0; n < 40; n++) ids.unshift(await newTab(app, fx.url(`/page/S${n}`), { activate: false }))
  const scroll = shell.getByTestId('sidebar-scroll')
  await expect.poll(() => rowIds(shell, 'today-list').then((r) => r.length)).toBe(40)
  // Select the last tab (off screen): the list scrolls to it.
  await act(app, 'tab.goto.9')
  const last = ids[ids.length - 1] as string
  await expect.poll(() => activeId(app)).toBe(last)
  await expect(row(shell, last)).toBeInViewport()
  // Let the reveal scroll finish, then scroll away with the wheel (like a user): a pill points back.
  await expect
    .poll(() =>
      scroll.evaluate(async (el) => {
        const a = el.scrollTop
        await new Promise((r) => setTimeout(r, 120))
        return a === el.scrollTop
      }),
    )
    .toBe(true)
  await scroll.hover()
  await shell.mouse.wheel(0, -5000)
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBe(0)
  await expect(shell.getByTestId('reveal-active')).toBeVisible()
  await shell.getByTestId('reveal-active').click()
  await expect(row(shell, last)).toBeInViewport()
  // Keyboard: focus the sidebar, move up two rows, Enter opens.
  await act(app, 'sidebar.focus')
  await expect(row(shell, last)).toHaveClass(/is-focused/)
  await shell.keyboard.press('ArrowUp')
  await shell.keyboard.press('ArrowUp')
  const target = ids[ids.length - 3] as string
  await expect(row(shell, target)).toHaveClass(/is-focused/)
  await shell.keyboard.press('Enter')
  await expect.poll(() => activeId(app)).toBe(target)
})
