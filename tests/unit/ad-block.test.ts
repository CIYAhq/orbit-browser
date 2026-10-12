import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SitePrefs } from '../../src/main/nav/site-prefs'
import { AD_HOSTS } from '../../src/main/settings/ad-hosts'
import { normalizeSettingsPrefs } from '../../src/main/settings/normalize'
import { applySettingsPatch } from '../../src/main/settings/validate'
import { adSiteOf, blockPatterns, listedEntry, normalHost, shouldBlock } from '../../src/shared/ad-block'
import { createInitialState, DEFAULT_PROFILE_ID, DEFAULT_SETTINGS } from '../../src/shared/defaults'
import type { Settings } from '../../src/shared/state'

/** Ad and tracker blocking (OB-06): what is stopped, Orbit's list, and where the choices are kept. */

const LIST = new Set(['ads.example', 'tracker.test', 'pixel.social.test'])
const page = 'https://news.site.test/article'

describe('[OB-06] which requests are stopped', () => {
  it('stops a page’s requests to a listed server or any of its subdomains, and nothing else', () => {
    for (const url of [
      'https://ads.example/banner.png',
      'https://cdn.ads.example/a.js',
      'http://x.y.tracker.test/p?u=1',
    ])
      expect(shouldBlock({ url, mainFrame: false, page }, LIST), url).toBe(true)
    for (const url of [
      'https://news.site.test/style.css',
      'https://images.site.test/photo.jpg',
      'https://notads.example/x.js',
      'https://ads.example.org/x.js',
      'https://social.test/widget.js',
      'data:image/png;base64,AAAA',
    ])
      expect(shouldBlock({ url, mainFrame: false, page }, LIST), url).toBe(false)
  })

  it('never stops the page the user goes to, and lets a listed site’s own page load from its own servers', () => {
    expect(shouldBlock({ url: 'https://ads.example/', mainFrame: true, page }, LIST)).toBe(false)
    const own = 'https://www.ads.example/dashboard'
    expect(shouldBlock({ url: 'https://cdn.ads.example/app.js', mainFrame: false, page: own }, LIST)).toBe(false)
    // …but not from another listed server.
    expect(shouldBlock({ url: 'https://tracker.test/t.js', mainFrame: false, page: own }, LIST)).toBe(true)
  })

  it('stops a listed server’s request when the page it is for is unknown', () => {
    expect(shouldBlock({ url: 'https://ads.example/a.js', mainFrame: false }, LIST)).toBe(true)
    expect(shouldBlock({ url: 'https://ads.example/a.js', mainFrame: false, page: 'about:blank' }, LIST)).toBe(true)
  })

  it('reads host names as the list keeps them', () => {
    expect(normalHost(' Ads.Example. ')).toBe('ads.example')
    expect(listedEntry('A.CDN.ads.example.', LIST)).toBe('ads.example')
    expect(listedEntry('social.test', LIST)).toBeNull()
    expect(listedEntry('pixel.social.test', LIST)).toBe('pixel.social.test')
  })

  it('keeps a site’s choice by its host name, for web pages only', () => {
    expect(adSiteOf('https://News.Site.test:8443/a?b')).toBe('news.site.test')
    expect(adSiteOf('http://localhost:3333/')).toBe('localhost')
    for (const url of ['orbit://settings', 'file:///tmp/a.html', 'about:blank', 'not a url', undefined])
      expect(adSiteOf(url), String(url)).toBeNull()
  })

  it('filters the session’s requests to the listed servers only', () => {
    expect(blockPatterns(['ads.example', 'tracker.test'])).toEqual(['*://*.ads.example/*', '*://*.tracker.test/*'])
  })
})

describe('[OB-06] Orbit’s list of servers', () => {
  const hostName = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

  it('names whole servers, each once, lowercase, with no scheme, port or path', () => {
    expect(AD_HOSTS.length).toBeGreaterThan(50)
    for (const host of AD_HOSTS) expect(host, host).toMatch(hostName)
    expect(new Set(AD_HOSTS).size).toBe(AD_HOSTS.length)
  })

  it('lists no server under another entry, which covers it already', () => {
    const list = new Set(AD_HOSTS)
    for (const host of AD_HOSTS) {
      const parent = listedEntry(host.slice(host.indexOf('.') + 1), list)
      expect(parent, host).toBeNull()
    }
  })

  it('never lists a site people use, its sign-in or its content servers: only their ad and tracking servers', () => {
    const list = new Set(AD_HOSTS)
    for (const host of [
      'google.com',
      'www.google.com',
      'accounts.google.com',
      'fonts.googleapis.com',
      'www.gstatic.com',
      'www.youtube.com',
      'i.ytimg.com',
      'facebook.com',
      'connect.facebook.net',
      'twitter.com',
      'x.com',
      'pbs.twimg.com',
      'www.linkedin.com',
      'static.licdn.com',
      'media.licdn.com',
      'www.bing.com',
      'login.microsoftonline.com',
      'www.amazon.com',
      'm.media-amazon.com',
      'www.apple.com',
      'cdnjs.cloudflare.com',
      'challenges.cloudflare.com',
      'github.com',
      'www.pinterest.com',
      'i.pinimg.com',
      'www.tiktok.com',
      'www.baidu.com',
      'yandex.ru',
      'segment.com',
      'www.reddit.com',
      'www.wikipedia.org',
    ])
      expect(listedEntry(host, list), host).toBeNull()
  })

  it('is the only request hook: Electron keeps one onBeforeRequest listener per session', () => {
    const main = resolve(__dirname, '../../src/main')
    const callers: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.ts$/.test(name) && /\.onBeforeRequest\(/.test(readFileSync(path, 'utf8')))
          callers.push(relative(main, path))
      }
    }
    walk(main)
    expect(callers).toEqual([join('settings', 'ad-block.ts')])
  })
})

describe('[OB-06] the setting and the sites it is off for', () => {
  const fileIn = () => join(mkdtempSync(join(tmpdir(), 'orbit-ads-')), 'site-prefs.json')

  it('is on by default; settings.update takes a yes or no only', () => {
    expect(DEFAULT_SETTINGS.adBlocking).toBe(true)
    const state = createInitialState(0)
    const draft = structuredClone(state.settings)
    expect(applySettingsPatch(draft, { adBlocking: false }, state)).toEqual([])
    expect(draft.adBlocking).toBe(false)
    expect(applySettingsPatch(draft, { adBlocking: 'no' }, state)).toEqual(['adBlocking'])
    expect(draft.adBlocking).toBe(false)
    // The onboarding step's choice is onboarding's own (onboarding.setAdBlocking).
    expect(applySettingsPatch(draft, { onboardingAdBlocking: true }, state)).toEqual(['onboardingAdBlocking'])
  })

  it('loads a damaged value as on, and keeps the onboarding step’s choice only while onboarding runs', () => {
    const state = createInitialState(0)
    state.settings = {
      ...state.settings,
      adBlocking: 'off',
      onboarded: false,
      onboardingAdBlocking: false,
    } as unknown as Settings
    normalizeSettingsPrefs(state)
    expect(state.settings.adBlocking).toBe(true)
    expect(state.settings.onboardingAdBlocking).toBe(false)
    state.settings.onboarded = true
    normalizeSettingsPrefs(state)
    expect(state.settings).not.toHaveProperty('onboardingAdBlocking')
    state.settings = { ...state.settings, onboarded: false, onboardingAdBlocking: 'yes' } as unknown as Settings
    normalizeSettingsPrefs(state)
    expect(state.settings).not.toHaveProperty('onboardingAdBlocking')
  })

  it('keeps the sites it is off for per profile, and writes them', () => {
    const file = fileIn()
    const prefs = new SitePrefs(file)
    prefs.setAdsAllowed(DEFAULT_PROFILE_ID, 'news.site.test', true)
    prefs.setAdsAllowed('work', 'shop.test', true)
    expect(prefs.adsAllowed(DEFAULT_PROFILE_ID, 'news.site.test')).toBe(true)
    expect(prefs.adsAllowed('work', 'news.site.test')).toBe(false)
    prefs.flush()
    const again = new SitePrefs(file)
    again.load()
    expect(again.adsAllowed(DEFAULT_PROFILE_ID, 'news.site.test')).toBe(true)
    expect(again.adsAllowed('work', 'shop.test')).toBe(true)
    again.setAdsAllowed(DEFAULT_PROFILE_ID, 'news.site.test', false)
    expect(again.adsAllowed(DEFAULT_PROFILE_ID, 'news.site.test')).toBe(false)
  })

  it('forgets them with the profile’s other site choices (Clear browsing data → Site settings)', () => {
    const prefs = new SitePrefs(fileIn())
    prefs.setAdsAllowed(DEFAULT_PROFILE_ID, 'news.site.test', true)
    prefs.setAdsAllowed('work', 'shop.test', true)
    prefs.forgetProfile(DEFAULT_PROFILE_ID)
    expect(prefs.adsAllowed(DEFAULT_PROFILE_ID, 'news.site.test')).toBe(false)
    expect(prefs.adsAllowed('work', 'shop.test')).toBe(true)
  })

  it('keeps a private window’s in memory only', () => {
    const file = fileIn()
    const prefs = new SitePrefs(file)
    prefs.setAdsAllowed('private-1', 'news.site.test', true)
    expect(prefs.adsAllowed('private-1', 'news.site.test')).toBe(true)
    prefs.flush()
    expect(existsSync(file) ? readFileSync(file, 'utf8') : '').not.toContain('news.site.test')
    prefs.forgetPrivate()
    expect(prefs.adsAllowed('private-1', 'news.site.test')).toBe(false)
  })
})
