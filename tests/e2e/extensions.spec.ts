import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import type { OrbitState } from '../../src/shared/state'
import { type CrxKey, FIXTURES, makeKey, packFolder } from '../fixtures/extensions/pack'
import { action, type Fixtures, launchOrbit, type Orbit, run, startFixtures, state, tabPage, viewPage } from './helpers'
import { newTab, waitTab } from './tabs-support'

/**
 * Chrome extensions (EX-*), with the fixture extensions only (tests/fixtures/extensions/), packed on
 * the spot: nothing here reaches the network or a store. The file picker is replaced in main, so no
 * dialog waits for a person.
 */

let fx: Fixtures
let orbit: Orbit
let scratch: string

test.beforeAll(async () => {
  fx = await startFixtures()
})
test.afterAll(async () => {
  await fx.close()
})
test.beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'orbit-ext-'))
  orbit = await launchOrbit()
})
test.afterEach(async () => {
  await orbit.app.close()
})

const PAGE_URL = 'orbit://extensions/'
const NAME = 'Orbit Test Extension'

interface Packed {
  path: string
  id: string
  bytes: Buffer
  key: CrxKey
}

/** Packs a fixture folder into a .crx file in the test's scratch folder. */
function pack(folder: string, key: CrxKey = makeKey(), name = 'fixture.crx'): Packed {
  const { file } = packFolder(folder, key)
  const path = join(scratch, name)
  writeFileSync(path, file)
  return { path, id: key.id, bytes: file, key }
}

/** The next file or folder picker in main answers `path` (null: Cancel). */
async function pickNext(app: ElectronApplication, path: string | null): Promise<void> {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () =>
      picked ? { canceled: false, filePaths: [picked] } : { canceled: true, filePaths: [] }) as never
  }, path)
}

interface Hooks {
  __orbit: { state: () => OrbitState; ctx: { tabs: { contents: (id: string) => Electron.WebContents | undefined } } }
  __orbitExtensions: {
    loaded: (profileId: string) => string[]
    installBytes: (profileId: string, bytes: Uint8Array, accept: boolean) => Promise<{ ok: boolean; error?: string }>
  }
}

/** The IDs running now in a profile's session. */
const loaded = (app: ElectronApplication, profileId: string) =>
  app.evaluate((_e, p) => (globalThis as unknown as Hooks).__orbitExtensions.loaded(p), profileId)

/** Installs a packed extension as if picked and confirmed. */
async function install(app: ElectronApplication, profileId: string, packed: Packed): Promise<void> {
  const result = await app.evaluate(
    (_e, [p, bytes]) =>
      (globalThis as unknown as Hooks).__orbitExtensions.installBytes(
        p as string,
        new Uint8Array(bytes as number[]),
        true,
      ),
    [profileId, [...packed.bytes]] as const,
  )
  expect(result).toEqual(expect.objectContaining({ ok: true }))
}

/** What a tab's page says in one of its root element's data attributes ('' if nothing set it). */
async function mark(app: ElectronApplication, tabId: string, attribute: string): Promise<string> {
  return app.evaluate(
    async (_e, [id, attr]) => {
      const contents = (globalThis as unknown as Hooks).__orbit.ctx.tabs.contents(id as string)
      if (!contents || contents.isDestroyed()) return 'no page'
      return contents.executeJavaScript(`document.documentElement.dataset[${JSON.stringify(attr)}] ?? ''`)
    },
    [tabId, attribute] as const,
  )
}

/** Opens a fixture page in a new tab (in `spaceId`'s Space, else the window's) and waits for it. */
async function visit(app: ElectronApplication, name: string, spaceId?: string): Promise<string> {
  const tabId = await newTab(app, fx.url(`/page/${name}`), spaceId ? { spaceId } : {})
  await waitTab(app, tabId, `/page/${name}`)
  return tabId
}

/** Reloads a tab and waits until it has loaded again. */
async function reload(app: ElectronApplication, tabId: string, part: string): Promise<void> {
  await run(app, 'tabs.reload', { tabId })
  await waitTab(app, tabId, part)
}

/** The Space shown in the first window, and its profile. */
async function current(app: ElectronApplication): Promise<{ spaceId: string; profileId: string }> {
  const s = await state(app)
  const win = Object.values(s.windows)[0] as OrbitState['windows'][string]
  return { spaceId: win.spaceId, profileId: s.spaces[win.spaceId]?.profileId as string }
}

/** Opens the extensions page (Manage Extensions) and returns it, ready. */
async function openPage(app: ElectronApplication): Promise<Page> {
  await action(app, 'extension.manage')
  const page = await tabPage(app, PAGE_URL)
  await expect(page.getByTestId('ext-page')).toHaveAttribute('data-ready', 'true')
  return page
}

/** The extensions installed in a profile, from the state. */
const installed = async (app: ElectronApplication, profileId: string) =>
  Object.values((await state(app)).extensions)
    .filter((e) => e.profileId === profileId)
    .map((e) => e.id)

/** Orbit's copies of extensions' files in a profile. */
const filesOf = (userData: string, profileId: string) => {
  const dir = join(userData, 'Extensions', profileId)
  return existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith('.')) : []
}

/** Runs a script in the page of the first web contents whose address starts with `prefix`. */
async function inContents(app: ElectronApplication, prefix: string, script: string): Promise<unknown> {
  return app.evaluate(
    async ({ webContents }, [p, s]) => {
      const found = webContents.getAllWebContents().find((c) => !c.isDestroyed() && c.getURL().startsWith(p as string))
      return found ? found.executeJavaScript(s as string) : 'no page'
    },
    [prefix, script] as const,
  )
}

test('[EX-09][EX-02] Install from file: Orbit’s own dialog names it and what it may do; Cancel leaves no trace; Add installs it into the Space’s profile only, where its content script runs', async () => {
  const { app, shell, userData } = orbit
  const { profileId } = await current(app)
  const packed = pack(FIXTURES.basic)
  const page = await openPage(app)
  await expect(page.getByTestId('ext-empty')).toHaveText('No extensions in this profile yet.')

  // Cancel in Orbit's dialog (in the overlay, not the page): nothing is left of it.
  await pickNext(app, packed.path)
  await page.getByTestId('ext-install-file').click()
  const overlay = await viewPage(app, 'overlay')
  const dialog = overlay.getByTestId('ext-dialog')
  await expect(dialog).toHaveAttribute('data-kind', 'install')
  await expect(overlay.getByTestId('ext-dialog-title')).toHaveText(`Add “${NAME}”?`)
  await expect(overlay.getByTestId('ext-dialog-icon')).toHaveAttribute('data-generic', 'false')
  await expect(overlay.getByTestId('ext-dialog-permissions')).toHaveText(
    'Read and change your data on localhost and 127.0.0.1',
  )
  await expect(overlay.getByTestId('ext-dialog-cancel')).toBeFocused()
  await expect(overlay.getByTestId('ext-dialog-confirm')).toHaveText('Add extension')
  await overlay.getByTestId('ext-dialog-cancel').click()
  await expect(dialog).toHaveCount(0)
  expect(await installed(app, profileId)).toEqual([])
  expect(await loaded(app, profileId)).toEqual([])
  expect(filesOf(userData, profileId)).toEqual([])
  await expect(page.getByTestId('ext-empty')).toBeVisible()

  // Esc in the dialog is Cancel too.
  await pickNext(app, packed.path)
  await page.getByTestId('ext-install-file').click()
  await expect(dialog).toBeVisible()
  await overlay.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(await installed(app, profileId)).toEqual([])

  // Add extension: installed and running, "<name> added" with Pin (EX-01).
  await pickNext(app, packed.path)
  await page.getByTestId('ext-install-file').click()
  await overlay.getByTestId('ext-dialog-confirm').click()
  await expect.poll(() => installed(app, profileId)).toEqual([packed.id])
  await expect.poll(() => loaded(app, profileId)).toEqual([packed.id])
  const toast = shell.getByTestId('toast').filter({ hasText: `${NAME} added` })
  await expect(toast).toBeVisible()
  await expect(toast.getByTestId('toast-action')).toHaveText('Pin')
  const card = page.getByTestId('ext-card')
  await expect(card).toHaveCount(1)
  await expect(card.getByTestId('ext-name')).toContainText(NAME)
  await expect(card).toHaveAttribute('data-id', packed.id)
  expect(filesOf(userData, profileId)).toEqual([packed.id])

  // Its content script runs in this profile's tabs.
  const here = await visit(app, 'ExtHere')
  await expect.poll(() => mark(app, here, 'orbitTestExtension')).toBe(packed.id)

  // Not in another profile's: a Space with a profile of its own.
  const other = (await run(app, 'profiles.create', { name: 'Work' })) as string
  const workSpace = (await run(app, 'spaces.create', { name: 'Work', profileId: other, activate: false })) as string
  const there = await visit(app, 'ExtThere', workSpace)
  expect(await mark(app, there, 'orbitTestExtension')).toBe('')
  expect(await loaded(app, other)).toEqual([])
  expect(await installed(app, other)).toEqual([])

  // The Pin button pins it (EX-04's pins are per profile).
  await toast.getByTestId('toast-action').click()
  await expect
    .poll(async () => (await state(app)).extensions[`${profileId}:${packed.id}`]?.pinnedAt !== undefined)
    .toBe(true)
})

test('[EX-07] The switch acts at once, without a restart; Details show what it may do; it runs again after a relaunch', async () => {
  const { app, userData } = orbit
  const { profileId } = await current(app)
  const packed = pack(FIXTURES.basic)
  await install(app, profileId, packed)
  const tabId = await visit(app, 'ExtToggle')
  await expect.poll(() => mark(app, tabId, 'orbitTestExtension')).toBe(packed.id)

  const page = await openPage(app)
  const card = page.getByTestId('ext-card')
  const toggle = card.getByTestId('ext-toggle')
  await expect(toggle).toHaveAttribute('aria-checked', 'true')

  // Off: stopped in the session at once; the page loads again without it.
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect.poll(() => loaded(app, profileId)).toEqual([])
  await reload(app, tabId, '/page/ExtToggle')
  expect(await mark(app, tabId, 'orbitTestExtension')).toBe('')

  // On again: it runs on the next load.
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect.poll(() => loaded(app, profileId)).toEqual([packed.id])
  await reload(app, tabId, '/page/ExtToggle')
  await expect.poll(() => mark(app, tabId, 'orbitTestExtension')).toBe(packed.id)

  // Details.
  await card.getByTestId('ext-details').click()
  await expect(card.getByTestId('ext-permissions')).toContainText(
    'Read and change your data on localhost and 127.0.0.1',
  )
  await expect(card.getByTestId('ext-site-access')).toContainText('On localhost and 127.0.0.1')
  await expect(card.getByTestId('ext-errors')).toContainText('None')
  const allowPrivate = card.getByTestId('ext-allow-private')
  await expect(allowPrivate).toHaveAttribute('aria-checked', 'false')
  await allowPrivate.click()
  await expect(allowPrivate).toHaveAttribute('aria-checked', 'true')
  const allowFiles = card.getByTestId('ext-allow-files')
  await allowFiles.click()
  await expect(allowFiles).toHaveAttribute('aria-checked', 'true')
  // Access to file URLs is read as the extension loads: it was loaded again, and still runs.
  await expect.poll(() => loaded(app, profileId)).toEqual([packed.id])
  const saved = (await state(app)).extensions[`${profileId}:${packed.id}`]
  expect(saved).toEqual(expect.objectContaining({ allowPrivate: true, allowFileAccess: true, enabled: true }))

  // Its options page opens in a tab.
  await card.getByTestId('ext-options').click()
  await expect
    .poll(() =>
      inContents(app, `chrome-extension://${packed.id}/options.html`, 'document.documentElement.dataset.options'),
    )
    .toBe('ready')

  // A relaunch: it loads with the profile's session, and the restored tab runs it.
  await run(app, 'tabs.activate', { tabId })
  await app.evaluate(() => (globalThis as unknown as { __orbit: { flush: () => Promise<void> } }).__orbit.flush())
  await app.close()
  orbit = await launchOrbit({ userData })
  const again = orbit.app
  await expect.poll(() => loaded(again, profileId)).toEqual([packed.id])
  await waitTab(again, tabId, '/page/ExtToggle')
  await expect.poll(() => mark(again, tabId, 'orbitTestExtension')).toBe(packed.id)
  const kept = (await state(again)).extensions[`${profileId}:${packed.id}`]
  expect(kept).toEqual(expect.objectContaining({ allowPrivate: true, allowFileAccess: true, enabled: true }))
})

test('[EX-08] Remove asks “Remove <name>?” in Orbit’s dialog; Remove deletes it and its data from the profile, and closes its pages', async () => {
  const { app, userData } = orbit
  const { profileId } = await current(app)
  const packed = pack(FIXTURES.basic)
  await install(app, profileId, packed)
  // Its content script tells its service worker, which counts the visits in chrome.storage: two.
  const tabId = await visit(app, 'ExtRemove')
  await expect.poll(() => mark(app, tabId, 'orbitTestExtension')).toBe(packed.id)
  const options = `chrome-extension://${packed.id}/options.html`
  await run(app, 'extensions.openOptions', { id: packed.id, profileId })
  const visits = `chrome.storage.local.get(null).then((all) => all.visits ?? 0)`
  await expect.poll(() => inContents(app, options, visits)).toBe(1)
  await reload(app, tabId, '/page/ExtRemove')
  await expect.poll(() => inContents(app, options, visits)).toBe(2)

  const page = await openPage(app)
  const card = page.getByTestId('ext-card')
  const overlay = await viewPage(app, 'overlay')
  const dialog = overlay.getByTestId('ext-dialog')

  // Cancel keeps it.
  await card.getByTestId('ext-remove').click()
  await expect(dialog).toHaveAttribute('data-kind', 'remove')
  await expect(overlay.getByTestId('ext-dialog-title')).toHaveText(`Remove “${NAME}”?`)
  await expect(overlay.getByTestId('ext-dialog-cancel')).toBeFocused()
  await overlay.getByTestId('ext-dialog-cancel').click()
  await expect(dialog).toHaveCount(0)
  expect(await installed(app, profileId)).toEqual([packed.id])

  // Remove: gone from the profile, its session, its files and its pages.
  await card.getByTestId('ext-remove').click()
  await expect(overlay.getByTestId('ext-dialog-confirm')).toHaveText('Remove')
  await overlay.getByTestId('ext-dialog-confirm').click()
  await expect.poll(() => installed(app, profileId)).toEqual([])
  await expect.poll(() => loaded(app, profileId)).toEqual([])
  await expect(page.getByTestId('ext-empty')).toBeVisible()
  await expect.poll(() => filesOf(userData, profileId)).toEqual([])
  await expect.poll(() => inContents(app, options, '1')).toBe('no page')
  expect(Object.values((await state(app)).tabs).filter((t) => t.url.startsWith('chrome-extension:'))).toEqual([])

  // Its data went with it: installed again (the same file, so the same ID), it counts from nothing.
  await install(app, profileId, packed)
  await run(app, 'extensions.openOptions', { id: packed.id, profileId })
  await expect.poll(() => inContents(app, options, visits)).toBe(0)
  await reload(app, tabId, '/page/ExtRemove')
  await expect.poll(() => mark(app, tabId, 'orbitTestExtension')).toBe(packed.id)
  await expect.poll(() => inContents(app, options, visits)).toBe(1)
})

test('[EX-07] Developer mode shows IDs and Load unpacked: a folder runs where it is, Reload reads it again, Remove leaves it', async () => {
  const { app, userData } = orbit
  const { profileId } = await current(app)
  const folder = join(scratch, 'unpacked')
  cpSync(FIXTURES.basic, folder, { recursive: true })
  const page = await openPage(app)
  await expect(page.getByTestId('ext-load-unpacked')).toHaveCount(0)
  await page.getByTestId('ext-dev-mode').click()
  await expect(page.getByTestId('ext-dev-mode')).toHaveAttribute('aria-checked', 'true')

  // Loaded without a confirmation: the developer chose the folder.
  await pickNext(app, folder)
  await page.getByTestId('ext-load-unpacked').click()
  const card = page.getByTestId('ext-card')
  await expect(card).toHaveCount(1)
  const id = (await card.getAttribute('data-id')) as string
  await expect(card.getByTestId('ext-dev-info')).toContainText(id)
  await expect(card.getByTestId('ext-dev-info')).toContainText(folder)
  await expect.poll(() => loaded(app, profileId)).toEqual([id])
  expect(filesOf(userData, profileId)).toEqual([])
  const tabId = await visit(app, 'ExtUnpacked')
  await expect.poll(() => mark(app, tabId, 'orbitTestExtension')).toBe(id)

  // Reload reads the folder again.
  const manifestPath = join(folder, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: '1.5' }))
  await card.getByTestId('ext-reload').click()
  await expect(card.getByTestId('ext-name')).toContainText('1.5')
  await expect.poll(() => loaded(app, profileId)).toEqual([id])

  // A folder that no longer loads says why, on its card; the extension stays listed.
  writeFileSync(manifestPath, '{ not json')
  await card.getByTestId('ext-reload').click()
  await expect(card.getByTestId('ext-error')).toBeVisible()
  await expect(card).toHaveAttribute('data-error', 'true')
  await expect.poll(() => loaded(app, profileId)).toEqual([])

  // Remove: Orbit forgets it; the developer's folder stays.
  await card.getByTestId('ext-remove').click()
  const overlay = await viewPage(app, 'overlay')
  await overlay.getByTestId('ext-dialog-confirm').click()
  await expect(page.getByTestId('ext-empty')).toBeVisible()
  expect(existsSync(manifestPath)).toBe(true)
})

test('[EX-09] A file Orbit can’t trust or read is refused with the reason, and nothing is installed', async () => {
  const { app, shell, userData } = orbit
  const { profileId } = await current(app)
  const good = pack(FIXTURES.basic)
  // Changed after it was signed.
  const tampered = Buffer.from(good.bytes)
  const at = tampered.length - 30
  tampered.writeUInt8(tampered.readUInt8(at) ^ 0xff, at)
  const path = join(scratch, 'tampered.crx')
  writeFileSync(path, tampered)
  await pickNext(app, path)
  const result = (await run(app, 'extensions.installFile', {})) as { ok: boolean; error?: string }
  expect(result.ok).toBe(false)
  await expect(shell.getByTestId('toast').filter({ hasText: 'Couldn’t add the extension.' })).toBeVisible()
  expect(await installed(app, profileId)).toEqual([])
  expect(filesOf(userData, profileId)).toEqual([])

  // A folder without a manifest, in Developer mode.
  await pickNext(app, scratch)
  const folder = (await run(app, 'extensions.loadUnpacked', {})) as { ok: boolean; error?: string }
  expect(folder).toEqual({ ok: false, error: 'The folder has no manifest.json.' })
  expect(await installed(app, profileId)).toEqual([])
})

test('[EX-09] Deleting a profile removes its extensions and their files', async () => {
  const { app, userData } = orbit
  // A profile no Space uses any more (one in use can't be deleted).
  const other = (await run(app, 'profiles.create', { name: 'Temp' })) as string
  const packed = pack(FIXTURES.basic)
  await install(app, other, packed)
  await expect.poll(() => loaded(app, other)).toEqual([packed.id])
  expect(filesOf(userData, other)).toEqual([packed.id])
  expect(await run(app, 'profiles.delete', { profileId: other })).toBe(true)
  await expect.poll(() => installed(app, other)).toEqual([])
  await expect.poll(() => existsSync(join(userData, 'Extensions', other))).toBe(false)
})

test('[EX] Isolation: content scripts never run in Orbit’s views or internal pages; an extension’s page gets nothing of Orbit’s; a crashing extension leaves the tab and main running', async () => {
  const { app, shell } = orbit
  const { profileId } = await current(app)
  const broad = pack(FIXTURES.broad, makeKey(), 'broad.crx')
  const basic = pack(FIXTURES.basic, makeKey(), 'basic.crx')
  await install(app, profileId, broad)
  await install(app, profileId, basic)

  // It runs on web pages (all of them)…
  const web = await visit(app, 'ExtIsolation')
  await expect.poll(() => mark(app, web, 'orbitBroadExtension')).toBe('http:')

  // …but not in an internal page, nor in Orbit's own views.
  const page = await openPage(app)
  await expect(page.getByTestId('ext-card')).toHaveCount(2)
  expect(await page.evaluate(() => document.documentElement.dataset.orbitBroadExtension ?? '')).toBe('')
  expect(await shell.evaluate(() => document.documentElement.dataset.orbitBroadExtension ?? '')).toBe('')
  const overlay = await viewPage(app, 'overlay')
  expect(await overlay.evaluate(() => document.documentElement.dataset.orbitBroadExtension ?? '')).toBe('')

  // An extension's own page has no Orbit bridge, and main doesn't take it for Orbit's UI.
  await run(app, 'extensions.openOptions', { id: basic.id, profileId })
  const options = `chrome-extension://${basic.id}/options.html`
  await expect.poll(() => inContents(app, options, 'document.documentElement.dataset.orbitBridge')).toBe('undefined')
  const isUi = await app.evaluate(({ webContents }, prefix) => {
    const hooks = (
      globalThis as unknown as { __orbit: { ctx: { windows: { isUi: (c: Electron.WebContents) => boolean } } } }
    ).__orbit
    const found = webContents.getAllWebContents().find((c) => c.getURL().startsWith(prefix))
    return found ? hooks.ctx.windows.isUi(found) : null
  }, options)
  expect(isUi).toBe(false)

  // Its process crashes (its pages and service worker): the web tab and main keep running.
  await app.evaluate(({ webContents }, prefix) => {
    webContents
      .getAllWebContents()
      .find((c) => c.getURL().startsWith(prefix))
      ?.forcefullyCrashRenderer()
  }, options)
  await expect.poll(() => mark(app, web, 'orbitBroadExtension')).toBe('http:')
  const tab = (await state(app)).tabs[web]
  expect(tab?.error).toBeUndefined()
  // It can be turned off and on again afterwards.
  expect(await run(app, 'extensions.setEnabled', { id: basic.id, enabled: false, profileId })).toBe(true)
  expect(await run(app, 'extensions.setEnabled', { id: basic.id, enabled: true, profileId })).toBe(true)
  await expect.poll(async () => (await loaded(app, profileId)).sort()).toEqual([broad.id, basic.id].sort())
  await reload(app, web, '/page/ExtIsolation')
  await expect.poll(() => mark(app, web, 'orbitTestExtension')).toBe(basic.id)
})
