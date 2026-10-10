import { readFileSync } from 'node:fs'
import { expect, type Page, test } from '@playwright/test'
import { PASTE_DEFAULT_NAME } from '../../src/renderer/src/import/copy'
import type { ImportJob } from '../../src/shared/commands/import'
import { MOD, type Orbit, run, state } from './helpers'
import {
  clickDone,
  closeImport,
  dropFile,
  dropMadeFile,
  fixturePath,
  guardMemory,
  importPage,
  importWindowPid,
  launchImport,
  loggedServer,
  mainLagMs,
  memoryMb,
  openImport,
  startMainLag,
  tabsUnder,
} from './import-support'
import { pageOfView } from './settings-support'

/** A list of links, pasted or from a .txt file (IM-12, IM-13): one pinned folder of pinned tabs. */

let orbit: Orbit | undefined
let server: Awaited<ReturnType<typeof loggedServer>> | undefined

test.afterEach(async () => {
  await orbit?.app.close().catch(() => {})
  await server?.close()
  orbit = undefined
  server = undefined
})

/** Next on the links step, Import on the target step, then waits for the summary. */
async function importLinks(page: Page): Promise<ImportJob> {
  await page.getByTestId('import-next').click()
  await expect(page.getByTestId('import-target')).toBeVisible()
  await page.getByTestId('import-next').click()
  await expect(page.getByTestId('import-progress')).toHaveAttribute('data-phase', 'done', { timeout: 30_000 })
  return (await page.evaluate(() =>
    (window as unknown as { orbit: { invoke: (n: string, a: unknown) => Promise<unknown> } }).orbit.invoke(
      'import.status',
      {},
    ),
  )) as ImportJob
}

/** The folder's tabs as "title <pinned URL>", in order. */
async function folderTabs(orbit: Orbit, folderId: string): Promise<string[]> {
  return tabsUnder(await state(orbit.app), folderId).map((t) => `${t.pinnedTitle ?? t.title} <${t.pinnedUrl}>`)
}

/** Puts text on the system clipboard (main process), as copying in another app would. */
async function copyText(orbit: Orbit, text: string): Promise<void> {
  await orbit.app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text)
}

/** Presses ⌘V (Ctrl+V) in the sidebar; resolves whether Orbit took the paste. */
async function pasteInSidebar(shell: Page): Promise<boolean> {
  const taken = shell.evaluate(
    () =>
      new Promise<boolean>((resolve) =>
        document.addEventListener('paste', (e) => resolve(e.defaultPrevented), { once: true }),
      ),
  )
  await shell.getByTestId('sidebar-scroll').evaluate((el) => (el as HTMLElement).focus())
  await shell.keyboard.press(`${MOD}+V`)
  return taken
}

test('[IM-12] Paste a list of links: one pinned folder named by the user, a pinned tab per link in order, nothing loaded', async () => {
  server = await loggedServer()
  const base = server.url('')
  // A link without a title is named after its address's host, as a new tab is before it loads.
  const host = new URL(base).host
  orbit = await launchImport()
  const { app } = orbit
  const page = await openImport(app)
  // The help for people moving from another browser explains the routes, in words only.
  await page.getByTestId('import-moving-help').locator('summary').click()
  await expect(page.getByTestId('import-moving-help').locator('li')).toHaveCount(5)

  await page.getByTestId('import-paste').click()
  await expect(page.getByTestId('import-step-links')).toBeVisible()
  await expect(page.getByTestId('import-folder-name')).toHaveValue(PASTE_DEFAULT_NAME)
  await expect(page.getByTestId('import-links-count')).toHaveText('No links yet')
  await expect(page.getByTestId('import-next')).toBeDisabled()
  await page
    .getByTestId('import-links-text')
    .fill(
      [
        `${base}/page/One`,
        `Two — ${base}/page/Two`,
        'a line that is not a link',
        `Three – ${base}/page/Three`,
        `${base}/page/Four`,
        `Five | ${base}/page/Five`,
      ].join('\n'),
    )
  await expect(page.getByTestId('import-links-count')).toHaveText('5 links')
  // An empty name can't be used; the user's own name can.
  await page.getByTestId('import-folder-name').fill(' ')
  await expect(page.getByTestId('import-next')).toBeDisabled()
  await page.getByTestId('import-folder-name').fill('From my old browser')
  const job = await importLinks(page)

  await expect(page.getByTestId('import-item-links')).toHaveAttribute('data-done', '5')
  await expect(page.getByTestId('import-skipped')).toContainText('1 line: Not a link')
  const s = await state(app)
  const folderId = job.folders[0]?.folderId as string
  expect(s.folders[folderId]?.name).toBe('From my old browser')
  expect(s.spaces[job.folders[0]?.spaceId as string]?.pinned.at(-1)).toBe(folderId)
  expect(await folderTabs(orbit, folderId)).toEqual([
    `${host} <${base}/page/One>`,
    `Two <${base}/page/Two>`,
    `Three <${base}/page/Three>`,
    `${host} <${base}/page/Four>`,
    `Five <${base}/page/Five>`,
  ])
  expect(tabsUnder(s, folderId).every((t) => t.asleep && !t.favicon)).toBe(true)
  await clickDone(page)
  expect(server.requests).toEqual([])
})

test('[IM-12] ⌘V on the sidebar with links on the clipboard offers the same import; one link is left alone', async () => {
  orbit = await launchImport()
  const { app, shell } = orbit
  // One link: not a list, so the paste does nothing here.
  await copyText(orbit, 'https://example.com/page/Alone')
  expect(await pasteInSidebar(shell)).toBe(false)
  // A list copied from another browser: the import window opens at the list, ready to import.
  const text = 'https://example.com/page/One\nTwo — https://example.com/page/Two\nhttps://example.com/page/Three'
  await copyText(orbit, text)
  expect(await pasteInSidebar(shell)).toBe(true)
  const page = await importPage(app)
  await expect(page.getByTestId('import-step-links')).toBeVisible()
  await expect(page.getByTestId('import-links-text')).toHaveValue(text)
  await expect(page.getByTestId('import-links-count')).toHaveText('3 links')
  const job = await importLinks(page)
  const folderId = job.folders[0]?.folderId as string
  expect((await state(app)).folders[folderId]?.name).toBe(PASTE_DEFAULT_NAME)
  expect(await folderTabs(orbit, folderId)).toEqual([
    'example.com <https://example.com/page/One>',
    'Two <https://example.com/page/Two>',
    'example.com <https://example.com/page/Three>',
  ])
  // Pasting the same list again makes a second folder, " (2)" (IM-15).
  await clickDone(page)
  expect(await pasteInSidebar(shell)).toBe(true)
  const again = await importLinks(await importPage(app))
  expect((await state(app)).folders[again.folders[0]?.folderId as string]?.name).toBe(`${PASTE_DEFAULT_NAME} (2)`)
})

test('[IM-13][IM-12] a .txt list of links dropped on the import window imports the same way', async () => {
  orbit = await launchImport()
  const { app } = orbit
  const page = await openImport(app)
  await dropFile(page, '[data-testid="import-flow"]', {
    name: 'links.txt',
    text: readFileSync(fixturePath('files', 'links.txt'), 'utf8'),
    type: 'text/plain',
  })
  await expect(page.getByTestId('import-step-links')).toBeVisible()
  await expect(page.getByTestId('import-links-count')).toHaveText('5 links')
  await page.getByTestId('import-folder-name').fill('Reading list')
  // Enter in the name goes on; Escape comes back with the list and name kept (IM-01).
  await page.getByTestId('import-folder-name').press('Enter')
  await expect(page.getByTestId('import-target')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('import-step-links')).toBeVisible()
  await expect(page.getByTestId('import-folder-name')).toHaveValue('Reading list')
  const job = await importLinks(page)
  expect(job.source).toBe('links.txt')
  expect(await folderTabs(orbit, job.folders[0]?.folderId as string)).toEqual([
    'example.com <https://example.com/page/One>',
    'Two <https://example.com/page/Two>',
    'example.org <https://example.org/three>',
    'Four <https://example.com/page/Four>',
    'Five <https://example.com/page/Five>',
  ])
  expect(await run(app, 'import.status', {})).toMatchObject({ phase: 'done', source: 'links.txt' })
})

test('[IM-12] a list too long to edit, pasted in the import window, shows its count and first lines and is imported whole (D62 (5))', async () => {
  test.setTimeout(120_000)
  orbit = await launchImport()
  const { app } = orbit
  const page = await openImport(app)
  await page.getByTestId('import-paste').click()
  // 10,001 lines: one more than the field edits.
  const urls = Array.from({ length: 10_001 }, (_, i) => `https://example.com/page/${i}`)
  await copyText(orbit, urls.join('\n'))
  const paste = async () => {
    await page.getByTestId('import-links-text').focus()
    await page.keyboard.press(`${MOD}+V`)
    await expect(page.getByTestId('import-links-count')).toHaveText('10,001 links')
  }
  await paste()
  // Read-only: the first eight lines, never the field (main holds the list).
  await expect(page.getByTestId('import-links-text')).toHaveCount(0)
  expect(await page.getByTestId('import-links-held').locator('pre').textContent()).toBe(urls.slice(0, 8).join('\n'))
  // Clear brings back the empty field; the list pasted again is held again.
  await page.getByTestId('import-links-clear').click()
  await expect(page.getByTestId('import-links-text')).toHaveValue('')
  await expect(page.getByTestId('import-links-count')).toHaveText('No links yet')
  await paste()
  await page.getByTestId('import-folder-name').fill('Long list')
  const job = await importLinks(page)
  expect(job.items[0]?.done).toBe(10_001)
  const folderId = job.folders[0]?.folderId as string
  const tabs = tabsUnder(await state(app), folderId)
  expect([tabs.length, tabs[0]?.pinnedUrl, tabs.at(-1)?.pinnedUrl]).toEqual([10_001, urls[0], urls.at(-1)])
  expect((await state(app)).folders[folderId]?.name).toBe('Long list')
})

/** A list of 16 MB (D62 (5)): two links, then one address per line. */
const LONG_LIST = {
  head: 'https://example.com/first\nSecond - https://example.com/second\n',
  unit: 'https://example.com/page/000000\n',
  bytes: 16 * 1024 * 1024,
}
/** The first lines the import window shows of it. */
const LONG_PREVIEW = [
  'https://example.com/first',
  'Second - https://example.com/second',
  ...Array(6).fill('https://example.com/page/000000'),
].join('\n')
/**
 * The import window's peak memory while it shows a 16 MB list (D62 (5)): its count and first lines, with main holding
 * the list, peaked at 113–176 MB in these tests; with the list in its field, at 2.8–3.2 GB.
 */
const WINDOW_LIMIT_MB = 400
/** Past this the window is stopped, so that a run with the list in the field can't take the machine. */
const WINDOW_GUARD_MB = 3072

interface LongListRound {
  mainLongestMs: number
  windowPeakMb: number
}
const meetsLongList = (r: LongListRound) => r.mainLongestMs < 150 && r.windowPeakMb < WINDOW_LIMIT_MB

/**
 * One round: main's longest stall from the drop or the paste until the import window shows the list and settles, and
 * the window's peak memory. `act` drops or pastes the list, calling `start` just before, and returns the import
 * window and how many links the list holds.
 */
async function longListRound(
  app: Orbit['app'],
  act: (start: () => Promise<void>) => Promise<{ page: Page; links: number }>,
) {
  await closeImport(app)
  const { page, links } = await act(() => startMainLag(app))
  const pid = await importWindowPid(app)
  const stop = guardMemory(pid, WINDOW_GUARD_MB)
  const shown = await expect(page.getByTestId('import-links-count'))
    .toHaveText(`${links.toLocaleString('en-US')} links`, { timeout: 120_000 })
    .then(async () => {
      // The keyboard moves into the step from its title, as a user's would: to the list, or what shows of it. Then
      // the window settles.
      await page.keyboard.press('Tab')
      await page.waitForTimeout(500)
    })
    .then(
      () => undefined,
      (err: unknown) => err,
    )
  const stoppedAt = stop()
  if (stoppedAt) throw new Error(`The import window passed ${WINDOW_GUARD_MB} MB (${stoppedAt} MB) and was stopped`)
  if (shown) throw shown
  const round: LongListRound = { mainLongestMs: await mainLagMs(app), windowPeakMb: memoryMb(pid).peak }
  return { page, round }
}

test('[IM-13][IM-12] a 16 MB list dropped on the import window: main never stalls 150 ms, the window stays small (D62 (5))', async () => {
  test.skip(process.platform !== 'linux', 'the window’s memory is read from /proc')
  test.setTimeout(300_000)
  orbit = await launchImport()
  const { app } = orbit
  // Best of three rounds (D46), each in a new import window.
  const rounds: LongListRound[] = []
  let page: Page | undefined
  for (let round = 0; round < 3; round++) {
    const done = await longListRound(app, async (start) => {
      const opened = await openImport(app)
      const file = { name: 'long.txt', type: 'text/plain', ...LONG_LIST }
      const units = await dropMadeFile(opened, '[data-testid="import-flow"]', file, start)
      return { page: opened, links: units + 2 }
    })
    page = done.page
    rounds.push(done.round)
    if (meetsLongList(done.round)) break
  }
  console.log(`[D62 (5)] a 16 MB list dropped on the import window: ${JSON.stringify(rounds)}`)
  expect(rounds.some(meetsLongList), JSON.stringify(rounds)).toBe(true)
  // Its count and first lines, read-only: the window holds no field with the list in it.
  await expect(page?.getByTestId('import-links-text') as ReturnType<Page['getByTestId']>).toHaveCount(0)
  expect(await page?.getByTestId('import-links-held').locator('pre').textContent()).toBe(LONG_PREVIEW)
})

test('[IM-12] a 16 MB list pasted on the sidebar: main never stalls 150 ms, the window stays small (D62 (5))', async () => {
  test.skip(process.platform !== 'linux', 'the window’s memory is read from /proc')
  test.setTimeout(300_000)
  orbit = await launchImport()
  const { app, shell } = orbit
  const units = Math.ceil(LONG_LIST.bytes / LONG_LIST.unit.length)
  const rounds: LongListRound[] = []
  let page: Page | undefined
  for (let round = 0; round < 3; round++) {
    // Copied in main, as another app would, before the round starts.
    await app.evaluate(({ clipboard }, l) => clipboard.writeText(l.head + l.unit.repeat(l.units)), {
      ...LONG_LIST,
      units,
    })
    const done = await longListRound(app, async (start) => {
      await start()
      expect(await pasteInSidebar(shell)).toBe(true)
      // The window, drawn or not: the round waits for the list, however long that takes.
      return { page: await pageOfView(app, 'import'), links: units + 2 }
    })
    page = done.page
    rounds.push(done.round)
    if (meetsLongList(done.round)) break
  }
  console.log(`[D62 (5)] a 16 MB list pasted on the sidebar: ${JSON.stringify(rounds)}`)
  expect(rounds.some(meetsLongList), JSON.stringify(rounds)).toBe(true)
  await expect(page?.getByTestId('import-links-text') as ReturnType<Page['getByTestId']>).toHaveCount(0)
  expect(await page?.getByTestId('import-links-held').locator('pre').textContent()).toBe(LONG_PREVIEW)
})
