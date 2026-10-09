import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import type { MainContext } from '../../src/main/context'
import type { SpaceTheme } from '../../src/shared/state'
import { paletteFor } from '../../src/shared/theme'
import {
  type Fixtures,
  launchOrbit,
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
test.beforeEach(async () => {
  orbit = await launchOrbit()
})
test.afterEach(async () => {
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
    if (!view || view.webContents.isDestroyed()) return null
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
        return { url: wc.isDestroyed() ? 'destroyed' : wc.getURL(), current: live.has(v as Electron.WebContentsView) }
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
  const placed = await placedUrls(orbit.app, windowId)
  expect(placed.at(-1)?.url).toContain('/page/External')
})

test('[TB-06] a page that closes itself leaves no dead view; the tab shows again (review M3)', async () => {
  const a = (await run(orbit.app, 'tabs.create', { url: fx.url('/page/Closer') })) as string
  const page = await tabPage(orbit.app, '/page/Closer')
  await expect(page.locator('#title')).toHaveText('Closer')
  const b = (await run(orbit.app, 'tabs.create', { url: fx.url('/page/Other') })) as string
  await run(orbit.app, 'tabs.activate', { tabId: a })
  await expect.poll(async () => (await viewPlacement(orbit.app, a))?.visible).toBe(true)
  await page.evaluate(() => window.close())
  await expect.poll(async () => (await state(orbit.app)).tabs[a]?.asleep).toBe(true)
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
  const result = await orbit.app.evaluate(async ({ BrowserWindow }) => {
    const ctx = (globalThis as unknown as OrbitGlobal).__orbit.ctx
    const main = ctx.windows.get(ctx.windows.ids()[0] as string)
    main?.focus()
    await new Promise((r) => setTimeout(r, 200))
    const withMain = ctx.windows.focusedWindowId()
    const popup = new BrowserWindow({ width: 300, height: 200, show: true })
    popup.focus()
    await new Promise((r) => setTimeout(r, 300))
    const focusedIsPopup = BrowserWindow.getFocusedWindow() === popup
    const withPopup = ctx.windows.focusedWindowId()
    const closed = ctx.windows.closeFocusedForeign()
    await new Promise((r) => setTimeout(r, 200))
    return { withMain, focusedIsPopup, withPopup, closed, popupGone: popup.isDestroyed() }
  })
  expect(result.withMain).toBeTruthy()
  // Xvfb gives the popup focus; a macOS runner in the background may not, so only Linux insists.
  if (process.platform === 'linux') expect(result.focusedIsPopup).toBe(true)
  if (result.focusedIsPopup) {
    expect(result.withPopup).toBeUndefined()
    expect(result.closed).toBe(true)
    expect(result.popupGone).toBe(true)
  }
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
  const mainSeq = await orbit.app.evaluate(() => (globalThis as unknown as OrbitGlobal).__orbit.ctx.store.seq)
  type Mirror = { __orbitMirror: { resyncs: () => number; seq: () => number } }
  for (const page of [orbit.shell, overlay]) {
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as Mirror).__orbitMirror.seq())).toBe(mainSeq)
    // Only the first load: no batch failed to apply and no gap forced a snapshot.
    expect(await page.evaluate(() => (globalThis as unknown as Mirror).__orbitMirror.resyncs())).toBe(1)
  }
  expect(errors.filter((e) => e.includes('[store]') || e.includes('Immer'))).toEqual([])
})

test('[NV-18] links and files from other apps open as tabs in the current Space (review F10)', async () => {
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
  const fullscreen = (on: boolean) =>
    orbit.app.evaluate(
      (_e, [id, enter]) =>
        (globalThis as unknown as OrbitGlobal).__orbit.ctx.tabs
          .contents(id)
          ?.executeJavaScript(
            enter ? 'document.documentElement.requestFullscreen().then(() => true)' : 'document.exitFullscreen()',
            true,
          ),
      [tabId, on] as const,
    )
  await fullscreen(true)
  await expect
    .poll(async () => {
      const b = await bounds()
      return JSON.stringify(b.view) === JSON.stringify(b.content)
    })
    .toBe(true)
  await fullscreen(false)
  await expect.poll(async () => (await bounds()).view?.x).toBe(framed?.x)
})

test('[NV-14] a crashed shell renderer reloads, and a crashed tab reloads when shown (review F11)', async () => {
  const a = (await run(orbit.app, 'tabs.create', { url: fx.url('/page/Crashy') })) as string
  await tabPage(orbit.app, '/page/Crashy')
  const b = (await run(orbit.app, 'tabs.create', { url: fx.url('/page/Calm') })) as string
  await tabPage(orbit.app, '/page/Calm')
  // A background tab crashes; selecting it reloads the page.
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
    const expected = paletteFor({ ...(theme as SpaceTheme), mode: 'system' }, appearance === 'dark').windowBackground
    await expect.poll(native).toEqual({ source: appearance, background: expected.toLowerCase() })
    await expect
      .poll(() => orbit.shell.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches))
      .toBe(appearance === 'dark')
  }
  await setAppearance('system')
  await expect.poll(async () => (await native()).source).toBe('system')
})
