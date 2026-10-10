import { describe, expect, it } from 'vitest'
import { normalizeSettingsPrefs } from '../../src/main/settings/normalize'
import { checkSiteSearch } from '../../src/main/settings/search'
import { createInitialState, createProfile, DEFAULT_PROFILE_ID, DEFAULT_SITE_SEARCH } from '../../src/shared/defaults'
import type { OrbitState } from '../../src/shared/state'
import { engineFor, engineForSpace, parseInput, siteEngineId } from '../../src/shared/url'

function withWork(): { state: OrbitState; work: string } {
  const state = createInitialState(0)
  const work = createProfile('Work', 'p-work', 1)
  state.profiles[work.id] = work
  return { state, work: work.id }
}

describe('[ST-06] custom search engines', () => {
  const sites = DEFAULT_SITE_SEARCH
  const check = (draft: Record<string, unknown>) => checkSiteSearch(draft, sites)

  it('takes a name, a keyword and a results address with %s', () => {
    expect(check({ name: ' Docs ', keyword: 'dx', url: 'https://docs.example/search?q=%s' })).toEqual({
      ok: true,
      value: { name: 'Docs', keyword: 'dx', url: 'https://docs.example/search?q=%s' },
    })
  })

  it('says which field is wrong', () => {
    expect(check({ name: '', keyword: 'dx', url: 'https://a.example/?q=%s' })).toMatchObject({ field: 'name' })
    expect(check({ name: 'A', keyword: 'd x', url: 'https://a.example/?q=%s' })).toMatchObject({ field: 'keyword' })
    expect(check({ name: 'A', keyword: 'dx', url: 'https://a.example/?q=' })).toMatchObject({
      field: 'url',
      message: 'Put %s where the search words go',
    })
    for (const url of ['javascript:alert(%s)', 'file:///%s', 'example.com/?q=%s', 'https://%s']) {
      expect(check({ name: 'A', keyword: 'dx', url })).toMatchObject({ ok: false, field: 'url' })
    }
  })

  it('keeps keywords unique, ignoring case, except for the engine being edited', () => {
    expect(check({ name: 'Tube', keyword: 'YT', url: 'https://t.example/?q=%s' })).toEqual({
      ok: false,
      field: 'keyword',
      message: 'YouTube already uses “yt”',
    })
    expect(check({ id: 'youtube', name: 'YouTube', keyword: 'yt', url: 'https://t.example/?q=%s' }).ok).toBe(true)
  })
})

describe('[ST-06][ST-20] default search engine per profile', () => {
  it('is Google until chosen', () => {
    const { state, work } = withWork()
    expect(engineFor(state, DEFAULT_PROFILE_ID).id).toBe('google')
    expect(engineFor(state, work).id).toBe('google')
  })

  it("follows the profile's own choice, else the Default profile's", () => {
    const { state, work } = withWork()
    const defaultProfile = state.profiles[DEFAULT_PROFILE_ID]
    if (!defaultProfile) throw new Error('no Default profile')
    defaultProfile.searchEngine = 'duckduckgo'
    expect(engineFor(state, work).id).toBe('duckduckgo')
    const workProfile = state.profiles[work]
    if (!workProfile) throw new Error('no Work profile')
    workProfile.searchEngine = 'bing'
    expect(engineFor(state, work).name).toBe('Bing')
    expect(engineFor(state, DEFAULT_PROFILE_ID).name).toBe('DuckDuckGo')
  })

  it('can be a site search, and queries typed in a Space go to its profile’s engine', () => {
    const { state } = withWork()
    const spaceId = state.spaceOrder[0] as string
    const defaultProfile = state.profiles[DEFAULT_PROFILE_ID]
    if (!defaultProfile) throw new Error('no Default profile')
    defaultProfile.searchEngine = siteEngineId('wikipedia')
    const engine = engineForSpace(state, spaceId)
    expect(engine.name).toBe('Wikipedia')
    expect(parseInput('orbit browser', engine).url).toBe('https://en.wikipedia.org/w/index.php?search=orbit+browser')
    expect(parseInput('example.com', engine).url).toBe('https://example.com/')
  })

  it('falls back when its engine is gone, and loading state drops what no longer exists', () => {
    const { state, work } = withWork()
    const workProfile = state.profiles[work]
    if (!workProfile) throw new Error('no Work profile')
    workProfile.searchEngine = siteEngineId('gone')
    expect(engineFor(state, work).id).toBe('google')
    ;(state.settings as { searchEngine: string }).searchEngine = 'altavista'
    const defaultProfile = state.profiles[DEFAULT_PROFILE_ID]
    if (!defaultProfile) throw new Error('no Default profile')
    defaultProfile.searchEngine = siteEngineId('github')
    normalizeSettingsPrefs(state)
    expect(state.settings.searchEngine).toBe('google')
    expect(workProfile).not.toHaveProperty('searchEngine')
    expect(defaultProfile.searchEngine).toBe('site:github')
  })
})
