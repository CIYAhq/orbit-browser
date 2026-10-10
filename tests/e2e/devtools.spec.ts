import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import type { MainContext } from '../../src/main/context'
import { INTERNAL_DOCUMENT_CSP } from '../../src/main/devtools/internal-urls'
import type { DevtoolsState, DockSide } from '../../src/shared/commands/devtools'
import type { OrbitState } from '../../src/shared/state'
import {
  action,
  activeTabId,
  isMac,
  launchOrbit,
  listenInRange,
  MOD,
  type Orbit,
  openViaCommandBar,
  run,
  state,
  tabPage,
  tabView,
  viewPage,
} from './helpers'
import { clickInTab } from './peek-helpers'

/**
 * DevTools (DT-01 to DT-03) and hard reload (DT-14). Keys are sent to whatever has the keyboard
 * (`'focused'`), as the OS would, or to a page or its DevTools, through the browser's input
 * handling (where Orbit's shortcuts listen). DevTools' own state is read in their page through the
 * engine's front-end modules.
 */

type OrbitGlobal = { __orbit: { ctx: MainContext } }

interface Request {
  path: string
  cacheControl?: string
  pragma?: string
}

interface Site {
  url: (path: string) => string
  requests: (path: string) => Request[]
  close: () => Promise<void>
}

const page = (title: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="margin:0;font:16px system-ui;background:#f4f0ff">
<h1 id="title" style="margin:16px">${title}</h1>
<div id="target" style="position:absolute;left:40px;top:120px;width:200px;height:80px;background:#c9f">Target</div>
<div id="other" style="position:absolute;left:40px;top:240px;width:200px;height:80px;background:#9cf">Other</div>
</body></html>`

/** A web page with links to internal pages (DT-13), one per row, 60 px apart from y = 30. */
const LINKS = `<!doctype html><html><head><meta charset="utf-8"><title>Links</title>
<style>body{margin:0;font:16px system-ui}a{position:absolute;left:20px;width:300px;height:40px;display:block}</style>
</head><body>
<a id="internal" href="orbit://pages/" style="top:10px">Internal pages</a>
<a id="internal-blank" href="orbit://version/" target="_blank" style="top:70px">Version, in a new tab</a>
</body></html>`
const LINK_AT = { internal: { x: 60, y: 30 }, internalBlank: { x: 60, y: 90 } }

/**
 * `/page/<title>`: two boxes to inspect. `/cached/page` loads `/cached/asset.js`, cacheable for an
 * hour. `/links`: links to internal pages. `/to-internal` redirects to one.
 */
async function startSite(): Promise<Site> {
  const log: Request[] = []
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const header = (name: string) => {
      const value = req.headers[name]
      return Array.isArray(value) ? value.join(', ') : value
    }
    log.push({ path, cacheControl: header('cache-control'), pragma: header('pragma') })
    if (path.startsWith('/page/')) {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(page(decodeURIComponent(path.slice('/page/'.length))))
    } else if (path === '/cached/page') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<!doctype html><title>Cached</title><h1 id="title">Cached</h1><script src="/cached/asset.js"></script>`)
    } else if (path === '/links') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(LINKS)
    } else if (path === '/to-internal') {
      res.writeHead(302, { location: 'orbit://version/' })
      res.end()
    } else if (path === '/cached/asset.js') {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'max-age=3600' })
      res.end('window.assetRuns = (window.assetRuns || 0) + 1')
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    }
  })
  const port = await listenInRange(server, 3300 + (Number(process.env.TEST_PARALLEL_INDEX ?? 0) % 50))
  return {
    url: (path) => `http://localhost:${port}${path}`,
    requests: (path) => log.filter((r) => r.path === path),
    close: () => new Promise((r) => server.close(() => r())),
  }
}

let site: Site
let orbit: Orbit

test.beforeEach(async () => {
  site = await startSite()
  orbit = await launchOrbit()
  await orbit.app.evaluate(({ clipboard }) => clipboard.clear())
})
test.afterEach(async () => {
  await orbit.app.close().catch(() => {})
  await site.close()
})

// ---- Pages, keys and DevTools' own state ----

/** Opens a fixture page in a new, selected tab. */
async function openPage(title: string): Promise<string> {
  const tabId = (await run(orbit.app, 'tabs.create', { url: site.url(`/page/${title}`) })) as string
  await expect.poll(() => inPage(tabId, 'document.title')).toBe(title)
  return tabId
}

/** Runs a script in a tab's page. */
function inPage<T>(tabId: string, script: string): Promise<T | null> {
  return orbit.app.evaluate(
    async (_e, [id, code]) => {
      const contents = (globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs.contents(id)
      return contents && !contents.isDestroyed() && !contents.isCrashed() ? contents.executeJavaScript(code) : null
    },
    [tabId, script] as const,
  )
}

/** Runs a script in a tab's DevTools page; null while they are closed. */
function inDevtools<T>(tabId: string, script: string): Promise<T | null> {
  return orbit.app.evaluate(
    async (_e, [id, code]) => {
      const contents = (globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs.contents(id)
      const devtools = contents?.isDevToolsOpened() ? contents.devToolsWebContents : null
      return devtools ? devtools.executeJavaScript(code) : null
    },
    [tabId, script] as const,
  )
}

const legacy = (body: string) => `(async () => { const legacy = await import('./ui/legacy/legacy.js'); ${body} })()`
/** What DevTools' dock menu does. */
const setDockSide = (side: DockSide) => legacy(`legacy.DockController.DockController.instance().setDockSide('${side}')`)
const SIZE = legacy('return legacy.InspectorView.InspectorView.instance().ownerSplitWidget.sidebarSize()')
/** What dragging the divider between the page and DevTools does when the drag ends. */
const setSize = (px: number) =>
  legacy(`legacy.InspectorView.InspectorView.instance().ownerSplitWidget.setSidebarSize(${px})`)
const PANEL = legacy('return legacy.InspectorView.InspectorView.instance().tabbedPane.selectedTabId')
const SELECTED = `(async () => {
  const SDK = await import('./core/sdk/sdk.js');
  const UI = await import('./ui/legacy/legacy.js');
  const node = UI.Context.Context.instance().flavor(SDK.DOMModel.DOMNode);
  return node ? node.getAttribute('id') || node.nodeName() : null;
})()`
const PICKING = `(async () => {
  const m = await import('./panels/elements/elements.js');
  return m.InspectElementModeController.InspectElementModeController.instance().isInInspectElementMode();
})()`
const PROMPT = `(async () => (await import('./panels/console/console.js')).ConsoleView.ConsoleView.instance().prompt.text())()`
/** DevTools' own guard against pasting into the Console ("allow pasting"), acknowledged. */
const ALLOW_PASTING = `(async () => {
  const common = await import('./core/common/common.js');
  common.Settings.Settings.instance().createSetting('disable-self-xss-warning', false, 'Synced').set(true);
})()`
const DEVICE_MODE = `(async () =>
  (await import('./core/common/common.js')).Settings.Settings.instance().createSetting('emulation.show-device-mode', false).get())()`

const devtoolsState = (tabId: string) => run(orbit.app, 'devtools.state', { tabId }) as Promise<DevtoolsState>
const isOpen = async (tabId: string) => (await devtoolsState(tabId)).open

type Target = 'focused' | { tab: string } | { devtools: string }

/**
 * Sends a key event, through the browser's input handling, to what has the keyboard or to a given
 * page or DevTools. `accel` is like "F12" or "Shift+Mod+R" (Mod: ⌘ on macOS, Ctrl elsewhere).
 * Returns the URL of the web contents that got it.
 */
function key(target: Target, accel: string, type: 'keyDown' | 'keyUp', repeat = false): Promise<string> {
  return orbit.app.evaluate(
    ({ webContents }, [to, keys, kind, held, mac]) => {
      const { ctx } = (globalThis as unknown as OrbitGlobal).__orbit
      const contents =
        to === 'focused'
          ? webContents.getFocusedWebContents()
          : 'tab' in to
            ? ctx.tabs.contents(to.tab)
            : ctx.tabs.contents(to.devtools)?.devToolsWebContents
      if (!contents) throw new Error(`no web contents to press ${keys} in`)
      const parts = keys.split('+')
      const keyCode = parts.pop() as string
      type Modifier = 'shift' | 'control' | 'alt' | 'meta' | 'isautorepeat'
      const modifiers = parts.map((m) => (m === 'Mod' ? (mac ? 'meta' : 'control') : m.toLowerCase())) as Modifier[]
      if (held) modifiers.push('isautorepeat')
      contents.sendInputEvent({ type: kind, keyCode, modifiers })
      return contents.getURL()
    },
    [target, accel, type, repeat, isMac] as const,
  )
}

async function press(target: Target, accel: string): Promise<string> {
  const url = await key(target, accel, 'keyDown')
  await key(target, accel, 'keyUp')
  return url
}

const TOGGLE = isMac ? 'Mod+Alt+I' : 'Shift+Ctrl+I'

/** Gives a tab's page the keyboard. */
async function focusPage(tabId: string): Promise<void> {
  await orbit.app.evaluate((_e, id) => {
    ;(globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs.contents(id)?.focus()
  }, tabId)
  await expect.poll(() => focusedUrl()).toContain('/page/')
}

const focusedUrl = () =>
  orbit.app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL() ?? 'nothing')

const clipboardText = () => orbit.app.evaluate(({ clipboard }) => clipboard.readText())

/** Clicks an element of a tab's page, through the browser's input handling. */
async function clickOn(tabId: string, selector: string, button: 'left' | 'right' = 'left'): Promise<void> {
  const box = await inPage<{ x: number; y: number }>(
    tabId,
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`,
  )
  if (!box) throw new Error(`no ${selector} in ${tabId}`)
  await orbit.app.evaluate(
    (_e, [id, point, which]) => {
      const contents = (globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs.contents(id)
      if (!contents) throw new Error(`no page for ${id}`)
      contents.sendInputEvent({ type: 'mouseMove', ...point })
      contents.sendInputEvent({ type: 'mouseDown', ...point, button: which, clickCount: 1 })
      contents.sendInputEvent({ type: 'mouseUp', ...point, button: which, clickCount: 1 })
    },
    [tabId, box, button] as const,
  )
}

/** Counts a tab's calls to open DevTools, from now on. */
async function countOpenCalls(tabId: string): Promise<() => Promise<number>> {
  await orbit.app.evaluate((_e, id) => {
    const contents = (globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs.contents(id)
    if (!contents) throw new Error(`no page for ${id}`)
    const g = globalThis as unknown as { __openCalls: Record<string, number> }
    g.__openCalls = { ...g.__openCalls, [id]: 0 }
    const open = contents.openDevTools.bind(contents)
    contents.openDevTools = (options?: Electron.OpenDevToolsOptions) => {
      g.__openCalls[id] = (g.__openCalls[id] ?? 0) + 1
      open(options)
    }
  }, tabId)
  return () =>
    orbit.app.evaluate(
      (_e, id) => (globalThis as unknown as { __openCalls: Record<string, number> }).__openCalls[id] ?? 0,
      tabId,
    )
}

/** Windows, Orbit windows, tabs and DevTools pages there are. */
const counts = () =>
  orbit.app.evaluate(({ BrowserWindow, webContents }) => {
    const s = (globalThis as unknown as { __orbit: { state: () => OrbitState } }).__orbit.state()
    return {
      windows: BrowserWindow.getAllWindows().length,
      orbitWindows: Object.keys(s.windows).length,
      tabs: Object.keys(s.tabs).length,
      devtools: webContents.getAllWebContents().filter((w) => w.getURL().startsWith('devtools://')).length,
    }
  })

/** From now on, native popup menus are recorded instead of shown. */
async function recordMenus(): Promise<void> {
  await orbit.app.evaluate(({ Menu }) => {
    const g = globalThis as unknown as { __shownMenu?: unknown }
    Menu.prototype.popup = function popup(this: unknown) {
      g.__shownMenu = this
    }
  })
}

type RecordedMenu = { items: { label: string; type: string; click: () => void }[] }

const shownMenu = () =>
  orbit.app.evaluate(() =>
    ((globalThis as unknown as { __shownMenu?: RecordedMenu }).__shownMenu?.items ?? [])
      .filter((i) => i.type !== 'separator')
      .map((i) => i.label),
  )

/** Clicks an item of the menu last shown; the menu is gone afterwards, as on screen. */
function clickShownMenu(label: string): Promise<void> {
  return orbit.app.evaluate((_e, name) => {
    const g = globalThis as unknown as { __shownMenu?: RecordedMenu }
    const item = g.__shownMenu?.items.find((i) => i.label === name)
    if (!item) throw new Error(`no ${name} in the menu`)
    g.__shownMenu = undefined
    item.click()
  }, label)
}

// ---- DT-01 ----

test('[DT-01][KS-13] F12 opens DevTools docked in the window; F12 again closes them', async () => {
  const tabId = await openPage('Docked')
  const before = await counts()
  await focusPage(tabId)
  await press('focused', 'F12')
  await expect.poll(() => devtoolsState(tabId)).toEqual({ open: true, dock: 'right', focused: true })
  // Docked inside the tab's view: the page is narrower than its view; no window was added.
  const view = await tabView(orbit.app, tabId)
  await expect.poll(() => inPage(tabId, 'innerWidth')).toBeLessThan(view?.bounds.width ?? 0)
  expect(await counts()).toEqual({ ...before, devtools: before.devtools + 1 })
  // DevTools have the keyboard: the same key closes them, and the page has it again.
  expect(await press('focused', 'F12')).toMatch(/^devtools:/)
  await expect.poll(() => isOpen(tabId)).toBe(false)
  await expect.poll(focusedUrl).toContain('/page/Docked')
  // The other open key, then the key again from the page: docked DevTools close.
  await press('focused', TOGGLE)
  await expect.poll(() => devtoolsState(tabId)).toMatchObject({ open: true, focused: true })
  await focusPage(tabId)
  await press('focused', 'F12')
  await expect.poll(() => isOpen(tabId)).toBe(false)
})

test('[DT-01] holding F12 opens DevTools once, and holding it again closes them for good', async () => {
  const tabId = await openPage('Held')
  const before = await counts()
  const openCalls = await countOpenCalls(tabId)
  await focusPage(tabId)
  // Held down: the first press opens DevTools; repeats reach the page while they load…
  await key('focused', 'F12', 'keyDown')
  for (let i = 0; i < 10; i++) await key({ tab: tabId }, 'F12', 'keyDown', true)
  expect(await openCalls()).toBe(1)
  await expect.poll(() => devtoolsState(tabId)).toMatchObject({ open: true, focused: true })
  // …then DevTools, which have the keyboard now.
  for (let i = 0; i < 10; i++) await key('focused', 'F12', 'keyDown', true)
  await key('focused', 'F12', 'keyUp')
  // DevTools still take their keys (and the repeats didn't close them): the console key shows the Console.
  await press('focused', isMac ? 'Mod+Alt+J' : 'Shift+Ctrl+J')
  await expect.poll(() => inDevtools(tabId, PANEL)).toBe('console')
  expect(await isOpen(tabId)).toBe(true)
  // Held down again: the first press closes them; repeats then reach the page and don't reopen them.
  await key('focused', 'F12', 'keyDown')
  await expect.poll(() => isOpen(tabId)).toBe(false)
  for (let i = 0; i < 10; i++) await key({ tab: tabId }, 'F12', 'keyDown', true)
  await key({ tab: tabId }, 'F12', 'keyUp')
  expect(await openCalls()).toBe(1)
  expect(await counts()).toEqual(before)
})

test('[DT-01] in a split, DevTools open for the focused pane', async () => {
  const left = await openPage('Left')
  const right = await openPage('Right')
  await run(orbit.app, 'split.create', { tabIds: [left, right], focus: right })
  await expect.poll(() => activeTabId(orbit.app)).toBe(right)
  await action(orbit.app, 'devtools.toggle')
  await expect.poll(() => isOpen(right)).toBe(true)
  expect(await isOpen(left)).toBe(false)
  await run(orbit.app, 'split.focusPane', { tabId: left })
  await expect.poll(() => activeTabId(orbit.app)).toBe(left)
  await action(orbit.app, 'devtools.toggle')
  await expect.poll(() => isOpen(left)).toBe(true)
  expect(await isOpen(right)).toBe(true)
})

test('[DT-01] the console key opens DevTools on the Console; copy, paste and the device toolbar work there', async () => {
  const tabId = await openPage('Console')
  await focusPage(tabId)
  await press('focused', isMac ? 'Mod+Alt+J' : 'Shift+Ctrl+J')
  await expect.poll(() => inDevtools(tabId, PANEL)).toBe('console')
  await expect.poll(() => devtoolsState(tabId)).toMatchObject({ open: true, focused: true })
  // Text typed in the Console's prompt is copied with the usual keys (on macOS, the Edit menu's).
  await orbit.app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.insertText('orbit-copy-test'))
  await expect.poll(() => inDevtools(tabId, PROMPT)).toBe('orbit-copy-test')
  const edit = async (command: 'selectAll' | 'copy' | 'paste', accel: string) => {
    if (!isMac) return void (await press('focused', accel))
    await orbit.app.evaluate(({ webContents }, c) => webContents.getFocusedWebContents()?.[c](), command)
  }
  await edit('selectAll', 'Mod+A')
  await edit('copy', 'Mod+C')
  await expect.poll(clipboardText).toBe('orbit-copy-test')
  // Pasted back, once DevTools' own "allow pasting" guard is past.
  await inDevtools(tabId, ALLOW_PASTING)
  await edit('selectAll', 'Mod+A')
  await press('focused', 'Backspace')
  await expect.poll(() => inDevtools(tabId, PROMPT)).toBe('')
  await edit('paste', 'Mod+V')
  await expect.poll(() => inDevtools(tabId, PROMPT)).toBe('orbit-copy-test')
  // The device toolbar is DevTools' own key.
  await press('focused', 'Shift+Mod+M')
  await expect.poll(() => inDevtools(tabId, DEVICE_MODE)).toBe(true)
})

test('[DT-01] a Peek and a Mini Window get DevTools of their own page', async () => {
  const tabId = await openPage('Behind')
  const peek = (await run(orbit.app, 'peek.open', { url: site.url('/page/Peeked') })) as string
  await expect.poll(() => inPage(peek, 'document.title')).toBe('Peeked')
  await press({ tab: peek }, 'F12')
  await expect.poll(() => devtoolsState(peek)).toMatchObject({ open: true, dock: 'right' })
  expect(await isOpen(tabId)).toBe(false)
  await run(orbit.app, 'peek.close', {})
  await run(orbit.app, 'mini.open', { url: site.url('/page/Mini') })
  let mini = ''
  await expect
    .poll(async () => {
      const s = await state(orbit.app)
      mini = Object.values(s.tabs).find((t) => t.url.endsWith('/page/Mini'))?.id ?? ''
      return mini ? inPage(mini, 'document.title') : null
    })
    .toBe('Mini')
  await press({ tab: mini }, 'F12')
  await expect.poll(() => devtoolsState(mini)).toMatchObject({ open: true, dock: 'right' })
  expect(await isOpen(tabId)).toBe(false)
})

test('[DT-01] a link DevTools open becomes a selected tab', async () => {
  const tabId = await openPage('Links')
  expect(await run(orbit.app, 'devtools.open', { tabId })).toBe(true)
  const url = site.url('/page/From-DevTools')
  await inDevtools(tabId, `InspectorFrontendHost.openInNewTab(${JSON.stringify(url)})`)
  await expect.poll(async () => (await state(orbit.app)).tabs[(await activeTabId(orbit.app)) ?? '']?.url).toBe(url)
})

// ---- DT-02 ----

test('[DT-02] right-click → Inspect opens DevTools on that element; with DevTools open it just selects', async () => {
  const tabId = await openPage('Inspect')
  await recordMenus()
  await clickOn(tabId, '#target', 'right')
  await expect.poll(shownMenu).toContain('Inspect')
  expect((await shownMenu()).at(-1)).toBe('Inspect')
  await clickShownMenu('Inspect')
  await expect.poll(() => inDevtools(tabId, SELECTED)).toBe('target')
  expect(await devtoolsState(tabId)).toMatchObject({ open: true, dock: 'right' })
  const devtoolsPage = () =>
    orbit.app.evaluate(
      (_e, id) => (globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs.contents(id)?.devToolsWebContents?.id,
      tabId,
    )
  const first = await devtoolsPage()
  await clickOn(tabId, '#other', 'right')
  await expect.poll(shownMenu).toContain('Inspect')
  await clickShownMenu('Inspect')
  await expect.poll(() => inDevtools(tabId, SELECTED)).toBe('other')
  expect(await devtoolsPage()).toBe(first)
})

test('[DT-02] the element picker picks what is clicked; ⇧⌘C stays Copy URL, except inside DevTools', async () => {
  const tabId = await openPage('Picker')
  // On the page, Shift+Mod+C copies its URL; DevTools stay closed.
  await focusPage(tabId)
  await press('focused', 'Shift+Mod+C')
  await expect.poll(clipboardText).toBe(site.url('/page/Picker'))
  expect(await isOpen(tabId)).toBe(false)
  // The picker: ⌥⌘C on macOS; Inspect Element in the command bar everywhere.
  if (isMac) {
    await press('focused', 'Mod+Alt+C')
  } else {
    await orbit.shell.keyboard.press(`${MOD}+T`)
    const overlay = await viewPage(orbit.app, 'overlay')
    await overlay.getByTestId('command-input').fill('Inspect Element')
    await expect(overlay.getByTestId('command-result').first()).toContainText('Inspect Element')
    await overlay.getByTestId('command-input').press('Enter')
  }
  await expect.poll(() => inDevtools(tabId, PICKING)).toBe(true)
  await clickOn(tabId, '#target')
  await expect.poll(() => inDevtools(tabId, SELECTED)).toBe('target')
  expect(await inDevtools(tabId, PICKING)).toBe(false)
  // With DevTools focused, Shift+Mod+C is DevTools' own picker, not Copy URL.
  await orbit.app.evaluate(({ clipboard }) => clipboard.clear())
  await orbit.app.evaluate((_e, id) => {
    ;(globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs.contents(id)?.devToolsWebContents?.focus()
  }, tabId)
  await expect.poll(focusedUrl).toMatch(/^devtools:/)
  await press('focused', 'Shift+Mod+C')
  await expect.poll(() => inDevtools(tabId, PICKING)).toBe(true)
  expect(await clipboardText()).toBe('')
})

// ---- DT-03 ----

test("[DT-03] DevTools dock where DevTools' dock menu last put them, also after a restart", async () => {
  const tabId = await openPage('Dock')
  expect(await run(orbit.app, 'devtools.open', { tabId })).toBe(true)
  await expect.poll(() => devtoolsState(tabId)).toMatchObject({ open: true, dock: 'right' })
  await inDevtools(tabId, setDockSide('bottom'))
  await expect.poll(async () => (await devtoolsState(tabId)).dock).toBe('bottom')
  // At the bottom of the tab's view: the page is as wide as the view and shorter.
  const view = (await tabView(orbit.app, tabId))?.bounds
  await expect.poll(() => inPage(tabId, 'innerHeight')).toBeLessThan(view?.height ?? 0)
  expect(await inPage(tabId, 'innerWidth')).toBe(view?.width)
  await run(orbit.app, 'devtools.close', { tabId })
  await expect.poll(() => isOpen(tabId)).toBe(false)
  // Another tab's DevTools open there too.
  const other = await openPage('Other')
  await run(orbit.app, 'devtools.open', { tabId: other })
  await expect.poll(() => devtoolsState(other)).toMatchObject({ open: true, dock: 'bottom' })
  // And after a restart.
  const { userData } = orbit
  await orbit.app.close()
  orbit = await launchOrbit({ userData })
  await expect.poll(() => run(orbit.app, 'devtools.open', {})).toBe(true)
  const active = (await activeTabId(orbit.app)) as string
  await expect.poll(() => devtoolsState(active)).toMatchObject({ open: true, dock: 'bottom' })
})

test('[DT-03] each tab has its own DevTools; the docked size stays the same from tab to tab', async () => {
  const a = await openPage('First')
  await run(orbit.app, 'devtools.open', { tabId: a })
  await expect.poll(() => inDevtools(a, SIZE)).toBeGreaterThan(0)
  await inDevtools(a, setSize(400))
  await expect.poll(() => inDevtools(a, SIZE)).toBe(400)
  // Another tab: its own DevTools, closed; the first tab's are hidden with its page.
  const b = await openPage('Second')
  expect(await isOpen(b)).toBe(false)
  expect(await isOpen(a)).toBe(true)
  await expect.poll(async () => (await tabView(orbit.app, a))?.visible).toBe(false)
  // Opened, they take the size last chosen; resized, the first tab's take it when shown again.
  await run(orbit.app, 'devtools.open', { tabId: b })
  await expect.poll(() => inDevtools(b, SIZE)).toBe(400)
  await inDevtools(b, setSize(300))
  await expect.poll(() => inDevtools(b, SIZE)).toBe(300)
  await run(orbit.app, 'tabs.activate', { tabId: a })
  await expect.poll(() => inDevtools(a, SIZE)).toBe(300)
  expect(await isOpen(b)).toBe(true)
})

test('[DT-03] undocked DevTools come to the front with the open key; DevTools for many tabs add no windows', async () => {
  const tabId = await openPage('Undocked')
  const before = await counts()
  await run(orbit.app, 'devtools.open', { tabId })
  await expect.poll(() => isOpen(tabId)).toBe(true)
  await inDevtools(tabId, setDockSide('undocked'))
  await expect.poll(async () => (await devtoolsState(tabId)).dock).toBe('undocked')
  // Undocked, the page has its whole view.
  const view = (await tabView(orbit.app, tabId))?.bounds
  await expect.poll(() => inPage(tabId, 'innerWidth')).toBe(view?.width)
  // Behind the window (the page has the keyboard): the open key brings them forward…
  await focusPage(tabId)
  expect(await devtoolsState(tabId)).toMatchObject({ open: true, focused: false })
  await press('focused', 'F12')
  await expect.poll(() => devtoolsState(tabId)).toEqual({ open: true, dock: 'undocked', focused: true })
  // …and, in front with the keyboard, closes them.
  await press('focused', 'F12')
  await expect.poll(() => isOpen(tabId)).toBe(false)
  await run(orbit.app, 'devtools.open', { tabId })
  await inDevtools(tabId, setDockSide('right'))
  // DevTools for three tabs: three DevTools pages, no window or tab more.
  const others = [await openPage('Two'), await openPage('Three')]
  for (const id of others) await run(orbit.app, 'devtools.open', { tabId: id })
  for (const id of [tabId, ...others]) await expect.poll(() => isOpen(id)).toBe(true)
  expect(await counts()).toEqual({ ...before, tabs: before.tabs + 2, devtools: before.devtools + 3 })
})

// ---- DT-14 ----

test('[DT-14] ⇧⌘R reloads bypassing the cache, and brings back a crashed tab', async () => {
  const tabId = (await run(orbit.app, 'tabs.create', { url: site.url('/cached/page') })) as string
  await expect.poll(() => inPage(tabId, 'window.assetRuns')).toBe(1)
  const docs = () => site.requests('/cached/page')
  const assets = () => site.requests('/cached/asset.js')
  expect(assets()).toHaveLength(1)
  // ⌘R: the page is checked with the server; the script, fresh in the cache, isn't fetched again.
  await focusPage(tabId).catch(() => {})
  await press({ tab: tabId }, 'Mod+R')
  await expect.poll(() => docs().length).toBe(2)
  expect(docs()[1]?.cacheControl).toBe('max-age=0')
  await expect.poll(() => inPage(tabId, 'window.assetRuns')).toBe(1)
  expect(assets()).toHaveLength(1)
  // ⇧⌘R: the page and its script come from the server again.
  await press({ tab: tabId }, 'Shift+Mod+R')
  await expect.poll(() => assets().length).toBe(2)
  expect(docs()[2]).toMatchObject({ cacheControl: 'no-cache', pragma: 'no-cache' })
  expect(assets()[1]).toMatchObject({ cacheControl: 'no-cache', pragma: 'no-cache' })
  // A crashed tab: the window keeps the keyboard, and ⇧⌘R brings the page back.
  await orbit.app.evaluate((_e, id) => {
    ;(globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs.contents(id)?.forcefullyCrashRenderer()
  }, tabId)
  await expect.poll(async () => (await state(orbit.app)).tabs[tabId]?.error?.code).toBe(-1000)
  await expect.poll(focusedUrl).toContain('view=shell')
  await press('focused', 'Shift+Mod+R')
  await expect.poll(() => inPage(tabId, 'document.title')).toBe('Cached')
  expect(docs()[3]).toMatchObject({ cacheControl: 'no-cache' })
  await expect.poll(async () => (await state(orbit.app)).tabs[tabId]?.error).toBeUndefined()
})

// ---- DT-13 ----

/** A tab's address, as the engine has it. */
const tabUrl = (tabId: string) =>
  orbit.app.evaluate(
    (_e, id) => (globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs.contents(id)?.getURL() ?? '',
    tabId,
  )

const openTabs = async () => Object.values((await state(orbit.app)).tabs)

test('[DT-13] typing orbit://pages opens the internal pages in a tab; its links open them; they follow the app', async () => {
  await openViaCommandBar(orbit, 'orbit://pages')
  const page = await tabPage(orbit.app, 'orbit://pages/')
  const root = page.getByTestId('internal-page')
  await expect(root).toHaveAttribute('data-page', 'pages')
  const tabId = (await activeTabId(orbit.app)) as string
  await expect.poll(async () => (await state(orbit.app)).tabs[tabId]?.title).toBe('Internal pages')
  expect((await state(orbit.app)).tabs[tabId]).toMatchObject({ url: 'orbit://pages/' })
  // It has Orbit's bridge, for its window.
  const windowId = Object.keys((await state(orbit.app)).windows)[0]
  expect(await page.evaluate(() => (window as unknown as { orbit: { windowId: string } }).orbit.windowId)).toBe(
    windowId,
  )
  // From the one preload pages get, the web page one (D40, D53).
  const preloads = await orbit.app.evaluate(
    (_e, id) =>
      (globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs
        .contents(id)
        ?.session.getPreloadScripts()
        .filter((s) => s.type === 'frame')
        .map((s) => s.filePath.split(/[\\/]/).pop()),
    tabId,
  )
  expect(preloads).toEqual(['page.cjs'])
  // A link opens a page in the same tab.
  await page.getByTestId('internal-page-link').filter({ hasText: 'orbit://version/' }).click()
  await expect(root).toHaveAttribute('data-page', 'version')
  // The build info About shows, and copies.
  const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }
  const engine = await orbit.app.evaluate(() => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  }))
  await expect(page.getByTestId('version-version')).toHaveText(version)
  await expect(page.getByTestId('version-electron')).toHaveText(engine.electron)
  await expect(page.getByTestId('version-chrome')).toHaveText(engine.chrome)
  await page.getByTestId('version-copy').click()
  await expect.poll(() => orbit.app.evaluate(({ clipboard }) => clipboard.readText())).toContain(`Orbit ${version}`)
  await expect.poll(async () => (await state(orbit.app)).tabs[tabId]?.title).toBe('Version')
  expect((await state(orbit.app)).tabs[tabId]).toMatchObject({ url: 'orbit://version/' })
  // It follows the app's state: dark when Orbit is.
  await run(orbit.app, 'spaces.setAppearance', { appearance: 'dark' })
  await expect(root).toHaveAttribute('data-dark', 'true')
  await run(orbit.app, 'spaces.setAppearance', { appearance: 'light' })
  await expect(root).toHaveAttribute('data-dark', 'false')
  // An address with no page says so.
  await run(orbit.app, 'tabs.navigate', { tabId, url: 'orbit://nope/' })
  await expect.poll(() => page.title()).toBe('No such page')
  await expect(root).toHaveAttribute('data-page', '')
  // A web page in the same tab has no bridge.
  await run(orbit.app, 'tabs.navigate', { tabId, url: site.url('/page/After') })
  await expect.poll(() => inPage(tabId, 'document.title')).toBe('After')
  expect(await inPage(tabId, 'typeof window.orbit')).toBe('undefined')
})

test('[DT-13] a web page reaches no internal page: no link, frame, new tab, redirect, fetch or bridge', async () => {
  // A pinned tab, where Peek also acts on links (PK-01).
  const win = Object.values((await state(orbit.app)).windows)[0]
  const container = { kind: 'pinned', spaceId: win?.spaceId }
  const tabId = (await run(orbit.app, 'tabs.create', { url: site.url('/links'), container })) as string
  await expect.poll(() => inPage(tabId, 'document.title')).toBe('Links')
  // What becomes of navigations to internal pages in the tab (after Orbit's own handling), and
  // where its frames went.
  await orbit.app.evaluate((_e, id) => {
    const g = globalThis as unknown as OrbitGlobal & { __navigations: string[] }
    g.__navigations = []
    const contents = g.__orbit.ctx.tabs.contents(id)
    contents?.on('will-frame-navigate', (e) => {
      if (e.url.startsWith('orbit:'))
        g.__navigations.push(`${e.isMainFrame ? 'page' : 'frame'} ${e.defaultPrevented ? 'stopped' : 'went'} ${e.url}`)
    })
    contents?.on('did-frame-navigate', (_e, url) => g.__navigations.push(`showed ${url}`))
  }, tabId)
  const navigations = () =>
    orbit.app.evaluate(() => (globalThis as unknown as { __navigations: string[] }).__navigations)

  expect(await inPage(tabId, 'typeof window.orbit')).toBe('undefined')
  expect(await inPage(tabId, "fetch('orbit://pages/').then(() => 'read', () => 'refused')")).toBe('refused')
  // Nor can it load one, or the scripts internal pages run, as if they weren't there.
  const script = (url: string, type = '') =>
    inPage(
      tabId,
      `new Promise((done) => {
        const s = Object.assign(document.createElement('script'), { src: ${JSON.stringify(url)}, type: '${type}' })
        s.onload = () => done('loaded')
        s.onerror = () => done('failed')
        document.head.append(s)
      })`,
    )
  const html = readFileSync(resolve('out/renderer/index.html'), 'utf8')
  const bundle = /src="\.\/(assets\/[^"]+\.js)"/.exec(html)?.[1]
  expect(bundle).toBeTruthy()
  expect(await script(site.url('/cached/asset.js'))).toBe('loaded')
  expect(await script(`orbit://pages/${bundle}`)).toBe('failed')
  expect(await script(`orbit://pages/${bundle}`, 'module')).toBe('failed')
  expect(await script('orbit://pages/')).toBe('failed')
  // A frame.
  await inPage(
    tabId,
    "document.body.append(Object.assign(document.createElement('iframe'), { src: 'orbit://pages/' })), 1",
  )
  await expect.poll(navigations).toContain('frame stopped orbit://pages/')
  // A link.
  await clickInTab(orbit.app, tabId, LINK_AT.internal)
  await expect.poll(navigations).toContain('page stopped orbit://pages/')
  // A link to a new tab: the page's window-open handler says no (D53), before any feature's hook
  // (Peek's, the tabs') hears of it.
  await orbit.app.evaluate((_e, id) => {
    type Handler = (details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse
    const g = globalThis as unknown as OrbitGlobal & { __opens: string[] }
    g.__opens = []
    const hooks = g.__orbit.ctx.hooks.windowOpen
    for (const [i, hook] of hooks.entries()) {
      hooks[i] = (openerTabId, details) => {
        g.__opens.push(`hook ${details.url}`)
        return hook(openerTabId, details)
      }
    }
    // Where Electron keeps the handler a page's opens go to.
    const contents = g.__orbit.ctx.tabs.contents(id) as unknown as { _windowOpenHandler: Handler }
    const handler = contents._windowOpenHandler
    contents._windowOpenHandler = (details) => {
      const response = handler(details)
      g.__opens.push(`${response.action} ${details.url}`)
      return response
    }
  }, tabId)
  await clickInTab(orbit.app, tabId, LINK_AT.internalBlank)
  await expect
    .poll(() => orbit.app.evaluate(() => (globalThis as unknown as { __opens: string[] }).__opens))
    .toEqual(['deny orbit://version/'])
  expect((await openTabs()).filter((t) => t.url.startsWith('orbit:'))).toEqual([])
  expect(await inPage(tabId, 'location.pathname')).toBe('/links')
  expect((await navigations()).filter((n) => n.startsWith('showed orbit:') || n.includes(' went '))).toEqual([])
  // Nor do frames in the page show one.
  const frames = await orbit.app.evaluate(
    (_e, id) =>
      (globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs
        .contents(id)
        ?.mainFrame.framesInSubtree.map((f) => f.url) ?? [],
    tabId,
  )
  expect(frames.filter((url) => url.startsWith('orbit:'))).toEqual([])
  // A redirect.
  const other = (await run(orbit.app, 'tabs.create', { url: site.url('/to-internal') })) as string
  await expect.poll(() => site.requests('/to-internal').length).toBe(1)
  await expect
    .poll(() =>
      orbit.app.evaluate(
        (_e, id) => (globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs.contents(id)?.isLoading(),
        other,
      ),
    )
    .toBe(false)
  expect(await tabUrl(other)).not.toContain('orbit:')
  expect((await openTabs()).filter((t) => t.url.startsWith('orbit:'))).toEqual([])
})

test('[DT-13] an internal page runs only its own commands, sends no events, and runs no script but its own (D53)', async () => {
  await openViaCommandBar(orbit, 'orbit://version/')
  const page = await tabPage(orbit.app, 'orbit://version/')
  await expect(page.getByTestId('version-facts')).toHaveAttribute('data-answered', 'true')
  // What a script that got into the page could ask: its own commands run, any other is refused.
  type Bridge = {
    invoke: (name: string, args: unknown) => Promise<unknown>
    send: (name: string, payload: unknown) => void
  }
  const ask = (name: string, args: unknown) =>
    page.evaluate(
      ([n, a]) =>
        (window as unknown as { orbit: Bridge }).orbit.invoke(n as string, a).then(
          () => 'ran',
          (e: Error) => (e.message.includes('Forbidden') ? 'refused' : e.message),
        ),
      [name, args] as const,
    )
  const tabs = (await openTabs()).length
  expect(await ask('settings.buildInfo', {})).toBe('ran')
  expect(await ask('settings.copyBuildInfo', {})).toBe('ran')
  expect(await ask('tabs.create', { url: site.url('/page/Sneaky') })).toBe('refused')
  expect(await ask('spaces.setAppearance', { appearance: 'dark' })).toBe('refused')
  expect(await ask('downloads.list', {})).toBe('refused')
  expect((await openTabs()).length).toBe(tabs)
  expect((await state(orbit.app)).settings.appearance).not.toBe('dark')
  // Events are for Orbit's own UI: one from the page never reaches main (a command after it has).
  await orbit.app.evaluate(() => {
    const g = globalThis as unknown as OrbitGlobal & { __events: string[] }
    g.__events = []
    g.__orbit.ctx.events.on('perf.mark', (p) => g.__events.push(p.name))
  })
  await page.evaluate(() =>
    (window as unknown as { orbit: Bridge }).orbit.send('perf.mark', { name: 'internal', t: 1 }),
  )
  expect(await ask('settings.buildInfo', {})).toBe('ran')
  expect(await orbit.app.evaluate(() => (globalThis as unknown as { __events: string[] }).__events)).toEqual([])
  // A script put into the page never runs: the policy Orbit serves the page with stops it.
  await page.evaluate(() => {
    const w = window as unknown as { __policies: string[] }
    w.__policies = []
    document.addEventListener('securitypolicyviolation', (e) => w.__policies.push(e.originalPolicy))
    document.body.append(Object.assign(document.createElement('script'), { textContent: 'window.__ran = true' }))
  })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __policies: string[] }).__policies))
    .toContain(INTERNAL_DOCUMENT_CSP)
  expect(await page.evaluate(() => (window as unknown as { __ran?: boolean }).__ran)).toBeUndefined()
  // The list page runs none.
  await run(orbit.app, 'tabs.navigate', { tabId: (await activeTabId(orbit.app)) as string, url: 'orbit://pages/' })
  await expect(page.getByTestId('internal-page')).toHaveAttribute('data-page', 'pages')
  expect(await ask('settings.buildInfo', {})).toBe('refused')
})
