import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { TWEAK_EDITOR } from '../../src/shared/commands/tweaks'
import { isMac, launchOrbit, MOD, type Orbit, run, state, tabPage, tabView, viewPage } from './helpers'
import { clickInPage, focusedUrl, pressInPage } from './nav-support'
import { remoteRequests } from './settings-support'
import { act, cmd, newTab, tabsHook, waitTab } from './tabs-support'
import {
  bgOf,
  edited,
  editorInfo,
  editorPage,
  firstFrame,
  mark,
  marked,
  near,
  newDocument,
  openFixture,
  pageTweaks,
  recordFrames,
  rgbOf,
  SLOW_BLOCKS,
  startTweakFixtures,
  type TweakFixtures,
  tweakList,
  waitEditor,
  waitEditorShown,
  zoomOf,
} from './tweaks-support'

/** Tweaks (BO-*): per-site restyling, kept on this device. Feature IDs lead each title. */

let fx: TweakFixtures
let orbit: Orbit | undefined

test.beforeAll(async () => {
  fx = await startTweakFixtures()
})
test.afterAll(async () => {
  await fx.close()
})
test.afterEach(async () => {
  await orbit?.app.close()
  orbit = undefined
})

/** A tab on fixture page `path` (on `host`), loaded. */
const openPage = (app: ElectronApplication, path: string, host?: string) => openFixture(app, fx, path, host)

type Points = { x: number; y: number }[]

/**
 * Where to look in a `/slow` page's frames: its background below everything, and the block that
 * changes colour with each load (it tells the new document's frames from the old one's).
 */
const slowPoints = (page: Page): Promise<Points> =>
  page.evaluate(() => {
    const r = (document.getElementById('block') as HTMLElement).getBoundingClientRect()
    return [
      { x: 0.5, y: 0.85 },
      { x: (r.x + r.width / 2) / innerWidth, y: (r.y + r.height / 2) / innerHeight },
    ]
  })

/**
 * Records what a `/slow` page paints, at `points` (`slowPoints`), while `action` loads it again, as
 * its `load`-th load: the new document must paint while it is still loading, and every frame of it
 * must have the Tweak's background (`bg`), never the page's own.
 */
async function everyFrameTweaked(
  app: ElectronApplication,
  page: Page,
  tabId: string,
  points: Points,
  load: number,
  action: () => Promise<unknown>,
  bg = '#202020',
): Promise<void> {
  const recording = await recordFrames(app, tabId, points)
  await action()
  await expect
    .poll(() => page.evaluate(() => document.getElementById('block')?.dataset.load).catch(() => null))
    .toBe(String(load))
  await expect.poll(() => page.evaluate(() => !!document.getElementById('end')).catch(() => false)).toBe(true)
  const frames = await recording.stop()
  const fresh = frames.filter((f) => near(f.colors[1] as string, SLOW_BLOCKS[load] as string))
  const whileLoading = fresh.filter((f) => f.t < frames[frames.length - 1]!.t)
  // The new document painted while it was still loading…
  expect(fresh.length, JSON.stringify(frames)).toBeGreaterThan(0)
  expect(whileLoading.length, JSON.stringify(frames)).toBeGreaterThan(0)
  // …and every frame of it has the Tweak's background, never the page's own.
  expect(
    fresh.filter((f) => !near(f.colors[0] as string, bg)),
    JSON.stringify(frames),
  ).toEqual([])
  const [r, g, b] = rgbOf(bg)
  expect((await firstFrame(page))?.bg).toBe(`rgb(${r}, ${g}, ${b})`)
}

/** Every sheet a `/slow` page could read: from its `<head>` (`when: 'head'`), or now. */
type Readable = { media: string; rules: string }[]
const readable = (page: Page, when: 'head' | 'now'): Promise<Readable> =>
  page.evaluate((w) => {
    const g = window as unknown as { __readable: Readable; __read: () => Readable }
    return w === 'head' ? g.__readable : g.__read()
  }, when)

test('[BO-01][BO-21] every entry point makes a Tweak for the shown site and opens the editor on it, named after the site; the intro shows once; nothing reloads', async () => {
  orbit = await launchOrbit()
  const { app, shell } = orbit
  const { tabId, page } = await openPage(app, '/page/Alpha')
  await mark(page)
  // 1. The command bar: "customize" finds New Tweak….
  await shell.keyboard.press(`${MOD}+T`)
  const overlay = await viewPage(app, 'overlay')
  const input = overlay.getByTestId('command-bar').getByTestId('command-input')
  await expect(input).toBeFocused()
  await input.fill('customize')
  const row = overlay.getByTestId('command-bar').getByTestId('command-result').filter({ hasText: 'New Tweak…' })
  await expect(row.first()).toBeVisible()
  // No key by default (BO-01): the row shows none.
  await expect(row.first().getByTestId('command-shortcut')).toHaveCount(0)
  await row.first().click()
  await waitEditor(app, true)
  const first = await edited(app)
  expect(first).toMatchObject({ host: 'localhost', name: 'localhost', enabled: true })
  expect((await editorInfo(app)).tabId).toBe(tabId)
  // The panel has the keyboard; the first time, it shows the intro, once.
  await expect.poll(async () => (await editorInfo(app)).focused).toBe(true)
  const view = await editorPage(app)
  await expect(view.getByTestId('tweak-intro')).toBeVisible()
  await expect(view.getByTestId('tweak-intro')).toContainText('localhost')
  await view.getByTestId('tweak-intro-start').click()
  await expect(view.getByTestId('tweak-intro')).toHaveCount(0)
  await expect(view.getByTestId('tweak-size')).toHaveText('100%')
  await expect.poll(async () => (await state(app)).settings.tweakIntroSeen).toBe(true)
  // Left as it was made (nothing changed, the site's name), it goes as the panel closes.
  await pressInPage(app, 'view=tweak', 'Escape')
  await waitEditor(app, false)
  expect(await tweakList(app)).toEqual([])

  // 2. The sidebar's + menu.
  await shell.getByTestId('sidebar-plus').click()
  await overlay.getByTestId('menu-plus-tweak').click()
  await waitEditor(app, true)
  expect((await edited(app)).host).toBe('localhost')
  await expect(view.getByTestId('tweak-intro')).toHaveCount(0)
  await expect.poll(async () => (await editorInfo(app)).focused).toBe(true)
  await view.getByTestId('tweak-close').click()
  await waitEditor(app, false)

  // 3. The site controls panel.
  await shell.getByTestId('site-controls-button').click()
  await overlay.getByTestId('site-controls').getByTestId('site-tweak-new').click()
  await waitEditor(app, true)
  expect((await edited(app)).host).toBe('localhost')
  await view.getByTestId('tweak-done').click()
  await waitEditor(app, false)
  expect(await tweakList(app)).toEqual([])

  // 4. The paintbrush in the address field, shown with the field's other buttons.
  await shell.getByTestId('address').hover()
  const brush = shell.getByTestId('tweak-button')
  await expect(brush).toHaveAttribute('data-state', 'none')
  await expect(brush).toBeVisible()
  await brush.click()
  await waitEditor(app, true)
  // A change keeps it: the page shows it at once.
  await view.getByTestId('tweak-size-up').click()
  await expect.poll(() => zoomOf(page)).toBe('1.1')
  const kept = await edited(app)
  expect(kept.style.size).toBe(110)
  await view.getByTestId('tweak-done').click()
  await waitEditor(app, false)
  expect((await tweakList(app)).map((t) => t.id)).toEqual([kept.id])
  await expect(brush).toHaveAttribute('data-state', 'on')

  // 5. The tab's menu: a second Tweak for the same site, beside the first.
  await cmd(app, 'tabs.contextMenu', { id: tabId })
  expect(await tabsHook<string[]>(app, 'lastMenu')).toContain('Tweak this Site…')
  expect(await tabsHook<boolean>(app, 'clickMenu', 'Tweak this Site…')).toBe(true)
  await waitEditor(app, true)
  const second = await edited(app)
  expect(second.id).not.toBe(kept.id)
  expect((await tweakList(app)).map((t) => t.host)).toEqual(['localhost', 'localhost'])
  await pressInPage(app, 'view=tweak', 'Escape')
  await waitEditor(app, false)
  expect((await tweakList(app)).map((t) => t.id)).toEqual([kept.id])

  // Making Tweaks neither reloaded nor navigated the page.
  expect(await marked(page)).toBe(true)
  expect((await state(app)).tabs[tabId]?.url).toBe(fx.url('/page/Alpha'))
})

test('[BO-01][KS-18] an internal page takes no Tweak: the entry points are greyed or gone and the action says why; a key given to New Tweak… shows in the tab’s menu', async () => {
  orbit = await launchOrbit()
  const { app, shell } = orbit
  const { tabId } = await openPage(app, '/page/Bravo')
  expect(await run(app, 'keys.bind', { actionId: 'tweak.new', accel: `${isMac ? 'Cmd' : 'Ctrl'}+Shift+Y` })).toEqual({
    ok: true,
  })
  await cmd(app, 'tabs.contextMenu', { id: tabId })
  const hints = await app.evaluate(() =>
    (globalThis as unknown as { __orbitKeys: { lastMenuHints: () => string[] } }).__orbitKeys.lastMenuHints(),
  )
  expect(hints).toContain(`Tweak this Site…=${isMac ? 'Command' : 'Control'}+Shift+Y`)

  const history = await newTab(app, 'orbit://history/')
  await expect.poll(async () => (await state(app)).tabs[history]?.url).toBe('orbit://history/')
  await act(app, 'tweak.new')
  await expect(shell.getByTestId('toast').filter({ hasText: 'Tweaks work on websites only' })).toBeVisible()
  expect((await editorInfo(app)).open).toBe(false)
  expect(await tweakList(app)).toEqual([])
  await expect(shell.getByTestId('tweak-button')).toHaveCount(0)
  await cmd(app, 'tabs.contextMenu', { id: history })
  expect(await tabsHook<string[]>(app, 'lastMenu')).not.toContain('Tweak this Site…')
  await shell.getByTestId('sidebar-plus').click()
  const overlay = await viewPage(app, 'overlay')
  await expect(overlay.getByTestId('menu-plus-tweak')).toBeDisabled()
  await overlay.keyboard.press('Escape')
  // A Tweak made for the site never reaches the internal page (D40).
  expect(await pageTweaks(app, history)).toBeNull()
})

test('[BO-02][KS-19] the editor is a small view of its own over the page’s top-right corner, sized to the panel; the page stays live; Esc, ✕ and Done close it, the page gets the keyboard back, and it reopens as it was', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  await run(app, 'tweaks.dismissIntro', {})
  const { tabId, page } = await openPage(app, '/page/Charlie')
  await act(app, 'tweak.new')
  const info = await waitEditorShown(app)
  const view = await editorPage(app)
  await expect(view.getByTestId('tweak-size')).toBeVisible()

  // Its own view, as wide as the panel and its shadow's margin, at the page's top-right corner.
  const pageRect = (await tabView(app, tabId))?.bounds
  if (!pageRect || !info.bounds) throw new Error('no bounds')
  const { margin, inset, width } = TWEAK_EDITOR
  expect(info.bounds.width).toBe(width + 2 * margin)
  expect(info.bounds.x + info.bounds.width).toBe(pageRect.x + pageRect.width - inset + margin)
  expect(info.bounds.y).toBe(pageRect.y + inset - margin)
  // As tall as the panel: no more of the page is covered than the panel needs.
  const panelHeight = await view.getByTestId('tweak-panel').evaluate((el) => el.getBoundingClientRect().height)
  expect(Math.abs(info.bounds.height - (panelHeight + 2 * margin))).toBeLessThanOrEqual(2)
  // Inside the page, and a narrow column of it: most of the page shows beside the panel.
  expect(info.bounds.y + info.bounds.height).toBeLessThanOrEqual(pageRect.y + pageRect.height)
  expect(info.bounds.width).toBeLessThan(pageRect.width / 2)
  await expect.poll(async () => (await editorInfo(app)).focused).toBe(true)

  // Every change shows at once, and is saved as it is made.
  await view.getByTestId('tweak-size-up').click()
  await expect(view.getByTestId('tweak-size')).toHaveText('110%')
  await expect.poll(() => zoomOf(page)).toBe('1.1')
  const tweakId = (await editorInfo(app)).tweakId as string
  expect((await state(app)).tweaks[tweakId]?.style.size).toBe(110)

  // The page around it stays live: it takes a click, and the panel stays.
  await clickInPage(app, '/page/Charlie', '#count')
  await expect.poll(() => page.evaluate(() => (window as unknown as { __clicks?: number }).__clicks)).toBe(1)
  expect((await editorInfo(app)).open).toBe(true)

  // Esc in the panel closes it; the page has the keyboard again.
  await pressInPage(app, 'view=tweak', 'Escape')
  await waitEditor(app, false)
  expect((await editorInfo(app)).placed).toBe(false)
  await expect.poll(() => focusedUrl(app)).toContain('/page/Charlie')
  // Every edit was kept.
  expect((await state(app)).tweaks[tweakId]?.style.size).toBe(110)
  expect(await zoomOf(page)).toBe('1.1')

  // Edit Tweak (the site's one Tweak) reopens it with its values; ✕ closes it.
  await act(app, 'tweak.edit')
  await waitEditorShown(app)
  expect((await editorInfo(app)).tweakId).toBe(tweakId)
  await expect(view.getByTestId('tweak-size')).toHaveText('110%')
  await view.getByTestId('tweak-close').click()
  await waitEditor(app, false)

  // The site controls panel's › reopens it too; Done closes it.
  await orbit.shell.getByTestId('site-controls-button').click()
  const overlay = await viewPage(app, 'overlay')
  const tweakRow = overlay.getByTestId('site-controls').getByTestId('site-tweak')
  await expect(tweakRow).toHaveCount(1)
  await tweakRow.getByTestId('site-tweak-edit').click()
  await waitEditorShown(app)
  expect((await editorInfo(app)).tweakId).toBe(tweakId)
  await view.getByTestId('tweak-done').click()
  await waitEditor(app, false)
  await expect.poll(() => focusedUrl(app)).toContain('/page/Charlie')
})

test('[BO-02] the editor follows its page: another page of the site keeps it open, another site or tab closes it; dragged by its title it moves, kept inside the page', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  await run(app, 'tweaks.dismissIntro', {})
  const { tabId, page } = await openPage(app, '/page/Delta')
  await act(app, 'tweak.new')
  await waitEditorShown(app)
  const view = await editorPage(app)
  await view.getByTestId('tweak-size-up').click()
  await expect.poll(() => zoomOf(page)).toBe('1.1')

  // Another page of the same site: the panel stays, and the Tweak is on that page too (BO-01).
  await mark(page)
  await clickInPage(app, '/page/Delta', '#next')
  await expect.poll(async () => (await state(app)).tabs[tabId]?.url).toContain('/page/Delta-next')
  await waitTab(app, tabId, '/page/Delta-next')
  await newDocument(page)
  expect((await firstFrame(page))?.zoom).toBe('1.1')
  expect((await editorInfo(app)).open).toBe(true)

  // Dragged by its title, it moves with the pointer.
  const before = (await editorInfo(app)).bounds
  const head = view.locator('.tweak-panel__head')
  const box = await head.boundingBox()
  if (!before || !box) throw new Error('no bounds')
  const start = { x: box.x + 40, y: box.y + box.height / 2 }
  await view.mouse.move(start.x, start.y)
  await view.mouse.down()
  await view.mouse.move(start.x - 120, start.y + 70)
  await view.mouse.up()
  await expect
    .poll(async () => {
      const b = (await editorInfo(app)).bounds
      return b ? { dx: b.x - before.x, dy: b.y - before.y } : null
    })
    .toEqual({ dx: -120, dy: 70 })
  // Never out of the page: a drag far up and right stops at its corner.
  const pageRect = (await tabView(app, tabId))?.bounds
  if (!pageRect) throw new Error('no page')
  const moved = (await editorInfo(app)).bounds as NonNullable<typeof before>
  const box2 = await head.boundingBox()
  if (!box2) throw new Error('no head')
  await view.mouse.move(box2.x + 40, box2.y + box2.height / 2)
  await view.mouse.down()
  await view.mouse.move(box2.x + 40 + 2000, box2.y + box2.height / 2 - 2000)
  await view.mouse.up()
  await expect
    .poll(async () => (await editorInfo(app)).bounds)
    .toEqual({
      x: pageRect.x + pageRect.width - TWEAK_EDITOR.width - TWEAK_EDITOR.margin,
      y: pageRect.y - TWEAK_EDITOR.margin,
      width: moved.width,
      height: moved.height,
    })

  // Another site in the tab: the panel closes; the Tweak stays with its site.
  await cmd(app, 'tabs.navigate', { tabId, url: fx.url('/page/Elsewhere', '127.0.0.1') })
  await waitEditor(app, false)
  await waitTab(app, tabId, '/page/Elsewhere')
  expect(await zoomOf(page)).toBe('1')
  expect((await tweakList(app)).map((t) => t.style.size)).toEqual([110])

  // Back on the site, reopened: then another tab closes it.
  await cmd(app, 'tabs.back', { tabId })
  await waitTab(app, tabId, '/page/Delta-next')
  await act(app, 'tweak.edit')
  await waitEditorShown(app)
  await openPage(app, '/page/Echo', '127.0.0.1')
  await waitEditor(app, false)
})

test('[BO-18] a Tweak is in the page from its first frame: a hard reload and a first visit of a page that paints before it is ready never show it without the Tweak', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const slow = '/slow/Dark?bg=%23ffffff&ms=900'
  const { tabId, page } = await openPage(app, slow)
  await expect.poll(() => page.evaluate(() => !!document.getElementById('end'))).toBe(true)
  const id = (await run(app, 'tweaks.create', { tabId })) as string
  await run(app, 'tweaks.update', { id, patch: { css: 'body { background: #202020 }' } })
  await run(app, 'tweaks.closeEditor', {})
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(32, 32, 32)')

  const points = await slowPoints(page)
  // A hard reload, as the spec's own check does.
  await everyFrameTweaked(app, page, tabId, points, 1, () => cmd(app, 'tabs.reload', { tabId, ignoreCache: true }))
  // A first visit from another site (a new renderer process).
  await cmd(app, 'tabs.navigate', { tabId, url: fx.url('/page/Before', '127.0.0.1') })
  await waitTab(app, tabId, '/page/Before')
  await everyFrameTweaked(app, page, tabId, points, 2, () => cmd(app, 'tabs.navigate', { tabId, url: fx.url(slow) }))
  // Main's own copy replaced the page preload's once the document was ready.
  await expect.poll(async () => (await pageTweaks(app, tabId))?.preloaded).toBe(false)
  expect(await page.evaluate(() => document.adoptedStyleSheets.length)).toBe(0)
})

test('[BO-18] the page can’t read, drop or outrank the sheets that come before its first paint: its <head> finds no Tweak, and a page that sets its own adopted sheets, or a layered !important background, shows no frame without the Tweak', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  // A page whose <head> sets its adopted sheets to one of its own, as some sites do.
  const own = '/slow/Own?bg=%23ffffff&ms=900&adopt=1'
  const { tabId, page } = await openPage(app, own)
  await expect.poll(() => page.evaluate(() => !!document.getElementById('end'))).toBe(true)
  const id = (await run(app, 'tweaks.create', { tabId })) as string
  const css = 'body { background: #202020 }\n#title::after { content: " (a private note)" }'
  await run(app, 'tweaks.update', { id, patch: { css } })
  await run(app, 'tweaks.closeEditor', {})
  await expect.poll(() => bgOf(page)).toBe('rgb(32, 32, 32)')
  const points = await slowPoints(page)
  await everyFrameTweaked(app, page, tabId, points, 1, () => cmd(app, 'tabs.reload', { tabId, ignoreCache: true }))

  // What the page could read, from its <head> and now: only its own sheets, nothing of the Tweak.
  const tweakIn = (sheets: Readable) =>
    sheets.filter((s) => /orbit|private note|32, 32, 32|#202020/i.test(s.media + s.rules))
  const head = await readable(page, 'head')
  expect(tweakIn(head), JSON.stringify(head)).toEqual([])
  expect(head.map((s) => s.media)).toEqual([''])
  const now = await readable(page, 'now')
  expect(tweakIn(now), JSON.stringify(now)).toEqual([])
  expect(now.map((s) => s.rules.includes('letter-spacing'))).toEqual([false, true])

  // A page whose background is also set in a cascade layer of its own, !important, as CSS from a
  // framework can be: the Tweak's still wins, from the first frame.
  await cmd(app, 'tabs.navigate', { tabId, url: fx.url('/slow/Layer?bg=%23ffffff&ms=900&layer=1') })
  await waitTab(app, tabId, '/slow/Layer')
  const layered = await tabPage(app, '/slow/Layer')
  await expect.poll(() => bgOf(layered)).toBe('rgb(32, 32, 32)')
  await everyFrameTweaked(app, layered, tabId, points, 1, () => cmd(app, 'tabs.reload', { tabId, ignoreCache: true }))
  expect(tweakIn(await readable(layered, 'head'))).toEqual([])
})

test('[BO-02][BO-14][BO-16] while the page is still loading, a Tweak turned off or on, an edit and the switch for all of them show within a few frames', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const { tabId, page } = await openPage(app, '/held/Busy')
  const id = (await run(app, 'tweaks.create', { tabId })) as string
  await run(app, 'tweaks.update', { id, patch: { css: 'body { background: #202020 }' } })
  await run(app, 'tweaks.closeEditor', {})
  await expect.poll(() => bgOf(page)).toBe('rgb(32, 32, 32)')

  // A load that its image holds for 8 s: the page is ready, and has its Tweak, long before it ends.
  await mark(page)
  await cmd(app, 'tabs.navigate', { tabId, url: fx.url('/held/Busy?ms=8000') })
  await newDocument(page)
  expect(await firstFrame(page)).toMatchObject({ bg: 'rgb(32, 32, 32)' })
  // Main's own copy is in.
  await expect.poll(async () => (await pageTweaks(app, tabId))?.parts.length).toBeGreaterThan(0)
  // The page notes, in each of its frames, its background and whether it is still loading.
  await page.evaluate(() => {
    const log: [number, string, string][] = []
    Object.assign(window, { __frames: log })
    const tick = () => {
      log.push([
        performance.timeOrigin + performance.now(),
        getComputedStyle(document.body).backgroundColor,
        document.readyState,
      ])
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  type Frame = [number, string, string]
  const framesSince = (t0: number) =>
    page.evaluate((t) => (window as unknown as { __frames: Frame[] }).__frames.filter(([at]) => at >= t), t0)
  /** The frames the page painted between a change and the first that shows it; that frame's state. */
  const change = async (what: () => Promise<unknown>, bg: string) => {
    const t0 = await page.evaluate(() => performance.timeOrigin + performance.now())
    await what()
    await expect.poll(async () => (await framesSince(t0)).some(([, b]) => b === bg), { timeout: 4000 }).toBe(true)
    const after = await framesSince(t0)
    const shown = after.findIndex(([, b]) => b === bg)
    return { frames: shown, loading: after[shown]?.[2], ms: Math.round((after[shown]?.[0] ?? Number.NaN) - t0) }
  }
  const results = {
    off: await change(() => run(app, 'tweaks.setEnabled', { id, enabled: false }), 'rgb(255, 255, 255)'),
    on: await change(() => run(app, 'tweaks.setEnabled', { id, enabled: true }), 'rgb(32, 32, 32)'),
    edit: await change(
      () => run(app, 'tweaks.update', { id, patch: { css: 'body { background: #303030 }' } }),
      'rgb(48, 48, 48)',
    ),
    all: await change(() => run(app, 'tweaks.setGlobal', { enabled: false }), 'rgb(255, 255, 255)'),
  }
  const report = JSON.stringify(results)
  for (const r of Object.values(results)) {
    expect(r.loading, report).toBe('interactive')
    expect(r.frames, report).toBeGreaterThanOrEqual(0)
    expect(r.frames, report).toBeLessThanOrEqual(12)
  }
  console.log(`[BO-14] changes while loading: ${report}`)
})

test('[BO-18][BO-01] a Tweak survives reloads, other pages of its site, back and forward, a closed tab reopened, a sleeping tab woken and a restart', async () => {
  orbit = await launchOrbit()
  const { app, userData } = orbit
  const { tabId, page } = await openPage(app, '/page/Keep')
  const id = (await run(app, 'tweaks.create', { tabId })) as string
  await run(app, 'tweaks.update', { id, patch: { style: { size: 125 } } })
  await run(app, 'tweaks.closeEditor', {})
  await expect.poll(() => zoomOf(page)).toBe('1.25')

  const firstZoom = async (p: Page) => (await firstFrame(p))?.zoom
  // A reload.
  await mark(page)
  await cmd(app, 'tabs.reload', { tabId })
  await newDocument(page)
  expect(await firstZoom(page)).toBe('1.25')
  // Another site, then back and forward.
  await mark(page)
  await cmd(app, 'tabs.navigate', { tabId, url: fx.url('/page/Other', '127.0.0.1') })
  await newDocument(page)
  expect(await firstZoom(page)).toBe('1')
  await mark(page)
  await cmd(app, 'tabs.back', { tabId })
  await newDocument(page)
  expect(page.url()).toContain('/page/Keep')
  expect(await firstZoom(page)).toBe('1.25')
  await mark(page)
  await cmd(app, 'tabs.forward', { tabId })
  await newDocument(page)
  expect(await firstZoom(page)).toBe('1')
  await mark(page)
  await cmd(app, 'tabs.back', { tabId })
  await newDocument(page)

  // Closed and reopened.
  await cmd(app, 'tabs.close', { tabId })
  await expect.poll(async () => (await state(app)).tabs[tabId]).toBeUndefined()
  const reopened = (await cmd(app, 'tabs.reopenClosed', {})) as string
  await waitTab(app, reopened, '/page/Keep')
  const again = await tabPage(app, '/page/Keep')
  await expect.poll(() => firstZoom(again)).toBe('1.25')

  // Asleep in the background, then woken.
  const other = await openPage(app, '/page/Front', '127.0.0.1')
  const after = (await state(app)).settings.sleepAfterMs
  const slept = await tabsHook<{ slept: string[] }>(app, 'maintenance', Date.now() + after + 60_000)
  expect(slept.slept).toContain(reopened)
  await cmd(app, 'tabs.activate', { tabId: reopened })
  await waitTab(app, reopened, '/page/Keep')
  await expect.poll(async () => firstZoom(await tabPage(app, '/page/Keep'))).toBe('1.25')
  expect(other.tabId).not.toBe(reopened)

  // A restart: the Tweak and the page come back, the page with it from its first frame.
  await cmd(app, 'tabs.activate', { tabId: reopened })
  await app.close()
  orbit = await launchOrbit({ userData })
  const restored = orbit.app
  const tweaks = await tweakList(restored)
  expect(tweaks.map((t) => [t.host, t.style.size])).toEqual([['localhost', 125]])
  const keep = Object.values((await state(restored)).tabs).find((t) => t.url.includes('/page/Keep'))
  if (!keep) throw new Error('the tab was not restored')
  await cmd(restored, 'tabs.activate', { tabId: keep.id })
  await waitTab(restored, keep.id, '/page/Keep')
  await expect.poll(async () => firstZoom(await tabPage(restored, '/page/Keep'))).toBe('1.25')
})

test('[BO-02][BO-18] making and editing a Tweak asks no server anything: no request but the page’s own names the site', async () => {
  const netLog = join(mkdtempSync(join(tmpdir(), 'orbit-netlog-')), 'netlog.json')
  const host = 'tweak-site.test'
  orbit = await launchOrbit({
    args: [`--log-net-log=${netLog}`, `--host-resolver-rules=MAP ${host} 127.0.0.1`, `--proxy-bypass-list=${host}`],
  })
  const { app, shell } = orbit
  const { tabId, page } = await openPage(app, '/page/Private', host)
  await shell.getByTestId('address').hover()
  await shell.getByTestId('tweak-button').click()
  await waitEditorShown(app)
  const view = await editorPage(app)
  await view.getByTestId('tweak-intro-start').click()
  await view.getByTestId('tweak-size-up').click()
  await view.getByTestId('tweak-size-up').click()
  await expect.poll(() => zoomOf(page)).toBe('1.25')
  await pressInPage(app, 'view=tweak', 'Escape')
  await waitEditor(app, false)
  // A reload asks for the Tweak again, from this computer only.
  await mark(page)
  await cmd(app, 'tabs.reload', { tabId })
  await newDocument(page)
  expect((await firstFrame(page))?.zoom).toBe('1.25')
  await app.close()
  orbit = undefined
  const own = `http://${host}:${fx.port}/`
  // Requests that left this computer: only the page's own (its server is the site), and Chromium's
  // spell-check dictionary on Linux (see onboarding.spec.ts).
  const remote = remoteRequests(netLog).filter(
    (url) => !url.startsWith(own) && !/^https:\/\/redirector\.gvt1\.com\/edgedl\/chrome\/dict\//.test(url),
  )
  expect(remote).toEqual([])
  // The site's server heard only page loads: nothing about the Tweak.
  expect(
    fx
      .seen()
      .filter((r) => r.startsWith(`${host}:`))
      .every((r) => / GET \/page\/Private/.test(r)),
  ).toBe(true)
})
