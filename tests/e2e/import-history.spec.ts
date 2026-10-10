import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { manyPages, sampleHistory, writeChromium } from '../../scripts/import-fixtures'
import type { HistoryEntry, HistoryVisit } from '../../src/shared/commands/history'
import type { ImportJob } from '../../src/shared/commands/import'
import { MOD, type Orbit, run, state, viewPage } from './helpers'
import {
  clickDone,
  fixturePath,
  launchImport,
  mainLagMs,
  openImport,
  pagesLoaded,
  startMainLag,
} from './import-support'

/** History from another browser (IM-07, IM-15): into the profile's History and the command bar, never tabs. */

let orbit: Orbit | undefined
const scratch: string[] = []

test.afterEach(async () => {
  await orbit?.app.close().catch(() => {})
  orbit = undefined
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const DAY = 86_400_000
const HISTORY_KEY = process.platform === 'darwin' ? 'Meta+Y' : 'Control+H'

/** Chooses a one-profile browser, keeps only History, and imports it into `profileId` (default: the current Space's). */
async function importHistory(app: ElectronApplication, sourceId: string, profileId?: string): Promise<Page> {
  const page = await openImport(app)
  await page.getByTestId(`import-source-${sourceId}`).click()
  await page.getByTestId('import-next').click()
  await expect(page.getByTestId('import-profiles').or(page.getByTestId('import-step-types'))).toBeVisible()
  if (await page.getByTestId('import-profiles').isVisible()) {
    // Several profiles: the first one only.
    const boxes = await page.getByTestId('import-profiles').getByRole('checkbox').all()
    for (const [i, box] of boxes.entries()) await box.setChecked(i === 0)
    await page.getByTestId('import-next').click()
  }
  await expect(page.getByTestId('import-type-history').getByRole('checkbox')).toBeChecked()
  const bookmarks = page.getByTestId('import-type-bookmarks').getByRole('checkbox')
  if (await bookmarks.count()) await bookmarks.uncheck()
  await page.getByTestId('import-next').click()
  await expect(page.getByTestId('import-target')).toBeVisible()
  if (profileId) await page.getByTestId('import-target-profile').selectOption(profileId)
  return page
}

const visits = async (app: ElectronApplication, profileId?: string) =>
  ((await run(app, 'history.visits', { limit: 100, ...(profileId ? { profileId } : {}) })) as HistoryVisit[]).map(
    (v) => ({ title: v.title, at: v.at }),
  )

test('[IM-07][IM-03][IM-15] Chrome’s history goes into History and the command bar at once, opens no tab, and comes over once', async () => {
  orbit = await launchImport({ places: [{ browser: 'chrome', dir: fixturePath('chrome') }] })
  const { app, shell } = orbit
  const page = await importHistory(app, 'chrome')
  await expect(page.getByTestId('import-target')).toContainText('History goes to its profile.')
  const tabsBefore = Object.keys((await state(app)).tabs)
  await page.getByTestId('import-next').click()
  await expect(page.getByTestId('import-progress')).toHaveAttribute('data-phase', 'done')
  await expect(page.getByTestId('import-item-history')).toHaveAttribute('data-done', '6')
  await expect(page.getByTestId('import-item-history')).toContainText('6 pages')
  await expect(page.getByTestId('import-progress')).toContainText('Done. The pages are in History')

  // Every visit, with its title and time; the browser's own pages and hidden ones left out.
  const expected = sampleHistory()
    .filter((p) => !p.hidden && p.url.startsWith('http'))
    .flatMap((p) => Array.from({ length: Math.min(p.visits, 3) }, (_, i) => ({ title: p.title, at: p.last - i * DAY })))
    .sort((a, b) => b.at - a.at)
  expect(await visits(app)).toEqual(expected)
  // Not one tab, not one page loaded.
  expect(Object.keys((await state(app)).tabs)).toEqual(tabsBefore)
  expect(await pagesLoaded(app)).toEqual([])
  await clickDone(page)

  // History (⌘Y, Ctrl+H) lists them, newest first.
  await shell.keyboard.press(HISTORY_KEY)
  const library = await libraryPage(app)
  await expect
    .poll(async () => (await library.getByTestId('history-row-title').allTextContents()).slice(0, 4))
    .toEqual(['Inbox', 'Example News', 'Team calendar', 'Inbox'])
  await library.keyboard.press('Escape')
  await expect(library.getByTestId('library')).toHaveAttribute('data-open', 'false')

  // The command bar knows them at once: a familiar site completes as it did in the other browser.
  await shell.keyboard.press(`${MOD}+T`)
  const overlay = await viewPage(app, 'overlay')
  const input = overlay.getByTestId('command-bar').getByTestId('command-input')
  await expect(input).toBeFocused()
  await overlay.keyboard.type('news')
  await expect
    .poll(() => input.evaluate((el: HTMLInputElement) => [el.value, el.selectionStart, el.selectionEnd]))
    .toEqual(['news.example.org', 4, 16])
  await input.fill('sourdough')
  await expect(overlay.getByTestId('command-result').filter({ hasText: 'sourdough - Search' }).first()).toHaveAttribute(
    'data-kind',
    'history',
  )
  await overlay.keyboard.press('Escape')

  // IM-15: the same history again adds nothing twice.
  const counts = async () =>
    ((await run(app, 'history.search', { text: 'example', limit: 50 })) as HistoryEntry[])
      .map((e) => `${e.url} ${e.visitCount}/${e.typedCount}`)
      .sort()
  const once = await counts()
  expect(once).toContain('https://news.example.org/ 120/80')
  const again = await importHistory(app, 'chrome')
  await again.getByTestId('import-next').click()
  await expect(again.getByTestId('import-progress')).toHaveAttribute('data-phase', 'done')
  expect(await counts()).toEqual(once)
  expect(await visits(app)).toEqual(expected)
})

test('[IM-06][IM-07] Firefox’s history goes to the profile chosen, not the current one', async () => {
  orbit = await launchImport({ places: [{ browser: 'firefox', dir: fixturePath('firefox') }] })
  const { app } = orbit
  const work = (await run(app, 'profiles.create', { name: 'Work' })) as string
  const page = await importHistory(app, 'firefox', work)
  await expect(page.getByTestId('import-target-space')).toHaveValue('new')
  await page.getByTestId('import-next').click()
  await expect(page.getByTestId('import-progress')).toHaveAttribute('data-phase', 'done')
  expect((await visits(app, work)).slice(0, 3).map((v) => v.title)).toEqual(['Inbox', 'Example News', 'Team calendar'])
  expect(await visits(app)).toEqual([])
})

/** The Library's own view (`?view=library`), once it has been created. */
async function libraryPage(app: ElectronApplication): Promise<Page> {
  await expect.poll(() => app.windows().some((p) => p.url().includes('view=library'))).toBe(true)
  return app.windows().find((p) => p.url().includes('view=library')) as Page
}

test('[IM-07][IM-14] 100,000 pages of history import in the background: the windows keep answering', async () => {
  test.setTimeout(300_000)
  const dir = mkdtempSync(join(tmpdir(), 'orbit-import-e2e-'))
  scratch.push(dir)
  writeChromium(join(dir, 'chrome'), [{ folder: 'Default', name: 'Big', history: manyPages(100_000) }])
  orbit = await launchImport({ places: [{ browser: 'chrome', dir: join(dir, 'chrome') }] })
  const { app, shell } = orbit
  const tabsBefore = Object.keys((await state(app)).tabs)
  // Best of three rounds, each into a profile of its own and against the whole budget (D46). Main's
  // longest stall is measured from the click on Import until the history file is written; the
  // shell's over the same stretch. Measured: about 2 s, main's longest stall 50–110 ms, the shell's none.
  type Round = { ms: number; mainLongestMs: number; shellLongestMs: number }
  const rounds: Round[] = []
  const meets = (r: Round) => r.ms < 10_000 && r.mainLongestMs < 150 && r.shellLongestMs < 150
  let profileId = ''
  for (let round = 0; round < 3; round++) {
    profileId = (await run(app, 'profiles.create', { name: `Round ${round + 1}` })) as string
    const page = await importHistory(app, 'chrome', profileId)
    await shell.evaluate(() => {
      const w = window as unknown as { __longest: number }
      w.__longest = 0
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__longest = Math.max(w.__longest, e.duration)
      }).observe({ type: 'longtask' })
    })
    await startMainLag(app)
    await page.getByTestId('import-next').click()
    await expect(page.getByTestId('import-progress')).toHaveAttribute('data-phase', 'done', { timeout: 120_000 })
    const job = (await run(app, 'import.status', {})) as ImportJob
    const mainLongestMs = await mainLagMs(app)
    const shellLongestMs = await shell.evaluate(() => (window as unknown as { __longest: number }).__longest)
    rounds.push({ ms: job.stats?.ms ?? Number.POSITIVE_INFINITY, mainLongestMs, shellLongestMs })
    // History keeps the 50,000 most recent pages: the rest are left out, and the summary says so.
    expect(job.items.find((i) => i.type === 'history')?.done).toBe(50_000)
    await expect(page.getByTestId('import-skipped')).toContainText(
      '50,000 older pages: History keeps the 50,000 most recent pages',
    )
    await clickDone(page)
    if (meets(rounds.at(-1) as Round)) break
  }
  console.log(`[IM-07] 100,000 pages: ${JSON.stringify(rounds)}`)
  expect(rounds.some(meets), JSON.stringify(rounds)).toBe(true)

  // Written once, as one line per page, when the import says it's done.
  const file = join(orbit.userData, 'history', `${profileId.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`)
  expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(50_000)
  const search = async (text: string) =>
    ((await run(app, 'history.search', { profileId, text, limit: 5 })) as HistoryEntry[]).map((e) => e.url)
  expect(await search('History page 50000')).toEqual(['https://example.com/h/50000'])
  expect(await search('History page 50001')).toEqual([])
  expect((await visits(app, profileId))[0]?.title).toBe('History page 1')
  // No tab was made, and the browser window answers at once.
  expect(Object.keys((await state(app)).tabs)).toEqual(tabsBefore)
  await shell.keyboard.press(`${MOD}+T`)
  await expect
    .poll(async () => (await state(app)).windows[Object.keys((await state(app)).windows)[0] as string]?.overlay.kind)
    .toBe('commandbar')
})

/** Copies of another browser's files (`0-History`, `1-places.sqlite-wal`, …) anywhere under these folders. */
function copiesIn(...dirs: string[]): string[] {
  return dirs.flatMap((dir) =>
    (readdirSync(dir, { recursive: true }) as string[]).filter((f) =>
      /^\d+-(History|places\.sqlite|History\.db|Preferences|Secure Preferences)/.test(basename(f)),
    ),
  )
}

test('[IM-07][IM-14] a quit while history is read leaves no copy of it: not in the temp folder, not in user data (D58)', async () => {
  test.setTimeout(120_000)
  const dir = mkdtempSync(join(tmpdir(), 'orbit-import-e2e-'))
  scratch.push(dir)
  writeChromium(join(dir, 'chrome'), [{ folder: 'Default', name: 'Big', history: manyPages(100_000) }])
  // Orbit's temp folder is one of the test's own, so whatever it leaves there can be seen.
  const temp = join(dir, 'temp')
  mkdirSync(temp)
  orbit = await launchImport({ places: [{ browser: 'chrome', dir: join(dir, 'chrome') }], env: { TMPDIR: temp } })
  const { app, userData } = orbit
  const page = await importHistory(app, 'chrome')
  await page.getByTestId('import-next').click()
  // Quit while the pages are being read: the copy of History is there.
  let read = 0
  await expect
    .poll(
      async () => {
        const job = (await run(app, 'import.status', {})) as ImportJob
        read = job.items[0]?.done ?? 0
        return job.phase === 'reading' && read > 0 && copiesIn(temp, userData).length > 0
      },
      { intervals: [10], timeout: 60_000 },
    )
    .toBe(true)
  await app.close()
  orbit = undefined
  console.log(`[D58] quit with ${read.toLocaleString('en-US')} of 100,000 pages read`)
  expect(read).toBeLessThan(100_000)
  expect(copiesIn(temp, userData)).toEqual([])
  expect(readdirSync(temp).filter((f) => f.startsWith('orbit-import-'))).toEqual([])
})

test('[IM-14] copies a crash left in user data are removed when Orbit starts (D58)', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'orbit-e2e-'))
  scratch.push(userData)
  const left = join(userData, 'import-scratch', 'read-left')
  mkdirSync(left, { recursive: true })
  writeFileSync(join(left, '0-History'), 'a copy of another browser’s history')
  orbit = await launchImport({ userData })
  await expect.poll(() => existsSync(left)).toBe(false)
  expect(copiesIn(userData)).toEqual([])
})
