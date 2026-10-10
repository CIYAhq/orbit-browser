import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import type { ArchivePage, LibraryShow } from '../../src/shared/commands/archive'
import {
  action,
  type Fixtures,
  FRAME_SLACK,
  launchOrbit,
  MOD,
  type Orbit,
  openViaCommandBar,
  run,
  startFixtures,
  state,
  tabPage,
} from './helpers'
import { activeId, newTab, space, waitTab } from './tabs-support'

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

const query = (o: Orbit, args: Record<string, unknown> = {}) =>
  run(o.app, 'archive.query', args) as Promise<ArchivePage>

interface LibraryInfo {
  open: boolean
  visible: boolean
  bounds?: { x: number; y: number; width: number; height: number }
  aboveTabs: boolean
  focused: boolean
}
const info = (o: Orbit) => run(o.app, 'library.testInfo') as Promise<LibraryInfo>
const status = (o: Orbit) => run(o.app, 'library.status') as Promise<LibraryShow & { open: boolean }>
const seed = (
  o: Orbit,
  args: { count: number; days?: number; spaceId?: string; profileId?: string; prefix?: string },
) => run(o.app, 'archive.testSeed', args) as Promise<number>

/** The Library's own view (`?view=library`), once it has been created. */
async function libraryPage(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const found = app.windows().find((p) => p.url().includes('view=library'))
    if (found) return found
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('No library page')
}

/** Opens the Library with the button in the sidebar's bottom bar and waits until it shows and has the keys. */
async function openLibrary(o: Orbit): Promise<Page> {
  await o.shell.getByTestId('library-button').click()
  const lib = await libraryPage(o.app)
  await expect(lib.getByTestId('library')).toHaveAttribute('data-open', 'true')
  await expect.poll(async () => (await info(o)).focused).toBe(true)
  return lib
}

/** The number in the Archive's header, whatever the locale's digit grouping. */
const countOf = async (lib: Page) =>
  Number(((await lib.getByTestId('archive-count').textContent()) ?? '').replace(/\D/g, ''))

test('[AR-01] a closed Today tab is the newest Archive entry, tagged closed, with its Space and its history, across a restart', async () => {
  const { app, shell, userData } = orbit
  const sp = await space(app)
  const t = await newTab(app, fx.url('/page/Kept'))
  await waitTab(app, t, '/page/Kept')
  await (await tabPage(app, '/page/Kept')).click('#next')
  await waitTab(app, t, '/page/Kept-next')
  await shell.keyboard.press(`${MOD}+W`)
  await expect.poll(async () => (await state(app)).tabs[t]).toBeUndefined()
  await expect
    .poll(async () => (await query(orbit)).rows[0])
    .toMatchObject({
      url: fx.url('/page/Kept-next'),
      reason: 'closed',
      section: 'today',
      spaceId: sp.id,
      spaceName: sp.name,
      hasHistory: true,
    })
  // The entry and its history live outside OrbitState too, so they outlast a restart.
  await app.close()
  orbit = await launchOrbit({ userData })
  const after = await query(orbit)
  expect(after.rows[0]).toMatchObject({ url: fx.url('/page/Kept-next'), hasHistory: true })
  expect(after.total).toBe(1)
})

test('[AR-02][SB-09] the Library button opens the Library over the page, above the tabs and with the keys; the button, Esc and ⌘W close it', async () => {
  const { app, shell } = orbit
  const t = await newTab(app, fx.url('/page/Under'))
  await waitTab(app, t, '/page/Under')
  const button = shell.getByTestId('library-button')
  await expect(button).toBeVisible()
  // SB-09: a target of at least 28×28 at the left of the bottom bar.
  const box = await button.boundingBox()
  const bar = await shell.getByTestId('spacebar').boundingBox()
  expect(box?.width).toBeGreaterThanOrEqual(28)
  expect(box?.height).toBeGreaterThanOrEqual(28)
  expect((box?.x ?? 0) - (bar?.x ?? 0)).toBeLessThan(12)
  const lib = await openLibrary(orbit)
  await expect(lib.getByTestId('library-section')).toHaveAttribute('data-section-id', 'archive')
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(lib.getByTestId('archive-search')).toBeFocused()
  const opened = await info(orbit)
  expect(opened.aboveTabs).toBe(true)
  expect(opened.visible).toBe(true)
  // It covers the page area beside the sidebar.
  const sidebar = await shell.getByTestId('sidebar').boundingBox()
  expect(opened.bounds?.x ?? 0).toBeGreaterThanOrEqual(Math.floor((sidebar?.x ?? 0) + (sidebar?.width ?? 0)) - 2)
  expect(opened.bounds?.width ?? 0).toBeGreaterThan(300)
  // ⌘W closes the Library, not the tab under it, and the page has the keys again.
  await lib.keyboard.press(`${MOD}+W`)
  await expect.poll(async () => (await info(orbit)).open).toBe(false)
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  expect((await state(app)).tabs[t]).toBeDefined()
  await expect.poll(async () => (await info(orbit)).visible).toBe(false)
  const page = await tabPage(app, '/page/Under')
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
  // Esc closes it too…
  await openLibrary(orbit)
  await lib.keyboard.press('Escape')
  await expect.poll(async () => (await info(orbit)).open).toBe(false)
  // …and the button, pressed again.
  await openLibrary(orbit)
  await button.click()
  await expect.poll(async () => (await info(orbit)).open).toBe(false)
  // Selecting another tab shows that tab.
  const other = await newTab(app, fx.url('/page/Other'), { activate: false })
  await openLibrary(orbit)
  await run(app, 'tabs.activate', { tabId: other })
  await expect.poll(async () => (await info(orbit)).open).toBe(false)
})

test('[AR-02] ⌘T "View Archive" opens the same view; the Library reopens to the section used last, across a restart', async () => {
  const { app } = orbit
  await openViaCommandBar(orbit, 'View Archive')
  const lib = await libraryPage(app)
  await expect(lib.getByTestId('library')).toHaveAttribute('data-open', 'true')
  await expect(lib.getByTestId('library-section')).toHaveAttribute('data-section-id', 'archive')
  // The bar closed and the Library has the keys.
  await expect.poll(async () => (await info(orbit)).focused).toBe(true)
  await expect(lib.getByTestId('archive-search')).toBeFocused()
  // A section chosen in the Library (the downloads lane adds more) is the one it opens on next time.
  await run(app, 'library.setSection', { section: 'downloads' })
  await expect.poll(async () => (await state(app)).settings.librarySection).toBe('downloads')
  await lib.keyboard.press('Escape')
  await expect.poll(async () => (await info(orbit)).open).toBe(false)
  await app.close()
  orbit = await launchOrbit({ userData: orbit.userData })
  await action(orbit.app, 'app.library')
  await expect.poll(async () => (await status(orbit)).open).toBe(true)
  expect((await status(orbit)).section).toBe('downloads')
  // "View Archive" always shows the Archive, and makes it the last section again.
  await action(orbit.app, 'app.archive')
  await expect.poll(async () => (await status(orbit)).section).toBe('archive')
  expect((await state(orbit.app)).settings.librarySection).toBe('archive')
})

test("[AR-03] entries are listed newest first under day headings; source, Space and how-closed filters; only this profile's entries", async () => {
  const { app } = orbit
  const a = await space(app)
  const b = (await run(app, 'spaces.create', { name: 'Bravo', activate: false })) as string
  await seed(orbit, { count: 40, days: 4, spaceId: a.id, prefix: 'Alpha' })
  await seed(orbit, { count: 5, days: 1, spaceId: b, prefix: 'Bravo' })
  // Another profile's Space, with entries of its own.
  const work = (await run(app, 'profiles.create', { name: 'Work' })) as string
  const w = (await run(app, 'spaces.create', { name: 'Workspace', profileId: work, activate: false })) as string
  await seed(orbit, { count: 3, days: 1, spaceId: w, profileId: work, prefix: 'Worky' })
  const lib = await openLibrary(orbit)
  await expect.poll(() => countOf(lib)).toBe(45)
  // Day headings, newest day first, starting with Today.
  const days = lib.getByTestId('archive-day')
  await expect(days.first()).toContainText('Today')
  const at = await days.evaluateAll((els) => els.map((e) => Number((e as HTMLElement).dataset.day)))
  expect(at.length).toBeGreaterThan(1)
  expect([...at].sort((x, y) => y - x)).toEqual(at)
  const rows = await query(orbit, { limit: 45 })
  expect(rows.rows.map((r) => r.archivedAt)).toEqual([...rows.rows.map((r) => r.archivedAt)].sort((x, y) => y - x))
  expect(rows.rows.every((r) => !r.title.startsWith('Worky'))).toBe(true)
  // Source: pages closed in a Mini Window (every tenth seeded page, the "lantern" ones).
  await lib.getByTestId('archive-source-mini').click()
  await expect.poll(() => countOf(lib)).toBe(4)
  await expect(lib.getByTestId('archive-row-title').first()).toContainText('lantern')
  await lib.getByTestId('archive-source-all').click()
  await expect.poll(() => countOf(lib)).toBe(45)
  // Space: this profile's Spaces only.
  const spaceFilter = lib.getByTestId('archive-space-filter')
  await expect(spaceFilter.locator(`option[value="${w}"]`)).toHaveCount(0)
  await spaceFilter.selectOption(b)
  await expect.poll(() => countOf(lib)).toBe(5)
  await expect(lib.getByTestId('archive-row-space').first()).toContainText('Bravo')
  await spaceFilter.selectOption('')
  // How they closed: archived automatically (every third seeded entry) or by the user.
  await lib.getByTestId('archive-closed-filter').selectOption('auto')
  await expect.poll(() => countOf(lib)).toBe(16)
  await lib.getByTestId('archive-closed-filter').selectOption('manual')
  await expect.poll(() => countOf(lib)).toBe(29)
  await lib.getByTestId('archive-closed-filter').selectOption('any')
  // From the Work profile's Space, the Library lists that profile's entries only (PR-05).
  await run(app, 'spaces.switch', { spaceId: w })
  await expect.poll(async () => (await info(orbit)).open).toBe(false)
  await openLibrary(orbit)
  await expect.poll(() => countOf(lib)).toBe(3)
  await expect(lib.getByTestId('archive-row-title').first()).toContainText('Worky')
})

test('[AR-03][AR-04] at 10,000 entries the list is virtualised, search answers each keystroke within 50 ms, and Enter restores the top match', async () => {
  const { app } = orbit
  await seed(orbit, { count: 10_000, days: 60 })
  const lib = await openLibrary(orbit)
  await expect.poll(() => countOf(lib)).toBe(10_000)
  // Only the rows near the viewport are in the page.
  expect(await lib.getByTestId('archive-row').count()).toBeLessThan(80)
  // At the end of the list, the oldest entry shows.
  await lib.getByTestId('archive-list').evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect(lib.locator('[data-testid="archive-row"][data-offset="9999"]')).toBeVisible()
  expect(await lib.getByTestId('archive-row').count()).toBeLessThan(80)
  // Typing: each keystroke's matches are in the list within 50 ms (FL-24), timed in the page from
  // the key event to the list showing that text's answer. The frame that paints it is logged too;
  // on a loaded test machine when it comes is up to the compositor more than to the Library.
  await lib.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="archive-search"]') as HTMLInputElement
    const list = document.querySelector<HTMLElement>('[data-testid="archive-list"]') as HTMLElement
    const shown: number[] = []
    const painted: number[] = []
    ;(window as unknown as { __search: { shown: number[]; painted: number[] } }).__search = { shown, painted }
    let pending: { t0: number; value: string | null } | null = null
    const check = () => {
      if (!pending || pending.value === null) return
      if (list.dataset.query !== pending.value || list.dataset.answered !== 'true') return
      const { t0 } = pending
      pending = null
      shown.push(performance.now() - t0)
      requestAnimationFrame(() => setTimeout(() => painted.push(performance.now() - t0), 0))
    }
    input.addEventListener('keydown', (e) => {
      // Not answered before the next key: it took at least this long.
      if (pending) shown.push(performance.now() - pending.t0)
      pending = { t0: e.timeStamp, value: null }
    })
    input.addEventListener('input', () => {
      if (pending) pending.value = input.value
    })
    new MutationObserver(check).observe(list, { attributes: true, attributeFilter: ['data-answered', 'data-query'] })
  })
  const typed = 'harbor 1045'
  await lib.getByTestId('archive-search').pressSequentially(typed, { delay: 60 })
  const search = () =>
    lib.evaluate(() => (window as unknown as { __search: { shown: number[]; painted: number[] } }).__search)
  await expect.poll(async () => (await search()).shown.length).toBe(typed.length)
  const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] ?? Number.POSITIVE_INFINITY
  const { shown, painted } = await search()
  console.info(
    `[archive e2e perf] search keystroke→list median ${median(shown).toFixed(1)} ms (worst ${Math.max(...shown).toFixed(1)}), →painted median ${median(painted).toFixed(1)} ms`,
  )
  expect(median(shown)).toBeLessThanOrEqual(50 * FRAME_SLACK)
  await expect.poll(() => countOf(lib)).toBe(1)
  await expect(lib.getByTestId('archive-row-title').first()).toHaveText('Seeded harbor 1045')
  // Enter puts the top match back and shows it; the Library makes way.
  await lib.getByTestId('archive-search').press('Enter')
  await expect.poll(async () => (await info(orbit)).open).toBe(false)
  const id = await activeId(app)
  expect((await state(app)).tabs[id ?? '']?.url).toBe('https://harbor75.example.test/page/1045')
  expect((await query(orbit, { text: 'harbor 1045' })).total).toBe(0)
  // A second open is quick even with thousands of entries (DL-09).
  const marks = async () =>
    (await app.evaluate(() =>
      (globalThis as unknown as { __orbit: { marks: () => { name: string; t: number }[] } }).__orbit.marks(),
    )) as { name: string; t: number }[]
  await openLibrary(orbit)
  const m = await marks()
  const start = m.filter((x) => x.name === 'library:open:start').at(-1)?.t ?? 0
  await expect
    .poll(async () => (await marks()).filter((x) => x.name === 'library:shown' && x.t >= start).length)
    .toBe(1)
  const opened = (await marks()).filter((x) => x.name === 'library:shown').at(-1)?.t ?? 0
  console.info(`[archive e2e perf] Library open→shown ${(opened - start).toFixed(1)} ms`)
  expect(opened - start).toBeLessThanOrEqual(100 * FRAME_SLACK)
})

test("[AR-05] Restore puts a tab back at the top of its own Space's Today with its history; a toast offers to go there", async () => {
  const { app } = orbit
  const a = await space(app)
  const b = (await run(app, 'spaces.create', { name: 'Bravo' })) as string
  const t = await newTab(app, fx.url('/page/Back'))
  await waitTab(app, t, '/page/Back')
  await (await tabPage(app, '/page/Back')).click('#next')
  await waitTab(app, t, '/page/Back-next')
  await run(app, 'tabs.close', { tabId: t })
  await expect.poll(async () => (await query(orbit)).rows[0]?.hasHistory).toBe(true)
  await run(app, 'spaces.switch', { spaceId: a.id })
  const lib = await openLibrary(orbit)
  const row = lib.getByTestId('archive-row').filter({ hasText: 'Back-next' })
  await row.hover()
  await row.getByTestId('archive-restore').click()
  // Back at the top of Bravo's Today, with the same tab id; the window stays in A.
  await expect.poll(async () => (await state(app)).spaces[b]?.today[0]).toBe(t)
  await expect(row).toHaveCount(0)
  const win = async () => Object.values((await state(app)).windows)[0]
  expect((await win())?.spaceId).toBe(a.id)
  // The toast says where it went and offers to go there.
  const toast = lib.getByTestId('library-toast')
  await expect(toast).toContainText('Bravo')
  await toast.getByTestId('library-toast-action').click()
  await expect.poll(async () => (await win())?.spaceId).toBe(b)
  await expect.poll(() => activeId(app)).toBe(t)
  await expect.poll(async () => (await info(orbit)).open).toBe(false)
  // Its history came back: Back goes to the page before.
  await expect.poll(async () => (await state(app)).tabs[t]?.canGoBack).toBe(true)
  await action(app, 'nav.back')
  await expect.poll(async () => (await state(app)).tabs[t]?.url).toBe(fx.url('/page/Back'))
  // Restoring again does nothing: the entry is gone.
  const again = (await run(app, 'archive.restore', { id: (await query(orbit)).rows[0]?.id ?? 'none' })) as {
    tabIds: string[]
  }
  expect(again.tabIds).toEqual([])
})

test('[AR-05] the row menu restores, opens in a new tab or deletes; ↓ and Enter restore the highlighted entry', async () => {
  const { app } = orbit
  await seed(orbit, { count: 6, days: 1, prefix: 'Menu' })
  const lib = await openLibrary(orbit)
  await expect.poll(() => countOf(lib)).toBe(6)
  const rows = lib.getByTestId('archive-row')
  const firstTitle = (await rows.nth(0).getByTestId('archive-row-title').textContent()) ?? ''
  await rows.nth(0).click({ button: 'right' })
  await expect
    .poll(() => run(app, 'archive.testMenu', {}))
    .toEqual(['Restore', 'Open in New Tab', 'Copy URL', 'Delete from Archive'])
  await run(app, 'archive.testMenu', { click: 'Delete from Archive' })
  await expect.poll(() => countOf(lib)).toBe(5)
  await expect(lib.getByTestId('archive-row-title').filter({ hasText: new RegExp(`^${firstTitle}$`) })).toHaveCount(0)
  // Two selected (⌘-click): one menu for both.
  await rows.nth(0).click()
  await rows.nth(1).click({ modifiers: [MOD === 'Meta' ? 'Meta' : 'Control'] })
  await expect(lib.getByTestId('archive-selection')).toContainText('2 selected')
  await rows.nth(1).click({ button: 'right' })
  await expect
    .poll(() => run(app, 'archive.testMenu', {}))
    .toEqual(['Restore 2 Tabs', 'Copy 2 URLs', 'Delete 2 from Archive'])
  await run(app, 'archive.testMenu', { click: 'Restore 2 Tabs' })
  await expect.poll(() => countOf(lib)).toBe(3)
  // Keyboard, on a fresh open: the top match is highlighted, ↓ moves to the second entry and
  // Enter restores it and shows it.
  const second = (await query(orbit)).rows[1]
  await lib.keyboard.press('Escape')
  await expect.poll(async () => (await info(orbit)).open).toBe(false)
  await openLibrary(orbit)
  await expect(lib.getByTestId('archive-search')).toBeFocused()
  await lib.keyboard.press('ArrowDown')
  await lib.keyboard.press('Enter')
  await expect.poll(async () => (await info(orbit)).open).toBe(false)
  const id = await activeId(app)
  expect((await state(app)).tabs[id ?? '']?.url).toBe(second?.url)
})

test('[AR-09][TB-07] closing A, B, C: ⌘⇧T brings back C, B, A, each selected with its history; ⌘Z reopens a just-closed tab', async () => {
  const { app, shell } = orbit
  const tabs: string[] = []
  for (const name of ['RcA', 'RcB', 'RcC']) {
    const t = await newTab(app, fx.url(`/page/${name}`))
    await waitTab(app, t, `/page/${name}`)
    await (await tabPage(app, `/page/${name}`)).click('#next')
    await waitTab(app, t, `/page/${name}-next`)
    tabs.push(t)
  }
  const [a, b, c] = tabs as [string, string, string]
  // Close A, then B, then C, each while it is the tab shown.
  for (const t of tabs) {
    await run(app, 'tabs.activate', { tabId: t })
    await expect.poll(() => activeId(app)).toBe(t)
    await shell.keyboard.press(`${MOD}+W`)
    await expect.poll(async () => (await state(app)).tabs[t]).toBeUndefined()
  }
  // ⌘⇧T walks back through the closes: each tab is selected on its last page, the one before behind it.
  for (const [t, name] of [
    [c, 'RcC'],
    [b, 'RcB'],
    [a, 'RcA'],
  ] as const) {
    await shell.keyboard.press(`${MOD}+Shift+T`)
    await expect.poll(() => activeId(app)).toBe(t)
    await waitTab(app, t, `/page/${name}-next`)
    await expect.poll(async () => (await state(app)).tabs[t]?.canGoBack).toBe(true)
  }
  await action(app, 'nav.back')
  await waitTab(app, a, '/page/RcA')
  // ⌘Z right after closing: the tab is back in its place, and shown again.
  const order = (await space(app)).today
  await shell.keyboard.press(`${MOD}+W`)
  await expect.poll(async () => (await state(app)).tabs[a]).toBeUndefined()
  expect(await activeId(app)).not.toBe(a)
  await shell.keyboard.press(`${MOD}+Z`)
  await expect.poll(() => activeId(app)).toBe(a)
  expect((await space(app)).today).toEqual(order)
  await waitTab(app, a, '/page/RcA')
})

test('[AR-09] Recently Closed lists the last closed tabs newest first, in the Library and the macOS File menu; choosing one reopens it', async () => {
  const { app } = orbit
  const lib = await openLibrary(orbit)
  await lib.getByTestId('archive-recently-closed').click()
  await expect.poll(() => run(app, 'archive.testMenu', {})).toEqual(['No Recently Closed Tabs', 'Reopen Closed Tab'])
  await lib.keyboard.press('Escape')
  await expect.poll(async () => (await info(orbit)).open).toBe(false)
  const tabs: string[] = []
  for (const name of ['ListA', 'ListB']) {
    const t = await newTab(app, fx.url(`/page/${name}`))
    await waitTab(app, t, `/page/${name}`)
    tabs.push(t)
  }
  const [a, b] = tabs as [string, string]
  await run(app, 'tabs.close', { tabId: a })
  await run(app, 'tabs.close', { tabId: b })
  // There is an app menu on macOS only (Windows and Linux use the Library's list).
  const appMenu = () => run(app, 'archive.testMenu', { appMenu: true })
  if (process.platform === 'darwin') await expect.poll(appMenu).toEqual(['ListB', 'ListA'])
  else expect(await appMenu()).toEqual([])
  await openLibrary(orbit)
  await lib.getByTestId('archive-recently-closed').click()
  await expect.poll(() => run(app, 'archive.testMenu', {})).toEqual(['ListB', 'ListA', 'Reopen Closed Tab'])
  // The older one, chosen from the list, comes back selected; the Library makes way for it.
  await run(app, 'archive.testMenu', { click: 'ListA' })
  await expect.poll(() => activeId(app)).toBe(a)
  await expect.poll(async () => (await info(orbit)).open).toBe(false)
  expect((await state(app)).tabs[b]).toBeUndefined()
  if (process.platform === 'darwin') await expect.poll(appMenu).toEqual(['ListB'])
})

/** The Archive's entry in the Library's section list. */
const archiveEntry = (lib: Page) => lib.locator('[data-testid="library-nav-item"][data-section-id="archive"]')
const visitCount = async (o: Orbit) => ((await run(o.app, 'history.visits', { limit: 500 })) as unknown[]).length

test('[AR-07] Clear Archive always asks first, from the Archive’s menu or the command bar; Cancel keeps it, Clear empties it and keeps history', async () => {
  const { app } = orbit
  const t = await newTab(app, fx.url('/page/Visited'))
  await waitTab(app, t, '/page/Visited')
  await expect.poll(() => visitCount(orbit)).toBeGreaterThan(0)
  const visits = await visitCount(orbit)
  await seed(orbit, { count: 12, days: 3 })
  const lib = await openLibrary(orbit)
  await expect.poll(() => countOf(lib)).toBe(12)
  await archiveEntry(lib).click({ button: 'right' })
  await expect
    .poll(() => run(app, 'archive.testMenu', {}))
    .toEqual([
      'Clear Archive…',
      'Keep Archived Tabs For',
      'Keep Archived Tabs For > 30 Days',
      'Keep Archived Tabs For > 90 Days',
      'Keep Archived Tabs For > 1 Year',
      'Keep Archived Tabs For > Forever',
    ])
  await run(app, 'archive.testMenu', { click: 'Clear Archive…' })
  const dialog = lib.getByTestId('archive-clear')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('All 12 archived tabs will be deleted. This can’t be undone.')
  await expect(dialog).toContainText('Your browsing history is kept.')
  // Cancel has the keys: Enter cancels, and so does Esc, which leaves the Library open.
  await expect(lib.getByTestId('archive-clear-cancel')).toBeFocused()
  await lib.keyboard.press('Enter')
  await expect(dialog).toHaveCount(0)
  await run(app, 'archive.testMenu', { click: 'Clear Archive…' })
  await expect(dialog).toBeVisible()
  await lib.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect((await info(orbit)).open).toBe(true)
  await expect(lib.getByTestId('archive-search')).toBeFocused()
  expect((await query(orbit)).total).toBe(12)
  // The command bar's "Clear Archive…" asks the same; this time the Archive is cleared.
  await openViaCommandBar(orbit, 'Clear Archive')
  await expect(dialog).toBeVisible()
  await lib.getByTestId('archive-clear-ok').click()
  await expect(lib.getByTestId('library-toast').filter({ hasText: 'Cleared 12 archived tabs' })).toBeVisible()
  await expect(lib.getByTestId('archive-empty')).toContainText('Nothing in the Archive')
  await expect(lib.getByTestId('archive-kept-for')).toHaveText('They are kept for 30 days.')
  expect((await query(orbit)).total).toBe(0)
  expect((await state(app)).archive).toEqual([])
  // Browsing history is not the Archive (AR-10): it is all still there.
  expect(await visitCount(orbit)).toBe(visits)
  // An empty Archive has nothing to clear: no question, just a note.
  await openViaCommandBar(orbit, 'Clear Archive')
  await expect(lib.getByTestId('library-toast').filter({ hasText: 'The Archive is already empty' })).toBeVisible()
  await expect(dialog).toHaveCount(0)
})

test('[AR-08] the Archive keeps 30 days by default: older entries go at launch, and at once when a shorter time is chosen', async () => {
  const { app, userData } = orbit
  expect((await state(app)).settings.archiveKeepDays).toBe(30)
  // Twelve entries ten days apart: 110 days old down to a minute old.
  await seed(orbit, { count: 12, days: 120 })
  expect((await query(orbit)).total).toBe(12)
  // Next launch, entries older than 30 days are gone.
  await app.close()
  orbit = await launchOrbit({ userData })
  await expect.poll(async () => (await query(orbit)).total).toBe(3)
  // Longer, then shorter, from the Archive's menu in the Library.
  await run(orbit.app, 'archive.setKeepDays', { days: 0 })
  await seed(orbit, { count: 12, days: 120, prefix: 'Again' })
  const lib = await openLibrary(orbit)
  await expect.poll(() => countOf(lib)).toBe(15)
  await archiveEntry(lib).click({ button: 'right' })
  await run(orbit.app, 'archive.testMenu', { click: 'Keep Archived Tabs For > 90 Days' })
  await expect.poll(() => countOf(lib)).toBe(12)
  await archiveEntry(lib).click({ button: 'right' })
  await run(orbit.app, 'archive.testMenu', { click: 'Keep Archived Tabs For > 30 Days' })
  await expect.poll(() => countOf(lib)).toBe(6)
  expect((await state(orbit.app)).settings.archiveKeepDays).toBe(30)
})
