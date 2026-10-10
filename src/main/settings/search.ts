import type { SiteSearchDraft, SiteSearchSaved } from '../../shared/commands/settings'
import { DEFAULT_PROFILE_ID } from '../../shared/defaults'
import type { OrbitState, SiteSearchEngine } from '../../shared/state'
import { engineById, isBuiltInEngine, siteEngineId } from '../../shared/url'
import type { MainContext } from '../context'

const MAX_NAME = 60
const MAX_KEYWORD = 32
const MAX_URL = 2048

/**
 * Checks a custom search engine (ST-06) before it joins the site searches: a name, a keyword of
 * its own without spaces, and a web address with %s where the query goes.
 */
export function checkSiteSearch(
  draft: unknown,
  existing: readonly SiteSearchEngine[],
): { ok: true; value: Omit<SiteSearchEngine, 'id'> } | Extract<SiteSearchSaved, { ok: false }> {
  const d = (typeof draft === 'object' && draft !== null ? draft : {}) as Partial<SiteSearchDraft>
  const name = typeof d.name === 'string' ? d.name.trim() : ''
  const keyword = typeof d.keyword === 'string' ? d.keyword.trim() : ''
  const url = typeof d.url === 'string' ? d.url.trim() : ''
  if (!name) return { ok: false, field: 'name', message: 'Enter a name' }
  if (name.length > MAX_NAME) return { ok: false, field: 'name', message: `Use at most ${MAX_NAME} characters` }
  if (!keyword) return { ok: false, field: 'keyword', message: 'Enter a keyword' }
  if (/\s/.test(keyword)) return { ok: false, field: 'keyword', message: 'A keyword has no spaces' }
  if (keyword.length > MAX_KEYWORD) {
    return { ok: false, field: 'keyword', message: `Use at most ${MAX_KEYWORD} characters` }
  }
  const taken = existing.find((s) => s.id !== d.id && s.keyword.toLowerCase() === keyword.toLowerCase())
  if (taken) return { ok: false, field: 'keyword', message: `${taken.name} already uses “${taken.keyword}”` }
  if (!url) return { ok: false, field: 'url', message: 'Enter the address of the results page' }
  if (url.length > MAX_URL) return { ok: false, field: 'url', message: 'That address is too long' }
  if (!url.includes('%s')) return { ok: false, field: 'url', message: 'Put %s where the search words go' }
  let parsed: URL | undefined
  try {
    parsed = new URL(url.replaceAll('%s', 'orbitquery'))
  } catch {
    parsed = undefined
  }
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !parsed.hostname) {
    return { ok: false, field: 'url', message: 'Enter a web address starting with https://' }
  }
  if (parsed.host.includes('orbitquery')) {
    return { ok: false, field: 'url', message: 'Put %s after the site’s address' }
  }
  return { ok: true, value: { name, keyword, url } }
}

/** Whether a profile can have settings of its own: private windows' in-memory profiles can't. */
export function isPersistentProfile(state: OrbitState, profileId: string): boolean {
  return !!state.profiles[profileId]?.partition.startsWith('persist:')
}

/** A new site search id (the starter ones use readable ids such as "youtube"). */
function newSiteSearchId(existing: readonly SiteSearchEngine[]): string {
  for (;;) {
    const id = `custom-${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`
    if (!existing.some((s) => s.id === id)) return id
  }
}

/** Default search engines and custom engines (ST-06). */
export function registerSearchSettings(ctx: MainContext): void {
  const { store, commands } = ctx

  commands.register('settings.setSearchEngine', ({ profileId, engine }) => {
    const state = store.state
    if (typeof profileId !== 'string' || !isPersistentProfile(state, profileId)) return
    if (typeof engine !== 'string' || !engineById(state, engine)) return
    store.update((d) => {
      const profile = d.profiles[profileId]
      if (!profile) return
      if (profile.searchEngine !== engine) profile.searchEngine = engine
      // The global setting follows the Default profile's built-in choice: it is the fallback for
      // anything that has no profile to go by.
      if (profileId === DEFAULT_PROFILE_ID && isBuiltInEngine(engine) && d.settings.searchEngine !== engine) {
        d.settings.searchEngine = engine
      }
    })
  })

  commands.register('settings.saveSiteSearch', (draft): SiteSearchSaved => {
    const sites = store.state.settings.siteSearch ?? []
    const checked = checkSiteSearch(draft, sites)
    if (!checked.ok) return checked
    const editing = typeof draft?.id === 'string' ? sites.find((s) => s.id === draft.id) : undefined
    if (typeof draft?.id === 'string' && !editing) return { ok: false, field: 'name', message: 'That engine is gone' }
    const id = editing?.id ?? newSiteSearchId(sites)
    store.update((d) => {
      const list = d.settings.siteSearch
      const at = list.findIndex((s) => s.id === id)
      if (at >= 0) list[at] = { id, ...checked.value }
      else list.push({ id, ...checked.value })
    })
    return { ok: true, id }
  })

  commands.register('settings.removeSiteSearch', ({ id }) => {
    if (!(store.state.settings.siteSearch ?? []).some((s) => s.id === id)) return
    const engine = siteEngineId(id)
    store.update((d) => {
      d.settings.siteSearch = d.settings.siteSearch.filter((s) => s.id !== id)
      // Profiles that searched with it go back to the Default profile's engine (or Google).
      for (const p of Object.values(d.profiles)) if (p.searchEngine === engine) delete p.searchEngine
    })
  })
}
