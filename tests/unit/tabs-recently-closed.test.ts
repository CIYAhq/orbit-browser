import { describe, expect, it } from 'vitest'
import { closedFor, makeTab } from '../../src/main/tabs/model'
import { createInitialState, createProfile, createSpace, createWindowState } from '../../src/shared/defaults'
import { PRIVATE_PARTITION_PREFIX, PRIVATE_PROFILE_PREFIX } from '../../src/shared/private'
import type { Tab } from '../../src/shared/state'

/** The Recently Closed list a window gets (TB-07, NV-11): its own closed tabs, never another's private ones. */

function world() {
  const state = createInitialState(0)
  const normalSpace = state.spaceOrder[0] as string
  const normal = createWindowState(normalSpace)
  const other = createWindowState(normalSpace)
  // A private window: its own profile (in memory) and its own Space, out of the Space order.
  const profile = createProfile('Private', `${PRIVATE_PROFILE_PREFIX}1`, 0)
  profile.partition = `${PRIVATE_PARTITION_PREFIX}1`
  state.profiles[profile.id] = profile
  const privateSpace = createSpace('Private', profile.id, undefined, '', 0)
  state.spaces[privateSpace.id] = privateSpace
  const priv = createWindowState(privateSpace.id, 'private')
  for (const w of [normal, other, priv]) state.windows[w.id] = w
  const closed = (tab: Tab, at: number) => ({ tab, closedAt: at })
  const page = closed(
    makeTab({ spaceId: normalSpace, profileId: state.spaces[normalSpace]?.profileId ?? '', url: 'https://a.test/' }, 0),
    1,
  )
  const secret = closed(makeTab({ spaceId: privateSpace.id, profileId: profile.id, url: 'https://secret.test/' }, 0), 2)
  return { state, normal, other, priv, page, secret, records: [page, secret] }
}

describe('[TB-07][NV-11] recently closed tabs, per window', () => {
  it('a private window’s closed tab is never returned for a normal window, nor with no window; the private window gets its own', () => {
    const { state, normal, other, priv, page, secret, records } = world()
    expect(closedFor(state, records, normal.id)).toEqual([page])
    expect(closedFor(state, records, other.id)).toEqual([page])
    expect(closedFor(state, records, undefined)).toEqual([page])
    expect(closedFor(state, records, priv.id)).toEqual([secret])
  })

  it('newest first, and a tab that came back is no longer listed', () => {
    const { state, normal, page } = world()
    const later = {
      tab: makeTab({ spaceId: page.tab.spaceId, profileId: page.tab.profileId, url: 'https://b.test/' }, 0),
      closedAt: 3,
    }
    expect(closedFor(state, [page, later], normal.id)).toEqual([later, page])
    state.tabs[later.tab.id] = later.tab
    expect(closedFor(state, [page, later], normal.id)).toEqual([page])
  })

  it('once the private window has gone, its closed tab is listed nowhere', () => {
    const { state, normal, priv, records, page } = world()
    delete state.windows[priv.id]
    for (const w of [normal.id, priv.id, undefined]) expect(closedFor(state, records, w)).toEqual([page])
  })
})
