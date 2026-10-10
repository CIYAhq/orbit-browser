import { readFileSync } from 'node:fs'
import { expect, type Page, test } from '@playwright/test'
import { PASTE_DEFAULT_NAME } from '../../src/renderer/src/import/copy'
import type { ImportJob } from '../../src/shared/commands/import'
import { MOD, type Orbit, run, state } from './helpers'
import { dropFile, fixturePath, importPage, launchImport, loggedServer, openImport, tabsUnder } from './import-support'

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
  await page.getByTestId('import-done').click()
  await expect.poll(() => page.isClosed()).toBe(true)
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
  await page.getByTestId('import-done').click()
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
