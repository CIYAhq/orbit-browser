import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import type { MainContext } from '../../src/main/context'
import type { SpaceTheme } from '../../src/shared/state'
import { paletteFor } from '../../src/shared/theme'
import {
  action,
  type Fixtures,
  launchOrbit,
  listenInRange,
  MOD,
  type Orbit,
  openViaCommandBar,
  run,
  startFixtures,
  state,
  tabPage,
  viewPage,
} from './helpers'

/**
 * Core main-process behaviour (store, sessions, windows, persistence). Titles carry
 * the review item they guard (PR-1 review: M*, F*) after any spec feature IDs.
 */

let fx: Fixtures
let orbit: Orbit

test.beforeAll(async () => {
  fx = await startFixtures()
})
test.afterAll(async () => {
  await fx.close()
})
let mainLog: string[] = []
test.beforeEach(async () => {
  orbit = await launchOrbit()
  mainLog = []
  orbit.app.process().stderr?.on('data', (d) => mainLog.push(String(d)))
})
test.afterEach(async () => {
  // The main process's own errors explain most failures here: keep them with the report.
  const info = test.info()
  if (info.status !== info.expectedStatus) await info.attach('main-process.log', { body: mainLog.join('') })
  await orbit.app.close().catch(() => {})
})

/** The main process's test handle (src/main/test-hooks.ts), for app.evaluate() bodies. */
type OrbitGlobal = { __orbit: { ctx: MainContext } }

test('[NV-15] permission checks report only what the user allowed, per profile (review M5)', async () => {
  const url = fx.url('/page/Perm')
  const tabId = (await run(orbit.app, 'tabs.create', { url })) as string
  const page = await tabPage(orbit.app, '/page/Perm')
  await expect(page.locator('#title')).toHaveText('Perm')
  const probe = () =>
    page.evaluate(async () => ({
      notification: Notification.permission,
      notifications: (await navigator.permissions.query({ name: 'notifications' })).state,
      geolocation: (await navigator.permissions.query({ name: 'geolocation' })).state,
    }))
  // Electron's check handler is boolean, so "not decided" reads as 'denied' rather than Chromium's
  // 'default'. What matters: nothing is reported granted before the user allows it.
  const fresh = await probe()
  expect(fresh.notification).not.toBe('granted')
  expect(fresh.notifications).not.toBe('granted')
  expect(fresh.geolocation).not.toBe('granted')

  // Allowing notifications for this origin in this profile grants exactly that.
  const s = await state(orbit.app)
  const partition = s.profiles[s.tabs[tabId]?.profileId as string]?.partition as string
  await orbit.app.evaluate(
    (_e, [p, o]) => (globalThis as unknown as OrbitGlobal).__orbit.ctx.sessions.decide(p, o, 'notifications', true),
    [partition, new URL(url).origin] as const,
  )
  const allowed = await probe()
  expect(allowed.notification).toBe('granted')
  expect(allowed.geolocation).not.toBe('granted')

  // Another profile does not inherit the decision.
  const profileId = (await run(orbit.app, 'profiles.create', { name: 'Work' })) as string
  const spaceId = (await run(orbit.app, 'spaces.create', { name: 'Work', profileId })) as string
  await run(orbit.app, 'tabs.create', { url: `${url}?bg=%23eeeeee`, spaceId })
  const other = await tabPage(orbit.app, '/page/Perm?bg')
  await expect(other.locator('#title')).toHaveText('Perm')
  expect(await other.evaluate(() => Notification.permission)).not.toBe('granted')
})

/** Where a tab's current view sits: ids of windows whose content view holds it, and its visibility. */
async function viewPlacement(app: Orbit['app'], tabId: string) {
  return app.evaluate((_e, id) => {
    const ctx = (globalThis as unknown as OrbitGlobal).__orbit.ctx
    const view = ctx.tabs.get(id)
    if (!view?.webContents || view.webContents.isDestroyed()) return null
    const hosts = ctx.windows.ids().filter((w) => ctx.windows.get(w)?.contentView.children.includes(view))
    return { hosts, visible: view.getVisible(), managedBy: ctx.windows.windowOfTab(id) ?? null }
  }, tabId)
}

/** URLs of the tab views placed in a window, bottom to top (the overlay excluded). */
async function placedUrls(app: Orbit['app'], windowId: string) {
  return app.evaluate((_e, w) => {
    const ctx = (globalThis as unknown as OrbitGlobal).__orbit.ctx
    const live = new Set(ctx.tabs.liveTabIds().map((id) => ctx.tabs.get(id)))
    return (ctx.windows.get(w)?.contentView.children ?? [])
      .filter((v) => 'webContents' in v)
      .map((v) => {
        const wc = (v as Electron.WebContentsView).webContents
        return {
          url: !wc || wc.isDestroyed() ? 'destroyed' : wc.getURL(),
          current: live.has(v as Electron.WebContentsView),
        }
      })
      .filter((v) => !v.url.includes('view=overlay'))
  }, windowId)
}

test('[TB-19] a target=_blank link shows its tab in exactly one attached, top-most view (review M1)', async () => {
  const opener = (await run(orbit.app, 'tabs.create', { url: fx.url('/page/Opener') })) as string
  const page = await tabPage(orbit.app, '/page/Opener')
  await page.locator('#external').click()
  await expect.poll(async () => Object.keys((await state(orbit.app)).tabs).length).toBe(2)
  const s = await state(orbit.app)
  const windowId = Object.keys(s.windows)[0] as string
  const opened = Object.keys(s.tabs).find((id) => id !== opener) as string
  await expect.poll(async () => (await viewPlacement(orbit.app, opened))?.hosts).toEqual([windowId])
  // Only the tab's current view is placed for that page, and it is above the opener.
  await expect
    .poll(async () => (await placedUrls(orbit.app, windowId)).filter((v) => v.url.includes('/page/External')))
    .toEqual([{ url: expect.stringContaining('/page/External'), current: true }])
  // Above every other view but the overlay, once the loading indicator (SB-28) has gone with the load.
  await expect.poll(async () => (await placedUrls(orbit.app, windowId)).at(-1)?.url).toContain('/page/External')
})

test('[TB-06] a page that closes itself leaves no dead view; the tab shows again (review M3)', async () => {
  // A pinned tab: its page closing itself unloads it (like closing it) and it shows again when
  // selected. A Today tab is closed into the Archive instead (tabs-review.spec.ts covers that).
  const spaceId = (await state(orbit.app)).spaceOrder[0] as string
  const a = (await run(orbit.app, 'tabs.create', {
    url: fx.url('/page/Closer'),
    container: { kind: 'pinned', spaceId },
  })) as string
  const page = await tabPage(orbit.app, '/page/Closer')
  await expect(page.locator('#title')).toHaveText('Closer')
  const b = (await run(orbit.app, 'tabs.create', { url: fx.url('/page/Other') })) as string
  await run(orbit.app, 'tabs.activate', { tabId: a })
  await expect.poll(async () => (await viewPlacement(orbit.app, a))?.visible).toBe(true)
  const live = () =>
    orbit.app.evaluate((_e, id) => {
      const contents = (globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs.get(id)?.webContents
      return !!contents && !contents.isDestroyed()
    }, a)
  await page.evaluate(() => window.close())
  await expect.poll(live).toBe(false)
  // The page asked to close: Orbit must not quietly load it again behind the user's back.
  await new Promise((r) => setTimeout(r, 300))
  expect(await live()).toBe(false)
  expect((await state(orbit.app)).tabs[a]?.asleep).toBe(true)
  const windowId = Object.keys((await state(orbit.app)).windows)[0] as string
  await expect
    .poll(async () => (await placedUrls(orbit.app, windowId)).filter((v) => v.url.includes('Closer')))
    .toEqual([])
  await run(orbit.app, 'tabs.activate', { tabId: b })
  await run(orbit.app, 'tabs.activate', { tabId: a })
  await expect
    .poll(async () => viewPlacement(orbit.app, a))
    .toEqual({ hosts: [windowId], visible: true, managedBy: windowId })
})

test('[TB-17] showing a tab in a second window moves its view and relays out the first (review M4)', async () => {
  const tabId = (await run(orbit.app, 'tabs.create', { url: fx.url('/page/Shared') })) as string
  await tabPage(orbit.app, '/page/Shared')
  const [w1] = await orbit.app.evaluate(() => (globalThis as unknown as OrbitGlobal).__orbit.ctx.windows.ids())
  await expect.poll(async () => (await viewPlacement(orbit.app, tabId))?.hosts).toEqual([w1])
  const w2 = await orbit.app.evaluate(() => (globalThis as unknown as OrbitGlobal).__orbit.ctx.windows.open())
  await expect
    .poll(() =>
      orbit.app.evaluate((_e, w) => {
        const win = (globalThis as unknown as OrbitGlobal).__orbit.ctx.windows.get(w)
        return !!win && win.isVisible() && win.contentView.children.length > 0
      }, w2),
    )
    .toBe(true)
  // The second window's shell reports its frame, then the tab is activated there.
  await orbit.app.evaluate(
    (_e, [w, t]) =>
      (globalThis as unknown as OrbitGlobal).__orbit.ctx.commands.run('tabs.activate', { tabId: t }, { windowId: w }),
    [w2, tabId] as const,
  )
  await expect.poll(async () => viewPlacement(orbit.app, tabId)).toEqual({ hosts: [w2], visible: true, managedBy: w2 })
})

test('[SP-11] a visible tab moved to another profile gets a new view instead of a blank frame (review F7)', async () => {
  const tabId = (await run(orbit.app, 'tabs.create', { url: fx.url('/page/Profiled') })) as string
  await tabPage(orbit.app, '/page/Profiled')
  await expect.poll(async () => (await viewPlacement(orbit.app, tabId))?.visible).toBe(true)
  const before = await orbit.app.evaluate(
    (_e, id) => (globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs.contents(id)?.id,
    tabId,
  )
  const s = await state(orbit.app)
  const spaceId = s.tabs[tabId]?.spaceId as string
  const profileId = (await run(orbit.app, 'profiles.create', { name: 'Work' })) as string
  await run(orbit.app, 'spaces.update', { spaceId, profileId })
  const windowId = Object.keys(s.windows)[0] as string
  await expect
    .poll(async () => viewPlacement(orbit.app, tabId))
    .toEqual({ hosts: [windowId], visible: true, managedBy: windowId })
  const after = await orbit.app.evaluate((_e, id) => {
    const ctx = (globalThis as unknown as OrbitGlobal).__orbit.ctx
    const contents = ctx.tabs.contents(id)
    return {
      id: contents?.id,
      partition: ctx.store.state.profiles[ctx.store.state.tabs[id]?.profileId ?? '']?.partition,
    }
  }, tabId)
  expect(after.id).not.toBe(before)
  expect(after.partition).toContain(profileId)
})

test('[KS-01] menu actions skip windows that are not Orbit windows (review M6)', async () => {
  // Focus is stubbed: parallel test apps share one X display and would steal it from each other.
  const result = await orbit.app.evaluate(async ({ BrowserWindow, webContents, WebContentsView }) => {
    const ctx = (globalThis as unknown as OrbitGlobal).__orbit.ctx
    const mainId = ctx.windows.ids()[0] as string
    const main = ctx.windows.get(mainId) ?? null
    const popup = new BrowserWindow({ width: 300, height: 200, show: false })
    const devtools = new WebContentsView()
    const focusedWindow = BrowserWindow.getFocusedWindow
    const focusedContents = webContents.getFocusedWebContents
    const focus = (win: Electron.BrowserWindow | null, contents: Electron.WebContents | null) => {
      BrowserWindow.getFocusedWindow = () => win
      webContents.getFocusedWebContents = () => contents
    }
    try {
      focus(main, main?.webContents ?? null)
      const withMain = ctx.windows.focusedWindowId()
      const closedWithMain = ctx.windows.closeFocusedForeign()
      focus(popup, popup.webContents)
      const withPopup = ctx.windows.focusedWindowId()
      focus(null, devtools.webContents)
      const withDevTools = ctx.windows.focusedWindowId()
      focus(null, null)
      const inBackground = ctx.windows.focusedWindowId()
      focus(popup, popup.webContents)
      const closedPopup = ctx.windows.closeFocusedForeign()
      await new Promise((r) => setTimeout(r, 200))
      return {
        mainId,
        withMain,
        closedWithMain,
        withPopup: withPopup ?? null,
        withDevTools: withDevTools ?? null,
        inBackground,
        closedPopup,
        popupGone: popup.isDestroyed(),
      }
    } finally {
      BrowserWindow.getFocusedWindow = focusedWindow
      webContents.getFocusedWebContents = focusedContents
      devtools.webContents.close()
      if (!popup.isDestroyed()) popup.destroy()
    }
  })
  expect(result).toEqual({
    mainId: result.mainId,
    withMain: result.mainId,
    closedWithMain: false,
    withPopup: null,
    withDevTools: null,
    inBackground: result.mainId,
    closedPopup: true,
    popupGone: true,
  })
})

test('[TB-22] closing the last window keeps it for the next launch (review F1)', async () => {
  const userData = orbit.userData
  const tabId = (await run(orbit.app, 'tabs.create', { url: fx.url('/page/Kept') })) as string
  await tabPage(orbit.app, '/page/Kept')
  const windowId = await orbit.app.evaluate(async () => {
    const ctx = (globalThis as unknown as OrbitGlobal).__orbit.ctx
    const id = ctx.windows.ids()[0] as string
    ctx.windows.get(id)?.setBounds({ x: 40, y: 30, width: 900, height: 640 })
    return id
  })
  const closed = orbit.app.waitForEvent('close')
  // Linux and Windows quit when the last window closes; macOS keeps running.
  await orbit.app.evaluate((_e, id) => (globalThis as unknown as OrbitGlobal).__orbit.ctx.windows.close(id), windowId)
  if (process.platform === 'darwin') {
    const kept = await state(orbit.app)
    expect(kept.windows[windowId]?.activeTab[kept.windows[windowId]?.spaceId ?? '']).toBe(tabId)
    await orbit.app.evaluate(({ app }) => app.quit())
  }
  await closed
  orbit = await launchOrbit({ userData })
  const s = await state(orbit.app)
  const win = s.windows[windowId]
  expect(Object.keys(s.windows)).toEqual([windowId])
  expect(win?.activeTab[win.spaceId]).toBe(tabId)
  expect(win?.bounds).toMatchObject({ width: 900, height: 640 })
})

test('[TB-22] an exception nothing caught in the main process is logged; Orbit still quits and restores (D28)', async () => {
  const userData = orbit.userData
  const tabId = (await run(orbit.app, 'tabs.create', { url: fx.url('/page/Kept') })) as string
  // Electron's default shows the exception in a modal box that holds the main thread, so Orbit
  // couldn't quit: app.close() waited until the harness killed it.
  await orbit.app.evaluate(() => {
    setTimeout(() => {
      throw new Error('a bug nothing caught')
    }, 0)
  })
  await expect.poll(() => orbit.takeUncaught()).toContain('a bug nothing caught')
  await orbit.app.close()
  orbit = await launchOrbit({ userData })
  expect((await state(orbit.app)).tabs[tabId]).toBeDefined()
})

test('[TB-22] the quit check also catches an exception whose log is long (D28, PR #11 review M1)', async () => {
  // Logged in one write of over 5,000 characters. The check used to keep only the last 4,000
  // characters before looking for the marker, which cut the marker off.
  await orbit.app.evaluate(() => {
    setTimeout(() => {
      throw new Error(`long ${'z'.repeat(5000)}`)
    }, 0)
  })
  await expect.poll(() => orbit.takeUncaught()).toContain('long zzz')
})

test('[TB-22] the quit check also catches a promise rejection nothing handled (D28, PR #11 review F3)', async () => {
  // Electron only prints a warning for these, so the check used to miss them.
  await orbit.app.evaluate(() => {
    void Promise.reject(new Error('a rejection nothing handled'))
  })
  await expect.poll(() => orbit.takeUncaught()).toContain('a rejection nothing handled')
})

test('[TB-22] a tab closed while its history is restoring leaves no rejection behind (D28, archive review F8)', async () => {
  const { app } = orbit
  // A page that stops answering once `hang` is set, so restoring a history that ends on it never finishes.
  let hang = false
  const slow = createServer((_req, res) => {
    if (!hang) res.end('<title>Slow</title>')
  })
  const port = await listenInRange(slow)
  try {
    const tabId = (await run(app, 'tabs.create', { url: fx.url('/page/One') })) as string
    await tabPage(app, '/page/One')
    await run(app, 'tabs.navigate', { tabId, url: `http://127.0.0.1:${port}/slow` })
    await tabPage(app, '/slow')
    await run(app, 'tabs.create', { url: fx.url('/page/Other') })
    await tabPage(app, '/page/Other')
    // Asleep, the tab keeps its history; waking it restores that history, ending on the slow page.
    await app.evaluate((_e, id) => (globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs.sleep(id), tabId)
    hang = true
    await run(app, 'tabs.activate', { tabId })
    await expect.poll(async () => (await state(app)).tabs[tabId]?.loading).toBe(true)
    // Closing it mid-restore made restore's catch load the page into contents already destroyed.
    await run(app, 'tabs.close', { tabId })
    await new Promise((r) => setTimeout(r, 1500))
    expect(orbit.takeUncaught()).toBe('')
  } finally {
    slow.closeAllConnections()
    slow.close()
  }
})

test('[TB-22] app.close() asks Orbit to quit between tasks, never part-way through a timer (D28)', async () => {
  // Main is busy in one timer for 1.5 s as the test closes it, so an ask through the inspector lands
  // inside it. A quit handler run there that clears the timer Node is about to call makes Node throw
  // (helpers.ts, askQuit).
  await orbit.app.evaluate(({ app }) => {
    const g = globalThis as unknown as { inTimer?: boolean }
    app.on('before-quit', () => console.error(`[test] quit handler inside a timer: ${g.inTimer === true}`))
    setTimeout(() => {
      g.inTimer = true
      const end = Date.now() + 1500
      while (Date.now() < end) {
        // busy
      }
      g.inTimer = false
    }, 0)
  })
  await orbit.app.close()
  const log = mainLog.join('')
  expect(log).toContain('[test] quit handler inside a timer: false')
  expect(log).not.toContain('[test] quit handler inside a timer: true')
})

test("[TB-22] a quit Orbit cancels fails the test: Playwright's own quit doesn't finish it (D28, PR #16 review M1)", async () => {
  // Orbit cancels the first quit, as a "quit anyway?" question or a swallowed quit would. app.close()
  // must find it still running, kill it and fail the test.
  test.fail()
  await orbit.app.evaluate(({ app }) => {
    let cancelled = false
    app.on('before-quit', (event) => {
      if (cancelled) return
      cancelled = true
      event.preventDefault()
    })
  })
  await orbit.app.close()
})

test('[TB-22] main-process evaluates and handles run between tasks, method shorthands too (PR #10 review F4)', async () => {
  // Main stays busy in timers, so an evaluate through the inspector lands inside one unless it
  // waits for a task of its own (helpers.ts, evaluateBetweenTasks).
  await orbit.app.evaluate(() => {
    const g = globalThis as unknown as { inTimer?: boolean }
    for (let i = 0; i < 10; i++) {
      setInterval(() => {
        g.inTimer = true
        const end = Date.now() + 10
        while (Date.now() < end) {
          // busy
        }
        g.inTimer = false
      }, 0)
    }
  })
  const inTimer = () => (globalThis as unknown as { inTimer?: boolean }).inTimer === true
  for (let i = 0; i < 5; i++) {
    expect(await orbit.app.evaluate(inTimer)).toBe(false)
    expect(await (await orbit.app.evaluateHandle(inTimer)).jsonValue()).toBe(false)
  }
  // A method shorthand is a function too, as in Playwright's own evaluate.
  const calc = {
    add(_electron: unknown, n: number) {
      return n + 1
    },
  }
  expect(await orbit.app.evaluate(calc.add, 1)).toBe(2)
})

test('[TB-02] opening tabs keeps every UI mirror in step without resyncs (review M2, F4)', async () => {
  const errors: string[] = []
  orbit.shell.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await openViaCommandBar(orbit, fx.url('/page/One'))
  const overlay = await viewPage(orbit.app, 'overlay')
  overlay.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await expect(orbit.shell.getByTestId('tab-row')).toHaveCount(1)
  await openViaCommandBar(orbit, fx.url('/page/Two'))
  await expect(orbit.shell.getByTestId('tab-row')).toHaveCount(2)
  await expect(orbit.shell.getByTestId('tab-row').first()).toContainText('Two')
  type Mirror = { __orbitMirror: { resyncs: () => number; seq: () => number } }
  for (const page of [orbit.shell, overlay]) {
    // Pages keep loading (titles, favicons), so compare against main's seq at the same moment.
    await expect
      .poll(async () => {
        const mirror = await page.evaluate(() => (globalThis as unknown as Mirror).__orbitMirror.seq())
        const main = await orbit.app.evaluate(() => (globalThis as unknown as OrbitGlobal).__orbit.ctx.store.seq)
        return mirror === main
      })
      .toBe(true)
    // Only the first load: no batch failed to apply and no gap forced a snapshot.
    expect(await page.evaluate(() => (globalThis as unknown as Mirror).__orbitMirror.resyncs())).toBe(1)
  }
  expect(errors.filter((e) => e.includes('[store]') || e.includes('Immer'))).toEqual([])
})

test('[CB-22] Enter right after typing opens what was typed, not a row left from an earlier query', async () => {
  const one = (await run(orbit.app, 'tabs.create', { url: fx.url('/page/One') })) as string
  // The empty bar lists recent tabs other than the active one, so "One" must not be active.
  await run(orbit.app, 'tabs.create', { url: fx.url('/page/Extra') })
  await expect(orbit.shell.getByTestId('tab-row').filter({ hasText: 'Extra' })).toHaveCount(1)
  // Answers for typed text come late (as on a slow machine); the empty query's "recent tabs" don't.
  await orbit.app.evaluate(() => {
    type Handler = (args: { query: string }, c: unknown) => unknown
    const commands = (globalThis as unknown as OrbitGlobal).__orbit.ctx.commands as unknown as {
      handlers: Map<string, Handler>
    }
    const original = commands.handlers.get('search.query') as Handler
    commands.handlers.set('search.query', async (args, c) => {
      if (args.query) await new Promise((r) => setTimeout(r, 500))
      return original(args, c)
    })
  })
  await orbit.shell.keyboard.press(`${MOD}+T`)
  const overlay = await viewPage(orbit.app, 'overlay')
  const input = overlay.getByTestId('command-input')
  await expect(input).toBeFocused()
  await expect(overlay.getByTestId('command-result').filter({ hasText: 'One' }).first()).toBeVisible()
  const two = fx.url('/page/Two')
  await input.fill(two)
  await input.press('Enter')
  await expect.poll(async () => Object.keys((await state(orbit.app)).tabs).length).toBe(3)
  const s = await state(orbit.app)
  const win = Object.values(s.windows)[0]
  const active = win?.activeTab[win.spaceId]
  expect(active).not.toBe(one)
  expect(s.tabs[active ?? '']?.url).toBe(two)
})

test('[NV-18][MW-11] links and files from other apps open as tabs in the current Space (review F10)', async () => {
  // Mini Windows off (MW-11): links from other apps open as tabs. mini-window.spec.ts covers the default.
  await orbit.app.evaluate(() => {
    ;(globalThis as unknown as OrbitGlobal).__orbit.ctx.store.update((d) => {
      d.settings.miniWindowForExternalLinks = false
    })
  })
  const s0 = await state(orbit.app)
  const windowId = Object.keys(s0.windows)[0] as string
  const spaceId = s0.windows[windowId]?.spaceId as string
  const active = async () => {
    const s = await state(orbit.app)
    const id = s.windows[windowId]?.activeTab[spaceId]
    return id ? s.tabs[id]?.url : undefined
  }
  // A second launch with a URL on its command line (Linux/Windows default browser).
  const fromArgv = fx.url('/page/FromArgv')
  await orbit.app.evaluate(({ app }, url) => app.emit('second-instance', {}, ['orbit', '--flag', url], '/'), fromArgv)
  await expect.poll(active).toBe(fromArgv)
  // macOS open-url and open-file.
  const fromOpenUrl = fx.url('/page/FromOpenUrl')
  await orbit.app.evaluate(({ app }, url) => app.emit('open-url', { preventDefault() {} }, url), fromOpenUrl)
  await expect.poll(active).toBe(fromOpenUrl)
  const file = join(mkdtempSync(join(tmpdir(), 'orbit-file-')), 'doc.html')
  writeFileSync(file, '<title>Doc</title><h1 id="title">Doc</h1>')
  await orbit.app.evaluate(({ app }, path) => app.emit('open-file', { preventDefault() {} }, path), file)
  await expect.poll(active).toBe(pathToFileURL(file).href)
  const s = await state(orbit.app)
  expect(s.spaces[spaceId]?.today).toHaveLength(3)
  expect(Object.values(s.tabs).every((t) => t.spaceId === spaceId)).toBe(true)
})

/** Labels of a window's views, bottom to top: OVERLAY, or the path of each tab view's page. */
async function zOrder(app: Orbit['app']) {
  return app.evaluate(() => {
    const ctx = (globalThis as unknown as OrbitGlobal).__orbit.ctx
    return (ctx.windows.get(ctx.windows.ids()[0] as string)?.contentView.children ?? []).map((v) => {
      const wc = (v as Electron.WebContentsView).webContents
      if (!wc || wc.isDestroyed()) return 'dead'
      const url = wc.getURL()
      return url.includes('view=overlay') ? 'OVERLAY' : new URL(url || 'about:blank').pathname
    })
  })
}

/** Records the first window's native fullscreen transitions ('enter' / 'leave' when each ends). */
async function watchNativeFullscreen(app: Orbit['app']) {
  await app.evaluate(() => {
    const g = globalThis as unknown as OrbitGlobal & { __fsEvents: string[] }
    g.__fsEvents = []
    const win = g.__orbit.ctx.windows.get(g.__orbit.ctx.windows.ids()[0] as string)
    win?.on('enter-full-screen', () => g.__fsEvents.push('enter'))
    win?.on('leave-full-screen', () => g.__fsEvents.push('leave'))
  })
  return () => app.evaluate(() => (globalThis as unknown as { __fsEvents: string[] }).__fsEvents.join(','))
}

/** Runs page script in a tab (with a user gesture), giving up after `ms` instead of hanging. */
async function inPage(app: Orbit['app'], tabId: string, code: string, ms = 15_000) {
  return app.evaluate(
    (_e, [id, js, limit]) => {
      const contents = (globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs.get(id)?.webContents
      if (!contents) return Promise.resolve('no page')
      return Promise.race([
        contents.executeJavaScript(js, true).then((v) => String(v)),
        new Promise<string>((r) => setTimeout(() => r('timeout'), limit)),
      ])
    },
    [tabId, code, ms] as const,
  )
}

test('[NV-20] HTML fullscreen fills the window and restores the pane on exit (review F11)', async () => {
  const tabId = (await run(orbit.app, 'tabs.create', { url: fx.url('/page/Video') })) as string
  await tabPage(orbit.app, '/page/Video')
  await expect.poll(async () => (await viewPlacement(orbit.app, tabId))?.visible).toBe(true)
  const bounds = () =>
    orbit.app.evaluate((_e, id) => {
      const ctx = (globalThis as unknown as OrbitGlobal).__orbit.ctx
      const [width, height] = ctx.windows.get(ctx.windows.ids()[0] as string)?.getContentSize() ?? [0, 0]
      return { view: ctx.tabs.get(id)?.getBounds(), content: { x: 0, y: 0, width, height } }
    }, tabId)
  const framed = (await bounds()).view
  expect(framed?.x).toBeGreaterThan(0)
  const transitions = await watchNativeFullscreen(orbit.app)
  expect(await inPage(orbit.app, tabId, 'document.documentElement.requestFullscreen().then(() => "in")')).toBe('in')
  // macOS animates into fullscreen: wait for the window to get there, as a person would.
  await expect.poll(transitions).toContain('enter')
  await expect
    .poll(async () => {
      const b = await bounds()
      return JSON.stringify(b.view) === JSON.stringify(b.content)
    })
    .toBe(true)
  // The page covers the other tab views but never the overlay (command bar, menus), however
  // often the window is laid out again while in fullscreen.
  for (let i = 0; i < 2; i++) {
    const order = await zOrder(orbit.app)
    expect(order.slice(-2)).toEqual(['/page/Video', 'OVERLAY'])
    await orbit.app.evaluate(() => {
      const ctx = (globalThis as unknown as OrbitGlobal).__orbit.ctx
      ctx.windows.get(ctx.windows.ids()[0] as string)?.emit('resize')
    })
  }
  expect(await inPage(orbit.app, tabId, 'document.exitFullscreen().then(() => "out")')).toBe('out')
  await expect.poll(async () => (await bounds()).view?.x).toBe(framed?.x)
  await expect.poll(transitions).toContain('leave')
  expect(await inPage(orbit.app, tabId, 'String(!!document.fullscreenElement)')).toBe('false')
})

test('[NV-20] leaving HTML fullscreen right after entering does not leave the page stuck (review F11)', async () => {
  const tabId = (await run(orbit.app, 'tabs.create', { url: fx.url('/page/Quick') })) as string
  await tabPage(orbit.app, '/page/Quick')
  await expect.poll(async () => (await viewPlacement(orbit.app, tabId))?.visible).toBe(true)
  const framedX = await orbit.app.evaluate(
    (_e, id) => (globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs.get(id)?.getBounds().x,
    tabId,
  )
  expect(framedX).toBeGreaterThan(0)
  const transitions = await watchNativeFullscreen(orbit.app)
  // On macOS the exit lands while the window is still animating into fullscreen.
  const result = await inPage(
    orbit.app,
    tabId,
    'document.documentElement.requestFullscreen().then(() => document.exitFullscreen()).then(() => "out")',
  )
  expect(result).toBe('out')
  await expect.poll(() => inPage(orbit.app, tabId, 'String(!!document.fullscreenElement)')).toBe('false')
  await expect
    .poll(() =>
      orbit.app.evaluate(() => {
        const ctx = (globalThis as unknown as OrbitGlobal).__orbit.ctx
        return ctx.windows.get(ctx.windows.ids()[0] as string)?.isFullScreen()
      }),
    )
    .toBe(false)
  await expect
    .poll(() =>
      orbit.app.evaluate(
        (_e, id) => (globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs.get(id)?.getBounds().x,
        tabId,
      ),
    )
    .toBe(framedX)
  if (process.platform === 'darwin') expect(await transitions()).toContain('leave')
})

test('[TB-19] a tab view that replaces another stays below the open command bar (review R1)', async () => {
  await run(orbit.app, 'tabs.create', { url: fx.url('/page/Alpha') })
  const alpha = await tabPage(orbit.app, '/page/Alpha')
  await action(orbit.app, 'tab.new')
  const overlay = await viewPage(orbit.app, 'overlay')
  await expect(overlay.getByTestId('command-input')).toBeFocused()
  // The page opens a tab while the command bar is up: its first view is replaced by the real one.
  // A real click, because pages may only open tabs on a user gesture (review M6).
  await alpha.click('#external')
  await expect.poll(async () => Object.keys((await state(orbit.app)).tabs).length).toBe(2)
  await expect.poll(async () => (await zOrder(orbit.app)).filter((l) => l === '/page/External').length).toBe(1)
  await expect.poll(async () => (await zOrder(orbit.app)).at(-1)).toBe('OVERLAY')
  expect(await overlay.getByTestId('command-input').isVisible()).toBe(true)
})

test('[NV-14] a crashed shell renderer reloads, and a crashed tab comes back when reloaded (review F11)', async () => {
  const a = (await run(orbit.app, 'tabs.create', { url: fx.url('/page/Crashy') })) as string
  await tabPage(orbit.app, '/page/Crashy')
  const b = (await run(orbit.app, 'tabs.create', { url: fx.url('/page/Calm') })) as string
  await tabPage(orbit.app, '/page/Calm')
  // A background tab crashes. Selecting it shows its crash screen (pages-crash.spec.ts); reloading
  // brings the page back.
  await orbit.app.evaluate(
    (_e, id) => (globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs.contents(id)?.forcefullyCrashRenderer(),
    a,
  )
  const crashed = (id: string) =>
    orbit.app.evaluate(
      (_e, t) => (globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs.contents(t)?.isCrashed() ?? null,
      id,
    )
  await expect.poll(() => crashed(a)).toBe(true)
  await run(orbit.app, 'tabs.activate', { tabId: a })
  await run(orbit.app, 'tabs.reload', { tabId: a })
  await expect.poll(() => crashed(a)).toBe(false)
  await expect
    .poll(() =>
      orbit.app.evaluate(
        (_e, t) =>
          (globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs
            .contents(t)
            ?.executeJavaScript('document.getElementById("title")?.textContent'),
        a,
      ),
    )
    .toBe('Crashy')
  expect(b).toBeTruthy()
  // The window's own UI renderer crashes: it comes back with the sidebar.
  await orbit.app.evaluate(() => {
    const ctx = (globalThis as unknown as OrbitGlobal).__orbit.ctx
    ctx.windows.get(ctx.windows.ids()[0] as string)?.webContents.forcefullyCrashRenderer()
  })
  await expect
    .poll(
      () =>
        orbit.app.evaluate(() => {
          const ctx = (globalThis as unknown as OrbitGlobal).__orbit.ctx
          const shell = ctx.windows.get(ctx.windows.ids()[0] as string)?.webContents
          if (!shell || shell.isCrashed() || shell.isLoading()) return false
          // A renderer that is just dying never answers: give each probe a deadline.
          return Promise.race([
            shell.executeJavaScript('!!document.querySelector("[data-testid=sidebar]")'),
            new Promise((r) => setTimeout(() => r(false), 500)),
          ])
        }),
      { timeout: 15_000 },
    )
    .toBe(true)
})

test('[AP-01][SP-18] the window background and colour scheme follow the global appearance (review F14)', async () => {
  const s = await state(orbit.app)
  const windowId = Object.keys(s.windows)[0] as string
  const theme = s.spaces[s.windows[windowId]?.spaceId as string]?.theme
  const setAppearance = (appearance: 'light' | 'dark' | 'system') =>
    orbit.app.evaluate((_e, a) => {
      ;(globalThis as unknown as OrbitGlobal).__orbit.ctx.store.update((d) => {
        d.settings.appearance = a
      })
    }, appearance)
  const native = () =>
    orbit.app.evaluate(({ nativeTheme }, w) => {
      const win = (globalThis as unknown as OrbitGlobal).__orbit.ctx.windows.get(w)
      return { source: nativeTheme.themeSource, background: win?.getBackgroundColor().toLowerCase() }
    }, windowId)
  // Playwright pins pages to a light colour scheme unless told not to.
  await orbit.shell.emulateMedia({ colorScheme: null })
  for (const appearance of ['dark', 'light'] as const) {
    await setAppearance(appearance)
    const expected = paletteFor(theme as SpaceTheme, appearance === 'dark').windowBackground
    await expect.poll(native).toEqual({ source: appearance, background: expected.toLowerCase() })
    await expect
      .poll(() => orbit.shell.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches))
      .toBe(appearance === 'dark')
  }
  await setAppearance('system')
  await expect.poll(async () => (await native()).source).toBe('system')
})
