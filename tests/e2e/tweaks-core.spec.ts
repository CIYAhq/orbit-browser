import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { TWEAK_EDITOR } from '../../src/shared/commands/tweaks'
import { action, isMac, launchOrbit, MOD, type Orbit, run, state, tabPage, viewPage } from './helpers'
import { cmdIn, pressInPage, uiPageOf, windowList } from './nav-support'
import { act, cmd, waitTab } from './tabs-support'
import {
  bgOf,
  editorInfo,
  editorPage,
  editorPageOf,
  firstFrame,
  mark,
  marked,
  newDocument,
  openFixture,
  pageTweaks,
  startTweakFixtures,
  type TweakFixtures,
  waitEditor,
  zoomOf,
} from './tweaks-support'

/** Tweaks' core controls (BO-11, BO-14, BO-17, BO-21). Feature IDs lead each title. */

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

const openPage = (app: ElectronApplication, path: string, host?: string) => openFixture(app, fx, path, host)

const WHITE = 'rgb(255, 255, 255)'
const NAVY = 'rgb(18, 52, 86)'

/** A new Tweak for a tab's site, made as New Tweak… does, its editor open (the intro already read). */
async function newTweak(app: ElectronApplication, tabId: string): Promise<{ id: string; view: Page }> {
  await run(app, 'tweaks.dismissIntro', {})
  const id = (await run(app, 'tweaks.create', { tabId })) as string
  await waitEditor(app, true)
  return { id, view: await editorPage(app) }
}

/** Changes a Tweak as the editor does (test setup). */
const update = (app: ElectronApplication, id: string, patch: Record<string, unknown>) =>
  run(app, 'tweaks.update', { id, patch })

/** A value the page's own scripts can read (the page's main world). */
const pageValue = <T>(page: Page, name: string) =>
  page.evaluate((n) => (window as unknown as Record<string, unknown>)[n] as T | undefined, name).catch(() => undefined)

/** The editor's CSS or JavaScript field. */
const field = (view: Page, language: 'css' | 'js') => view.getByTestId(`tweak-${language}-input`)

test('[BO-11] CSS typed in the code area shows in the page within 0.3 s, is saved as typed and stays after a reload; the editor colours it, numbers its lines, indents with Tab and undoes with ⌘Z', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const { tabId, page } = await openPage(app, '/page/Code')
  const { id, view } = await newTweak(app, tabId)

  // The code button opens the code area; the panel widens to the left, its right edge kept.
  const narrow = (await editorInfo(app)).bounds
  await view.getByTestId('tweak-code-button').click()
  await expect(view.getByTestId('tweak-code')).toBeVisible()
  await expect
    .poll(async () => (await editorInfo(app)).bounds?.width)
    .toBe(TWEAK_EDITOR.wideWidth + 2 * TWEAK_EDITOR.margin)
  const wide = (await editorInfo(app)).bounds
  if (!narrow || !wide) throw new Error('no bounds')
  expect(wide.x + wide.width).toBe(narrow.x + narrow.width)
  await expect(view.getByTestId('tweak-code-css-tab')).toHaveAttribute('aria-selected', 'true')
  // It starts empty (BO-11).
  await expect(field(view, 'css')).toHaveValue('')

  // Typed: the page shows it once the rule is whole; main has it as typed.
  const css = field(view, 'css')
  await css.click()
  await css.pressSequentially('body { background: yellow }')
  await expect.poll(() => bgOf(page)).toBe('rgb(255, 255, 0)')
  await expect.poll(async () => (await state(app)).tweaks[id]?.css).toBe('body { background: yellow }')
  // Coloured as code, as text: the coloured copy is the field's text exactly.
  const layer = view.getByTestId('tweak-css').locator('.code-editor__layer')
  await expect(layer.locator('.tok-selector')).toHaveText('body')
  await expect(layer.locator('.tok-property')).toHaveText('background')
  expect(await layer.evaluate((el) => el.textContent)).toBe('body { background: yellow }\n')

  // ⌘Z / Ctrl+Z, through Orbit's own key handling, is the field's undo, and the page follows.
  await css.fill('')
  await expect.poll(() => bgOf(page)).toBe(WHITE)
  await pressInPage(app, 'view=tweak', 'Z', [isMac ? 'meta' : 'control'])
  await expect(css).toHaveValue('body { background: yellow }')
  await expect.poll(() => bgOf(page)).toBe('rgb(255, 255, 0)')
  await expect.poll(async () => (await state(app)).tweaks[id]?.css).toBe('body { background: yellow }')
  await css.fill('')

  // Enter keeps the indentation, one level more after a brace; ⇧Tab outdents; lines are numbered.
  await css.pressSequentially('a {')
  await css.press('Enter')
  await css.pressSequentially('color: red')
  await css.press('Enter')
  await css.pressSequentially('}')
  await expect(css).toHaveValue('a {\n  color: red\n  }')
  await css.press('Shift+Tab')
  await expect(css).toHaveValue('a {\n  color: red\n}')
  // Tab indents at the caret.
  await css.press('Home')
  await css.press('Tab')
  await expect(css).toHaveValue('a {\n  color: red\n  }')
  // With lines selected, Tab and ⇧Tab indent and outdent each of them.
  await css.press(`${MOD}+A`)
  await css.press('Tab')
  await expect(css).toHaveValue('  a {\n    color: red\n    }')
  await css.press('Shift+Tab')
  await css.press('Shift+Tab')
  await expect(css).toHaveValue('a {\ncolor: red\n}')
  await expect(view.getByTestId('tweak-css').locator('.code-editor__numbers')).toHaveText('1\n2\n3')
  // Tab stays in the field.
  await expect(css).toBeFocused()

  // How soon the page shows what was typed: from the field's input to the page's frame that shows
  // it, best of three (D46). The page notes each colour's first frame.
  await page.evaluate(() => {
    const seen: Record<string, number> = {}
    Object.assign(window, { __colorAt: seen })
    const loop = () => {
      const bg = getComputedStyle(document.body).backgroundColor
      if (!(bg in seen)) seen[bg] = Date.now()
      requestAnimationFrame(loop)
    }
    loop()
  })
  await view.evaluate(() =>
    document.addEventListener('input', () => Object.assign(window, { __typedAt: Date.now() }), true),
  )
  const delays: number[] = []
  for (const [color, rgb] of [
    ['#ff8800', 'rgb(255, 136, 0)'],
    ['#00aa88', 'rgb(0, 170, 136)'],
    ['#8844ff', 'rgb(136, 68, 255)'],
  ] as const) {
    await css.fill(`body { background: ${color} }`)
    const typedAt = (await view.evaluate(() => (window as unknown as { __typedAt: number }).__typedAt)) as number
    await expect
      .poll(() => page.evaluate((c) => (window as unknown as { __colorAt: Record<string, number> }).__colorAt[c], rgb))
      .toBeGreaterThan(0)
    const shownAt = await page.evaluate(
      (c) => (window as unknown as { __colorAt: Record<string, number> }).__colorAt[c] as number,
      rgb,
    )
    delays.push(shownAt - typedAt)
  }
  console.log(`[BO-11] typed CSS to the page's frame, ms: ${delays.join(', ')}`)
  expect(Math.min(...delays)).toBeLessThanOrEqual(300)

  // Saved: closing keeps it, and a reload shows it from the first frame.
  await css.fill('body { background: #123456 }')
  await pressInPage(app, 'view=tweak', 'Escape')
  await waitEditor(app, false)
  expect((await state(app)).tweaks[id]?.css).toBe('body { background: #123456 }')
  // Even typed into a new Tweak just before Esc, before it was sent: it is sent first, so the new
  // Tweak isn't taken for an empty one and dropped as the panel closes (BO-01).
  const fresh = await newTweak(app, tabId)
  await fresh.view.getByTestId('tweak-code-button').click()
  await field(fresh.view, 'css').focus()
  await fresh.view.evaluate(() => {
    document.execCommand('insertText', false, 'h1 { color: #0a0b0c }')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await waitEditor(app, false)
  await expect.poll(async () => (await state(app)).tweaks[fresh.id]?.css).toBe('h1 { color: #0a0b0c }')
  await mark(page)
  await cmd(app, 'tabs.reload', { tabId })
  await newDocument(page)
  expect((await firstFrame(page))?.bg).toBe(NAVY)

  // Reopened, the panel shows the code area at once, with the code.
  await run(app, 'tweaks.edit', { id, tabId })
  await waitEditor(app, true)
  await expect(field(view, 'css')).toHaveValue('body { background: #123456 }')
})

test('[BO-11][BO-18] JavaScript runs in the page’s own world once per load, and at once with Run now; an error goes to the page’s console; a frame from another site is left alone', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const inner = fx.url('/page/Inner', '127.0.0.1')
  const path = `/framed/Script?other=${encodeURIComponent(inner)}`
  const { tabId, page } = await openPage(app, path)
  // The page's console: its messages, and the errors nothing caught (DevTools' "Uncaught …").
  const console: string[] = []
  page.on('console', (m) => console.push(m.text()))
  page.on('pageerror', (e) => console.push(`Uncaught ${e.name}: ${e.message}`))
  const dialogs: string[] = []
  page.on('dialog', (d) => {
    dialogs.push(d.message())
    void d.dismiss()
  })
  const { id, view } = await newTweak(app, tabId)
  await update(app, id, { css: 'body { background: #123456 }' })
  await expect.poll(() => bgOf(page)).toBe(NAVY)

  await view.getByTestId('tweak-code-button').click()
  await view.getByTestId('tweak-code-js-tab').click()
  await field(view, 'js').fill('window.__tweakRuns = (window.__tweakRuns || 0) + 1')
  await expect.poll(async () => (await state(app)).tweaks[id]?.js).toContain('__tweakRuns')
  // Typing runs nothing; Run now runs it, in the page's own world (its scripts see it).
  expect(await pageValue(page, '__tweakRuns')).toBeUndefined()
  await view.getByTestId('tweak-js-run').click()
  await expect.poll(() => pageValue<number>(page, '__tweakRuns')).toBe(1)
  await expect(view.getByTestId('tweak-js-badge')).toBeVisible()

  // The frame from another site gets neither the CSS nor the JavaScript.
  const frame = page.frames().find((f) => f.url() === inner)
  if (!frame) throw new Error('no inner frame')
  expect(await frame.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(WHITE)
  expect(await frame.evaluate(() => (window as unknown as { __tweakRuns?: number }).__tweakRuns)).toBeUndefined()

  // Reload page: a new document, where it ran once at document ready.
  await mark(page)
  await view.getByTestId('tweak-js-reload').click()
  await newDocument(page)
  await expect.poll(() => pageValue<number>(page, '__tweakRuns')).toBe(1)
  const again = page.frames().find((f) => f.url() === inner)
  expect(await again?.evaluate(() => (window as unknown as { __tweakRuns?: number }).__tweakRuns)).toBeUndefined()
  // An in-page navigation runs it no more, as page scripts don't run again (BO-18).
  await page.evaluate(() => history.pushState({}, '', '#more'))
  await expect.poll(async () => (await state(app)).tabs[tabId]?.url).toContain('#more')
  await expect.poll(async () => (await editorInfo(app)).open).toBe(true)
  expect(await pageValue<number>(page, '__tweakRuns')).toBe(1)

  // An error, thrown or in the code itself, goes to the page's console: no dialog, nothing in main.
  await field(view, 'js').fill('throw new Error("tweak boom")')
  await view.getByTestId('tweak-js-run').click()
  await expect.poll(() => console.find((m) => m.includes('tweak boom')) ?? '').toContain('[Tweak “localhost”]')
  await field(view, 'js').fill('let = ;')
  await view.getByTestId('tweak-js-run').click()
  await expect.poll(() => console.some((m) => m.startsWith('Uncaught SyntaxError'))).toBe(true)
  expect(dialogs).toEqual([])
  await expect(view.getByTestId('tweak-panel')).toBeVisible()
})

test('[BO-11][BO-18] JavaScript that came from elsewhere doesn’t run until allowed on this device; editing it doesn’t allow it', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const { tabId, page } = await openPage(app, '/page/Imported')
  const { id, view } = await newTweak(app, tabId)
  // As an imported Tweak arrives (BO-20): its JavaScript not allowed here.
  await update(app, id, { js: 'window.__imported = (window.__imported || 0) + 1', jsAllowed: false })
  await mark(page)
  await cmd(app, 'tabs.reload', { tabId })
  await newDocument(page)
  await expect.poll(async () => (await pageTweaks(app, tabId))?.scripted).toBe(true)
  expect(await pageValue(page, '__imported')).toBeUndefined()

  await view.getByTestId('tweak-code-button').click()
  await view.getByTestId('tweak-code-js-tab').click()
  await expect(view.getByTestId('tweak-js-blocked')).toBeVisible()
  await expect(view.getByTestId('tweak-js-run')).toBeDisabled()
  // Editing the code leaves it off.
  await field(view, 'js').press('End')
  await field(view, 'js').pressSequentially(' // edited')
  await expect.poll(async () => (await state(app)).tweaks[id]?.js).toContain('// edited')
  expect((await state(app)).tweaks[id]?.jsAllowed).toBe(false)
  expect(await run(app, 'tweaks.runNow', { id, tabId })).toBe(false)
  expect(await pageValue(page, '__imported')).toBeUndefined()

  // Allowed here, it runs: now, and on each load.
  await view.getByTestId('tweak-js-allow').click()
  await expect(view.getByTestId('tweak-js-blocked')).toHaveCount(0)
  expect((await state(app)).tweaks[id]?.jsAllowed).toBe(true)
  await view.getByTestId('tweak-js-run').click()
  await expect.poll(() => pageValue<number>(page, '__imported')).toBe(1)
  await mark(page)
  await cmd(app, 'tabs.reload', { tabId })
  await newDocument(page)
  await expect.poll(() => pageValue<number>(page, '__imported')).toBe(1)
})

const SCOPE_HOSTS = ['*.scope.test', 'scope.test', 'scope.other']
const SCOPE_ARGS = [
  `--host-resolver-rules=${SCOPE_HOSTS.map((h) => `MAP ${h} 127.0.0.1`).join(', ')}`,
  `--proxy-bypass-list=${SCOPE_HOSTS.join(';')}`,
]

test('[BO-17] a Tweak is for its host’s pages, any path and in-page navigations included, not another host’s; its subdomains’ only with the box ticked, which applies at once', async () => {
  orbit = await launchOrbit({ args: SCOPE_ARGS })
  const { app } = orbit
  const www = await openPage(app, '/page/Www', 'www.scope.test')
  const { id } = await newTweak(app, www.tabId)
  await update(app, id, { css: 'body { background: #123456 }' })
  await expect.poll(() => bgOf(www.page)).toBe(NAVY)
  await pressInPage(app, 'view=tweak', 'Escape')
  await waitEditor(app, false)

  // Every path and query of the host, and in-page navigations.
  const deep = await openPage(app, '/page/Deep/a/b?x=1', 'www.scope.test')
  expect((await firstFrame(deep.page))?.bg).toBe(NAVY)
  await deep.page.evaluate(() => history.pushState({}, '', '/elsewhere/c?y=2'))
  await expect.poll(async () => (await state(app)).tabs[deep.tabId]?.url).toContain('/elsewhere/c?y=2')
  expect(await bgOf(deep.page)).toBe(NAVY)
  // Not another host, the parent domain or a subdomain.
  for (const host of ['scope.other', 'scope.test', 'news.www.scope.test']) {
    const other = await openPage(app, `/page/On-${host}`, host)
    expect((await firstFrame(other.page))?.bg).toBe(WHITE)
  }

  // A Tweak of the parent domain: "Also apply to subdomains" brings in its subdomains' open pages
  // at once, without a reload.
  const parent = await openPage(app, '/page/Parent', 'scope.test')
  const news = await openPage(app, '/page/News', 'news.www.scope.test')
  await mark(news.page)
  await cmd(app, 'tabs.activate', { tabId: parent.tabId })
  const second = await newTweak(app, parent.tabId)
  await update(app, second.id, { css: 'body { background: #00aa88 }' })
  await expect.poll(() => bgOf(parent.page)).toBe('rgb(0, 170, 136)')
  const box = second.view.getByTestId('tweak-subdomains')
  await expect(box).not.toBeChecked()
  await box.check()
  await expect.poll(async () => (await state(app)).tweaks[second.id]?.subdomains).toBe(true)
  await expect.poll(() => bgOf(news.page)).toBe('rgb(0, 170, 136)')
  expect(await marked(news.page)).toBe(true)
  // On a subdomain's page the box is fixed: unticking it there would take the Tweak off that page.
  await pressInPage(app, 'view=tweak', 'Escape')
  await waitEditor(app, false)
  await cmd(app, 'tabs.activate', { tabId: news.tabId })
  expect(await run(app, 'tweaks.edit', { id: second.id, tabId: news.tabId })).toBe(true)
  await waitEditor(app, true)
  await expect(second.view.getByTestId('tweak-subdomains')).toBeChecked()
  await expect(second.view.getByTestId('tweak-subdomains')).toBeDisabled()
  await pressInPage(app, 'view=tweak', 'Escape')
  await waitEditor(app, false)
  // Unticked on the parent's page, the subdomain's page loses it at once.
  await cmd(app, 'tabs.activate', { tabId: parent.tabId })
  await run(app, 'tweaks.edit', { id: second.id, tabId: parent.tabId })
  await waitEditor(app, true)
  await second.view.getByTestId('tweak-subdomains').uncheck()
  await expect.poll(() => bgOf(news.page)).toBe(WHITE)
  await pressInPage(app, 'view=tweak', 'Escape')
  await waitEditor(app, false)
  // An address by number has no subdomains: no box.
  const ip = await openPage(app, '/page/Numbers', '127.0.0.1')
  await newTweak(app, ip.tabId)
  await expect(second.view.getByTestId('tweak-done')).toBeVisible()
  await expect(second.view.getByTestId('tweak-subdomains')).toHaveCount(0)
})

test('[BO-17] a Tweak applies in every profile; in a private window its CSS applies and its JavaScript runs only once allowed there', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const first = await openPage(app, '/page/Everywhere')
  const { id } = await newTweak(app, first.tabId)
  await update(app, id, {
    css: 'body { background: #123456 }',
    js: 'document.documentElement.dataset.tweakJs = "ran"',
  })
  await pressInPage(app, 'view=tweak', 'Escape')
  await waitEditor(app, false)
  const ran = (page: Page) => page.evaluate(() => document.documentElement.dataset.tweakJs ?? null).catch(() => null)
  await mark(first.page)
  await cmd(app, 'tabs.reload', { tabId: first.tabId })
  await newDocument(first.page)
  await expect.poll(() => ran(first.page)).toBe('ran')

  // Another profile's Space: the same Tweak, CSS and JavaScript.
  const profileId = (await run(app, 'profiles.create', { name: 'Work' })) as string
  const spaceId = (await run(app, 'spaces.create', { name: 'Work', profileId })) as string
  const workUrl = fx.url('/page/Work')
  const workTab = (await run(app, 'tabs.create', { url: workUrl, spaceId })) as string
  await waitTab(app, workTab, '/page/Work')
  expect((await state(app)).tabs[workTab]?.profileId).toBe(profileId)
  const work = await tabPage(app, '/page/Work')
  expect((await firstFrame(work))?.bg).toBe(NAVY)
  await expect.poll(() => ran(work)).toBe('ran')

  // A private window: the CSS, but not the JavaScript, until allowed in private windows.
  const before = new Set((await windowList(app)).map((w) => w.id))
  await action(app, 'window.newPrivate')
  await expect.poll(async () => (await windowList(app)).filter((w) => !before.has(w.id)).length).toBe(1)
  const priv = (await windowList(app)).find((w) => !before.has(w.id))
  if (!priv) throw new Error('no private window')
  const privUrl = fx.url('/page/Hidden')
  const privTab = await cmdIn<string>(app, priv.id, 'tabs.create', { url: privUrl })
  await waitTab(app, privTab, '/page/Hidden')
  const hidden = await tabPage(app, '/page/Hidden')
  expect((await firstFrame(hidden))?.bg).toBe(NAVY)
  await expect.poll(async () => (await pageTweaks(app, privTab))?.scripted).toBe(true)
  expect(await ran(hidden)).toBeNull()
  expect(await run(app, 'tweaks.runNow', { id, tabId: privTab })).toBe(false)

  // The editor over the private page says so; ticking the box lets it run there.
  expect(await cmdIn(app, priv.id, 'tweaks.edit', { id, tabId: privTab })).toBe(true)
  await expect.poll(async () => (await editorInfo(app, priv.id)).placed).toBe(true)
  const view = await editorPageOf(app, priv.id)
  await expect(view.getByTestId('tweak-code')).toBeVisible()
  await view.getByTestId('tweak-code-js-tab').click()
  await expect(view.getByTestId('tweak-js-run')).toBeDisabled()
  await view.getByTestId('tweak-js-private').check()
  await expect.poll(async () => (await state(app)).tweaks[id]?.jsInPrivate).toBe(true)
  await mark(hidden)
  await view.getByTestId('tweak-js-reload').click()
  await newDocument(hidden)
  await expect.poll(() => ran(hidden)).toBe('ran')
  const privShell = await uiPageOf(app, 'shell', priv.id)
  await expect(privShell.getByTestId('sidebar')).toBeAttached()
})

test('[BO-14] the site controls panel lists the site’s Tweaks: a name turns its Tweak off or on at once, without a reload, each on its own; the address field’s paintbrush shows and turns them all', async () => {
  orbit = await launchOrbit()
  const { app, shell } = orbit
  const { tabId, page } = await openPage(app, '/page/Toggle')
  const dark = await newTweak(app, tabId)
  await update(app, dark.id, { name: 'Dark', css: 'body { background: #123456 }', js: 'void 0' })
  await pressInPage(app, 'view=tweak', 'Escape')
  await waitEditor(app, false)
  const big = await newTweak(app, tabId)
  await update(app, big.id, { name: 'Big', style: { size: 110 } })
  await pressInPage(app, 'view=tweak', 'Escape')
  await waitEditor(app, false)
  await expect.poll(() => bgOf(page)).toBe(NAVY)
  await expect.poll(() => zoomOf(page)).toBe('1.1')
  await mark(page)

  const brush = shell.getByTestId('tweak-button')
  await expect(brush).toHaveAttribute('data-state', 'on')
  await shell.getByTestId('site-controls-button').click()
  const overlay = await viewPage(app, 'overlay')
  const panel = overlay.getByTestId('site-controls')
  const rows = panel.getByTestId('site-tweak')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('Dark')
  await expect(rows.nth(1)).toContainText('Big')
  // The one with JavaScript says so.
  await expect(rows.nth(0).getByTestId('site-tweak-js')).toBeVisible()
  await expect(rows.nth(1).getByTestId('site-tweak-js')).toHaveCount(0)

  // Its name turns one off: the page loses it at once; the other stays.
  await rows.nth(0).getByTestId('site-tweak-toggle').click()
  await expect(rows.nth(0)).toHaveAttribute('data-on', 'false')
  await expect.poll(() => bgOf(page)).toBe(WHITE)
  expect(await zoomOf(page)).toBe('1.1')
  await expect(brush).toHaveAttribute('data-state', 'on')
  // Off, it keeps everything it had.
  expect((await state(app)).tweaks[dark.id]).toMatchObject({ enabled: false, css: 'body { background: #123456 }' })
  // The other off too: the paintbrush goes grey.
  await rows.nth(1).getByTestId('site-tweak-toggle').click()
  await expect.poll(() => zoomOf(page)).toBe('1')
  await expect(brush).toHaveAttribute('data-state', 'off')
  // On again, one at a time: back at once.
  await rows.nth(0).getByTestId('site-tweak-toggle').click()
  await expect.poll(() => bgOf(page)).toBe(NAVY)
  expect(await zoomOf(page)).toBe('1')
  await overlay.keyboard.press('Escape')
  await expect(panel).toBeHidden()

  // The paintbrush turns all of the site's Tweaks off, then on.
  await brush.click()
  await expect(brush).toHaveAttribute('data-state', 'off')
  await expect.poll(() => bgOf(page)).toBe(WHITE)
  await expect(shell.getByTestId('toast').filter({ hasText: 'Tweaks off for localhost' })).toBeVisible()
  await brush.click()
  await expect(brush).toHaveAttribute('data-state', 'on')
  await expect.poll(() => bgOf(page)).toBe(NAVY)
  await expect.poll(() => zoomOf(page)).toBe('1.1')
  // None of it reloaded the page.
  expect(await marked(page)).toBe(true)
})

test('[BO-21] the command bar makes, edits and turns off and on the shown site’s Tweaks; with several, Edit Tweak lists them in the site controls', async () => {
  orbit = await launchOrbit()
  const { app, shell } = orbit
  const { tabId, page } = await openPage(app, '/page/Commands')
  await run(app, 'tweaks.dismissIntro', {})
  const overlay = await viewPage(app, 'overlay')
  const runCommand = async (text: string, title: string) => {
    await shell.keyboard.press(`${MOD}+T`)
    const input = overlay.getByTestId('command-bar').getByTestId('command-input')
    await expect(input).toBeFocused()
    await input.fill(text)
    const row = overlay.getByTestId('command-bar').getByTestId('command-result').filter({ hasText: title })
    await expect(row.first()).toBeVisible()
    await row.first().click()
  }

  // No Tweak yet: Edit says so.
  await runCommand('edit customization', 'Edit Tweak')
  await expect(shell.getByTestId('toast').filter({ hasText: 'This site has no Tweaks' })).toBeVisible()
  // "site style" finds New Tweak….
  await runCommand('site style', 'New Tweak…')
  await waitEditor(app, true)
  const id = (await editorInfo(app)).tweakId as string
  await update(app, id, { css: 'body { background: #123456 }' })
  await pressInPage(app, 'view=tweak', 'Escape')
  await waitEditor(app, false)
  // One Tweak: Edit opens it.
  await runCommand('customize', 'Edit Tweak')
  await waitEditor(app, true)
  expect((await editorInfo(app)).tweakId).toBe(id)
  await pressInPage(app, 'view=tweak', 'Escape')
  await waitEditor(app, false)

  // Off and on for the site.
  await runCommand('customization', 'Turn Off Tweaks for This Site')
  await expect.poll(() => bgOf(page)).toBe(WHITE)
  await expect(shell.getByTestId('toast').filter({ hasText: 'Tweaks off for localhost' })).toBeVisible()
  await runCommand('site style', 'Turn On Tweaks for This Site')
  await expect.poll(() => bgOf(page)).toBe(NAVY)

  // Two Tweaks: Edit lists them in the site controls panel to pick from.
  const other = (await run(app, 'tweaks.create', { tabId })) as string
  await update(app, other, { style: { size: 110 } })
  await pressInPage(app, 'view=tweak', 'Escape')
  await waitEditor(app, false)
  await act(app, 'tweak.edit')
  const panel = overlay.getByTestId('site-controls')
  await expect(panel).toBeVisible()
  await expect(panel.getByTestId('site-tweak')).toHaveCount(2)
  await panel.getByTestId('site-tweak-edit').nth(1).click()
  await waitEditor(app, true)
  expect((await editorInfo(app)).tweakId).toBe(other)
})
