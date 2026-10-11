import { type ElectronApplication, expect, test } from '@playwright/test'
import { netscapeHtml } from '../../scripts/import-fixtures'
import type { ArchivePage, BackupInfo, BackupRestoreResult } from '../../src/shared/commands/archive'
import type { SearchResponse } from '../../src/shared/commands/commandbar'
import { type ImportJob, STOPPED_BY_RESTORE } from '../../src/shared/commands/import'
import { action, MOD, type Orbit, run, state, viewPage } from './helpers'
import {
  danglingIds,
  dropFile,
  holdAddingAt,
  importedTabs,
  inFolders,
  launchImport,
  loggedServer,
  openImport,
  placesOf,
  resumeAdding,
  tabsUnder,
  untilMade,
} from './import-support'
import { rowMenu, tabsHook } from './tabs-support'

/**
 * An import's unfinished tabs, until its folder shows (D65): reachable nowhere; one the user reached anyway and placed
 * stays where they put it; Restore Data stops the import first.
 */

let orbit: Orbit | undefined
let server: Awaited<ReturnType<typeof loggedServer>> | undefined

test.afterEach(async () => {
  await orbit?.app.close().catch(() => {})
  await server?.close()
  orbit = undefined
  server = undefined
})

/** The tabs the command bar offers for `query` (empty: the recent tabs it opens with), as their ids. */
async function tabRows(app: ElectronApplication, query: string): Promise<string[]> {
  const { results } = (await run(app, 'search.query', { query, mode: 'new-tab' })) as SearchResponse
  return results.flatMap((r) => (r.kind === 'tab' && r.tabId ? [r.tabId] : []))
}

/** Waits until an import has ended, its numbers in; returns its status. */
async function untilEnded(app: ElectronApplication, jobId: string): Promise<ImportJob> {
  let job: ImportJob | undefined
  await expect
    .poll(
      async () => {
        job = (await run(app, 'import.status', { jobId })) as ImportJob
        return !!job.stats && job.phase !== 'reading' && job.phase !== 'adding'
      },
      { timeout: 60_000 },
    )
    .toBe(true)
  return job as ImportJob
}

/** The id of the tab of `inFolders`' bookmark `page` in folder `folder`. */
function tabOf(s: Awaited<ReturnType<typeof state>>, folder: number, page: number): string {
  const url = `https://example.com/page/f${folder}/p${page}`
  return importedTabs(s).find((t) => t.pinnedUrl === url)?.id as string
}

test('[IM-14] while an import adds its bookmarks, the command bar finds none of their tabs: not by title, by address or among recent tabs (D65 (1))', async () => {
  test.setTimeout(120_000)
  orbit = await launchImport()
  const { app, shell } = orbit
  const s = await state(app)
  const spaceId = s.windows[Object.keys(s.windows)[0] as string]?.spaceId as string
  // 4,000 bookmarks in folders of 1,000, held once the first 1,000 are made (an e2e hook).
  await holdAddingAt(app, 1000)
  const id = (await run(app, 'import.start', {
    plan: { kind: 'file', name: 'many.html', bookmarks: inFolders(4, 1000), target: { kind: 'space', spaceId } },
  })) as string
  await untilMade(app, 1000)
  const unfinished = new Set(importedTabs(await state(app)).map((t) => t.id))
  expect(unfinished.size).toBe(1000)
  // Opened empty (its recent tabs), a title, another, an address: none of them.
  for (const query of ['', 'Page 1', 'Page 999', 'example.com/page/f1/p1']) {
    const found = (await tabRows(app, query)).filter((tabId) => unfinished.has(tabId))
    expect(found, `the command bar for "${query}"`).toEqual([])
  }
  // In the command bar itself: a title typed, the rows that answer it drawn, none of them one of its tabs.
  await shell.keyboard.press(`${MOD}+T`)
  const overlay = await viewPage(app, 'overlay')
  const input = overlay.getByTestId('command-input')
  await expect(input).toBeFocused()
  await input.fill('Page 999')
  await expect(overlay.getByTestId('command-result').filter({ hasText: 'Page 999' }).first()).toBeVisible()
  const rows = await overlay
    .locator('[data-testid="command-result"][data-kind="tab"]')
    .evaluateAll((els) => els.map((el) => (el.getAttribute('data-id') ?? '').replace(/^tab:/, '')))
  expect(rows.filter((tabId) => unfinished.has(tabId))).toEqual([])
  await input.press('Escape')
  // Shown whole, they're the user's: found like any tab.
  await resumeAdding(app)
  expect((await untilEnded(app, id)).phase).toBe('done')
  expect((await tabRows(app, 'Page 999')).filter((tabId) => unfinished.has(tabId)).length).toBeGreaterThan(0)
})

test('[IM-14] a tab of an import the user reached anyway and placed stays where they put it, in one place with one row; its close and the import’s undo leave no id behind (D65 (2))', async () => {
  test.setTimeout(120_000)
  server = await loggedServer()
  orbit = await launchImport()
  const { app, shell } = orbit
  const s = await state(app)
  const spaceId = s.windows[Object.keys(s.windows)[0] as string]?.spaceId as string
  const spaceName = s.spaces[spaceId]?.name
  // A Today tab and a pinned tab of the user's.
  const today = (await run(app, 'tabs.create', {
    url: server.url('/today'),
    spaceId,
    container: { kind: 'today', spaceId },
    activate: false,
  })) as string
  const pinned = (await run(app, 'tabs.create', {
    url: server.url('/pinned'),
    spaceId,
    container: { kind: 'pinned', spaceId },
    activate: false,
  })) as string
  await holdAddingAt(app, 1000)
  const id = (await run(app, 'import.start', {
    plan: { kind: 'file', name: 'many.html', bookmarks: inFolders(4, 1000), target: { kind: 'space', spaceId } },
  })) as string
  await untilMade(app, 1000)
  // Two of its tabs, reached anyway (a test hook: nothing lists them, D65 (1)): one switched to, as "Switch to tab"
  // did, then put in a split view with the Today tab; the other put in one with the pinned tab.
  // Main refuses them to a window (D66 (1)): with its guard off, the commands stand for a route it doesn't guard.
  const during = await state(app)
  const a = tabOf(during, 1, 1)
  const b = tabOf(during, 1, 2)
  await tabsHook(app, 'importGuard', false)
  await run(app, 'tabs.activate', { tabId: a })
  const splitA = (await run(app, 'tabs.splitWith', { tabId: a, target: today, side: 'right' })) as string
  const splitB = (await run(app, 'tabs.splitWith', { tabId: b, target: pinned, side: 'right' })) as string
  await tabsHook(app, 'importGuard', true)
  expect([splitA, splitB].every(Boolean)).toBe(true)
  await resumeAdding(app)
  const job = await untilEnded(app, id)
  expect(job.phase).toBe('done')
  const root = job.folders[0]?.folderId as string

  // Each is where the user put it, and only there: the folder holds the other 3,998.
  let after = await state(app)
  expect.soft(placesOf(after, a), 'the tab put in a split in Today').toEqual([`split ${splitA}`])
  expect.soft(placesOf(after, b), 'the tab put in a split in the pinned section').toEqual([`split ${splitB}`])
  expect.soft(placesOf(after, splitA)).toEqual([`today ${spaceName}`])
  expect.soft(placesOf(after, splitB)).toEqual([`pinned ${spaceName}`])
  expect.soft(tabsUnder(after, root)).toHaveLength(3998)
  expect.soft(job.items[0]?.done, 'the bookmarks it imported, the two the user placed among them').toBe(4000)
  expect.soft(danglingIds(after)).toEqual([])
  // One row each in the sidebar, with "Folder 1", where the two came from, open.
  const folder1 = after.folders[root]?.children.find((c) => after.folders[c]?.name === 'Folder 1') as string
  await run(app, 'folders.setCollapsed', { folderId: root, collapsed: false })
  await run(app, 'folders.setCollapsed', { folderId: folder1, collapsed: false })
  const sidebar = shell.getByTestId('sidebar')
  await expect(sidebar.locator(`[data-tab-id="${tabOf(after, 1, 3)}"]`)).toBeVisible()
  await expect.soft(sidebar.locator(`[data-tab-id="${a}"]`)).toHaveCount(1)
  await expect.soft(sidebar.locator(`[data-tab-id="${b}"]`)).toHaveCount(1)

  // The import's undo takes its folder back, not the tabs the user placed: nothing is left behind.
  expect(await run(app, 'tabs.undo')).toBe('Import Bookmarks')
  after = await state(app)
  expect.soft(after.folders[root]).toBeUndefined()
  expect.soft([after.tabs[a]?.id, after.tabs[b]?.id]).toEqual([a, b])
  expect.soft(placesOf(after, a)).toEqual([`split ${splitA}`])
  expect.soft(danglingIds(after)).toEqual([])
  // Redo puts the folder back; closing the tab then leaves its id nowhere.
  expect(await run(app, 'tabs.redo')).toBe('Import Bookmarks')
  await run(app, 'tabs.close', { tabId: a })
  after = await state(app)
  expect.soft(after.tabs[a]).toBeUndefined()
  expect.soft(placesOf(after, a)).toEqual([])
  expect.soft(danglingIds(after)).toEqual([])
  expect.soft(tabsUnder(after, root)).toHaveLength(3998)
})

test('[IM-14] a window that names a tab the import hasn’t shown gets nothing shown or placed: main refuses it (D66 (1))', async () => {
  test.setTimeout(120_000)
  server = await loggedServer()
  orbit = await launchImport()
  const { app } = orbit
  const s = await state(app)
  const windowId = Object.keys(s.windows)[0] as string
  const spaceId = s.windows[windowId]?.spaceId as string
  // The user's tab, shown.
  const mine = (await run(app, 'tabs.create', {
    url: server.url('/mine'),
    spaceId,
    container: { kind: 'today', spaceId },
  })) as string
  const shown = async () => (await state(app)).windows[windowId]?.activeTab[spaceId]
  await expect.poll(shown).toBe(mine)
  await holdAddingAt(app, 1000)
  const id = (await run(app, 'import.start', {
    plan: { kind: 'file', name: 'many.html', bookmarks: inFolders(4, 1000), target: { kind: 'space', spaceId } },
  })) as string
  await untilMade(app, 1000)
  const during = await state(app)
  const hidden = tabOf(during, 1, 1)
  const other = tabOf(during, 1, 2)
  const windows = Object.keys(during.windows).length
  const copies = (st: typeof during) =>
    Object.values(st.tabs).filter((t) => t.url === during.tabs[hidden]?.url || t.url === during.tabs[other]?.url)

  // The fix check's repro: switched to by its id, then Add Split Right. The user's tab stays shown and is the one split.
  await run(app, 'tabs.activate', { tabId: hidden })
  expect(await shown(), 'the tab shown after tabs.activate named a hidden one').toBe(mine)
  await action(app, 'split.addRight')
  await expect.poll(async () => placesOf(await state(app), mine)[0] ?? '').toMatch(/^split /)
  expect.soft(placesOf(await state(app), hidden), 'after Add Split Right').toEqual([])
  // Into a split view by a drop's command, as the tab dropped or as the row dropped on.
  expect.soft(await run(app, 'tabs.splitWith', { tabId: other, target: mine, side: 'right' }), 'splitWith').toBeNull()
  expect
    .soft(await run(app, 'tabs.splitWith', { tabId: mine, target: other, side: 'left' }), 'splitWith onto it')
    .toBeNull()
  // Into a split view by the split commands: made with it, added as a pane or as the pane added to, or a new page
  // opened beside it. Into a Mini Window of its own.
  expect.soft(await run(app, 'split.create', { tabIds: [mine, hidden] }), 'split.create').toBeNull()
  expect.soft(await run(app, 'split.addTab', { tabId: other, target: mine }), 'split.addTab').toBeNull()
  expect.soft(await run(app, 'split.addTab', { tabId: mine, target: other }), 'split.addTab onto it').toBeNull()
  expect
    .soft(await run(app, 'split.openUrl', { url: server.url('/beside'), target: hidden }), 'split.openUrl beside it')
    .toBeNull()
  expect.soft(await run(app, 'mini.fromTab', { tabId: hidden }), 'mini.fromTab').toBeNull()
  // Focused as a pane: it is in no split (the fix check's repro, round 2).
  await run(app, 'split.focusPane', { tabId: hidden })
  expect.soft(await shown(), 'the tab shown after split.focusPane named a hidden one').not.toBe(hidden)
  // Out to a window of its own; copied; its menu; closed or deleted (the Archive would list it); selected.
  expect.soft(await run(app, 'tabs.toNewWindow', { tabId: hidden }), 'toNewWindow').toBeNull()
  await expect.soft(run(app, 'tabs.duplicate', { tabId: hidden }), 'duplicate').rejects.toThrow('No such tab')
  await run(app, 'tabs.contextMenu', { id: hidden })
  await run(app, 'tabs.close', { tabId: hidden })
  await run(app, 'tabs.delete', { id: other })
  // Moves already went nowhere for a tab no section holds (the fix check's own tries).
  await run(app, 'tabs.move', { ids: [hidden], to: { kind: 'today', spaceId }, index: 0 })
  await run(app, 'tabs.pin', { tabId: other })
  await run(app, 'tabs.favorite', { tabId: hidden })
  await orbit.shell.waitForTimeout(300)
  expect.soft(await rowMenu(app), 'a row menu for it').toBeNull()
  const after = await state(app)
  // Add Split Right showed its new pane, beside the user's tab.
  expect.soft([hidden, other], 'the tab shown').not.toContain(await shown())
  for (const t of [hidden, other]) {
    expect.soft(after.tabs[t], 'still there, out of sight').toBeDefined()
    expect.soft(placesOf(after, t), 'placed').toEqual([])
  }
  expect.soft(Object.keys(after.windows), 'windows').toHaveLength(windows)
  expect
    .soft(
      copies(after)
        .map((t) => t.id)
        .toSorted(),
      'copies of its page',
    )
    .toEqual([hidden, other].toSorted())
  const archive = (await run(app, 'archive.query', { text: 'example.com/page' })) as ArchivePage
  expect.soft(archive.total, 'its page in the Archive').toBe(0)

  // Shown whole at last, the folder holds every one of them.
  await resumeAdding(app)
  const job = await untilEnded(app, id)
  expect(job.phase).toBe('done')
  const root = job.folders[0]?.folderId as string
  expect.soft(tabsUnder(await state(app), root)).toHaveLength(4000)
})

test('[IM-14][AR-11] Restore Data part-way through an import stops it: none of its tabs go to the Archive, and its window says why (D65 (3))', async () => {
  test.setTimeout(180_000)
  server = await loggedServer()
  orbit = await launchImport()
  const { app } = orbit
  const s = await state(app)
  const spaceId = s.windows[Object.keys(s.windows)[0] as string]?.spaceId as string
  // A pinned tab of the user's, then a backup of the sidebar.
  const mine = (await run(app, 'tabs.create', {
    url: server.url('/mine'),
    spaceId,
    container: { kind: 'pinned', spaceId },
    activate: false,
  })) as string
  const backup = (await run(app, 'backups.take', {})) as BackupInfo
  expect(backup?.id).toBeTruthy()
  const pinnedBefore = (await state(app)).spaces[spaceId]?.pinned
  expect(pinnedBefore).toContain(mine)
  // An import from the import window: 4,000 bookmarks, held once 1,000 are made (an e2e hook).
  await holdAddingAt(app, 1000)
  const page = await openImport(app)
  await dropFile(page, '[data-testid="import-flow"]', { name: 'many.html', text: netscapeHtml(inFolders(4, 1000)) })
  await expect(page.getByTestId('import-step-bookmarks')).toBeVisible()
  await page.getByTestId('import-next').click()
  await expect(page.getByTestId('import-target')).toBeVisible()
  await page.getByTestId('import-next').click()
  await untilMade(app, 1000)
  await expect(page.getByTestId('import-progress')).toHaveAttribute('data-phase', 'adding')

  const restored = (await run(app, 'backups.restore', { id: backup.id })) as BackupRestoreResult
  console.log(`[D65] Restore Data with 1,000 of 4,000 bookmarks made: ${JSON.stringify(restored)}`)
  expect.soft(restored).toMatchObject({ restored: true, archived: 0 })
  // None of the import's pages in the Archive, and none of its tabs anywhere; the user's tab is there.
  const archive = (await run(app, 'archive.query', { text: 'example.com/page' })) as ArchivePage
  expect.soft(archive.total, 'the import’s pages in the Archive').toBe(0)
  let after = await state(app)
  expect.soft(after.archive.filter((e) => e.url.startsWith('https://example.com/page/'))).toEqual([])
  expect.soft(importedTabs(after)).toHaveLength(0)
  expect.soft(after.spaces[spaceId]?.pinned).toEqual(pinnedBefore)
  // The import window says it stopped, and why.
  const progress = page.getByTestId('import-progress')
  await expect.soft(progress).toHaveAttribute('data-phase', 'failed')
  await expect.soft(progress).toContainText('The import stopped: data was restored from a backup.')

  // Let go, it adds nothing more.
  await resumeAdding(app)
  const job = await untilEnded(app, ((await run(app, 'import.status', {})) as ImportJob).id)
  expect.soft(job.phase).toBe('failed')
  expect.soft(job.folders).toEqual([])
  after = await state(app)
  expect.soft(importedTabs(after)).toHaveLength(0)
  expect.soft(Object.values(after.folders).map((f) => f.name)).toEqual([])
  await expect.soft(progress).toHaveAttribute('data-phase', 'failed')

  // The restore's undo (⌘Z) and its redo (⌘⇧Z) replace the sidebar too: each stops an import that is adding, the
  // same way (import fix check 3, N1).
  for (const [step, command] of [
    ['undo', 'tabs.undo'],
    ['redo', 'tabs.redo'],
  ] as const) {
    await holdAddingAt(app, 1000)
    const jobId = (await run(app, 'import.start', {
      plan: { kind: 'file', name: `${step}.html`, bookmarks: inFolders(2, 1000), target: { kind: 'space', spaceId } },
    })) as string
    await untilMade(app, 1000)
    expect(await run(app, command), `${step} while an import adds`).toBe('Restore Data')
    await resumeAdding(app)
    const stopped = await untilEnded(app, jobId)
    expect.soft(stopped.phase, `the import during the ${step}`).toBe('failed')
    expect.soft(stopped.error ?? '', `why it stopped (${step})`).toContain(STOPPED_BY_RESTORE)
    const left = (await run(app, 'archive.query', { text: 'example.com/page' })) as ArchivePage
    expect.soft(left.total, `the import’s pages in the Archive after the ${step}`).toBe(0)
    expect.soft(importedTabs(await state(app)), `its tabs after the ${step}`).toHaveLength(0)
  }
})
