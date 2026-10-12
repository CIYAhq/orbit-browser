import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { loadavg } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { TEST_RELAUNCH_FILE } from '../../src/main/updates/install'
import { DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from '../../src/shared/defaults'
import { record } from './frames'
import { action, launchOrbit, listenInRange, type Orbit, run, state } from './helpers'
import { clickInPage } from './nav-support'
import { dialogPage, type PagesFixtures, pageDialogs, startPagesFixtures, waitDialog } from './pages-support'
import { openSettings } from './settings-support'
import { liveTabs, waitTab } from './tabs-support'

/**
 * The update flow (UP-01, UP-02, UP-03, UP-05, UP-06) against a release feed served here, on this
 * lane's ports: it offers a newer version with a file for this system. Test runs install nothing and
 * start nothing at the relaunch (src/main/updates/install.ts): Orbit quits, records what it would
 * have installed, and the test starts it again as the new version (ORBIT_E2E_VERSION).
 */

let orbit: Orbit
let pages: PagesFixtures

test.beforeAll(async () => {
  pages = await startPagesFixtures()
})
test.afterAll(async () => {
  await pages.close()
})
test.beforeEach(async () => {
  orbit = await launchOrbit()
})
test.afterEach(async () => {
  await orbit.app.close().catch(() => {})
})

interface UpdateFeed {
  url: string
  page: (path: string) => string
  /**
   * Offers `version`, with its file for this system (none with `file: false`: Orbit opens its page,
   * UP-10). `hold`: the file's download stops half-way until `finish()`. `badSum`: the SHA-256 the
   * feed gives isn't the file's. `security`: a security fix (UP-12).
   */
  offer: (
    version: string,
    opts?: { summary?: string; hold?: boolean; badSum?: boolean; file?: boolean; security?: boolean },
  ) => void
  finish: () => void
  /** The requests for the update's file, with their headers. */
  downloads: IncomingHttpHeaders[]
  checks: () => number
  close: () => Promise<void>
}

async function startUpdateFeed(system: string): Promise<UpdateFeed> {
  const body = randomBytes(256 * 1024)
  const sum = createHash('sha256').update(body).digest('hex')
  const ext = system.startsWith('win32') ? '.exe' : system.startsWith('darwin') ? '.zip' : '.tar.gz'
  let feed: unknown = {}
  let hold: Promise<void> | undefined
  let finish = () => {}
  let checks = 0
  const downloads: IncomingHttpHeaders[] = []
  const server = createServer((req, res) => {
    const path = req.url ?? '/'
    if (path === '/feed.json') {
      checks++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(feed))
      return
    }
    if (path.startsWith('/pkg/')) {
      downloads.push(req.headers)
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length })
      res.write(body.subarray(0, body.length / 2))
      void (hold ?? Promise.resolve()).then(() => res.end(body.subarray(body.length / 2)))
      return
    }
    if (path === '/held.bin') {
      // A download that runs until the test ends.
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="held.bin"',
        'content-length': 50_000_000,
      })
      res.write(Buffer.alloc(64 * 1024))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>Release notes</title><h1>Release notes</h1>')
  })
  const base = `http://127.0.0.1:${await listenInRange(server, 3330)}`
  return {
    url: `${base}/feed.json`,
    page: (path) => `${base}${path}`,
    offer: (version, opts = {}) => {
      hold = opts.hold ? new Promise<void>((resolve) => (finish = resolve)) : undefined
      const sha256 = opts.badSum ? sum.replace(/^./, (c) => (c === '0' ? '1' : '0')) : sum
      feed = {
        version,
        url: `${base}/release/${version}`,
        ...(opts.summary ? { summary: opts.summary } : {}),
        ...(opts.security ? { security: true } : {}),
        ...(opts.file === false
          ? {}
          : {
              files: { [system]: { url: `${base}/pkg/orbit-${version}-${system}${ext}`, sha256, size: body.length } },
            }),
      }
    },
    finish: () => finish(),
    downloads,
    checks: () => checks,
    close: () =>
      new Promise((resolve) => {
        finish()
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** This system, as a feed lists files under it: "linux-x64". */
const systemOf = (app: ElectronApplication) => app.evaluate(() => `${process.platform}-${process.arch}`)
const appVersion = async (app: ElectronApplication) =>
  ((await run(app, 'settings.buildInfo')) as { version: string }).version
const newerThan = (version: string) => `${Number(version.split('.')[0]) + 1}.0.0`
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The update files Orbit keeps in its data folder. */
const updateFiles = (userData: string) => {
  const dir = join(userData, 'updates')
  return existsSync(dir) ? readdirSync(dir) : []
}

/** Runs a command as from a given window. */
const runIn = (app: ElectronApplication, windowId: string, name: string, args: unknown = {}) =>
  app.evaluate(
    (_e, [n, a, w]) =>
      (globalThis as unknown as { __orbit: { run: (n: string, a: unknown, w?: string) => unknown } }).__orbit.run(
        n,
        a,
        w,
      ),
    [name, args, windowId] as const,
  )

/** The address of the first window's shown tab. */
async function activeUrl(app: ElectronApplication): Promise<string | undefined> {
  const s = await state(app)
  const win = Object.values(s.windows)[0]
  const tabId = win?.activeTab[win.spaceId]
  return tabId ? s.tabs[tabId]?.url : undefined
}

/** What a test run's relaunch recorded it would install, or null when Orbit didn't relaunch. */
function relaunched(userData: string): { version: string; file: string } | null {
  const file = join(userData, TEST_RELAUNCH_FILE)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

/** Resolves when Orbit's main process has gone. */
const exited = (app: ElectronApplication) =>
  new Promise<void>((resolve) => {
    const proc = app.process()
    if (proc.exitCode !== null) resolve()
    else proc.once('exit', () => resolve())
  })

/** Sets up a feed offering a newer version, and waits until Orbit has downloaded it. */
async function readyUpdate(opts: { summary?: string } = {}) {
  const feed = await startUpdateFeed(await systemOf(orbit.app))
  const next = newerThan(await appVersion(orbit.app))
  feed.offer(next, opts)
  await run(orbit.app, 'updates.setFeed', { url: feed.url })
  await expect.poll(async () => (await state(orbit.app)).updates?.state).toBe('ready')
  return { feed, next }
}

test('[UP-01][UP-02][UP-03] a newer version downloads in the background and shows only once ready: “Update ready”, which opens on hover to Relaunch to update', async () => {
  const feed = await startUpdateFeed(await systemOf(orbit.app))
  try {
    const version = await appVersion(orbit.app)
    const next = newerThan(version)
    feed.offer(next, { summary: 'Calmer colours', hold: true })
    await run(orbit.app, 'updates.setFeed', { url: feed.url })

    // Half-way through the download: nothing in the sidebar yet; Settings shows how far it got.
    await expect.poll(async () => (await state(orbit.app)).updates?.state).toBe('downloading')
    const banner = orbit.shell.getByTestId('update-banner')
    await expect(banner).toHaveCount(0)
    const settings = await openSettings(orbit.app, { section: 'general', item: 'updates' })
    const status = settings.getByTestId('updates-status')
    await expect(status).toHaveAttribute('data-state', 'downloading')
    await expect(status).toHaveText(new RegExp(`^Downloading Orbit ${escaped(next)}… \\d+%$`))
    const progress = settings.getByTestId('updates-progress')
    await expect.poll(async () => Number(await progress.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(45)
    expect(Number(await progress.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(50)
    expect(feed.downloads).toHaveLength(1)
    // The download tells the feed's site no more than a check does (UP-01's privacy rule).
    expect(feed.downloads[0]?.['user-agent']).toMatch(
      new RegExp(`^Orbit/${escaped(version)} \\((macOS|Linux|Windows); \\w+\\)$`),
    )
    expect(feed.downloads[0]).not.toHaveProperty('cookie')
    await expect(banner).toHaveCount(0)

    feed.finish()
    await expect(banner).toHaveAttribute('data-action', 'relaunch')
    await expect(banner).toContainText('Update ready')
    await expect(status).toHaveText(`Orbit ${next} is ready. Relaunch to update (you have ${version}).`)
    await expect(settings.getByTestId('updates-relaunch')).toBeVisible()

    // Collapsed to a pill until hovered (UP-02).
    const more = banner.locator('.upd__more')
    expect((await more.boundingBox())?.height).toBeLessThan(1)
    await banner.hover()
    await expect.poll(async () => (await more.boundingBox())?.height ?? 0).toBeGreaterThan(20)
    await expect(more).toContainText('Calmer colours')
    await expect(more).toContainText('Relaunch to update')

    // While it waits for the relaunch, checks ask the feed nothing.
    const checks = feed.checks()
    await run(orbit.app, 'updates.check')
    expect(feed.checks()).toBe(checks)
    expect(feed.downloads).toHaveLength(1)
  } finally {
    await feed.close()
  }
})

test('[UP-03] with automatic checks off, Check Now offers Download: its progress, then Relaunch; a download that isn’t the release’s file is thrown away', async () => {
  const feed = await startUpdateFeed(await systemOf(orbit.app))
  try {
    const version = await appVersion(orbit.app)
    const next = newerThan(version)
    feed.offer(next, { badSum: true })
    await run(orbit.app, 'settings.update', { updateChecks: false })
    await run(orbit.app, 'updates.setFeed', { url: feed.url })
    const settings = await openSettings(orbit.app, { section: 'general', item: 'updates' })
    const status = settings.getByTestId('updates-status')
    await settings.getByTestId('updates-check').click()
    await expect(status).toHaveText(`Orbit ${next} is available (you have ${version}).`)
    expect(feed.downloads).toHaveLength(0)

    // A file whose SHA-256 isn't the one the feed gives is deleted, never used.
    await settings.getByTestId('updates-download').click()
    await expect(status).toHaveText(
      `Orbit ${next} is available (you have ${version}). The download doesn’t match its checksum.`,
    )
    expect(updateFiles(orbit.userData)).toEqual([])
    await expect(orbit.shell.getByTestId('update-banner')).toHaveCount(0)

    // The feed has the right file now: Download asks it again, then shows its progress, then Relaunch.
    feed.offer(next, { hold: true })
    await settings.getByTestId('updates-download').click()
    await expect(settings.getByTestId('updates-progress')).toBeVisible()
    await expect(status).toHaveAttribute('data-state', 'downloading')
    feed.finish()
    await expect(status).toHaveAttribute('data-state', 'ready')
    await expect(settings.getByTestId('updates-relaunch')).toHaveText('Relaunch')
    await expect(orbit.shell.getByTestId('update-banner')).toHaveAttribute('data-action', 'relaunch')
  } finally {
    await feed.close()
  }
})

test('[UP-02][UP-05][UP-06] one click relaunches into the update: windows, Spaces, tabs and split views come back, and What’s new gives the release’s line and opens its notes', async () => {
  const { userData } = orbit
  const { feed, next } = await readyUpdate({ summary: 'Calmer colours' })
  try {
    const app = orbit.app
    const first = (await run(app, 'tabs.create', { url: pages.url('/page/Left') })) as string
    const second = (await run(app, 'tabs.create', { url: pages.url('/page/Right') })) as string
    const splitId = (await run(app, 'split.create', { tabIds: [first, second] })) as string
    const waiting = (await run(app, 'tabs.create', { url: pages.url('/page/Waiting'), activate: false })) as string
    const work = (await run(app, 'spaces.create', { name: 'Work', activate: false })) as string
    const one = Object.keys((await state(app)).windows)[0] as string
    await action(app, 'window.new')
    await expect.poll(async () => Object.keys((await state(app)).windows).length).toBe(2)
    const two = Object.keys((await state(app)).windows).find((id) => id !== one) as string
    await runIn(app, two, 'spaces.switch', { spaceId: work })
    const other = (await runIn(app, two, 'tabs.create', { url: pages.url('/page/Other'), spaceId: work })) as string
    for (const [id, part] of [
      [first, '/page/Left'],
      [second, '/page/Right'],
      [other, '/page/Other'],
    ] as const) {
      await waitTab(app, id, part)
    }
    const before = await state(app)
    expect(before.windows[two]?.spaceId).toBe(work)

    // One click: Orbit quits at once (no question: no download runs, no page has unsaved changes).
    const gone = exited(app)
    const clicked = Date.now()
    await orbit.shell.getByTestId('update-banner-open').click()
    await gone
    const quitMs = Date.now() - clicked
    expect(relaunched(userData)?.version).toBe(next)
    expect(relaunched(userData)?.file).toMatch(new RegExp(`orbit-${escaped(next)}-[\\w-]+\\.(tar\\.gz|zip|exe)$`))
    await app.close()

    // Started again as the new version, it is where it was.
    const started = Date.now()
    orbit = await launchOrbit({ userData, env: { ORBIT_E2E_VERSION: next } })
    await waitTab(orbit.app, first, '/page/Left')
    await waitTab(orbit.app, other, '/page/Other')
    const startMs = Date.now() - started
    console.log(`[UP-05] relaunch: quit ${quitMs} ms, start ${startMs} ms (load ${loadavg()[0]?.toFixed(2)})`)
    const after = await state(orbit.app)
    expect(Object.keys(after.windows).sort()).toEqual([one, two].sort())
    for (const id of [one, two]) {
      expect(after.windows[id]?.spaceId).toBe(before.windows[id]?.spaceId)
      expect(after.windows[id]?.activeTab).toEqual(before.windows[id]?.activeTab)
    }
    expect(after.spaceOrder).toEqual(before.spaceOrder)
    for (const id of before.spaceOrder) expect(after.spaces[id]?.today).toEqual(before.spaces[id]?.today)
    expect(after.splits[splitId]).toEqual(before.splits[splitId])
    // The shown pages load at once (both of the split's); the others when selected (ST-16).
    expect((await liveTabs(orbit.app)).sort()).toEqual([first, second, other].sort())
    expect(after.tabs[waiting]?.asleep).toBe(true)

    // What's new: the release's line, and its notes in a tab (UP-06).
    const banner = orbit.shell.getByTestId('update-banner')
    await expect(banner).toHaveAttribute('data-kind', 'whats-new')
    await expect(banner).toContainText(`Updated to Orbit ${next}`)
    await expect(banner.getByTestId('update-banner-summary')).toHaveText('Calmer colours')
    await orbit.shell.getByTestId('update-banner-open').click()
    await expect
      .poll(async () => {
        const s = await state(orbit.app)
        const tabId = s.windows[one]?.activeTab[s.windows[one]?.spaceId ?? '']
        return tabId ? s.tabs[tabId]?.url : undefined
      })
      .toBe(feed.page(`/release/${next}`))
    const s = await state(orbit.app)
    expect(s.settings.pendingUpdate).toBeUndefined()
    expect(s.settings.lastRunVersion).toBe(next)
    // The downloaded file is gone.
    await expect.poll(() => updateFiles(userData)).toEqual([])
  } finally {
    await feed.close()
  }
})

test('[UP-02] the relaunch asks first while a download runs or a page has unsaved changes: Cancel keeps Orbit as it was', async () => {
  const { userData } = orbit
  const app = orbit.app
  const { feed } = await readyUpdate()
  try {
    // A page that warns before it goes, touched by the user (NV-24).
    const warn = (await run(app, 'tabs.create', { url: pages.url('/warn') })) as string
    await waitTab(app, warn, '/warn')
    await clickInPage(app, pages.url('/warn'), '#area')
    // A download that runs.
    await run(app, 'tabs.create', { url: feed.page('/held.bin') })
    await expect.poll(() => run(app, 'downloads.active')).toBe(1)
    const asked = () =>
      app.evaluate(() => (globalThis as unknown as { __orbitDownloads: { asked: string[] } }).__orbitDownloads.asked)
    const answer = (value: 'quit' | 'cancel') =>
      app.evaluate((_e, v) => {
        ;(globalThis as unknown as { __orbitDownloads: { quitAnswer?: string } }).__orbitDownloads.quitAnswer = v
      }, value)
    const stays = async () => {
      const s = await state(app)
      expect(s.updates?.state).toBe('ready')
      expect(s.settings.pendingUpdate).toBeUndefined()
      expect(s.tabs[warn]?.asleep).toBe(false)
      expect(relaunched(userData)).toBeNull()
      expect(
        await app.evaluate(
          () =>
            (globalThis as unknown as { __orbit: { ctx: { windows: { quitting: boolean } } } }).__orbit.ctx.windows
              .quitting,
        ),
      ).toBe(false)
    }
    const banner = orbit.shell.getByTestId('update-banner-open')

    // The download first: Cancel, and no page was asked or let go.
    await answer('cancel')
    await banner.click()
    await expect.poll(asked).toEqual(['1 download in progress, quit anyway?'])
    expect(await pageDialogs(app)).toEqual([])
    await stays()

    // Quit anyway, then the page: Cancel keeps Orbit running.
    await answer('quit')
    await banner.click()
    await expect.poll(asked).toHaveLength(2)
    const leave = async (choice: 'page-dialog-ok' | 'page-dialog-cancel') => {
      const d = await waitDialog(app, (x) => x.tabId === warn && x.onScreen && x.kind === 'leave')
      const view = await dialogPage(app, d.id)
      await expect(view.getByTestId('page-dialog-title')).toHaveText('Leave site?')
      await view.getByTestId(choice).click()
    }
    await leave('page-dialog-cancel')
    await expect.poll(async () => (await pageDialogs(app)).length).toBe(0)
    await stays()
    // The quit the download's answer was for never came: quitting now asks again.
    await answer('cancel')
    await app.evaluate(({ app: electronApp }) => electronApp.quit())
    await expect.poll(asked).toHaveLength(3)
    await stays()

    // Quit anyway, and Leave: Orbit relaunches.
    await answer('quit')
    const gone = exited(app)
    await banner.click()
    await leave('page-dialog-ok')
    await gone
    expect(relaunched(userData)).not.toBeNull()
  } finally {
    await feed.close()
  }
})

/** A part of the sidebar's box once it has stopped moving: the trays slide in and out. */
async function settledBox(shell: Page, testId: string): Promise<{ y: number; height: number }> {
  let last = ''
  let box: { y: number; height: number } | null = null
  await expect
    .poll(
      async () => {
        box = await shell.getByTestId(testId).boundingBox()
        const now = JSON.stringify(box)
        const same = now === last
        last = now
        return same && box !== null
      },
      { intervals: [200] },
    )
    .toBe(true)
  return box as unknown as { y: number; height: number }
}

test('[SB-10] the update banner, a left video’s controls and a running download stack just above the bottom bar, pushing the list up, and give the room back when they go', async () => {
  const { app, shell } = orbit
  const bottom = (b: { y: number; height: number }) => b.y + b.height
  // Nothing to show: no tray takes room, and the list reaches the bottom bar.
  await expect(shell.getByTestId('update-banner')).toHaveCount(0)
  expect((await settledBox(shell, 'media-tray')).height).toBe(0)
  expect((await settledBox(shell, 'downloads-tray')).height).toBe(0)
  const full = await settledBox(shell, 'space-strip')

  await run(app, 'settings.update', { autoPip: false })
  const { feed } = await readyUpdate()
  try {
    // A download that runs (DL-03); the tab opened only for it closes again.
    await run(app, 'tabs.create', { url: feed.page('/held.bin') })
    await expect.poll(() => run(app, 'downloads.active')).toBe(1)
    // A video playing with sound, left for another tab: with PiP off, its controls go to the
    // sidebar (MD-09).
    const video = (await run(app, 'tabs.create', { url: pages.url('/video/Clip') })) as string
    await waitTab(app, video, '/video/Clip')
    await expect.poll(async () => (await state(app)).tabs[video]?.media?.playing).toBe(true)
    const away = (await run(app, 'tabs.create', { url: pages.url('/page/Away') })) as string
    await waitTab(app, away, '/page/Away')
    await expect(shell.getByTestId('download-row')).toBeVisible()
    await expect(shell.getByTestId('media-controller')).toBeVisible()
    await expect(shell.getByTestId('update-banner')).toBeVisible()

    // Stacked in that order, the last on the bottom bar, none over another or over the list.
    const parts = ['space-strip', 'update-banner', 'media-tray', 'downloads-tray', 'spacebar']
    const boxes = []
    for (const part of parts) boxes.push(await settledBox(shell, part))
    for (let i = 1; i < boxes.length; i++) {
      const [upper, lower] = [boxes[i - 1], boxes[i]] as [{ y: number; height: number }, { y: number; height: number }]
      expect(bottom(upper), `${parts[i - 1]} over ${parts[i]}`).toBeLessThanOrEqual(lower.y + 1)
      if (i > 1) expect(lower.y - bottom(upper), `${parts[i - 1]} to ${parts[i]}`).toBeLessThanOrEqual(12)
    }
    expect(boxes[2]?.height).toBeGreaterThan(0)
    expect(boxes[3]?.height).toBeGreaterThan(0)
    // The list starts where it did and ends above the trays: they pushed it up.
    const list = boxes[0] as { y: number; height: number }
    expect(Math.abs(list.y - full.y)).toBeLessThanOrEqual(1)
    expect(bottom(full) - bottom(list)).toBeGreaterThanOrEqual(
      (boxes[1]?.height ?? 0) + (boxes[2]?.height ?? 0) + (boxes[3]?.height ?? 0) - 1,
    )

    // Each goes when it no longer applies: back on the video's tab, the download cancelled, the
    // banner closed. The list has its room again.
    await run(app, 'tabs.activate', { tabId: video })
    await expect(shell.getByTestId('media-controller')).toHaveCount(0)
    const [running] = (await run(app, 'downloads.list')) as { id: string }[]
    await run(app, 'downloads.cancel', { id: running?.id })
    await run(app, 'updates.dismiss', { banner: 'update' })
    await expect(shell.getByTestId('update-banner')).toHaveCount(0)
    await expect.poll(async () => (await shell.getByTestId('downloads-tray').boundingBox())?.height).toBe(0)
    const back = await settledBox(shell, 'space-strip')
    expect(Math.abs(bottom(back) - bottom(full))).toBeLessThanOrEqual(1)
  } finally {
    await feed.close()
  }
})

test('[UP-06] What’s new for a version Orbit didn’t install itself takes the feed’s line and page for it', async () => {
  const { userData } = orbit
  const version = await appVersion(orbit.app)
  await orbit.app.close()
  // Installed some other way: the last run was another version, and no relaunch left its line.
  const file = join(userData, 'orbit-state.json')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  saved.settings.lastRunVersion = '0.0.0'
  writeFileSync(file, JSON.stringify(saved))
  orbit = await launchOrbit({ userData })
  const banner = orbit.shell.getByTestId('update-banner')
  await expect(banner).toHaveAttribute('data-kind', 'whats-new')
  await expect(banner.getByTestId('update-banner-summary')).toHaveCount(0)

  const feed = await startUpdateFeed(await systemOf(orbit.app))
  try {
    feed.offer(version, { summary: 'Quieter tab sounds' })
    await run(orbit.app, 'updates.setFeed', { url: feed.url })
    await expect.poll(async () => (await state(orbit.app)).updates?.state).toBe('current')
    await expect(banner).toContainText(`Updated to Orbit ${version}`)
    await expect(banner.getByTestId('update-banner-summary')).toHaveText('Quieter tab sounds')
    await orbit.shell.getByTestId('update-banner-open').click()
    await expect.poll(() => activeUrl(orbit.app)).toBe(feed.page(`/release/${version}`))
    // Nothing to download: the feed's version is the one running.
    expect(feed.downloads).toEqual([])
  } finally {
    await feed.close()
  }
})

// ---- From the lead's sign-off 3 (D83) ----

test('[ST-17] About draws the version, engine, build date and update line in its first frame, opened there or switched to', async () => {
  const feed = await startUpdateFeed(await systemOf(orbit.app))
  try {
    const version = await appVersion(orbit.app)
    const next = newerThan(version)
    // A newer version with no file for this system: the update line says "(you have …)".
    feed.offer(next, { file: false })
    await run(orbit.app, 'updates.setFeed', { url: feed.url })
    await expect.poll(async () => (await state(orbit.app)).updates?.state).toBe('available')
    const arch = await orbit.app.evaluate(() => process.arch)
    const expected = {
      version,
      built: expect.stringMatching(/^Built \d{4}-\d{2}-\d{2}$/),
      engine: expect.stringMatching(/^Chromium [\d.]+ · Electron [\d.]+$/),
      system: expect.stringMatching(new RegExp(`.+ \\(${arch}\\)$`)),
      status: `Orbit ${next} is available (you have ${version}).`,
    }

    // Opened straight at About: what its first render put in the page, before the first paint.
    await orbit.app.context().addInitScript(() => {
      new MutationObserver((_records, observer) => {
        const text = (selector: string) => document.querySelector(selector)?.textContent ?? null
        if (!document.querySelector('[data-testid="about-version"]')) return
        ;(window as unknown as { __aboutFirst: Record<string, string | null> }).__aboutFirst = {
          version: text('[data-testid="about-version"]'),
          built: text('[data-testid="about-built"]'),
          engine: text('[data-testid="about-engine"]'),
          system: text('[data-setting="system"] .st-muted'),
          status: text('[data-setting="check-updates"] [data-testid="updates-status"]'),
        }
        observer.disconnect()
      }).observe(document, { childList: true, subtree: true })
    })
    let page = await openSettings(orbit.app, { section: 'about' })
    expect(await page.evaluate(() => (window as unknown as { __aboutFirst?: unknown }).__aboutFirst)).toEqual(expected)
    await page.close()
    await expect.poll(() => orbit.app.windows().filter((p) => p.url().includes('view=settings')).length).toBe(0)

    // Settings already open elsewhere, then About: its first frame has them, and no row moves after.
    page = await openSettings(orbit.app, { section: 'general' })
    const about = '[data-testid="settings-content"][data-section="about"]'
    const rec = await record(page, {
      version: { selector: `${about} [data-testid="about-version"]`, text: true },
      built: { selector: `${about} [data-testid="about-built"]`, text: true },
      engine: { selector: `${about} [data-testid="about-engine"]`, text: true },
      system: { selector: `${about} [data-setting="system"] .st-muted`, text: true },
      status: { selector: `${about} [data-setting="check-updates"] [data-testid="updates-status"]`, text: true },
      credits: `${about} [data-setting="credits"]`,
    })
    await run(orbit.app, 'settings.open', { section: 'about' })
    const { frames } = await rec.until(1200)
    const drawn = frames.filter((f) => f.els.version)
    const first = drawn[0]
    expect(first, 'About was drawn').toBeDefined()
    expect({
      version: first?.els.version?.text,
      built: first?.els.built?.text,
      engine: first?.els.engine?.text,
      system: first?.els.system?.text,
      status: first?.els.status?.text,
    }).toEqual(expected)
    expect(new Set(drawn.map((f) => Math.round(f.els.credits?.y ?? -1))).size).toBe(1)
  } finally {
    await feed.close()
  }
})

test('[UP-10] after a click opens the release page, the pill closes once the pointer leaves it; focused from the keyboard it opens', async () => {
  const feed = await startUpdateFeed(await systemOf(orbit.app))
  try {
    const next = newerThan(await appVersion(orbit.app))
    feed.offer(next, { summary: 'Calmer colours', file: false })
    await run(orbit.app, 'updates.setFeed', { url: feed.url })
    const banner = orbit.shell.getByTestId('update-banner')
    await expect(banner).toHaveAttribute('data-action', 'open')
    await expect(banner).toContainText('New version available')
    const open = orbit.shell.getByTestId('update-banner-open')
    const close = orbit.shell.getByTestId('update-banner-dismiss')
    const more = async () => (await banner.locator('.upd__more').boundingBox())?.height ?? 0
    const closeShows = () => close.evaluate((el) => getComputedStyle(el).opacity)

    await banner.hover()
    await expect.poll(more).toBeGreaterThan(20)
    await open.click()
    await expect.poll(() => activeUrl(orbit.app)).toBe(feed.page(`/release/${next}`))
    // The pointer moves up the sidebar: the pill closes, and its ✕ goes.
    const side = (await orbit.shell.getByTestId('sidebar').boundingBox()) as { x: number; y: number; width: number }
    await orbit.shell.mouse.move(side.x + side.width / 2, side.y + 14)
    await expect.poll(more).toBeLessThan(1)
    await expect.poll(closeShows).toBe('0')

    // From the keyboard (Shift+Tab from its ✕), it opens with its ✕.
    await close.focus()
    await orbit.shell.keyboard.press('Shift+Tab')
    await expect(open).toBeFocused()
    await expect.poll(more).toBeGreaterThan(20)
    await expect.poll(closeShows).toBe('1')
  } finally {
    await feed.close()
  }
})

test('[UP-12] the security update’s whole title and its Relaunch to update show at the default and the narrowest sidebar widths, the ✕ over none of the title', async () => {
  const feed = await startUpdateFeed(await systemOf(orbit.app))
  try {
    const next = newerThan(await appVersion(orbit.app))
    feed.offer(next, { security: true })
    await run(orbit.app, 'updates.setFeed', { url: feed.url })
    const banner = orbit.shell.getByTestId('update-banner')
    await expect(banner).toHaveAttribute('data-kind', 'security')
    await expect(banner).toHaveAttribute('data-action', 'relaunch')
    const title = banner.locator('.upd__title')
    const cta = banner.locator('.upd__cta')
    const close = orbit.shell.getByTestId('update-banner-dismiss')
    const sidebar = orbit.shell.getByTestId('sidebar')
    const windowId = Object.keys((await state(orbit.app)).windows)[0] as string
    for (const width of [DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH]) {
      await runIn(orbit.app, windowId, 'window.setSidebar', { width })
      await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(width)
      await expect(title).toHaveText('Important security update')
      const fits = await title.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
      expect(fits.scroll, `title at ${width} px: ${JSON.stringify(fits)}`).toBeLessThanOrEqual(fits.client)

      // Hovered: the ✕ shows beside the title's text, over none of it, and the button shows whole.
      await banner.hover()
      await expect.poll(() => close.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
      const covered = await title.evaluate((el) => {
        const x = document.querySelector('[data-testid="update-banner-dismiss"]')?.getBoundingClientRect()
        const range = document.createRange()
        range.selectNodeContents(el)
        return [...range.getClientRects()].some(
          (r) => x && r.width > 0 && r.right > x.left && r.left < x.right && r.bottom > x.top && r.top < x.bottom,
        )
      })
      expect(covered, `✕ over the title at ${width} px`).toBe(false)
      await expect(cta).toHaveText('Relaunch to update')
      await expect
        .poll(() =>
          cta.evaluate((el) => {
            const shown = (el.closest('.upd__more-inner') as Element).getBoundingClientRect()
            const box = el.getBoundingClientRect()
            return (
              el.scrollWidth <= el.clientWidth && box.right <= shown.right + 0.5 && box.bottom <= shown.bottom + 0.5
            )
          }),
        )
        .toBe(true)
      const box = (await sidebar.boundingBox()) as { x: number; y: number; width: number }
      await orbit.shell.mouse.move(box.x + box.width / 2, box.y + 14)
    }
  } finally {
    await feed.close()
  }
})
