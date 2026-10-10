import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { manyBookmarks, netscapeHtml, sampleTree } from '../../scripts/import-fixtures'
import type { BookmarkNode, ImportJob } from '../../src/shared/commands/import'
import { MOD, type Orbit, run, state } from './helpers'
import {
  clickDone,
  dropFile,
  fixturePath,
  importPage,
  launchImport,
  loggedServer,
  mainLagMs,
  openImport,
  pagesLoaded,
  pickFileNext,
  pinnedShape,
  startMainLag,
  tabsUnder,
} from './import-support'

/** Bookmarks from a file (IM-13, IM-05) and the import window's progress and summary (IM-14). */

let orbit: Orbit | undefined
let server: Awaited<ReturnType<typeof loggedServer>> | undefined

test.afterEach(async () => {
  await orbit?.app.close().catch(() => {})
  await server?.close()
  orbit = undefined
  server = undefined
})

const SAMPLE_FOLDER = (base: string) => ({
  'Imported bookmarks': [
    {
      'Bookmarks bar': [
        {
          Work: [
            `Team calendar <${base}/page/Calendar>`,
            `Design docs <${base}/page/Docs>`,
            `Issue tracker <${base}/page/Issues>`,
          ],
        },
        { News: [`Morning paper <${base}/page/Paper>`, `Tech & Science <weekly> <${base}/page/Weekly>`] },
      ],
    },
    { 'Other bookmarks': [{ Recipes: [{ Bread: [`Sourdough <${base}/page/Sourdough>`] }] }] },
  ],
})

/** Next, Next, Import: the current Space, then waits for the summary. */
async function importToCurrentSpace(page: Page): Promise<ImportJob> {
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

test('[IM-13][IM-05][IM-04][IM-14] a bookmarks file dropped on the import window becomes one pinned folder, and nothing loads', async () => {
  server = await loggedServer()
  const base = server.url('')
  orbit = await launchImport()
  const { app, shell } = orbit
  const before = await state(app)
  const spaceId = before.windows[Object.keys(before.windows)[0] as string]?.spaceId as string
  const page = await openImport(app)
  await expect(page.getByTestId('import-step-source')).toBeVisible()

  await dropFile(page, '[data-testid="import-flow"]', { name: 'bookmarks.html', text: netscapeHtml(sampleTree(base)) })
  // IM-04: the file's tree, all chosen, with a count; what can't be a tab is shown greyed, with why.
  await expect(page.getByTestId('import-step-bookmarks')).toBeVisible()
  await expect(page.getByTestId('import-count')).toHaveText('6 of 6 bookmarks selected')
  await expect(page.getByTestId('import-tree-folder').filter({ hasText: 'Bookmarks bar' })).toBeVisible()
  const skipped = page.getByTestId('import-tree-bookmark').filter({ hasText: 'Bookmarklet' })
  await expect(skipped.locator('input')).toBeDisabled()
  await page.getByTestId('import-select-none').click()
  await expect(page.getByTestId('import-count')).toHaveText('0 of 6 bookmarks selected')
  await expect(page.getByTestId('import-next')).toBeDisabled()
  await page.getByTestId('import-select-all').click()
  await expect(page.getByTestId('import-count')).toHaveText('6 of 6 bookmarks selected')

  // IM-06: the current Space by default.
  await page.getByTestId('import-next').click()
  await expect(page.getByTestId('import-target-space')).toHaveValue(spaceId)
  await page.getByTestId('import-back').click()
  await expect(page.getByTestId('import-step-bookmarks')).toBeVisible()
  const job = await importToCurrentSpace(page)

  // IM-14: counts, and what was left out with the reason.
  await expect(page.getByTestId('import-item-bookmarks')).toHaveAttribute('data-done', '6')
  await expect(page.getByTestId('import-skipped')).toContainText('1 bookmark: Bookmarklet (a script, not a page)')
  await expect(page.getByTestId('import-skipped')).toContainText('1 bookmark: A page only that browser can open')
  expect(job.phase).toBe('done')

  // IM-05: one pinned folder at the end of the Space's pinned section, the file's folders inside it.
  const s = await state(app)
  const pinned = s.spaces[spaceId]?.pinned ?? []
  expect(pinned.slice(0, -1)).toEqual(before.spaces[spaceId]?.pinned)
  const folderId = pinned.at(-1) as string
  expect(job.folders).toEqual([{ folderId, spaceId }])
  expect(pinnedShape(s, [folderId])).toEqual([SAMPLE_FOLDER(base)])
  const tabs = tabsUnder(s, folderId)
  expect(tabs).toHaveLength(6)
  for (const tab of tabs) expect(tab).toMatchObject({ asleep: true, loading: false, lastActiveAt: 0 })
  for (const tab of tabs) expect(tab.favicon).toBeUndefined()
  expect(s.spaces[spaceId]?.today).toEqual(before.spaces[spaceId]?.today)

  // Done shows the folder in the browser window's sidebar.
  await clickDone(page)
  const row = shell.locator(`[data-folder-id="${folderId}"] [data-testid="folder-row"]`).first()
  await expect(row).toBeInViewport()
  await expect(row).toHaveClass(/is-focused/)

  // ⌘Z takes the whole import back; ⌘⇧Z puts it back.
  await run(app, 'tabs.undo')
  await expect.poll(async () => (await state(app)).spaces[spaceId]?.pinned).toEqual(before.spaces[spaceId]?.pinned)
  expect(Object.keys((await state(app)).tabs).filter((id) => tabs.some((t) => t.id === id))).toEqual([])
  await run(app, 'tabs.redo')
  await expect.poll(async () => (await state(app)).spaces[spaceId]?.pinned.at(-1)).toBe(folderId)
  expect(pinnedShape(await state(app), [folderId])).toEqual([SAMPLE_FOLDER(base)])

  // Opening its folders draws the tabs, still without a request or an icon fetched.
  await expect(row).toHaveAttribute('aria-expanded', 'true')
  await shell.getByTestId('folder-row').filter({ hasText: 'Bookmarks bar' }).click()
  await shell.getByTestId('folder-row').filter({ hasText: 'Work' }).click()
  const calendar = shell.getByTestId('tab-row').filter({ hasText: 'Team calendar' })
  await expect(calendar).toBeVisible()
  expect(server.requests).toEqual([])
  // The log does catch a load: the first request is the one opened.
  await calendar.click()
  await expect.poll(() => server?.requests[0]).toBe('/page/Calendar')
})

test('[IM-13] a file without bookmarks says "No bookmarks found in this file" and imports nothing; From a file… reads the same', async () => {
  orbit = await launchImport()
  const { app } = orbit
  const before = await state(app)
  const page = await openImport(app)

  await dropFile(page, '[data-testid="import-flow"]', {
    name: 'page.html',
    text: readFileSync(fixturePath('files', 'malformed.htm'), 'utf8'),
  })
  await expect(page.getByTestId('import-file-error')).toHaveText('page.html: No bookmarks found in this file')
  await expect(page.getByTestId('import-step-source')).toBeVisible()

  // From a file… (the system's picker stands in): the same error, then a real export.
  await pickFileNext(app, fixturePath('files', 'malformed.htm'))
  await page.getByTestId('import-from-file').click()
  await expect(page.getByTestId('import-file-error')).toHaveText('malformed.htm: No bookmarks found in this file')
  await pickFileNext(app, null)
  await page.getByTestId('import-from-file').click()
  await expect(page.getByTestId('import-step-source')).toBeVisible()
  await pickFileNext(app, fixturePath('files', 'bookmarks.htm'))
  await page.getByTestId('import-from-file').click()
  await expect(page.getByTestId('import-count')).toHaveText('6 of 6 bookmarks selected')

  // Cancel imports nothing.
  await page.getByTestId('import-cancel').click()
  await expect.poll(() => page.isClosed()).toBe(true)
  const after = await state(app)
  expect(after.folders).toEqual(before.folders)
  expect(after.tabs).toEqual(before.tabs)
})

test('[IM-13] a bookmarks file dropped on the sidebar opens the import window at its bookmarks', async () => {
  orbit = await launchImport()
  const { app, shell } = orbit
  await dropFile(shell, '[data-testid="sidebar-scroll"]', {
    name: 'bookmarks.html',
    text: readFileSync(fixturePath('files', 'bookmarks.htm'), 'utf8'),
  })
  const page = await importPage(app)
  await expect(page.getByTestId('import-step-bookmarks')).toBeVisible()
  await expect(page.getByTestId('import-count')).toHaveText('6 of 6 bookmarks selected')
  // A second file dropped while it's open starts over with that one.
  await dropFile(shell, '[data-testid="sidebar-scroll"]', {
    name: 'other.html',
    text: netscapeHtml([{ title: 'One', url: 'https://one.example/' }]),
  })
  await expect(page.getByTestId('import-count')).toHaveText('1 of 1 bookmarks selected')
  // A file that holds no bookmarks says so.
  await dropFile(shell, '[data-testid="sidebar-scroll"]', { name: 'empty.html', text: '<!doctype html><p>nothing</p>' })
  await expect(page.getByTestId('import-file-error')).toHaveText('empty.html: No bookmarks found in this file')
  // No tab was opened for any of them.
  expect(Object.values((await state(app)).tabs).filter((t) => !t.pinnedUrl && t.url.startsWith('file:'))).toEqual([])
})

test('[IM-13] a file with no bookmarks dropped with a local address opens no tab: the address is checked as a dropped link is (D49, D58)', async () => {
  orbit = await launchImport()
  const { app, shell } = orbit
  const localTabs = async () => Object.values((await state(app)).tabs).filter((t) => /^file:/i.test(t.url))
  // A page's drag that carries a file of its own and a local address.
  await dropFile(
    shell,
    '[data-testid="sidebar-scroll"]',
    { name: 'notes.txt', text: 'Nothing here is a link.', type: 'text/plain' },
    { 'text/uri-list': `file://${fixturePath('files', 'bookmarks.htm')}` },
  )
  // The drop is handled once a tab opens or the import window says why it can't read the file.
  await expect
    .poll(async () => (await localTabs()).length > 0 || app.windows().some((w) => w.url().includes('view=import')))
    .toBe(true)
  expect(await localTabs()).toEqual([])
  const page = await importPage(app)
  await expect(page.getByTestId('import-file-error')).toHaveText('notes.txt: No bookmarks found in this file')
  expect(await localTabs()).toEqual([])
})

test('[IM-13] hostile files of 1 MB are read off main’s thread: main never stalls 150 ms, and each says what it holds (D58)', async () => {
  test.setTimeout(180_000)
  orbit = await launchImport()
  const { app } = orbit
  const page = await openImport(app)
  // The import review's shapes (M1), each 1 MB. Before D58 the first stalled main for seconds and the others for
  // minutes: each scan searched to the end of the file from every tag, title or "](".
  const MB = 1024 * 1024
  const fill = (unit: string) => unit.repeat(Math.ceil(MB / unit.length))
  const head = (folder: string) =>
    `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<TITLE>Bookmarks</TITLE>\n<DL><p>\n<DT><H3>${folder}</H3>\n<DL><p>\n`
  const link = '<DT><A HREF="https://example.com/page">A page\n'
  const folder = '<DT><H3>A folder\n<DL><p>\n<DT><A HREF="https://example.com/">A page</A>\n</DL><p>\n'
  const count = (unit: string) => Math.ceil(MB / unit.length).toLocaleString('en-US')
  const files: { name: string; text: string; type?: string; holds: string }[] = [
    { name: 'no-close-a.html', text: head('Links') + fill(link), holds: `${count(link)} bookmarks` },
    { name: 'no-close-h3.html', text: head('Folders') + fill(folder), holds: `${count(folder)} bookmarks` },
    { name: 'open-a.html', text: `${head('Open')}<DT>${fill('<a ')}`, holds: 'none' },
    {
      name: 'title.html',
      text: `${head('Title')}<DT><A HREF="https://example.com/">${'<'.repeat(MB)}</A>\n</DL>`,
      holds: '1 bookmarks',
    },
    { name: 'brackets.txt', text: `[${fill('](')}`, type: 'text/plain', holds: 'none' },
  ]
  // Best of three rounds, each against the whole budget (D46). A round ends at the first file that misses it.
  const rounds: Record<string, number>[] = []
  for (let round = 0; round < 3; round++) {
    const stalls: Record<string, number> = {}
    rounds.push(stalls)
    for (const file of files) {
      await startMainLag(app)
      await dropFile(page, '[data-testid="import-flow"]', file)
      if (file.holds === 'none') {
        await expect(page.getByTestId('import-file-error')).toHaveText(
          `${file.name}: No bookmarks found in this file`,
          {
            timeout: 60_000,
          },
        )
      } else {
        const n = file.holds.split(' ')[0]
        await expect(page.getByTestId('import-count')).toHaveText(`${n} of ${n} bookmarks selected`, {
          timeout: 60_000,
        })
      }
      stalls[file.name] = await mainLagMs(app)
      if ((stalls[file.name] as number) >= 150) break
    }
    if (Object.keys(stalls).length === files.length && Object.values(stalls).every((ms) => ms < 150)) break
  }
  console.log(`[IM-13] main's longest stall per 1 MB hostile file, by round: ${JSON.stringify(rounds)}`)
  const best = rounds.at(-1) as Record<string, number>
  expect(Object.keys(best), JSON.stringify(rounds)).toEqual(files.map((f) => f.name))
  expect(Math.max(...Object.values(best)), JSON.stringify(rounds)).toBeLessThan(150)
  // The title of a million "<" is cut to 1,000 characters; a folder holding over 1,000 bookmarks starts closed (F5).
  const title = files[3] as (typeof files)[number]
  await dropFile(page, '[data-testid="import-flow"]', title)
  await expect(page.getByTestId('import-count')).toHaveText('1 of 1 bookmarks selected')
  await expect(page.getByTestId('import-tree-bookmark').locator('.im-tree__title')).toHaveText('<'.repeat(1000))
  await dropFile(page, '[data-testid="import-flow"]', files[0] as (typeof files)[number])
  await expect(page.getByTestId('import-tree-folder').getByRole('button', { name: 'Open Links' })).toBeVisible()
  await expect(page.getByTestId('import-tree-bookmark')).toHaveCount(0)
})

test('[IM-05][IM-14] 2,000 bookmarks: one closed folder, nothing loaded, quick, and the window stays responsive', async () => {
  server = await loggedServer()
  const html = netscapeHtml(manyBookmarks(2000, server.url('')))
  orbit = await launchImport()
  const { app, shell } = orbit
  // Best of three rounds, each against the whole budget (D46). Main's longest stall is measured from
  // the click on Import until the state file holds the folder; the shell's from the drop to Done.
  // Adding the tabs in parts keeps both near 30 ms on a quiet machine (one update of 2,000 took 80–110).
  type Round = { ms: number; mainLongestMs: number; shellLongestMs: number }
  const rounds: Round[] = []
  const meets = (r: Round) => r.ms < 2000 && r.mainLongestMs < 150 && r.shellLongestMs < 150
  for (let round = 0; round < 3; round++) {
    await shell.evaluate(() => {
      const w = window as unknown as { __longest: number }
      w.__longest = 0
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__longest = Math.max(w.__longest, e.duration)
      }).observe({ type: 'longtask' })
    })
    const page = await openImport(app)
    await dropFile(page, '[data-testid="import-flow"]', { name: 'big.html', text: html })
    await expect(page.getByTestId('import-count')).toHaveText('2,000 of 2,000 bookmarks selected')
    await page.getByTestId('import-next').click()
    await expect(page.getByTestId('import-target')).toBeVisible()
    await startMainLag(app)
    await page.getByTestId('import-next').click()
    await expect(page.getByTestId('import-progress')).toHaveAttribute('data-phase', 'done', { timeout: 30_000 })
    const job = (await app.evaluate(() =>
      (globalThis as unknown as { __orbit: { run: (n: string, a: unknown) => unknown } }).__orbit.run(
        'import.status',
        {},
      ),
    )) as ImportJob
    expect(job.items[0]?.done).toBe(2000)
    const folderId = job.folders[0]?.folderId as string
    await expect
      .poll(() => readFileSync(join(orbit!.userData, 'orbit-state.json'), 'utf8').includes(folderId))
      .toBe(true)
    const mainLongestMs = await mainLagMs(app)
    const shellLongestMs = await shell.evaluate(() => (window as unknown as { __longest: number }).__longest)
    rounds.push({ ms: job.stats?.ms ?? Number.POSITIVE_INFINITY, mainLongestMs, shellLongestMs })
    await clickDone(page)
    if (meets(rounds.at(-1)!)) break
  }
  console.log(`[IM-05] 2,000 bookmarks: ${JSON.stringify(rounds)}`)
  expect(rounds.some(meets), JSON.stringify(rounds)).toBe(true)

  const s = await state(app)
  const spaceId = s.windows[Object.keys(s.windows)[0] as string]?.spaceId as string
  const folders = (s.spaces[spaceId]?.pinned ?? []).filter((id) => s.folders[id]?.name.startsWith('Imported bookmarks'))
  // Each round made its own folder (IM-15), closed because it holds over 1,000 items.
  expect(folders.map((id) => s.folders[id]?.name)).toEqual(
    ['Imported bookmarks', 'Imported bookmarks (2)', 'Imported bookmarks (3)'].slice(0, rounds.length),
  )
  for (const id of folders) {
    expect(s.folders[id]?.collapsed).toBe(true)
    const tabs = tabsUnder(s, id)
    expect(tabs).toHaveLength(2000)
    expect(tabs.every((t) => t.asleep && !t.favicon)).toBe(true)
  }
  // Not one page was opened: no new web contents, no request.
  expect(await pagesLoaded(app)).toEqual([])
  expect(server.requests).toEqual([])
  // The browser window still answers at once.
  await shell.keyboard.press(`${MOD}+T`)
  await expect
    .poll(async () => (await state(app)).windows[Object.keys(s.windows)[0] as string]?.overlay.kind)
    .toBe('commandbar')
})

test('[IM-13][IM-14] a quit while bookmarks are being added takes them back: the relaunch shows no part-filled folder (F6)', async () => {
  test.setTimeout(180_000)
  const userData = mkdtempSync(join(tmpdir(), 'orbit-e2e-'))
  try {
    orbit = await launchImport({ userData })
    const { app } = orbit
    const s = await state(app)
    const spaceId = s.windows[Object.keys(s.windows)[0] as string]?.spaceId as string
    // 100,000 bookmarks in one folder: adding them takes several seconds, a part at a time.
    const children: BookmarkNode[] = Array.from({ length: 100_000 }, (_, i) => ({
      id: `b${i}`,
      title: `Page ${i + 1}`,
      url: `https://example.com/page/p${i + 1}`,
    }))
    const bookmarks: BookmarkNode[] = [{ id: 'f', title: 'Many', children }]
    await run(app, 'import.start', {
      plan: { kind: 'file', name: 'many.html', bookmarks, target: { kind: 'space', spaceId } },
    })
    let added = 0
    await expect
      .poll(
        async () => {
          const job = (await run(app, 'import.status', {})) as ImportJob
          added = job.items[0]?.done ?? 0
          return job.phase === 'adding' && added > 0
        },
        { intervals: [10], timeout: 60_000 },
      )
      .toBe(true)
    await app.close()
    console.log(`[F6] quit with ${added.toLocaleString('en-US')} of 100,000 bookmarks added`)
    expect(added).toBeLessThan(100_000)

    orbit = await launchImport({ userData })
    const after = await state(orbit.app)
    const left = Object.values(after.tabs).filter((t) => t.pinnedUrl?.startsWith('https://example.com/page/'))
    console.log(`[F6] after the relaunch: ${left.length} of the imported tabs`)
    expect(Object.values(after.folders).map((f) => f.name)).not.toContain('Imported bookmarks')
    expect(left).toHaveLength(0)
  } finally {
    await orbit?.app.close().catch(() => {})
    orbit = undefined
    rmSync(userData, { recursive: true, force: true })
  }
})

test('[IM-14] the summary counts every skipped bookmark, also those in a folder that holds nothing else (F3)', async () => {
  orbit = await launchImport()
  const { app } = orbit
  const html = netscapeHtml([
    {
      title: 'Scripts',
      children: [
        { title: 'One', url: 'javascript:void(1)' },
        { title: 'Two', url: 'javascript:void(2)' },
        { title: 'Three', url: 'javascript:void(3)' },
      ],
    },
    { title: 'Four', url: 'javascript:void(4)' },
    { title: 'A page', url: 'https://example.com/page/A' },
  ])
  const page = await openImport(app)
  await dropFile(page, '[data-testid="import-flow"]', { name: 'scripts.html', text: html })
  await expect(page.getByTestId('import-count')).toHaveText('1 of 1 bookmarks selected')
  const job = await importToCurrentSpace(page)
  await expect(page.getByTestId('import-skipped').locator('li')).toHaveText([
    '4 bookmarks: Bookmarklet (a script, not a page)',
  ])
  // No folder for the scripts: only the page came over.
  expect(pinnedShape(await state(app), [job.folders[0]?.folderId as string])).toEqual([
    { 'Imported bookmarks': ['A page <https://example.com/page/A>'] },
  ])
})
