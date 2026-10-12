import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import type { OrbitState } from '../../src/shared/state'
import { type CrxKey, crx, FIXTURES, folderFiles, makeKey, packFolder, zip } from '../fixtures/extensions/pack'
import {
  action,
  type Fixtures,
  launchOrbit,
  listenInRange,
  type Orbit,
  run,
  startFixtures,
  state,
  tabPage,
  viewPage,
} from './helpers'
import { newTab, waitTab } from './tabs-support'

/**
 * Chrome extensions (EX-*), with the fixture extensions only (tests/fixtures/extensions/), packed on
 * the spot: nothing here reaches the network or a store. The file picker is replaced in main, so no
 * dialog waits for a person. The extension store is a fixture server on this machine (`startStore`),
 * which each launch names (EX-01).
 */

/**
 * A store on this machine (EX-01): listing pages whose button calls the install API as the store's
 * own does, and the extensions' files.
 */
interface FixtureStore {
  origin: string
  /** The same server under another origin: not the store. */
  otherOrigin: string
  /** The file served for each ID. */
  files: Map<string, Buffer>
  /** The IDs whose files were asked for, in order. */
  downloads: string[]
  close: () => Promise<void>
}

/** A listing page: its button calls the API with what the store would send, a manifest of its own included. */
const LISTING = (id: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Listing ${id}</title></head>
<body style="font:16px system-ui;padding:40px">
<h1>A listing</h1>
<button id="add" style="font-size:20px;padding:12px 20px">Add</button>
<iframe id="frame" src="/frame" width="300" height="80"></iframe>
<script>
  const root = document.documentElement
  const api = window.chrome && window.chrome.webstorePrivate
  root.dataset.api = api ? Object.keys(api).join(',') : 'none'
  document.getElementById('add').addEventListener('click', () => {
    root.dataset.begin = 'waiting'
    const manifest = '{"name":"What the page says","version":"9","manifest_version":3,"permissions":["tabs"]}'
    api.beginInstallWithManifest3({ id: ${JSON.stringify(id)}, manifest }, (result) => {
      root.dataset.begin = result
      if (result === '') api.completeInstall(${JSON.stringify(id)}, () => { root.dataset.complete = 'done' })
    })
  })
</script></body></html>`

async function startStore(): Promise<FixtureStore> {
  const files = new Map<string, Buffer>()
  const downloads: string[] = []
  const html = (res: import('node:http').ServerResponse, body: string) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(body)
  }
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost')
    const listing = /^\/detail\/[^/]+\/([a-p]{32})$/.exec(u.pathname)
    const file = /^\/crx\/([a-p]{32})$/.exec(u.pathname)
    if (listing?.[1]) return html(res, LISTING(listing[1]))
    if (u.pathname === '/frame') {
      return html(
        res,
        '<!doctype html><html lang="en"><body><script>document.documentElement.dataset.api = window.chrome && window.chrome.webstorePrivate ? "yes" : "none"</script></body></html>',
      )
    }
    if (u.pathname === '/')
      return html(res, '<!doctype html><html lang="en"><title>Fixture store</title><h1>Store</h1></html>')
    if (file?.[1]) {
      downloads.push(file[1])
      const bytes = files.get(file[1])
      if (bytes) {
        res.writeHead(200, { 'content-type': 'application/x-chrome-extension' })
        res.end(bytes)
        return
      }
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  const port = await listenInRange(server, 3350)
  return {
    origin: `http://localhost:${port}`,
    otherOrigin: `http://127.0.0.1:${port}`,
    files,
    downloads,
    close: () => new Promise((r) => server.close(() => r())),
  }
}

let fx: Fixtures
let store: FixtureStore
let orbit: Orbit
let scratch: string

/** Points Orbit's store settings at the fixture store. */
const storeEnv = () => ({
  ORBIT_STORE_ORIGIN: store.origin,
  ORBIT_STORE_DOWNLOAD_URL: `${store.origin}/crx/{id}?prodversion={version}`,
})

test.beforeAll(async () => {
  fx = await startFixtures()
  store = await startStore()
})
test.afterAll(async () => {
  await fx.close()
  await store.close()
})
test.beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'orbit-ext-'))
  orbit = await launchOrbit({ env: storeEnv() })
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

  // Add extension: installed and running, "<name> added" with Pin.
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

  // The Pin button pins it, in this profile.
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

  // …but not in an internal page, nor in Orbit's own views: they are in the session no extension runs in.
  const views = await app.evaluate(({ session, webContents }) => {
    const hooks = (
      globalThis as unknown as { __orbit: { ctx: { windows: { isUi: (c: Electron.WebContents) => boolean } } } }
    ).__orbit
    const ui = webContents.getAllWebContents().filter((c) => !c.isDestroyed() && hooks.ctx.windows.isUi(c))
    return {
      count: ui.length,
      elsewhere: ui.filter((c) => c.session !== session.defaultSession).map((c) => c.getURL()),
      extensions: session.defaultSession.extensions.getAllExtensions().map((e) => e.id),
    }
  })
  expect(views.count).toBeGreaterThan(1)
  expect(views.elsewhere).toEqual([])
  expect(views.extensions).toEqual([])
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

// ---- The extension store (EX-01): a fixture store on this machine ----

/** Runs a command as window `windowId` would. */
const runIn = (app: ElectronApplication, windowId: string, name: string, args: unknown) =>
  app.evaluate(
    (_e, [w, n, a]) =>
      (globalThis as unknown as { __orbit: { run: (n: string, a: unknown, w?: string) => unknown } }).__orbit.run(
        n as string,
        a,
        w as string,
      ),
    [windowId, name, args] as const,
  )

/** Opens a store listing in a new tab (of window `windowId`, else the first) and gives its page. */
async function openListing(
  app: ElectronApplication,
  id: string,
  opts: { origin?: string; slug?: string; windowId?: string } = {},
): Promise<{ tabId: string; page: Page; url: string }> {
  const url = `${opts.origin ?? store.origin}/detail/${opts.slug ?? 'orbit-test'}/${id}`
  const tabId = opts.windowId
    ? ((await runIn(app, opts.windowId, 'tabs.create', { url, activate: true })) as string)
    : await newTab(app, url)
  await waitTab(app, tabId, `/detail/${opts.slug ?? 'orbit-test'}/${id}`)
  const page = await tabPage(app, url)
  await expect(page.locator('#add')).toBeVisible()
  return { tabId, page, url }
}

/** What the listing page's own script says (`data-<name>` on its root). */
const said = (page: Page, name: string) => page.evaluate((n) => document.documentElement.dataset[n] ?? '', name)

/** The extension installed in a profile, from the state. */
const entryOf = async (app: ElectronApplication, profileId: string, id: string) =>
  (await state(app)).extensions[`${profileId}:${id}`]

test('[EX-01][EX-02] The store’s own button adds an extension once Orbit’s dialog says yes, into the tab’s profile; only the ID crosses, and a script can’t press it', async () => {
  const { app, shell } = orbit
  const { profileId } = await current(app)
  const key = makeKey()
  store.files.set(key.id, packFolder(FIXTURES.basic, key).file)
  const { tabId, page, url } = await openListing(app, key.id)

  // The store's main frame has the two install calls and nothing else; its frames have none.
  await expect.poll(() => said(page, 'api')).toBe('beginInstallWithManifest3,completeInstall')
  await expect
    .poll(async () => {
      const frame = page.frames().find((f) => f.url().endsWith('/frame'))
      return frame ? frame.evaluate(() => document.documentElement.dataset.api ?? '') : ''
    })
    .toBe('none')

  // A script that calls it without a click on the page gets nothing, and Orbit downloads nothing. (A
  // page Orbit loads has the user's activation for a moment, so this one is the page's own reload.)
  await inContents(app, url, 'location.replace(location.pathname + "?again"), true')
  const again = `${url}?again`
  await expect.poll(() => inContents(app, again, 'document.readyState')).toBe('complete')
  expect(await inContents(app, again, 'navigator.userActivation.isActive')).toBe(false)
  const scripted = await inContents(
    app,
    again,
    `window.chrome.webstorePrivate.beginInstallWithManifest3({ id: ${JSON.stringify(key.id)} })`,
  )
  expect(scripted).toBe('user_gesture_required')
  expect(store.downloads).not.toContain(key.id)

  // The button: Orbit downloads the file and asks in its own dialog, naming what the file says, not
  // what the page sent. Cancel: nothing is added, and the page hears so.
  await page.locator('#add').click()
  const overlay = await viewPage(app, 'overlay')
  const dialog = overlay.getByTestId('ext-dialog')
  await expect(dialog).toHaveAttribute('data-kind', 'install')
  await expect(overlay.getByTestId('ext-dialog-title')).toHaveText(`Add “${NAME}”?`)
  await expect(overlay.getByTestId('ext-dialog-permissions')).toHaveText(
    'Read and change your data on localhost and 127.0.0.1',
  )
  expect(store.downloads.filter((id) => id === key.id)).toHaveLength(1)
  await overlay.getByTestId('ext-dialog-cancel').click()
  await expect.poll(() => said(page, 'begin')).toBe('user_cancelled')
  expect(await installed(app, profileId)).toEqual([])

  // Add extension: it's in the tab's profile, from the store, and running; the page's install completes.
  await page.locator('#add').click()
  await overlay.getByTestId('ext-dialog-confirm').click()
  await expect.poll(() => said(page, 'complete')).toBe('done')
  expect(await said(page, 'begin')).toBe('')
  expect(await installed(app, profileId)).toEqual([key.id])
  const entry = await entryOf(app, profileId, key.id)
  expect(entry?.source).toBe('store')
  expect(entry?.name).toBe(NAME)
  await expect(shell.getByTestId('toast').filter({ hasText: `${NAME} added` })).toBeVisible()
  await expect.poll(() => loaded(app, profileId)).toEqual([key.id])
  const web = await visit(app, 'FromStore')
  await expect.poll(() => mark(app, web, 'orbitTestExtension')).toBe(key.id)

  // Once it's in, the button says so without downloading it again.
  const before = store.downloads.length
  await page.locator('#add').click()
  await expect.poll(() => said(page, 'begin')).toBe('already_installed')
  expect(store.downloads.length).toBe(before)
  expect((await state(app)).tabs[tabId]?.profileId).toBe(profileId)
})

test('[EX-01] A store file that isn’t the one asked for, or isn’t signed right, is refused with the reason; pages of other origins and private windows add nothing', async () => {
  const { app, shell, userData } = orbit
  const { profileId } = await current(app)
  const toast = (text: string) => shell.getByTestId('toast').filter({ hasText: text })

  // Another extension's file under this ID.
  const asked = makeKey()
  store.files.set(asked.id, packFolder(FIXTURES.basic, makeKey()).file)
  const wrong = await openListing(app, asked.id)
  await wrong.page.locator('#add').click()
  await expect.poll(() => said(wrong.page, 'begin')).toBe('unknown_error')
  await expect(toast('Couldn’t add the extension. It isn’t the extension that was asked for.')).toBeVisible()

  // A file changed after it was signed.
  const changed = makeKey()
  const archive = zip(folderFiles(FIXTURES.basic))
  store.files.set(changed.id, crx(zip(folderFiles(FIXTURES.broad)), changed, { signedArchive: archive }))
  const tampered = await openListing(app, changed.id)
  await tampered.page.locator('#add').click()
  await expect.poll(() => said(tampered.page, 'begin')).toBe('unknown_error')
  await expect(toast('Its signature doesn’t match its contents.')).toBeVisible()

  // A file the store doesn't have.
  const missing = makeKey()
  const none = await openListing(app, missing.id)
  await none.page.locator('#add').click()
  await expect.poll(() => said(none.page, 'begin')).toBe('unknown_error')
  await expect(toast('The store didn’t send it (404).')).toBeVisible()
  expect(await installed(app, profileId)).toEqual([])
  expect(filesOf(userData, profileId)).toEqual([])

  // The same page under another origin isn't the store: no API.
  const good = makeKey()
  store.files.set(good.id, packFolder(FIXTURES.basic, good).file)
  const elsewhere = await openListing(app, good.id, { origin: store.otherOrigin, slug: 'elsewhere' })
  expect(await said(elsewhere.page, 'api')).toBe('none')

  // A private window's store page: refused before anything is downloaded.
  await action(app, 'window.newPrivate')
  let privateWindow = ''
  await expect
    .poll(async () => {
      privateWindow = Object.values((await state(app)).windows).find((w) => w.kind === 'private')?.id ?? ''
      return privateWindow
    })
    .not.toBe('')
  const before = store.downloads.length
  const hidden = await openListing(app, good.id, { slug: 'private', windowId: privateWindow })
  await hidden.page.locator('#add').click()
  await expect.poll(() => said(hidden.page, 'begin')).toBe('blocked_by_policy')
  expect(store.downloads.length).toBe(before)
  expect(Object.keys((await state(app)).extensions)).toEqual([])
})

test('[EX-01] Add to Orbit in a listing’s site controls; Add Extension opens the store', async () => {
  const { app, shell } = orbit
  const { profileId } = await current(app)
  const key = makeKey()
  store.files.set(key.id, packFolder(FIXTURES.basic, key).file)
  await openListing(app, key.id, { slug: 'panel' })
  const overlay = await viewPage(app, 'overlay')

  await run(app, 'site.openControls', {})
  const row = overlay.getByTestId('ext-store-row')
  await expect(row).toHaveAttribute('data-state', 'new')
  await overlay.getByTestId('ext-store-add').click()
  await expect(overlay.getByTestId('ext-dialog-title')).toHaveText(`Add “${NAME}”?`)
  await overlay.getByTestId('ext-dialog-confirm').click()
  await expect.poll(() => installed(app, profileId)).toEqual([key.id])
  expect((await entryOf(app, profileId, key.id))?.source).toBe('store')
  await expect(shell.getByTestId('toast').filter({ hasText: `${NAME} added` })).toBeVisible()

  // Once it's in, the row names it and offers nothing to add.
  await run(app, 'site.openControls', {})
  await expect(row).toHaveAttribute('data-state', 'added')
  await expect(row).toContainText(NAME)
  await expect(overlay.getByTestId('ext-store-add')).toHaveCount(0)
  await overlay.keyboard.press('Escape')

  // Any other page has no store row.
  await visit(app, 'NotAListing')
  await run(app, 'site.openControls', {})
  await expect(overlay.getByTestId('site-controls')).toBeVisible()
  await expect(overlay.getByTestId('ext-store')).toHaveCount(0)
  await overlay.keyboard.press('Escape')

  // Add Extension (the command bar's, the menu's): the store, in a new tab.
  await action(app, 'extension.add')
  await expect
    .poll(async () => {
      const s = await state(app)
      const win = Object.values(s.windows)[0]
      const active = win ? win.activeTab[win.spaceId] : undefined
      return active ? s.tabs[active]?.url : ''
    })
    .toBe(`${store.origin}/`)
})

test('[EX-01] Without a store a test names, Orbit makes no store request: no API, no Add to Orbit, and Add Extension says so', async () => {
  await orbit.app.close()
  orbit = await launchOrbit()
  const { app, shell } = orbit
  const key = makeKey()
  store.files.set(key.id, packFolder(FIXTURES.basic, key).file)
  const before = store.downloads.length
  const { page } = await openListing(app, key.id, { slug: 'off' })
  expect(await said(page, 'api')).toBe('none')
  const overlay = await viewPage(app, 'overlay')
  await run(app, 'site.openControls', {})
  await expect(overlay.getByTestId('site-controls')).toBeVisible()
  await expect(overlay.getByTestId('ext-store')).toHaveCount(0)
  await overlay.keyboard.press('Escape')
  const tabs = Object.keys((await state(app)).tabs).length
  await action(app, 'extension.add')
  await expect(shell.getByTestId('toast').filter({ hasText: 'doesn’t open the extension store' })).toBeVisible()
  expect(Object.keys((await state(app)).tabs).length).toBe(tabs)
  expect(store.downloads.length).toBe(before)
})
