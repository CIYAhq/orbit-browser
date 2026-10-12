import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type ElectronApplication, expect, test } from '@playwright/test'
import type { SplitLayout } from '../../src/shared/state'
import { isMac, launchOrbit, type Orbit, state, tabPage, viewPage } from './helpers'
import {
  blockedMenu,
  chooseBlocked,
  choosePageMenu,
  clickEvents,
  clickInPage,
  cmd,
  foreignWindowTitles,
  hoverInPage,
  type Modifier,
  type NavFixtures,
  openTab,
  pageMenu,
  sendToPage,
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
  // ⌥-click: split view. The link is requested twice, for the split's page and for the engine's own
  // ⌥-click download (Orbit cancels it once it has begun), so the requests aren't counted: once the
  // split shows the page, each request so far had the page as Referer.
  const url3 = await away(3)
  await clickInPage(app, src, '#away', ['alt'])
  await expect.poll(() => splitTabs(app, srcTab)).toHaveLength(2)
  const [, split] = await splitTabs(app, srcTab)
  await waitLoaded(app, split as string, url3)
  const sent = fx.sentFromEach('/page/Opened-3')
  expect(sent.length).toBeGreaterThan(0)
  for (const request of sent) expect(request.referer).toBe(referer)
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

/** The real X pointer and keyboard on the test's display (xdotool, Linux), or null where there are none. */
const xdotool = (() => {
  if (process.platform !== 'linux' || !process.env.DISPLAY) return null
  try {
    execFileSync('xdotool', ['version'], { stdio: 'ignore' })
  } catch {
    return null
  }
  return (...args: string[]) => execFileSync('xdotool', args, { encoding: 'utf8' })
})()

/** Where a point of a tab's page (in CSS pixels at 100%) is on the screen. */
function onScreen(app: ElectronApplication, tabId: string, x: number, y: number): Promise<{ x: number; y: number }> {
  return app.evaluate(
    (_e, [id, px, py]) => {
      type Windows = {
        windowOfTab: (id: string) => string | undefined
        get: (id: string) => Electron.BrowserWindow | undefined
        tabViewBounds: (id: string) => Electron.Rectangle | undefined
      }
      const { windows } = (globalThis as unknown as { __orbit: { ctx: { windows: Windows } } }).__orbit.ctx
      const win = windows.get(windows.windowOfTab(id) ?? '')
      const view = windows.tabViewBounds(id)
      if (!win || !view) throw new Error(`tab ${id} isn't on screen`)
      const content = win.getContentBounds()
      return { x: content.x + view.x + px, y: content.y + view.y + py }
    },
    [tabId, x, y] as const,
  )
}

test('[NV-08][SV-08] ⌥-click on a link in a frame from another site opens that link, not the page’s link at the frame’s own point (round 2 fix check, M2)', async () => {
  test.skip(!xdotool, 'the press has to come from the real pointer: test input never reaches a frame from another site')
  const x = xdotool as NonNullable<typeof xdotool>
  const { app } = orbit
  // The page on 127.0.0.1; its frame on localhost, another site, so in a process of its own.
  const top = fx.urlOn('127.0.0.1', '/page/AltTop')
  const decoy = fx.urlOn('127.0.0.1', '/page/AltDecoy')
  const target = page('AltTarget')
  const id = await openTab(app, top)
  const downloads = await watchDownloads(app, top)
  const box = 'position:absolute;display:block;left:40px;top:70px;width:80px;height:40px'
  const frame = 'position:absolute;left:100px;top:100px;width:400px;height:300px;border:0'
  const fill = (html: string) =>
    `document.body.style.cssText = 'margin:0;padding:0'; document.body.innerHTML = ${JSON.stringify(html)}`
  // The page's own link sits at (80, 90): where the frame's link is in the frame's own coordinates.
  await inFrame(
    app,
    id,
    '/page/AltTop',
    fill(
      `<a id="decoy" href="${decoy}" style="${box}">Decoy</a><iframe src="${page('AltInner')}" style="${frame}"></iframe>`,
    ),
  )
  await expect.poll(() => inFrame(app, id, '/page/AltInner', 'document.readyState')).toBe('complete')
  await inFrame(app, id, '/page/AltInner', fill(`<a id="target" href="${target}" style="${box}">Target</a>`))
  // The frame's link, at (80, 90) in the frame and (180, 190) in the page.
  const at = await onScreen(app, id, 180, 190)
  const [, startX = '0', startY = '0'] = /X=(\d+)\s+Y=(\d+)/.exec(x('getmouselocation', '--shell')) ?? []
  try {
    x('mousemove', String(at.x), String(at.y))
    await expect
      .poll(() => inFrame(app, id, '/page/AltInner', `document.getElementById('target').matches(':hover')`))
      .toBe(true)
    x('keydown', 'alt')
    x('click', '1')
  } finally {
    x('keyup', 'alt')
    x('mousemove', startX, startY)
  }
  await expect.poll(() => splitTabs(app, id)).toHaveLength(2)
  const [, right] = await splitTabs(app, id)
  expect(await urlOf(app, right)).toBe(target)
  // The engine's own download of the frame's link said which, and was cancelled.
  await expect.poll(downloads, { timeout: 10_000 }).toEqual([{ url: target, cancelled: true }])
  expect(fx.hits('/page/AltDecoy')).toBe(0)
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
  // Over the page, where it can be seen (SB-13).
  await expect((await viewPage(app, 'toasts')).getByTestId('toast').last()).toContainText('Opened in a new tab')
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

/** Records the links a page's pointer goes over (`update-target-url`), latest last. */
async function watchTargets(app: ElectronApplication, pageUrl: string): Promise<() => Promise<string | undefined>> {
  await app.evaluate(({ webContents }, url) => {
    const g = globalThis as unknown as { __targets: string[] }
    g.__targets = []
    const contents = webContents.getAllWebContents().find((w) => w.getURL() === url)
    if (!contents) throw new Error(`no page ${url}`)
    contents.on('update-target-url', (_e, target) => g.__targets.push(target))
  }, pageUrl)
  return () => app.evaluate(() => (globalThis as unknown as { __targets: string[] }).__targets.at(-1))
}

test('[NV-08] ⌥-click on a local file’s link in a frame never opens it beside the page, even in a local page: the engine’s download goes ahead, as a frame counts as a web page (D49, round 2 fix check F2)', async () => {
  const { app } = orbit
  const local = localFiles()
  const folder = new URL(local.folder.endsWith('/') ? local.folder : `${local.folder}/`)
  const outer = new URL('outer.html', folder).href
  writeFileSync(
    new URL(outer),
    '<!doctype html><title>Outer</title><body style="margin:0"><iframe src="inner.html" style="position:absolute;left:100px;top:100px;width:300px;height:200px;border:0"></iframe>',
  )
  writeFileSync(
    new URL('inner.html', folder),
    `<!doctype html><title>Inner</title><body style="margin:0"><a id="link" href="${local.text}" style="position:absolute;left:20px;top:20px;width:120px;height:40px;display:block">Local</a>`,
  )
  const id = await openTab(app, outer)
  await expect.poll(() => inFrame(app, id, 'inner.html', 'document.readyState')).toBe('complete')
  const loads = await watchLoads(app, local.folder)
  const downloads = await watchDownloads(app, outer)
  const target = await watchTargets(app, outer)
  /** ⌥-clicks the frame's link at (x, y) in the page once the pointer is over it. */
  const altClick = async (x: number, url: string) => {
    await sendToPage(app, outer, [{ type: 'mouseMove', x, y: 140 }])
    await expect.poll(target).toBe(url)
    await sendToPage(app, outer, clickEvents(x, 140, ['alt']))
  }
  await altClick(180, local.text)
  // The engine downloads the link it was ⌥-clicked on. Orbit lets that go ahead as a download and
  // opens nothing.
  await expect.poll(downloads).toEqual([{ url: local.text, cancelled: false }])
  // A web link in the same frame opens beside the page, so the ⌥-click before it was seen.
  await inFrame(app, id, 'inner.html', `document.getElementById('link').href = ${JSON.stringify(page('FramedWeb'))}`)
  await altClick(181, page('FramedWeb'))
  await expect.poll(() => splitTabs(app, id)).toHaveLength(2)
  const [, right] = await splitTabs(app, id)
  expect(await urlOf(app, right)).toBe(page('FramedWeb'))
  expect(Object.values((await state(app)).tabs).filter((t) => t.url === local.text)).toEqual([])
  expect((await loads()).filter((u) => u.includes('orbit-local.txt'))).toEqual([])
  await expect.poll(downloads, { timeout: 10_000 }).toEqual([
    { url: local.text, cancelled: false },
    { url: page('FramedWeb'), cancelled: true },
  ])
})

/**
 * Asks the window-open handler Orbit gave the page at `pageUrl` for `url`, as the engine would for a
 * link or a window.open() it let through, with a click in the page just before (holding `modifiers`)
 * unless `click` is false: the handler's answer.
 */
function askToOpen(
  app: ElectronApplication,
  pageUrl: string,
  url: string,
  disposition: 'background-tab' | 'foreground-tab' | 'new-window',
  { features = '', click = true, modifiers = [] }: { features?: string; click?: boolean; modifiers?: Modifier[] } = {},
): Promise<string> {
  return app.evaluate(
    async ({ webContents }, [p, u, d, f, c, m]) => {
      const contents = webContents.getAllWebContents().find((w) => w.getURL() === p)
      if (!contents) throw new Error(`no page ${p}`)
      if (c) {
        // A click in the page's margin: the gesture a new tab or a pop-up needs (NV-09).
        const at = { x: 8, y: 8, button: 'left' as const, clickCount: 1, modifiers: [...m] }
        contents.sendInputEvent({ type: 'mouseDown', ...at })
        contents.sendInputEvent({ type: 'mouseUp', ...at })
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      type Handler = (details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse
      // Where Electron keeps the handler a page's opens go to.
      const handler = (contents as unknown as { _windowOpenHandler?: Handler })._windowOpenHandler
      if (typeof handler !== 'function') throw new Error(`no window-open handler for ${p}`)
      const details = { url: u, frameName: '', features: f, disposition: d, referrer: { url: '', policy: 'default' } }
      return handler(details as Electron.HandlerDetails).action
    },
    [pageUrl, url, disposition, features, click, modifiers] as const,
  )
}

test('[NV-08][NV-09][MW-07] a web page that asks for a local file in a new tab, window or pop-up gets none, even where the engine lets it ask; a local page still does (D49, round 2 fix check F1)', async () => {
  const { app, shell } = orbit
  const local = localFiles()
  const folder = new URL(local.folder.endsWith('/') ? local.folder : `${local.folder}/`)
  const loads = await watchLoads(app, local.folder)
  const web = page('Opener')
  const webId = await openTab(app, web)
  const windows = (await windowList(app)).length
  const fileTabs = async () =>
    Object.values((await state(app)).tabs)
      .filter((t) => t.url.includes('orbit-local'))
      .map((t) => t.url)

  // From the web page: a pop-up without a click (to block), ⌘-click (a background tab), ⌘⌥-click (a
  // Mini Window), ⇧⌘-click (a selected tab), ⇧-click (a window), and a pop-up with a click.
  const popup = 'width=300,height=200'
  const answers = [
    await askToOpen(app, web, local.text, 'new-window', { features: popup, click: false }),
    await askToOpen(app, web, local.text, 'background-tab'),
    await askToOpen(app, web, local.text, 'background-tab', { modifiers: [mod, 'alt'] }),
    await askToOpen(app, web, local.text, 'foreground-tab'),
    await askToOpen(app, web, local.text, 'new-window'),
    await askToOpen(app, web, local.text, 'new-window', { features: popup }),
  ]
  expect(answers).toEqual(['deny', 'deny', 'deny', 'deny', 'deny', 'deny'])
  // A toast names the file, once however often the page asks (round 3 fix check F1).
  const refused = (file: string) => shell.getByTestId('toast').filter({ hasText: `Local file blocked: ${file}` })
  await expect(refused('orbit-local.txt')).toHaveCount(1)
  // A pop-up the page opened asks too: its own opens become tabs. Its toast is in the opener's window.
  await clickInPage(app, web, '#popup')
  await expect.poll(() => loadedTitle(app, page('Popup-Opener'))).toBe('Popup-Opener')
  expect(await askToOpen(app, page('Popup-Opener'), local.image, 'foreground-tab')).toBe('deny')
  await expect(refused('orbit-local.png')).toBeVisible()

  // A local page with a frame from the web: the frame may be the one asking.
  const framed = new URL('framed.html', folder).href
  writeFileSync(new URL(framed), `<!doctype html><title>Framed</title><iframe src="${page('FramedWeb')}"></iframe>`)
  const framedId = await openTab(app, framed)
  await expect.poll(() => inFrame(app, framedId, '/page/FramedWeb', 'document.readyState')).toBe('complete')
  expect(await askToOpen(app, framed, local.text, 'background-tab')).toBe('deny')

  // Nothing opened, loaded or waits to be opened.
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(await fileTabs()).toEqual([])
  expect(await windowList(app)).toHaveLength(windows)
  expect(await foreignWindowTitles(app)).toEqual([`localhost:${fx.port}`])
  expect((await state(app)).tabs[webId]?.blockedPopups).toBeUndefined()
  expect((await loads()).filter((u) => u.includes('orbit-local'))).toEqual([])

  // A local page of its own asks, and its ⌘-clicked local file opens in a background tab.
  const first = new URL('first.html', folder).href
  writeFileSync(new URL(first), '<!doctype html><title>First</title><p>First local page</p>')
  await openTab(app, first)
  expect(await askToOpen(app, first, local.text, 'background-tab')).toBe('deny')
  await expect.poll(fileTabs).toEqual([local.text])
})

test('[NV-08][NV-09] a local page with a frame of another origin, a web page’s or an opaque one, opens no local file in a new tab, and a toast names it; a plain click still opens it (D49, round 3 fix check F1)', async () => {
  const { app, shell } = orbit
  const local = localFiles()
  const folder = new URL(local.folder.endsWith('/') ? local.folder : `${local.folder}/`)
  const fileTabs = async () =>
    Object.values((await state(app)).tabs)
      .filter((t) => t.url.includes('orbit-local'))
      .map((t) => t.url)
      .sort()
  const frameOrigins = (id: string) =>
    app.evaluate(
      (_e, tabId) =>
        (globalThis as unknown as TabsHook).__orbit.ctx.tabs
          .contents(tabId)
          ?.mainFrame.framesInSubtree.map((f) => f.origin) ?? [],
      id,
    )
  /** A local page with a frame, a target=_blank link to the text file and a plain one to the image. */
  const localPage = (name: string, frame: string) => {
    const url = new URL(`${name}.html`, folder).href
    const links = `<a id="blank" target="_blank" href="${local.text}">Text</a> <a id="plain" href="${local.image}">Image</a>`
    writeFileSync(new URL(url), `<!doctype html><title>${name}</title><p>${links}</p>${frame}`)
    return url
  }
  const toasts = shell.getByTestId('toast')
  const refused = (file: string) => toasts.filter({ hasText: `Local file blocked: ${file}` })
  const frames = [
    { name: 'web-frame', frame: `<iframe src="${page('FramedWeb')}"></iframe>`, origin: `http://localhost:${fx.port}` },
    { name: 'sandboxed-frame', frame: '<iframe sandbox srcdoc="<p>Sandboxed</p>"></iframe>', origin: 'null' },
    { name: 'data-frame', frame: '<iframe src="data:text/html,<p>Data</p>"></iframe>', origin: 'null' },
  ]
  let last = { url: '', id: '' }
  for (const { name, frame, origin } of frames) {
    const url = localPage(name, frame)
    const id = await openTab(app, url)
    last = { url, id }
    await expect.poll(() => frameOrigins(id)).toEqual(['file://', origin])
    // The toasts before have gone.
    await expect(toasts).toHaveCount(0, { timeout: 5000 })
    // A target=_blank link: the page asks for a new tab.
    await clickInPage(app, url, '#blank')
    await expect(refused('orbit-local.txt')).toBeVisible()
    // ⌘-click (Ctrl-click): a background tab.
    await clickInPage(app, url, '#plain', [mod])
    await expect(refused('orbit-local.png')).toBeVisible()
    expect(await fileTabs()).toEqual([])
  }
  // A plain click without a target loads it in the page's own tab, as the engine allows.
  await clickInPage(app, last.url, '#plain')
  await expect.poll(() => urlOf(app, last.id)).toBe(local.image)

  // A local page with a frame of its own origin (srcdoc) opens both, and no toast.
  await expect(toasts).toHaveCount(0, { timeout: 5000 })
  const own = localPage('own-frame', '<iframe srcdoc="<p>Own</p>"></iframe>')
  const ownId = await openTab(app, own)
  await expect.poll(() => frameOrigins(ownId)).toEqual(['file://', 'file://'])
  await clickInPage(app, own, '#blank')
  await clickInPage(app, own, '#plain', [mod])
  await expect.poll(fileTabs).toEqual([local.image, local.image, local.text].sort())
  expect(await toasts.count()).toBe(0)
})

test('[NV-09] a pop-up blocked on a web page is offered to open later unless it is a local file (D49, round 2 fix check F1)', async () => {
  const { app } = orbit
  const local = localFiles()
  const web = page('Web')
  const id = await openTab(app, web)
  // As the tabs runtime reports the pop-ups it blocked: a local file, then a web page.
  await app.evaluate(
    (_e, [tabId, urls, from]) => {
      type Tabs = { onPopupBlocked?: (tabId: string, url: string, referrer: Electron.Referrer) => void }
      const { tabs } = (globalThis as unknown as { __orbit: { ctx: { tabs: Tabs } } }).__orbit.ctx
      for (const url of urls) tabs.onPopupBlocked?.(tabId, url, { url: from, policy: 'default' })
    },
    [id, [local.text, page('Surprise')], web] as const,
  )
  await expect.poll(async () => (await state(app)).tabs[id]?.blockedPopups).toBe(1)
  const host = `localhost:${fx.port}`
  await cmd(app, 'nav.blockedPopupsMenu', { x: 0, y: 0 })
  await expect
    .poll(() => blockedMenu(app))
    .toEqual([`[Pop-ups blocked on ${host}]`, `Open ${page('Surprise')}`, `Always Allow Pop-ups from ${host}`])
})

test('[DT-13][NV-08][NV-09][NV-12] a web page has Orbit open no internal page: not from its menu (Split View included), ⌥-click, a new tab, window or pop-up, its pop-up, a blocked pop-up or a drop (D53)', async () => {
  const { app, shell } = orbit
  const internal = 'orbit://version/'
  const loads = await watchLoads(app, 'orbit:')
  const web = fx.url(`/page/Web?away=${encodeURIComponent(internal)}`)
  const id = await openTab(app, web)
  const tab = await tabPage(app, '/page/Web')
  // The page can't load the picture (D53). Its box shrinks once the load fails, and the link below
  // it moves up, so the clicks wait for that: they aim at the link once, where it was then.
  const picture = await tab.evaluate(
    () =>
      new Promise<string>((resolve) => {
        document.body.insertAdjacentHTML(
          'afterbegin',
          '<img id="internal" src="orbit://pages/" alt="Pages" width="48" height="48">',
        )
        const img = document.getElementById('internal') as HTMLImageElement
        img.addEventListener('error', () => resolve('error'), { once: true })
        img.addEventListener('load', () => resolve('load'), { once: true })
      }),
  )
  expect(picture).toBe('error')
  const orbitTabs = async () =>
    Object.values((await state(app)).tabs)
      .filter((t) => t.url.toLowerCase().startsWith('orbit:'))
      .map((t) => t.url)

  // The page menu on the link and on the picture.
  await clickInPage(app, web, '#away', [], 'right')
  await expect.poll(async () => (await pageMenu(app))?.tabId).toBe(id)
  const linkMenu = (await pageMenu(app))?.labels ?? []
  expect(linkMenu).toContain('Copy Link Address')
  await clickInPage(app, web, '#internal', [], 'right')
  await expect.poll(async () => (await pageMenu(app))?.labels ?? []).toContain('Copy Image Address')
  const imageMenu = (await pageMenu(app))?.labels ?? []
  // ⌥-click on the link.
  await clickInPage(app, web, '#away', ['alt'])
  // New tabs, windows and pop-ups it asks for: a pop-up without a click (to block), ⌘-click, ⌘⌥-click
  // (a Mini Window), ⇧⌘-click, ⇧-click (a window) and a pop-up with a click.
  const popup = 'width=300,height=200'
  const answers = [
    await askToOpen(app, web, internal, 'new-window', { features: popup, click: false }),
    await askToOpen(app, web, internal, 'background-tab'),
    await askToOpen(app, web, internal, 'background-tab', { modifiers: [mod, 'alt'] }),
    await askToOpen(app, web, internal, 'foreground-tab'),
    await askToOpen(app, web, internal, 'new-window'),
    await askToOpen(app, web, internal, 'new-window', { features: popup }),
  ]
  // A pop-up the page opened asks too.
  await clickInPage(app, web, '#popup')
  await expect.poll(() => loadedTitle(app, page('Popup-Web'))).toBe('Popup-Web')
  answers.push(await askToOpen(app, page('Popup-Web'), internal, 'foreground-tab'))
  // Dropped on the sidebar, as a link or as text; a web link dropped after them opens.
  const drop = async (type: string, text: string) => {
    const dt = await shell.evaluateHandle(
      ([t, u]) => {
        const d = new DataTransfer()
        d.setData(t, u)
        return d
      },
      [type, text] as const,
    )
    // At the top of Today: a dropped link opens where it is dropped (NV-08).
    const top = await shell.getByTestId('new-tab-button').boundingBox()
    const at = top ? { clientX: top.x + top.width / 2, clientY: top.y + top.height / 2 } : {}
    await shell.getByTestId('sidebar-scroll').dispatchEvent('dragover', { dataTransfer: dt, ...at })
    await shell.getByTestId('sidebar-scroll').dispatchEvent('drop', { dataTransfer: dt, ...at })
  }
  await drop('text/uri-list', internal)
  await drop('text/plain', internal)
  await drop('text/uri-list', page('DroppedAfter'))
  await expect.poll(async () => urlOf(app, (await today(app))[0])).toBe(page('DroppedAfter'))
  // A local file asked for last: its toast, when it shows, is the only one (an internal page's says nothing).
  const local = localFiles()
  expect(await askToOpen(app, web, local.text, 'background-tab')).toBe('deny')
  const toasts = shell.getByTestId('toast')
  await expect(toasts.filter({ hasText: 'Local file blocked: orbit-local.txt' })).toBeVisible()

  expect({
    linkMenu: linkMenu.filter((l) => OPEN_OR_SAVE.includes(l)),
    imageMenu: imageMenu.filter((l) => OPEN_OR_SAVE.includes(l)),
    answers,
    split: await splitTabs(app, id),
    blocked: (await state(app)).tabs[id]?.blockedPopups,
    tabs: await orbitTabs(),
    loads: await loads(),
    toasts: await toasts.count(),
  }).toEqual({
    linkMenu: [],
    imageMenu: [],
    answers: ['deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny'],
    split: [],
    blocked: undefined,
    tabs: [],
    loads: [],
    toasts: 1,
  })
})

test('[NV-12] a script, a page’s source or a data link offers no way to open it; copying it stays (round 2 fix check F6)', async () => {
  const { app } = orbit
  const web = page('Odd')
  await openTab(app, web)
  const tab = await tabPage(app, '/page/Odd')
  const links: Record<string, string> = {
    script: 'javascript:void(0)',
    source: `view-source:${page('Odd-next')}`,
    data: 'data:text/html,<title>Data</title>',
  }
  await tab.evaluate((list) => {
    for (const [id, href] of Object.entries(list).reverse()) {
      const a = Object.assign(document.createElement('a'), { id, href, textContent: id })
      const p = document.createElement('p')
      p.append(a)
      document.body.prepend(p)
    }
  }, links)
  const opens = (labels: string[]) => labels.filter((l) => l.startsWith('Open '))
  for (const id of [...Object.keys(links), 'next']) {
    // The page's own menu first, so the link's is told from the one before.
    await clickInPage(app, web, '#title', [], 'right')
    await expect.poll(async () => (await pageMenu(app))?.labels ?? []).toContain('Back')
    await clickInPage(app, web, `#${id}`, [], 'right')
    await expect.poll(async () => (await pageMenu(app))?.labels ?? []).toContain('Copy Link Address')
    const labels = (await pageMenu(app))?.labels ?? []
    if (id === 'next') expect(opens(labels)).toContain('Open Link in New Tab')
    else expect(opens(labels), id).toEqual([])
  }
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
    // At the top of Today: a dropped link opens where it is dropped (NV-08).
    const top = await shell.getByTestId('new-tab-button').boundingBox()
    const at = top ? { clientX: top.x + top.width / 2, clientY: top.y + top.height / 2 } : {}
    await shell.getByTestId('sidebar-scroll').dispatchEvent('dragover', { dataTransfer: dt, ...at })
    await shell.getByTestId('sidebar-scroll').dispatchEvent('drop', { dataTransfer: dt, ...at })
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
