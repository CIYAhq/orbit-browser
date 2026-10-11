import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, test } from '@playwright/test'
import { isMac, launchOrbit, MOD, type Orbit, run, viewPage } from './helpers'
import { choosePageMenu, clickInPage, focusedUrl, pageMenu, pressInPage } from './nav-support'
import { type PagesFixtures, startPagesFixtures } from './pages-support'
import { newTab, waitTab } from './tabs-support'

/**
 * Save Page As… (NV-21): the page saved where the save dialog says. The test answers the dialog
 * (`dialog.showSaveDialog` replaced): no dialog waits for a person.
 */

let fx: PagesFixtures
let orbit: Orbit
let out = ''

test.beforeAll(async () => {
  fx = await startPagesFixtures()
})
test.afterAll(async () => {
  await fx.close()
})
test.beforeEach(async () => {
  orbit = await launchOrbit()
  out = mkdtempSync(join(tmpdir(), 'orbit-save-'))
})
test.afterEach(async () => {
  await orbit.app.close()
  rmSync(out, { recursive: true, force: true })
})

/** ⇧⌘S on macOS, Ctrl+Shift+S elsewhere, for pressInPage. */
const SAVE_KEYS: ('meta' | 'control' | 'shift')[] = isMac ? ['meta', 'shift'] : ['control', 'shift']

interface Asked {
  defaultPath?: string
  filters?: string[]
}

/** Answers the save dialogs that come next with `paths`, in turn, and records what each one asked. */
async function answerSaves(app: ElectronApplication, paths: string[]): Promise<() => Promise<Asked[]>> {
  await app.evaluate(({ dialog }, list) => {
    const g = globalThis as unknown as { __asked: Asked[] }
    g.__asked = []
    const answers = [...list]
    dialog.showSaveDialog = (async (...args: unknown[]) => {
      const options = args[args.length - 1] as Electron.SaveDialogOptions
      g.__asked.push({ defaultPath: options.defaultPath, filters: options.filters?.map((f) => f.name) })
      const filePath = answers.shift()
      return filePath ? { canceled: false, filePath } : { canceled: true, filePath: '' }
    }) as typeof dialog.showSaveDialog
  }, paths)
  return () => app.evaluate(() => (globalThis as unknown as { __asked: Asked[] }).__asked)
}

/** The text of a saved file, once it is all there. */
async function saved(path: string, ending: string): Promise<string> {
  await expect.poll(() => existsSync(path) && readFileSync(path, 'utf8').trimEnd().endsWith(ending)).toBe(true)
  return readFileSync(path, 'utf8')
}

/** The keys the right-click menu built last showed, as "Label=Accelerator" (KS-18). */
const menuHints = (app: ElectronApplication) =>
  app.evaluate(() =>
    (globalThis as unknown as { __orbitKeys: { lastMenuHints: () => string[] } }).__orbitKeys.lastMenuHints(),
  )

test('[NV-21][KS-08] ⇧⌘S (Ctrl+Shift+S) asks where to save the page, from the Downloads folder, and saves it there as one file or its HTML alone; the page menu, the command bar and a Peek’s page save too', async () => {
  const { app, shell } = orbit
  const url = fx.url('/page/Kept')
  const tabId = await newTab(app, url)
  await waitTab(app, tabId, '/page/Kept')
  await expect.poll(() => focusedUrl(app)).toBe(url)
  const downloads = await app.evaluate(({ app: electron }) => electron.getPath('downloads'))
  const asked = await answerSaves(
    app,
    ['Kept.mhtml', 'Kept.html', 'Peeked.mhtml', 'Bar.mhtml'].map((name) => join(out, name)),
  )

  // The page as a single file, named after it, from the Downloads folder.
  await pressInPage(app, '/page/Kept', 'S', SAVE_KEYS)
  const single = await saved(join(out, 'Kept.mhtml'), '--')
  expect(single).toContain('multipart/related')
  expect(single).toContain(url)
  expect(await asked()).toEqual([
    { defaultPath: join(downloads, 'Kept.mhtml'), filters: ['Web Page, Single File', 'Web Page, HTML Only'] },
  ])

  // The page's menu shows the key, and saves too: a name ending in .html saves the HTML alone.
  await clickInPage(app, '/page/Kept', '#title', [], 'right')
  await expect.poll(async () => (await pageMenu(app))?.tabId).toBe(tabId)
  expect(await menuHints(app)).toContain(`Save Page As…=${isMac ? 'Command' : 'Control'}+Shift+S`)
  expect(await choosePageMenu(app, 'Save Page As…')).toBe(true)
  const html = await saved(join(out, 'Kept.html'), '</html>')
  expect(html).toContain('<h1 id="title">Kept</h1>')
  expect(html).not.toContain('multipart/related')

  // A Peek's page saves itself, not the tab under it.
  const peekUrl = fx.url('/page/Peeked')
  const peekTab = (await run(app, 'peek.open', { url: peekUrl })) as string
  await waitTab(app, peekTab, '/page/Peeked')
  await expect.poll(() => focusedUrl(app)).toBe(peekUrl)
  await pressInPage(app, '/page/Peeked', 'S', SAVE_KEYS)
  const peeked = await saved(join(out, 'Peeked.mhtml'), '--')
  expect(peeked).toContain(peekUrl)
  expect(peeked).not.toContain(url)
  await run(app, 'peek.close', {})

  // The command bar's Save Page As…, with its key.
  await shell.keyboard.press(`${MOD}+T`)
  const overlay = await viewPage(app, 'overlay')
  await expect(overlay.getByTestId('command-input')).toBeFocused()
  await overlay.keyboard.type('Save page as')
  const top = overlay.getByTestId('command-result').first()
  await expect(top.getByTestId('command-result-title')).toHaveText('Save Page As…')
  await expect(top.getByTestId('command-shortcut')).toHaveText(isMac ? '⇧⌘S' : 'Ctrl+Shift+S')
  await overlay.keyboard.press('Enter')
  expect(await saved(join(out, 'Bar.mhtml'), '--')).toContain(url)
  expect((await asked()).map((a) => a.defaultPath)).toEqual(
    ['Kept', 'Kept', 'Peeked', 'Kept'].map((name) => join(downloads, `${name}.mhtml`)),
  )
})
