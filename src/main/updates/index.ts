import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, powerMonitor, type Session, session } from 'electron'
import { durationMs, EASE } from '../../shared/motion'
import { cubicBezier } from '../../shared/pip'
import { RELEASES_URL } from '../../shared/project'
import type { WindowId } from '../../shared/state'
import {
  compareVersions,
  feedUrlProblem,
  isNewer,
  parseFeed,
  type ReleaseInfo,
  systemKey,
  type UpdateStatus,
} from '../../shared/updates'
import type { MainContext } from '../context'
import { reducedMotion } from '../motion'
import { runningVersion } from '../settings/build-info'
import { DownloadError, fetchPackage } from './download'
import { type Installer, type Staged, systemInstaller, testInstaller } from './install'
import {
  CHECK_EVERY_MS,
  CHECK_TIMEOUT_MS,
  DISMISS_MS,
  FIRST_CHECK_MS,
  MAX_FEED_BYTES,
  nextCheckDelay,
  WHATS_NEW_MS,
} from './schedule'

/**
 * Updates (UP-01…UP-12). A check asks a release feed for a newer version (UP-01, UP-03).
 * - When the release has a file for this system and this copy can replace itself (install.ts), it
 *   downloads in the background, checked against its SHA-256 (automatic checks; else Settings'
 *   Download), and only then shows: "Update ready" in the sidebar and Relaunch in Settings (UP-02,
 *   UP-03). A click relaunches into it; windows, Spaces, tabs and split views come back as they
 *   were, with each page's place (UP-05, ST-16), and What's new follows (UP-06).
 * - Otherwise (no file for this system, a development run…) the banner and Settings offer the
 *   release's page in a tab (UP-10).
 *
 * Nothing is checked until a feed address is set (Settings → General; empty by default), so test
 * and development runs never contact a server; those builds also only accept a feed on this
 * computer, and follow no redirect. A check and a download go through a session of their own with
 * no cookies or cache, and an agent string of Orbit's version, system and processor type (UP-01's
 * privacy rule).
 */
export function registerUpdates(ctx: MainContext): void {
  const updater = new Updater(ctx)
  const { commands } = ctx

  commands.register('updates.check', () => updater.check())
  commands.register('updates.download', () => updater.download())
  commands.register('updates.relaunch', () => updater.relaunch())
  commands.register('updates.setFeed', ({ url }) => updater.setFeed(url))
  commands.register('updates.open', (_args, c) => updater.openRelease(c.windowId))
  commands.register('updates.dismiss', ({ banner }) => updater.dismiss(banner))
  commands.register('updates.whatsNew', (_args, c) => updater.openWhatsNew(c.windowId))

  updater.start()
}

class FeedError extends Error {}

/** Where downloaded updates wait for a relaunch, in the user's data folder. */
const UPDATES_DIR = 'updates'

class Updater {
  private readonly version = runningVersion(app.getVersion())
  /** Test runs and unpackaged builds only check a feed on this computer. */
  private readonly loopbackOnly: boolean
  private readonly installer: Installer
  private timer: NodeJS.Timeout | undefined
  private readonly timers = new Set<NodeJS.Timeout>()
  private running: Promise<UpdateStatus> | undefined
  private downloading: Promise<void> | undefined
  /** The downloaded update, unpacked and waiting for a relaunch. */
  private staged: Staged | undefined
  /** A relaunch is asking its questions (downloads, pages with unsaved changes). */
  private asking = false
  /** A relaunch into `staged` is under way: the windows fade and Orbit quits. */
  private relaunching = false
  private ses: Session | undefined

  constructor(private readonly ctx: MainContext) {
    this.loopbackOnly = ctx.e2e || !app.isPackaged
    this.installer = ctx.e2e
      ? testInstaller(ctx.paths.userData)
      : systemInstaller(
          {
            platform: process.platform,
            execPath: process.execPath,
            packaged: app.isPackaged,
            env: process.env,
            relaunch: (execPath) => app.relaunch(execPath ? { execPath } : undefined),
          },
          app.getName(),
        )
  }

  start(): void {
    const { store } = this.ctx
    this.noteVersion()
    // What an earlier update left behind: the copy it replaced, files of versions never installed.
    void this.installer.cleanUp()
    void rm(this.updatesDir(), { recursive: true, force: true }).catch(() => {})
    this.plan(this.ctx.e2e ? 1000 : FIRST_CHECK_MS)
    store.subscribe((next, prev) => {
      const now = next.settings
      const before = prev.settings
      if (now.updateFeedUrl !== before.updateFeedUrl) {
        // Another feed: what the old one said no longer counts.
        this.reset()
        this.plan(0)
      } else if (now.updateChecks !== before.updateChecks) {
        this.plan(now.updateChecks ? 1000 : undefined)
      }
    })
    // After sleep, a check that fell due meanwhile runs once the network is likely back.
    powerMonitor.on('resume', () => {
      const last = this.status().checkedAt ?? 0
      if (Date.now() - last >= CHECK_EVERY_MS) this.plan(15_000)
    })
    app.once('will-quit', () => {
      clearTimeout(this.timer)
      for (const t of this.timers) clearTimeout(t)
      this.timers.clear()
      if (this.relaunching && this.staged) this.install(this.staged)
    })
    app.on('before-quit', (event) => {
      // Something stopped the relaunch's quit (a download that began meanwhile asks, DL-01): Orbit
      // stays as it was, and the banner stays on offer.
      if (this.relaunching && event.defaultPrevented) this.callOff()
    })
  }

  private updatesDir(): string {
    return join(this.ctx.paths.userData, UPDATES_DIR)
  }

  /** Nothing checked (yet): another feed, or none. */
  private reset(): void {
    this.staged = undefined
    this.ctx.store.update((d) => {
      d.updates = { state: 'idle' }
    })
  }

  private status(): UpdateStatus {
    return this.ctx.store.state.updates ?? { state: 'idle' }
  }

  private patch(fields: Partial<UpdateStatus>): void {
    this.ctx.store.update((d) => {
      if (!d.updates) d.updates = { state: 'idle' }
      const next = d.updates as unknown as Record<string, unknown>
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) delete next[key]
        else next[key] = value
      }
    })
  }

  /** The feed to check, or '' when there is none (or this build may not use it). */
  private feed(): string {
    const url = this.ctx.store.state.settings.updateFeedUrl
    if (!url || feedUrlProblem(url, { loopbackOnly: this.loopbackOnly })) return ''
    return url
  }

  private auto(): boolean {
    return this.ctx.store.state.settings.updateChecks && this.feed() !== ''
  }

  /** The next background check, in `delay` ms (none when checks are off). */
  private plan(delay: number | undefined): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (delay === undefined || !this.auto()) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.check()
    }, delay)
  }

  /** Runs `fn` after `ms`, unless Orbit quits first. */
  private later(ms: number, fn: () => void): void {
    const t = setTimeout(
      () => {
        this.timers.delete(t)
        fn()
      },
      Math.max(0, Math.min(ms, 2 ** 31 - 1)),
    )
    this.timers.add(t)
  }

  /**
   * Checks the feed now (UP-01, UP-03); a call while a check runs gets that one's result. Failures
   * are silent: only Settings shows them, and the next check comes as planned.
   */
  check(): Promise<UpdateStatus> {
    this.running ??= this.run().finally(() => {
      this.running = undefined
    })
    return this.running
  }

  private async run(): Promise<UpdateStatus> {
    const feed = this.feed()
    if (!feed) {
      if (this.status().state !== 'idle') this.reset()
      return this.status()
    }
    // An update coming in, or waiting for a relaunch: nothing to ask the feed until it is installed.
    const now = this.status().state
    if (now === 'downloading' || now === 'ready') return this.status()
    this.patch({ state: 'checking', error: undefined })
    try {
      const release = await this.latestRelease(feed)
      const newer = release && isNewer(release.version, this.version) ? release : undefined
      if (feed === this.feed()) {
        if (release) this.describeThisVersion(release)
        const installable = !!newer?.package && this.installer.problem() === ''
        this.patch({
          state: newer ? 'available' : 'current',
          latest: newer,
          installable: newer ? installable : undefined,
          checkedAt: Date.now(),
        })
        // In the background when checks are automatic (UP-01); otherwise Settings offers Download (UP-03).
        if (installable && this.ctx.store.state.settings.updateChecks) void this.download()
      }
    } catch (err) {
      // What an earlier check found stays on offer.
      if (feed === this.feed()) this.patch({ state: 'failed', checkedAt: Date.now(), error: describe(err) })
    }
    this.plan(nextCheckDelay())
    return this.status()
  }

  /**
   * Downloads the newer version's file, checks it and unpacks it beside this copy (UP-01). Only then
   * does the update show: "Update ready" (UP-02). A failure says so in Settings only, and the next
   * check tries again.
   */
  download(): Promise<void> {
    this.downloading ??= (async () => {
      // After a failed download the feed may have put another file up: ask it again first.
      if (this.status().downloadError) await this.check()
      await this.fetch()
    })().finally(() => {
      this.downloading = undefined
    })
    return this.downloading
  }

  private async fetch(): Promise<void> {
    const { latest, installable, state } = this.status()
    const pkg = latest?.package
    if (!latest || !pkg || !installable || state === 'ready') return
    const feed = this.feed()
    const still = () => this.feed() === feed && this.status().latest?.version === latest.version
    this.patch({ state: 'downloading', progress: 0, error: undefined, downloadError: undefined })
    const name = `orbit-${latest.version}-${systemKey(process.platform, process.arch)}${extensionOf(pkg.url)}`
    const file = join(this.updatesDir(), name)
    try {
      await mkdir(this.updatesDir(), { recursive: true })
      await fetchPackage(this.session(), pkg, file, {
        follow: !this.loopbackOnly,
        onProgress: (share) => {
          if (still()) this.patch({ progress: Math.min(1, share) })
        },
      })
      const staged = await this.installer.stage(file, latest.version)
      if (!still()) return
      this.staged = staged
      this.patch({ state: 'ready', progress: undefined })
    } catch (err) {
      await rm(file, { force: true }).catch(() => {})
      // Still on offer: Settings says what went wrong and offers Download again.
      const error =
        err instanceof DownloadError ? err.message : `The update couldn't be unpacked (${describeError(err)}).`
      if (still()) this.patch({ state: 'available', progress: undefined, downloadError: error })
    }
  }

  /**
   * Relaunches into the downloaded update (UP-02, UP-05). A page with unsaved changes asks first, as
   * closing it would (NV-24), and so do downloads in progress (DL-01); Cancel keeps Orbit running.
   * The windows fade out, Orbit quits, the update goes in and Orbit starts again where it was.
   */
  async relaunch(): Promise<boolean> {
    const staged = this.staged
    const latest = this.status().latest
    if (this.status().state !== 'ready' || !staged || !latest || this.asking || this.relaunching) return false
    this.asking = true
    try {
      if (!(await this.mayQuit())) return false
    } finally {
      this.asking = false
    }
    if (this.staged !== staged || this.status().state !== 'ready') {
      this.withdrawQuit()
      return false
    }
    this.relaunching = true
    // Saved with the state at quit: the next start shows this release's What's new (UP-06).
    this.ctx.store.update((d) => {
      d.settings.pendingUpdate = {
        version: latest.version,
        url: latest.url,
        ...(latest.summary ? { summary: latest.summary } : {}),
      }
    })
    await this.fadeOut()
    if (!this.relaunching) return false
    app.quit()
    return true
  }

  /**
   * The questions a relaunch asks before the windows fade (UP-02): downloads in progress first
   * (DL-01), so Cancel there leaves every page as it was; then each page with unsaved changes, as
   * closing it would (NV-24). False when the user kept Orbit running.
   */
  private async mayQuit(): Promise<boolean> {
    const { commands, tabs } = this.ctx
    if (commands.has('downloads.confirmQuit') && !(await commands.run('downloads.confirmQuit', {}))) return false
    if (tabs.letGo && !(await tabs.letGo(tabs.liveTabIds()))) {
      this.withdrawQuit()
      return false
    }
    return true
  }

  /** The quit the downloads question was asked for doesn't come: the next quit asks again. */
  private withdrawQuit(): void {
    if (this.ctx.commands.has('downloads.confirmQuit')) {
      void this.ctx.commands.run('downloads.confirmQuit', { withdraw: true })
    }
  }

  /** A relaunch something called off: Orbit stays as it was. */
  private callOff(): void {
    if (!this.relaunching) return
    this.relaunching = false
    this.ctx.store.update((d) => {
      delete d.settings.pendingUpdate
    })
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.setOpacity(1)
  }

  /** At quit: the update goes in and Orbit starts again (where it can't, the same version does). */
  private install(staged: Staged): void {
    try {
      this.installer.apply(staged)
    } catch (err) {
      console.error('[updates] could not install', err)
      if (!this.ctx.e2e) app.relaunch()
    }
  }

  /**
   * The windows fade out before the relaunch (UP-05), where windows can fade (macOS, Windows);
   * none with reduced motion. About 190 ms, an exit's share of the standard duration.
   */
  private async fadeOut(): Promise<void> {
    if ((process.platform !== 'darwin' && process.platform !== 'win32') || reducedMotion(this.ctx)) return
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible())
    const ms = durationMs('standard', true)
    const ease = cubicBezier(...EASE.quick)
    const start = Date.now()
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        const t = Math.min(1, (Date.now() - start) / ms)
        for (const w of wins) if (!w.isDestroyed()) w.setOpacity(1 - ease(t))
        if (t >= 1 || !this.relaunching) {
          clearInterval(timer)
          resolve()
        }
      }, 12)
    })
  }

  setFeed(url: unknown): string {
    if (typeof url !== 'string') return 'Enter a web address.'
    const problem = feedUrlProblem(url, { loopbackOnly: this.loopbackOnly })
    if (problem) return problem
    const value = url.trim()
    if (value !== this.ctx.store.state.settings.updateFeedUrl) {
      this.ctx.store.update((d) => {
        d.settings.updateFeedUrl = value
      })
    }
    return ''
  }

  private session(): Session {
    if (!this.ses) {
      // In memory (no "persist:"), apart from every profile: no cookies, history or cache.
      this.ses = session.fromPartition('orbit-updates', { cache: false })
      this.ses.setUserAgent(`Orbit/${this.version} (${systemName()}; ${process.arch})`, 'en')
      this.ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    }
    return this.ses
  }

  private async latestRelease(feed: string): Promise<ReleaseInfo | undefined> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
    try {
      const res = await this.session().fetch(feed, {
        headers: { Accept: 'application/vnd.github+json, application/json;q=0.9' },
        credentials: 'omit',
        cache: 'no-store',
        // The feed rules (https, or this computer; this computer only in test and dev builds) are
        // checked on the address set, so a redirect could take the check anywhere: follow none.
        redirect: 'error',
        signal: controller.signal,
      })
      if (!res.ok) throw new FeedError(`The feed answered ${res.status}.`)
      const text = await readCapped(res, MAX_FEED_BYTES)
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        throw new FeedError('The feed is not JSON.')
      }
      const release = parseFeed(json, systemKey(process.platform, process.arch))
      if (release === undefined) throw new FeedError('The feed has no release Orbit can read.')
      return release ?? undefined
    } catch (err) {
      if (controller.signal.aborted) throw new FeedError('The feed did not answer in time.')
      if (err instanceof Error && /redirect/i.test(err.message)) {
        throw new FeedError('The feed redirects elsewhere; set the address it moved to.')
      }
      throw err
    } finally {
      clearTimeout(timeout)
    }
  }

  /** The banner's button and Settings' Download (UP-10): the release's page in a tab. */
  async openRelease(from: WindowId | undefined): Promise<void> {
    const url = this.status().latest?.url ?? RELEASES_URL
    await this.ctx.commands.run('settings.openUrl', { url }, { windowId: from })
  }

  dismiss(banner: 'update' | 'whatsNew'): void {
    if (banner === 'whatsNew') {
      this.endWhatsNew()
      return
    }
    const latest = this.status().latest
    if (!latest) return
    const until = Date.now() + DISMISS_MS
    this.patch({ dismissed: { version: latest.version, until } })
    this.later(DISMISS_MS, () => {
      if (this.status().dismissed?.until === until) this.patch({ dismissed: undefined })
    })
  }

  /**
   * After an update (UP-06): What's new until it is opened, dismissed or a few days old, with the
   * release's line and page when Orbit installed it itself (UP-05).
   */
  private noteVersion(): void {
    const now = Date.now()
    const s = this.ctx.store.state.settings
    const isNew = s.lastRunVersion !== undefined && isNewer(this.version, s.lastRunVersion)
    const stale = s.whatsNew && (s.whatsNew.version !== this.version || now - s.whatsNew.since >= WHATS_NEW_MS)
    // The update a relaunch installed; another version running means it didn't go in.
    const pending = s.pendingUpdate?.version === this.version ? s.pendingUpdate : undefined
    if (s.lastRunVersion !== this.version || stale || s.pendingUpdate) {
      this.ctx.store.update((d) => {
        if (stale) delete d.settings.whatsNew
        if (isNew) {
          d.settings.whatsNew = {
            version: this.version,
            since: now,
            ...(pending?.summary ? { summary: pending.summary } : {}),
            ...(pending?.url ? { url: pending.url } : {}),
          }
        }
        d.settings.lastRunVersion = this.version
        delete d.settings.pendingUpdate
      })
    }
    const news = this.ctx.store.state.settings.whatsNew
    if (news) this.later(news.since + WHATS_NEW_MS - now, () => this.endWhatsNew())
  }

  /**
   * What's new for a version Orbit didn't install itself (a new download, a package manager) has no
   * line yet: the feed's line and page for this version fill it in when a check finds them (UP-06).
   */
  private describeThisVersion(release: ReleaseInfo): void {
    const news = this.ctx.store.state.settings.whatsNew
    if (
      !news ||
      news.summary ||
      news.version !== this.version ||
      compareVersions(release.version, this.version) !== 0
    ) {
      return
    }
    this.ctx.store.update((d) => {
      const shown = d.settings.whatsNew
      if (!shown) return
      if (release.summary) shown.summary = release.summary
      shown.url ??= release.url
    })
  }

  private endWhatsNew(): void {
    if (!this.ctx.store.state.settings.whatsNew) return
    this.ctx.store.update((d) => {
      delete d.settings.whatsNew
    })
  }

  async openWhatsNew(from: WindowId | undefined): Promise<void> {
    const news = this.ctx.store.state.settings.whatsNew
    const url = news?.url ?? `${RELEASES_URL}/tag/v${news?.version ?? this.version}`
    this.endWhatsNew()
    await this.ctx.commands.run('settings.openUrl', { url }, { windowId: from })
  }
}

/** The update file's kind, from its address: ".tar.gz", ".zip" or ".exe". */
function extensionOf(url: string): string {
  const path = new URL(url).pathname.toLowerCase()
  return ['.tar.gz', '.zip', '.exe'].find((ext) => path.endsWith(ext)) ?? ''
}

/** A check's failure in words, for Settings. */
function describe(err: unknown): string {
  if (err instanceof FeedError) return err.message
  return `The feed could not be reached (${describeError(err)}).`
}

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 120)

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      void reader.cancel()
      throw new FeedError('The feed is too large.')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function systemName(): string {
  if (process.platform === 'darwin') return 'macOS'
  if (process.platform === 'win32') return 'Windows'
  if (process.platform === 'linux') return 'Linux'
  return process.platform
}
