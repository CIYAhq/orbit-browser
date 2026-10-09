import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ElectronApplication, expect, test } from '@playwright/test'
import type { OrbitState } from '../../src/shared/state'
import { action, isMac, launchOrbit, MOD, type Orbit, state } from './helpers'
import {
  closeWindow,
  cmd,
  cmdIn,
  flushState,
  type NavFixtures,
  openTab,
  pressInPage,
  startNavFixtures,
  uiPageOf,
  waitLoaded,
  windowList,
  zoomOf,
} from './nav-support'

/** New windows (NV-10) and private windows (NV-11, SB-25, AP-05). */

let fx: NavFixtures
let orbit: Orbit

test.beforeAll(async () => {
  fx = await startNavFixtures()
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

const page = (title: string) => fx.url(`/page/${title}`)
/** ⌘ on macOS, Ctrl elsewhere. */
const mod = isMac ? 'meta' : 'control'

type WindowInfo = Awaited<ReturnType<typeof windowList>>[number]

/** Opens a private window from the first window (⌘⇧N there) and returns it. */
async function openPrivate(app: ElectronApplication): Promise<WindowInfo> {
  const before = new Set((await windowList(app)).map((w) => w.id))
  await action(app, 'window.newPrivate')
  await expect.poll(async () => (await windowList(app)).filter((w) => !before.has(w.id)).length).toBe(1)
  const win = (await windowList(app)).find((w) => !before.has(w.id))
  if (!win) throw new Error('no private window')
  expect(win.kind).toBe('private')
  return win
}

/** Opens a page in a new tab of the given window and waits until it has loaded. */
async function openTabIn(app: ElectronApplication, windowId: string, url: string): Promise<string> {
  const id = await cmdIn<string>(app, windowId, 'tabs.create', { url })
  await waitLoaded(app, id, url)
  return id
}

/** Runs a script in the page with this exact address in a private (or else a normal) session. */
function inSession<T>(app: ElectronApplication, url: string, persistent: boolean, code: string): Promise<T> {
  return app.evaluate(
    async ({ webContents }, [u, keep, js]) => {
      const contents = webContents
        .getAllWebContents()
        .find((w) => w.getURL() === u && w.session.isPersistent() === keep)
      if (!contents) throw new Error(`no page ${u}`)
      return await contents.executeJavaScript(js)
    },
    [url, persistent, code] as const,
  ) as Promise<T>
}

const privateLeft = (s: OrbitState) => ({
  profiles: Object.keys(s.profiles).filter((id) => id.startsWith('private-')),
  spaces: Object.values(s.spaces).filter((sp) => sp.profileId.startsWith('private-')).length,
  tabs: Object.values(s.tabs).filter((t) => t.profileId.startsWith('private-')).length,
  windows: Object.values(s.windows).filter((w) => w.kind === 'private').length,
})
const NOTHING_PRIVATE = { profiles: [], spaces: 0, tabs: 0, windows: 0 }

/** Every file under `dir` whose bytes contain `text` (as UTF-8 or UTF-16, as Chromium stores some strings). */
function filesContaining(dir: string, text: string): string[] {
  const needles = [Buffer.from(text, 'utf8'), Buffer.from(text, 'utf16le')]
  const found: string[] = []
  const visit = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) {
        let bytes: Buffer
        try {
          bytes = readFileSync(path)
        } catch {
          continue
        }
        if (needles.some((n) => bytes.includes(n))) found.push(path)
      }
    }
  }
  visit(dir)
  return found
}

const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '')
const readDir = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .map((f) => read(join(dir, f)))
        .join('\n')
    : ''

test('[NV-10] ⌘N (Ctrl+N) opens another window with the same pinned tabs, a step down and right', async () => {
  const { app, shell } = orbit
  const pinned = await openTab(app, page('Kept'))
  await cmd(app, 'tabs.pin', { tabId: pinned })
  await shell.keyboard.press(`${MOD}+N`)
  await expect.poll(async () => (await windowList(app)).length).toBe(2)
  const [first, second] = await windowList(app)
  if (!first || !second) throw new Error('no second window')
  expect(second.kind).toBe('main')
  const sidebar = await uiPageOf(app, 'shell', second.id)
  await expect(sidebar.locator(`[data-testid="tab-row"][data-tab-id="${pinned}"]`)).toBeVisible()
  expect([second.bounds?.x, second.bounds?.y]).not.toEqual([first.bounds?.x, first.bounds?.y])
})

test('[NV-11][SB-25][AP-05] ⌘⇧N (Ctrl+Shift+N) opens a private window: dark, labelled Private, with only its own tabs', async () => {
  const { app, shell } = orbit
  const pinned = await openTab(app, page('Mine'))
  await cmd(app, 'tabs.pin', { tabId: pinned })
  const normal = await openTab(app, page('Ours'))
  await shell.keyboard.press(`${MOD}+Shift+N`)
  await expect.poll(async () => (await windowList(app)).map((w) => w.kind)).toEqual(['main', 'private'])
  const priv = (await windowList(app))[1] as WindowInfo
  const sidebar = await uiPageOf(app, 'shell', priv.id)
  const label = sidebar.getByTestId('private-label')
  await expect(label).toContainText('Private')
  // Plain about what it hides and what it doesn't.
  await expect(label).toContainText('not from websites or your network')
  // Near-black, whatever the theme.
  await expect
    .poll(() =>
      sidebar.evaluate(() =>
        getComputedStyle(document.querySelector('[data-testid="sidebar"]') as Element)
          .getPropertyValue('--frame-top')
          .trim(),
      ),
    )
    .toMatch(/^(#141417|rgb\(20, 20, 23\))$/)
  // No Spaces, pinned tabs or Favorites; its Space isn't one of the user's.
  await expect(sidebar.getByTestId('spacebar')).toHaveCount(0)
  await expect(sidebar.getByTestId('space-strip')).toHaveCount(0)
  await expect(sidebar.locator(`[data-tab-id="${pinned}"]`)).toHaveCount(0)
  await expect(sidebar.locator(`[data-tab-id="${normal}"]`)).toHaveCount(0)
  expect((await state(app)).spaceOrder).not.toContain(priv.spaceId)
  // It starts with the command bar open for a first tab, which opens there.
  await expect.poll(async () => (await state(app)).windows[priv.id]?.overlay.kind).toBe('commandbar')
  const overlay = await uiPageOf(app, 'overlay', priv.id)
  const input = overlay.getByTestId('command-input')
  const secret = fx.urlOn('127.0.0.1', '/page/Hidden')
  await input.fill(secret)
  await expect(overlay.getByTestId('command-result').filter({ hasText: '127.0.0.1' }).first()).toBeVisible()
  await input.press('Enter')
  await expect
    .poll(async () => {
      const s = await state(app)
      const shown = s.windows[priv.id]?.activeTab[priv.spaceId]
      return shown ? s.tabs[shown]?.url : undefined
    })
    .toBe(secret)
  const s = await state(app)
  const tabId = s.windows[priv.id]?.activeTab[priv.spaceId] as string
  expect(s.tabs[tabId]?.profileId).toMatch(/^private-/)
  await expect(sidebar.locator(`[data-testid="tab-row"][data-tab-id="${tabId}"]`)).toBeVisible()
  // The normal window doesn't list it, can't show it, and its command bar doesn't offer it.
  await expect(shell.locator(`[data-tab-id="${tabId}"]`)).toHaveCount(0)
  await cmd(app, 'tabs.activate', { tabId })
  const first = (await windowList(app))[0] as WindowInfo
  expect((await state(app)).windows[first.id]?.activeTab[first.spaceId]).not.toBe(tabId)
  const found = await cmd<{ results: { url?: string }[] }>(app, 'search.query', { query: 'Hidden', mode: 'new-tab' })
  expect(found.results.filter((r) => r.url === secret)).toEqual([])
  // Nor does the private window's command bar offer the normal window's tabs or history.
  const there = await cmdIn<{ results: { url?: string }[] }>(app, priv.id, 'search.query', {
    query: 'Ours',
    mode: 'new-tab',
  })
  expect(there.results.filter((r) => r.url === page('Ours'))).toEqual([])
  // Pinning and other Spaces aren't there.
  await app.evaluate(
    async (_e, [w, t]) => {
      const g = globalThis as unknown as { __orbit: { run: (n: string, a: unknown, w?: string) => Promise<unknown> } }
      await g.__orbit.run('tabs.activate', { tabId: t }, w)
    },
    [priv.id, tabId] as const,
  )
  await app.evaluate(async (_e, w) => {
    const g = globalThis as unknown as { __orbit: { action: (id: string, w?: string) => Promise<void> } }
    await g.__orbit.action('tab.togglePin', w)
  }, priv.id)
  expect((await state(app)).spaces[priv.spaceId]?.pinned).toEqual([])
})

test('[NV-11] private windows share one session while any is open; it is wiped when the last one closes', async () => {
  const { app } = orbit
  const site = fx.urlOn('127.0.0.1', '/page/Jar')
  const normal = await openTab(app, site)
  const a = await openPrivate(app)
  await openTabIn(app, a.id, site)
  await inSession(app, site, false, `document.cookie = 'jar=private; path=/'; localStorage.setItem('jar', 'private')`)
  // The normal window's copy of the site sees none of it.
  expect(await inSession(app, site, true, 'document.cookie')).toBe('')
  expect(await inSession(app, site, true, `localStorage.getItem('jar')`)).toBeNull()
  // A second private window shares the first one's session.
  const b = await openPrivate(app)
  expect(b.spaceId).not.toBe(a.spaceId)
  const second = await openTabIn(app, b.id, fx.urlOn('127.0.0.1', '/page/Jar2'))
  expect(await inSession(app, fx.urlOn('127.0.0.1', '/page/Jar2'), false, 'document.cookie')).toBe('jar=private')
  // Closing one keeps the session; closing the last forgets everything.
  await closeWindow(app, a.id)
  await expect.poll(async () => (await windowList(app)).length).toBe(2)
  expect((await state(app)).tabs[second]).toBeDefined()
  expect(await inSession(app, fx.urlOn('127.0.0.1', '/page/Jar2'), false, 'document.cookie')).toBe('jar=private')
  await closeWindow(app, b.id)
  await expect.poll(async () => privateLeft(await state(app))).toEqual(NOTHING_PRIVATE)
  expect((await state(app)).tabs[normal]).toBeDefined()
  // Reopen Closed Tab doesn't bring a private tab back into a normal window.
  await action(app, 'tab.reopenClosed')
  expect(privateLeft(await state(app))).toEqual(NOTHING_PRIVATE)
  // The next private window starts with nothing.
  const c = await openPrivate(app)
  await openTabIn(app, c.id, fx.urlOn('127.0.0.1', '/page/Jar3'))
  expect(await inSession(app, fx.urlOn('127.0.0.1', '/page/Jar3'), false, 'document.cookie')).toBe('')
  expect(await inSession(app, fx.urlOn('127.0.0.1', '/page/Jar3'), false, `localStorage.getItem('jar')`)).toBeNull()
})

test('[NV-11] nothing of a private window reaches the disk: no state, history, favicon cache or site choices', async () => {
  const { app, userData } = orbit
  const token = `Secret${Date.now().toString(36)}`
  /** What a normal page stores the same way: the search below must find it (it can see the engine's files). */
  const control = `Kept${Date.now().toString(36)}`
  const secret = fx.urlOn('127.0.0.1', `/page/${token}`)
  const priv = await openPrivate(app)
  await openTabIn(app, priv.id, secret)
  // A site choice (zoom), a cookie and site data.
  await pressInPage(app, secret, '=', [mod])
  await expect.poll(() => zoomOf(app, secret)).toBeCloseTo(1.1)
  await inSession(
    app,
    secret,
    false,
    `document.cookie = '${token}=1; path=/; max-age=3600'; localStorage.setItem('${token}', '1')`,
  )
  // While it's open, the state file has none of it.
  await flushState(app)
  const saved = read(join(userData, 'orbit-state.json'))
  expect(saved).toContain('"spaceOrder"')
  expect(saved).not.toContain(token)
  expect(saved).not.toContain('private-')
  // A normal page meanwhile, so each store has something to write.
  await openTab(app, page('Plain'))
  await inSession(
    app,
    page('Plain'),
    true,
    `document.cookie = '${control}=1; path=/; max-age=3600'; localStorage.setItem('${control}', '1')`,
  )
  await pressInPage(app, page('Plain'), '=', [mod])
  await expect.poll(() => zoomOf(app, page('Plain'))).toBeCloseTo(1.1)
  await expect.poll(() => read(join(userData, 'orbit-favicons.json'))).toContain(`http://localhost:${fx.port}`)
  await closeWindow(app, priv.id)
  await expect.poll(async () => privateLeft(await state(app))).toEqual(NOTHING_PRIVATE)
  await orbit.app.close()

  // What Orbit keeps has the normal page and not the private one…
  expect(readDir(join(userData, 'history'))).toContain(page('Plain'))
  expect(read(join(userData, 'orbit-site-prefs.json'))).toContain('localhost')
  // …and no file at all (Orbit's or the engine's) names the private page or its site, while the
  // normal page's cookie and site data are in the engine's files.
  expect(filesContaining(userData, control).length).toBeGreaterThan(0)
  expect(filesContaining(userData, token)).toEqual([])
  expect(filesContaining(userData, '127.0.0.1')).toEqual([])
  expect(existsSync(join(userData, 'Partitions'))).toBe(true)
  expect(readdirSync(join(userData, 'Partitions')).filter((p) => p.includes('private'))).toEqual([])

  // Back in Orbit, the command bar and history don't know it.
  orbit = await launchOrbit({ userData })
  expect(privateLeft(await state(orbit.app))).toEqual(NOTHING_PRIVATE)
  const found = await cmd<{ results: { url?: string }[] }>(orbit.app, 'search.query', { query: token, mode: 'new-tab' })
  expect(found.results.filter((r) => r.url?.includes(`/page/${token}`))).toEqual([])
})
