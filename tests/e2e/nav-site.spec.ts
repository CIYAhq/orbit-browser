import { type ElectronApplication, expect, type Frame, type Page, test } from '@playwright/test'
import { action, launchOrbit, type Orbit, state, tabPage } from './helpers'
import {
  closeWindow,
  cmd,
  cmdIn,
  type NavFixtures,
  openTab,
  shellRoundTrip,
  startNavFixtures,
  uiPageOf,
  visit,
  waitLoaded,
  windowList,
  windowState,
} from './nav-support'

/** Permission prompts (NV-15) and the site controls panel (NV-16). */

let fx: NavFixtures
let orbit: Orbit

// A fake camera and microphone, so getUserMedia has devices once it is allowed.
const MEDIA_ARGS = ['--use-fake-device-for-media-stream']

test.beforeAll(async () => {
  fx = await startNavFixtures()
})
test.afterAll(async () => {
  await fx.close()
})
test.beforeEach(async () => {
  orbit = await launchOrbit({ args: MEDIA_ARGS })
})
test.afterEach(async () => {
  await orbit.app.close()
})

const page = (title: string) => fx.url(`/page/${title}`)
/** Another site (another origin) on the same server. */
const elsewhere = (title: string) => fx.urlOn('127.0.0.1', `/page/${title}`)
const host = () => `localhost:${fx.port}`

type Ask = 'location' | 'notifications' | 'camera' | 'microphone' | 'camera+microphone'
type Answers = { __answers?: Record<string, string> }

/**
 * Starts a permission request in a page without waiting for it: its outcome lands in
 * `window.__answers[what]` ('granted', 'denied', 'default' or 'error:<code or name>').
 */
async function ask(p: Page | Frame, what: Ask): Promise<void> {
  await p.evaluate((w) => {
    const win = window as unknown as Answers
    win.__answers ??= {}
    const answers = win.__answers
    delete answers[w]
    const done = (value: string) => {
      answers[w] = value
    }
    if (w === 'location') {
      navigator.geolocation.getCurrentPosition(
        () => done('granted'),
        (e) => done(`error:${e.code}`),
      )
    } else if (w === 'notifications') {
      void Notification.requestPermission().then(done)
    } else {
      navigator.mediaDevices.getUserMedia({ video: w.includes('camera'), audio: w.includes('microphone') }).then(
        (stream) => {
          for (const track of stream.getTracks()) track.stop()
          done('granted')
        },
        (e: Error) => done(`error:${e.name}`),
      )
    }
  }, what)
}

const answerOf = (p: Page | Frame, what: Ask) =>
  p.evaluate((w) => (window as unknown as Answers).__answers?.[w] ?? null, what)

/** What the page sees for a permission without asking (the permission check). */
const permissionState = (p: Page | Frame, name: 'geolocation' | 'notifications' | 'camera') =>
  p.evaluate(async (n) => (await navigator.permissions.query({ name: n as PermissionName })).state, name)

/** The shown page of a tab: the view's bounds in the window. */
const pageBounds = (app: ElectronApplication, tabId: string) =>
  app.evaluate((_e, id) => {
    const g = globalThis as unknown as {
      __orbit: { ctx: { windows: { tabViewBounds: (t: string) => Electron.Rectangle | undefined } } }
    }
    return g.__orbit.ctx.windows.tabViewBounds(id) ?? null
  }, tabId)

/** A tab's page bounds once the layout has stopped moving (the sidebar slides in 260 ms). */
async function settledPage(app: ElectronApplication, tabId: string): Promise<Electron.Rectangle> {
  let last = ''
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await pageBounds(app, tabId))
        const same = now === last
        last = now
        return same
      },
      { intervals: [100] },
    )
    .toBe(true)
  const bounds = await pageBounds(app, tabId)
  if (!bounds) throw new Error('no page')
  return bounds
}

/** The first window's permission prompt view (shown while the sidebar is hidden). */
const promptView = (app: ElectronApplication) =>
  app.evaluate(() => {
    const g = globalThis as unknown as {
      __orbitNav: { prompt: () => { placed: boolean; bounds?: Electron.Rectangle } }
    }
    return g.__orbitNav.prompt()
  })

/** The prompt view's own page (view=prompt), once it has started. */
async function promptPage(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const found = app.windows().find((p) => p.url().includes('view=prompt'))
    if (found) return found
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('No prompt view page')
}

/** Opens a page in a new selected tab and returns it with its Playwright page. */
async function open(app: ElectronApplication, url: string): Promise<{ id: string; p: Page }> {
  const id = await openTab(app, url)
  return { id, p: await tabPage(app, url) }
}

test('[NV-15] the camera prompt hangs under the address; Allow this time lasts while the site stays; Never allow sticks', async () => {
  const { app, shell } = orbit
  const { id, p } = await open(app, page('Camera'))
  await ask(p, 'camera')
  const prompt = shell.getByTestId('permission-prompt')
  await expect(prompt).toBeVisible()
  await expect(prompt.getByTestId('permission-site')).toHaveText(host())
  await expect(prompt).toHaveAttribute('data-kinds', 'camera')
  await expect(prompt).toContainText('Use your camera')
  await expect(prompt.getByTestId('permission-allow')).toHaveText('Allow while visiting the site')
  await expect(prompt.getByTestId('permission-once')).toHaveText('Allow this time')
  await expect(prompt.getByTestId('permission-block')).toHaveText('Never allow')
  // Under the address display, as wide as it.
  const address = await shell.getByTestId('address').boundingBox()
  const card = await prompt.boundingBox()
  if (!address || !card) throw new Error('no boxes')
  expect(card.y).toBeGreaterThanOrEqual(address.y + address.height - 4)
  expect(Math.abs(card.x - address.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(card.width - address.width)).toBeLessThanOrEqual(1)

  await prompt.getByTestId('permission-once').click()
  await expect.poll(() => answerOf(p, 'camera')).toBe('granted')
  await expect(prompt).toBeHidden()
  // Asked again on the site: no prompt. Another page of the same site keeps it too.
  await ask(p, 'camera')
  await expect.poll(() => answerOf(p, 'camera')).toBe('granted')
  await visit(app, id, page('Camera-2'))
  await ask(p, 'camera')
  await expect.poll(() => answerOf(p, 'camera')).toBe('granted')
  await expect(prompt).toBeHidden()

  // Once the tab has left the site, it asks again; Never allow is remembered.
  await visit(app, id, elsewhere('Away'))
  await visit(app, id, page('Camera'))
  const back = await tabPage(app, page('Camera'))
  expect(await permissionState(back, 'camera')).toBe('prompt')
  await ask(back, 'camera')
  await expect(prompt).toBeVisible()
  await prompt.getByTestId('permission-block').click()
  await expect.poll(() => answerOf(back, 'camera')).toBe('error:NotAllowedError')
  await ask(back, 'camera')
  await expect.poll(() => answerOf(back, 'camera')).toBe('error:NotAllowedError')
  await expect(prompt).toBeHidden()
  expect(await permissionState(back, 'camera')).toBe('denied')
})

test('[NV-15] camera and microphone ask once together; a blocked location fails with code 1', async () => {
  const { app, shell } = orbit
  const { p } = await open(app, page('Call'))
  const prompt = shell.getByTestId('permission-prompt')
  await ask(p, 'camera+microphone')
  await expect(prompt).toHaveAttribute('data-kinds', 'camera microphone')
  await expect(prompt.locator('li')).toHaveText(['Use your camera', 'Use your microphone'])
  await prompt.getByTestId('permission-allow').click()
  await expect.poll(() => answerOf(p, 'camera+microphone')).toBe('granted')
  // Remembered for each: asking for one of them doesn't ask again.
  await ask(p, 'microphone')
  await expect.poll(() => answerOf(p, 'microphone')).toBe('granted')

  await ask(p, 'location')
  await expect(prompt).toHaveAttribute('data-kinds', 'location')
  await prompt.getByTestId('permission-block').click()
  await expect.poll(() => answerOf(p, 'location')).toBe('error:1')
  expect(await permissionState(p, 'geolocation')).toBe('denied')
  expect(await permissionState(p, 'camera')).toBe('granted')
})

test('[NV-15] notifications ask with Block and Allow; Esc dismisses and the site may ask again', async () => {
  const { app, shell } = orbit
  const { p } = await open(app, page('News'))
  const prompt = shell.getByTestId('permission-prompt')
  await ask(p, 'notifications')
  await expect(prompt).toContainText('Show notifications')
  await expect(prompt.getByTestId('permission-once')).toHaveCount(0)
  await expect(prompt.getByTestId('permission-block')).toHaveText('Block')
  // Keyboard: the buttons take the arrows, Esc dismisses.
  await prompt.getByTestId('permission-block').focus()
  await shell.keyboard.press('ArrowRight')
  await expect(prompt.getByTestId('permission-allow')).toBeFocused()
  await shell.keyboard.press('Escape')
  await expect(prompt).toBeHidden()
  await expect.poll(() => answerOf(p, 'notifications')).toBe('default')
  expect(await p.evaluate(() => Notification.permission)).toBe('default')
  // Dismissed is not decided: asked again, it prompts again.
  await ask(p, 'notifications')
  await expect(prompt).toBeVisible()
  await prompt.getByTestId('permission-allow').click()
  await expect.poll(() => answerOf(p, 'notifications')).toBe('granted')
  expect(await p.evaluate(() => Notification.permission)).toBe('granted')
})

type DialogInfo = { message: string; detail: string; buttons: string[]; parent: number | null; requests: number }
type DialogHooks = {
  __orbitNav: { permissionDialogs: () => DialogInfo[]; answerPermissionDialog: (button: string) => boolean }
}
/** The plain permission dialogs open for pages without a sidebar (Peek, Mini Window, pop-up), oldest first. */
const permissionDialogs = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as DialogHooks).__orbitNav.permissionDialogs())
/** Answers the oldest permission dialog with a button, or `cancel` (Esc, or closing it). */
const answerDialog = (app: ElectronApplication, button: string) =>
  app.evaluate((_e, b) => (globalThis as unknown as DialogHooks).__orbitNav.answerPermissionDialog(b), button)
/** The id of the first window whose own page's address contains `part`. */
const browserWindowId = (app: ElectronApplication, part: string) =>
  app.evaluate(
    ({ BrowserWindow }, p) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(p))?.id ?? null,
    part,
  )
/** The id of the window that shows the web page at `url`. */
const windowWithPage = (app: ElectronApplication, url: string) =>
  app.evaluate(
    ({ BrowserWindow }, u) =>
      BrowserWindow.getAllWindows().find((w) =>
        w.contentView.children.some((v) => (v as Electron.WebContentsView).webContents?.getURL() === u),
      )?.id ?? null,
    url,
  )
const focusedWindowId = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? null)

test('[NV-15][MW-03] a Mini Window’s page asks in a dialog over its own window; the same request twice asks once; Esc keeps nothing (review B-F2)', async () => {
  const { app } = orbit
  const url = page('MiniAsks')
  await cmd<string>(app, 'mini.open', { url })
  const p = await tabPage(app, url)
  const mini = await windowWithPage(app, url)
  const main = await browserWindowId(app, 'view=shell')
  expect(mini).not.toBeNull()
  // The Mini Window has come forward (it takes the focus as it shows); then the main window has the focus.
  await expect.poll(() => focusedWindowId(app)).toBe(mini)
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id ?? -1)?.focus(), main)
  await expect.poll(() => focusedWindowId(app)).toBe(main)
  const both = () => p.evaluate(() => (window as unknown as { __both?: string[] | null }).__both ?? null)
  const askTwice = () =>
    p.evaluate(() => {
      const w = window as unknown as { __both?: string[] | null }
      w.__both = null
      void Promise.all([Notification.requestPermission(), Notification.requestPermission()]).then((r) => {
        w.__both = r
      })
    })
  await askTwice()
  await expect
    .poll(() => permissionDialogs(app))
    .toEqual([
      {
        message: `${host()} wants to:`,
        detail: 'Show notifications',
        buttons: ['Allow', 'Block', 'Not Now'],
        parent: mini,
        requests: 2,
      },
    ])
  // Over the page's window, not the one that had the focus.
  expect(await focusedWindowId(app)).toBe(main)
  // Esc (or closing it) is this time no, and keeps nothing: the site may ask again.
  expect(await answerDialog(app, 'cancel')).toBe(true)
  await expect.poll(both).toEqual(['default', 'default'])
  expect(await p.evaluate(() => Notification.permission)).toBe('default')
  await askTwice()
  await expect.poll(async () => (await permissionDialogs(app)).length).toBe(1)
  expect(await answerDialog(app, 'Allow')).toBe(true)
  await expect.poll(both).toEqual(['granted', 'granted'])
  expect(await p.evaluate(() => Notification.permission)).toBe('granted')
  expect(await permissionDialogs(app)).toEqual([])
})

test('[NV-15] a frame from another site can’t ask for notifications in the page’s name, nor use the page’s', async () => {
  const { app, shell } = orbit
  const { p } = await open(app, page('Host'))
  const widget = elsewhere('Widget')
  await p.evaluate(
    (src) =>
      new Promise<void>((resolve) => {
        const frame = document.createElement('iframe')
        frame.src = src
        frame.addEventListener('load', () => resolve())
        document.body.prepend(frame)
      }),
    widget,
  )
  const frame = p.frames().find((f) => f.url() === widget)
  if (!frame) throw new Error('no frame')
  const prompt = shell.getByTestId('permission-prompt')
  // Chromium refuses a cross-origin frame's request, and doesn't hand it the page's grant.
  await ask(frame, 'notifications')
  await expect.poll(() => answerOf(frame, 'notifications')).toBe('denied')
  await expect(prompt).toBeHidden()
  expect(await p.evaluate(() => Notification.permission)).toBe('default')
  // The page itself asks, in its own name, and is allowed.
  await ask(p, 'notifications')
  await expect(prompt.getByTestId('permission-site')).toHaveText(host())
  await prompt.getByTestId('permission-allow').click()
  await expect.poll(() => answerOf(p, 'notifications')).toBe('granted')
  expect(await frame.evaluate(() => Notification.permission)).toBe('denied')
  expect(await permissionState(frame, 'notifications')).toBe('denied')
})

test('[NV-15] a prompt belongs to its tab: hidden on another tab, back with it, gone when the page is left', async () => {
  const { app, shell } = orbit
  const { id, p } = await open(app, page('Asker'))
  const prompt = shell.getByTestId('permission-prompt')
  await ask(p, 'notifications')
  await expect(prompt).toBeVisible()
  await openTab(app, page('Other'))
  await expect(prompt).toBeHidden()
  await cmd(app, 'tabs.activate', { tabId: id })
  await expect(prompt).toBeVisible()
  // Leaving the page answers for it: the request ends undecided.
  await visit(app, id, elsewhere('Left'))
  await expect(prompt).toBeHidden()
  expect((await state(app)).tabs[id]?.permissionPrompt).toBeUndefined()
})

test('[NV-15] pages read an undecided permission as not decided yet, as in Chromium', async () => {
  const { app, shell } = orbit
  const { id, p } = await open(app, page('Reader'))
  // Electron's check can only say yes or no: the page preload keeps "default" and "prompt".
  expect(await p.evaluate(() => Notification.permission)).toBe('default')
  expect(await permissionState(p, 'notifications')).toBe('prompt')
  expect(await permissionState(p, 'geolocation')).toBe('prompt')
  expect(await permissionState(p, 'camera')).toBe('prompt')
  // The page's Notification is still the one it knows, down to what it declares (review B-F11).
  expect(
    await p.evaluate(() => ({
      name: Notification.name,
      request: typeof Notification.requestPermission,
      requestName: Notification.requestPermission.name,
      requestLength: Notification.requestPermission.length,
      constructor: Notification.prototype.constructor === Notification,
      maxActions: typeof (Notification as unknown as { maxActions: number }).maxActions,
      own: Object.keys(window).filter((k) => /orbit/i.test(k)),
    })),
  ).toEqual({
    name: 'Notification',
    request: 'function',
    requestName: 'requestPermission',
    requestLength: 0,
    constructor: true,
    maxActions: 'number',
    own: [],
  })

  const prompt = shell.getByTestId('permission-prompt')
  await ask(p, 'notifications')
  await prompt.getByTestId('permission-block').click()
  await expect.poll(() => answerOf(p, 'notifications')).toBe('denied')
  expect(await p.evaluate(() => Notification.permission)).toBe('denied')
  expect(await permissionState(p, 'notifications')).toBe('denied')
  // Reset in the site controls: undecided again.
  await cmd(app, 'site.resetPermissions', { tabId: id })
  expect(await p.evaluate(() => Notification.permission)).toBe('default')
  await ask(p, 'notifications')
  await prompt.getByTestId('permission-allow').click()
  await expect.poll(() => answerOf(p, 'notifications')).toBe('granted')
  expect(await permissionState(p, 'notifications')).toBe('granted')
  expect(
    await p.evaluate(() => {
      const made = new Notification('Hello')
      made.close()
      return { instance: made instanceof Notification, constructor: made.constructor === Notification }
    }),
  ).toEqual({ instance: true, constructor: true })
  // The old callback form answers too.
  expect(await p.evaluate(() => new Promise<string>((resolve) => void Notification.requestPermission(resolve)))).toBe(
    'granted',
  )
})

/**
 * The message a page's preload sends main when the user clicks one of its notifications, as main
 * receives it from that page's main frame.
 */
const notificationClick = (app: ElectronApplication, url: string) =>
  app.evaluate(({ ipcMain, webContents }, u) => {
    const sender = webContents.getAllWebContents().find((c) => c.getURL() === u)
    if (!sender) throw new Error(`no page at ${u}`)
    ipcMain.emit('orbit-page:notification-click', { sender, senderFrame: sender.mainFrame })
  }, url)

test('[NV-15] clicking a notification brings its tab forward, on its Space; a click the page makes up does nothing', async () => {
  const { app, shell } = orbit
  const { id, p } = await open(app, page('Sender'))
  await ask(p, 'notifications')
  await shell.getByTestId('permission-prompt').getByTestId('permission-allow').click()
  await expect.poll(() => answerOf(p, 'notifications')).toBe('granted')
  await p.evaluate(() => {
    ;(window as unknown as { __note: Notification }).__note = new Notification('Ping', { body: 'From the sender' })
  })
  // A site that never asked for notifications, in a background tab.
  const quiet = elsewhere('Quiet')
  const quietId = await openTab(app, quiet)
  // The user moves on: another tab, then another Space.
  const other = await openTab(app, page('Elsewhere'))
  const work = await cmd<string>(app, 'spaces.create', { name: 'Work' })
  await expect.poll(async () => (await windowState(app)).spaceId).toBe(work)

  // A click event the page dispatches itself isn't the user's.
  await p.evaluate(() => (window as unknown as { __note: Notification }).__note.dispatchEvent(new Event('click')))
  await shellRoundTrip(shell)
  expect((await windowState(app)).spaceId).toBe(work)

  // Nor is a "trusted" click the page fakes with the listener Orbit adds to its notifications: the
  // built-ins a page replaces (here while it makes one) never see that listener.
  const leaked = await p.evaluate(() => {
    type Fn = (...args: unknown[]) => unknown
    const seen: Fn[] = []
    const keep = (args: ArrayLike<unknown> | undefined) => {
      for (const arg of Array.from(args ?? [])) if (typeof arg === 'function') seen.push(arg as Fn)
    }
    const fn = Function.prototype as unknown as Record<'call' | 'apply', unknown>
    const reflect = Reflect as unknown as Record<'apply', unknown>
    const { call, apply } = fn
    const reflectApply = Reflect.apply
    fn.call = function (this: Fn, ...args: unknown[]) {
      keep(args)
      return reflectApply(this, args[0], args.slice(1))
    }
    fn.apply = function (this: Fn, self: unknown, args?: ArrayLike<unknown>) {
      keep(args)
      return reflectApply(this, self, Array.from(args ?? []))
    }
    reflect.apply = (target: Fn, self: unknown, args: ArrayLike<unknown>) => {
      keep(args)
      return reflectApply(target, self, args)
    }
    try {
      new Notification('Fake')
    } finally {
      fn.call = call
      fn.apply = apply
      reflect.apply = reflectApply
    }
    for (const listener of seen) listener({ isTrusted: true, type: 'click' })
    return seen.length
  })
  // The page's next permission read reaches main after anything that call sent.
  expect(await permissionState(p, 'geolocation')).toBe('prompt')
  expect((await windowState(app)).spaceId).toBe(work)
  expect(leaked).toBe(0)

  // A click from a site without the notification permission (no real notification of its own).
  await notificationClick(app, quiet)
  expect((await windowState(app)).spaceId).toBe(work)

  // The user's click (the engine's trusted event reaches main as this message).
  await notificationClick(app, page('Sender'))
  await expect
    .poll(async () => {
      const win = await windowState(app)
      return { space: win.spaceId === work ? 'work' : 'first', tab: win.activeTab[win.spaceId] }
    })
    .toEqual({ space: 'first', tab: id })
  expect(other).not.toBe(id)
  expect(quietId).not.toBe(id)
})

test('[NV-15][SV-01] in split view the pane without the focus shows its prompt too; with the sidebar hidden, at its own corner (review B-F3)', async () => {
  const { app, shell } = orbit
  const { id: left, p } = await open(app, page('LeftAsks'))
  const right = await openTab(app, elsewhere('Right'))
  await cmd(app, 'split.create', { tabIds: [left, right], focus: right })
  await expect(shell.getByTestId('address-pill')).toHaveText(`127.0.0.1:${fx.port}`)
  const prompt = shell.getByTestId('permission-prompt')
  await ask(p, 'notifications')
  await expect(prompt).toContainText('Show notifications')
  await expect(prompt.getByTestId('permission-site')).toHaveText(host())
  // In the sidebar, not a dialog: the pane is a tab in the Space.
  expect(await permissionDialogs(app)).toEqual([])
  // The focus stays where it was.
  const win = await windowState(app)
  expect(win.activeTab[win.spaceId]).toBe(right)
  // With the sidebar hidden it waits over the corner of the pane that asks.
  await action(app, 'sidebar.toggle')
  await expect.poll(async () => (await windowState(app)).sidebar.visible).toBe(false)
  const shown = await settledPage(app, left)
  await expect.poll(async () => (await promptView(app)).placed).toBe(true)
  const bounds = (await promptView(app)).bounds
  expect(bounds && { x: bounds.x, y: bounds.y }).toEqual({ x: shown.x - 2, y: shown.y - 2 })
  const card = (await promptPage(app)).getByTestId('permission-prompt')
  await card.getByTestId('permission-allow').click()
  await expect.poll(() => answerOf(p, 'notifications')).toBe('granted')
  await expect.poll(async () => (await promptView(app)).placed).toBe(false)
})

test('[NV-15] with the sidebar hidden the prompt shows over the page’s top-left corner', async () => {
  const { app } = orbit
  const { id, p } = await open(app, page('Corner'))
  await action(app, 'sidebar.toggle')
  await expect.poll(async () => (await windowState(app)).sidebar.visible).toBe(false)
  const shown = await settledPage(app, id)
  await ask(p, 'notifications')
  await expect.poll(async () => (await promptView(app)).placed).toBe(true)
  const bounds = (await promptView(app)).bounds
  if (!bounds) throw new Error('no bounds')
  // The card sits 10 px in from the page's corner (its view has a 12 px margin for the shadow).
  expect(bounds.x).toBe(shown.x - 2)
  expect(bounds.y).toBe(shown.y - 2)
  const view = await promptPage(app)
  const card = view.getByTestId('permission-prompt')
  await expect(card).toBeVisible()
  await expect(card.getByTestId('permission-site')).toHaveText(host())
  // The view fits the card: its height follows what the card reports.
  await expect
    .poll(async () => {
      const box = await card.boundingBox()
      const placed = (await promptView(app)).bounds
      return !!box && !!placed && Math.abs(placed.height - (box.height + 24)) <= 2
    })
    .toBe(true)
  await card.getByTestId('permission-allow').click()
  await expect.poll(() => answerOf(p, 'notifications')).toBe('granted')
  await expect.poll(async () => (await promptView(app)).placed).toBe(false)
  // Showing the sidebar moves a waiting prompt back under the address.
  await ask(p, 'location')
  await expect.poll(async () => (await promptView(app)).placed).toBe(true)
  await action(app, 'sidebar.toggle')
  await expect.poll(async () => (await promptView(app)).placed).toBe(false)
  await expect(orbit.shell.getByTestId('permission-prompt')).toBeVisible()
})

/**
 * Real clicks (input events, not script) on the prompt view's first "Allow" button, every `every`
 * ms from the moment it shows, `count` times. Returns how long after the view was placed and after
 * the button showed the first click came.
 */
const clickAllowAsItShows = (app: ElectronApplication, count: number, every: number) =>
  app.evaluate(
    async ({ webContents }, [n, gap]) => {
      const g = globalThis as unknown as { __orbitNav: { prompt: () => { placed: boolean } } }
      const view = webContents.getAllWebContents().find((c) => c.getURL().includes('view=prompt'))
      if (!view) throw new Error('no prompt view')
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
      const find = `(() => {
        const button = document.querySelector('[data-testid="permission-allow"]')
        if (!button) return null
        const r = button.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })()`
      const deadline = Date.now() + 15_000
      let placedAt = 0
      let at: { x: number; y: number } | null = null
      while (!at && Date.now() < deadline) {
        if (!placedAt && g.__orbitNav.prompt().placed) placedAt = Date.now()
        at = placedAt ? await view.executeJavaScript(find) : null
        if (!at) await wait(5)
      }
      if (!at) throw new Error('no Allow button in the prompt view')
      const shownAt = Date.now()
      for (let i = 0; i < n; i++) {
        if (i > 0) await wait(gap)
        view.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 })
        view.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 })
      }
      return { afterPlaced: shownAt - placedAt, at }
    },
    [count, every] as const,
  )

test('[NV-15] a prompt takes no clicks as it shows, nor while they keep coming; a click after a pause answers', async () => {
  const { app } = orbit
  const { id, p } = await open(app, page('Quick'))
  await action(app, 'sidebar.toggle')
  await expect.poll(async () => (await windowState(app)).sidebar.visible).toBe(false)
  await settledPage(app, id)
  // A first prompt, dismissed: the prompt view's page is up, as after any prompt.
  await ask(p, 'notifications')
  await expect.poll(async () => (await promptView(app)).placed).toBe(true)
  const view = await promptPage(app)
  await view.getByTestId('permission-dismiss').click()
  await expect.poll(() => answerOf(p, 'notifications')).toBe('default')
  await expect.poll(async () => (await promptView(app)).placed).toBe(false)

  // The page asks for the camera while the user clicks quickly (every 150 ms, for over a second)
  // where "Allow while visiting the site" shows up.
  await ask(p, 'camera')
  const { afterPlaced, at } = await clickAllowAsItShows(app, 8, 150)
  expect(afterPlaced).toBeLessThan(1000)
  // Each click came too soon: the request still waits.
  await shellRoundTrip(orbit.shell)
  expect(await answerOf(p, 'camera')).toBeNull()
  expect((await state(app)).tabs[id]?.permissionPrompt?.type).toBe('permission')
  expect((await promptView(app)).placed).toBe(true)

  // After a pause, the user's click answers.
  await expect(view.getByTestId('permission-allow')).toBeEnabled()
  await app.evaluate(({ webContents }, point) => {
    const prompt = webContents.getAllWebContents().find((c) => c.getURL().includes('view=prompt'))
    prompt?.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    prompt?.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  }, at)
  await expect.poll(() => answerOf(p, 'camera')).toBe('granted')
})

test('[NV-15] a site asking for a serial port gets a device chooser; Connect waits for a pick, Cancel refuses', async () => {
  const { app, shell } = orbit
  const { p } = await open(app, page('Ports'))
  // requestPort() needs a click: a button in the page, clicked as a person would.
  await p.evaluate(() => {
    const button = document.createElement('button')
    button.id = 'connect'
    button.textContent = 'Connect'
    button.addEventListener('click', () => {
      const win = window as unknown as Answers
      win.__answers ??= {}
      const answers = win.__answers
      ;(navigator as unknown as { serial: { requestPort: () => Promise<unknown> } }).serial.requestPort().then(
        () => {
          answers.serial = 'granted'
        },
        (e: Error) => {
          answers.serial = `error:${e.name}`
        },
      )
    })
    document.body.prepend(button)
  })
  await p.click('#connect')
  const prompt = shell.getByTestId('permission-prompt')
  await expect(prompt).toHaveAttribute('data-type', 'device')
  await expect(prompt).toContainText('wants to connect to a serial port')
  // The machine's own ports, or a note that there are none: nothing is picked for the user.
  await expect(
    prompt.getByTestId('permission-devices-empty').or(prompt.getByTestId('permission-devices')),
  ).toBeVisible()
  await expect(prompt.getByTestId('permission-allow')).toHaveText('Connect')
  await expect(prompt.getByTestId('permission-allow')).toBeDisabled()
  await prompt.getByTestId('permission-block').click()
  await expect
    .poll(() => p.evaluate(() => (window as unknown as Answers).__answers?.serial ?? null))
    .toBe('error:NotFoundError')
  await expect(prompt).toBeHidden()
})

test('[NV-15][NV-11] choices last across launches, per profile; private windows forget theirs', async () => {
  const { app, userData } = orbit
  const { p } = await open(app, page('Kept'))
  await ask(p, 'notifications')
  await orbit.shell.getByTestId('permission-prompt').getByTestId('permission-allow').click()
  await expect.poll(() => answerOf(p, 'notifications')).toBe('granted')

  // In a private window the same site starts undecided, and its answer stays there.
  const before = new Set((await windowList(app)).map((w) => w.id))
  await action(app, 'window.newPrivate')
  await expect.poll(async () => (await windowList(app)).filter((w) => !before.has(w.id)).length).toBe(1)
  const priv = (await windowList(app)).find((w) => !before.has(w.id))
  if (!priv) throw new Error('no private window')
  const privUrl = page('Kept?private')
  const privTab = await cmdIn<string>(app, priv.id, 'tabs.create', { url: privUrl })
  await waitLoaded(app, privTab, privUrl)
  const pp = await tabPage(app, privUrl)
  expect(await pp.evaluate(() => Notification.permission)).toBe('default')
  await ask(pp, 'notifications')
  const privShell = await uiPageOf(app, 'shell', priv.id)
  await privShell.getByTestId('permission-prompt').getByTestId('permission-block').click()
  await expect.poll(() => answerOf(pp, 'notifications')).toBe('denied')
  // The normal window's choice is untouched.
  expect(await p.evaluate(() => Notification.permission)).toBe('granted')
  await closeWindow(app, priv.id)
  await expect.poll(async () => (await windowList(app)).length).toBe(1)

  // After a relaunch the choice is still there, without asking.
  await app.close()
  orbit = await launchOrbit({ userData, args: MEDIA_ARGS })
  const again = await open(orbit.app, page('Kept-again'))
  expect(await again.p.evaluate(() => Notification.permission)).toBe('granted')
  await ask(again.p, 'notifications')
  await expect.poll(() => answerOf(again.p, 'notifications')).toBe('granted')
  await expect(orbit.shell.getByTestId('permission-prompt')).toBeHidden()
})

test('[NV-16] the site controls panel shows the site, its permissions and zoom; switches apply at once', async () => {
  const { app, shell } = orbit
  const win = await windowState(app)
  const { p } = await open(app, page('Controls'))
  // Something to show: location refused.
  await ask(p, 'location')
  await shell.getByTestId('permission-prompt').getByTestId('permission-block').click()
  await expect.poll(() => answerOf(p, 'location')).toBe('error:1')

  const button = shell.getByTestId('site-controls-button')
  await button.click()
  const overlay = await uiPageOf(app, 'overlay', win.id)
  const panel = overlay.getByTestId('site-controls')
  await expect(panel).toBeVisible()
  await expect(button).toHaveAttribute('aria-expanded', 'true')
  await expect(panel.getByTestId('site-controls-host')).toHaveText(host())
  await expect(panel.getByTestId('site-controls-connection')).toHaveAttribute('data-connection', 'local')
  // Under the address display's field.
  const field = await shell.getByTestId('address').boundingBox()
  const box = await panel.boundingBox()
  if (!field || !box) throw new Error('no boxes')
  expect(box.y).toBeGreaterThanOrEqual(field.y + field.height)
  expect(box.y).toBeLessThan(field.y + field.height + 20)
  const location = panel.locator('[data-testid="site-controls-permission"][data-kind="location"]')
  await expect(location).toHaveAttribute('data-state', 'block')
  // Turning it on applies at once; the page sees it after a reload.
  await panel.getByTestId('site-switch-location').click()
  await expect(location).toHaveAttribute('data-state', 'allow')
  await expect(panel.getByTestId('site-controls-reload')).toBeVisible()
  expect(await permissionState(p, 'geolocation')).toBe('granted')
  // Zoom, with a reset once it isn't 100%.
  await expect(panel.getByTestId('site-controls-zoom')).toHaveText('100%')
  await expect(panel.getByTestId('site-controls-zoom-reset')).toHaveCount(0)
  await panel.getByRole('button', { name: 'Zoom in' }).click()
  await expect(panel.getByTestId('site-controls-zoom')).toHaveText('110%')
  await panel.getByTestId('site-controls-zoom-reset').click()
  await expect(panel.getByTestId('site-controls-zoom')).toHaveText('100%')
  // Reset permissions: the site asks again.
  await panel.getByTestId('site-controls-reset').click()
  await expect(location).toHaveAttribute('data-state', 'ask')
  expect(await permissionState(p, 'geolocation')).toBe('prompt')
  // Esc closes it; the button opens it again and closes it.
  await overlay.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await expect.poll(async () => (await windowState(app)).overlay.kind).toBe('none')
  await button.click()
  await expect(panel).toBeVisible()
  await button.click()
  await expect.poll(async () => (await windowState(app)).overlay.kind).toBe('none')
})

test('[NV-16] clearing cookies and site data asks first; a click outside closes the panel', async () => {
  const { app, shell } = orbit
  const win = await windowState(app)
  const { p } = await open(app, page('Jar'))
  await p.evaluate(async () => {
    const jar = (window as unknown as { cookieStore: { set: (name: string, value: string) => Promise<void> } })
      .cookieStore
    await jar.set('kept', '1')
    localStorage.setItem('kept', '1')
  })
  expect(await p.evaluate(() => document.cookie)).toBe('kept=1')
  await shell.getByTestId('site-controls-button').click()
  const overlay = await uiPageOf(app, 'overlay', win.id)
  const panel = overlay.getByTestId('site-controls')
  await expect(panel).toBeVisible()
  await panel.getByTestId('site-controls-clear').click()
  await expect(panel.getByTestId('site-controls-clear-confirm')).toContainText(
    `Clear cookies and site data for ${host()}`,
  )
  await panel.getByTestId('site-controls-clear-ok').click()
  await expect.poll(() => p.evaluate(() => document.cookie)).toBe('')
  await visit(app, (await windowState(app)).activeTab[win.spaceId] as string, page('Jar-2'))
  expect(await p.evaluate(() => localStorage.getItem('kept'))).toBeNull()
  // The panel stays open while the tab moves on; a click outside it closes it.
  await expect(panel).toBeVisible()
  await expect(panel.getByTestId('site-controls-clear')).toBeVisible()
  const box = await panel.boundingBox()
  if (!box) throw new Error('no panel')
  await overlay.mouse.click(box.x + box.width + 120, box.y + box.height + 120)
  await expect.poll(async () => (await windowState(app)).overlay.kind).toBe('none')
})

test('[NV-16] with the sidebar hidden, Site Controls opens at the page’s corner and the sidebar stays hidden', async () => {
  const { app } = orbit
  const win = await windowState(app)
  const { id } = await open(app, page('Hidden'))
  await action(app, 'sidebar.toggle')
  await expect.poll(async () => (await windowState(app)).sidebar.visible).toBe(false)
  const shown = await settledPage(app, id)
  await action(app, 'site.controls')
  const overlay = await uiPageOf(app, 'overlay', win.id)
  const panel = overlay.getByTestId('site-controls')
  await expect(panel).toBeVisible()
  // 8 px in from the page's corner, once its opening animation is over.
  await expect
    .poll(async () => {
      const box = await panel.boundingBox()
      return !!box && Math.abs(box.x - (shown.x + 8)) <= 1 && Math.abs(box.y - (shown.y + 8)) <= 1
    })
    .toBe(true)
  const s = await windowState(app)
  expect(s.sidebar.visible).toBe(false)
  expect(s.sidebar.peeking).toBe(false)
  // The action again closes it.
  await action(app, 'site.controls')
  await expect.poll(async () => (await windowState(app)).overlay.kind).toBe('none')
})
