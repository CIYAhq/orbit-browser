import { app, powerMonitor, type Session, session } from 'electron'
import { RELEASES_URL } from '../../shared/project'
import type { WindowId } from '../../shared/state'
import { feedUrlProblem, isNewer, parseFeed, type ReleaseInfo, type UpdateStatus } from '../../shared/updates'
import type { MainContext } from '../context'
import { BUILT_VERSION } from '../settings/build-info'
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
 * Updates (UP-01…UP-12). Orbit's builds are unsigned and no release feed is set up yet, so this is
 * the update stub of UP-10: it checks a release feed for a newer version and, when there is one,
 * the sidebar banner and Settings offer its page in a tab; nothing downloads or installs here.
 *
 * Nothing is checked until a feed address is set (Settings → General; empty by default), so test
 * and development runs never contact a server; those builds also only accept a feed on this
 * computer. A check asks the feed only: through a session of its own with no cookies or cache, and
 * an agent string of Orbit's version, system and processor type (UP-01's privacy rule).
 */
export function registerUpdates(ctx: MainContext): void {
  const updater = new Updater(ctx)
  const { commands } = ctx

  commands.register('updates.check', () => updater.check())
  commands.register('updates.setFeed', ({ url }) => updater.setFeed(url))
  commands.register('updates.open', (_args, c) => updater.openRelease(c.windowId))
  commands.register('updates.dismiss', ({ banner }) => updater.dismiss(banner))
  commands.register('updates.whatsNew', (_args, c) => updater.openWhatsNew(c.windowId))

  updater.start()
}

class FeedError extends Error {}

class Updater {
  private readonly version = BUILT_VERSION ?? app.getVersion()
  /** Test runs and unpackaged builds only check a feed on this computer. */
  private readonly loopbackOnly: boolean
  private timer: NodeJS.Timeout | undefined
  private readonly timers = new Set<NodeJS.Timeout>()
  private running: Promise<UpdateStatus> | undefined
  private ses: Session | undefined

  constructor(private readonly ctx: MainContext) {
    this.loopbackOnly = ctx.e2e || !app.isPackaged
  }

  start(): void {
    const { store } = this.ctx
    this.noteVersion()
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
    })
  }

  /** Nothing checked (yet): another feed, or none. */
  private reset(): void {
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
    this.patch({ state: 'checking', error: undefined })
    try {
      const release = await this.latestRelease(feed)
      const newer = release && isNewer(release.version, this.version) ? release : undefined
      if (feed === this.feed()) {
        this.patch({ state: newer ? 'available' : 'current', latest: newer, checkedAt: Date.now() })
      }
    } catch (err) {
      // What an earlier check found stays on offer.
      if (feed === this.feed()) this.patch({ state: 'failed', checkedAt: Date.now(), error: describe(err) })
    }
    this.plan(nextCheckDelay())
    return this.status()
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
      const release = parseFeed(json)
      if (release === undefined) throw new FeedError('The feed has no release Orbit can read.')
      return release ?? undefined
    } catch (err) {
      if (controller.signal.aborted) throw new FeedError('The feed did not answer in time.')
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

  /** After an update (UP-06): What's new until it is opened, dismissed or a few days old. */
  private noteVersion(): void {
    const now = Date.now()
    const s = this.ctx.store.state.settings
    const isNew = s.lastRunVersion !== undefined && isNewer(this.version, s.lastRunVersion)
    const stale = s.whatsNew && (s.whatsNew.version !== this.version || now - s.whatsNew.since >= WHATS_NEW_MS)
    if (s.lastRunVersion !== this.version || stale) {
      this.ctx.store.update((d) => {
        if (stale) delete d.settings.whatsNew
        if (isNew) d.settings.whatsNew = { version: this.version, since: now }
        d.settings.lastRunVersion = this.version
      })
    }
    const news = this.ctx.store.state.settings.whatsNew
    if (news) this.later(news.since + WHATS_NEW_MS - now, () => this.endWhatsNew())
  }

  private endWhatsNew(): void {
    if (!this.ctx.store.state.settings.whatsNew) return
    this.ctx.store.update((d) => {
      delete d.settings.whatsNew
    })
  }

  async openWhatsNew(from: WindowId | undefined): Promise<void> {
    const version = this.ctx.store.state.settings.whatsNew?.version ?? this.version
    this.endWhatsNew()
    await this.ctx.commands.run('settings.openUrl', { url: `${RELEASES_URL}/tag/v${version}` }, { windowId: from })
  }
}

/** A check's failure in words, for Settings. */
function describe(err: unknown): string {
  if (err instanceof FeedError) return err.message
  const message = err instanceof Error ? err.message : String(err)
  return `The feed could not be reached (${message.slice(0, 120)}).`
}

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
