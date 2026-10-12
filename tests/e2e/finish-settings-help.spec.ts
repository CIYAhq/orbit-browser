import { readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test'
import { ACTIONS_BY_ID, formatAccelerator, shortcutsFor } from '../../src/shared/actions'
import { GUIDE_URL, HELP_URL, ISSUES_URL, WELCOME_URL } from '../../src/shared/project'
import type { OrbitState } from '../../src/shared/state'
import { action, isMac, listenInRange, MOD, run, state, tabPage, viewPage } from './helpers'
import {
  type FirstRun,
  focusBrowserWindow,
  launchFirstRun,
  osWindows,
  pageOfView,
  remoteRequests,
} from './settings-support'

/**
 * Orbit's own help (finish-settings lane): the first window (OB-09), the getting-started guide
 * (OB-10), hints (OB-11) and Help (OB-13). Feature IDs lead each title.
 */

let orbit: FirstRun | undefined
let server: Server | undefined
let base = ''

test.beforeAll(async () => {
  // Pages of our own, on this computer: each says which keys it heard.
  server = createServer((req, res) => {
    const title = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname.slice(1)) || 'Page'
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      `<!doctype html><meta charset="utf-8"><title>${title}</title><body><h1>${title}</h1>` +
        `<script>window.heard = []; addEventListener('keydown', (e) => heard.push(e.key))</script>`,
    )
  })
  base = `http://localhost:${await listenInRange(server, 3330)}`
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
})

test.afterEach(async () => {
  await orbit?.app.close().catch(() => {})
  orbit = undefined
})

/** The dictionary Chromium's spellchecker asks for: Chromium's, and refused offline (OB-02). */
const SPELLCHECK_DICTIONARY = /^https:\/\/redirector\.gvt1\.com\/edgedl\/chrome\/dict\/[\w.-]+\.bdic$/

/** An action's first key on this system, before any remap ("Ctrl+S"), or ''. */
function accelOf(actionId: string): string {
  const def = ACTIONS_BY_ID[actionId]
  return (def ? shortcutsFor(def, process.platform)[0] : undefined) ?? ''
}

/** That key as Orbit shows it ("⌘S", "Ctrl+S"). */
function keysOf(actionId: string): string {
  const accel = accelOf(actionId)
  return accel ? formatAccelerator(accel, process.platform) : ''
}

function launchWithOnboarding(): Promise<FirstRun> {
  return launchFirstRun({ env: { ORBIT_ONBOARDING: '1', ORBIT_IMPORT_PLACES: '[]', ORBIT_SYSTEM_KEYS: '[]' } })
}

/** Does something that closes the onboarding window, which can close it while Playwright still acts. */
async function closing(page: Page, act: () => Promise<void>): Promise<void> {
  await act().catch(async (err: unknown) => {
    if (!page.isClosed()) await page.waitForEvent('close', { timeout: 2000 }).catch(() => {})
    if (!page.isClosed()) throw err
  })
}

function firstWindow(s: OrbitState) {
  const win = Object.values(s.windows).find((w) => w.kind === 'main')
  if (!win) throw new Error('No browser window')
  return win
}

/** A tab's title attribute, as the pointer would show it. */
function tooltip(locator: Locator): Promise<string | null> {
  return locator.getAttribute('title')
}

test('[OB-09][OB-10][OB-11] the first window: about 80% of the screen, centred, "Orbit basics" on top of pinned, the welcome page in Today; Getting Started opens the guide, with the keys as they are', async () => {
  orbit = await launchWithOnboarding()
  const { app } = orbit
  const page = await pageOfView(app, 'onboarding')
  await expect(page.getByTestId('onboarding-step-welcome')).toBeVisible()
  // Through every step, choosing nothing: no import, no Favorites.
  await page.getByTestId('onboarding-next').click()
  await page.getByTestId('onboarding-import-later').click()
  for (const step of ['theme', 'favorites', 'ads']) {
    await expect(page.getByTestId(`onboarding-step-${step}`)).toBeVisible()
    await page.getByTestId('onboarding-next').click()
  }
  await page.getByTestId('onboarding-browser-later').click()
  await expect(page.getByTestId('onboarding-step-done')).toBeVisible()
  await closing(page, () => page.getByTestId('onboarding-start').click())
  const shell = await viewPage(app, 'shell')
  await expect(shell.getByTestId('sidebar')).toBeVisible()

  // Centred, at about 80% of the screen's width and height.
  const area = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
  const [win] = await osWindows(app, 'shell')
  const bounds = win?.bounds as { x: number; y: number; width: number; height: number }
  expect(Math.abs(bounds.width - area.width * 0.8)).toBeLessThanOrEqual(2)
  expect(Math.abs(bounds.height - area.height * 0.8)).toBeLessThanOrEqual(2)
  expect(Math.abs(bounds.x + bounds.width / 2 - (area.x + area.width / 2))).toBeLessThanOrEqual(2)
  expect(Math.abs(bounds.y + bounds.height / 2 - (area.y + area.height / 2))).toBeLessThanOrEqual(2)

  // "Orbit basics" at the top of the pinned section, open: the guide and Help, unloaded till opened.
  const s = await state(app)
  const spaceId = s.spaceOrder[0] as string
  const space = s.spaces[spaceId]
  const basicsId = space?.pinned[0] as string
  expect(s.folders[basicsId]?.name).toBe('Orbit basics')
  expect(s.folders[basicsId]?.children.map((id) => [s.tabs[id]?.url, s.tabs[id]?.asleep])).toEqual([
    [GUIDE_URL, true],
    [HELP_URL, true],
  ])
  const basics = shell.locator(`[data-testid="folder"][data-folder-id="${basicsId}"]`)
  await expect(basics.getByTestId('folder-title')).toHaveText('Orbit basics')
  await expect(basics.getByTestId('tab-title')).toHaveText(['Getting Started', 'Orbit Help'])
  // One Today tab, Orbit's welcome page, in front; the command bar stays closed.
  expect(space?.today.map((id) => s.tabs[id]?.url)).toEqual([WELCOME_URL])
  expect(firstWindow(s).activeTab[spaceId]).toBe(space?.today[0])
  expect(firstWindow(s).overlay.kind).toBe('none')
  const welcome = await tabPage(app, WELCOME_URL)
  await expect(welcome.getByRole('heading', { level: 1 })).toHaveText('Welcome to Orbit')
  await expect(welcome.getByTestId('welcome-tip')).toHaveCount(5)
  await expect(welcome.locator('kbd[data-action="tab.new"]')).toHaveText(keysOf('tab.new'))

  // OB-11: tooltips name the keys: "+ New Tab", the tab in front's Close (not another's), the window's Close.
  await expect.poll(() => tooltip(shell.getByTestId('new-tab-button'))).toBe(`New Tab (${keysOf('tab.new')})`)
  const welcomeRow = shell.locator(`[data-testid="tab-row"][data-tab-id="${space?.today[0]}"]`)
  expect(await tooltip(welcomeRow.getByTestId('tab-close'))).toBe(`Close (${keysOf('tab.close')})`)
  expect(await tooltip(basics.getByTestId('tab-close').first())).toBe('Close')
  if (!isMac) {
    const close = shell.getByTestId('window-controls').getByRole('button', { name: 'Close window' })
    expect(await tooltip(close)).toBe(`Close (${keysOf('window.close')})`)
  }

  // OB-10: "Getting started" in the command bar opens the guide in a tab.
  await shell.keyboard.press(`${MOD}+T`)
  const overlay = await viewPage(app, 'overlay')
  const input = overlay.getByTestId('command-input')
  await expect(input).toBeFocused()
  await input.fill('getting started')
  const row = overlay
    .locator('[data-testid="command-result"][data-kind="action"]')
    .filter({ hasText: 'Getting Started' })
  await expect(row).toHaveCount(1)
  await row.click()
  const guide = await tabPage(app, GUIDE_URL)
  await expect(guide.getByRole('heading', { level: 1 })).toHaveText('Getting started with Orbit')
  await expect(guide.getByTestId('help-section').locator('h2')).toHaveText([
    'The sidebar',
    'Spaces',
    'Pinned, Favorites and Today',
    'The command bar',
    'Split view',
    'Peek',
    'Mini Window',
    'Site controls',
    'Essential shortcuts',
  ])
  // It ends with the essential shortcuts (OB-12's groups), with the user's keys.
  const table = guide.getByTestId('guide-shortcuts')
  await expect(table.locator('th')).toHaveText(['Everyday', 'Navigation', 'Spaces', 'Split View'])
  const toggleRow = table.getByTestId('guide-shortcut').filter({ hasText: 'Toggle Sidebar' })
  await expect(toggleRow.locator('kbd')).toHaveText(keysOf('sidebar.toggle'))
  // A key changed in Settings shows at once, in the text and the table (KS-18).
  const was = accelOf('sidebar.toggle')
  expect(await run(app, 'keys.bind', { actionId: 'sidebar.toggle', accel: 'F8', replace: was })).toEqual({ ok: true })
  await expect(toggleRow.locator('kbd')).toHaveText('F8')
  await expect(guide.locator('#sidebar kbd[data-action="sidebar.toggle"]')).toHaveText('F8')

  // Its buttons: the shortcut sheet in this window, and Settings → Shortcuts for all of them.
  await guide.getByTestId('guide-sheet').click()
  const sheet = overlay.getByTestId('shortcut-sheet')
  await expect(sheet).toBeVisible()
  await expect(sheet.getByTestId('shortcut-sheet-row').filter({ hasText: 'Toggle Sidebar' })).toContainText('F8')
  await overlay.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await guide.getByTestId('guide-settings-shortcuts').click()
  const settings = await pageOfView(app, 'settings')
  await expect(settings.getByTestId('settings-content')).toHaveAttribute('data-section', 'shortcuts')

  // Local pages all along: nothing went online.
  await app.close()
  expect(remoteRequests(orbit.netLog).filter((url) => !SPELLCHECK_DICTIONARY.test(url))).toEqual([])
})

test('[OB-13] Help opens Orbit’s own page: its answers, the shortcut sheet, build info, and Report a Bug as a draft the user sends', async () => {
  orbit = await launchFirstRun()
  const { app } = orbit
  const shell = await viewPage(app, 'shell')
  await expect(shell.getByTestId('sidebar')).toBeVisible()
  await action(app, 'help.open')
  const help = await tabPage(app, HELP_URL)
  await expect.poll(async () => firstWindow(await state(app)).overlay.kind).toBe('none')
  await expect(help.getByRole('heading', { level: 1 })).toHaveText('Orbit Help')
  await expect(help.getByTestId('help-section').locator('h2')).toHaveText([
    'New to Orbit?',
    'Where did my tabs go?',
    'Where did the sidebar go?',
    'Can I bring my bookmarks along?',
    'Does Orbit send what I do anywhere?',
    'Is my Orbit up to date?',
    'Keyboard shortcuts',
    'Something wrong?',
  ])
  await expect(help.locator('kbd[data-action="sidebar.toggle"]')).toHaveText(keysOf('sidebar.toggle'))
  await expect(help.getByTestId('help-section').nth(1)).toContainText('haven’t used for 12 hours')

  // The shortcut sheet (OB-12), over this window.
  await help.getByTestId('help-shortcuts').click()
  const overlay = await viewPage(app, 'overlay')
  await expect(overlay.getByTestId('shortcut-sheet')).toBeVisible()
  await overlay.keyboard.press('Escape')
  await expect(overlay.getByTestId('shortcut-sheet')).toHaveCount(0)

  // Build info, for a report.
  await app.evaluate(({ clipboard }) => clipboard.clear())
  await help.getByTestId('help-copy-build-info').click()
  await expect(shell.getByTestId('toast').last()).toContainText('Copied build info')
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toMatch(/^Orbit \S+ \(built \d{4}-\d{2}-\d{2}\)/)

  // Settings, at the section an answer names.
  await help.getByRole('button', { name: 'Settings → Privacy' }).click()
  const settings = await pageOfView(app, 'settings')
  await expect(settings.getByTestId('settings-content')).toHaveAttribute('data-section', 'privacy')
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('view=settings')) w.close()
  })

  // Report a Bug: a new tab with a draft issue, the version filled in, for the user to send.
  const before = Object.keys((await state(app)).tabs).length
  await help.getByTestId('help-report-bug').click()
  await expect.poll(async () => Object.keys((await state(app)).tabs).length).toBe(before + 1)
  const s = await state(app)
  const win = firstWindow(s)
  const draft = s.tabs[win.activeTab[win.spaceId] as string]?.url ?? ''
  expect(draft.startsWith(`${ISSUES_URL}/new?body=`)).toBe(true)
  expect(new URL(draft).searchParams.get('body')).toContain('Steps to make it happen again')

  // The guide is a link away.
  const helpTab = Object.values(s.tabs).find((t) => t.url === HELP_URL)?.id as string
  await run(app, 'tabs.activate', { tabId: helpTab })
  await help.getByTestId('help-guide').click()
  await expect.poll(async () => (await state(app)).tabs[helpTab]?.url).toBe(GUIDE_URL)
})

/** Sets how long ago tabs were last used, in the state file of a closed Orbit. */
function ageTabs(userData: string, match: (url: string) => boolean, ms: number): void {
  const file = join(userData, 'orbit-state.json')
  const saved = JSON.parse(readFileSync(file, 'utf8')) as OrbitState
  for (const tab of Object.values(saved.tabs)) if (match(tab.url)) tab.lastActiveAt = Date.now() - ms
  writeFileSync(file, JSON.stringify(saved))
}

/**
 * Presses a key in a tab's page as the keyboard does: main hears it first (before-input-event),
 * which a key Playwright sends over the DevTools protocol skips.
 */
async function pressInPage(app: ElectronApplication, url: string, keyCode: string): Promise<void> {
  await app.evaluate(
    ({ webContents }, [pageUrl, key]) => {
      const contents = webContents.getAllWebContents().find((c) => c.getURL() === pageUrl)
      if (!contents) throw new Error(`No page at ${pageUrl}`)
      contents.focus()
      contents.sendInputEvent({ type: 'keyDown', keyCode: key })
      contents.sendInputEvent({ type: 'keyUp', keyCode: key })
    },
    [url, keyCode] as const,
  )
}

/** Polls until `ms` has passed since `since`, failing if the locator went away before. */
async function staysFor(locator: Locator, since: number, ms: number): Promise<void> {
  await expect
    .poll(
      async () => {
        if (!(await locator.isVisible())) return 'gone'
        return Date.now() - since >= ms ? 'stayed' : 'waiting'
      },
      { timeout: ms + 4000, intervals: [100] },
    )
    .not.toBe('waiting')
  expect(await locator.isVisible()).toBe(true)
}

/** A dismissed hint is gone this soon: well before the 6 s it would stay. */
const DISMISSED_MS = 2500

test('[OB-11] hints: the first auto-archive explains itself once; a hidden sidebar says how to bring it back, three times; they stay about 6 s, longer when hovered, and ✕ or Esc dismisses them without taking the key from the page', async () => {
  const HOURS = 3600_000
  orbit = await launchFirstRun({ env: { ORBIT_HINTS: '1' } })
  let { app } = orbit
  const { userData } = orbit
  await expect((await viewPage(app, 'shell')).getByTestId('sidebar')).toBeVisible()
  await run(app, 'tabs.create', { url: `${base}/Kept`, activate: true })
  for (const name of ['Old one', 'Old two']) await run(app, 'tabs.create', { url: `${base}/${name}`, activate: false })
  await expect.poll(async () => Object.keys((await state(app)).tabs).length).toBe(3)
  await app.close()
  ageTabs(userData, (url) => url.includes('/Old'), 13 * HOURS)

  // The next launch archives them (TD-03); the browser window in front says so.
  orbit = await launchFirstRun({ userData, env: { ORBIT_HINTS: '1' } })
  app = orbit.app
  let shell = await viewPage(app, 'shell')
  await expect(shell.getByTestId('sidebar')).toBeVisible()
  await focusBrowserWindow(app)
  const archiveHint = shell.locator('[data-testid="toast"][data-hint="true"]')
  await expect(archiveHint).toBeVisible({ timeout: 15_000 })
  const seen = Date.now()
  await expect(archiveHint).toContainText(
    '2 Today tabs you hadn’t used for 12 hours moved to the Archive. You can restore them from there.',
  )
  await expect(archiveHint.getByTestId('toast-action')).toHaveText('View Archive')
  await expect(archiveHint.getByTestId('toast-close')).toBeVisible()
  let s = await state(app)
  expect(s.archive.filter((e) => e.reason === 'auto')).toHaveLength(2)
  expect(s.settings.hintsShown).toEqual({ archive: 1 })
  // Long enough to read: still there 4.5 s after it was first seen, gone soon after 6 s.
  await staysFor(archiveHint, seen, 4500)
  await expect(archiveHint).toHaveCount(0, { timeout: 4000 })

  // The sidebar hidden: over the page (SB-13), how to bring it back.
  const page = await tabPage(app, `${base}/Kept`)
  await action(app, 'sidebar.toggle')
  const toasts = await viewPage(app, 'toasts')
  const sidebarHint = toasts.locator('[data-testid="toast"][data-hint="true"]')
  await expect(sidebarHint).toContainText(
    `The sidebar is hidden. ${keysOf('sidebar.toggle')} brings it back, or point at the window’s left edge.`,
  )
  await expect(sidebarHint.getByTestId('toast-action')).toHaveText('Show')
  // ✕ dismisses it at once (well before its 6 s), and only that: the sidebar stays hidden.
  await sidebarHint.getByTestId('toast-close').click()
  await expect(sidebarHint).toHaveCount(0, { timeout: DISMISSED_MS })
  expect(firstWindow(await state(app)).sidebar.visible).toBe(false)
  // The pointer moves off, so the next one isn't hovered where this one was.
  await toasts.mouse.move(1, 1)

  // The second time: Esc in the page dismisses it, and the page still gets its Esc.
  await action(app, 'sidebar.toggle')
  await action(app, 'sidebar.toggle')
  await expect(sidebarHint).toBeVisible()
  await pressInPage(app, `${base}/Kept`, 'Escape')
  await expect(sidebarHint).toHaveCount(0, { timeout: DISMISSED_MS })
  await expect.poll(() => page.evaluate(() => (window as unknown as { heard: string[] }).heard)).toEqual(['Escape'])
  expect(firstWindow(await state(app)).sidebar.visible).toBe(false)

  // The third time: hovered, it stays past its 6 s; its button shows the sidebar.
  await action(app, 'sidebar.toggle')
  await action(app, 'sidebar.toggle')
  await expect(sidebarHint).toBeVisible()
  const hovered = Date.now()
  await sidebarHint.hover()
  await staysFor(sidebarHint, hovered, 7000)
  await sidebarHint.getByTestId('toast-action').click()
  await expect.poll(async () => firstWindow(await state(app)).sidebar.visible).toBe(true)
  await expect(sidebarHint).toHaveCount(0)

  // No fourth: a toast after the sidebar hides again is the only one.
  await action(app, 'sidebar.toggle')
  expect((await state(app)).settings.hintsShown).toEqual({ archive: 1, sidebar: 3 })
  await action(app, 'help.copyBuildInfo')
  await expect(toasts.getByTestId('toast').filter({ hasText: 'Copied build info' })).toBeVisible()
  await expect(sidebarHint).toHaveCount(0)
  await action(app, 'sidebar.toggle')

  // Once: the next auto-archive, a launch later, is not explained again.
  await run(app, 'tabs.create', { url: `${base}/Old three`, activate: false })
  await expect.poll(async () => Object.keys((await state(app)).tabs).length).toBe(2)
  await app.close()
  ageTabs(userData, (url) => url.includes('/Old'), 13 * HOURS)
  orbit = await launchFirstRun({ userData, env: { ORBIT_HINTS: '1' } })
  app = orbit.app
  shell = await viewPage(app, 'shell')
  await expect(shell.getByTestId('sidebar')).toBeVisible()
  await focusBrowserWindow(app)
  await expect.poll(async () => (await state(app)).archive.filter((e) => e.reason === 'auto').length).toBe(3)
  await action(app, 'help.copyBuildInfo')
  await expect(shell.getByTestId('toast').filter({ hasText: 'Copied build info' })).toBeVisible()
  await expect(shell.locator('[data-testid="toast"][data-hint="true"]')).toHaveCount(0)
  s = await state(app)
  expect(s.settings.hintsShown).toEqual({ archive: 1, sidebar: 3 })
})
