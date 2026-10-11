import { expect, test } from '@playwright/test'
import { type Fixtures, launchOrbit, MOD, type Orbit, startFixtures, state, tabPage, viewPage } from './helpers'
import {
  act,
  activeId,
  center,
  chooseRowMenu,
  closeOverlay,
  cmd,
  liveTabs,
  menuFor,
  newTab,
  PROFILE,
  row,
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
  const labels = await menuFor(app, c)
  expect(labels).toContain('Close 3 Tabs')
  expect(labels).toContain('New Folder with Tabs')
  // Cmd+W closes all of them (once the menu is closed: while it is open, its keys are its own, KS-19).
  await closeOverlay(app)
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
  await menuFor(app, p)
  expect(await chooseRowMenu(app, 'Change Icon…')).toBe(true)
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

test('[TB-18][TD-05] undo walks back archive-below, a rename and a move; redo re-applies them', async () => {
  const { app, shell } = orbit
  const ids: string[] = []
  for (const n of [1, 2, 3, 4]) ids.unshift(await newTab(app, fx.url(`/page/U${n}`), { activate: false }))
  const [top] = ids as [string]
  await cmd(app, 'tabs.move', { id: ids[3], to: { kind: 'today', spaceId: (await space(app)).id }, index: 0 })
  const moved = [ids[3], ids[0], ids[1], ids[2]]
  expect((await space(app)).today).toEqual(moved)
  await cmd(app, 'tabs.rename', { tabId: top, title: 'Renamed' })
  await row(shell, top).click({ button: 'right' })
  await menuFor(app, top)
  expect(await chooseRowMenu(app, 'Archive Tabs Below')).toBe(true)
  await expect.poll(async () => (await space(app)).today).toEqual([ids[3], ids[0]])
  // ⌘Z three times: archive-below, rename, move.
  await shell.keyboard.press(`${MOD}+Z`)
  await expect.poll(async () => (await space(app)).today).toEqual(moved)
  await shell.keyboard.press(`${MOD}+Z`)
  await expect.poll(async () => (await tab(app, top))?.customTitle).toBeUndefined()
  await shell.keyboard.press(`${MOD}+Z`)
  await expect.poll(async () => (await space(app)).today).toEqual(ids)
  // ⌘⇧Z redoes, most recently undone first: the move, then the rename.
  await shell.keyboard.press(`${MOD}+Shift+Z`)
  await expect.poll(async () => (await space(app)).today).toEqual(moved)
  await shell.keyboard.press(`${MOD}+Shift+Z`)
  await expect.poll(async () => (await tab(app, top))?.customTitle).toBe('Renamed')
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
  await menuFor(app, p)
  expect(await chooseRowMenu(app, 'Pinned URL > Replace with Current URL')).toBe(true)
  await expect.poll(async () => (await tab(app, p))?.pinnedUrl).toContain('/page/Start-next')
  await expect(row(shell, p).getByTestId('tab-title')).toHaveText('Start-next')
  // Edit… opens an inline field with the pinned URL.
  await row(shell, p).click({ button: 'right' })
  await menuFor(app, p)
  expect(await chooseRowMenu(app, 'Pinned URL > Edit…')).toBe(true)
  const field = shell.getByTestId('rename-field')
  await expect(field).toHaveValue(/\/page\/Start-next/)
  await field.fill(fx.url('/page/Home'))
  await field.press('Enter')
  await expect.poll(async () => (await tab(app, p))?.pinnedUrl).toContain('/page/Home')
  // Something that isn't a web address is refused (the pinned URL stays).
  await cmd(app, 'tabs.setPinnedUrl', { tabId: p, url: 'not a web address' })
  expect((await tab(app, p))?.pinnedUrl).toContain('/page/Home')
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
  const favMenu = await menuFor(app, fav)
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
  await closeOverlay(app)
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
  const folderMenu = await menuFor(app, outer)
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
  expect(await chooseRowMenu(app, 'Duplicate Folder')).toBe(true)
  await expect.poll(async () => (await space(app)).pinned.length).toBe(2)
  const copy = (await space(app)).pinned[1] as string
  expect((await state(app)).folders[copy]?.name).toBe('Outer copy')
  // Delete moves the contents to the Archive; undo restores the whole folder.
  await shell.locator(`[data-folder-id="${outer}"] .folder-row`).first().click({ button: 'right' })
  await menuFor(app, outer)
  expect(await chooseRowMenu(app, 'Delete Folder…')).toBe(true)
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
  // At the top of Today: a dropped link opens where it is dropped (NV-08).
  const top = await shell.getByTestId('new-tab-button').boundingBox()
  const at = top ? { clientX: top.x + top.width / 2, clientY: top.y + top.height / 2 } : {}
  await shell.getByTestId('sidebar-scroll').dispatchEvent('dragover', { dataTransfer: dt, ...at })
  await shell.getByTestId('sidebar-scroll').dispatchEvent('drop', { dataTransfer: dt, ...at })
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

test('[TB-05] Ctrl+Tab goes to the previous tab; holding Ctrl and tapping Tab walks back through recent tabs', async () => {
  const { app } = orbit
  const a = await newTab(app, fx.url('/page/A'))
  await waitTab(app, a, '/page/A')
  const b = await newTab(app, fx.url('/page/B'))
  await waitTab(app, b, '/page/B')
  const c = await newTab(app, fx.url('/page/C'))
  await waitTab(app, c, '/page/C')
  await cmd(app, 'tabs.focusPage', {})
  await expect
    .poll(() => app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL()))
    .toBe(fx.url('/page/C'))
  // Each key goes to whatever has the keyboard, as a keyboard's do: from the first Tab on, that is
  // the switcher's overlay (finish-tabs lane, TB-05).
  const keys = (...events: [type: 'keyDown' | 'keyUp', keyCode: string, control: boolean][]) =>
    app.evaluate(({ webContents }, list) => {
      for (const [type, keyCode, control] of list)
        webContents.getFocusedWebContents()?.sendInputEvent({ type, keyCode, modifiers: control ? ['control'] : [] })
    }, events)
  const tabKey: [type: 'keyDown' | 'keyUp', keyCode: string, control: boolean][] = [
    ['keyDown', 'Tab', true],
    ['keyUp', 'Tab', true],
  ]
  // Quick tap and release: back to B.
  await keys(['keyDown', 'Control', true], ...tabKey, ['keyUp', 'Control', false])
  await expect.poll(() => activeId(app)).toBe(b)
  // Hold Control, Tab twice, release: A (C was used before A now that B is current).
  await keys(['keyDown', 'Control', true], ...tabKey, ...tabKey, ['keyUp', 'Control', false])
  await expect.poll(() => activeId(app)).toBe(a)
  // Then a single tap returns to B, the tab used just before.
  await keys(['keyDown', 'Control', true], ...tabKey, ['keyUp', 'Control', false])
  await expect.poll(() => activeId(app)).toBe(b)
})

test('[FL-21][SB-23] 200 tabs: the sidebar mounts and scrolls without long main-thread stalls', async () => {
  const { app, shell } = orbit
  await app.evaluate(async () => {
    const g = globalThis as unknown as {
      __orbit: { run: (n: string, a: unknown, w?: string) => Promise<unknown>; windowIds: () => string[] }
    }
    const w = g.__orbit.windowIds()[0]
    for (let i = 0; i < 200; i++) await g.__orbit.run('tabs.create', { url: `about:blank#t${i}`, activate: false }, w)
  })
  await expect.poll(async () => (await space(app)).today.length).toBe(200)
  await expect(shell.getByTestId('today-list').locator(':scope > [data-slot]')).toHaveCount(200, { timeout: 30_000 })
  // Hosted CI runners have 2 slow cores: 200 rows can take longer than 10 s to finish entering.
  await settled(shell, 30_000)
  const longTasks = await shell.evaluate(async () => {
    const tasks: number[] = []
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) tasks.push(e.duration)
    })
    obs.observe({ entryTypes: ['longtask'] })
    const sc = document.querySelector('[data-testid="sidebar-scroll"]') as HTMLElement
    for (let i = 0; i < 60; i++) {
      sc.scrollTop += 120
      await new Promise((r) => requestAnimationFrame(r))
    }
    for (let i = 0; i < 60; i++) {
      sc.scrollTop -= 120
      await new Promise((r) => requestAnimationFrame(r))
    }
    await new Promise((r) => setTimeout(r, 100))
    obs.disconnect()
    return tasks
  })
  // Guard against pathological stalls (e.g. every row animating at once). Frame-accurate numbers
  // come from the perf harness on a quiet machine; e2e may share the CPU with another worker.
  // CI runners are 3–4× slower than a dev machine, so the stall limit scales there.
  const stall = process.env.CI ? 300 : 120
  expect(
    longTasks.filter((d) => d > stall),
    `long tasks: ${longTasks.map((d) => Math.round(d)).join(', ')}`,
  ).toEqual([])
  expect(longTasks.length).toBeLessThan(process.env.CI ? 8 : 4)
  // A title change re-renders one row, not the list: measured as a single row's DOM update. Rows
  // far from the visible band are not drawn (FL-21): this one shows its new title once scrolled to.
  const t = (await space(app)).today[100] as string
  await cmd(app, 'tabs.rename', { tabId: t, title: 'Renamed in place' })
  await shell.locator(`[data-slot][data-key="${t}"]`).scrollIntoViewIfNeeded()
  await expect(row(shell, t).getByTestId('tab-title')).toHaveText('Renamed in place')
})

test('[FL-21] a row that leaves the screen while it grows in still ends at its full height', async () => {
  const { app, shell } = orbit
  await app.evaluate(async () => {
    const g = globalThis as unknown as {
      __orbit: { run: (n: string, a: unknown, w?: string) => Promise<unknown>; windowIds: () => string[] }
    }
    const w = g.__orbit.windowIds()[0]
    for (let i = 0; i < 60; i++) await g.__orbit.run('tabs.create', { url: `about:blank#t${i}`, activate: false }, w)
  })
  await expect(shell.getByTestId('today-list').locator(':scope > [data-slot]')).toHaveCount(60, { timeout: 30_000 })
  await settled(shell, 30_000)
  // A new row grows in at the top. Caught mid-growth, the list scrolls far down and the row finishes
  // off-screen, where rows aren't drawn (FL-21): it must not keep the height it left with.
  type Seen = { caught: number; offscreen: number }
  let seen: Seen | null = null
  for (let attempt = 0; attempt < 3 && !seen; attempt++) {
    await shell.evaluate(() => {
      const sc = document.querySelector('[data-testid="sidebar-scroll"]') as HTMLElement
      sc.scrollTop = 0
      const keys = [...document.querySelectorAll<HTMLElement>('.row-slot')].map((e) => e.dataset.key)
      ;(window as unknown as { __rows: Set<string | undefined> }).__rows = new Set(keys)
    })
    const watched = shell.evaluate(
      () =>
        new Promise<Seen | null>((resolve) => {
          const known = (window as unknown as { __rows: Set<string | undefined> }).__rows
          const sc = document.querySelector('[data-testid="sidebar-scroll"]') as HTMLElement
          const t0 = performance.now()
          const tick = () => {
            const slots = [...document.querySelectorAll<HTMLElement>('.row-slot')]
            const fresh = slots.find((e) => !known.has(e.dataset.key))
            if (fresh && fresh.offsetHeight > 0 && fresh.offsetHeight < 30) {
              const caught = fresh.offsetHeight
              sc.scrollTop = 1e6
              setTimeout(() => resolve({ caught, offscreen: fresh.offsetHeight }), 1500)
            } else if (performance.now() - t0 > 5000) resolve(null)
            else requestAnimationFrame(tick)
          }
          tick()
        }),
    )
    await shell.waitForTimeout(100)
    await cmd(app, 'tabs.create', { url: `about:blank#late${attempt}`, activate: false })
    seen = await watched
  }
  expect(seen, 'a new row was caught while it grew in').not.toBeNull()
  expect(seen?.offscreen, `caught at ${seen?.caught}px`).toBe(32)
})

test('[FD-08][FD-04] folder search lists its tabs, filters as you type and opens the match under the closed folder', async () => {
  const { app, shell } = orbit
  const sp = (await space(app)).id
  const a = await newTab(app, fx.url('/page/Alpha'), { container: { kind: 'pinned', spaceId: sp }, activate: false })
  const b = await newTab(app, fx.url('/page/Beta'), { container: { kind: 'pinned', spaceId: sp }, activate: false })
  const c = await newTab(app, fx.url('/page/Gamma'), { container: { kind: 'pinned', spaceId: sp }, activate: false })
  await cmd(app, 'tabs.rename', { tabId: b, title: 'Budget sheet' })
  const folderId = await cmd<string>(app, 'folders.create', { name: 'Work', items: [a, b, c] })
  await shell.keyboard.press('Escape')
  await cmd(app, 'folders.setCollapsed', { folderId, collapsed: true })
  const folderRow = shell.locator(`[data-folder-id="${folderId}"] .folder-row`).first()
  await folderRow.hover()
  await folderRow.getByTestId('folder-search-button').click()
  await expect(shell.getByTestId('folder-search')).toBeVisible()
  await expect(shell.getByTestId('folder-search-item')).toHaveCount(3)
  // Custom names are searchable; the first match is preselected.
  await shell.getByTestId('folder-search-input').fill('budg')
  await expect(shell.getByTestId('folder-search-item')).toHaveCount(1)
  await expect(shell.getByTestId('folder-search-item').first()).toHaveAttribute('aria-selected', 'true')
  await shell.getByTestId('folder-search-input').press('Enter')
  await expect.poll(() => activeId(app)).toBe(b)
  await expect(shell.getByTestId('folder-search')).toHaveCount(0)
  expect((await state(app)).folders[folderId]?.collapsed).toBe(true)
  await expect(shell.getByTestId('folder-peek').locator(`[data-tab-id="${b}"]`)).toBeVisible()
  // Escape closes without opening anything.
  await folderRow.hover()
  await folderRow.getByTestId('folder-search-button').click()
  await shell.getByTestId('folder-search-input').press('Escape')
  await expect(shell.getByTestId('folder-search')).toHaveCount(0)
  expect(await activeId(app)).toBe(b)
})

test('[TB-10][TB-09] dragging with Alt held drops a copy with its history and leaves the original', async () => {
  const { app, shell } = orbit
  const other = await newTab(app, fx.url('/page/Other'), { activate: false })
  const t = await newTab(app, fx.url('/page/Src'))
  await waitTab(app, t, '/page/Src')
  await (await tabPage(app, '/page/Src')).click('#next')
  await waitTab(app, t, '/page/Src-next')
  const divider = await center(shell.getByTestId('today-divider'))
  const start = await center(row(shell, t))
  await shell.mouse.move(start.x, start.y)
  await shell.mouse.down()
  await shell.mouse.move(start.x, start.y + 6, { steps: 2 })
  await shell.mouse.move(divider.x, divider.box.y + 2, { steps: 10 })
  await shell.keyboard.down('Alt')
  await shell.mouse.move(divider.x, divider.box.y + 3, { steps: 2 })
  await shell.mouse.up()
  await shell.keyboard.up('Alt')
  await expect.poll(async () => (await space(app)).pinned.length).toBe(1)
  const copy = (await space(app)).pinned[0] as string
  expect(copy).not.toBe(t)
  expect((await space(app)).today).toEqual([t, other])
  expect(await activeId(app)).toBe(t)
  await expect(row(shell, t)).toBeVisible()
  // The copy has the original's back history.
  await row(shell, copy).click()
  await waitTab(app, copy, '/page/Src-next')
  await act(app, 'nav.back')
  await expect.poll(async () => (await tab(app, copy))?.url.endsWith('/page/Src')).toBe(true)
})

test('[FL-07][PN-02] a row pinned with Cmd+D travels to the pinned section instead of popping in', async () => {
  const { app, shell } = orbit
  const ids: string[] = []
  for (const n of [1, 2, 3]) ids.unshift(await newTab(app, fx.url(`/page/F${n}`), { activate: false }))
  const third = ids[2] as string
  await row(shell, third).click()
  await waitTab(app, third, '/page/F1')
  await settled(shell)
  const before = await row(shell, third).boundingBox()
  await shell.keyboard.press(`${MOD}+D`)
  const slot = shell.getByTestId('pinned-list').locator(`[data-slot][data-key="${third}"]`)
  await expect(slot).toHaveClass(/is-travelling/)
  // It starts where it was and settles into the pinned section. The room it left in Today is never
  // drawn, and goes once its own spring settles, which can be a frame after the row lands.
  await expect(slot).not.toHaveClass(/is-travelling/)
  await expect(shell.getByTestId('today-list').locator(`[data-slot][data-key="${third}"]`)).toHaveCount(0)
  const after = await shell
    .getByTestId('pinned-list')
    .locator(`[data-testid="tab-row"][data-tab-id="${third}"]`)
    .boundingBox()
  expect((after?.y ?? 0) < (before?.y ?? 0)).toBe(true)
  expect((await space(app)).pinned).toEqual([third])
})

test('[TB-09][TB-11] holding a dragged tab at the sidebar edge slides to the next Space, where it can be dropped', async () => {
  const { app, shell } = orbit
  const sA = (await space(app)).id
  const sB = await cmd<string>(app, 'spaces.create', { name: 'B', activate: false })
  const inB = await newTab(app, fx.url('/page/InB'), { spaceId: sB, activate: false })
  const t = await newTab(app, fx.url('/page/Mover'))
  await waitTab(app, t, '/page/Mover')
  const start = await center(row(shell, t))
  const sidebar = await shell.getByTestId('sidebar').boundingBox()
  const edgeX = (sidebar?.x ?? 0) + (sidebar?.width ?? 248) + 4
  await shell.mouse.move(start.x, start.y)
  await shell.mouse.down()
  await shell.mouse.move(start.x, start.y + 6, { steps: 2 })
  await shell.mouse.move(edgeX, start.y + 20, { steps: 8 })
  // Hold near the right edge: the window shows the next Space.
  await expect.poll(async () => Object.values((await state(app)).windows)[0]?.spaceId, { timeout: 4000 }).toBe(sB)
  // Drop at the top of that Space's Today.
  const target = await shell.locator(`[data-tab-id="${inB}"]`).boundingBox()
  await shell.mouse.move(start.x, (target?.y ?? 0) + 4, { steps: 8 })
  await shell.mouse.up()
  await expect.poll(async () => (await state(app)).spaces[sB]?.today).toEqual([t, inB])
  expect((await state(app)).spaces[sA]?.today).toEqual([])
})

test('[TB-06] Cmd+W in a window with nothing selected closes that window', async () => {
  const { app } = orbit
  await act(app, 'window.new')
  await expect.poll(async () => Object.keys((await state(app)).windows).length).toBe(2)
  // The new window shows an empty Space: Cmd+W closes it.
  await act(app, 'tab.close', 1)
  await expect.poll(async () => Object.keys((await state(app)).windows).length).toBe(1)
})

test('[TB-07] recently closed tabs are listed newest first and any of them can be reopened', async () => {
  const { app } = orbit
  const a = await newTab(app, fx.url('/page/ClosedA'))
  await waitTab(app, a, '/page/ClosedA')
  const b = await newTab(app, fx.url('/page/ClosedB'))
  await waitTab(app, b, '/page/ClosedB')
  await cmd(app, 'tabs.close', { tabId: a })
  await cmd(app, 'tabs.close', { tabId: b })
  const list = await cmd<{ tabId: string; title: string }[]>(app, 'tabs.recentlyClosed')
  expect(list.map((r) => r.tabId)).toEqual([b, a])
  expect(list[1]?.title).toBe('ClosedA')
  // Reopen the older one directly (as the command bar would).
  expect(await cmd(app, 'tabs.reopenClosed', { tabId: a })).toBe(a)
  await expect.poll(() => activeId(app)).toBe(a)
  expect((await cmd<{ tabId: string }[]>(app, 'tabs.recentlyClosed')).map((r) => r.tabId)).toEqual([b])
})

test('[TB-02][TB-03] a Cmd/Ctrl-clicked link opens a background tab at the top of Today; with the sidebar hidden a toast says so', async () => {
  const { app } = orbit
  const t = await newTab(app, fx.url('/page/Links'))
  await waitTab(app, t, '/page/Links')
  const page = await tabPage(app, '/page/Links')
  await page.click('#next', { modifiers: [MOD_KEY] })
  await expect.poll(async () => (await space(app)).today.length).toBe(2)
  const bg = (await space(app)).today[0] as string
  expect(await activeId(app)).toBe(t)
  expect((await tab(app, bg))?.url).toContain('/page/Links-next')
  // Sidebar hidden: the background open is announced, over the page (SB-13).
  await cmd(app, 'window.setSidebar', { visible: false })
  await page.click('#next', { modifiers: [MOD_KEY] })
  await expect.poll(async () => (await space(app)).today.length).toBe(3)
  await expect((await viewPage(app, 'toasts')).getByTestId('toast').last()).toContainText('Opened in a new tab')
  expect(await activeId(app)).toBe(t)
})

test('[TB-13][TB-06] a selection made in one Space never acts in another (lane review MF-3)', async () => {
  const { app, shell } = orbit
  const sA = (await space(app)).id
  const sB = await cmd<string>(app, 'spaces.create', { name: 'B', activate: false })
  const inB = await newTab(app, fx.url('/page/InB'), { spaceId: sB, activate: false })
  const a2 = await newTab(app, fx.url('/page/A2'), { activate: false })
  const a1 = await newTab(app, fx.url('/page/A1'))
  await waitTab(app, a1, '/page/A1')
  // Space A: Cmd-click a second row (the selected tab joins the selection).
  await row(shell, a2).click({ modifiers: [MOD_KEY] })
  await expect(shell.locator('.tab-row.is-selected')).toHaveCount(2)
  // Switch to Space B and select its tab; the selection is gone.
  await cmd(app, 'spaces.switch', { spaceId: sB })
  await cmd(app, 'tabs.activate', { tabId: inB })
  await expect(shell.locator('.tab-row.is-selected')).toHaveCount(0)
  // Cmd+W closes only B's tab, never A's.
  await act(app, 'tab.close')
  await expect.poll(async () => (await state(app)).tabs[inB]).toBeUndefined()
  const s = await state(app)
  expect(s.spaces[sA]?.today).toEqual([a1, a2])
  // Even if the sidebar's selection message is stale, main ignores a selection outside the view.
  await cmd(app, 'tabs.setSelection', { tabIds: [a1, a2] })
  const another = await newTab(app, fx.url('/page/B2'), { spaceId: sB })
  await waitTab(app, another, '/page/B2')
  await act(app, 'tab.close')
  await expect.poll(async () => (await state(app)).tabs[another]).toBeUndefined()
  expect((await state(app)).spaces[sA]?.today).toEqual([a1, a2])
})
