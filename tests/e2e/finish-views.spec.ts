import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { paneOrder } from '../../src/shared/split'
import {
  activeTabId,
  type Fixtures,
  FRAME_SLACK,
  launchOrbit,
  MOD,
  type Orbit,
  run,
  startFixtures,
  state,
  viewPage,
} from './helpers'
import { blockNetwork, clickInTab, findPage, overlayOf, startSites } from './peek-helpers'

/** Views lane follow-ups: the command bar, split view, Peek, Mini Windows and media. */

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

/** Opens a fixture page titled `name` in a new tab and waits until it has its title and favicon. */
async function newTab(name: string): Promise<string> {
  const id = (await run(orbit.app, 'tabs.create', { url: fx.url(`/page/${encodeURIComponent(name)}`) })) as string
  await expect.poll(async () => (await state(orbit.app)).tabs[id]?.title).toBe(name)
  await expect.poll(async () => !!(await state(orbit.app)).tabs[id]?.favicon).toBe(true)
  return id
}

async function openBar(): Promise<Page> {
  await orbit.shell.keyboard.press(`${MOD}+T`)
  const overlay = await viewPage(orbit.app, 'overlay')
  await expect(input(overlay)).toBeFocused()
  return overlay
}

/** The live bar (a closing one may still be animating out). */
const bar = (overlay: Page) => overlay.getByTestId('command-bar')
const input = (overlay: Page) => bar(overlay).getByTestId('command-input')
const rows = (overlay: Page) => bar(overlay).getByTestId('command-result')
/** The "search the web" row's text: once it shows a query, the rows around it answer that query. */
const searchRow = (overlay: Page) =>
  rows(overlay).and(overlay.locator('[data-kind="search"]')).getByTestId('command-result-title')

/** Popup menus are recorded instead of shown, so a test can read and click them. */
async function recordMenus(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu }) => {
    const g = globalThis as unknown as { __shownMenu?: unknown }
    Menu.prototype.popup = function popup(this: unknown) {
      g.__shownMenu = this
    }
  })
}

/** The last recorded popup menu's item labels. */
function shownMenu(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() =>
    ((globalThis as unknown as { __shownMenu?: Electron.Menu }).__shownMenu?.items ?? []).map((i) => i.label),
  )
}

/** Clicks an item of the last recorded popup menu; false when it is missing or disabled. */
function clickShownMenu(app: ElectronApplication, label: string): Promise<boolean> {
  return app.evaluate((_e, l) => {
    const item = (globalThis as unknown as { __shownMenu?: Electron.Menu }).__shownMenu?.items.find(
      (i) => i.label === l,
    )
    if (!item?.enabled) return false
    item.click()
    return true
  }, label)
}

// ---- Split view in the command bar and the sidebar (SV-21) ----

test('[SV-21][CB-06] the command bar lists an open split once, with both favicons, and Enter shows it', async () => {
  const { app, shell } = orbit
  const a = await newTab('Alpha Mail')
  const b = await newTab('Bravo Docs')
  const splitId = (await run(app, 'split.create', { tabIds: [a, b] })) as string
  expect(splitId).toBeTruthy()
  // The panes' titles in the order the sidebar's split row shows them.
  const titles = shell.locator(`[data-testid="split-row"][data-split-id="${splitId}"] .split-segment__title`)
  await expect(titles).toHaveCount(2)
  const paneTitles = (await titles.allTextContents()).join(' | ')
  expect(paneTitles.split(' | ').sort()).toEqual(['Alpha Mail', 'Bravo Docs'])
  const current = await newTab('Charlie')
  await expect.poll(() => activeTabId(app)).toBe(current)
  // Their pages are in history, where the bar could find them on their own too.
  await expect
    .poll(async () => ((await run(app, 'history.search', { text: 'page' })) as unknown[]).length)
    .toBeGreaterThanOrEqual(3)

  // Both panes match "page" (in their URLs): one row for the split, none for either pane or page.
  const overlay = await openBar()
  await input(overlay).fill('page')
  await expect(searchRow(overlay)).toHaveText('page')
  const split = rows(overlay).and(overlay.locator(`[data-id="split:${splitId}"]`))
  await expect(split).toHaveCount(1)
  await expect(split).toHaveAttribute('data-kind', 'tab')
  await expect(split.getByTestId('command-result-title')).toHaveText(paneTitles)
  await expect(split.locator('.cmdbar__label')).toHaveText('Split')
  await expect(split.getByTestId('split-favicons').locator('img.favicon')).toHaveCount(2)
  await expect(overlay.locator(`[data-id="tab:${a}"], [data-id="tab:${b}"]`)).toHaveCount(0)
  await expect(rows(overlay).and(overlay.locator('[data-kind="history"]'))).toHaveCount(0)

  // Enter on it shows the split, with the pane that matched focused.
  await input(overlay).fill('bravo')
  await expect(searchRow(overlay)).toHaveText('bravo')
  await expect(rows(overlay).first()).toHaveAttribute('data-id', `split:${splitId}`)
  await expect(split.locator('.cmdbar__hint')).toHaveText('Switch to split ↩')
  await overlay.keyboard.press('Enter')
  await expect.poll(() => activeTabId(app)).toBe(b)
  await expect(shell.getByTestId('split-pane')).toHaveCount(2)

  // Now on screen, the split and its pages aren't offered, as the current tab isn't.
  const again = await openBar()
  await input(again).fill('alpha')
  await expect(searchRow(again)).toHaveText('alpha')
  await expect(rows(again).and(again.locator(`[data-id="split:${splitId}"]`))).toHaveCount(0)
  await expect(rows(again).filter({ hasText: 'Alpha Mail' })).toHaveCount(0)
})

test("[SV-21][SV-22][SV-23] a split's icon replaces its panes' favicons on its row and Favorites tile, lasts, and can be removed", async () => {
  const { app, shell, userData } = orbit
  const a = await newTab('Alpha')
  const b = await newTab('Bravo')
  const splitId = (await run(app, 'split.create', { tabIds: [a, b] })) as string
  const row = shell.locator(`[data-testid="split-row"][data-split-id="${splitId}"]`)
  await expect(row.getByTestId('split-segment')).toHaveCount(2)
  const paneTitles = (await row.locator('.split-segment__title').allTextContents()).join(' | ')

  // Right-click → Change Icon… → pick one: it stands in for the favicons; the titles stay.
  await recordMenus(app)
  await row.click({ button: 'right' })
  await expect.poll(() => shownMenu(app)).toContain('Change Icon…')
  expect(await clickShownMenu(app, 'Change Icon…')).toBe(true)
  const picker = shell.getByTestId('icon-picker')
  await expect(picker).toBeVisible()
  await picker.getByTestId('icon-choice').first().click()
  await expect(picker).toHaveCount(0)
  await expect(row.getByTestId('split-icon')).toHaveText('⭐')
  await expect(row.getByTestId('split-segment')).toHaveCount(0)
  await expect(row.locator('.split-row__name')).toHaveText(paneTitles)
  expect((await state(app)).splits[splitId]?.icon).toBe('⭐')

  // As a Favorite, its tile shows the icon too (SV-23), and still does after a relaunch.
  const s = await state(app)
  const profileId = s.spaces[s.tabs[a]?.spaceId as string]?.profileId as string
  expect(await run(app, 'tabs.move', { id: splitId, to: { kind: 'favorites', profileId }, index: 0 })).toBe(true)
  const tile = (o: Orbit) => o.shell.locator(`[data-testid="favorite-tile"][data-split-id="${splitId}"]`)
  await expect(tile(orbit).getByTestId('split-icon')).toHaveText('⭐')
  await app.close()
  orbit = await launchOrbit({ userData })
  await expect(tile(orbit).getByTestId('split-icon')).toHaveText('⭐')

  // Remove icon: the panes' favicons come back.
  await recordMenus(orbit.app)
  await tile(orbit).click({ button: 'right' })
  await expect.poll(() => shownMenu(orbit.app)).toContain('Change Icon…')
  expect(await clickShownMenu(orbit.app, 'Change Icon…')).toBe(true)
  await orbit.shell.getByTestId('icon-picker').getByRole('button', { name: 'Remove icon' }).click()
  await expect(tile(orbit).getByTestId('split-icon')).toHaveCount(0)
  await expect(tile(orbit).locator('.favicon')).toHaveCount(2)
  await expect.poll(async () => (await state(orbit.app)).splits[splitId]?.icon).toBeUndefined()
})

test('[SV-22][TD-05] a split row in Today offers Archive Tabs Below: the items under it go, the split stays', async () => {
  const { app, shell } = orbit
  const below = await newTab('Below')
  const a = await newTab('Alpha')
  const b = await newTab('Bravo')
  const splitId = (await run(app, 'split.create', { tabIds: [a, b] })) as string
  const above = await newTab('Above')
  // Today lists the newest first: Above, the split, Below.
  const spaceId = (await state(app)).tabs[a]?.spaceId as string
  await expect.poll(async () => (await state(app)).spaces[spaceId]?.today).toEqual([above, splitId, below])

  await recordMenus(app)
  const row = shell.locator(`[data-testid="split-row"][data-split-id="${splitId}"]`)
  await row.click({ button: 'right' })
  await expect.poll(() => shownMenu(app)).toContain('Archive Tabs Below')
  expect(await clickShownMenu(app, 'Archive Tabs Below')).toBe(true)
  await expect.poll(async () => (await state(app)).spaces[spaceId]?.today).toEqual([above, splitId])
  const s = await state(app)
  expect(s.tabs[below]).toBeUndefined()
  expect(s.splits[splitId]).toBeDefined()

  // Now the last item: there's nothing below it, so the item is there but can't be chosen.
  await app.evaluate(() => {
    ;(globalThis as unknown as { __shownMenu?: unknown }).__shownMenu = undefined
  })
  await row.click({ button: 'right' })
  await expect.poll(() => shownMenu(app)).toContain('Archive Tabs Below')
  expect(await clickShownMenu(app, 'Archive Tabs Below')).toBe(false)
})

// ---- Pinned and Favorite splits (SV-23) ----

test('[SV-23][PN-04] a pinned split resets as one: every pane goes back to its own pinned page, from its menu or a double-click on its Favorite tile', async () => {
  const { app, shell } = orbit
  const a = await newTab('Alpha')
  const b = await newTab('Bravo')
  const splitId = (await run(app, 'split.create', { tabIds: [a, b] })) as string
  const before = await state(app)
  const home = [before.tabs[a]?.url, before.tabs[b]?.url]
  const spaceId = before.tabs[a]?.spaceId as string
  expect(await run(app, 'split.move', { splitId, to: { kind: 'pinned', spaceId } })).toBe(true)
  const urls = async () => {
    const t = (await state(app)).tabs
    return [t[a]?.url, t[b]?.url]
  }
  await expect
    .poll(async () => {
      const t = (await state(app)).tabs
      return [t[a]?.pinnedUrl, t[b]?.pinnedUrl]
    })
    .toEqual(home)
  // Both panes wander off to other pages.
  const wander = async () => {
    await run(app, 'tabs.navigate', { tabId: a, url: fx.url('/page/Elsewhere%20A') })
    await run(app, 'tabs.navigate', { tabId: b, url: fx.url('/page/Elsewhere%20B') })
    await expect
      .poll(async () => {
        const t = (await state(app)).tabs
        return [t[a]?.title, t[b]?.title]
      })
      .toEqual(['Elsewhere A', 'Elsewhere B'])
  }
  await wander()

  // The split's menu brings both back (once the row has left Today for the pinned section).
  await recordMenus(app)
  const row = shell.locator(`[data-testid="split-row"][data-split-id="${splitId}"]`)
  await expect(row).toHaveCount(1)
  await row.click({ button: 'right' })
  await expect.poll(() => shownMenu(app)).toContain('Reset to Pinned URLs')
  expect(await clickShownMenu(app, 'Reset to Pinned URLs')).toBe(true)
  await expect.poll(urls).toEqual(home)
  // At home there's nothing to reset: the item is there but can't be chosen.
  await app.evaluate(() => {
    ;(globalThis as unknown as { __shownMenu?: unknown }).__shownMenu = undefined
  })
  await row.click({ button: 'right' })
  await expect.poll(() => shownMenu(app)).toContain('Reset to Pinned URLs')
  expect(await clickShownMenu(app, 'Reset to Pinned URLs')).toBe(false)

  // As a Favorite, its tile shows that its panes wandered off, and a double-click brings both back.
  const profileId = before.spaces[spaceId]?.profileId as string
  expect(await run(app, 'split.move', { splitId, to: { kind: 'favorites', profileId } })).toBe(true)
  const tile = shell.locator(`[data-testid="favorite-tile"][data-split-id="${splitId}"]`)
  await expect(tile).toBeVisible()
  await expect(tile.getByTestId('favorite-away')).toHaveCount(0)
  await wander()
  await expect(tile.getByTestId('favorite-away')).toHaveCount(1)
  await tile.dblclick()
  await expect.poll(urls).toEqual(home)
  await expect(tile.getByTestId('favorite-away')).toHaveCount(0)
})

test('[SV-23][PK-02] a link to another site in either pane of a Favorite split opens a Peek from that pane; the split keeps its focus across Spaces', async () => {
  const { app, shell } = orbit
  const sites = await startSites()
  try {
    await blockNetwork(app)
    const s = await state(app)
    const win = Object.values(s.windows).find((w) => w.kind === 'main')
    const profileId = s.spaces[win?.spaceId as string]?.profileId as string
    const favorites = { kind: 'favorites', profileId }
    const left = (await run(app, 'tabs.create', { url: sites.url('/site/Left'), container: favorites })) as string
    const right = (await run(app, 'tabs.create', {
      url: sites.url('/site/Right'),
      container: favorites,
      activate: false,
    })) as string
    expect(await run(app, 'split.addTab', { tabId: right, target: left, side: 'right', focus: false })).toBeTruthy()
    await expect(shell.getByTestId('split-pane')).toHaveCount(2)
    await expect.poll(() => activeTabId(app)).toBe(left)

    // A click on the other pane's link: that pane takes the focus and the Peek opens from it.
    const page = await findPage(app, '/site/Right')
    const link = await page.locator('#other').boundingBox()
    if (!link) throw new Error('no link')
    await clickInTab(app, right, { x: link.x + link.width / 2, y: link.y + link.height / 2 })
    await expect.poll(async () => (await overlayOf(app)).kind).toBe('peek')
    const overlay = await overlayOf(app)
    expect(overlay.kind === 'peek' ? overlay.sourceTabId : undefined).toBe(right)
    const peekTab = overlay.kind === 'peek' ? overlay.tabId : ''
    await expect.poll(async () => (await state(app)).tabs[peekTab]?.url).toBe(sites.other('/site/Other'))
    const after = (await state(app)).tabs
    expect(after[right]?.url).toBe(sites.url('/site/Right'))
    expect(after[left]?.url).toBe(sites.url('/site/Left'))
    await run(app, 'peek.close', {})
    await expect.poll(async () => (await overlayOf(app)).kind).toBe('none')
    await expect.poll(() => activeTabId(app)).toBe(right)

    // Another Space and back: the split comes back with the same pane focused.
    const other = (await run(app, 'spaces.create', { name: 'Elsewhere' })) as string
    await expect.poll(async () => (await state(app)).windows[win?.id as string]?.spaceId).toBe(other)
    await run(app, 'spaces.switch', { spaceId: win?.spaceId })
    await expect.poll(async () => (await state(app)).windows[win?.id as string]?.spaceId).toBe(win?.spaceId)
    await expect.poll(() => activeTabId(app)).toBe(right)
    await expect(shell.getByTestId('split-pane')).toHaveCount(2)
  } finally {
    await sites.close()
  }
})

// ---- The action catalogue (CB-13) ----

/** Opens the bar, types `text` and returns the top row once it is the action `title`. */
async function actionRow(text: string, title: string): Promise<{ overlay: Page; top: ReturnType<Page['locator']> }> {
  const overlay = await openBar()
  await input(overlay).fill(text)
  const top = rows(overlay).first()
  await expect(top).toHaveAttribute('data-kind', 'action')
  await expect(top.getByTestId('command-result-title')).toHaveText(title)
  return { overlay, top }
}

test('[CB-13][TD-05][KS-18] Archive Tabs Below from the command bar archives the Today tabs under the current one; its key shows in its row', async () => {
  const { app } = orbit
  const a = await newTab('Oldest')
  const b = await newTab('Middle')
  const c = await newTab('Newest')
  // Today lists the newest first: Newest, Middle, Oldest. From Middle, only Oldest is below.
  await run(app, 'tabs.activate', { tabId: b })
  await expect.poll(() => activeTabId(app)).toBe(b)
  expect(await run(app, 'keys.bind', { actionId: 'tab.archiveBelow', accel: 'F7' })).toEqual({ ok: true })

  const { overlay, top } = await actionRow('archive tabs below', 'Archive Tabs Below')
  await expect(top.getByTestId('command-shortcut')).toHaveText('F7')
  await overlay.keyboard.press('Enter')
  await expect.poll(async () => (await state(app)).tabs[a]).toBeUndefined()
  const tabs = (await state(app)).tabs
  expect(tabs[b]).toBeDefined()
  expect(tabs[c]).toBeDefined()
  expect(await activeTabId(app)).toBe(b)
})

test('[CB-13][SV-19][SV-17] Close Split from the command bar closes the whole split; Close Split Pane only the focused pane', async () => {
  const { app } = orbit
  const a = await newTab('Left')
  const b = await newTab('Right')
  const c = await newTab('Third')
  const first = (await run(app, 'split.create', { tabIds: [a, b, c], focus: c })) as string
  expect(first).toBeTruthy()
  await expect.poll(() => activeTabId(app)).toBe(c)

  // Close Split Pane: the focused pane goes, the split stays with the other two.
  const pane = await actionRow('close split pane', 'Close Split Pane')
  await pane.overlay.keyboard.press('Enter')
  await expect.poll(async () => (await state(app)).tabs[c]).toBeUndefined()
  expect((await state(app)).splits[first]).toBeDefined()

  // Close Split: the whole split, as its row's × closes it.
  const whole = await actionRow('close split', 'Close Split')
  await whole.overlay.keyboard.press('Enter')
  await expect.poll(async () => Object.keys((await state(app)).splits)).toEqual([])
  const tabs = (await state(app)).tabs
  expect(tabs[a]).toBeUndefined()
  expect(tabs[b]).toBeUndefined()
})

// ---- Split view: a pane that grows in (SV-26) ----

/** What the in-page sampler records about a pane growing in (as split.spec's SV-26 test). */
type Growth = { insertedAt: number; ticks: number; samples: { t: number; w: number }[]; done: boolean }

/** Starts sampling the card width of `tabId`'s pane every frame, timed from when it enters the page. */
async function sampleGrowth(shell: Page, tabId: string): Promise<void> {
  await shell.evaluate((id) => {
    const probe: Growth = { insertedAt: 0, ticks: 0, samples: [], done: false }
    ;(window as unknown as { __growth: Growth }).__growth = probe
    const started = performance.now()
    const card = () => document.querySelector<HTMLElement>(`[data-testid="split-pane"][data-tab-id="${id}"]`)
    const seen = new MutationObserver(() => {
      if (!card()) return
      probe.insertedAt = performance.now()
      seen.disconnect()
    })
    seen.observe(document.body, { subtree: true, childList: true })
    const tick = () => {
      probe.ticks++
      const now = performance.now()
      const el = card()
      if (el && probe.insertedAt) probe.samples.push({ t: now - probe.insertedAt, w: el.getBoundingClientRect().width })
      if (probe.insertedAt ? now - probe.insertedAt > 900 : now - started > 8000) probe.done = true
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, tabId)
}

async function growth(shell: Page): Promise<Growth> {
  const probe = () => shell.evaluate(() => (window as unknown as { __growth: Growth }).__growth)
  await expect.poll(async () => (await probe()).done).toBe(true)
  const result = await probe()
  expect(result.insertedAt, `the new pane never appeared (${result.ticks} frames)`).toBeGreaterThan(0)
  return result
}

/** Waits until the split's pane cards stop moving. */
async function settledPanes(shell: Page, count: number): Promise<void> {
  const widths = () =>
    shell.evaluate(async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      return [...document.querySelectorAll('[data-testid="split-pane"]')].map((el) =>
        Math.round(el.getBoundingClientRect().width),
      )
    })
  await expect
    .poll(async () => {
      const a = await widths()
      const b = await widths()
      return a.length === count && a.join() === b.join()
    })
    .toBe(true)
}

test('[SV-26] a pane added while its neighbour still grows back from a close grows in too (PR #19 review F10)', async () => {
  const { app, shell } = orbit
  // As in split.spec's SV-26 test, the shape is checked on frames that came in time; a starved
  // renderer gets up to three rounds (D46).
  const rounds: string[] = []
  for (let round = 1; round <= 3; round++) {
    const ids = [await newTab(`Left${round}`), await newTab(`Middle${round}`), await newTab(`Right${round}`)]
    const splitId = (await run(app, 'split.create', { tabIds: ids })) as string
    const layout = (await state(app)).splits[splitId]?.layout
    if (!layout) throw new Error('no split')
    const [, middle, right] = paneOrder(layout)
    await settledPanes(shell, 3)
    const added = (await run(app, 'tabs.create', { url: fx.url(`/page/Added${round}`), activate: false })) as string
    await sampleGrowth(shell, added)
    // The right pane closes and a new one takes its place beside the middle one in the same moment:
    // the closing pane still covers that place, and the middle one hasn't grown into it yet.
    await app.evaluate(
      async (_e, [closing, adding, target]) => {
        const h = (
          globalThis as unknown as {
            __orbit: { run: (n: string, a: unknown, w?: string) => unknown; windowIds: () => string[] }
          }
        ).__orbit
        const w = h.windowIds()[0]
        await Promise.all([
          h.run('split.closePane', { tabId: closing }, w),
          h.run('split.addTab', { tabId: adding, target, side: 'right' }, w),
        ])
      },
      [right, added, middle] as const,
    )
    const { samples } = await growth(shell)
    const final = samples[samples.length - 1]?.w ?? 0
    expect(final).toBeGreaterThan(100)
    const early = samples.filter((s) => s.t <= 100)
    if (FRAME_SLACK === 1 && early.length === 0) {
      rounds.push(`round ${round}: no frame by 100 ms`)
      await run(app, 'split.close', { splitId })
      continue
    }
    // It starts as a sliver and grows over several frames, instead of appearing at full size.
    if (FRAME_SLACK === 1) expect(early[0]?.w).toBeLessThan(final * 0.8)
    expect(samples.filter((s) => s.w > 1 && s.w < final - 1).length).toBeGreaterThan(0)
    return
  }
  throw new Error(`frames never came in time to show the grow-in (${rounds.join('; ')})`)
})
