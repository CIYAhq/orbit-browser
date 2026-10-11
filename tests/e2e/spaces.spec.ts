import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import {
  type Fixtures,
  launchOrbit,
  type Orbit,
  run,
  startFixtures,
  state,
  tabPage,
  tabView,
  viewPage,
} from './helpers'
import {
  activeSpace,
  bgVar,
  createSpace,
  cssVar,
  flick,
  hoverSidebar,
  names,
  newTab,
  order,
  settled,
  stripWidth,
  stripX,
  swipe,
  win,
} from './spaces-support'

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
})
test.afterEach(async () => {
  await orbit.app.close()
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('[SP-01][SP-06][SB-09][PR-01] the switcher shows one target per Space (icon or dot) and only from two Spaces', async () => {
  const { app, shell } = orbit
  await expect(shell.getByTestId('space-dot')).toHaveCount(0)
  const s0 = await state(app)
  expect(Object.values(s0.profiles).map((p) => p.name)).toEqual(['Default'])
  const a = await activeSpace(app)
  const b = await createSpace(app, { name: 'Rocket', icon: '🚀', activate: false })
  await createSpace(app, { name: 'Gamma', activate: false, afterSpaceId: b })
  const dots = shell.getByTestId('space-dot')
  await expect(dots).toHaveCount(3)
  await expect(dots.nth(0).locator('.space-dot__dot')).toHaveCount(1)
  await expect(dots.nth(1)).toHaveText('🚀')
  await expect(dots.nth(2).locator('.space-dot__dot')).toHaveCount(1)
  await expect(dots.nth(0)).toHaveAttribute('aria-pressed', 'true')
  await expect(dots.nth(1)).toHaveAttribute('aria-pressed', 'false')
  await expect(dots.nth(1)).toHaveAttribute('title', /^Rocket/)
  // The emphasis is stronger on the active target.
  const p = await dots.evaluateAll((els) => els.map((el) => Number(getComputedStyle(el).getPropertyValue('--p'))))
  expect(p).toEqual([1, 0, 0])
  expect(await activeSpace(app)).toBe(a)
})

test('[SP-07][SP-10][FL-13] clicking a target slides to that Space and each Space remembers its tab', async () => {
  const { app, shell } = orbit
  const a = await activeSpace(app)
  const t1 = await newTab(app, fx.url('/page/AlphaOne'))
  await newTab(app, fx.url('/page/AlphaTwo'))
  await run(app, 'tabs.activate', { tabId: t1 })
  const b = await createSpace(app, { name: 'Beta', activate: false })
  await settled(shell)
  await shell.locator(`[data-testid="space-dot"][data-space-id="${b}"]`).click()
  // State first: the window is on B at once, and the slide shows A's page leaving.
  await expect.poll(() => activeSpace(app)).toBe(b)
  await expect(shell.locator(`[data-preview-space="${a}"]`)).toHaveCount(1)
  await expect(shell.getByTestId('space-name')).toHaveText('Beta')
  await settled(shell)
  await expect(shell.getByTestId('empty-state')).toBeVisible()
  const t5 = await newTab(app, fx.url('/page/BetaFive'))
  await expect.poll(async () => (await win(app)).activeTab[b]).toBe(t5)
  await shell.locator(`[data-testid="space-dot"][data-space-id="${a}"]`).click()
  await expect.poll(() => activeSpace(app)).toBe(a)
  await expect.poll(async () => (await win(app)).activeTab[a]).toBe(t1)
  await settled(shell)
  // The page card shows A's remembered tab again.
  const page = await tabPage(app, '/page/AlphaOne')
  await expect(page.locator('#title')).toHaveText('AlphaOne')
  await expect.poll(async () => (await tabView(app, t1))?.visible).toBe(true)
  await expect.poll(async () => (await tabView(app, t5))?.visible ?? false).toBe(false)
})

test('[SP-08][FL-13] a horizontal two-finger swipe tracks 1:1 and commits with a spring settle', async () => {
  const { app, shell } = orbit
  const a = await activeSpace(app)
  const b = await createSpace(app, { name: 'Beta', activate: false })
  await settled(shell)
  const w = await stripWidth(shell)
  await hoverSidebar(shell)
  // Recognition (≈9 px) then 1:1 tracking: 10 + 6×10 = 70 px of finger travel.
  await swipe(shell, 10, 7, 10)
  await expect.poll(() => stripX(shell)).toBeCloseTo(-70, 0)
  await expect(shell.locator(`[data-preview-space="${b}"]`)).toHaveCount(1)
  // The neighbour slides in beside the current page; the window has not switched yet.
  expect(await activeSpace(app)).toBe(a)
  await swipe(shell, 10, 6, 10)
  await expect.poll(() => stripX(shell)).toBeCloseTo(-130, 0)
  // Past a third of the width (130 > w/3) on release: commit.
  expect(130).toBeGreaterThan(w / 3)
  await expect.poll(() => activeSpace(app), { timeout: 3000 }).toBe(b)
  await settled(shell)
  await expect(shell.getByTestId('space-name')).toHaveText('Beta')
})

test('[SP-08][FL-13] a short slow swipe springs back while a quick short flick commits', async () => {
  const { app, shell } = orbit
  const a = await activeSpace(app)
  const b = await createSpace(app, { name: 'Beta', activate: false })
  await settled(shell)
  await hoverSidebar(shell)
  // Slow: 40 px over ~400 ms, then release.
  await swipe(shell, 4, 10, 40)
  await settled(shell)
  expect(await activeSpace(app)).toBe(a)
  // Flick: about 45 px (well under a third of the width) then OS-style momentum still switches.
  await sleep(200)
  await flick(shell, [8, 8, 8, 7.2, 6.5, 5.9, 5.3, 4.8, 4.3], 6)
  await expect.poll(() => activeSpace(app), { timeout: 3000 }).toBe(b)
  await settled(shell)
})

test('[SP-08][FL-13] the first Space rubber-bands; a long over-swipe at the last Space opens the new-Space page', async () => {
  const { app, shell } = orbit
  const a = await activeSpace(app)
  const b = await createSpace(app, { name: 'Beta', activate: false })
  await settled(shell)
  const w = await stripWidth(shell)
  await hoverSidebar(shell)
  // Toward the previous Space from the first: resistance grows, at most about a third.
  await swipe(shell, -20, Math.round(w / 20), 10)
  const shown = await stripX(shell)
  expect(shown).toBeGreaterThan(0)
  expect(shown).toBeLessThan(w * 0.37)
  await settled(shell)
  expect(await activeSpace(app)).toBe(a)

  await run(app, 'spaces.switch', { spaceId: b })
  await settled(shell)
  // A short over-swipe past the last Space stretches and springs back. The hint shows while it's
  // stretched; a loaded machine may only look after the spring-back, so a watcher records it.
  await sleep(150)
  await shell.evaluate(() => {
    const w = window as unknown as { __sawNewHint?: boolean }
    w.__sawNewHint = false
    new MutationObserver((_, obs) => {
      if (!document.querySelector('[data-testid="new-space-hint"]')) return
      w.__sawNewHint = true
      obs.disconnect()
    }).observe(document.body, { childList: true, subtree: true })
  })
  await flick(shell, [8, 8, 8, 8], 30)
  await expect
    .poll(() => shell.evaluate(() => (window as unknown as { __sawNewHint?: boolean }).__sawNewHint))
    .toBe(true)
  await settled(shell)
  await expect(shell.getByTestId('new-space-flow')).toHaveCount(0)
  // A long, hard one opens the new-Space flow on the page past the last Space. Stamped event
  // times: a slow runner delivering real wheel events late would end the gesture early.
  await sleep(150)
  await flick(shell, Array(12).fill(30), 10)
  await expect(shell.getByTestId('new-space-flow')).toBeVisible()
  await expect.poll(() => stripX(shell)).toBeCloseTo(-w, 0)
  await shell.getByTestId('new-space-name').fill('Delta')
  await shell.getByTestId('new-space-name').press('Enter')
  await expect.poll(() => names(app)).toEqual(['Personal', 'Beta', 'Delta'])
  await expect.poll(async () => (await state(app)).spaces[await activeSpace(app)]?.name).toBe('Delta')
  await settled(shell)
  await expect(shell.getByTestId('space-name')).toHaveText('Delta')
  await expect(shell.getByTestId('new-space-flow')).toHaveCount(0)
})

test('[SP-08][SB-23] a vertical scroll over the sidebar never switches Space', async () => {
  const { app, shell } = orbit
  const a = await activeSpace(app)
  await createSpace(app, { name: 'Beta', activate: false })
  for (let i = 0; i < 40; i++) await newTab(app, fx.url(`/page/Row${i}`), { activate: false })
  await settled(shell)
  await hoverSidebar(shell)
  // Mostly vertical with some horizontal drift (> 30° from horizontal).
  await swipe(shell, 6, 12, 12, 30)
  await sleep(300)
  expect(await activeSpace(app)).toBe(a)
  expect(await stripX(shell)).toBe(0)
  const scrolled = await shell.getByTestId('sidebar-scroll').evaluate((el) => el.scrollTop)
  expect(scrolled).toBeGreaterThan(100)
})

test('[SP-09][KS-07] Space shortcuts: jump to N and next/previous without wrapping', async () => {
  const { app, shell } = orbit
  const isMac = process.platform === 'darwin'
  const [a] = await order(app)
  const b = await createSpace(app, { name: 'Beta', activate: false })
  const c = await createSpace(app, { name: 'Gamma', activate: false, afterSpaceId: b })
  await settled(shell)
  await shell.keyboard.press(isMac ? 'Control+3' : 'Alt+3')
  await expect.poll(() => activeSpace(app)).toBe(c)
  await shell.keyboard.press(isMac ? 'Control+9' : 'Alt+9')
  await sleep(150)
  expect(await activeSpace(app)).toBe(c)
  await settled(shell)
  // Next from the last Space stays there (only a small nudge).
  await shell.keyboard.press(isMac ? 'Meta+Alt+ArrowRight' : 'Control+Alt+ArrowRight')
  await sleep(200)
  expect(await activeSpace(app)).toBe(c)
  await shell.keyboard.press(isMac ? 'Meta+Alt+ArrowLeft' : 'Control+Alt+ArrowLeft')
  await expect.poll(() => activeSpace(app)).toBe(b)
  await sleep(150)
  await shell.keyboard.press(isMac ? 'Meta+Alt+ArrowLeft' : 'Control+Alt+ArrowLeft')
  await expect.poll(() => activeSpace(app)).toBe(a)
  await settled(shell)
  await shell.keyboard.press(isMac ? 'Meta+Alt+ArrowLeft' : 'Control+Alt+ArrowLeft')
  await sleep(200)
  expect(await activeSpace(app)).toBe(a)
})

test('[SP-19][FL-14][SP-16] the theme colour blends between Spaces during a switch, never via the neutral grey', async () => {
  const { app, shell } = orbit
  const a = await activeSpace(app)
  await run(app, 'spaces.update', { spaceId: a, theme: { colors: ['#2f6bff'], intensity: 1, grain: 0 } })
  const b = await createSpace(app, { name: 'Orange', activate: false })
  await run(app, 'spaces.update', { spaceId: b, theme: { colors: ['#ff8a2f'], intensity: 1, grain: 0 } })
  await settled(shell)
  await sleep(300)
  const start = await bgVar(shell, '--bg-top')
  // Sample the background layer's colour every frame while the switch animates.
  const samples = shell.evaluate(
    () =>
      new Promise<string[]>((done) => {
        const out: string[] = []
        const el = document.querySelector('.shell-bg') as HTMLElement
        const t0 = performance.now()
        const tick = () => {
          out.push(el.style.getPropertyValue('--bg-top').trim())
          if (performance.now() - t0 < 600) requestAnimationFrame(tick)
          else done(out)
        }
        requestAnimationFrame(tick)
      }),
  )
  await run(app, 'spaces.switch', { spaceId: b })
  const frames = [...new Set(await samples)]
  const end = await bgVar(shell, '--bg-top')
  // At rest the inherited variables match the background layer again.
  expect(await cssVar(shell, '--frame-top')).toBe(end)
  expect(end).not.toBe(start)
  // Several in-between colours, none of them grey.
  const between = frames.filter((c) => c !== start && c !== end)
  expect(between.length).toBeGreaterThan(2)
  for (const c of between) {
    const n = Number.parseInt(c.slice(1), 16)
    const r = (n >> 16) & 255
    const g = (n >> 8) & 255
    const bl = n & 255
    expect(Math.max(r, g, bl) - Math.min(r, g, bl), c).toBeGreaterThan(6)
  }
})

test('[SP-03][SP-04][SB-06][SB-24] rename the Space inline from its title row', async () => {
  const { app, shell } = orbit
  const a = await activeSpace(app)
  await createSpace(app, { name: 'Beta', activate: false })
  await shell.getByTestId('space-name').click()
  const input = shell.getByTestId('space-rename-input')
  await expect(input).toBeFocused()
  // The whole name is selected, so typing replaces it.
  await input.pressSequentially('Research')
  await input.press('Enter')
  await expect.poll(async () => (await state(app)).spaces[a]?.name).toBe('Research')
  await expect(shell.getByTestId('space-name')).toHaveText('Research')
  await expect(shell.locator(`[data-testid="space-dot"][data-space-id="${a}"]`)).toHaveAttribute('title', /^Research/)
  // Escape cancels.
  await shell.getByTestId('space-name').click()
  await shell.getByTestId('space-rename-input').pressSequentially('Nope')
  await shell.getByTestId('space-rename-input').press('Escape')
  await expect(shell.getByTestId('space-name')).toHaveText('Research')
  // Clearing the name restores the placeholder.
  await shell.getByTestId('space-name').click()
  await shell.getByTestId('space-rename-input').fill('')
  await shell.getByTestId('space-rename-input').press('Enter')
  await expect(shell.getByTestId('space-name')).toHaveText('Space 1')
})

test('[SP-04][SP-07][SB-06] the Space menu lists its items, also for a background Space from the switcher', async () => {
  const { app, shell } = orbit
  const a = await activeSpace(app)
  const b = await createSpace(app, { name: 'Beta', activate: false })
  await settled(shell)
  const row = shell.getByTestId('space-title-row')
  const button = shell.getByTestId('space-menu-button')
  await expect(button).toHaveCSS('opacity', '0')
  await row.hover()
  await expect(button).toHaveCSS('opacity', '1')
  await button.click()
  const overlay = await viewPage(app, 'overlay')
  const menu = overlay.getByTestId('space-menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Theme…',
    'Change Icon…',
    'Profile',
    'Rename',
    'Manage Spaces',
    'Delete Space…',
  ])
  await overlay.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  // Right-click a background Space's target: its menu, without switching to it.
  await shell.locator(`[data-testid="space-dot"][data-space-id="${b}"]`).click({ button: 'right' })
  await expect(overlay.getByTestId('space-menu')).toHaveAttribute('aria-label', 'Beta options')
  expect(await activeSpace(app)).toBe(a)
  // Rename acts on that Space: it comes into view with its name ready to edit (review M7).
  await overlay.getByTestId('menu-rename').click()
  await expect.poll(() => activeSpace(app)).toBe(b)
  const input = shell.getByTestId('space-rename-input')
  await expect(input).toBeFocused()
  await input.fill('Background renamed')
  await input.press('Enter')
  await expect.poll(async () => (await state(app)).spaces[b]?.name).toBe('Background renamed')
  expect((await state(app)).spaces[a]?.name).toBe('Personal')
})

test('[SP-12] deleting a Space asks first, archives its tabs tagged with its name, and Undo brings it back', async () => {
  const { app, shell } = orbit
  const a = await activeSpace(app)
  const b = await createSpace(app, { name: 'Trip planning' })
  await newTab(app, fx.url('/page/Flights'), { activate: false })
  await newTab(app, fx.url('/page/Hotels'))
  await settled(shell)
  await shell.getByTestId('space-title-row').hover()
  await shell.getByTestId('space-menu-button').click()
  const overlay = await viewPage(app, 'overlay')
  await overlay.getByTestId('menu-delete').click()
  const dialog = overlay.getByTestId('space-delete-dialog')
  await expect(dialog).toContainText('Delete “Trip planning”?')
  await overlay.getByTestId('space-delete-cancel').click()
  await expect(dialog).toHaveCount(0)
  expect(await order(app)).toContain(b)

  await shell.getByTestId('space-title-row').hover()
  await shell.getByTestId('space-menu-button').click()
  await overlay.getByTestId('menu-delete').click()
  await overlay.getByTestId('space-delete-confirm').click()
  await expect.poll(() => order(app)).toEqual([a])
  expect(await activeSpace(app)).toBe(a)
  const s = await state(app)
  expect(
    s.archive
      .filter((e) => e.spaceName === 'Trip planning')
      .map((e) => new URL(e.url).pathname)
      .sort(),
  ).toEqual(['/page/Flights', '/page/Hotels'])
  expect(Object.values(s.profiles)).toHaveLength(1)
  await expect(shell.getByTestId('space-undo')).toContainText('Trip planning')
  await shell.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(() => order(app)).toEqual([a, b])
  const restored = await state(app)
  expect(restored.spaces[b]?.today).toHaveLength(2)
  expect(restored.archive.filter((e) => e.spaceName === 'Trip planning')).toHaveLength(0)
  expect(await activeSpace(app)).toBe(b)
  // The last Space can't be deleted.
  await run(app, 'spaces.delete', { spaceId: b })
  await expect(shell.getByTestId('space-undo-button')).toBeVisible()
  await shell.getByTestId('space-undo-button').click()
  await expect.poll(() => order(app)).toEqual([a, b])
  expect(await run(app, 'spaces.delete', { spaceId: a })).toBe(true)
  expect(await run(app, 'spaces.delete', { spaceId: b })).toBe(false)
})

test('[SP-14][SP-15][SP-16][SP-17][SP-18][SB-24][FL-14] the theme picker previews live and is the one global light/dark switch', async () => {
  const { app, shell } = orbit
  const a = await activeSpace(app)
  await run(app, 'spaces.setAppearance', { appearance: 'light' })
  const b = await createSpace(app, { name: 'Beta', activate: false })
  await settled(shell)
  const before = await cssVar(shell, '--frame-top')
  await shell.getByTestId('space-title-row').hover()
  await shell.getByTestId('space-menu-button').click()
  const overlay = await viewPage(app, 'overlay')
  await overlay.getByTestId('menu-theme').click()
  const picker = overlay.getByTestId('theme-picker')
  await expect(picker).toBeVisible()
  // Drag in the colour area: the sidebar colour follows while dragging.
  const field = await overlay.getByTestId('theme-field').boundingBox()
  if (!field) throw new Error('no field')
  await overlay.mouse.move(field.x + field.width * 0.05, field.y + 10)
  await overlay.mouse.down()
  await overlay.mouse.move(field.x + field.width * 0.08, field.y + 12, { steps: 3 })
  await expect.poll(async () => (await state(app)).spaces[a]?.theme.colors[0]).toMatch(/^#/)
  const red = await cssVar(shell, '--frame-top')
  expect(red).not.toBe(before)
  await overlay.mouse.move(field.x + field.width * 0.62, field.y + 12, { steps: 4 })
  await expect.poll(() => cssVar(shell, '--frame-top')).not.toBe(red)
  await overlay.mouse.up()
  // Two colours make a gradient.
  await overlay.getByTestId('theme-add-color').click()
  await expect.poll(async () => (await state(app)).spaces[a]?.theme.colors.length).toBe(2)
  await expect
    .poll(async () => (await cssVar(shell, '--frame-top')) !== (await cssVar(shell, '--frame-bottom')))
    .toBe(true)
  // Grain is stored with the theme and shown on the sidebar.
  await overlay.getByTestId('theme-grain').fill('80')
  await expect.poll(async () => (await state(app)).spaces[a]?.theme.grain).toBeCloseTo(0.8)
  await expect.poll(async () => Number(await cssVar(shell, '--grain-opacity'))).toBeGreaterThan(0.3)
  // A preset applies (animated) and reset returns to the neutral theme.
  await overlay.getByTestId('theme-preset').nth(2).click()
  await expect.poll(async () => (await state(app)).spaces[a]?.theme.colors).toEqual(['#2fbf8f'])
  await overlay.getByTestId('theme-reset').click()
  await expect.poll(async () => (await state(app)).spaces[a]?.theme.colors).toEqual([])
  await expect.poll(() => cssVar(shell, '--frame-top')).toBe('#e7e7eb')
  // Light / Dark / Automatic applies to every Space (SP-18).
  await overlay.getByTestId('appearance-dark').click()
  await expect.poll(async () => (await state(app)).settings.appearance).toBe('dark')
  await expect.poll(() => cssVar(shell, '--text')).toBe('#f3f3f5')
  await overlay.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  await run(app, 'spaces.switch', { spaceId: b })
  await settled(shell)
  await expect.poll(() => cssVar(shell, '--text')).toBe('#f3f3f5')
  const s = await state(app)
  expect(s.spaces[b]?.theme).not.toHaveProperty('mode')
})

test('[SP-05][SP-06] change a Space icon with the emoji picker and remove it again', async () => {
  const { app, shell } = orbit
  const a = await activeSpace(app)
  await createSpace(app, { name: 'Beta', activate: false })
  await settled(shell)
  await shell.getByTestId('space-title-row').hover()
  await shell.getByTestId('space-menu-button').click()
  const overlay = await viewPage(app, 'overlay')
  await overlay.getByTestId('menu-icon').click()
  const search = overlay.getByTestId('emoji-search')
  await expect(search).toBeFocused()
  await search.fill('rocket')
  await overlay.getByTestId('emoji-option').first().click()
  await expect.poll(async () => (await state(app)).spaces[a]?.icon).toBe('🚀')
  await expect(shell.locator(`[data-testid="space-dot"][data-space-id="${a}"]`)).toHaveText('🚀')
  await run(app, 'spaces.update', { spaceId: a, icon: '' })
  await expect(shell.locator(`[data-testid="space-dot"][data-space-id="${a}"] .space-dot__dot`)).toHaveCount(1)
})

test('[PR-02][PR-03][PR-05][PR-07][PR-08] a new profile from the Space menu isolates cookies and shows its badge', async () => {
  const { app, shell } = orbit
  const a = await activeSpace(app)
  await newTab(app, fx.url('/page/CookieA'))
  const pageA = await tabPage(app, '/page/CookieA')
  await pageA.evaluate(() => {
    // biome-ignore lint/suspicious/noDocumentCookie: the test sets a plain session cookie on purpose
    document.cookie = 'orbit_session=alice; path=/; max-age=3600'
  })
  const b = await createSpace(app, { name: 'Client' })
  const shown = await newTab(app, fx.url('/page/ClientHome'))
  await tabPage(app, '/page/ClientHome')
  await settled(shell)
  // Space menu → Profile → New Profile… assigns it to this Space at once.
  await shell.getByTestId('space-title-row').hover()
  await shell.getByTestId('space-menu-button').click()
  const overlay = await viewPage(app, 'overlay')
  await overlay.getByTestId('menu-profile').click()
  await overlay.getByTestId('menu-profile-new').click()
  await overlay.getByTestId('profile-name').fill('Work')
  await overlay.getByTestId('profile-create').click()
  await expect.poll(async () => (await state(app)).spaces[b]?.profileId).not.toBe('p-default')
  const s = await state(app)
  const work = s.spaces[b]?.profileId as string
  expect(s.profiles[work]?.name).toBe('Work')
  expect(s.profiles[work]?.partition).toBe(`persist:orbit-${work}`)
  // The page that was on screen reloads in the new profile's session, visible (PR-03; review M6).
  const live = () =>
    app.evaluate((_e, id) => {
      const ctx = (
        globalThis as unknown as {
          __orbit: {
            ctx: {
              tabs: {
                get: (id: string) => { getVisible: () => boolean; webContents: { session: unknown } } | undefined
              }
              sessions: { get: (p: string) => unknown }
              store: { state: { tabs: Record<string, { profileId: string; asleep: boolean }> } }
            }
          }
        }
      ).__orbit.ctx
      const view = ctx.tabs.get(id)
      const tab = ctx.store.state.tabs[id]
      return {
        visible: view?.getVisible() ?? false,
        newSession: !!view && !!tab && view.webContents.session === ctx.sessions.get(tab.profileId),
        asleep: tab?.asleep,
      }
    }, shown)
  await expect.poll(live).toEqual({ visible: true, newSession: true, asleep: false })
  await expect(shell.getByTestId('content-frame')).toHaveAttribute('data-active-tab', shown)
  // Same site in the other profile: signed out (no cookie).
  await newTab(app, fx.url('/page/CookieB'))
  const pageB = await tabPage(app, '/page/CookieB')
  await expect(pageB.locator('#title')).toHaveText('CookieB')
  expect(await pageB.evaluate(() => document.cookie)).not.toContain('orbit_session')
  // …while another tab in the first profile still sees it.
  await run(app, 'spaces.switch', { spaceId: a })
  await newTab(app, fx.url('/page/CookieA2'))
  const pageA2 = await tabPage(app, '/page/CookieA2')
  await expect.poll(() => pageA2.evaluate(() => document.cookie)).toContain('orbit_session=alice')
  // Profile indicator: badge on the title row and the switcher tooltip (PR-07).
  await run(app, 'spaces.switch', { spaceId: b })
  await settled(shell)
  await shell.getByTestId('space-title-row').hover()
  await expect(shell.getByTestId('profile-badge')).toHaveText('W')
  await expect(shell.locator(`[data-testid="space-dot"][data-space-id="${b}"]`)).toHaveAttribute(
    'title',
    /Client · Work/,
  )
  // Default can't be deleted, nor a profile a Space still uses (review F1); once unused it can.
  expect(await run(app, 'profiles.delete', { profileId: 'p-default' })).toBe(false)
  expect(await run(app, 'profiles.delete', { profileId: work })).toBe(false)
  expect((await state(app)).profiles[work]).toBeDefined()
  await run(app, 'spaces.update', { spaceId: b, profileId: 'p-default' })
  await expect(shell.getByTestId('profile-badge')).toHaveCount(0)
  expect(await run(app, 'profiles.delete', { profileId: work })).toBe(true)
  await expect.poll(async () => (await state(app)).profiles[work]).toBeUndefined()
})

test('[PR-06][SP-01][SP-20] Favorites belong to the profile; pinned and Today belong to the Space', async () => {
  const { app, shell } = orbit
  const a = await activeSpace(app)
  await newTab(app, fx.url('/page/Fav'), { container: { kind: 'favorites', profileId: 'p-default' } })
  await newTab(app, fx.url('/page/PinnedA'), { container: { kind: 'pinned', spaceId: a } })
  const b = await createSpace(app, { name: 'Same profile', activate: false })
  const work = (await run(app, 'profiles.create', { name: 'Work' })) as string
  const c = await createSpace(app, { name: 'Work Space', activate: false, profileId: work, afterSpaceId: b })
  await settled(shell)
  await expect(shell.getByTestId('favorite-tile')).toHaveCount(1)
  await run(app, 'spaces.switch', { spaceId: b })
  await settled(shell)
  await expect(shell.getByTestId('favorite-tile')).toHaveCount(1)
  await expect(shell.getByTestId('pinned-list').getByTestId('tab-row')).toHaveCount(0)
  await run(app, 'spaces.switch', { spaceId: c })
  await settled(shell)
  await expect(shell.getByTestId('favorite-tile')).toHaveCount(0)
  // Clear Today in one Space leaves the others alone.
  await newTab(app, fx.url('/page/TodayC'))
  await run(app, 'spaces.switch', { spaceId: a })
  await newTab(app, fx.url('/page/TodayA'))
  await run(app, 'tabs.clearToday', { spaceId: a })
  const s = await state(app)
  expect(s.spaces[a]?.today).toHaveLength(0)
  expect(s.spaces[c]?.today).toHaveLength(1)
})

test('[SP-23][SP-24] each window has its own Space; a new window opens on the same Space with the command bar', async () => {
  const { app, shell } = orbit
  const a = await activeSpace(app)
  const b = await createSpace(app, { name: 'Beta' })
  await run(app, 'window.setSidebar', { visible: false })
  await app.evaluate(async () => {
    const hooks = (
      globalThis as unknown as {
        __orbit: { action: (id: string, w?: string) => Promise<void>; windowIds: () => string[] }
      }
    ).__orbit
    await hooks.action('window.new', hooks.windowIds()[0])
  })
  await expect.poll(async () => Object.keys((await state(app)).windows).length).toBe(2)
  const s = await state(app)
  const ids = Object.keys(s.windows)
  const second = s.windows[ids[1] as string]
  expect(second?.spaceId).toBe(b)
  expect(second?.sidebar.visible).toBe(true)
  await expect.poll(async () => (await state(app)).windows[ids[1] as string]?.overlay.kind).toBe('commandbar')
  // Cascaded, not exactly on top of the first window.
  const first = s.windows[ids[0] as string]
  if (first?.bounds && second?.bounds) expect(second.bounds.x).not.toBe(first.bounds.x)
  // Switching window 1 leaves window 2 alone.
  await run(app, 'spaces.switch', { spaceId: a })
  const after = await state(app)
  expect(after.windows[ids[0] as string]?.spaceId).toBe(a)
  expect(after.windows[ids[1] as string]?.spaceId).toBe(b)
  // Renaming a Space in one window updates both windows' sidebars.
  await run(app, 'spaces.update', { spaceId: b, name: 'Renamed' })
  await expect(shell.locator(`[data-testid="space-dot"][data-space-id="${b}"]`)).toHaveAttribute('title', /^Renamed/)
})

test('[SP-11] dragging a switcher target reorders Spaces and keeps the active Space', async () => {
  const { app, shell } = orbit
  const [a] = await order(app)
  const b = await createSpace(app, { name: 'Beta', activate: false })
  const c = await createSpace(app, { name: 'Gamma', activate: false, afterSpaceId: b })
  await settled(shell)
  const third = await shell.locator(`[data-testid="space-dot"][data-space-id="${c}"]`).boundingBox()
  const firstBox = await shell.locator(`[data-testid="space-dot"][data-space-id="${a}"]`).boundingBox()
  if (!third || !firstBox) throw new Error('no targets')
  await shell.mouse.move(third.x + third.width / 2, third.y + third.height / 2)
  await shell.mouse.down()
  await shell.mouse.move(firstBox.x + firstBox.width / 2, third.y + third.height / 2, { steps: 8 })
  await shell.mouse.up()
  await expect.poll(() => order(app)).toEqual([c, a, b])
  expect(await activeSpace(app)).toBe(a)
  // Numeric shortcuts follow the new order.
  await shell.keyboard.press(process.platform === 'darwin' ? 'Control+1' : 'Alt+1')
  await expect.poll(() => activeSpace(app)).toBe(c)
})

test('[SP-02][PR-04] New Space from the + menu: the flow in the sidebar, profile step, inserted after the active Space', async () => {
  const { app, shell } = orbit
  const [a] = await order(app)
  const b = await createSpace(app, { name: 'B' })
  const c = await createSpace(app, { name: 'C', activate: false, afterSpaceId: b })
  const work = (await run(app, 'profiles.create', { name: 'Work' })) as string
  await settled(shell)
  await shell.getByTestId('sidebar-plus').click()
  const overlay = await viewPage(app, 'overlay')
  await overlay.getByTestId('menu-plus-space').click()
  const flow = shell.getByTestId('new-space-flow')
  await expect(flow).toBeVisible()
  await expect(shell.getByTestId('new-space-name')).toBeFocused()
  // Same name an unnamed Space gets in that position (review F8).
  await expect(shell.getByTestId('new-space-name')).toHaveAttribute('placeholder', 'Space 3')
  // Profile step: the active Space's profile is preselected.
  const profiles = shell.getByTestId('new-space-profile')
  await expect(profiles).toHaveCount(2)
  await expect(profiles.nth(0)).toHaveAttribute('aria-checked', 'true')
  await profiles.nth(1).click()
  // Escape abandons the flow and creates nothing.
  await shell.getByTestId('new-space-name').press('Escape')
  await expect(flow).toHaveCount(0)
  expect(await order(app)).toEqual([a, b, c])
  await run(app, 'spaces.beginCreate', {})
  await expect(flow).toBeVisible()
  await shell.getByTestId('new-space-name').fill('D')
  await shell.getByTestId('new-space-profile').nth(1).click()
  await shell.getByTestId('new-space-create').click()
  await expect.poll(() => names(app)).toEqual(['Personal', 'B', 'D', 'C'])
  const s = await state(app)
  const d = s.spaceOrder[2] as string
  expect(s.spaces[d]?.profileId).toBe(work)
  await expect.poll(() => activeSpace(app)).toBe(d)
  await settled(shell)
  await expect(shell.getByTestId('space-name')).toHaveText('D')
  await expect(shell.getByTestId('today-list').getByTestId('tab-row')).toHaveCount(0)
})

test('[FL-13][SP-07] with reduced motion a switch cross-fades without sliding', async () => {
  const { app, shell } = orbit
  await shell.emulateMedia({ reducedMotion: 'reduce' })
  const b = await createSpace(app, { name: 'Beta', activate: false })
  await settled(shell)
  const slid = shell.evaluate(
    () =>
      new Promise<boolean>((done) => {
        let moved = false
        const track = document.querySelector<HTMLElement>('.space-strip__track')
        const t0 = performance.now()
        const tick = () => {
          if (track?.style.transform) moved = true
          if (document.querySelector('[data-preview-space]')) moved = true
          if (performance.now() - t0 < 400) requestAnimationFrame(tick)
          else done(moved)
        }
        requestAnimationFrame(tick)
      }),
  )
  await shell.locator(`[data-testid="space-dot"][data-space-id="${b}"]`).click()
  expect(await slid).toBe(false)
  await expect(shell.getByTestId('space-name')).toHaveText('Beta')
})

test('[PR-06][FL-13] mid-swipe, Favorites stay still within a profile and cross-fade between profiles', async () => {
  const { app, shell } = orbit
  await newTab(app, fx.url('/page/Fav'), { container: { kind: 'favorites', profileId: 'p-default' } })
  const b = await createSpace(app, { name: 'Same', activate: false })
  const work = (await run(app, 'profiles.create', { name: 'Work' })) as string
  await createSpace(app, { name: 'Other', activate: false, profileId: work, afterSpaceId: b })
  await settled(shell)
  const layers = () =>
    shell.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.space-strip__track > [data-slot]')].map((page) => {
        const layer = page.querySelector<HTMLElement>('[data-favorites-layer]')
        const box = layer?.getBoundingClientRect()
        return {
          slot: Number(page.dataset.slot),
          x: Math.round(box?.left ?? 0),
          opacity: layer?.style.opacity ?? '',
          tiles: layer?.querySelectorAll('.favorite').length ?? 0,
        }
      }),
    )
  const favX = await shell.getByTestId('favorites').evaluate((el) => Math.round(el.getBoundingClientRect().left))
  await hoverSidebar(shell)
  await swipe(shell, 10, 8, 10)
  // Same profile: the real page's grid is held in place, the neighbour's is hidden.
  const same = await layers()
  const real = same.find((l) => l.slot === 0)
  expect(real?.x).toBe(favX)
  expect(real?.opacity).toBe('1')
  expect(same.find((l) => l.slot === 1)?.opacity).toBe('0')
  await settled(shell)
  await run(app, 'spaces.switch', { spaceId: b })
  await settled(shell)
  await sleep(150)
  await hoverSidebar(shell)
  await swipe(shell, 10, 10, 10)
  // Different profiles: the two grids cross-fade in place.
  const cross = await layers()
  const out = Number(cross.find((l) => l.slot === 0)?.opacity)
  const into = Number(cross.find((l) => l.slot === 1)?.opacity)
  expect(out).toBeGreaterThan(0)
  expect(out).toBeLessThan(1)
  expect(out + into).toBeCloseTo(1, 2)
  await settled(shell)
})

test('[SP-02][SP-04] with the sidebar hidden, New Space creates at once; a single unnamed Space hides its title row', async () => {
  const { app, shell } = orbit
  const [a] = await order(app)
  await run(app, 'window.setSidebar', { visible: false })
  await app.evaluate(async () => {
    const hooks = (
      globalThis as unknown as {
        __orbit: { action: (id: string, w?: string) => Promise<void>; windowIds: () => string[] }
      }
    ).__orbit
    await hooks.action('space.new', hooks.windowIds()[0])
  })
  await expect.poll(() => names(app)).toEqual(['Personal', 'Space 2'])
  // The toast shows over the page while the sidebar is hidden (SB-13).
  await expect((await viewPage(app, 'toasts')).getByTestId('toast')).toContainText('Space 2')
  await run(app, 'window.setSidebar', { visible: true })
  const second = (await order(app))[1] as string
  await run(app, 'spaces.delete', { spaceId: second })
  await run(app, 'spaces.update', { spaceId: a, name: '' })
  await expect(shell.getByTestId('space-title-row')).toHaveCount(0)
  // Rename Space (command bar action) still reaches it.
  await run(app, 'spaces.beginRename', { spaceId: a })
  await shell.getByTestId('space-rename-input').fill('Home')
  await shell.getByTestId('space-rename-input').press('Enter')
  await expect(shell.getByTestId('space-name')).toHaveText('Home')
})

test('[SP-09] mouse back/forward buttons over the sidebar move between Spaces', async () => {
  const { app, shell } = orbit
  const [a] = await order(app)
  const b = await createSpace(app, { name: 'Beta', activate: false })
  await settled(shell)
  const press = (button: number) =>
    shell.getByTestId('sidebar').evaluate((el, b) => {
      el.dispatchEvent(new MouseEvent('mouseup', { button: b, bubbles: true }))
    }, button)
  await press(4)
  await expect.poll(() => activeSpace(app)).toBe(b)
  await press(3)
  await expect.poll(() => activeSpace(app)).toBe(a)
})

test('[SP-02][SP-09] switching Space while the new-Space flow is open abandons the flow', async () => {
  const { app, shell } = orbit
  const [a] = await order(app)
  await createSpace(app, { name: 'Beta' })
  await settled(shell)
  await run(app, 'spaces.beginCreate', {})
  await expect(shell.getByTestId('new-space-flow')).toBeVisible()
  await run(app, 'spaces.switch', { spaceId: a })
  await settled(shell)
  await expect(shell.getByTestId('new-space-flow')).toHaveCount(0)
  await expect(shell.getByTestId('space-name')).toHaveText('Personal')
  // The real page is interactive again.
  await shell.getByTestId('space-name').click()
  await expect(shell.getByTestId('space-rename-input')).toBeFocused()
  expect(await names(app)).toEqual(['Personal', 'Beta'])
})

test('[FL-13][SP-07] jumping several Spaces slides one page with the destination next to the current one', async () => {
  const { app, shell } = orbit
  const [a] = await order(app)
  const b = await createSpace(app, { name: 'Two', activate: false })
  const c = await createSpace(app, { name: 'Three', activate: false, afterSpaceId: b })
  const d = await createSpace(app, { name: 'Four', activate: false, afterSpaceId: c })
  await settled(shell)
  const seen = shell.evaluate(
    () =>
      new Promise<string[]>((done) => {
        const ids = new Set<string>()
        let maxShift = 0
        const t0 = performance.now()
        const tick = () => {
          for (const el of document.querySelectorAll<HTMLElement>('[data-preview-space]')) {
            ids.add(el.dataset.previewSpace as string)
          }
          const m = /translate3d\((-?[\d.]+)px/.exec(
            document.querySelector<HTMLElement>('.space-strip__track')?.style.transform ?? '',
          )
          if (m) maxShift = Math.max(maxShift, Math.abs(Number(m[1])))
          if (performance.now() - t0 < 600) requestAnimationFrame(tick)
          else done([...ids, `shift:${Math.round(maxShift)}`])
        }
        requestAnimationFrame(tick)
      }),
  )
  await shell.locator(`[data-testid="space-dot"][data-space-id="${d}"]`).click()
  const result = await seen
  const width = await stripWidth(shell)
  // Only the Space we left is shown beside the destination; Two and Three never flash.
  expect(result.filter((r) => !r.startsWith('shift:'))).toEqual([a])
  const shift = Number(result.find((r) => r.startsWith('shift:'))?.slice(6))
  expect(shift).toBeLessThanOrEqual(width + 1)
  await expect.poll(() => activeSpace(app)).toBe(d)
})

test('[SB-23][SP-08] slow, small vertical wheel steps scroll the tab list (review M2)', async () => {
  const { app, shell } = orbit
  await createSpace(app, { name: 'Beta', activate: false })
  for (let i = 0; i < 40; i++) await newTab(app, fx.url(`/page/Row${i}`), { activate: false })
  await settled(shell)
  await hoverSidebar(shell)
  const list = shell.getByTestId('sidebar-scroll')
  await list.evaluate((el) => {
    el.scrollTop = 0
  })
  for (let i = 0; i < 15; i++) {
    await shell.mouse.wheel(0, 6)
    await sleep(120)
  }
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThanOrEqual(60)
  expect(await stripX(shell)).toBe(0)
})

test('[SP-08][FL-13] the strip never freezes between pages (review M3)', async () => {
  const { app, shell } = orbit
  await createSpace(app, { name: 'Beta', activate: false })
  await settled(shell)
  const w = await stripWidth(shell)
  // (a) Fingers still moving while the new-Space page springs in: once the slide has started,
  // three small horizontal events arrive. The page still arrives fully.
  await run(app, 'spaces.beginCreate', {})
  await shell.waitForFunction(() => {
    const m = /translate3d\((-?[\d.]+)px/.exec(
      document.querySelector<HTMLElement>('.space-strip__track')?.style.transform ?? '',
    )
    return !!m && Number(m[1]) < -5
  })
  await shell.evaluate(async () => {
    const target = document.querySelector('[data-testid="sidebar"]') as HTMLElement
    for (let i = 0; i < 3; i++) {
      target.dispatchEvent(new WheelEvent('wheel', { deltaX: 6, deltaY: 0, bubbles: true, cancelable: true }))
      await new Promise((r) => setTimeout(r, 8))
    }
  })
  await expect.poll(() => stripX(shell), { timeout: 3000 }).toBe(-w)
  await shell.getByTestId('new-space-cancel').click()
  await settled(shell)
  // (b) A release starved by a long task: the next event (vertical, in the same task as the
  // busy loop, so no timer can run in between) still releases the swipe and the strip settles.
  await sleep(150)
  await shell.evaluate(async () => {
    const target = document.querySelector('[data-testid="sidebar-scroll"]') as HTMLElement
    const wheel = (dx: number, dy: number) =>
      target.dispatchEvent(new WheelEvent('wheel', { deltaX: dx, deltaY: dy, bubbles: true, cancelable: true }))
    for (let i = 0; i < 6; i++) {
      wheel(10, 0)
      await new Promise((r) => setTimeout(r, 10))
    }
    const end = performance.now() + 150
    while (performance.now() < end) {
      // busy: the release timer can't run
    }
    wheel(0, 8)
  })
  await settled(shell)
  expect(await stripX(shell)).toBe(0)
})

test('[SP-08][FL-13] a finger that eases off and moves on keeps tracking (review M4)', async () => {
  const { app, shell } = orbit
  const a = await activeSpace(app)
  const b = await createSpace(app, { name: 'Beta', activate: false })
  for (let i = 0; i < 40; i++) await newTab(app, fx.url(`/page/Row${i}`), { activate: false })
  await settled(shell)
  // 144 px at 60 Hz: eases off to 2 px per event, then speeds up again (no lift in between).
  const deltas = [10, 6, 6, 6, 6, 6, 5, 4, 3, 2, 3, 4, 5, ...Array(13).fill(6)]
  const xs = await flick(shell, deltas, 16)
  // While the fingers were on, the strip followed them 1:1 (it never sprang back): after
  // the 9 px recognition, each event moved it by exactly that event's delta.
  let travel = 0
  const expected = deltas.map((d) => {
    travel += d
    return travel >= 9 ? -travel : 0
  })
  expect(xs.map((x) => Math.round(x * 10) / 10)).toEqual(expected)
  // Past half the width on release: switched.
  await expect.poll(() => activeSpace(app), { timeout: 3000 }).toBe(b)
  await settled(shell)
  // A swipe released by OS-style momentum (here: rubber-banding at the first Space), then at
  // once a vertical scroll: the list scrolls instead of being swallowed with the momentum.
  await run(app, 'spaces.switch', { spaceId: a })
  await settled(shell)
  await hoverSidebar(shell)
  const list = shell.getByTestId('sidebar-scroll')
  await flick(shell, [-8, -8, -7.2, -6.5, -5.9, -5.3, -4.8, -4.3], 6)
  await shell.mouse.wheel(0, 60)
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(20)
  await settled(shell)
})

test('[SP-15][PR-01] a theme with a gradient and grain survives relaunch (review M1)', async () => {
  const { app } = orbit
  const a = await activeSpace(app)
  const theme = { colors: ['#e85d9a', '#6b7cff'], intensity: 0.7, grain: 0.4 }
  await run(app, 'spaces.update', { spaceId: a, theme })
  await expect.poll(async () => (await state(app)).spaces[a]?.theme).toEqual(theme)
  const userData = orbit.userData
  await app.close()
  orbit = await launchOrbit({ userData })
  await expect.poll(async () => (await state(orbit.app)).spaces[a]?.theme).toEqual(theme)
  await expect.poll(() => bgVar(orbit.shell, '--bg-top')).not.toBe('')
})

test('[SP-15] a stored theme without colors still opens the window (review M1)', async () => {
  const { app } = orbit
  const a = await activeSpace(app)
  const userData = orbit.userData
  await app.close()
  const file = join(userData, 'orbit-state.json')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  saved.spaces[a].theme = { intensity: 0.6, grain: 0 }
  writeFileSync(file, JSON.stringify(saved))
  orbit = await launchOrbit({ userData })
  await expect(orbit.shell.getByTestId('sidebar')).toBeVisible()
  expect((await state(orbit.app)).spaces[a]?.theme).toEqual({ colors: [], intensity: 0.6, grain: 0 })
})

test('[SP-21][TB-09] a tab dropped right after an edge-dwell Space switch lands where it was dropped (review V1)', async () => {
  const { app, shell } = orbit
  const a = await activeSpace(app)
  const b = await createSpace(app, { name: 'B', activate: false })
  const inB: string[] = []
  for (let i = 0; i < 3; i++) inB.push(await newTab(app, fx.url(`/page/InB${i}`), { spaceId: b, activate: false }))
  const mover = await newTab(app, fx.url('/page/Mover'))
  await settled(shell)
  // Pressed once it has grown in and hit testing finds the row itself (PR #10 review M2).
  await expect
    .poll(() =>
      shell.evaluate((id) => {
        const slot = document.querySelector<HTMLElement>(`.row-slot[data-key="${id}"]`)
        const row = slot?.querySelector<HTMLElement>('[data-testid="tab-row"]')
        const b = row?.getBoundingClientRect()
        if (!slot || !row || !b || slot.classList.contains('is-growing')) return false
        const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
        return hit?.closest('[data-testid="tab-row"]') === row
      }, mover),
    )
    .toBe(true)
  const rowOf = (id: string) => shell.locator(`[data-testid="tab-row"][data-tab-id="${id}"]`)
  const start = await rowOf(mover).boundingBox()
  const sidebar = await shell.getByTestId('sidebar').boundingBox()
  if (!start || !sidebar) throw new Error('no layout')
  const sx = start.x + start.width / 2
  const sy = start.y + start.height / 2
  await shell.mouse.move(sx, sy)
  await shell.mouse.down()
  await shell.mouse.move(sx, sy + 6, { steps: 2 })
  await shell.mouse.move(sidebar.x + sidebar.width + 4, sy + 20, { steps: 8 })
  // Hold at the right edge until the window shows B…
  await expect.poll(() => activeSpace(app), { timeout: 4000 }).toBe(b)
  // …then go straight back over B's first row and let go about 150 ms after the switch.
  const firstB = inB[inB.length - 1] as string
  await expect(rowOf(firstB)).toBeVisible()
  const target = await rowOf(firstB).boundingBox()
  if (!target) throw new Error('no row')
  await shell.mouse.move(sx, target.y + 4, { steps: 4 })
  await sleep(60)
  await shell.mouse.up()
  // Dropped above B's first row: first in B's Today, not at the end.
  await expect.poll(async () => (await state(app)).spaces[b]?.today[0]).toBe(mover)
  expect((await state(app)).spaces[b]?.today).toHaveLength(4)
  expect((await state(app)).spaces[a]?.today).not.toContain(mover)
})

test('[PR-06][SP-07] a click switch between Spaces of one profile keeps the Favorites grid still (review V2)', async () => {
  const { app, shell } = orbit
  for (let i = 0; i < 3; i++) {
    await newTab(app, fx.url(`/page/Fav${i}`), { container: { kind: 'favorites', profileId: 'p-default' } })
  }
  const a = await activeSpace(app)
  const b = await createSpace(app, { name: 'Same profile', activate: false })
  for (let i = 0; i < 60; i++) await newTab(app, fx.url(`/page/Many${i}`), { spaceId: b, activate: false })
  await settled(shell)
  const tiles = () =>
    shell.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-slot="0"] .favorite')]
        .filter((el) => el.getClientRects().length > 0)
        .map((el) => {
          const r = el.getBoundingClientRect()
          return `${Math.round(r.x)}:${Math.round(r.width)}`
        })
        .join(' '),
    )
  // The new tiles' entrance animation must be over first (slow CI machines run it late).
  let before = ''
  await expect
    .poll(
      async () => {
        const first = await tiles()
        await sleep(250)
        before = await tiles()
        return first === before && before.split(' ').length === 3
      },
      { timeout: 10_000 },
    )
    .toBe(true)
  // Sample the visible tiles every frame while switching back and forth.
  const sampled = shell.evaluate(
    () =>
      new Promise<string[]>((done) => {
        const out = new Set<string>()
        const t0 = performance.now()
        const tick = () => {
          out.add(
            [...document.querySelectorAll<HTMLElement>('[data-slot="0"] .favorite')]
              .filter((el) => el.getClientRects().length > 0)
              .map((el) => {
                const r = el.getBoundingClientRect()
                return `${Math.round(r.x)}:${Math.round(r.width)}`
              })
              .join(' '),
          )
          if (performance.now() - t0 < 1400) requestAnimationFrame(tick)
          else done([...out])
        }
        requestAnimationFrame(tick)
      }),
  )
  await shell.locator(`[data-testid="space-dot"][data-space-id="${b}"]`).click()
  await sleep(600)
  await shell.locator(`[data-testid="space-dot"][data-space-id="${a}"]`).click()
  const seen = (await sampled).filter((g) => g !== '')
  // One grid on screen on every frame: no tile changes size or place.
  expect(new Set(seen).size).toBe(1)
  expect(seen[0]).toBe(before)
  expect(before.split(' ')).toHaveLength(3)
})

test('[SP-23][TB-17] switching Space never puts two windows on the same tab', async () => {
  const { app, shell } = orbit
  const a = await activeSpace(app)
  const t1 = await newTab(app, fx.url('/page/Shared1'))
  const t2 = await newTab(app, fx.url('/page/Shared2'), { activate: false })
  await run(app, 'tabs.activate', { tabId: t1 })
  const b = await createSpace(app, { name: 'B', activate: false })
  await settled(shell)
  const ids = (await state(app)).windows
  const w1 = Object.keys(ids)[0] as string
  // A second window on Space A.
  await app.evaluate(async (_e, w) => {
    const hooks = (globalThis as unknown as { __orbit: { action: (id: string, w?: string) => Promise<void> } }).__orbit
    await hooks.action('window.new', w)
  }, w1)
  await expect.poll(async () => Object.keys((await state(app)).windows).length).toBe(2)
  const w2 = Object.keys((await state(app)).windows).find((id) => id !== w1) as string
  const runIn = (w: string, name: string, args: unknown) =>
    app.evaluate(
      (_e, [ww, n, ar]) =>
        (
          globalThis as unknown as { __orbit: { run: (n: string, a: unknown, w?: string) => Promise<unknown> } }
        ).__orbit.run(n, ar, ww),
      [w, name, args] as const,
    )
  await runIn(w2, 'overlay.close', {})
  // Window 1 goes to B (remembering t1 for A); window 2 then shows t1.
  await runIn(w1, 'spaces.switch', { spaceId: b })
  await runIn(w2, 'tabs.activate', { tabId: t1 })
  await expect.poll(async () => (await state(app)).windows[w2]?.activeTab[a]).toBe(t1)
  // Window 1 comes back to A: it keeps t1, and window 2 shows another tab.
  await runIn(w1, 'spaces.switch', { spaceId: a })
  await expect.poll(async () => (await state(app)).windows[w1]?.spaceId).toBe(a)
  const s = await state(app)
  expect(s.windows[w1]?.activeTab[a]).toBe(t1)
  expect(s.windows[w2]?.activeTab[a]).toBe(t2)
})
