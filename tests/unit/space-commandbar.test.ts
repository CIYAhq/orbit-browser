import { describe, expect, it } from 'vitest'
import { type RankInput, rank } from '../../src/main/commandbar/rank'
import { SourceCache } from '../../src/main/commandbar/sources'
import { DEFAULT_SITE_SEARCH } from '../../src/shared/defaults'

/** The Space actions the command bar offers (SP-22). */

function input(query: string): RankInput {
  return {
    query,
    mode: 'new-tab',
    now: 0,
    engine: { name: 'Google', search: 'https://www.google.com/search?q=%s' },
    tabs: [],
    activeTabId: null,
    currentSpaceId: 's-a',
    spaceNames: { 's-a': 'Home' },
    history: [],
    hosts: [],
    archive: [],
    spaces: [{ id: 's-a', name: 'Home', icon: '', nameLower: 'home' }],
    actions: new SourceCache().actions(() => true, 'darwin'),
    siteSearches: DEFAULT_SITE_SEARCH,
  }
}

describe('Space actions in the command bar (SP-22)', () => {
  it('[SP-22] "Select Next Space" and "Select Previous Space" find the Space switches, top of the list', () => {
    expect(rank(input('select next space')).results[0]).toMatchObject({ kind: 'action', actionId: 'space.next' })
    expect(rank(input('select previous space')).results[0]).toMatchObject({
      kind: 'action',
      actionId: 'space.previous',
    })
  })
})
