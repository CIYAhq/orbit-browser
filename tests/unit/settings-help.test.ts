import { describe, expect, it } from 'vitest'
import { rank } from '../../src/main/commandbar/rank'
import { SourceCache } from '../../src/main/commandbar/sources'
import { internalPageMayRun } from '../../src/main/devtools/internal-urls'
import { normalizeState } from '../../src/main/persist'
import { addOrbitBasics, BASICS_FOLDER_NAME } from '../../src/main/settings/basics'
import { archiveHint, sidebarHint } from '../../src/main/settings/hints'
import { normalizeSettingsPrefs } from '../../src/main/settings/normalize'
import { ACTIONS_BY_ID } from '../../src/shared/actions'
import { HELP_PAGE_ACTIONS } from '../../src/shared/commands/settings'
import { createInitialState, DEFAULT_PROFILE_ID, DEFAULT_SITE_SEARCH } from '../../src/shared/defaults'
import { archivePeriodText, HINT_LIMITS, HINT_MS } from '../../src/shared/hints'
import { GUIDE_URL, HELP_URL, WELCOME_URL } from '../../src/shared/project'
import type { ArchivedTab, OrbitState, Settings } from '../../src/shared/state'

const NOW = 1_800_000_000_000

function withSettings(settings: Record<string, unknown>): OrbitState {
  const state = createInitialState(0)
  state.settings = { ...state.settings, ...settings } as unknown as Settings
  return state
}

/** Entries the auto-archive made (only what the hint reads of them). */
function archived(n: number): ArchivedTab[] {
  return Array.from(
    { length: n },
    (_, i) => ({ id: `a-${i}`, profileId: DEFAULT_PROFILE_ID, reason: 'auto' }) as ArchivedTab,
  )
}

describe('[OB-09] the first window’s "Orbit basics" folder', () => {
  it('goes at the top of the pinned section, open, with the guide and Help unloaded and titled', () => {
    const state = createInitialState(0)
    const spaceId = state.spaceOrder[0] as string
    state.spaces[spaceId]?.pinned.push('t-kept')
    const folderId = addOrbitBasics(state, spaceId, NOW) as string
    expect(state.spaces[spaceId]?.pinned).toEqual([folderId, 't-kept'])
    const folder = state.folders[folderId]
    expect(folder).toMatchObject({ name: BASICS_FOLDER_NAME, collapsed: false })
    const tabs = (folder?.children ?? []).map((id) => state.tabs[id])
    expect(tabs.map((t) => [t?.pinnedUrl, t?.url, t?.title, t?.pinnedTitle])).toEqual([
      [GUIDE_URL, GUIDE_URL, 'Getting Started', 'Getting Started'],
      [HELP_URL, HELP_URL, 'Orbit Help', 'Orbit Help'],
    ])
    for (const tab of tabs) {
      expect(tab).toMatchObject({ spaceId, profileId: state.spaces[spaceId]?.profileId, asleep: true, lastActiveAt: 0 })
    }
  })

  it('adds nothing to a Space that is gone', () => {
    const state = createInitialState(0)
    expect(addOrbitBasics(state, 's-gone', NOW)).toBeUndefined()
    expect(state.folders).toEqual({})
    expect(state.tabs).toEqual({})
  })

  it('is kept by a reload of the state file', () => {
    const state = createInitialState(0)
    const spaceId = state.spaceOrder[0] as string
    const folderId = addOrbitBasics(state, spaceId, NOW) as string
    const loaded = normalizeState(JSON.parse(JSON.stringify(state)))
    expect(loaded.spaces[spaceId]?.pinned).toEqual([folderId])
    expect(loaded.folders[folderId]?.children).toHaveLength(2)
  })
})

describe('[OB-10][OB-13] Orbit’s help pages', () => {
  it('are local pages, and their buttons run only a few actions, all of them real', () => {
    for (const url of [HELP_URL, GUIDE_URL, WELCOME_URL]) expect(url.startsWith('orbit://')).toBe(true)
    for (const id of HELP_PAGE_ACTIONS) expect(ACTIONS_BY_ID[id], id).toBeDefined()
    expect(HELP_PAGE_ACTIONS).not.toContain('help.open')
    for (const url of [HELP_URL, GUIDE_URL, WELCOME_URL]) {
      expect(internalPageMayRun(url, 'help.run')).toBe(true)
      expect(internalPageMayRun(url, 'settings.open')).toBe(true)
      for (const other of ['tabs.create', 'tabs.navigate', 'settings.set', 'settings.update', 'action.run']) {
        expect(internalPageMayRun(url, other), `${url} ${other}`).toBe(false)
      }
    }
    expect(internalPageMayRun('orbit://version/', 'help.run')).toBe(false)
  })

  it.each([
    ['Getting started', 'help.gettingStarted'],
    ['guide', 'help.gettingStarted'],
    ['tutorial', 'help.gettingStarted'],
    ['Help', 'help.open'],
    ['Report a bug', 'help.reportBug'],
  ])('the command bar finds "%s" as %s first', (query, id) => {
    const actions = new SourceCache().actions(() => true, 'darwin')
    const rows = rank({
      query,
      mode: 'new-tab',
      now: NOW,
      engine: { name: 'Google', search: 'https://www.google.com/search?q=%s' },
      tabs: [],
      activeTabId: null,
      currentSpaceId: 's-a',
      spaceNames: { 's-a': 'Home' },
      history: [],
      hosts: [],
      archive: [],
      spaces: [{ id: 's-a', name: 'Home', icon: '', nameLower: 'home' }],
      actions,
      siteSearches: DEFAULT_SITE_SEARCH,
    }).results
    expect(rows.find((r) => r.kind === 'action')?.actionId).toBe(id)
  })
})

describe('[OB-11] one-time hints', () => {
  it('stay long enough to read, and each kind shows a few times at most', () => {
    expect(HINT_MS).toBeGreaterThanOrEqual(4000)
    expect(HINT_MS).toBeLessThanOrEqual(6000)
    expect(HINT_LIMITS.archive).toBe(1)
    expect(HINT_LIMITS.sidebar).toBe(3)
  })

  it('say how long Today tabs wait, as Settings offers it', () => {
    expect(archivePeriodText(12 * 3600_000)).toBe('12 hours')
    expect(archivePeriodText(24 * 3600_000)).toBe('24 hours')
    expect(archivePeriodText(3600_000)).toBe('1 hour')
    expect(archivePeriodText(7 * 24 * 3600_000)).toBe('7 days')
    expect(archivePeriodText(30 * 24 * 3600_000)).toBe('30 days')
  })

  it('explain an archive and how to get the tabs back', () => {
    const state = createInitialState(0)
    const one = archiveHint(state, archived(1))
    expect(one.message).toBe(
      'A Today tab you hadn’t used for 12 hours moved to the Archive. You can restore it from there.',
    )
    expect(one.action).toEqual({ label: 'View Archive', command: 'library.open', args: { section: 'archive' } })
    expect(archiveHint(state, archived(3)).message).toBe(
      '3 Today tabs you hadn’t used for 12 hours moved to the Archive. You can restore them from there.',
    )
    // The profile's own period (ST-05), where it has one.
    const profile = state.profiles[DEFAULT_PROFILE_ID]
    if (profile) profile.archiveAfterMs = 7 * 24 * 3600_000
    expect(archiveHint(state, archived(1)).message).toContain('for 7 days')
  })

  it('say how to bring the sidebar back, with its key when it has one', () => {
    expect(sidebarHint('⌘S').message).toBe(
      'The sidebar is hidden. ⌘S brings it back, or point at the window’s left edge.',
    )
    expect(sidebarHint('').message).toBe('The sidebar is hidden. Point at the window’s left edge to see it.')
    expect(sidebarHint('⌘S').action).toEqual({ label: 'Show', command: 'window.setSidebar', args: { visible: true } })
  })

  it('remember whole counts of the kinds there are, no more than each shows', () => {
    const state = withSettings({ hintsShown: { archive: 4, sidebar: 2.5, other: 1, toString: 2 } })
    normalizeSettingsPrefs(state)
    expect(state.settings.hintsShown).toEqual({ archive: 1 })
    for (const bad of [{ archive: 0 }, { sidebar: -1 }, 'archive', null, [1], { sidebar: '2' }]) {
      const s = withSettings({ hintsShown: bad })
      normalizeSettingsPrefs(s)
      expect(s.settings, JSON.stringify(bad)).not.toHaveProperty('hintsShown')
    }
    const fresh = createInitialState(0)
    normalizeSettingsPrefs(fresh)
    expect(fresh.settings).not.toHaveProperty('hintsShown')
  })
})
