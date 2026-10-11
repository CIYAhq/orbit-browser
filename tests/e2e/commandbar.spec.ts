import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import {
  activeTabId,
  type Fixtures,
  FRAME_SLACK,
  launchOrbit,
  MOD,
  type Orbit,
  run,
  startFixtures,
  state,
  tabPage,
  viewPage,
} from './helpers'

let fx: Fixtures
let orbit: Orbit

test.beforeAll(async () => {
  fx = await startFixtures()
})
test.afterAll(async () => {
  await fx.close()
})
test.beforeEach(async () => {
  orbit = await launchOrbit()
  await blockNetwork(orbit.app)
  // macOS keeps the clipboard after the app quits: a URL a CB-12 test left there would put
  // Paste and go first, pre-selected (F4), in every later test. Linux loses it with the app.
  await orbit.app.evaluate(({ clipboard }) => clipboard.clear())
  // The overlay renderer is pre-warmed shortly after launch (CB-22); start once it is up.
  const overlay = await viewPage(orbit.app, 'overlay')
  await overlay.getByTestId('overlay').waitFor({ state: 'attached' })
})
test.afterEach(async () => {
  await orbit.app.close()
})

/** A mouse-move over result row `i` at a screen point, sent to the bar directly. */
async function hoverRow(overlay: Page, i: number, screenX: number, screenY: number): Promise<void> {
  await overlay.evaluate(
    ([i, screenX, screenY]) => {
      const row = document.querySelectorAll('[data-testid="command-result"]')[i]
      row?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, screenX, screenY }))
    },
    [i, screenX, screenY] as const,
  )
}

/** Tests never reach the network: anything but the local fixture server is cancelled. */
async function blockNetwork(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ session }) => {
    const allow = /^(https?:\/\/(localhost|127\.0\.0\.1)[:/]|data:|blob:|devtools:|chrome)/
    const install = (ses: Electron.Session) =>
      ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => cb({ cancel: !allow.test(d.url) }))
    install(session.fromPartition('persist:orbit-p-default'))
    ;(globalThis as unknown as { __blockNet: typeof install }).__blockNet = install
  })
}

async function openBar(key: 'T' | 'L' = 'T'): Promise<Page> {
  await orbit.shell.keyboard.press(`${MOD}+${key}`)
  const overlay = await viewPage(orbit.app, 'overlay')
  await expect(input(overlay)).toBeFocused()
  return overlay
}

/** The live bar (a closing one may still be animating out). */
const bar = (overlay: Page) => overlay.getByTestId('command-bar')
const input = (overlay: Page) => bar(overlay).getByTestId('command-input')
const rows = (overlay: Page) => bar(overlay).getByTestId('command-result')

/** Opens a fixture page titled `name` in a new tab and waits until it has loaded. */
async function newTab(name: string): Promise<string> {
  const path = `/page/${encodeURIComponent(name)}`
  const id = (await run(orbit.app, 'tabs.create', { url: fx.url(path) })) as string
  const page = await tabPage(orbit.app, path)
  await page.waitForLoadState('load')
  await expect.poll(async () => (await state(orbit.app)).tabs[id]?.title).toBe(name)
  return id
}

/** Waits until main shows the command bar (a real ⌘T opens it synchronously in main). */
async function barOpenInMain(): Promise<void> {
  await expect
    .poll(async () => Object.values((await state(orbit.app)).windows)[0]?.overlay.kind, { intervals: [5] })
    .toBe('commandbar')
}

async function tabCount(): Promise<number> {
  return Object.keys((await state(orbit.app)).tabs).length
}

async function selectionOf(overlay: Page) {
  return input(overlay).evaluate((el: HTMLInputElement) => ({
    value: el.value,
    start: el.selectionStart,
    end: el.selectionEnd,
  }))
}

const hostOfFixtures = () => new URL(fx.url('/')).host

test('[CB-01][CB-21][KS-04] ⌘T then Esc creates nothing, and the next ⌘T opens empty', async () => {
  const overlay = await openBar()
  await overlay.keyboard.type('abc')
  await expect(input(overlay)).toHaveValue('abc')
  await overlay.keyboard.press('Escape')
  await expect(overlay.getByTestId('command-bar')).toHaveCount(0)
  expect(await tabCount()).toBe(0)
  await openBar()
  await expect(input(overlay)).toHaveValue('')
  // ⌘T again closes it (CB-21).
  await overlay.keyboard.press(`${MOD}+T`)
  await expect(overlay.getByTestId('command-bar')).toHaveCount(0)
  expect(await tabCount()).toBe(0)
})

test('[CB-02][CB-08][CB-07] typing a domain and Enter opens exactly one new selected Today tab', async () => {
  const overlay = await openBar()
  await overlay.keyboard.type(`${hostOfFixtures()}/page/Alpha`)
  await expect(rows(overlay).first()).toHaveAttribute('data-kind', 'url')
  await overlay.keyboard.press('Enter')
  await expect.poll(tabCount).toBe(1)
  const s = await state(orbit.app)
  const id = (await activeTabId(orbit.app)) as string
  const space = s.spaces[s.spaceOrder[0] as string]
  expect(space?.today[0]).toBe(id)
  // Scheme added: http for localhost.
  expect(s.tabs[id]?.url).toBe(fx.url('/page/Alpha'))
  await expect(orbit.shell.getByTestId('tab-row').first()).toHaveClass(/is-active/)
})

test('[CB-03] ⌘L edits the current URL in place, and ⌘L then Enter reloads', async () => {
  const id = await newTab('Alpha')
  const overlay = await openBar('L')
  const sel = await selectionOf(overlay)
  expect(sel.value).toBe(fx.url('/page/Alpha'))
  expect(sel.start).toBe(0)
  expect(sel.end).toBe(sel.value.length)
  await expect(rows(overlay).first()).toHaveAttribute('data-kind', 'current')
  await overlay.keyboard.type(fx.url('/page/Beta'))
  await expect(rows(overlay).first()).toHaveAttribute('data-kind', 'url')
  await overlay.keyboard.press('Enter')
  await expect.poll(async () => (await state(orbit.app)).tabs[id]?.url).toBe(fx.url('/page/Beta'))
  expect(await tabCount()).toBe(1)

  // ⌘L, Enter: the page reloads (a marker set in the page is gone).
  const page = await tabPage(orbit.app, '/page/Beta')
  await page.waitForLoadState('load')
  await page.evaluate(() => {
    ;(window as unknown as { marker: number }).marker = 1
  })
  const again = await openBar('L')
  await expect(rows(again).first()).toHaveAttribute('data-kind', 'current')
  const reloaded = page.waitForEvent('load')
  await again.keyboard.press('Enter')
  await reloaded
  expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker ?? null)).toBeNull()
  expect(await tabCount()).toBe(1)
})

test('[CB-04] the bar is centred in the window with the sidebar shown or hidden', async () => {
  const overlay = await openBar()
  const centre = async () => {
    const box = await overlay.getByTestId('command-bar').boundingBox()
    const width = await overlay.evaluate(() => window.innerWidth)
    return { delta: (box?.x ?? 0) + (box?.width ?? 0) / 2 - width / 2, top: box?.y ?? 0 }
  }
  // Measured at rest: the bar opens from 97 % scale and 4 px up, which keeps it centred but moves its top.
  const still = () =>
    expect
      .poll(() => bar(overlay).evaluate((el) => getComputedStyle(el).transform))
      .toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/)
  await still()
  await expect.poll(async () => Math.abs((await centre()).delta)).toBeLessThanOrEqual(1)
  const before = await centre()
  await run(orbit.app, 'window.setSidebar', { visible: false })
  await expect(overlay.getByTestId('command-bar')).toBeVisible()
  await still()
  const after = await centre()
  expect(Math.abs(after.delta)).toBeLessThanOrEqual(1)
  expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1)
  // The input sits a little above the middle of the window.
  const height = await overlay.evaluate(() => window.innerHeight)
  expect(before.top / height).toBeGreaterThan(0.2)
  expect(before.top / height).toBeLessThan(0.45)
})

test('[CB-05][CB-06][CB-07] an open tab, an archived tab and a history page all match, each labelled', async () => {
  await newTab('Budget')
  const archivedId = await newTab('Budget 2025')
  await run(orbit.app, 'tabs.close', { tabId: archivedId })
  const historyId = await newTab('Budgeting tips')
  await run(orbit.app, 'tabs.navigate', { tabId: historyId, url: fx.url('/page/Elsewhere') })
  await expect.poll(async () => (await state(orbit.app)).tabs[historyId]?.title).toBe('Elsewhere')

  const overlay = await openBar()
  await overlay.keyboard.type('budg')
  const labels = rows(overlay).locator('.cmdbar__label')
  await expect(labels.filter({ hasText: /^Tab$/ })).toHaveCount(1)
  await expect(labels.filter({ hasText: 'Archived' })).toHaveCount(1)
  await expect(labels.filter({ hasText: 'History' })).toHaveCount(1)
  await expect(rows(overlay).filter({ hasText: 'Budget 2025' })).toHaveAttribute('data-kind', 'archived')
  await expect(rows(overlay).filter({ hasText: 'Budgeting tips' })).toHaveAttribute('data-kind', 'history')
})

test('[CB-09][CB-07] choosing an open tab in another Space switches there instead of duplicating', async () => {
  const alpha = await newTab('Alpha')
  const spaceA = (await state(orbit.app)).spaceOrder[0] as string
  const spaceB = (await run(orbit.app, 'spaces.create', { name: 'Work' })) as string
  await expect.poll(async () => Object.values((await state(orbit.app)).windows)[0]?.spaceId).toBe(spaceB)

  const overlay = await openBar()
  await overlay.keyboard.type('alph')
  const top = rows(overlay).first()
  await expect(top).toHaveAttribute('data-kind', 'tab')
  await expect(top).toContainText('Alpha')
  await overlay.keyboard.press('Enter')
  await expect.poll(async () => Object.values((await state(orbit.app)).windows)[0]?.spaceId).toBe(spaceA)
  expect(await activeTabId(orbit.app)).toBe(alpha)
  expect(await tabCount()).toBe(1)
})

test('[CB-10] arrows move the highlight, hovering highlights, Enter runs the highlighted row', async () => {
  const ids = [await newTab('Gamma one'), await newTab('Gamma two'), await newTab('Gamma three')]
  await run(orbit.app, 'tabs.activate', { tabId: ids[2] })
  const overlay = await openBar()
  await overlay.keyboard.type('gamma')
  await expect(rows(overlay)).toHaveCount(3) // two other tabs + the web search
  await expect(rows(overlay).nth(0)).toHaveAttribute('aria-selected', 'true')
  await overlay.keyboard.press('ArrowDown')
  await overlay.keyboard.press('ArrowDown')
  const third = rows(overlay).nth(2)
  await expect(third).toHaveAttribute('aria-selected', 'true')
  await expect(rows(overlay).nth(0)).toHaveAttribute('aria-selected', 'false')
  // Hover moves it too, once the pointer moves. The bar gets its mouse-moves straight from the test
  // here, so where the OS pointer happens to rest doesn't matter.
  await hoverRow(overlay, 1, 500, 300)
  await hoverRow(overlay, 1, 500, 320)
  await expect(rows(overlay).nth(1)).toHaveAttribute('aria-selected', 'true')
  await overlay.keyboard.press('ArrowDown')
  await expect(third).toHaveAttribute('aria-selected', 'true')
  // Rows that change under a still pointer keep the keyboard's choice: a mouse-move at the same
  // spot over another row (what a re-render under a resting pointer sends) selects nothing.
  await hoverRow(overlay, 0, 500, 320)
  await expect(third).toHaveAttribute('aria-selected', 'true')
  const chosen = (await third.getAttribute('data-id')) as string
  expect(chosen).toMatch(/^tab:/)
  await overlay.keyboard.press('Enter')
  await expect.poll(() => activeTabId(orbit.app)).toBe(chosen.slice(4))
})

test('[CB-11][KS-04] site search: keyword, Tab, query, Enter opens the site’s results; Backspace leaves', async () => {
  const overlay = await openBar()
  await overlay.keyboard.type('yt')
  await expect(rows(overlay).filter({ hasText: 'Search YouTube' })).toHaveCount(1)
  await overlay.keyboard.press('Tab')
  await expect(bar(overlay).getByTestId('command-chip')).toHaveText('YouTube')
  await expect(input(overlay)).toHaveValue('')
  // Backspace on the empty query removes the chip, Tab brings it back.
  await overlay.keyboard.press('Backspace')
  await expect(bar(overlay).getByTestId('command-chip')).toHaveCount(0)
  await overlay.keyboard.type('yt')
  await overlay.keyboard.press('Tab')
  await expect(bar(overlay).getByTestId('command-chip')).toHaveText('YouTube')
  await overlay.keyboard.type('cats')
  await expect(rows(overlay).first()).toContainText('Search YouTube')
  await overlay.keyboard.press('Enter')
  await expect.poll(tabCount).toBe(1)
  const s = await state(orbit.app)
  expect(Object.values(s.tabs)[0]?.url).toBe('https://www.youtube.com/results?search_query=cats')
})

test('[CB-15][CB-07] plain text searches the default engine and the row names it', async () => {
  await orbit.app.evaluate(() => {
    const ctx = (globalThis as unknown as { __orbit: { ctx: { store: { update: (fn: (d: never) => void) => void } } } })
      .__orbit.ctx
    ctx.store.update((d: { settings: { searchEngine: string } }) => {
      d.settings.searchEngine = 'duckduckgo'
    })
  })
  const overlay = await openBar()
  await overlay.keyboard.type('orbit test')
  const top = rows(overlay).first()
  await expect(top).toHaveAttribute('data-kind', 'search')
  await expect(top).toContainText('Search DuckDuckGo')
  await overlay.keyboard.press('Enter')
  await expect.poll(tabCount).toBe(1)
  const s = await state(orbit.app)
  expect(Object.values(s.tabs)[0]?.url.startsWith('https://duckduckgo.com/?q=orbit+test')).toBe(true)
})

test('[CB-08] a visited domain completes inline; Backspace removes the completion; Enter opens the site', async () => {
  await newTab('Alpha')
  const host = hostOfFixtures()
  const overlay = await openBar()
  await overlay.keyboard.type('loc')
  await expect.poll(() => selectionOf(overlay)).toEqual({ value: host, start: 3, end: host.length })
  await overlay.keyboard.press('Backspace')
  await expect.poll(() => selectionOf(overlay)).toEqual({ value: 'loc', start: 3, end: 3 })
  await overlay.keyboard.type('a')
  await expect.poll(async () => (await selectionOf(overlay)).value).toBe(host)
  await overlay.keyboard.press('Enter')
  await expect.poll(tabCount).toBe(2)
  const s = await state(orbit.app)
  const id = (await activeTabId(orbit.app)) as string
  expect(s.tabs[id]?.url).toBe(fx.url('/'))
})

test('[CB-13][CB-06] actions show their shortcut; "pin" and Enter pins the current tab', async () => {
  const id = await newTab('Alpha')
  const overlay = await openBar()
  await overlay.keyboard.type('pin')
  const top = rows(overlay).first()
  await expect(top).toHaveAttribute('data-kind', 'action')
  await expect(top.getByTestId('command-shortcut')).toHaveText(process.platform === 'darwin' ? '⌘D' : 'Ctrl+D')
  await overlay.keyboard.press('Enter')
  await expect
    .poll(async () => (await state(orbit.app)).spaces[(await state(orbit.app)).spaceOrder[0] as string]?.pinned)
    .toContain(id)
})

test('[CB-18] a fresh profile shows suggestions before typing, with no history', async () => {
  const overlay = await openBar()
  await expect(rows(overlay).first()).toBeVisible()
  expect(await rows(overlay).count()).toBeLessThanOrEqual(6)
  await expect(rows(overlay).filter({ has: overlay.locator('[data-kind="history"]') })).toHaveCount(0)
  await expect(overlay.locator('[data-kind="history"]')).toHaveCount(0)
})

test('[CB-19][SP-22] switching Space with the bar open keeps it open; the new tab lands in the new Space and profile', async () => {
  const profile = (await run(orbit.app, 'profiles.create', { name: 'Work profile' })) as string
  await orbit.app.evaluate(({ session }, p) => {
    ;(globalThis as unknown as { __blockNet: (s: Electron.Session) => void }).__blockNet(
      session.fromPartition(`persist:orbit-${p}`),
    )
  }, profile)
  const spaceA = (await state(orbit.app)).spaceOrder[0] as string
  const spaceB = (await run(orbit.app, 'spaces.create', {
    name: 'Work',
    profileId: profile,
    activate: false,
  })) as string
  const overlay = await openBar()
  await run(orbit.app, 'spaces.switch', { spaceId: spaceB })
  await expect(overlay.getByTestId('command-bar')).toBeVisible()
  await overlay.keyboard.type(fx.url('/page/InB'))
  await overlay.keyboard.press('Enter')
  await expect.poll(tabCount).toBe(1)
  const s = await state(orbit.app)
  const tab = Object.values(s.tabs)[0]
  expect(tab?.spaceId).toBe(spaceB)
  expect(tab?.profileId).toBe(profile)
  expect(s.spaces[spaceA]?.today).toHaveLength(0)
})

test('[CB-21] clicking outside the bar closes it and creates nothing', async () => {
  const overlay = await openBar()
  await overlay.keyboard.type('abc')
  // Over the page, away from the bar (a click over the sidebar is passed on to it: CB-20).
  const size = await overlay.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  await overlay.mouse.click(size.w - 40, size.h - 40)
  await expect(overlay.getByTestId('command-bar')).toHaveCount(0)
  expect(await tabCount()).toBe(0)
  await openBar()
  await expect(input(overlay)).toHaveValue('')
})

test('[CB-22][FL-16][FL-17] keys typed right after ⌘T are kept and results follow each keystroke', async () => {
  const overlay = await viewPage(orbit.app, 'overlay')
  await orbit.shell.keyboard.press(`${MOD}+T`)
  await barOpenInMain()
  await overlay.keyboard.type('qwertyuiop', { delay: 30 })
  await expect(input(overlay)).toHaveValue('qwertyuiop')
  await expect(rows(overlay).first()).toHaveAttribute('data-kind', 'search')
  await expect(rows(overlay).first().getByTestId('command-result-title')).toHaveText('qwertyuiop')
  const latencies = await overlay.evaluate(
    () => (window as unknown as { __orbitCommandBar: { latencies: number[] } }).__orbitCommandBar.latencies,
  )
  // Results follow the keystrokes: the upper median of the last 10. The worst keystroke and the open's
  // budget are judged by the budget tests (CB-22 below, FL-17 in feel-commandbar), measured in rounds
  // (D46): one sample or a maximum here would judge the load on the machine more than the bar.
  const last = latencies.slice(-10).sort((a, b) => a - b)
  expect(last.length).toBeGreaterThan(0)
  expect(last[last.length >> 1]).toBeLessThan(50 * FRAME_SLACK)
  // The open is timed too, start to painted.
  const marks = (await orbit.app.evaluate(() =>
    (globalThis as unknown as { __orbit: { marks: () => { name: string; t: number }[] } }).__orbit.marks(),
  )) as { name: string; t: number }[]
  const start = marks.filter((m) => m.name === 'commandbar:open:start').at(-1)?.t ?? 0
  const painted = marks.filter((m) => m.name === 'commandbar:open:painted').at(-1)?.t ?? 0
  expect(painted).toBeGreaterThan(start)
})

test('[CB-22] typing a whole action name and Enter right after ⌘T runs it (no lost keys)', async () => {
  await newTab('Alpha')
  const overlay = await viewPage(orbit.app, 'overlay')
  await orbit.shell.keyboard.press(`${MOD}+T`)
  await barOpenInMain()
  await overlay.keyboard.type('new space')
  await overlay.keyboard.press('Enter')
  // "New Space" opens the creation flow in the sidebar (SP-02); creating from it adds the Space.
  await expect(orbit.shell.getByTestId('new-space-flow')).toBeVisible()
  await orbit.shell.getByTestId('new-space-create').click()
  await expect.poll(async () => (await state(orbit.app)).spaceOrder.length).toBe(2)
})

test('[KS-19] ⌘W closes the bar, not the tab', async () => {
  await newTab('Alpha')
  const overlay = await openBar()
  await overlay.keyboard.press(`${MOD}+W`)
  await expect(overlay.getByTestId('command-bar')).toHaveCount(0)
  expect(await tabCount()).toBe(1)
})

test('[CB-23][CB-05] history is kept per profile and never recorded in private sessions', async () => {
  // A profile on a non-persistent session behaves like a private window.
  const priv = (await run(orbit.app, 'profiles.create', { name: 'Private' })) as string
  await orbit.app.evaluate(({ session }, p) => {
    const ctx = (
      globalThis as unknown as {
        __orbit: {
          ctx: { store: { update: (fn: (d: { profiles: Record<string, { partition: string }> }) => void) => void } }
        }
      }
    ).__orbit.ctx
    ctx.store.update((d) => {
      const profile = d.profiles[p]
      if (profile) profile.partition = `orbit-private-${p}`
    })
    ;(globalThis as unknown as { __blockNet: (s: Electron.Session) => void }).__blockNet(
      session.fromPartition(`orbit-private-${p}`),
    )
  }, priv)
  const spaceP = (await run(orbit.app, 'spaces.create', {
    name: 'Private',
    profileId: priv,
    activate: false,
  })) as string
  await newTab('Normal visit')
  const privTab = (await run(orbit.app, 'tabs.create', {
    url: fx.url('/page/Secret visit'),
    spaceId: spaceP,
  })) as string
  await tabPage(orbit.app, '/page/Secret%20visit')
  await expect.poll(async () => (await state(orbit.app)).tabs[privTab]?.title).toBe('Secret visit')
  const search = (profileId: string, text: string) =>
    run(orbit.app, 'history.search', { profileId, text }) as Promise<{ url: string; title: string }[]>
  await expect.poll(async () => (await search('p-default', 'normal')).map((e) => e.title)).toEqual(['Normal visit'])
  expect(await search(priv, 'secret')).toEqual([])
  expect(await search('p-default', 'secret')).toEqual([])
})

// ---- P1 ----

test('[CB-14] Tab on an empty field lists only actions', async () => {
  await newTab('Alpha')
  const overlay = await openBar()
  await overlay.keyboard.press('Tab')
  await expect(bar(overlay).getByTestId('command-chip')).toHaveText('Actions')
  await overlay.keyboard.type('zoom')
  await expect(rows(overlay).first()).toHaveAttribute('data-kind', 'action')
  await expect(rows(overlay).first()).toContainText('Zoom')
  const kinds = await rows(overlay).evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')))
  expect(new Set(kinds)).toEqual(new Set(['action']))
  await overlay.keyboard.press('Escape')
  await expect(bar(overlay).getByTestId('command-chip')).toHaveCount(0)
})

test('[CB-17] a history row can be removed from the keyboard and stays gone', async () => {
  const id = await newTab('Removable page')
  // A sibling that shows as the same row (trailing slash) must go too (review F13).
  await run(orbit.app, 'tabs.navigate', { tabId: id, url: fx.url('/page/Removable%20page/') })
  await expect.poll(async () => (await state(orbit.app)).tabs[id]?.url).toBe(fx.url('/page/Removable%20page/'))
  await run(orbit.app, 'tabs.navigate', { tabId: id, url: fx.url('/page/Other') })
  await expect.poll(async () => (await state(orbit.app)).tabs[id]?.title).toBe('Other')
  const overlay = await openBar()
  await overlay.keyboard.type('removable')
  const row = rows(overlay).filter({ hasText: 'Removable page' })
  await expect(row).toHaveAttribute('data-kind', 'history')
  const index = await rows(overlay).evaluateAll((els) =>
    els.findIndex((e) => e.textContent?.includes('Removable page')),
  )
  for (let i = 0; i < index; i++) await overlay.keyboard.press('ArrowDown')
  await overlay.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+Backspace' : 'Shift+Delete')
  await expect(rows(overlay).filter({ hasText: 'Removable page' })).toHaveCount(0)
  await overlay.keyboard.press('Escape')
  const again = await openBar()
  await again.keyboard.type('removable')
  await expect(rows(again).first()).toBeVisible()
  await expect(rows(again).filter({ hasText: 'Removable page' })).toHaveCount(0)
})

test('[CB-12] a URL on the clipboard is offered first as Paste and go', async () => {
  const url = fx.url('/page/Clip')
  await orbit.app.evaluate(async ({ clipboard }, u) => {
    await clipboard.writeText(u)
  }, url)
  const overlay = await openBar()
  const top = rows(overlay).first()
  await expect(top).toHaveAttribute('data-kind', 'paste')
  await overlay.keyboard.press('Enter')
  await expect.poll(tabCount).toBe(1)
  expect(Object.values((await state(orbit.app)).tabs)[0]?.url).toBe(url)
})

/** A local OpenSearch-style suggestion endpoint that answers after a delay (ports 3300–3399). */
async function startSuggestServer(delayMs: number) {
  const requests: string[] = []
  const server = createServer((req, res) => {
    const q = new URL(req.url ?? '/', 'http://localhost').searchParams.get('q') ?? ''
    requests.push(q)
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([q, [`${q} browser`, `${q} review`, q]]))
    }, delayMs)
  })
  let port = 3399
  await new Promise<void>((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && port > 3360) server.listen(--port, '127.0.0.1')
      else reject(err)
    })
    server.listen(port, '127.0.0.1', () => resolve())
  })
  const { port: bound } = server.address() as AddressInfo
  return {
    template: `http://127.0.0.1:${bound}/suggest?q=%s`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

/** Relaunches Orbit with engine suggestions pointed at a local endpoint and switched on. */
async function launchWithSuggestions(template: string): Promise<void> {
  await orbit.app.close()
  orbit = await launchOrbit({ env: { ORBIT_SUGGEST_URL: template } })
  await blockNetwork(orbit.app)
  await (await viewPage(orbit.app, 'overlay')).getByTestId('overlay').waitFor({ state: 'attached' })
}

async function enableSuggestions(): Promise<void> {
  await orbit.app.evaluate(() => {
    const ctx = (globalThis as unknown as { __orbit: { ctx: { store: { update: (fn: (d: never) => void) => void } } } })
      .__orbit.ctx
    ctx.store.update((d: { settings: { searchSuggestions: boolean } }) => {
      d.settings.searchSuggestions = true
    })
  })
}

test('[CB-15][CB-05][FL-17] opt-in engine suggestions fill rows below without moving the highlight', async () => {
  const suggest = await startSuggestServer(250)
  await orbit.app.close()
  orbit = await launchOrbit({ env: { ORBIT_SUGGEST_URL: suggest.template } })
  await blockNetwork(orbit.app)
  await (await viewPage(orbit.app, 'overlay')).getByTestId('overlay').waitFor({ state: 'attached' })
  await newTab('Orbit notes')
  await newTab('Elsewhere')
  // Off by default: nothing is fetched.
  expect(await run(orbit.app, 'search.suggest', { query: 'orbit' })).toEqual([])
  await orbit.app.evaluate(() => {
    const ctx = (globalThis as unknown as { __orbit: { ctx: { store: { update: (fn: (d: never) => void) => void } } } })
      .__orbit.ctx
    ctx.store.update((d: { settings: { searchSuggestions: boolean } }) => {
      d.settings.searchSuggestions = true
    })
  })
  const overlay = await openBar()
  await overlay.keyboard.type('orbit')
  await expect(rows(overlay)).toHaveCount(2) // the open tab and the web search, before suggestions arrive
  await overlay.keyboard.press('ArrowDown')
  const highlighted = await rows(overlay).nth(1).getAttribute('data-id')
  const suggestions = rows(overlay).filter({ has: overlay.locator('.cmdbar__label', { hasText: 'Suggestion' }) })
  await expect(suggestions).toHaveCount(2)
  await expect(suggestions.first()).toContainText('orbit browser')
  await expect(rows(overlay).nth(1)).toHaveAttribute('aria-selected', 'true')
  expect(await rows(overlay).nth(1).getAttribute('data-id')).toBe(highlighted)
  await suggest.close()
})

test('[CB-05][CB-13] "Open folder" finds a folder by name and expands it', async () => {
  const tab = await newTab('Soup')
  const spaceId = (await state(orbit.app)).spaceOrder[0] as string
  const folderId = (await run(orbit.app, 'folders.create', {
    container: { kind: 'pinned', spaceId },
    name: 'Recipes',
    items: [tab],
  })) as string
  await run(orbit.app, 'folders.setCollapsed', { folderId, collapsed: true })
  const overlay = await openBar()
  await overlay.keyboard.type('recip')
  const row = rows(overlay).filter({ hasText: 'Recipes' })
  await expect(row).toHaveAttribute('data-kind', 'folder')
  await row.click()
  await expect.poll(async () => (await state(orbit.app)).folders[folderId]?.collapsed).toBe(false)
})

test('[CB-20] clicking a tab in the sidebar while the bar is open selects it in one click', async () => {
  const first = await newTab('First')
  await newTab('Second')
  const overlay = await openBar()
  await overlay.keyboard.type('abc')
  const row = orbit.shell.getByTestId('tab-row').filter({ hasText: 'First' })
  const box = await row.boundingBox()
  expect(box).toBeTruthy()
  await overlay.mouse.click((box?.x ?? 0) + 30, (box?.y ?? 0) + (box?.height ?? 0) / 2)
  await expect(bar(overlay)).toHaveCount(0)
  await expect.poll(() => activeTabId(orbit.app)).toBe(first)
  expect(await tabCount()).toBe(2)
})

test('[SP-22][CB-13] "Move to [Space]" moves the current tab there; this Space stays in view', async () => {
  const keep = await newTab('Stays here')
  const moving = await newTab('Goes to Work')
  const spaceA = (await state(orbit.app)).spaceOrder[0] as string
  const spaceB = (await run(orbit.app, 'spaces.create', { name: 'Work', activate: false })) as string
  const overlay = await openBar()
  await overlay.keyboard.type('move to work')
  await expect(rows(overlay).first()).toContainText('Move to Work')
  await overlay.keyboard.press('Enter')
  await expect.poll(async () => (await state(orbit.app)).spaces[spaceB]?.today).toEqual([moving])
  const s = await state(orbit.app)
  expect(s.spaces[spaceA]?.today).toEqual([keep])
  expect(Object.values(s.windows)[0]?.spaceId).toBe(spaceA)
  expect(await activeTabId(orbit.app)).toBe(keep)
})

test('[CB-14] typing "/ " at the start enters actions mode', async () => {
  const overlay = await openBar()
  await overlay.keyboard.type('/ ')
  await expect(bar(overlay).getByTestId('command-chip')).toHaveText('Actions')
  await expect(input(overlay)).toHaveValue('')
})

test('[CB-22][FL-16] the bar scales in normally and only fades with reduced motion', async () => {
  const overlay = await viewPage(orbit.app, 'overlay')
  /** Transforms of the live bar over its first frames. */
  const sampleOpen = async () => {
    const samples = overlay.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          const out: string[] = []
          const tick = () => {
            const el = document.querySelector('[data-testid="command-bar"]')
            if (el) out.push(getComputedStyle(el).transform)
            if (out.length >= 10) resolve(out)
            else requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        }),
    )
    await orbit.shell.keyboard.press(`${MOD}+T`)
    const result = await samples
    await overlay.keyboard.press('Escape')
    await expect(bar(overlay)).toHaveCount(0)
    return result
  }
  const identity = (t: string) => t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)'
  expect((await sampleOpen()).some((t) => !identity(t))).toBe(true)
  await overlay.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(() => overlay.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
  const reduced = await sampleOpen()
  expect(reduced.every(identity), reduced.join(' | ')).toBe(true)
})

test('[CB-05] history survives a restart and still feeds the bar', async () => {
  const id = await newTab('Persistent page')
  await run(orbit.app, 'tabs.navigate', { tabId: id, url: fx.url('/page/Elsewhere') })
  await expect.poll(async () => (await state(orbit.app)).tabs[id]?.title).toBe('Elsewhere')
  const { userData } = orbit
  await orbit.app.close()
  orbit = await launchOrbit({ userData })
  await blockNetwork(orbit.app)
  await (await viewPage(orbit.app, 'overlay')).getByTestId('overlay').waitFor({ state: 'attached' })
  const overlay = await openBar()
  await overlay.keyboard.type('persistent')
  await expect(rows(overlay).filter({ hasText: 'Persistent page' })).toHaveAttribute('data-kind', 'history')
})

test('[CB-12][KS-04] ⌘⌥V / Ctrl+Alt+V opens the clipboard URL as a new tab', async () => {
  const url = fx.url('/page/Pasted')
  await orbit.app.evaluate(async ({ clipboard }, u) => {
    await clipboard.writeText(u)
  }, url)
  await orbit.shell.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+V' : 'Control+Alt+V')
  await expect.poll(tabCount).toBe(1)
  expect(Object.values((await state(orbit.app)).tabs)[0]?.url).toBe(url)
  // With the bar open, the pasted tab replaces it: the bar closes (review N1).
  const overlay = await openBar()
  await overlay.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+V' : 'Control+Alt+V')
  await expect.poll(tabCount).toBe(2)
  await expect(bar(overlay)).toHaveCount(0)
  await expect.poll(async () => Object.values((await state(orbit.app)).windows)[0]?.overlay.kind).toBe('none')
})

test('[CB-22] IME composition: Enter while composing commits the text and runs nothing', async () => {
  const overlay = await openBar()
  const cdp = await overlay.context().newCDPSession(overlay)
  await cdp.send('Input.imeSetComposition', { text: 'ㅎ', selectionStart: 1, selectionEnd: 1 })
  await cdp.send('Input.imeSetComposition', { text: '하', selectionStart: 1, selectionEnd: 1 })
  // Enter while the composition is active must not choose a row.
  const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...enter })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter })
  await cdp.send('Input.insertText', { text: '한' })
  await expect(input(overlay)).toHaveValue('한')
  await expect(rows(overlay).first().getByTestId('command-result-title')).toHaveText('한')
  expect(await tabCount()).toBe(0)
  await expect(bar(overlay)).toBeVisible()
})

test('[CB-16][KS-04] ⇧Enter opens the first result directly only when the option is on', async () => {
  const setSettings = (fields: Record<string, unknown>) =>
    orbit.app.evaluate((_e, f) => {
      const ctx = (
        globalThis as unknown as { __orbit: { ctx: { store: { update: (fn: (d: never) => void) => void } } } }
      ).__orbit.ctx
      ctx.store.update((d: { settings: Record<string, unknown> }) => {
        Object.assign(d.settings, f)
      })
    }, fields)
  await setSettings({ searchEngine: 'duckduckgo' })
  let overlay = await openBar()
  await overlay.keyboard.type('wikipedia cats')
  await overlay.keyboard.press('Shift+Enter')
  await expect.poll(tabCount).toBe(1)
  // Off by default: a normal search.
  expect(Object.values((await state(orbit.app)).tabs)[0]?.url).toBe('https://duckduckgo.com/?q=wikipedia+cats')
  await setSettings({ searchTopResult: true })
  overlay = await openBar()
  await overlay.keyboard.type('wikipedia cats')
  await overlay.keyboard.press('Shift+Enter')
  await expect.poll(tabCount).toBe(2)
  const urls = Object.values((await state(orbit.app)).tabs).map((t) => t.url)
  expect(urls).toContain('https://duckduckgo.com/?q=%5Cwikipedia+cats')
})

test('[CB-15][CB-03] with engine suggestions on, ⌘L never sends the current address (review M3)', async () => {
  const suggest = await startSuggestServer(0)
  await launchWithSuggestions(suggest.template)
  await newTab('Account')
  await run(orbit.app, 'tabs.navigate', {
    tabId: await activeTabId(orbit.app),
    url: fx.url('/page/Account?reset_token=SECRET123'),
  })
  await expect
    .poll(async () => {
      const s = await state(orbit.app)
      return Object.values(s.tabs)[0]?.url
    })
    .toBe(fx.url('/page/Account?reset_token=SECRET123'))
  await enableSuggestions()
  const overlay = await openBar('L')
  await expect(rows(overlay).first()).toHaveAttribute('data-kind', 'current')
  // Typing another address sends nothing either.
  await overlay.keyboard.type('example.com/private?id=7')
  await expect(rows(overlay).first()).toHaveAttribute('data-kind', 'url')
  await new Promise((r) => setTimeout(r, 600))
  expect(suggest.requests).toEqual([])
  // Plain words still get suggestions.
  await input(overlay).fill('')
  await overlay.keyboard.type('orbit')
  await expect.poll(() => suggest.requests.length).toBeGreaterThan(0)
  expect(suggest.requests.every((q) => !q.includes('SECRET') && !q.includes('://'))).toBe(true)
  await suggest.close()
})

test('[CB-21] after a background close, focus returns to the page when the window comes back (review M4)', async () => {
  const id = await newTab('Focus target')
  const page = await tabPage(orbit.app, '/page/Focus%20target')
  await openBar()
  // Another window takes focus; the bar then closes while Orbit's window is in the background.
  await orbit.app.evaluate(({ BrowserWindow }) => {
    const other = new BrowserWindow({ width: 320, height: 240, show: true })
    ;(globalThis as unknown as { __other: Electron.BrowserWindow }).__other = other
    other.focus()
  })
  const orbitFocused = () =>
    orbit.app.evaluate(() => {
      const hooks = (
        globalThis as unknown as {
          __orbit: {
            ctx: { windows: { get: (id: string) => Electron.BrowserWindow | undefined } }
            windowIds: () => string[]
          }
        }
      ).__orbit
      return hooks.ctx.windows.get(hooks.windowIds()[0] as string)?.isFocused() ?? false
    })
  await expect.poll(orbitFocused).toBe(false)
  await run(orbit.app, 'overlay.close', {})
  // Back to Orbit: the page has keyboard focus, not the sidebar.
  await orbit.app.evaluate(() => {
    const hooks = (
      globalThis as unknown as {
        __orbit: {
          ctx: { windows: { get: (id: string) => Electron.BrowserWindow | undefined } }
          windowIds: () => string[]
        }
      }
    ).__orbit
    hooks.ctx.windows.get(hooks.windowIds()[0] as string)?.focus()
  })
  await expect.poll(orbitFocused).toBe(true)
  // Main's view of keyboard focus: the page's web contents, not the shell (sidebar).
  const focusedUrl = () => orbit.app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL() ?? '')
  await expect.poll(focusedUrl).toContain('/page/Focus%20target')
  expect(await activeTabId(orbit.app)).toBe(id)
  expect(page.url()).toContain('/page/Focus%20target')
  await orbit.app.evaluate(() => (globalThis as unknown as { __other: Electron.BrowserWindow }).__other.destroy())
})

test('[CB-20] right and middle clicks over the sidebar only close the bar (review M5)', async () => {
  await newTab('First')
  const second = await newTab('Second')
  for (const button of ['right', 'middle'] as const) {
    const overlay = await openBar()
    const box = await orbit.shell.getByTestId('tab-row').filter({ hasText: 'First' }).boundingBox()
    expect(box).toBeTruthy()
    await overlay.mouse.click((box?.x ?? 0) + 30, (box?.y ?? 0) + (box?.height ?? 0) / 2, { button })
    await expect(bar(overlay)).toHaveCount(0)
    expect(await activeTabId(orbit.app)).toBe(second)
  }
})

test('[CB-18] Enter on the untouched empty field runs no starter action (review F4)', async () => {
  const overlay = await openBar()
  await expect(rows(overlay).first()).toBeVisible()
  await expect(rows(overlay).filter({ has: overlay.locator('[aria-selected="true"]') })).toHaveCount(0)
  await expect(bar(overlay).locator('[aria-selected="true"]')).toHaveCount(0)
  await overlay.keyboard.press('Enter')
  await new Promise((r) => setTimeout(r, 300))
  const s = await state(orbit.app)
  expect(s.spaceOrder).toHaveLength(1)
  expect(Object.keys(s.tabs)).toHaveLength(0)
  // Arrow down picks the first row explicitly.
  await overlay.keyboard.press('ArrowDown')
  await expect(rows(overlay).first()).toHaveAttribute('aria-selected', 'true')
})

test('[CB-22][CB-07][FL-17] at 500 tabs and 10,000 history entries: open ≤ 50 ms, results ≤ 30 ms per keystroke (review F3)', async () => {
  // Up to three rounds, each in a launch of its own, take 30-60 s on a loaded machine.
  test.setTimeout(120_000)
  // A seeded profile: 10,000 history entries on 800 hosts.
  const words = ['alpha', 'budget', 'cloud', 'design', 'engine', 'forest', 'garden', 'harbor', 'island', 'jungle']
  const userData = mkdtempSync(join(tmpdir(), 'orbit-e2e-perf-'))
  mkdirSync(join(userData, 'history'), { recursive: true })
  const now = Date.now()
  const lines: string[] = []
  for (let i = 0; i < 10_000; i++) {
    const at = now - i * 60_000
    lines.push(
      JSON.stringify({
        t: 'e',
        u: `https://host${i % 800}.example/${words[i % 10]}/page-${i}`,
        ti: `${words[(i * 3) % 10]} article number ${i} about ${words[(i * 7) % 10]}`,
        vc: 1 + (i % 4),
        tc: 0,
        fv: at,
        v: [at],
      }),
    )
  }
  writeFileSync(join(userData, 'history', 'p-default.jsonl'), `${lines.join('\n')}\n`)
  await orbit.app.close()
  const launch = async () => {
    orbit = await launchOrbit({ userData })
    await blockNetwork(orbit.app)
    await (await viewPage(orbit.app, 'overlay')).getByTestId('overlay').waitFor({ state: 'attached' })
  }
  /** Waits until history has loaded and the app's idle warm-up after it has run, as before a user's first search. */
  const settle = async () => {
    await expect
      .poll(async () => ((await run(orbit.app, 'history.search', { text: 'garden', limit: 1 })) as unknown[]).length)
      .toBe(1)
    await new Promise((r) => setTimeout(r, 1800)) // idle warm-up after history loads (as in the app)
  }
  await launch()
  // 500 sleeping tabs.
  await orbit.app.evaluate(async (_e, ws) => {
    const hooks = (
      globalThis as unknown as {
        __orbit: {
          ctx: { commands: { run: (n: string, a: unknown, c: unknown) => Promise<unknown> } }
          windowIds: () => string[]
        }
      }
    ).__orbit
    const windowId = hooks.windowIds()[0]
    for (let i = 0; i < 500; i++) {
      await hooks.ctx.commands.run(
        'tabs.create',
        { url: `http://127.0.0.1:9/${ws[i % 10]}/tab-${i}`, activate: false },
        { windowId },
      )
    }
  }, words)
  await settle()

  const marks = async () =>
    (await orbit.app.evaluate(() =>
      (globalThis as unknown as { __orbit: { marks: () => { name: string; t: number }[] } }).__orbit.marks(),
    )) as { name: string; t: number }[]
  const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)] ?? Number.POSITIVE_INFINITY
  /**
   * One round, in a launch of its own: open the bar five times and type a query each time. The first open is the
   * first after the launch, which a user meets after every launch: it is judged on its own (PR #17 review F2).
   */
  const measure = async () => {
    const overlay = await viewPage(orbit.app, 'overlay')
    // The bar keeps its last 100 timings; this round's are the ones after it starts.
    await overlay.evaluate(() => {
      const timings = (window as unknown as { __orbitCommandBar: { latencies: number[]; replies: number[] } })
        .__orbitCommandBar
      timings.latencies.length = 0
      timings.replies.length = 0
    })
    const opens: number[] = []
    for (let k = 0; k < 5; k++) {
      const before = (await marks()).filter((m) => m.name === 'commandbar:open:painted').length
      await orbit.shell.keyboard.press(`${MOD}+T`)
      await expect
        .poll(async () => (await marks()).filter((m) => m.name === 'commandbar:open:painted').length)
        .toBe(before + 1)
      const m = await marks()
      const start = m.filter((x) => x.name === 'commandbar:open:start').at(-1)?.t ?? 0
      const painted = m.filter((x) => x.name === 'commandbar:open:painted').at(-1)?.t ?? 0
      opens.push(painted - start)
      await overlay.keyboard.type('garden article 4', { delay: 35 })
      await expect(rows(overlay).first()).toBeVisible()
      await overlay.keyboard.press('Escape')
      await expect(bar(overlay)).toHaveCount(0)
    }
    const timings = await overlay.evaluate(
      () => (window as unknown as { __orbitCommandBar: { latencies: number[]; replies: number[] } }).__orbitCommandBar,
    )
    const rest = opens.slice(1).sort((a, b) => a - b)
    return {
      n: timings.replies.length,
      replies: p95(timings.replies),
      painted: p95(timings.latencies),
      opens,
      first: opens[0] ?? Number.POSITIVE_INFINITY,
      // The upper median of the other four: only the slowest of them goes unjudged.
      open: rest[rest.length >> 1] ?? Number.POSITIVE_INFINITY,
    }
  }
  type Round = Awaited<ReturnType<typeof measure>>
  // §8 budgets: results ≤ 30 ms per keystroke (ranked in main and back in the bar), and open ≤ 50 ms to a visible,
  // focused input. FL-17: on screen within 50 ms at worst (this includes waiting for the next frame).
  const meets = (r: Round) =>
    r.replies <= 30 && r.painted <= 50 * FRAME_SLACK && r.first <= 50 * FRAME_SLACK && r.open <= 50 * FRAME_SLACK
  // Other work on a shared machine can only add delay, so a round that misses a budget is measured again, up to three
  // rounds; Orbit's own speed is the best of them (D46). Each retry runs in a fresh launch of the same profile: every
  // round is then the bar's first use after a launch, as a user meets it after every launch, so a slowdown in that
  // first use misses every round instead of passing on a warmer app (PR #17 review M1).
  const rounds: Round[] = []
  while (rounds.length < 3 && !rounds.some(meets)) {
    if (rounds.length > 0) {
      await orbit.app.close()
      await launch()
      await expect.poll(async () => Object.keys((await state(orbit.app)).tabs).length).toBeGreaterThanOrEqual(500)
      await settle()
    }
    const r = await measure()
    rounds.push(r)
    console.info(
      `[commandbar e2e perf] round ${rounds.length}: p95 keystroke→results ${r.replies.toFixed(1)} ms, →painted ${r.painted.toFixed(1)} ms (n=${r.n}); first open after launch ${r.first.toFixed(1)} ms, upper median of the rest ${r.open.toFixed(1)} ms (opens ${r.opens.map((x) => x.toFixed(1)).join(', ')})`,
    )
  }
  const best = rounds.find(meets) ?? (rounds.at(-1) as Round)
  expect(best.n).toBeGreaterThan(40)
  expect(best.replies).toBeLessThanOrEqual(30)
  expect(best.painted).toBeLessThanOrEqual(50 * FRAME_SLACK)
  expect(best.first).toBeLessThanOrEqual(50 * FRAME_SLACK)
  expect(best.open).toBeLessThanOrEqual(50 * FRAME_SLACK)
})
