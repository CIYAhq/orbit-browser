import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import type { ArchivePage, ArchiveRestoreResult, BackupInfo, LibraryShow } from '../../src/shared/commands/archive'
import { bestOf } from './frames'
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
import { focusedUrl } from './nav-support'
import { overlayOf, pressInTab, viewInfo } from './peek-helpers'
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
  ready: boolean
  open: boolean
  visible: boolean
  bounds?: { x: number; y: number; width: number; height: number }
  aboveTabs: boolean
  focused: boolean
}
const info = (o: Orbit) => run(o.app, 'library.testInfo') as Promise<LibraryInfo>
const status = (o: Orbit) => run(o.app, 'library.status') as Promise<LibraryShow & { open: boolean }>
/** Seeded entries are pages of the fixture server, so restoring one never reaches the network. */
const seed = (
  o: Orbit,
  args: { count: number; days?: number; spaceId?: string; profileId?: string; prefix?: string },
) => run(o.app, 'archive.testSeed', { base: fx.url(''), ...args }) as Promise<number>

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

/** The search timings a test installs in the Library's page (AR-04). */
type Search = { shown: number[]; painted: number[]; reset: () => void }

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
  // Where the keys are, as main sees it (the page's own document.hasFocus() stays true while
  // another view of the window has them).
  const under = fx.url('/page/Under')
  await expect.poll(() => focusedUrl(app)).toBe(under)
  // Esc closes it too, from the Archive and from History, and the page has the keys again (keys
  // review F11)…
  await openLibrary(orbit)
  expect(await focusedUrl(app)).toContain('view=library')
  await lib.keyboard.press('Escape')
  await expect.poll(async () => (await info(orbit)).open).toBe(false)
  await expect.poll(() => focusedUrl(app)).toBe(under)
  await run(app, 'library.open', { section: 'history' })
  await expect(lib.getByTestId('library')).toHaveAttribute('data-open', 'true')
  await expect(lib.getByTestId('library-section')).toHaveAttribute('data-section-id', 'history')
  await expect.poll(() => focusedUrl(app)).toContain('view=library')
  await lib.keyboard.press('Escape')
  await expect.poll(async () => (await info(orbit)).open).toBe(false)
  await expect.poll(() => focusedUrl(app)).toBe(under)
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

test('[DL-09][FL-24] once Orbit is idle after launch the Library view is made off-screen, so even the first open is quick at 10,000 entries', async () => {
  // Up to three launches (D46), each waiting a few seconds for the view made ahead.
  test.setTimeout(120_000)
  await seed(orbit, { count: 10_000, days: 60 })
  const marks = async () =>
    (await orbit.app.evaluate(() =>
      (globalThis as unknown as { __orbit: { marks: () => { name: string; t: number }[] } }).__orbit.marks(),
    )) as { name: string; t: number }[]
  /** The first open after a launch, from its shortcut's action (no pointer over the Library button to warm it up). */
  const firstOpen = async () => {
    const { app } = orbit
    // Nothing loading and nothing over the window: the view is made a few seconds after launch, hidden,
    // with the section it opens to built.
    await expect.poll(async () => (await info(orbit)).ready, { timeout: 20_000 }).toBe(true)
    const lib = await libraryPage(app)
    await expect(lib.getByTestId('library')).toHaveAttribute('data-open', 'false')
    await expect.poll(() => countOf(lib)).toBe(10_000)
    expect(await info(orbit)).toMatchObject({ open: false, visible: false })
    await action(app, 'app.library')
    await expect.poll(async () => (await status(orbit)).open).toBe(true)
    const start = (await marks()).filter((x) => x.name === 'library:open:start').at(-1)?.t ?? 0
    await expect
      .poll(async () => (await marks()).filter((x) => x.name === 'library:shown' && x.t >= start).length)
      .toBe(1)
    const shown = (await marks()).filter((x) => x.name === 'library:shown').at(-1)?.t ?? 0
    return shown - start
  }
  // A round that misses is measured again in a fresh launch of the same profile, so every round is
  // the first open after a launch, as a user meets it (D46).
  const { best, all } = await bestOf(
    async (round) => {
      if (round > 1) {
        await orbit.app.close()
        orbit = await launchOrbit({ userData: orbit.userData })
      }
      return firstOpen()
    },
    (ms) => ms <= 250 * FRAME_SLACK,
  )
  console.info(`[archive e2e perf] first Library open→shown, by round: ${all.map((ms) => ms.toFixed(1)).join(', ')} ms`)
  // 66–77 ms in the builder's runs, 81 ms at load 10, and 127–165 ms at load 30–44 (re-review R2).
  // Without the view made ahead the first open takes about 490 ms, so this still fails without it.
  // The idle wait itself is tested in archive-library-idle.test.ts.
  expect(best).toBeLessThanOrEqual(250 * FRAME_SLACK)
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
    let pending: { t0: number; value: string | null } | null = null
    const reset = () => {
      shown.length = 0
      painted.length = 0
      pending = null
    }
    ;(window as unknown as { __search: Search }).__search = { shown, painted, reset }
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
  const field = lib.getByTestId('archive-search')
  const search = () =>
    lib.evaluate(() => {
      const { shown, painted } = (window as unknown as { __search: Search }).__search
      return { shown, painted }
    })
  const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] ?? Number.POSITIVE_INFINITY
  // A round that misses is typed again, from an empty field (D46).
  const { best: searched } = await bestOf(
    async (round) => {
      if (round > 1) {
        await field.fill('')
        await expect.poll(() => countOf(lib)).toBe(10_000)
      }
      await lib.evaluate(() => (window as unknown as { __search: Search }).__search.reset())
      await field.pressSequentially(typed, { delay: 60 })
      await expect.poll(async () => (await search()).shown.length).toBe(typed.length)
      const { shown, painted } = await search()
      console.info(
        `[archive e2e perf] round ${round}: search keystroke→list median ${median(shown).toFixed(1)} ms (worst ${Math.max(...shown).toFixed(1)}), →painted median ${median(painted).toFixed(1)} ms`,
      )
      return median(shown)
    },
    (ms) => ms <= 50 * FRAME_SLACK,
  )
  expect(searched).toBeLessThanOrEqual(50 * FRAME_SLACK)
  await expect.poll(() => countOf(lib)).toBe(1)
  await expect(lib.getByTestId('archive-row-title').first()).toHaveText('Seeded harbor 1045')
  // Enter puts the top match back and shows it; the Library makes way.
  await lib.getByTestId('archive-search').press('Enter')
  await expect.poll(async () => (await info(orbit)).open).toBe(false)
  const id = await activeId(app)
  expect((await state(app)).tabs[id ?? '']?.url).toBe(fx.url('/page/harbor75-1045'))
  // The page loads from the fixture server: no name lookup, no network.
  await waitTab(app, id ?? '', '/page/harbor75-1045')
  expect((await state(app)).tabs[id ?? '']?.title).toBe('harbor75-1045')
  expect((await query(orbit, { text: 'harbor 1045' })).total).toBe(0)
  // A second open is quick even with thousands of entries (DL-09).
  const marks = async () =>
    (await app.evaluate(() =>
      (globalThis as unknown as { __orbit: { marks: () => { name: string; t: number }[] } }).__orbit.marks(),
    )) as { name: string; t: number }[]
  // A round that misses is measured again after closing it (D46).
  const { best: open, all: opens } = await bestOf(
    async (round) => {
      if (round > 1) {
        await lib.keyboard.press('Escape')
        await expect.poll(async () => (await info(orbit)).open).toBe(false)
      }
      await openLibrary(orbit)
      const start = (await marks()).filter((x) => x.name === 'library:open:start').at(-1)?.t ?? 0
      await expect
        .poll(async () => (await marks()).filter((x) => x.name === 'library:shown' && x.t >= start).length)
        .toBe(1)
      const opened = (await marks()).filter((x) => x.name === 'library:shown').at(-1)?.t ?? 0
      return opened - start
    },
    (ms) => ms <= 100 * FRAME_SLACK,
  )
  console.info(`[archive e2e perf] Library open→shown, by round: ${opens.map((ms) => ms.toFixed(1)).join(', ')} ms`)
  expect(open).toBeLessThanOrEqual(100 * FRAME_SLACK)
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
  // Two selected (⌘-click; a plain click previews, AR-06): one menu for both.
  await rows.nth(0).click({ modifiers: [MOD === 'Meta' ? 'Meta' : 'Control'] })
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
  // A shorter time deletes the older entries, so the Library asks first, saying how many (F5).
  const keep = lib.getByTestId('archive-keep')
  const choose = async (label: string) => {
    await archiveEntry(lib).click({ button: 'right' })
    await run(orbit.app, 'archive.testMenu', { click: `Keep Archived Tabs For > ${label}` })
  }
  await choose('90 Days')
  await expect(keep).toContainText('Keep archived tabs for 90 days?')
  await expect(keep).toContainText('3 archived tabs are older than that and will be deleted now. This can’t be undone.')
  await expect(lib.getByTestId('archive-keep-ok')).toHaveText('Delete 3 Tabs')
  // Cancel keeps them all, and the time.
  await lib.getByTestId('archive-keep-cancel').click()
  await expect(keep).toHaveCount(0)
  expect((await state(orbit.app)).settings.archiveKeepDays).toBe(0)
  expect((await query(orbit)).total).toBe(15)
  // Asked again and confirmed, they go.
  await choose('90 Days')
  await lib.getByTestId('archive-keep-ok').click()
  await expect.poll(() => countOf(lib)).toBe(12)
  await expect(lib.getByTestId('library-toast').filter({ hasText: 'Deleted 3 archived tabs' })).toBeVisible()
  expect((await state(orbit.app)).settings.archiveKeepDays).toBe(90)
  await choose('30 Days')
  await expect(keep).toContainText('6 archived tabs are older than that')
  await lib.getByTestId('archive-keep-ok').click()
  await expect.poll(() => countOf(lib)).toBe(6)
  expect((await state(orbit.app)).settings.archiveKeepDays).toBe(30)
  // A longer time deletes nothing: set at once, without a question.
  await choose('1 Year')
  await expect.poll(async () => (await state(orbit.app)).settings.archiveKeepDays).toBe(365)
  await expect(keep).toHaveCount(0)
  expect((await query(orbit)).total).toBe(6)
})

test('[AR-07] Delete, from a row’s menu or for a selection, offers Undo in a toast, which puts the entries back with their history', async () => {
  const { app } = orbit
  const t = await newTab(app, fx.url('/page/Undone'))
  await waitTab(app, t, '/page/Undone')
  await (await tabPage(app, '/page/Undone')).click('#next')
  await waitTab(app, t, '/page/Undone-next')
  await run(app, 'tabs.close', { tabId: t })
  await expect.poll(async () => (await query(orbit)).rows[0]?.hasHistory).toBe(true)
  await seed(orbit, { count: 2, days: 1, prefix: 'Pair' })
  const lib = await openLibrary(orbit)
  await expect.poll(() => countOf(lib)).toBe(3)
  // The row menu's Delete: the toast (held under the pointer) offers Undo.
  await lib.getByTestId('archive-row').filter({ hasText: 'Undone-next' }).click({ button: 'right' })
  await run(app, 'archive.testMenu', { click: 'Delete from Archive' })
  const one = lib.getByTestId('library-toast').filter({ hasText: 'Deleted from the Archive' })
  await one.hover()
  await expect.poll(() => countOf(lib)).toBe(2)
  await one.getByTestId('library-toast-action').click()
  await expect.poll(() => countOf(lib)).toBe(3)
  expect((await query(orbit)).rows.find((r) => r.url === fx.url('/page/Undone-next'))).toMatchObject({
    hasHistory: true,
  })
  // Two selected, deleted with the selection's Delete: Undo brings both back.
  const pair = lib.getByTestId('archive-row').filter({ hasText: 'Pair' })
  await pair.nth(0).click({ modifiers: [MOD === 'Meta' ? 'Meta' : 'Control'] })
  await pair.nth(1).click({ modifiers: [MOD === 'Meta' ? 'Meta' : 'Control'] })
  await lib.getByTestId('archive-delete-selected').click()
  const two = lib.getByTestId('library-toast').filter({ hasText: 'Deleted 2 archived tabs' })
  await two.hover()
  await expect.poll(() => countOf(lib)).toBe(1)
  await two.getByTestId('library-toast-action').click()
  await expect.poll(() => countOf(lib)).toBe(3)
})

/** The Library's History section (AR-10). ⌘Y / Ctrl+H shows History as a page in a tab (pages-history.spec.ts). */
const openHistory = () => run(orbit.app, 'library.open', { section: 'history' })

test('[AR-10] the Library’s History section lists the profile’s visits newest first, with search; a row opens its page, its menu or × removes it', async () => {
  const { app } = orbit
  const t = await newTab(app, fx.url('/page/HistOne'))
  await waitTab(app, t, '/page/HistOne')
  await (await tabPage(app, '/page/HistOne')).click('#next')
  await waitTab(app, t, '/page/HistOne-next')
  const u = await newTab(app, fx.url('/page/HistTwo'))
  await waitTab(app, u, '/page/HistTwo')
  const visited = async () =>
    ((await run(app, 'history.visits', { limit: 50 })) as { title: string }[])
      .map((v) => v.title)
      .filter((title) => title.startsWith('Hist'))
  await expect.poll(visited).toEqual(['HistTwo', 'HistOne-next', 'HistOne'])
  await openHistory()
  const lib = await libraryPage(app)
  await expect(lib.getByTestId('library-section')).toHaveAttribute('data-section-id', 'history')
  await expect.poll(async () => (await info(orbit)).focused).toBe(true)
  await expect(lib.getByTestId('history-search')).toBeFocused()
  const titles = async () =>
    (await lib.getByTestId('history-row-title').allTextContents()).filter((title) => title.startsWith('Hist'))
  await expect.poll(titles).toEqual(['HistTwo', 'HistOne-next', 'HistOne'])
  await expect(lib.getByTestId('history-day').first()).toHaveText('Today')
  // Search: every word, in the title or the address.
  await lib.getByTestId('history-search').fill('histone')
  await expect.poll(titles).toEqual(['HistOne-next', 'HistOne'])
  await lib.getByTestId('history-search').fill('histone next')
  await expect.poll(titles).toEqual(['HistOne-next'])
  // Enter opens the top match in a new tab, and the Library makes way for it.
  const before = Object.keys((await state(app)).tabs)
  await lib.keyboard.press('Enter')
  await expect.poll(async () => (await info(orbit)).open).toBe(false)
  const opened = Object.keys((await state(app)).tabs).find((id) => !before.includes(id))
  expect(opened).toBeDefined()
  await expect.poll(() => activeId(app)).toBe(opened)
  await waitTab(app, opened as string, '/page/HistOne-next')
  // Opened again, with the search cleared. The row menu removes a page from history.
  await openHistory()
  await expect(lib.getByTestId('history-search')).toHaveValue('')
  const row = (title: string) => lib.getByTestId('history-row').filter({ hasText: title })
  await row('HistTwo').click({ button: 'right' })
  await expect
    .poll(() => run(app, 'archive.testMenu', {}))
    .toEqual(['Open in New Tab', 'Open in Background', 'Copy Link', 'Remove from History'])
  await run(app, 'archive.testMenu', { click: 'Remove from History' })
  await expect(row('HistTwo')).toHaveCount(0)
  await expect.poll(visited).not.toContain('HistTwo')
  // × on the row removes every visit to that page.
  await row('HistOne-next').first().hover()
  await row('HistOne-next').first().getByTestId('history-remove').click()
  await expect(row('HistOne-next')).toHaveCount(0)
  await expect.poll(visited).toEqual(['HistOne'])
  // Another profile's Space shows that profile's history: none yet.
  const work = (await run(app, 'profiles.create', { name: 'Work' })) as string
  const w = (await run(app, 'spaces.create', { name: 'Workspace', profileId: work, activate: false })) as string
  await run(app, 'spaces.switch', { spaceId: w })
  await expect.poll(async () => (await info(orbit)).open).toBe(false)
  await openHistory()
  await expect(lib.getByTestId('history-empty')).toContainText('No history yet')
  await expect(lib.getByTestId('history-row')).toHaveCount(0)
})

/** Closes a tab so it becomes the newest Archive entry, and returns that entry's id. */
async function archived(o: Orbit, path: string): Promise<string> {
  const t = await newTab(o.app, fx.url(path))
  await waitTab(o.app, t, path)
  await run(o.app, 'tabs.close', { tabId: t })
  await expect.poll(async () => (await query(o)).rows[0]?.url).toBe(fx.url(path))
  return (await query(o)).rows[0]?.id as string
}

/** The window's open Peek (its tab), once one is up. */
async function peekTab(app: ElectronApplication, except: string[] = []): Promise<string> {
  let tabId = ''
  await expect
    .poll(async () => {
      const overlay = await overlayOf(app)
      tabId = overlay.kind === 'peek' && !overlay.phase && !except.includes(overlay.tabId) ? overlay.tabId : ''
      return tabId
    })
    .not.toBe('')
  return tabId
}

test('[AR-06] a row click previews the page in a Peek over the Library; ⌘W and Esc close only the preview, which adds no second entry', async () => {
  const { app } = orbit
  const keep = await newTab(app, fx.url('/page/Underneath'))
  await waitTab(app, keep, '/page/Underneath')
  const id = await archived(orbit, '/page/Previewed')
  const entries = async () => (await query(orbit, { text: 'previewed' })).rows.map((r) => r.id)
  const lib = await openLibrary(orbit)
  const row = lib.getByTestId('archive-row').filter({ hasText: 'Previewed' })
  await row.click()
  // The page shows in a Peek card over the Library, which stays open under it; nothing is restored.
  const first = await peekTab(app)
  expect(await overlayOf(app)).toMatchObject({ archiveEntry: id })
  await expect.poll(async () => (await state(app)).tabs[first]?.url).toBe(fx.url('/page/Previewed'))
  await expect.poll(async () => (await viewInfo(app, first)).aboveOverlay).toBe(true)
  expect((await info(orbit)).open).toBe(true)
  expect(await activeId(app)).toBe(keep)
  expect(await entries()).toEqual([id])
  // ⌘W closes the preview only: the Library is still open and has the keys.
  await pressInTab(app, first, 'Mod+W')
  await expect.poll(async () => (await overlayOf(app)).kind).toBe('none')
  await expect.poll(async () => (await info(orbit)).focused).toBe(true)
  expect((await info(orbit)).open).toBe(true)
  await expect.poll(async () => (await state(app)).tabs[first]).toBeUndefined()
  expect(await entries()).toEqual([id])
  // Esc closes it too.
  await row.click()
  const second = await peekTab(app, [first])
  await pressInTab(app, second, 'Escape')
  await expect.poll(async () => (await overlayOf(app)).kind).toBe('none')
  expect((await info(orbit)).open).toBe(true)
  await expect.poll(async () => (await state(app)).tabs[second]).toBeUndefined()
  // ⌘⇧T reopens the closed preview over the Library, still a preview: closing it adds nothing either.
  await action(app, 'tab.reopenClosed')
  const reopened = await peekTab(app, [first, second])
  await expect.poll(() => overlayOf(app)).toMatchObject({ kind: 'peek', tabId: reopened, archiveEntry: id })
  await pressInTab(app, reopened, 'Escape')
  await expect.poll(async () => (await state(app)).tabs[reopened]).toBeUndefined()
  expect(await entries()).toEqual([id])
  // The search field kept the keys: Enter restores the row previewed and shows it.
  await expect.poll(async () => (await info(orbit)).focused).toBe(true)
  await expect(lib.getByTestId('archive-search')).toBeFocused()
  await lib.keyboard.press('Enter')
  await expect.poll(async () => (await info(orbit)).open).toBe(false)
  await expect.poll(entries).toEqual([])
  const shown = await activeId(app)
  expect((await state(app)).tabs[shown ?? '']?.url).toBe(fx.url('/page/Previewed'))
})

test('[AR-06] from a preview, Open as Tab opens the page and keeps the entry; Restore puts it back; with no tab under it, a click opens a tab', async () => {
  const { app } = orbit
  const sp = await space(app)
  const keep = await newTab(app, fx.url('/page/Base'))
  await waitTab(app, keep, '/page/Base')
  const expanded = await archived(orbit, '/page/Expanded')
  const restored = await archived(orbit, '/page/Restored')
  const ids = async (text: string) => (await query(orbit, { text })).rows.map((r) => r.id)
  const lib = await openLibrary(orbit)
  const row = (title: string) => lib.getByTestId('archive-row').filter({ hasText: title })
  // Open as Tab (⌘O): the page becomes the selected Today tab, the Library makes way, the entry stays.
  await row('Expanded').click()
  const card = await peekTab(app)
  await expect.poll(async () => (await state(app)).tabs[card]?.url).toBe(fx.url('/page/Expanded'))
  await pressInTab(app, card, 'Mod+O')
  await expect
    .poll(async () => (await state(app)).tabs[(await activeId(app)) ?? '']?.url)
    .toBe(fx.url('/page/Expanded'))
  await expect.poll(async () => (await info(orbit)).open).toBe(false)
  await expect.poll(async () => (await overlayOf(app)).kind).toBe('none')
  expect(await ids('expanded')).toEqual([expanded])
  // Restore from the preview: the Peek goes, the tab is back at the top of its Space's Today, the
  // entry leaves the Archive and the Library stays.
  await openLibrary(orbit)
  await row('Restored').click()
  const preview = await peekTab(app, [card])
  const result = (await run(app, 'archive.restorePreview')) as ArchiveRestoreResult
  expect(result.ids).toEqual([restored])
  await expect.poll(async () => (await overlayOf(app)).kind).toBe('none')
  await expect.poll(async () => (await state(app)).tabs[preview]).toBeUndefined()
  await expect.poll(() => ids('restored')).toEqual([])
  const s = await state(app)
  expect(s.spaces[sp.id]?.today[0]).toBe(result.tabIds[0])
  expect(s.tabs[result.tabIds[0] ?? '']?.url).toBe(fx.url('/page/Restored'))
  expect((await info(orbit)).open).toBe(true)
  await expect(row('Restored')).toHaveCount(0)
  // An empty Space has no tab to preview over: the click opens the page in a new tab there.
  const empty = (await run(app, 'spaces.create', { name: 'Empty' })) as string
  await expect.poll(async () => Object.values((await state(app)).windows)[0]?.spaceId).toBe(empty)
  expect(await activeId(app)).toBeNull()
  await openLibrary(orbit)
  await row('Expanded').click()
  await expect.poll(async () => (await state(app)).spaces[empty]?.today.length).toBe(1)
  const opened = (await state(app)).spaces[empty]?.today[0] as string
  await waitTab(app, opened, '/page/Expanded')
  await expect.poll(() => activeId(app)).toBe(opened)
  await expect.poll(async () => (await info(orbit)).open).toBe(false)
  expect(await ids('expanded')).toEqual([expanded])
})

test('[SV-19][SV-24] a Today split closed as one unit restores from the Archive as one unit: Restore on either pane brings the split back, same pages and sizes', async () => {
  const { app } = orbit
  const sp = await space(app)
  const left = await newTab(app, fx.url('/page/Left'))
  await waitTab(app, left, '/page/Left')
  const right = await newTab(app, fx.url('/page/Right'))
  await waitTab(app, right, '/page/Right')
  const splitId = (await run(app, 'split.create', { tabIds: [left, right] })) as string
  await run(app, 'split.resize', { splitId, path: [], sizes: [0.4, 0.6] })
  await expect.poll(async () => (await state(app)).splits[splitId]?.layout).toMatchObject({ sizes: [0.4, 0.6] })
  const layout = (await state(app)).splits[splitId]?.layout
  // × on the split row (Close Split): it goes to the Archive as one unit, one row per pane.
  await run(app, 'split.close', { splitId })
  await expect.poll(async () => (await state(app)).splits[splitId]).toBeUndefined()
  const lib = await openLibrary(orbit)
  const rows = lib.getByTestId('archive-row')
  await expect(rows).toHaveCount(2)
  await expect(lib.getByTestId('archive-row-split')).toHaveCount(2)
  const rightRow = rows.filter({ hasText: 'Right' })
  await rightRow.hover()
  await rightRow.getByTestId('archive-restore').click()
  // Back at the top of Today as the same split, both pages in it; both rows left the Archive.
  await expect.poll(async () => (await state(app)).spaces[sp.id]?.today[0]).toBe(splitId)
  const s = await state(app)
  expect(s.splits[splitId]?.layout).toEqual(layout)
  expect(s.tabs[left]?.url).toBe(fx.url('/page/Left'))
  expect(s.tabs[right]?.url).toBe(fx.url('/page/Right'))
  await expect(rows).toHaveCount(0)
})

test('[AR-11] Restore Data lists sidebar backups; the one from before a folder was deleted brings the folder back; Undo, ⌘Z and ⌘⇧Z in the Library take it back and redo it', async () => {
  const { app } = orbit
  const sp = await space(app)
  const stay = await newTab(app, fx.url('/page/Stay'))
  await waitTab(app, stay, '/page/Stay')
  const one = await newTab(app, fx.url('/page/One'))
  await waitTab(app, one, '/page/One')
  const two = await newTab(app, fx.url('/page/Two'))
  await waitTab(app, two, '/page/Two')
  const folderId = (await run(app, 'folders.create', { name: 'Reading', items: [one, two] })) as string
  await expect.poll(async () => (await state(app)).folders[folderId]?.children.length).toBe(2)
  const backup = (await run(app, 'backups.take')) as BackupInfo
  expect(backup.tabs).toBeGreaterThanOrEqual(2)
  // Since then: the folder deleted (its tabs go to the Archive) and a tab opened.
  await run(app, 'folders.delete', { folderId })
  await expect.poll(async () => (await state(app)).folders[folderId]).toBeUndefined()
  const urls = async () => (await query(orbit)).rows.map((r) => r.url)
  await expect.poll(urls).toEqual(expect.arrayContaining([fx.url('/page/One'), fx.url('/page/Two')]))
  const late = await newTab(app, fx.url('/page/Late'))
  await waitTab(app, late, '/page/Late')
  await run(app, 'tabs.activate', { tabId: stay })
  await expect.poll(() => activeId(app)).toBe(stay)

  // Help → Restore Data… on macOS; the command bar everywhere.
  if (process.platform === 'darwin') {
    const help = await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()
        ?.items.find((i) => i.role === 'help')
        ?.submenu?.items.map((i) => i.label),
    )
    expect(help).toContain('Restore Data…')
  }
  await openViaCommandBar(orbit, 'Restore Data')
  const lib = await libraryPage(app)
  await expect(lib.getByTestId('library')).toHaveAttribute('data-open', 'true')
  await expect(lib.getByTestId('library-section')).toHaveAttribute('data-section-id', 'backups')
  const row = lib.locator(`[data-testid="backup-row"][data-id="${backup.id}"]`)
  await expect(row.getByTestId('backup-row-counts')).toHaveText(
    `${backup.spaces} ${backup.spaces === 1 ? 'Space' : 'Spaces'} · ${backup.tabs} tabs`,
  )
  await expect(lib.getByTestId('backups-day').first()).toHaveText('Today')
  // Restore… asks first; Cancel has the keys.
  await row.click()
  await row.getByTestId('backup-restore').click()
  const dialog = lib.getByTestId('backup-confirm')
  await expect(dialog).toContainText('Restore the sidebar from today at')
  await expect(dialog).toContainText('Tabs opened since go to the Archive.')
  await expect(lib.getByTestId('backup-confirm-cancel')).toBeFocused()
  await lib.getByTestId('backup-confirm-ok').click()
  const toast = lib.getByTestId('library-toast').filter({ hasText: 'Sidebar restored from today at' })
  await expect(toast).toBeVisible()
  // Under the pointer the toast stays while the checks below run.
  await toast.hover()

  // The folder is back in the pinned section with its tabs, which left the Archive; the tab
  // opened since went there.
  await expect
    .poll(async () => (await state(app)).folders[folderId]?.children.toSorted())
    .toEqual([one, two].toSorted())
  const s = await state(app)
  expect(s.spaces[sp.id]?.pinned).toContain(folderId)
  expect(s.tabs[one]).toMatchObject({ url: fx.url('/page/One'), asleep: true })
  expect(s.tabs[late]).toBeUndefined()
  // The window still shows the tab it showed.
  expect(await activeId(app)).toBe(stay)
  await expect.poll(urls).toContain(fx.url('/page/Late'))
  expect(await urls()).not.toContain(fx.url('/page/One'))
  // The sidebar as it was just before is a backup of its own, listed above.
  await expect.poll(async () => ((await run(app, 'backups.list')) as BackupInfo[]).length).toBeGreaterThanOrEqual(2)
  await expect(lib.getByTestId('backup-row').first()).not.toHaveAttribute('data-id', backup.id)

  // Undo takes the restore back: the folder goes again and the late tab comes back, same tab.
  await toast.getByTestId('library-toast-action').click()
  await expect(lib.getByTestId('library-toast').filter({ hasText: 'Restore undone' })).toBeVisible()
  await expect.poll(async () => (await state(app)).folders[folderId]).toBeUndefined()
  await expect.poll(async () => (await state(app)).tabs[late]?.url).toBe(fx.url('/page/Late'))
  await expect.poll(urls).toEqual(expect.arrayContaining([fx.url('/page/One'), fx.url('/page/Two')]))
  expect(await urls()).not.toContain(fx.url('/page/Late'))

  // With the keys still in the Library, ⌘⇧Z restores again and ⌘Z takes it back (TB-18).
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await lib.keyboard.press(`${mod}+Shift+Z`)
  await expect.poll(async () => (await state(app)).folders[folderId]?.children.length).toBe(2)
  await expect.poll(async () => (await state(app)).tabs[late]).toBeUndefined()
  await lib.keyboard.press(`${mod}+Z`)
  await expect.poll(async () => (await state(app)).folders[folderId]).toBeUndefined()
  await expect.poll(async () => (await state(app)).tabs[late]?.url).toBe(fx.url('/page/Late'))
})

test('[AR-11] a backup whose file can’t be read is listed as unreadable, without Restore…', async () => {
  const { app, userData } = orbit
  const t = await newTab(app, fx.url('/page/Backed'))
  await waitTab(app, t, '/page/Backed')
  const good = (await run(app, 'backups.take')) as BackupInfo
  // A backup from an hour before, cut short.
  const cut = `${good.at - 3_600_000}-1-1-0badf00d`
  writeFileSync(join(userData, 'backups', `${cut}.json`), '{"v":1,"at":')
  await openViaCommandBar(orbit, 'Restore Data')
  const lib = await libraryPage(app)
  await expect(lib.getByTestId('library-section')).toHaveAttribute('data-section-id', 'backups')
  const bad = lib.locator(`[data-testid="backup-row"][data-id="${cut}"]`)
  await expect(bad).toHaveAttribute('data-unreadable', 'true')
  await expect(bad.getByTestId('backup-row-counts')).toHaveText('Can’t be read')
  await expect(bad.getByTestId('backup-restore')).toBeDisabled()
  // Enter on it asks nothing; the good one still restores.
  await bad.click()
  await lib.keyboard.press('Enter')
  await expect(lib.getByTestId('backup-confirm')).toHaveCount(0)
  const row = lib.locator(`[data-testid="backup-row"][data-id="${good.id}"]`)
  await expect(row).not.toHaveAttribute('data-unreadable')
  await expect(row.getByTestId('backup-restore')).toBeEnabled()
})
