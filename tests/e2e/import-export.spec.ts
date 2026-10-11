import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, test } from '@playwright/test'
import { parseBookmarksHtml } from '../../src/main/import/netscape'
import type { BookmarkNode } from '../../src/shared/commands/import'
import { action, type Orbit, run, state } from './helpers'
import { launchImport } from './import-support'
import { openSettings } from './settings-support'

/** Export pinned items as bookmarks (IM-17): Orbit's pinned items, out, as a file any browser imports. */

let orbit: Orbit | undefined
let dir: string | undefined

test.afterEach(async () => {
  await orbit?.app.close().catch(() => {})
  orbit = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/** Makes the next save dialog answer `path` instead of asking. */
async function saveTo(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as unknown as typeof dialog.showSaveDialog
  }, path)
}

/** A bookmarks file as another browser reads it: folders and "title <address>". */
function readBack(file: string): unknown[] {
  const shape = (list: readonly BookmarkNode[]): unknown[] =>
    list.map((n) => (n.children ? { [n.title]: shape(n.children) } : `${n.title} <${n.url}>`))
  return shape(parseBookmarksHtml(readFileSync(file, 'utf8')) ?? [])
}

test('[IM-17] Export Pinned Items as Bookmarks: the command, or Settings with Today’s tabs, writes a bookmarks file', async () => {
  orbit = await launchImport()
  const { app } = orbit
  dir = mkdtempSync(join(tmpdir(), 'orbit-export-e2e-'))
  const s = await state(app)
  const spaceId = s.spaceOrder[0] as string
  const space = s.spaces[spaceId]
  const create = (url: string, container?: unknown) =>
    run(app, 'tabs.create', { url, spaceId, activate: false, ...(container ? { container } : {}) }) as Promise<string>
  const calendar = await create('https://example.com/calendar', { kind: 'pinned', spaceId })
  await run(app, 'folders.create', { container: { kind: 'pinned', spaceId }, name: 'Team', items: [calendar] })
  await create('https://mail.example.net/', { kind: 'favorites', profileId: space?.profileId })
  await create('https://news.example.org/')
  const expected = [
    { Favorites: ['mail.example.net <https://mail.example.net/>'] },
    { [space?.name as string]: [{ Team: ['example.com <https://example.com/calendar>'] }] },
  ]

  // The command (the command bar's, and the File menu's on macOS): pinned items and Favorites, not Today.
  await saveTo(app, join(dir, 'pinned.html'))
  await action(app, 'app.exportPinned')
  await expect.poll(() => existsSync(join(dir as string, 'pinned.html'))).toBe(true)
  expect(readBack(join(dir, 'pinned.html'))).toEqual(expected)

  // Settings → General: Today's tabs too, when asked; it says where the file went.
  const settings = await openSettings(app, { section: 'general' })
  await saveTo(app, join(dir, 'with-today.html'))
  await settings.getByTestId('export-today').click()
  await settings.getByTestId('export-pinned').click()
  await expect(settings.getByTestId('setting-export-pinned')).toContainText(`Saved to ${join(dir, 'with-today.html')}`)
  const withToday = readBack(join(dir, 'with-today.html')) as Record<string, unknown[]>[]
  expect(withToday[1]?.[space?.name as string]?.at(-1)).toEqual({
    Today: ['news.example.org <https://news.example.org/>'],
  })
})
