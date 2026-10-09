import { describe, expect, it } from 'vitest'
import {
  assignProfileInDraft,
  createProfileInDraft,
  createSpaceInDraft,
  deleteProfileInDraft,
  deleteSpaceInDraft,
  MAX_ARCHIVE,
  neighbourSpace,
  normalizeSpacesInDraft,
  placeholderName,
  renameSpaceInDraft,
  reorderSpaceInDraft,
  restoreSpaceInDraft,
  switchSpaceInDraft,
} from '../../src/main/spaces/model'
import { makeTab } from '../../src/main/tabs/model'
import { createInitialState, createWindowState, DEFAULT_PROFILE_ID, THEME_PRESETS } from '../../src/shared/defaults'
import type { OrbitState } from '../../src/shared/state'

function world() {
  const state = createInitialState(0)
  const a = state.spaceOrder[0] as string
  const win = createWindowState(a)
  state.windows[win.id] = win
  const addTab = (spaceId: string, where: 'today' | 'pinned' | 'favorites', url = 'https://x.test/') => {
    const space = state.spaces[spaceId]
    const tab = makeTab({ spaceId, profileId: space?.profileId ?? DEFAULT_PROFILE_ID, url })
    state.tabs[tab.id] = tab
    if (where === 'favorites') state.profiles[space?.profileId ?? DEFAULT_PROFILE_ID]?.favorites.push(tab.id)
    else space?.[where].push(tab.id)
    return tab.id
  }
  return { state, a, win: win.id, addTab }
}

const names = (s: OrbitState) => s.spaceOrder.map((id) => s.spaces[id]?.name)

describe('[SP-01][PR-01] initial state', () => {
  it('a fresh install has one Space on the Default profile', () => {
    const s = createInitialState(0)
    expect(s.spaceOrder).toHaveLength(1)
    expect(Object.values(s.profiles).map((p) => p.name)).toEqual(['Default'])
    expect(s.spaces[s.spaceOrder[0] as string]?.profileId).toBe(DEFAULT_PROFILE_ID)
  })
})

describe('[SP-02] create a Space', () => {
  it('inserts the new Space right after the active one, not at the end', () => {
    const { state, a } = world()
    const b = createSpaceInDraft(state, { name: 'B', afterSpaceId: a })
    const c = createSpaceInDraft(state, { name: 'C', afterSpaceId: b.id })
    createSpaceInDraft(state, { name: 'D', afterSpaceId: b.id })
    expect(names(state)).toEqual(['Personal', 'B', 'D', 'C'])
    expect(c.pinned).toEqual([])
    expect(c.today).toEqual([])
  })

  it('unnamed Spaces get a "Space N" placeholder and rotate through the colour presets', () => {
    const { state, a } = world()
    const s2 = createSpaceInDraft(state, { afterSpaceId: a })
    expect(s2.name).toBe('Space 2')
    expect(s2.unnamed).toBe(true)
    expect(s2.theme).toEqual(THEME_PRESETS[1])
    const s3 = createSpaceInDraft(state, { afterSpaceId: s2.id })
    expect(s3.name).toBe('Space 3')
    expect(placeholderName(state, 2)).toBe('Space 4')
  })

  it('defaults to the neighbour Space’s profile (PR-04 preselection)', () => {
    const { state, a } = world()
    const work = createProfileInDraft(state, 'Work')
    state.spaces[a]!.profileId = work.id
    expect(createSpaceInDraft(state, { afterSpaceId: a }).profileId).toBe(work.id)
    expect(createSpaceInDraft(state, { afterSpaceId: a, profileId: DEFAULT_PROFILE_ID }).profileId).toBe(
      DEFAULT_PROFILE_ID,
    )
  })
})

describe('[SP-03] rename a Space', () => {
  it('trims names and restores the placeholder when cleared', () => {
    const { state, a } = world()
    const b = createSpaceInDraft(state, { name: 'Work', afterSpaceId: a })
    renameSpaceInDraft(state, b.id, '  Research   notes ')
    expect(state.spaces[b.id]?.name).toBe('Research notes')
    renameSpaceInDraft(state, b.id, '   ')
    expect(state.spaces[b.id]?.name).toBe('Space 2')
    expect(state.spaces[b.id]?.unnamed).toBe(true)
    renameSpaceInDraft(state, b.id, 'Trip')
    expect(state.spaces[b.id]?.unnamed).toBeUndefined()
  })
})

describe('[SP-09][SP-11] order and stepping', () => {
  it('steps without wrapping and reorders while keeping the active Space', () => {
    const { state, a, win } = world()
    const b = createSpaceInDraft(state, { name: 'B', afterSpaceId: a })
    const c = createSpaceInDraft(state, { name: 'C', afterSpaceId: b.id })
    expect(neighbourSpace(state, a, -1)).toBeUndefined()
    expect(neighbourSpace(state, a, 1)).toBe(b.id)
    expect(neighbourSpace(state, c.id, 1)).toBeUndefined()
    switchSpaceInDraft(state, win, b.id)
    reorderSpaceInDraft(state, c.id, 0)
    expect(names(state)).toEqual(['C', 'Personal', 'B'])
    expect(state.windows[win]?.spaceId).toBe(b.id)
    expect(switchSpaceInDraft(state, win, b.id)).toBe(false)
  })
})

describe('[SP-10][SP-23] switching', () => {
  it('each window keeps its own active Space and its remembered tab per Space', () => {
    const { state, a, win, addTab } = world()
    const b = createSpaceInDraft(state, { name: 'B', afterSpaceId: a })
    const win2 = createWindowState(a)
    state.windows[win2.id] = win2
    const t1 = addTab(a, 'today')
    state.windows[win]!.activeTab[a] = t1
    switchSpaceInDraft(state, win, b.id)
    expect(state.windows[win]?.spaceId).toBe(b.id)
    expect(state.windows[win2.id]?.spaceId).toBe(a)
    switchSpaceInDraft(state, win, a)
    expect(state.windows[win]?.activeTab[a]).toBe(t1)
  })
})

describe('[SP-23][TB-17] Spaces across windows', () => {
  it('switching Space never leaves two windows on the same tab (the switching window keeps it)', () => {
    const { state, a, win, addTab } = world()
    const b = createSpaceInDraft(state, { name: 'B', afterSpaceId: a })
    const t1 = addTab(a, 'today')
    const t2 = addTab(a, 'today')
    state.windows[win]!.activeTab[a] = t1
    switchSpaceInDraft(state, win, b.id)
    // A second window shows t1 while the first one is away on B.
    const w2 = createWindowState(a)
    w2.activeTab[a] = t1
    state.windows[w2.id] = w2
    switchSpaceInDraft(state, win, a)
    expect(state.windows[win]?.activeTab[a]).toBe(t1)
    expect(state.windows[w2.id]?.activeTab[a]).toBe(t2)
  })
})

describe('[SP-12] delete a Space', () => {
  it('archives its tabs tagged with its name, moves windows to the left neighbour and keeps the profile', () => {
    const { state, a, win, addTab } = world()
    const b = createSpaceInDraft(state, { name: 'Trip planning', afterSpaceId: a })
    const c = createSpaceInDraft(state, { name: 'C', afterSpaceId: b.id })
    const t1 = addTab(b.id, 'today', 'https://one.test/')
    addTab(b.id, 'pinned', 'https://two.test/')
    addTab(b.id, 'today', 'about:blank')
    state.folders['f-1'] = { id: 'f-1', name: 'F', children: [], collapsed: false, createdAt: 0 }
    state.spaces[b.id]!.pinned.push('f-1')
    const nested = addTab(b.id, 'today', 'https://three.test/')
    state.spaces[b.id]!.today = state.spaces[b.id]!.today.filter((id) => id !== nested)
    state.folders['f-1']!.children.push(nested)
    switchSpaceInDraft(state, win, b.id)
    state.windows[win]!.activeTab[b.id] = t1
    state.archive.push({
      id: 'a-old',
      url: 'https://old.test/',
      title: 'old',
      spaceId: a,
      profileId: DEFAULT_PROFILE_ID,
      archivedAt: 0,
      reason: 'closed',
    })

    const deleted = deleteSpaceInDraft(state, b.id, 100)
    expect(deleted).toBeDefined()
    expect(names(state)).toEqual(['Personal', 'C'])
    expect(state.windows[win]?.spaceId).toBe(a)
    expect(state.windows[win]?.activeTab[b.id]).toBeUndefined()
    expect(Object.keys(state.tabs)).toHaveLength(0)
    expect(state.folders['f-1']).toBeUndefined()
    // Appended after existing entries (review F2), tagged with the Space's name.
    expect(state.archive[0]?.id).toBe('a-old')
    expect(state.archive.slice(1).map((e) => e.url)).toEqual([
      'https://two.test/',
      'https://three.test/',
      'https://one.test/',
    ])
    expect(state.archive.slice(1).every((e) => e.spaceName === 'Trip planning' && e.reason === 'closed')).toBe(true)
    expect(state.profiles[DEFAULT_PROFILE_ID]).toBeDefined()

    // Undo restores the whole Space where it was, and removes the archive entries again.
    expect(restoreSpaceInDraft(state, deleted!, win)).toBe(true)
    expect(names(state)).toEqual(['Personal', 'Trip planning', 'C'])
    expect(state.spaces[b.id]?.today).toContain(t1)
    expect(state.folders['f-1']?.children).toEqual([nested])
    expect(state.tabs[t1]?.asleep).toBe(true)
    expect(state.archive.map((e) => e.id)).toEqual(['a-old'])
    expect(state.windows[win]?.spaceId).toBe(b.id)
    expect(state.windows[win]?.activeTab[b.id]).toBe(t1)
    expect(restoreSpaceInDraft(state, deleted!, win)).toBe(false)
    expect(c.id in state.spaces).toBe(true)
  })

  it('the first Space falls back to the right neighbour, and the last Space cannot be deleted', () => {
    const { state, a, win } = world()
    expect(deleteSpaceInDraft(state, a)).toBeUndefined()
    const b = createSpaceInDraft(state, { name: 'B', afterSpaceId: a })
    expect(deleteSpaceInDraft(state, a)).toBeDefined()
    expect(state.windows[win]?.spaceId).toBe(b.id)
  })

  it('caps the archive by trimming the oldest entries in chunks', () => {
    const { state, a, addTab } = world()
    const b = createSpaceInDraft(state, { name: 'B', afterSpaceId: a })
    for (let i = 0; i < MAX_ARCHIVE + 500; i++) {
      state.archive.push({
        id: `a-${i}`,
        url: `https://x${i}.test/`,
        title: '',
        spaceId: a,
        profileId: DEFAULT_PROFILE_ID,
        archivedAt: i,
        reason: 'closed',
      })
    }
    addTab(b.id, 'today', 'https://new.test/')
    deleteSpaceInDraft(state, b.id)
    expect(state.archive.length).toBe(MAX_ARCHIVE)
    expect(state.archive.at(-1)?.url).toBe('https://new.test/')
    expect(state.archive[0]?.id).toBe('a-501')
  })
})

describe('[PR-02][PR-03][PR-05][PR-06] profiles', () => {
  it('assigning a profile moves the Space’s tabs (to reload) and keeps name, icon and theme', () => {
    const { state, a, addTab } = world()
    const space = state.spaces[a]!
    space.icon = '🚀'
    const pinned = addTab(a, 'pinned')
    const today = addTab(a, 'today')
    const fav = addTab(a, 'favorites')
    const work = createProfileInDraft(state, '  Work ')
    expect(work.name).toBe('Work')
    expect(work.partition).toBe(`persist:orbit-${work.id}`)
    expect(work.favorites).toEqual([])
    const moved = assignProfileInDraft(state, a, work.id)
    expect(moved.sort()).toEqual([pinned, today].sort())
    expect(state.tabs[pinned]?.profileId).toBe(work.id)
    // Favorites belong to the profile, not the Space.
    expect(state.tabs[fav]?.profileId).toBe(DEFAULT_PROFILE_ID)
    expect(state.profiles[DEFAULT_PROFILE_ID]?.favorites).toEqual([fav])
    expect(space.name).toBe('Personal')
    expect(space.icon).toBe('🚀')
    expect(assignProfileInDraft(state, a, work.id)).toEqual([])
  })

  it('[PR-08] a profile is deleted only when no Space uses it, and its Favorites go with it (review F1)', () => {
    const { state, a, win, addTab } = world()
    const work = createProfileInDraft(state, 'Work')
    const b = createSpaceInDraft(state, { name: 'B', afterSpaceId: a, profileId: work.id })
    const t = addTab(b.id, 'today')
    const fav = addTab(b.id, 'favorites')
    state.windows[win]!.activeTab[b.id] = fav
    expect(deleteProfileInDraft(state, DEFAULT_PROFILE_ID)).toBeUndefined()
    // In use by Space B: refused, nothing changes.
    expect(deleteProfileInDraft(state, work.id)).toBeUndefined()
    expect(state.profiles[work.id]).toBeDefined()
    // Reassign B, then delete: the profile and its Favorites are gone; B's tabs stay.
    assignProfileInDraft(state, b.id, DEFAULT_PROFILE_ID)
    expect(deleteProfileInDraft(state, work.id)?.removed).toEqual([fav])
    expect(state.profiles[work.id]).toBeUndefined()
    expect(state.tabs[fav]).toBeUndefined()
    expect(state.tabs[t]?.profileId).toBe(DEFAULT_PROFILE_ID)
    expect(state.profiles[DEFAULT_PROFILE_ID]?.favorites).not.toContain(fav)
    expect(state.windows[win]?.activeTab[b.id]).toBeNull()
  })
})

describe('[SP-15] normalization of stored Spaces', () => {
  it('upgrades old themes, fills missing names and fixes unknown profiles', () => {
    const { state, a } = world()
    const space = state.spaces[a] as unknown as Record<string, unknown>
    space.theme = { color: '#ff7a59', mode: 'dark' }
    space.name = ''
    space.profileId = 'p-gone'
    normalizeSpacesInDraft(state)
    expect(state.spaces[a]?.theme).toEqual({ colors: ['#ff7a59'], intensity: 0.6, grain: 0 })
    expect(state.spaces[a]?.name).toBe('Space 1')
    expect(state.spaces[a]?.unnamed).toBe(true)
    expect(state.spaces[a]?.profileId).toBe(DEFAULT_PROFILE_ID)
  })
})
