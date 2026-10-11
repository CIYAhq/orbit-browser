import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { activeTabId, isMac, launchOrbit, MOD, type Orbit, run, state, tabPage, viewPage } from './helpers'
import { focusedUrl, pressInPage } from './nav-support'
import { type PagesFixtures, startPagesFixtures } from './pages-support'
import { newTab, waitTab } from './tabs-support'

/**
 * History as a page in a tab (AR-10): `orbit://history/`, the Library's History section in a tab.
 * The Library's own section is tested in archive.spec.ts; a Mini Window's ⌘Y in keys.spec.ts.
 */

let fx: PagesFixtures
let orbit: Orbit

test.beforeAll(async () => {
  fx = await startPagesFixtures()
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

const HISTORY_URL = 'orbit://history/'
/** ⌘Y on macOS, Ctrl+H elsewhere, for pressInPage. */
const HISTORY_KEY: [string, ('meta' | 'control')[]] = isMac ? ['Y', ['meta']] : ['H', ['control']]

/** Visits the fixture's pages `names`, one tab each, in order. */
async function visit(app: ElectronApplication, names: string[], spaceId?: string): Promise<string[]> {
  const ids: string[] = []
  for (const name of names) {
    const tabId = await newTab(app, fx.url(`/page/${name}`), spaceId ? { spaceId } : {})
    await waitTab(app, tabId, `/page/${name}`)
    ids.push(tabId)
  }
  return ids
}

/** The tabs showing History. */
const historyTabs = async (app: ElectronApplication) =>
  Object.values((await state(app)).tabs)
    .filter((t) => t.url === HISTORY_URL)
    .map((t) => t.id)

/** The titles a History page lists, of the fixture's pages starting with `prefix`. */
const titles = (page: Page, prefix: string) => async () =>
  (await page.getByTestId('history-row-title').allTextContents()).filter((t) => t.startsWith(prefix))

test('[AR-10] ⌘Y (Ctrl+H) shows History as a page in a tab, newest first with search; ⌘Y and the command bar’s View History come back to it, up to date; an open Library makes way', async () => {
  const { app, shell } = orbit
  await visit(app, ['HistOne', 'HistTwo'])
  const before = Object.keys((await state(app)).tabs)
  await pressInPage(app, '/page/HistTwo', ...HISTORY_KEY)

  // A new tab, shown, with the keyboard in History's search field.
  await expect.poll(() => historyTabs(app)).toHaveLength(1)
  const [history] = await historyTabs(app)
  expect(before).not.toContain(history)
  await expect.poll(() => activeTabId(app)).toBe(history)
  const page = await tabPage(app, HISTORY_URL)
  await expect.poll(() => page.title()).toBe('History')
  await expect.poll(titles(page, 'Hist')).toEqual(['HistTwo', 'HistOne'])
  await expect(page.getByTestId('history-day').first()).toHaveText('Today')
  await expect.poll(() => focusedUrl(app)).toBe(HISTORY_URL)
  await expect(page.getByTestId('history-search')).toBeFocused()

  // Search; Enter opens the top match in a new tab, shown.
  await page.keyboard.type('histone')
  await expect.poll(titles(page, 'Hist')).toEqual(['HistOne'])
  await page.keyboard.press('Enter')
  let opened = ''
  await expect
    .poll(async () => {
      opened = (await activeTabId(app)) ?? ''
      return opened !== history && !before.includes(opened)
    })
    .toBe(true)
  await waitTab(app, opened, '/page/HistOne')

  // ⌘Y from another page shows the same tab again, its list up to date (the search kept).
  const [three] = await visit(app, ['HistThree'])
  await pressInPage(app, '/page/HistThree', ...HISTORY_KEY)
  await expect.poll(() => activeTabId(app)).toBe(history)
  expect(await historyTabs(app)).toEqual([history])
  await expect.poll(titles(page, 'Hist')).toEqual(['HistOne', 'HistOne'])
  await page.getByTestId('history-search').fill('')
  await expect.poll(titles(page, 'Hist')).toEqual(['HistThree', 'HistOne', 'HistTwo', 'HistOne'])

  // The command bar's View History, with its key.
  await run(app, 'tabs.activate', { tabId: three })
  await shell.keyboard.press(`${MOD}+T`)
  const overlay = await viewPage(app, 'overlay')
  await expect(overlay.getByTestId('command-input')).toBeFocused()
  await overlay.keyboard.type('View History')
  const top = overlay.getByTestId('command-result').first()
  await expect(top.getByTestId('command-result-title')).toHaveText('View History')
  await expect(top.getByTestId('command-shortcut')).toHaveText(isMac ? '⌘Y' : 'Ctrl+H')
  await overlay.keyboard.press('Enter')
  await expect.poll(() => activeTabId(app)).toBe(history)
  expect(await historyTabs(app)).toEqual([history])

  // ⌘Y in the Library over the History tab: the Library makes way.
  await run(app, 'library.open', { section: 'archive' })
  let library: Page | undefined
  await expect
    .poll(() => {
      library = app.windows().find((p) => p.url().includes('view=library'))
      return !!library
    })
    .toBe(true)
  await expect((library as Page).getByTestId('library')).toHaveAttribute('data-open', 'true')
  await pressInPage(app, 'view=library', ...HISTORY_KEY)
  await expect.poll(async () => ((await run(app, 'library.status')) as { open: boolean }).open).toBe(false)
  expect(await activeTabId(app)).toBe(history)
  expect(await historyTabs(app)).toEqual([history])
})

test('[AR-10] History removes a page with × or its menu, and shows only its own tab’s profile: it can’t ask about another or open a page it didn’t list (D53)', async () => {
  const { app } = orbit
  await visit(app, ['KeepMe', 'GoneMe', 'MenuMe'])
  await pressInPage(app, '/page/MenuMe', ...HISTORY_KEY)
  const page = await tabPage(app, HISTORY_URL)
  const [history] = await historyTabs(app)
  const row = (title: string) => page.getByTestId('history-row').filter({ hasText: title })
  const visited = async () =>
    ((await run(app, 'history.visits', { limit: 50 })) as { title: string }[]).map((v) => v.title)
  await expect.poll(titles(page, '')).toEqual(['MenuMe', 'GoneMe', 'KeepMe'])

  // × removes every visit to the page.
  await row('GoneMe').hover()
  await row('GoneMe').getByTestId('history-remove').click()
  await expect(row('GoneMe')).toHaveCount(0)
  await expect.poll(visited).not.toContain('GoneMe')

  // Its menu: Open in Background opens the page behind History, which says so.
  await row('MenuMe').click({ button: 'right' })
  await expect
    .poll(() => run(app, 'pages.testHistoryMenu', {}))
    .toEqual(['Open in New Tab', 'Open in Background', 'Copy Link', 'Remove from History'])
  const tabsBefore = Object.keys((await state(app)).tabs)
  await run(app, 'pages.testHistoryMenu', { click: 'Open in Background' })
  await expect(page.getByTestId('library-toast')).toContainText('Opened in a new tab')
  await expect
    .poll(async () =>
      Object.values((await state(app)).tabs)
        .filter((t) => !tabsBefore.includes(t.id))
        .map((t) => t.url),
    )
    .toEqual([fx.url('/page/MenuMe')])
  expect(await activeTabId(app)).toBe(history)
  // Remove from History: the row goes, with every visit to the page.
  await row('MenuMe').first().click({ button: 'right' })
  await run(app, 'pages.testHistoryMenu', { click: 'Remove from History' })
  await expect(row('MenuMe')).toHaveCount(0)
  await expect.poll(visited).not.toContain('MenuMe')

  // Another profile's Space has its own visits, and its own History tab.
  const work = (await run(app, 'profiles.create', { name: 'Work' })) as string
  const workSpace = (await run(app, 'spaces.create', { name: 'Workspace', profileId: work, activate: true })) as string
  await expect.poll(async () => Object.values((await state(app)).windows)[0]?.spaceId).toBe(workSpace)
  await visit(app, ['WorkOnly'], workSpace)
  await pressInPage(app, '/page/WorkOnly', ...HISTORY_KEY)
  await expect.poll(async () => (await historyTabs(app)).length).toBe(2)
  const [workHistory] = (await historyTabs(app)).filter((id) => id !== history)
  expect((await state(app)).tabs[workHistory as string]?.spaceId).toBe(workSpace)
  let workPage: Page | undefined
  await expect
    .poll(() => {
      workPage = app.windows().find((p) => p.url() === HISTORY_URL && p !== page)
      return !!workPage
    })
    .toBe(true)
  await expect.poll(titles(workPage as Page, '')).toEqual(['WorkOnly'])

  // The first History page asks about the other profile and gets its own; it opens no page it didn't
  // list, and runs no command that isn't its own.
  const ask = (command: string, args: unknown) =>
    page.evaluate(
      ([c, a]) =>
        (window as unknown as { orbit: { invoke: (c: string, a: unknown) => Promise<unknown> } }).orbit
          .invoke(c, a)
          .then(
            (result) => result,
            () => 'refused',
          ),
      [command, args] as const,
    )
  const listed = (await ask('pages.history', { profileId: work, limit: 50 })) as { title: string }[]
  expect(listed.map((v) => v.title)).toEqual(['KeepMe'])
  const count = Object.keys((await state(app)).tabs).length
  expect(await ask('pages.historyOpen', { url: fx.url('/page/WorkOnly') })).toBeUndefined()
  expect(await ask('pages.historyOpen', { url: 'file:///' })).toBeUndefined()
  expect(await ask('tabs.create', { url: fx.url('/page/Sneaky'), spaceId: workSpace })).toBe('refused')
  expect(await ask('history.visits', { profileId: work })).toBe('refused')
  expect(Object.keys((await state(app)).tabs)).toHaveLength(count)
})
