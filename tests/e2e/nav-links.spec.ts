import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, test } from '@playwright/test'
import type { SplitLayout } from '../../src/shared/state'
import { isMac, launchOrbit, type Orbit, state, tabPage } from './helpers'
import {
  blockedMenu,
  chooseBlocked,
  choosePageMenu,
  clickInPage,
  cmd,
  foreignWindowTitles,
  type NavFixtures,
  openTab,
  pageMenu,
  startNavFixtures,
  visit,
  waitLoaded,
  windowList,
  windowState,
} from './nav-support'

/** Clicking links and the windows pages open (NV-08, NV-09), and the page's context menu (NV-12). */

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

const leaves = (layout: SplitLayout): string[] =>
  layout.type === 'leaf' ? [layout.tabId] : layout.children.flatMap(leaves)

/** The tabs of the split view showing `tabId`, in order; empty when it isn't in one. */
async function splitTabs(app: ElectronApplication, tabId: string): Promise<string[]> {
  for (const split of Object.values((await state(app)).splits)) {
    const ids = leaves(split.layout)
    if (ids.includes(tabId)) return ids
  }
  return []
}

/** The first window's Today tabs, top first. */
async function today(app: ElectronApplication): Promise<string[]> {
  const win = await windowState(app)
  return [...((await state(app)).spaces[win.spaceId]?.today ?? [])]
}

async function selectedTab(app: ElectronApplication): Promise<string | undefined> {
  const win = await windowState(app)
  return win.activeTab[win.spaceId] ?? undefined
}

const urlOf = async (app: ElectronApplication, tabId: string | undefined) =>
  tabId ? (await state(app)).tabs[tabId]?.url : undefined

/** The pages of the open Mini Windows, oldest first. */
async function miniUrls(app: ElectronApplication): Promise<(string | null)[]> {
  const s = await state(app)
  return Object.values(s.windows)
    .filter((w) => w.kind === 'mini')
    .map((w) => {
      const id = w.activeTab[w.spaceId]
      return id ? (s.tabs[id]?.url ?? null) : null
    })
}

type Download = { url: string; cancelled: boolean }

/**
 * Records the downloads of a page's session from now on: the address, and whether Orbit cancelled
 * it. One that goes ahead is saved in a temporary folder instead of asking where.
 */
async function watchDownloads(app: ElectronApplication, pageUrl: string): Promise<() => Promise<Download[]>> {
  const folder = mkdtempSync(join(tmpdir(), 'orbit-e2e-downloads-'))
  await app.evaluate(
    ({ webContents }, [url, dir]) => {
      const g = globalThis as unknown as { __downloads: Download[] }
      g.__downloads = []
      const contents = webContents.getAllWebContents().find((w) => w.getURL() === url)
      if (!contents) throw new Error(`no page ${url}`)
      // Added after Orbit's own listener, so it sees what Orbit decided.
      contents.session.on('will-download', (event, item) => {
        g.__downloads.push({ url: item.getURL(), cancelled: event.defaultPrevented })
        if (!event.defaultPrevented) item.setSavePath(`${dir}/${item.getFilename()}`)
      })
    },
    [pageUrl, folder] as const,
  )
  return () => app.evaluate(() => (globalThis as unknown as { __downloads: Download[] }).__downloads)
}

/** Title of the page with this exact address, once it has loaded. */
const loadedTitle = (app: ElectronApplication, url: string) =>
  app.evaluate(({ webContents }, u) => {
    const contents = webContents.getAllWebContents().find((w) => w.getURL() === u)
    return contents && !contents.isLoading() ? contents.getTitle() : null
  }, url)

/** `labels` without the items not in `wanted`: checks those come in this order. */
const inOrder = (labels: string[] | undefined, wanted: string[]) => (labels ?? []).filter((l) => wanted.includes(l))

test('[NV-08] ⌘-click (Ctrl-click) opens the link in a background tab at the top of Today', async () => {
  const { app } = orbit
  const opener = await openTab(app, page('Behind'))
  const before = await today(app)
  await clickInPage(app, page('Behind'), '#next', [mod])
  await expect.poll(async () => (await today(app)).length).toBe(before.length + 1)
  expect(await urlOf(app, (await today(app))[0])).toBe(page('Behind-next'))
  expect(await selectedTab(app)).toBe(opener)
})

test('[NV-08] ⇧⌘-click (Ctrl+Shift-click) opens the link in a new tab at the top of Today and selects it', async () => {
  const { app } = orbit
  const opener = await openTab(app, page('Front'))
  await clickInPage(app, page('Front'), '#next', [mod, 'shift'])
  await expect.poll(async () => urlOf(app, (await today(app))[0])).toBe(page('Front-next'))
  const [id] = await today(app)
  await expect.poll(() => selectedTab(app)).toBe(id)
  await waitLoaded(app, id as string, page('Front-next'))
  expect(await urlOf(app, opener)).toBe(page('Front'))
})

test('[NV-08] ⇧-click opens the link in a new window, a step down and right, when Peek doesn’t take it', async () => {
  const { app } = orbit
  // ⇧-click shows Peek unless that's turned off in Settings (peek.md); then it opens a new window.
  await app.evaluate(() => {
    const g = globalThis as unknown as {
      __orbit: { ctx: { store: { update: (f: (d: { settings: Record<string, unknown> }) => void) => void } } }
    }
    g.__orbit.ctx.store.update((d) => {
      d.settings.peekShiftClick = false
    })
  })
  const opener = await openTab(app, page('Shifted'))
  await clickInPage(app, page('Shifted'), '#next', ['shift'])
  await expect.poll(async () => (await windowList(app)).length).toBe(2)
  const [first, second] = await windowList(app)
  if (!first || !second) throw new Error('no second window')
  expect(second.kind).toBe('main')
  expect(second.spaceId).toBe(first.spaceId)
  const s = await state(app)
  const shown = s.windows[second.id]?.activeTab[second.spaceId]
  expect(await urlOf(app, shown ?? undefined)).toBe(page('Shifted-next'))
  // The first window still shows the page with the link, and no Peek took the click.
  expect(s.windows[first.id]?.activeTab[first.spaceId]).toBe(opener)
  expect(s.windows[first.id]?.overlay.kind).toBe('none')
  expect(Object.values(s.tabs).filter((t) => t.floating)).toHaveLength(0)
  expect([second.bounds?.x, second.bounds?.y]).not.toEqual([first.bounds?.x, first.bounds?.y])
})

test('[NV-08][MW-07] ⌥-click opens split view and ⌘⌥-click (Ctrl+Alt-click) a Mini Window: neither takes the other’s click', async () => {
  const { app } = orbit
  const id = await openTab(app, page('Both'))
  const downloads = await watchDownloads(app, page('Both'))
  // ⌘⌥-click: the link in a Mini Window; no split view, no download.
  await clickInPage(app, page('Both'), '#next', [mod, 'alt'])
  await expect.poll(() => miniUrls(app)).toEqual([page('Both-next')])
  expect(await splitTabs(app, id)).toEqual([])
  expect(await urlOf(app, id)).toBe(page('Both'))
  // ⌥-click: split view beside the page; no second Mini Window.
  await clickInPage(app, page('Both'), '#next', ['alt'])
  await expect.poll(() => splitTabs(app, id)).toHaveLength(2)
  const [, right] = await splitTabs(app, id)
  await waitLoaded(app, right as string, page('Both-next'))
  expect(await miniUrls(app)).toEqual([page('Both-next')])
  // Only the ⌥-click's own download began, and Orbit cancelled it.
  await expect.poll(downloads, { timeout: 10_000 }).toEqual([{ url: page('Both-next'), cancelled: true }])
})

test('[SV-09][MW-07] on sidebar rows too: ⌥-click splits with the current tab, ⌘⌥-click (Ctrl+Alt-click) opens a Mini Window', async () => {
  const { app, shell } = orbit
  const current = await openTab(app, page('RowA'))
  const other = await openTab(app, page('RowB'))
  const third = await openTab(app, page('RowC'))
  await cmd(app, 'tabs.activate', { tabId: current })
  await expect.poll(() => selectedTab(app)).toBe(current)
  const row = (id: string) => shell.locator(`[data-testid="tab-row"][data-tab-id="${id}"]`)
  await row(other).click({ modifiers: ['Alt'] })
  await expect.poll(() => splitTabs(app, current)).toEqual([current, other])
  expect(await miniUrls(app)).toEqual([])
  await row(third).click({ modifiers: [isMac ? 'Meta' : 'Control', 'Alt'] })
  await expect.poll(() => miniUrls(app)).toEqual([page('RowC')])
  expect((await state(app)).tabs[third]?.floating).toBe('mini')
  expect(await splitTabs(app, current)).toEqual([current, other])
})

test('[NV-08][SV-08] ⌥-click (Alt-click) opens the link in split view beside the page instead of downloading it', async () => {
  const { app, shell } = orbit
  const id = await openTab(app, page('Alted'))
  const downloads = await watchDownloads(app, page('Alted'))
  await clickInPage(app, page('Alted'), '#next', ['alt'])
  await expect.poll(() => splitTabs(app, id)).toHaveLength(2)
  const [left, right] = await splitTabs(app, id)
  expect(left).toBe(id)
  await waitLoaded(app, right as string, page('Alted-next'))
  await expect(shell.getByTestId('split-pane')).toHaveCount(2)
  // The engine's own download of the link comes a moment later, and is cancelled.
  await expect.poll(downloads, { timeout: 10_000 }).toEqual([{ url: page('Alted-next'), cancelled: true }])
  expect(await urlOf(app, id)).toBe(page('Alted'))
})

test('[NV-09] a target=_blank link opens a new tab at the top of Today and selects it', async () => {
  const { app } = orbit
  const opener = await openTab(app, page('Blank'))
  await clickInPage(app, page('Blank'), '#child')
  await expect.poll(async () => urlOf(app, (await today(app))[0])).toBe(page('Blank-child'))
  const [id] = await today(app)
  await expect.poll(() => selectedTab(app)).toBe(id)
  // Orbit remembers where it came from (TB-19: Back with no history goes back there).
  expect((await state(app)).tabs[id as string]?.openerTabId).toBe(opener)
})

test('[NV-09] a page’s pop-up (window.open with a size) is a small window of its own, titled with the site, that the page can close', async () => {
  const { app } = orbit
  await openTab(app, page('Opener'))
  const tabs = Object.keys((await state(app)).tabs).length
  await clickInPage(app, page('Opener'), '#popup')
  const host = `localhost:${fx.port}`
  await expect.poll(() => foreignWindowTitles(app)).toEqual([host])
  // The page calls itself "Popup-Opener"; the window keeps showing where it is.
  await expect.poll(() => loadedTitle(app, page('Popup-Opener'))).toBe('Popup-Opener')
  expect(await foreignWindowTitles(app)).toEqual([host])
  // Not a tab, nor an Orbit window with a sidebar.
  expect(Object.keys((await state(app)).tabs)).toHaveLength(tabs)
  expect(await windowList(app)).toHaveLength(1)
  await clickInPage(app, page('Opener'), '#closepopup')
  await expect.poll(() => foreignWindowTitles(app)).toEqual([])
})

test('[NV-09] a pop-up opened without a click is blocked and offered in the address display; Always Allow lets the site open them', async () => {
  const { app, shell } = orbit
  const url = fx.url('/page/Eager?open=/page/Surprise')
  const id = await openTab(app, url)
  const indicator = shell.getByTestId('popups-blocked')
  await expect(indicator).toBeVisible()
  expect(await foreignWindowTitles(app)).toEqual([])
  const host = `localhost:${fx.port}`
  await indicator.click()
  await expect
    .poll(() => blockedMenu(app))
    .toEqual([`[Pop-ups blocked on ${host}]`, `Open ${page('Surprise')}`, `Always Allow Pop-ups from ${host}`])
  // Opened from there, it's a tab.
  expect(await chooseBlocked(app, `Open ${page('Surprise')}`)).toBe(true)
  await expect.poll(async () => urlOf(app, await selectedTab(app))).toBe(page('Surprise'))
  await expect(indicator).toBeHidden()

  // Back on the page, loading it again blocks it again; this time the site is allowed.
  await cmd(app, 'tabs.activate', { tabId: id })
  await visit(app, id, url)
  await expect(indicator).toBeVisible()
  await indicator.click()
  await expect.poll(() => blockedMenu(app)).toContain(`Always Allow Pop-ups from ${host}`)
  expect(await chooseBlocked(app, `Always Allow Pop-ups from ${host}`)).toBe(true)
  await expect(indicator).toBeHidden()
  await visit(app, id, url)
  await expect.poll(() => foreignWindowTitles(app)).toEqual([host])
  await expect(indicator).toBeHidden()
})

test('[NV-09] a link that downloads in a new tab leaves no tab behind', async () => {
  const { app } = orbit
  const opener = await openTab(app, page('Files'))
  const downloads = await watchDownloads(app, page('Files'))
  const before = await today(app)
  await clickInPage(app, page('Files'), '#download')
  await expect.poll(downloads).toEqual([{ url: fx.url('/download/Files.txt'), cancelled: false }])
  await expect.poll(() => today(app)).toEqual(before)
  expect(await selectedTab(app)).toBe(opener)
  // Nothing to bring back either.
  expect((await state(app)).archive).toEqual([])
})

test('[NV-12] right-clicking a link offers new tab, split view, Peek, Mini Window, new and private windows, copy and save; Split View shows two panes', async () => {
  const { app, shell } = orbit
  const id = await openTab(app, page('Menu'))
  await clickInPage(app, page('Menu'), '#next', [], 'right')
  await expect.poll(async () => (await pageMenu(app))?.tabId).toBe(id)
  const labels = (await pageMenu(app))?.labels
  const link = [
    'Open Link in New Tab',
    'Open Link in Split View',
    'Open Link in Peek',
    'Open Link in Mini Window',
    'Open Link in New Window',
    'Open Link in Private Window',
    'Copy Link Address',
    'Save Link As…',
  ]
  expect(inOrder(labels, link)).toEqual(link)
  expect(labels?.[0]).toBe('Open Link in New Tab')
  expect(labels?.at(-1)).toBe('Inspect')
  // Nothing for the page itself when a link was clicked.
  expect(labels).not.toContain('View Page Source')
  expect(await choosePageMenu(app, 'Open Link in Split View')).toBe(true)
  await expect.poll(() => splitTabs(app, id)).toHaveLength(2)
  await expect(shell.getByTestId('split-pane')).toHaveCount(2)
})

test('[NV-12] right-clicking the page offers Back, Forward, Reload, Save Page As, Print and View Page Source', async () => {
  const { app } = orbit
  const id = await openTab(app, page('Plain'))
  await visit(app, id, page('Plain-next'))
  await clickInPage(app, page('Plain-next'), '#title', [], 'right')
  await expect.poll(async () => (await pageMenu(app))?.tabId).toBe(id)
  const menu = await pageMenu(app)
  const wanted = ['Back', 'Forward', 'Reload', 'Save Page As…', 'Print…', 'View Page Source', 'Inspect']
  expect(inOrder(menu?.labels, wanted)).toEqual(wanted)
  expect(menu?.labels.at(-1)).toBe('Inspect')
  expect(menu?.enabled.Back).toBe(true)
  expect(menu?.enabled.Forward).toBe(false)
  expect(menu?.labels).not.toContain('Open Link in New Tab')
  // View Page Source opens the source in a new tab, which keeps its view-source: address once loaded.
  const source = `view-source:${page('Plain-next')}`
  expect(await choosePageMenu(app, 'View Page Source')).toBe(true)
  await expect.poll(async () => urlOf(app, await selectedTab(app))).toBe(source)
  await expect
    .poll(() =>
      app.evaluate(
        ({ webContents }, url) => webContents.getAllWebContents().some((w) => w.getURL() === url && !w.isLoading()),
        source,
      ),
    )
    .toBe(true)
  expect(await urlOf(app, await selectedTab(app))).toBe(source)
})

test('[NV-12] right-clicking a text field offers the editing items and Writing Direction', async () => {
  const { app } = orbit
  await openTab(app, page('Field'))
  await clickInPage(app, page('Field'), '#box', [], 'right')
  await expect.poll(async () => (await pageMenu(app))?.labels ?? []).toContain('Writing Direction')
  const wanted = [
    'role:undo',
    'role:redo',
    'role:cut',
    'role:copy',
    'role:paste',
    'role:pasteAndMatchStyle',
    'role:selectAll',
    'Writing Direction',
    'Inspect',
  ]
  expect(inOrder((await pageMenu(app))?.labels, wanted)).toEqual(wanted)
  expect(await choosePageMenu(app, 'Writing Direction > Right to Left')).toBe(true)
  const tab = await tabPage(app, page('Field'))
  await expect.poll(() => tab.evaluate(() => document.querySelector('#box')?.getAttribute('dir'))).toBe('rtl')
})

test('[NV-12] Open Link in New Window and in Private Window', async () => {
  const { app } = orbit
  await openTab(app, page('Links'))
  await clickInPage(app, page('Links'), '#next', [], 'right')
  await expect.poll(async () => (await pageMenu(app))?.labels ?? []).toContain('Open Link in New Window')
  expect(await choosePageMenu(app, 'Open Link in New Window')).toBe(true)
  await expect.poll(async () => (await windowList(app)).map((w) => w.kind)).toEqual(['main', 'main'])
  await clickInPage(app, page('Links'), '#next', [], 'right')
  await expect.poll(async () => (await pageMenu(app))?.labels ?? []).toContain('Open Link in Private Window')
  expect(await choosePageMenu(app, 'Open Link in Private Window')).toBe(true)
  await expect.poll(async () => (await windowList(app)).map((w) => w.kind)).toEqual(['main', 'main', 'private'])
  const s = await state(app)
  const [second, third] = (await windowList(app)).slice(1)
  for (const w of [second, third]) {
    const shown = w ? s.windows[w.id]?.activeTab[w.spaceId] : undefined
    expect(shown && s.tabs[shown]?.url).toBe(page('Links-next'))
  }
  // The private window's copy of the page lives in a session kept in memory only.
  const privateTab = third ? s.windows[third.id]?.activeTab[third.spaceId] : undefined
  await waitLoaded(app, privateTab as string, page('Links-next'))
  const sessions = await app.evaluate(
    ({ webContents }, url) =>
      webContents
        .getAllWebContents()
        .filter((w) => w.getURL() === url)
        .map((w) => w.session.isPersistent())
        .sort(),
    page('Links-next'),
  )
  expect(sessions).toEqual([false, true])
})
