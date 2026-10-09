import { expect, test } from '@playwright/test'
import { type Fixtures, launchOrbit, MOD, type Orbit, startFixtures, state, tabPage } from './helpers'
import {
  act,
  activeId,
  cmd,
  liveTabs,
  newTab,
  PROFILE,
  row,
  setState,
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

const clipboardText = (o: Orbit) => o.app.evaluate(({ clipboard }) => clipboard.readText())
const MOD_KEY = process.platform === 'darwin' ? 'Meta' : 'Control'

test('[TB-13][TB-06][TB-20] Cmd/Shift-click select several tabs; Cmd+W closes them and Copy URL copies all', async () => {
  const { app, shell } = orbit
  const ids: string[] = []
  for (const n of [1, 2, 3, 4]) ids.unshift(await newTab(app, fx.url(`/page/M${n}?utm_source=x`), { activate: false }))
  const [a, b, c, d] = ids as [string, string, string, string]
  await row(shell, a).click()
  await row(shell, c).click({ modifiers: [MOD_KEY] })
  await expect(row(shell, a)).toHaveClass(/is-selected/)
  await expect(row(shell, c)).toHaveClass(/is-selected/)
  await row(shell, d).click({ modifiers: ['Shift'] })
  await expect(row(shell, d)).toHaveClass(/is-selected/)
  await expect(row(shell, b)).not.toHaveClass(/is-selected/)
  // Copy URL with a selection copies every selected tab's clean link, one per line.
  await shell.keyboard.press(`${MOD}+Shift+C`)
  await expect.poll(() => clipboardText(orbit)).toContain('/page/M4')
  const text = await clipboardText(orbit)
  expect(text.split('\n')).toHaveLength(3)
  expect(text).not.toContain('utm_source')
  // The menu offers group actions.
  await row(shell, c).click({ button: 'right' })
  const labels = await tabsHook<string[]>(app, 'lastMenu')
  expect(labels).toContain('Close 3 Tabs')
  expect(labels).toContain('New Folder with Tabs')
  // Cmd+W closes all of them.
  await shell.keyboard.press(`${MOD}+W`)
  await expect.poll(async () => (await space(app)).today).toEqual([b])
  // Escape or a plain click clears a selection.
  const e = await newTab(app, fx.url('/page/M5'), { activate: false })
  await row(shell, b).click()
  await row(shell, e).click({ modifiers: [MOD_KEY] })
  await expect(row(shell, e)).toHaveClass(/is-selected/)
  await shell.keyboard.press('Escape')
  await expect(shell.locator('.tab-row.is-selected')).toHaveCount(0)
})

test('[TB-10] Duplicate copies the page and its history directly below the original', async () => {
  const { app } = orbit
  const other = await newTab(app, fx.url('/page/Other'), { activate: false })
  const t = await newTab(app, fx.url('/page/Orig'))
  await waitTab(app, t, '/page/Orig')
  await (await tabPage(app, '/page/Orig')).click('#next')
  await waitTab(app, t, '/page/Orig-next')
  await act(app, 'tab.duplicate')
  await expect.poll(async () => (await space(app)).today.length).toBe(3)
  const today = (await space(app)).today
  const copy = today[1] as string
  expect(today).toEqual([t, copy, other])
  expect(await activeId(app)).toBe(copy)
  await waitTab(app, copy, '/page/Orig-next')
  await act(app, 'nav.back')
  await expect.poll(async () => (await tab(app, copy))?.url.endsWith('/page/Orig')).toBe(true)
})

test('[TB-12][PN-08] rename by double-click survives navigation and relaunch; empty reverts; emoji icon', async () => {
  const { app, shell, userData } = orbit
  const sp = (await space(app)).id
  const p = await newTab(app, fx.url('/page/Inbox'), { container: { kind: 'pinned', spaceId: sp } })
  await waitTab(app, p, '/page/Inbox')
  await row(shell, p).getByTestId('tab-title').dblclick()
  const field = shell.getByTestId('rename-field')
  await expect(field).toBeFocused()
  await field.fill('Mail')
  await field.press('Enter')
  await expect(row(shell, p).getByTestId('tab-title')).toHaveText('Mail')
  // Navigating away keeps the name in the breadcrumb.
  await (await tabPage(app, '/page/Inbox')).click('#next')
  await waitTab(app, p, '/page/Inbox-next')
  await expect(row(shell, p).getByTestId('tab-title')).toHaveText('Mail / Inbox-next')
  // Emoji icon replaces the favicon.
  await row(shell, p).click({ button: 'right' })
  expect(await tabsHook<boolean>(app, 'clickMenu', 'Change Icon…')).toBe(true)
  await expect(shell.getByTestId('icon-picker')).toBeVisible()
  await shell.getByTestId('icon-choice').first().click()
  await expect(row(shell, p).locator('.tab-row__emoji')).toHaveText('⭐')
  await app.close()
  orbit = await launchOrbit({ userData })
  await expect(row(orbit.shell, p).getByTestId('tab-title')).toContainText('Mail')
  await expect(row(orbit.shell, p).locator('.tab-row__emoji')).toHaveText('⭐')
  // Saving an empty name reverts to the page title.
  await row(orbit.shell, p).getByTestId('tab-title').dblclick()
  await orbit.shell.getByTestId('rename-field').fill('')
  await orbit.shell.getByTestId('rename-field').press('Enter')
  await expect.poll(async () => (await tab(orbit.app, p))?.customTitle).toBeUndefined()
})

test('[TB-15] the audio icon on a row mutes and unmutes the tab', async () => {
  const { app, shell } = orbit
  const t = await newTab(app, fx.url('/page/Sound'))
  await waitTab(app, t, '/page/Sound')
  await setState(app, 'd.tabs[arg].audible = true', t)
  const audio = row(shell, t).getByTestId('tab-audio')
  await expect(audio).toHaveAttribute('aria-label', 'Mute tab')
  await audio.click()
  await expect.poll(async () => (await tab(app, t))?.muted).toBe(true)
  await expect(audio).toHaveAttribute('aria-label', 'Unmute tab')
  const muted = await app.evaluate(
    (_e, id) =>
      (
        globalThis as unknown as { __orbit: { ctx: { tabs: { contents: (id: string) => Electron.WebContents } } } }
      ).__orbit.ctx.tabs
        .contents(id)
        .isAudioMuted(),
    t,
  )
  expect(muted).toBe(true)
})

test('[TB-16][FV-08] idle background tabs sleep; Favorites stay warm longer; playing and shown tabs never sleep', async () => {
  const { app } = orbit
  const fav = await newTab(app, fx.url('/page/Fav'), { container: { kind: 'favorites', profileId: PROFILE } })
  await waitTab(app, fav, '/page/Fav')
  const bg = await newTab(app, fx.url('/page/Bg'))
  await waitTab(app, bg, '/page/Bg')
  const loud = await newTab(app, fx.url('/page/Loud'))
  await waitTab(app, loud, '/page/Loud')
  const shown = await newTab(app, fx.url('/page/Shown'))
  await waitTab(app, shown, '/page/Shown')
  await setState(app, 'd.tabs[arg].audible = true', loud)
  expect((await liveTabs(app)).sort()).toEqual([fav, bg, loud, shown].sort())
  const after = (await state(app)).settings.sleepAfterMs
  const now = Date.now()
  const first = await tabsHook<{ slept: string[] }>(app, 'maintenance', now + after + 60_000)
  expect(first.slept).toEqual([bg])
  expect(await liveTabs(app)).not.toContain(bg)
  expect((await tab(app, bg))?.asleep).toBe(true)
  const later = await tabsHook<{ slept: string[] }>(app, 'maintenance', now + after * 4 + 60_000)
  expect(later.slept).toEqual([fav])
  expect((await liveTabs(app)).sort()).toEqual([loud, shown].sort())
})

test('[TB-18][TD-05] undo walks back archive-below, a rename and a move', async () => {
  const { app, shell } = orbit
  const ids: string[] = []
  for (const n of [1, 2, 3, 4]) ids.unshift(await newTab(app, fx.url(`/page/U${n}`), { activate: false }))
  const [top] = ids as [string]
  await cmd(app, 'tabs.move', { id: ids[3], to: { kind: 'today', spaceId: (await space(app)).id }, index: 0 })
  const moved = [ids[3], ids[0], ids[1], ids[2]]
  expect((await space(app)).today).toEqual(moved)
  await cmd(app, 'tabs.rename', { tabId: top, title: 'Renamed' })
  await row(shell, top).click({ button: 'right' })
  expect(await tabsHook<boolean>(app, 'clickMenu', 'Archive Tabs Below')).toBe(true)
  await expect.poll(async () => (await space(app)).today).toEqual([ids[3], ids[0]])
  // ⌘Z three times: archive-below, rename, move.
  await shell.keyboard.press(`${MOD}+Z`)
  await expect.poll(async () => (await space(app)).today).toEqual(moved)
  await shell.keyboard.press(`${MOD}+Z`)
  await expect.poll(async () => (await tab(app, top))?.customTitle).toBeUndefined()
  await shell.keyboard.press(`${MOD}+Z`)
  await expect.poll(async () => (await space(app)).today).toEqual(ids)
})

test('[TB-19] Back on a link-opened tab with no history closes it and returns to the opener', async () => {
  const { app } = orbit
  const opener = await newTab(app, fx.url('/page/Opener'))
  await waitTab(app, opener, '/page/Opener')
  await (await tabPage(app, '/page/Opener')).click('#external')
  await expect.poll(async () => (await space(app)).today.length).toBe(2)
  const child = (await space(app)).today[0] as string
  await waitTab(app, child, '/page/External')
  await act(app, 'nav.back')
  await expect.poll(async () => (await state(app)).tabs[child]).toBeUndefined()
  expect(await activeId(app)).toBe(opener)
})

test('[PN-07][PN-04] edit the pinned URL inline, or replace it with the current page', async () => {
  const { app, shell } = orbit
  const sp = (await space(app)).id
  const p = await newTab(app, fx.url('/page/Start'), { container: { kind: 'pinned', spaceId: sp } })
  await waitTab(app, p, '/page/Start')
  await (await tabPage(app, '/page/Start')).click('#next')
  await waitTab(app, p, '/page/Start-next')
  await row(shell, p).click({ button: 'right' })
  expect(await tabsHook<boolean>(app, 'clickMenu', 'Pinned URL > Replace with Current URL')).toBe(true)
  await expect.poll(async () => (await tab(app, p))?.pinnedUrl).toContain('/page/Start-next')
  await expect(row(shell, p).getByTestId('tab-title')).toHaveText('Start-next')
  // Edit… opens an inline field with the pinned URL.
  await row(shell, p).click({ button: 'right' })
  expect(await tabsHook<boolean>(app, 'clickMenu', 'Pinned URL > Edit…')).toBe(true)
  const field = shell.getByTestId('rename-field')
  await expect(field).toHaveValue(/\/page\/Start-next/)
  await field.fill(fx.url('/page/Home'))
  await field.press('Enter')
  await expect.poll(async () => (await tab(app, p))?.pinnedUrl).toContain('/page/Home')
  await act(app, 'tab.resetToPinned')
  await waitTab(app, p, '/page/Home')
})

test('[PN-09] collapsing the pinned section hides its rows except the selected one and persists per Space', async () => {
  const { app, shell } = orbit
  const sp = (await space(app)).id
  const p1 = await newTab(app, fx.url('/page/P1'), { container: { kind: 'pinned', spaceId: sp }, activate: false })
  const p2 = await newTab(app, fx.url('/page/P2'), { container: { kind: 'pinned', spaceId: sp } })
  const t = await newTab(app, fx.url('/page/T'), { activate: false })
  await shell.getByTestId('space-header').hover()
  await shell.getByTestId('pinned-toggle').click()
  await expect.poll(async () => (await space(app)).pinnedCollapsed).toBe(true)
  await expect(row(shell, p1)).toHaveCount(0)
  // The selected pinned tab stays visible under the title, which turns bold.
  await expect(shell.getByTestId('pinned-peek')).toBeVisible()
  await expect(row(shell, p2)).toBeVisible()
  await expect(shell.getByTestId('space-header')).toHaveClass(/has-hidden-active/)
  // Keyboard traversal skips the hidden pinned tab.
  await act(app, 'tab.next')
  expect(await activeId(app)).toBe(t)
  await act(app, 'tab.next')
  expect(await activeId(app)).toBe(t)
  await expect(shell.getByTestId('pinned-peek')).toHaveCount(0)
  await act(app, 'pinned.toggleCollapsed')
  await expect.poll(async () => (await space(app)).pinnedCollapsed).toBeFalsy()
  await expect(row(shell, p1)).toBeVisible()
})

test('[FV-07][FD-09][FD-06][FD-07][FD-10] Favorite and folder menus, nested folders, folder icon, delete and undo', async () => {
  const { app, shell } = orbit
  const sp = (await space(app)).id
  const fav = await newTab(app, fx.url('/page/Fav'), { container: { kind: 'favorites', profileId: PROFILE } })
  await waitTab(app, fav, '/page/Fav')
  await shell.locator(`[data-fav-id="${fav}"]`).click({ button: 'right' })
  const favMenu = await tabsHook<string[]>(app, 'lastMenu')
  for (const label of [
    'Remove from Favorites',
    'Reset to Pinned URL',
    'Change Icon…',
    'Pinned URL > Edit…',
    'Mute Tab',
    'Copy Link',
    'Close Tab',
  ]) {
    expect(favMenu).toContain(label)
  }
  const inner = await newTab(app, fx.url('/page/Inner'), {
    container: { kind: 'pinned', spaceId: sp },
    activate: false,
  })
  const outer = await cmd<string>(app, 'folders.create', { name: 'Outer', items: [inner] })
  await shell.keyboard.press('Escape')
  const nested = await cmd<string>(app, 'folders.create', {
    name: 'Nested',
    container: { kind: 'folder', folderId: outer },
    index: 0,
  })
  await shell.keyboard.press('Escape')
  await expect.poll(async () => (await state(app)).folders[outer]?.children).toEqual([nested, inner])
  // Nested rows indent further.
  const outerBox = await shell.locator(`[data-folder-id="${outer}"] > [data-slot] .folder-row`).boundingBox()
  const nestedPad = await shell
    .locator(`[data-folder-id="${nested}"] .folder-row`)
    .first()
    .evaluate((el) => getComputedStyle(el).paddingLeft)
  expect(Number.parseInt(nestedPad, 10)).toBeGreaterThan(8)
  expect(outerBox).toBeTruthy()
  await cmd(app, 'folders.setIcon', { folderId: outer, icon: '📚' })
  await expect(shell.locator(`[data-folder-id="${outer}"] .tab-row__emoji`).first()).toHaveText('📚')
  await shell.locator(`[data-folder-id="${outer}"] .folder-row`).first().click({ button: 'right' })
  const folderMenu = await tabsHook<string[]>(app, 'lastMenu')
  for (const label of [
    'Rename…',
    'Change Icon…',
    'Duplicate Folder',
    'Copy All Links',
    'Paste URL as New Tab',
    'Delete Folder…',
  ]) {
    expect(folderMenu).toContain(label)
  }
  expect(await tabsHook<boolean>(app, 'clickMenu', 'Duplicate Folder')).toBe(true)
  await expect.poll(async () => (await space(app)).pinned.length).toBe(2)
  const copy = (await space(app)).pinned[1] as string
  expect((await state(app)).folders[copy]?.name).toBe('Outer copy')
  // Delete moves the contents to the Archive; undo restores the whole folder.
  await shell.locator(`[data-folder-id="${outer}"] .folder-row`).first().click({ button: 'right' })
  expect(await tabsHook<boolean>(app, 'clickMenu', 'Delete Folder…')).toBe(true)
  await expect.poll(async () => (await state(app)).folders[outer]).toBeUndefined()
  let s = await state(app)
  expect(s.tabs[inner]).toBeUndefined()
  expect(s.folders[nested]).toBeUndefined()
  expect(s.archive[s.archive.length - 1]?.url).toContain('/page/Inner')
  await tabsHook(app, 'undo')
  await expect.poll(async () => (await state(app)).folders[outer]?.children).toEqual([nested, inner])
  s = await state(app)
  expect(s.tabs[inner]).toBeTruthy()
  expect(s.spaces[sp]?.pinned[0]).toBe(outer)
})

test('[TB-02] a link dropped on the sidebar and a pasted URL open as new Today tabs', async () => {
  const { app, shell } = orbit
  const url = fx.url('/page/Dropped')
  const dt = await shell.evaluateHandle((u) => {
    const d = new DataTransfer()
    d.setData('text/uri-list', u)
    return d
  }, url)
  await shell.getByTestId('sidebar-scroll').dispatchEvent('dragover', { dataTransfer: dt })
  await shell.getByTestId('sidebar-scroll').dispatchEvent('drop', { dataTransfer: dt })
  await expect.poll(async () => (await space(app)).today.length).toBe(1)
  const dropped = (await space(app)).today[0] as string
  await waitTab(app, dropped, '/page/Dropped')
  // Plain text becomes a search; here we paste a URL with Cmd/Ctrl+Alt+V.
  await app.evaluate(({ clipboard }, u) => clipboard.writeText(u), fx.url('/page/Pasted'))
  await act(app, 'tab.pasteAsNewTab')
  await expect.poll(async () => (await space(app)).today.length).toBe(2)
  const pasted = (await space(app)).today[0] as string
  await waitTab(app, pasted, '/page/Pasted')
  expect(await activeId(app)).toBe(pasted)
})
