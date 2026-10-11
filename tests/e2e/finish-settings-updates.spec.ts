import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { loadavg } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, test } from '@playwright/test'
import { TEST_RELAUNCH_FILE } from '../../src/main/updates/install'
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
   * Offers `version`, with its file for this system. `hold`: the file's download stops half-way
   * until `finish()`. `badSum`: the SHA-256 the feed gives isn't the file's.
   */
  offer: (version: string, opts?: { summary?: string; hold?: boolean; badSum?: boolean }) => void
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
        files: { [system]: { url: `${base}/pkg/orbit-${version}-${system}${ext}`, sha256, size: body.length } },
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
    await expect
      .poll(async () => {
        const s = await state(orbit.app)
        const win = Object.values(s.windows)[0]
        const tabId = win?.activeTab[win.spaceId]
        return tabId ? s.tabs[tabId]?.url : undefined
      })
      .toBe(feed.page(`/release/${version}`))
    // Nothing to download: the feed's version is the one running.
    expect(feed.downloads).toEqual([])
  } finally {
    await feed.close()
  }
})
