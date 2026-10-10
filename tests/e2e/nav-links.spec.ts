import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type ElectronApplication, expect, test } from '@playwright/test'
import type { SplitLayout } from '../../src/shared/state'
import { isMac, launchOrbit, type Orbit, state, tabPage } from './helpers'
import {
  blockedMenu,
  chooseBlocked,
  choosePageMenu,
  clickEvents,
  clickInPage,
  cmd,
  foreignWindowTitles,
  hoverInPage,
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

/**
 * A page on localhost with a link (#away) to a page on the other site, 127.0.0.1, which has
 * cookies: `away(n)` points it at `/page/<name>-<n>` there.
 */
async function linkToOtherSite(
  app: ElectronApplication,
  name: string,
): Promise<{ src: string; srcTab: string; away: (n: number) => Promise<string> }> {
  await openTab(app, fx.urlOn('127.0.0.1', '/cookies'))
  const target = (n: number) => fx.urlOn('127.0.0.1', `/page/${name}-${n}`)
  const src = fx.url(`/page/${name}?away=${encodeURIComponent(target(0))}`)
  const srcTab = await openTab(app, src)
  const tab = await tabPage(app, src)
  /** Points the link at <name>-n. */
  const away = async (n: number) => {
    await tab.evaluate((href) => document.querySelector('#away')?.setAttribute('href', href), target(n))
    return target(n)
  }
  return { src, srcTab, away }
}

/** How a click on a link to the other site is requested: as the page's own, as a browser's is. */
const sentAsLink = () => ({ referer: `http://localhost:${fx.port}/`, site: 'cross-site', cookie: 'lax=1' })

test('[NV-08] links opened with ⌘-, middle-, ⇧- and ⇧⌘-click are requested as the page’s own clicks: with a Referer, as cross-site, without the SameSite=Strict cookie (review B-F1)', async () => {
  const { app } = orbit
  await app.evaluate(() => {
    const g = globalThis as unknown as {
      __orbit: { ctx: { store: { update: (f: (d: { settings: Record<string, unknown> }) => void) => void } } }
    }
    // ⇧-click opens a new window, not Peek (peek.md).
    g.__orbit.ctx.store.update((d) => {
      d.settings.peekShiftClick = false
    })
  })
  const { src, away } = await linkToOtherSite(app, 'Clicked')
  const opener = await selectedTab(app)
  const requested = async (n: number) => {
    await expect.poll(() => fx.hits(`/page/Clicked-${n}`)).toBe(1)
    expect(fx.sentFrom(`/page/Clicked-${n}`)).toEqual(sentAsLink())
  }

  // ⌘-click (Ctrl-click) and middle-click: background tabs at the top of Today.
  const url1 = await away(1)
  await clickInPage(app, src, '#away', [mod])
  await requested(1)
  await expect.poll(async () => urlOf(app, (await today(app))[0])).toBe(url1)
  const [first] = await today(app)
  expect((await state(app)).tabs[first as string]?.openerTabId).toBe(opener)
  await waitLoaded(app, first as string, url1)
  const url2 = await away(2)
  await clickInPage(app, src, '#away', [], 'middle')
  await requested(2)
  await expect.poll(async () => urlOf(app, (await today(app))[0])).toBe(url2)
  expect(await selectedTab(app)).toBe(opener)

  // ⇧-click: a new window.
  const url3 = await away(3)
  await clickInPage(app, src, '#away', ['shift'])
  await requested(3)
  await expect.poll(async () => (await windowList(app)).length).toBe(2)
  const second = (await windowList(app))[1]
  const shown = second ? (await state(app)).windows[second.id]?.activeTab[second.spaceId] : undefined
  expect(await urlOf(app, shown ?? undefined)).toBe(url3)

  // ⇧⌘-click (Ctrl+Shift-click): a new tab, selected.
  const url4 = await away(4)
  await clickInPage(app, src, '#away', [mod, 'shift'])
  await requested(4)
  await expect.poll(async () => urlOf(app, await selectedTab(app))).toBe(url4)
  // Each was requested once: the page's request, not Orbit's as well.
  expect([1, 2, 3, 4].map((n) => fx.hits(`/page/Clicked-${n}`))).toEqual([1, 1, 1, 1])
})

test('[NV-08][NV-09][NV-12] links Orbit opens for a page (its menu, ⌥-click, a blocked pop-up) are sent with the page as Referer (review B-F1)', async () => {
  const { app, shell } = orbit
  const { src, srcTab, away } = await linkToOtherSite(app, 'Opened')
  const referer = `http://localhost:${fx.port}/`
  const fromMenu = async (label: string) => {
    await clickInPage(app, src, '#away', [], 'right')
    await expect.poll(async () => (await pageMenu(app))?.labels ?? []).toContain(label)
    expect(await choosePageMenu(app, label)).toBe(true)
  }
  const url1 = await away(1)
  await fromMenu('Open Link in New Tab')
  await expect.poll(async () => urlOf(app, (await today(app))[0])).toBe(url1)
  // Shown, in case it hasn't loaded in the background.
  await cmd(app, 'tabs.activate', { tabId: (await today(app))[0] })
  await expect.poll(() => fx.hits('/page/Opened-1')).toBe(1)
  expect(fx.sentFrom('/page/Opened-1')?.referer).toBe(referer)
  await cmd(app, 'tabs.activate', { tabId: srcTab })
  await expect.poll(() => selectedTab(app)).toBe(srcTab)
  await away(2)
  await fromMenu('Open Link in New Window')
  await expect.poll(() => fx.hits('/page/Opened-2')).toBe(1)
  expect(fx.sentFrom('/page/Opened-2')?.referer).toBe(referer)
  // ⌥-click: split view.
  await away(3)
  await clickInPage(app, src, '#away', ['alt'])
  await expect.poll(() => fx.hits('/page/Opened-3')).toBe(1)
  expect(fx.sentFrom('/page/Opened-3')?.referer).toBe(referer)
  // A pop-up blocked as the page loaded, opened from the address display.
  const blocked = fx.urlOn('127.0.0.1', '/page/Opened-4')
  await openTab(app, fx.url(`/page/Eager?open=${encodeURIComponent(blocked)}`))
  await shell.getByTestId('popups-blocked').click()
  await expect.poll(() => blockedMenu(app)).toContain(`Open ${blocked}`)
  expect(await chooseBlocked(app, `Open ${blocked}`)).toBe(true)
  await expect.poll(() => fx.hits('/page/Opened-4')).toBe(1)
  expect(fx.sentFrom('/page/Opened-4')?.referer).toBe(referer)
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

test('[NV-08][SV-08] ⌥-click opens the link under the click, though the pointer leaves the page before a busy page answers which (fix check B, F1)', async () => {
  const { app } = orbit
  const url = page('Busy')
  const id = await openTab(app, url)
  const downloads = await watchDownloads(app, url)
  const next = await hoverInPage(app, url, '#next')
  await hoverInPage(app, url, '#child')
  // The page is busy for a moment. Meanwhile ⌥-click comes on the link above the pointer, and the
  // pointer leaves the page, as when a window opens over the real one.
  const events = [...clickEvents(next.x, next.y, ['alt']), { type: 'mouseLeave', x: next.x, y: next.y }]
  await app.evaluate(
    ({ webContents }, [u, list]) => {
      const contents = webContents.getAllWebContents().find((w) => w.getURL() === u)
      if (!contents) throw new Error(`no page ${u}`)
      void contents.executeJavaScript(
        '(() => { const end = performance.now() + 400; while (performance.now() < end); })()',
      )
      for (const event of list) contents.sendInputEvent(event as unknown as Electron.MouseInputEvent)
    },
    [url, events] as const,
  )
  await expect.poll(() => splitTabs(app, id)).toHaveLength(2)
  const [, right] = await splitTabs(app, id)
  expect(await urlOf(app, right)).toBe(page('Busy-next'))
  await expect.poll(downloads, { timeout: 10_000 }).toEqual([{ url: page('Busy-next'), cancelled: true }])
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

test('[NV-12] Open Link in New Tab with the sidebar hidden says so, as a ⌘-clicked link does (review B-M4)', async () => {
  const { app, shell } = orbit
  const id = await openTab(app, page('Hidden'))
  await cmd(app, 'window.setSidebar', { visible: false })
  await expect(shell.getByTestId('sidebar')).toBeHidden()
  await clickInPage(app, page('Hidden'), '#next', [], 'right')
  await expect.poll(async () => (await pageMenu(app))?.tabId).toBe(id)
  expect(await choosePageMenu(app, 'Open Link in New Tab')).toBe(true)
  await expect.poll(async () => urlOf(app, (await today(app))[0])).toBe(page('Hidden-next'))
  await expect(shell.getByTestId('toast').last()).toContainText('Opened in a new tab')
  expect(await selectedTab(app)).toBe(id)
})

test('[NV-12] right-clicking a video or audio offers Loop and Show Controls, ticked as the element is, before Picture in Picture; each sets the element (review B-M4)', async () => {
  const { app } = orbit
  const id = await openTab(app, fx.url('/media/Clip'))
  const tab = await tabPage(app, '/media/Clip')
  // The video has been recorded and has a length and a picture; the tone has loaded.
  await expect
    .poll(() =>
      tab.evaluate(() => {
        const v = document.getElementById('v') as HTMLVideoElement
        const a = document.getElementById('a') as HTMLAudioElement
        return v.readyState >= 1 && Number.isFinite(v.duration) && v.videoWidth > 0 && a.readyState >= 1
      }),
    )
    .toBe(true)
  const elements = () =>
    tab.evaluate(() => {
      const v = document.getElementById('v') as HTMLVideoElement
      const a = document.getElementById('a') as HTMLAudioElement
      return { video: { loop: v.loop, controls: v.controls }, audio: { loop: a.loop, controls: a.controls } }
    })
  /** Right-clicks an element near its top left (clear of a paused video's play button): the menu's first group. */
  const menuOn = async (selector: string) => {
    const box = await tab.locator(selector).boundingBox()
    if (!box) throw new Error(`no ${selector}`)
    await tab.mouse.click(box.x + 16, box.y + 16, { button: 'right' })
    await expect.poll(async () => (await pageMenu(app))?.tabId).toBe(id)
    const menu = await pageMenu(app)
    const labels = menu?.labels ?? []
    const end = labels.indexOf('-')
    return { group: end < 0 ? labels : labels.slice(0, end), checked: menu?.checked, enabled: menu?.enabled }
  }

  // The video: Loop unticked, Show Controls ticked, then media's Picture in Picture.
  let menu = await menuOn('#v')
  expect(menu.group).toEqual(['Loop', 'Show Controls', 'Picture in Picture'])
  expect(menu.checked).toMatchObject({ Loop: false, 'Show Controls': true })
  expect(menu.enabled).toMatchObject({ Loop: true, 'Show Controls': true })
  expect(await choosePageMenu(app, 'Loop')).toBe(true)
  await expect.poll(async () => (await elements()).video).toEqual({ loop: true, controls: true })
  menu = await menuOn('#v')
  expect(menu.checked).toMatchObject({ Loop: true, 'Show Controls': true })
  expect(await choosePageMenu(app, 'Show Controls')).toBe(true)
  await expect.poll(async () => (await elements()).video).toEqual({ loop: true, controls: false })
  menu = await menuOn('#v')
  expect(menu.checked).toMatchObject({ Loop: true, 'Show Controls': false })
  expect(await choosePageMenu(app, 'Loop')).toBe(true)
  await expect.poll(async () => (await elements()).video).toEqual({ loop: false, controls: false })

  // The tone: no Picture in Picture, and its controls stay (without them it would be gone for good).
  menu = await menuOn('#a')
  expect(menu.group).toEqual(['Loop', 'Show Controls'])
  expect(menu.checked).toMatchObject({ Loop: false, 'Show Controls': true })
  expect(menu.enabled).toMatchObject({ Loop: true, 'Show Controls': false })
  expect(await choosePageMenu(app, 'Loop')).toBe(true)
  await expect.poll(async () => (await elements()).audio).toEqual({ loop: true, controls: true })
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

// ---- Local files from web pages (D49, fix check B M2) ----

/** A 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** A text file and a picture in a new temporary folder, with their file: addresses. */
function localFiles(): { folder: string; text: string; image: string } {
  const folder = mkdtempSync(join(tmpdir(), 'orbit-e2e-local-'))
  writeFileSync(join(folder, 'orbit-local.txt'), 'orbit-local-file')
  writeFileSync(join(folder, 'orbit-local.png'), PNG)
  return {
    folder: pathToFileURL(folder).href,
    text: pathToFileURL(join(folder, 'orbit-local.txt')).href,
    image: pathToFileURL(join(folder, 'orbit-local.png')).href,
  }
}

/** Records from now on every page, new ones too, that starts loading an address under `prefix`. */
async function watchLoads(app: ElectronApplication, prefix: string): Promise<() => Promise<string[]>> {
  await app.evaluate(({ app: electronApp, webContents }, p) => {
    const g = globalThis as unknown as { __loads: string[] }
    g.__loads = []
    const watch = (contents: Electron.WebContents) =>
      contents.on('did-start-navigation', (details) => {
        if (details.url.startsWith(p)) g.__loads.push(details.url)
      })
    for (const contents of webContents.getAllWebContents()) watch(contents)
    electronApp.on('web-contents-created', (_e, contents) => watch(contents))
  }, prefix)
  return () => app.evaluate(() => (globalThis as unknown as { __loads: string[] }).__loads)
}

/** The items that would open or save a link or an image. */
const OPEN_OR_SAVE = [
  'Open Link in New Tab',
  'Open Link in Split View',
  'Open Link in Peek',
  'Open Link in Mini Window',
  'Open Link in New Window',
  'Open Link in Private Window',
  'Save Link As…',
  'Open Image in New Tab',
  'Save Image As…',
]

test('[NV-12][NV-08] a web page’s link to a local file and its local picture: the page menu offers no way to open or save them, ⌥-click opens nothing (D49, fix check B M2)', async () => {
  const { app } = orbit
  const local = localFiles()
  const loads = await watchLoads(app, local.folder)
  const web = fx.url(`/page/Web?away=${encodeURIComponent(local.text)}`)
  const id = await openTab(app, web)
  const tab = await tabPage(app, '/page/Web')
  await tab.evaluate((src) => {
    document.body.insertAdjacentHTML('afterbegin', `<img id="local" src="${src}" alt="Local" width="48" height="48">`)
  }, local.image)
  const downloads = await watchDownloads(app, web)

  // The link: only Copy Link Address.
  await clickInPage(app, web, '#away', [], 'right')
  await expect.poll(async () => (await pageMenu(app))?.tabId).toBe(id)
  const linkMenu = (await pageMenu(app))?.labels ?? []
  expect(linkMenu.filter((l) => OPEN_OR_SAVE.includes(l))).toEqual([])
  expect(linkMenu).toContain('Copy Link Address')
  // The picture: copying stays.
  await clickInPage(app, web, '#local', [], 'right')
  await expect.poll(async () => (await pageMenu(app))?.labels ?? []).toContain('Copy Image Address')
  const imageMenu = (await pageMenu(app))?.labels ?? []
  expect(imageMenu.filter((l) => OPEN_OR_SAVE.includes(l))).toEqual([])
  expect(imageMenu).toContain('Copy Image')

  // ⌥-click on it opens no pane; ⌥-click on a web link after it does, alone.
  await clickInPage(app, web, '#away', ['alt'])
  await clickInPage(app, web, '#next', ['alt'])
  await expect.poll(() => splitTabs(app, id)).toHaveLength(2)
  const [, right] = await splitTabs(app, id)
  expect(await urlOf(app, right)).toBe(page('Web-next'))

  // No page ever started loading the local files, and nothing downloaded them.
  expect(await loads()).toEqual([])
  expect(Object.values((await state(app)).tabs).filter((t) => t.url.startsWith(local.folder))).toEqual([])
  expect((await downloads()).filter((d) => d.url.startsWith(local.folder))).toEqual([])
})

test('[NV-12][NV-08] a local file page still opens its links to local files: Open Link in New Tab and ⌥-click (D49)', async () => {
  const { app } = orbit
  const local = localFiles()
  const folder = new URL(local.folder.endsWith('/') ? local.folder : `${local.folder}/`)
  const first = new URL('first.html', folder).href
  const second = new URL('second.html', folder).href
  writeFileSync(
    new URL(first),
    '<!doctype html><title>First</title><p><a id="second" href="second.html">Second</a></p>',
  )
  writeFileSync(new URL(second), '<!doctype html><title>Second</title><p>Second local page</p>')
  const id = await openTab(app, first)
  await clickInPage(app, first, '#second', [], 'right')
  await expect.poll(async () => (await pageMenu(app))?.tabId).toBe(id)
  const labels = (await pageMenu(app))?.labels ?? []
  expect(labels).toEqual(expect.arrayContaining(['Open Link in New Tab', 'Open Link in Split View', 'Save Link As…']))
  expect(await choosePageMenu(app, 'Open Link in New Tab')).toBe(true)
  await expect.poll(async () => urlOf(app, (await today(app))[0])).toBe(second)
  const opened = (await today(app))[0] as string
  await cmd(app, 'tabs.activate', { tabId: opened })
  await expect.poll(() => loadedTitle(app, second)).toBe('Second')
  // ⌥-click in the local page: the other local page beside it.
  await cmd(app, 'tabs.activate', { tabId: id })
  await expect.poll(() => selectedTab(app)).toBe(id)
  await clickInPage(app, first, '#second', ['alt'])
  await expect.poll(() => splitTabs(app, id)).toHaveLength(2)
  const [, right] = await splitTabs(app, id)
  expect(await urlOf(app, right)).toBe(second)
})

test('[TB-02] a local file’s address dropped on the sidebar opens nothing, as a link or as text; a web link dropped after it opens (D49)', async () => {
  const { app, shell } = orbit
  const local = localFiles()
  const loads = await watchLoads(app, local.folder)
  /** Drops `text` on the sidebar as data of `type`, as a link or a selection dragged from a page does. */
  const drop = async (type: string, text: string) => {
    const dt = await shell.evaluateHandle(
      ([t, u]) => {
        const d = new DataTransfer()
        d.setData(t, u)
        return d
      },
      [type, text] as const,
    )
    await shell.getByTestId('sidebar-scroll').dispatchEvent('dragover', { dataTransfer: dt })
    await shell.getByTestId('sidebar-scroll').dispatchEvent('drop', { dataTransfer: dt })
  }
  await drop('text/uri-list', local.text)
  await drop('text/plain', local.text)
  await drop('text/plain', `view-source:${local.text}`)
  await drop('text/uri-list', page('DroppedAfter'))
  await expect.poll(async () => urlOf(app, (await today(app))[0])).toBe(page('DroppedAfter'))
  expect(await today(app)).toHaveLength(1)
  expect(Object.values((await state(app)).tabs).map((t) => t.url)).not.toContainEqual(
    expect.stringContaining('orbit-local'),
  )
  expect(await loads()).toEqual([])
})

// ---- Save Page As… (D49, round 2 fix check M1) ----

/** A local style sheet, script and picture holding a marker no web page could know, in a new folder. */
function markedFiles(tag: string): { folder: string; marker: string; css: string; js: string; png: string } {
  const folder = mkdtempSync(join(tmpdir(), `orbit-e2e-${tag}-`))
  const marker = `orbit-marker-${tag}-${Math.random().toString(36).slice(2)}`
  writeFileSync(join(folder, `${tag}.css`), `/* ${marker} */ h1 { outline: 1px solid red }`)
  writeFileSync(join(folder, `${tag}.js`), `/* ${marker} */ window.__ran = true`)
  // A picture with the marker after its end, where readers ignore it.
  writeFileSync(join(folder, `${tag}.png`), Buffer.concat([PNG, Buffer.from(marker)]))
  const url = (name: string) => pathToFileURL(join(folder, name)).href
  return { folder, marker, css: url(`${tag}.css`), js: url(`${tag}.js`), png: url(`${tag}.png`) }
}

/** HTML naming the files as a style sheet, a script, a picture and a frame's page. */
const naming = (files: { css: string; js: string; png: string }) =>
  `<link rel="stylesheet" href="${files.css}"><script src="${files.js}"></script>` +
  `<img src="${files.png}" width="8" height="8" alt=""><iframe src="${files.css}" width="80" height="40"></iframe>`

/** The saved files under `folder` (paths from it) that hold `marker`; an MHTML file's parts are each decoded. */
function holding(folder: string, marker: string): string[] {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? files(path) : [path]
    })
  return files(folder)
    .filter((path) => mhtmlParts(readFileSync(path)).some((part) => part.includes(marker)))
    .map((path) => path.slice(folder.length + 1))
}

/** An MHTML file's parts, decoded; any other file as it is. */
function mhtmlParts(raw: Buffer): Buffer[] {
  const text = raw.toString('latin1')
  const boundary = /^MIME-Version:[\s\S]*?boundary="?([^";\r\n]+)"?/im.exec(text.slice(0, 2000))?.[1]
  if (!boundary) return [raw]
  return text
    .split(`--${boundary}`)
    .slice(1)
    .map((part) => {
      const end = part.indexOf('\r\n\r\n')
      const body = part.slice(end + 4)
      const encoding = /content-transfer-encoding:\s*([\w-]+)/i.exec(part.slice(0, end))?.[1]?.toLowerCase()
      if (encoding === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64')
      if (encoding !== 'quoted-printable') return Buffer.from(body, 'latin1')
      const unwrapped = body.replace(/=\r?\n/g, '')
      return Buffer.from(
        unwrapped.replace(/=([0-9A-F]{2})/gi, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))),
        'latin1',
      )
    })
}

type TabsHook = { __orbit: { ctx: { tabs: { contents: (id: string) => Electron.WebContents | undefined } } } }
type Saved = { path: string; format: string; done: boolean }

/** Runs a script in the frame of a tab whose address contains `part` (the page's own too); null while there's none. */
function inFrame<T>(app: ElectronApplication, tabId: string, part: string, code: string): Promise<T | null> {
  return app.evaluate(
    async (_e, [id, p, js]) => {
      const contents = (globalThis as unknown as TabsHook).__orbit.ctx.tabs.contents(id)
      const frame = contents?.mainFrame.framesInSubtree.find((f) => f.url.includes(p))
      return frame ? await frame.executeJavaScript(js) : null
    },
    [tabId, part, code] as const,
  ) as Promise<T | null>
}

/**
 * Chooses Save Page As… on a tab's page, with the save dialog answering `target`, and waits until the
 * page is saved. Returns the format it was saved as.
 */
async function savePageAs(app: ElectronApplication, url: string, tabId: string, target: string): Promise<string> {
  await app.evaluate(
    ({ dialog }, [id, path]) => {
      const g = globalThis as unknown as TabsHook & { __saved?: Saved[] }
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog
      const contents = g.__orbit.ctx.tabs.contents(id) as (Electron.WebContents & { __watched?: true }) | undefined
      if (!contents) throw new Error(`no tab ${id}`)
      g.__saved = g.__saved ?? []
      const saved = g.__saved
      if (contents.__watched) return
      contents.__watched = true
      // Watched, not changed: what the page is saved as, and when that is done.
      const savePage = contents.savePage.bind(contents)
      contents.savePage = (path, format) => {
        const save = { path, format, done: false }
        saved.push(save)
        return savePage(path, format).then(() => {
          save.done = true
        })
      }
    },
    [tabId, target] as const,
  )
  await clickInPage(app, url, '#title', [], 'right')
  await expect.poll(async () => (await pageMenu(app))?.tabId).toBe(tabId)
  expect(await choosePageMenu(app, 'Save Page As…')).toBe(true)
  const save = () =>
    app.evaluate(
      (_e, path) => (globalThis as unknown as { __saved?: Saved[] }).__saved?.find((s) => s.path === path),
      target,
    )
  await expect.poll(async () => (await save())?.done).toBe(true)
  return (await save())?.format ?? ''
}

test('[NV-12] Save Page As… copies no local file a web page names: a web page, or a local page with a web frame, saves as one file or as its HTML alone; a local page alone still saves complete (D49, round 2 fix check M1)', async () => {
  const { app } = orbit
  // A web page naming local files as its style sheet, script, picture and a frame.
  const secret = markedFiles('secret')
  const web = page('SaveWeb')
  const webId = await openTab(app, web)
  await inFrame(
    app,
    webId,
    '/page/SaveWeb',
    `document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(naming(secret))})`,
  )
  for (const [name, format] of [
    ['SaveWeb.mhtml', 'MHTML'],
    ['SaveWeb.html', 'HTMLOnly'],
  ] as const) {
    const out = mkdtempSync(join(tmpdir(), 'orbit-e2e-saved-'))
    const saved = await savePageAs(app, web, webId, join(out, name))
    expect(holding(out, secret.marker), name).toEqual([])
    expect(holding(out, 'SaveWeb'), name).toEqual([name])
    expect(saved).toBe(format)
  }

  // A local page with its own local files and a web frame, which names other local files.
  const own = markedFiles('own')
  const framed = markedFiles('framed')
  const localPath = join(own.folder, 'local.html')
  writeFileSync(
    localPath,
    `<!doctype html><title>Local</title><h1 id="title">Local</h1>${naming(own)}<iframe id="web" src="${page('SaveFrame')}"></iframe>`,
  )
  const local = pathToFileURL(localPath).href
  const localId = await openTab(app, local)
  await expect.poll(() => inFrame(app, localId, '/page/SaveFrame', 'document.readyState')).toBe('complete')
  await inFrame(
    app,
    localId,
    '/page/SaveFrame',
    `document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(naming(framed))})`,
  )
  for (const [name, format] of [
    ['Framed.html', 'HTMLOnly'],
    ['Framed.mhtml', 'MHTML'],
  ] as const) {
    const out = mkdtempSync(join(tmpdir(), 'orbit-e2e-saved-'))
    const saved = await savePageAs(app, local, localId, join(out, name))
    expect(holding(out, framed.marker), name).toEqual([])
    expect(saved).toBe(format)
  }

  // Without the web frame, the local page saves complete: its own local files beside it.
  await inFrame(app, localId, local, `document.getElementById('web').remove()`)
  await expect.poll(() => inFrame(app, localId, '/page/SaveFrame', '1')).toBe(null)
  const out = mkdtempSync(join(tmpdir(), 'orbit-e2e-saved-'))
  expect(await savePageAs(app, local, localId, join(out, 'Local.html'))).toBe('HTMLComplete')
  expect(holding(out, own.marker)).toEqual(
    expect.arrayContaining(['Local_files/own.css', 'Local_files/own.js', 'Local_files/own.png']),
  )
})
