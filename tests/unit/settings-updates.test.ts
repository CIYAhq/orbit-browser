import { describe, expect, it } from 'vitest'
import { isRuntimeOnlyPatch, normalizeState } from '../../src/main/persist'
import { bugReportUrl, buildInfoText } from '../../src/main/settings/build-info'
import { normalizeSettingsPrefs } from '../../src/main/settings/normalize'
import { applySettingsPatch } from '../../src/main/settings/validate'
import { CHECK_EVERY_MS, CHECK_JITTER_MS, nextCheckDelay } from '../../src/main/updates/schedule'
import { ago } from '../../src/renderer/src/settings/format'
import type { BuildInfo } from '../../src/shared/commands/settings'
import { createInitialState, DEFAULT_SETTINGS } from '../../src/shared/defaults'
import { ISSUES_URL } from '../../src/shared/project'
import type { OrbitState, Settings } from '../../src/shared/state'
import { cleanVersion, compareVersions, feedUrlProblem, isNewer, parseFeed } from '../../src/shared/updates'

function withSettings(settings: Record<string, unknown>): OrbitState {
  const state = createInitialState(0)
  state.settings = { ...state.settings, ...settings } as unknown as Settings
  return state
}

describe('[UP-01] versions', () => {
  it('orders versions as semver does: numbers, then a release above its pre-releases', () => {
    const ordered = [
      '0.1.0',
      '0.1.1',
      '0.2.0-alpha',
      '0.2.0-alpha.2',
      '0.2.0-alpha.10',
      '0.2.0-beta',
      '0.2.0',
      '0.10.0',
      '1.0.0',
    ]
    for (let i = 1; i < ordered.length; i++) {
      expect(compareVersions(ordered[i - 1] as string, ordered[i] as string)).toBe(-1)
      expect(compareVersions(ordered[i] as string, ordered[i - 1] as string)).toBe(1)
    }
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.2.3+build.7', '1.2.3')).toBe(0)
    expect(isNewer('0.2.0', '0.1.0')).toBe(true)
    expect(isNewer('0.1.0', '0.1.0')).toBe(false)
    expect(isNewer('0.1.0-rc.1', '0.1.0')).toBe(false)
  })

  it('reads "v1.2.3" as 1.2.3 and nothing else as a version', () => {
    expect(cleanVersion('v1.2.3')).toBe('1.2.3')
    expect(cleanVersion(' 1.2.3-beta.1+sha.5 ')).toBe('1.2.3-beta.1')
    for (const bad of [
      '1.2',
      '01.2.3',
      '1.2.3.4',
      'latest',
      '',
      '1.2.3-',
      7,
      null,
      undefined,
      `1.2.${'9'.repeat(70)}`,
    ]) {
      expect(cleanVersion(bad)).toBeUndefined()
    }
    expect(Number.isNaN(compareVersions('1.2', '1.2.0'))).toBe(true)
    expect(isNewer('next', '0.1.0')).toBe(false)
  })
})

describe('[UP-10][UP-12] release feeds', () => {
  it("reads Orbit's own feed", () => {
    expect(
      parseFeed({
        version: 'v0.2.0',
        url: 'https://example.com/orbit/0.2.0',
        summary: '  Faster  tabs ',
        security: true,
      }),
    ).toEqual({ version: '0.2.0', url: 'https://example.com/orbit/0.2.0', summary: 'Faster tabs', security: true })
    expect(parseFeed({ version: '0.2.0', url: 'https://example.com/' })).toEqual({
      version: '0.2.0',
      url: 'https://example.com/',
      security: false,
    })
  })

  it("reads a GitHub latest release, with its name or first line of notes as the summary and [security] as UP-12's mark", () => {
    const release = {
      tag_name: 'v0.3.0',
      html_url: 'https://github.com/o/p/releases/tag/v0.3.0',
      name: 'v0.3.0',
      body: "## What's Changed\n\n* **Split view** remembers its panes\n* Fixes [security]",
      draft: false,
      prerelease: false,
    }
    expect(parseFeed(release)).toEqual({
      version: '0.3.0',
      url: 'https://github.com/o/p/releases/tag/v0.3.0',
      summary: 'Split view remembers its panes',
      security: true,
    })
    expect(parseFeed({ ...release, name: 'Calmer colours', body: '' })).toMatchObject({
      summary: 'Calmer colours',
      security: false,
    })
    // "latest" that is a pre-release or draft offers nothing.
    expect(parseFeed({ ...release, prerelease: true })).toBeNull()
  })

  it('takes the newest proper release from a list of GitHub releases', () => {
    const r = (tag: string, extra = {}) => ({
      tag_name: tag,
      html_url: `https://github.com/o/p/releases/tag/${tag}`,
      ...extra,
    })
    const list = [
      r('v0.5.0-beta.1', { prerelease: true }),
      r('v0.6.0', { draft: true }),
      r('v0.4.1'),
      r('v0.4.0'),
      r('nightly'),
    ]
    expect(parseFeed(list)?.version).toBe('0.4.1')
    expect(parseFeed([])).toBeNull()
  })

  it('refuses what is not a feed, and pages that are not https (or http on this computer)', () => {
    for (const bad of [null, 'v1.0.0', 42, { name: 'x' }, { version: '1.0', url: 'https://e.com/' }]) {
      expect(parseFeed(bad)).toBeUndefined()
    }
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'http://example.com/',
      'https://user:pw@example.com/',
      'nope',
    ]) {
      expect(parseFeed({ version: '1.0.0', url })).toBeUndefined()
    }
    expect(parseFeed({ version: '1.0.0', url: 'http://127.0.0.1:3330/release' })?.url).toBe(
      'http://127.0.0.1:3330/release',
    )
  })

  it('keeps a summary to one short line', () => {
    const summary = parseFeed({
      version: '1.0.0',
      url: 'https://e.com/',
      summary: `${'word '.repeat(60)}\n\nmore`,
    })?.summary
    expect(summary?.length).toBeLessThanOrEqual(140)
    expect(summary).not.toContain('\n')
    expect(summary?.endsWith('…')).toBe(true)
  })
})

describe('[UP-01] the update feed address', () => {
  it('is empty by default: Orbit never checks until one is set', () => {
    expect(DEFAULT_SETTINGS.updateFeedUrl).toBe('')
    expect(feedUrlProblem('')).toBe('')
  })

  it('takes https, or plain http only to this computer, and never a user name or password', () => {
    expect(feedUrlProblem('https://api.github.com/repos/o/p/releases/latest')).toBe('')
    expect(feedUrlProblem('http://127.0.0.1:3330/feed.json')).toBe('')
    expect(feedUrlProblem('http://localhost:3330/feed.json')).toBe('')
    expect(feedUrlProblem('http://example.com/feed.json')).not.toBe('')
    expect(feedUrlProblem('ftp://example.com/feed.json')).not.toBe('')
    expect(feedUrlProblem('https://me:secret@example.com/feed.json')).not.toBe('')
    expect(feedUrlProblem('example.com/feed')).not.toBe('')
    expect(feedUrlProblem(`https://example.com/${'a'.repeat(3000)}`)).not.toBe('')
  })

  it('in test runs and development builds, only reaches this computer', () => {
    expect(feedUrlProblem('https://example.com/feed.json', { loopbackOnly: true })).not.toBe('')
    expect(feedUrlProblem('http://127.0.0.1:3330/feed.json', { loopbackOnly: true })).toBe('')
  })

  it('is set through updates.setFeed only; the automatic checks switch through settings.update', () => {
    const state = createInitialState(0)
    const draft = structuredClone(state.settings)
    const refused = applySettingsPatch(
      draft,
      { updateChecks: false, updateFeedUrl: 'https://e.com/', lastRunVersion: '9.9.9', whatsNew: {} },
      state,
    )
    expect(refused.sort()).toEqual(['lastRunVersion', 'updateFeedUrl', 'whatsNew'])
    expect(draft.updateChecks).toBe(false)
    expect(draft.updateFeedUrl).toBe('')
  })
})

describe('[UP-01][UP-06] update settings on load', () => {
  it('turns checks off for a feed that is not usable, and keeps a good one', () => {
    for (const bad of ['http://example.com/feed', 'javascript:x', 7, null]) {
      const state = withSettings({ updateFeedUrl: bad })
      normalizeSettingsPrefs(state)
      expect(state.settings.updateFeedUrl).toBe('')
    }
    const good = withSettings({ updateFeedUrl: ' https://example.com/feed.json ', updateChecks: false })
    normalizeSettingsPrefs(good)
    expect(good.settings.updateFeedUrl).toBe('https://example.com/feed.json')
    expect(good.settings.updateChecks).toBe(false)
  })

  it("keeps What's new and the last version only when they make sense", () => {
    const ok = withSettings({ lastRunVersion: '0.1.0', whatsNew: { version: '0.2.0', since: 5 } })
    normalizeSettingsPrefs(ok)
    expect(ok.settings.lastRunVersion).toBe('0.1.0')
    expect(ok.settings.whatsNew).toEqual({ version: '0.2.0', since: 5 })
    const bad = withSettings({ lastRunVersion: 'v0.1', whatsNew: { version: '0.2.0' }, updateChecks: 'yes' })
    normalizeSettingsPrefs(bad)
    expect(bad.settings).not.toHaveProperty('lastRunVersion')
    expect(bad.settings).not.toHaveProperty('whatsNew')
    expect(bad.settings.updateChecks).toBe(true)
  })

  it('never keeps update check results: they are runtime only and not a reason to save', () => {
    const state = createInitialState(0)
    state.updates = { state: 'available', latest: { version: '9.0.0', url: 'https://e.com/', security: false } }
    expect(normalizeState(JSON.parse(JSON.stringify(state)))).not.toHaveProperty('updates')
    expect(isRuntimeOnlyPatch({ op: 'add', path: ['updates'], value: {} })).toBe(true)
    expect(isRuntimeOnlyPatch({ op: 'replace', path: ['updates', 'state'], value: 'checking' })).toBe(true)
    expect(isRuntimeOnlyPatch({ op: 'replace', path: ['settings', 'updateFeedUrl'], value: '' })).toBe(false)
  })
})

describe('[UP-01] check timing', () => {
  it('checks about every 4 hours, give or take half an hour', () => {
    expect(nextCheckDelay(0)).toBe(CHECK_EVERY_MS - CHECK_JITTER_MS)
    expect(nextCheckDelay(1)).toBe(CHECK_EVERY_MS + CHECK_JITTER_MS)
    expect(nextCheckDelay(0.5)).toBe(CHECK_EVERY_MS)
    expect(CHECK_EVERY_MS).toBe(4 * 60 * 60 * 1000)
  })

  it('says when the last check was', () => {
    const now = 1_000_000_000
    expect(ago(now - 5_000, now)).toBe('just now')
    expect(ago(now - 60_000, now)).toBe('1 minute ago')
    expect(ago(now - 3 * 60 * 60_000 - 5, now)).toBe('3 hours ago')
    expect(ago(now - 2 * 24 * 60 * 60_000, now)).toBe('2 days ago')
  })
})

describe('[OB-13][UP-07] build info and bug reports', () => {
  const info: BuildInfo = {
    version: '0.1.0',
    electron: '44.7.0',
    chrome: '146.0.0.0',
    node: '24.1.0',
    v8: '14.6',
    os: 'Linux 6.8.0',
    arch: 'x64',
    built: '2026-10-10',
  }

  it('copies version, build date, engine, system and processor', () => {
    expect(buildInfoText(info)).toBe(
      'Orbit 0.1.0 (built 2026-10-10)\nChromium 146.0.0.0 (Electron 44.7.0, Node 24.1.0, V8 14.6)\nLinux 6.8.0 (x64)',
    )
    expect(buildInfoText({ ...info, built: undefined }).split('\n')[0]).toBe('Orbit 0.1.0')
  })

  it("opens a new issue on the project's tracker with the build info filled in", () => {
    const url = new URL(bugReportUrl(info))
    expect(`${url.origin}${url.pathname}`).toBe(`${ISSUES_URL}/new`)
    expect(url.searchParams.get('body')).toContain(buildInfoText(info))
  })
})
