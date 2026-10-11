import { describe, expect, it } from 'vitest'
import { pinnedExport } from '../../src/main/import/export'
import { type ExportNode, parseBookmarksHtml, writeBookmarksHtml } from '../../src/main/import/netscape'
import type { BookmarkNode } from '../../src/shared/commands/import'
import type { OrbitState } from '../../src/shared/state'

/** A made-up Orbit: two Spaces in the Default profile, one in a private window's profile. */
function sample(): OrbitState {
  const tab = (id: string, url: string, title: string, extra = {}) => [id, { id, url, title, createdAt: 1, ...extra }]
  const pinned = (id: string, url: string, title: string) =>
    tab(id, 'https://elsewhere.example/', 'Now', { pinnedUrl: url, pinnedTitle: title })
  return {
    profiles: {
      'p-default': { id: 'p-default', name: 'Default', partition: 'persist:orbit-p-default', favorites: ['fav'] },
      'private-1': { id: 'private-1', name: 'Private', partition: 'private-1', favorites: ['secret'] },
    },
    spaceOrder: ['s-work', 's-home', 's-private'],
    spaces: {
      's-work': {
        id: 's-work',
        name: 'Work',
        profileId: 'p-default',
        pinned: ['f-team', 'sp'],
        today: ['t-today'],
        createdAt: 2,
      },
      's-home': { id: 's-home', name: 'Home', profileId: 'p-default', pinned: ['settings'], today: [], createdAt: 3 },
      's-private': {
        id: 's-private',
        name: 'Private',
        profileId: 'private-1',
        pinned: ['secret'],
        today: [],
        createdAt: 4,
      },
    },
    folders: {
      'f-team': { id: 'f-team', name: 'Team', children: ['cal', 'f-docs'], createdAt: 5 },
      'f-docs': { id: 'f-docs', name: 'Docs', children: ['plan'], createdAt: 6 },
    },
    splits: {
      sp: {
        id: 'sp',
        layout: {
          type: 'row',
          children: [
            { type: 'leaf', tabId: 'left' },
            { type: 'leaf', tabId: 'right' },
          ],
          sizes: [1, 1],
        },
      },
    },
    tabs: Object.fromEntries([
      pinned('fav', 'https://mail.example.net/', 'Mail'),
      pinned('cal', 'https://example.com/calendar', 'Calendar'),
      pinned('plan', 'https://docs.example.com/plan', 'Plan'),
      pinned('left', 'https://example.com/left', 'Left'),
      tab('right', 'https://example.com/right', 'Right', {
        pinnedUrl: 'https://example.com/right',
        customTitle: 'Renamed',
      }),
      // Orbit's own pages open nowhere else.
      pinned('settings', 'orbit://settings', 'Settings'),
      tab('t-today', 'https://news.example.org/', 'News'),
      pinned('secret', 'https://secret.example/', 'Secret'),
    ]),
  } as unknown as OrbitState
}

/** The file's tree as another browser reads it back: titles and addresses. */
function readBack(nodes: readonly ExportNode[]): unknown[] {
  const shape = (list: readonly BookmarkNode[]): unknown[] =>
    list.map((n) => (n.children ? { [n.title]: shape(n.children) } : `${n.title} <${n.url}>`))
  return shape(parseBookmarksHtml(writeBookmarksHtml(nodes)) ?? [])
}

describe('[IM-17] export pinned items as bookmarks', () => {
  it('Favorites become a folder and each Space another, folders nested as they are; Today left out', () => {
    expect(readBack(pinnedExport(sample()))).toEqual([
      { Favorites: ['Mail <https://mail.example.net/>'] },
      {
        Work: [
          { Team: ['Calendar <https://example.com/calendar>', { Docs: ['Plan <https://docs.example.com/plan>'] }] },
          // A split's tabs, side by side.
          'Left <https://example.com/left>',
          'Renamed <https://example.com/right>',
        ],
      },
      { Home: [] },
    ])
  })

  it('Today’s tabs when asked, in their Space; one profile’s alone', () => {
    const work = readBack(pinnedExport(sample(), { includeToday: true }))[1] as { Work: unknown[] }
    expect(work.Work.at(-1)).toEqual({ Today: ['News <https://news.example.org/>'] })
    const state = sample()
    const other = { id: 'p-other', name: 'Other', partition: 'persist:orbit-p-other', favorites: [] as string[] }
    state.profiles['p-other'] = other as never
    expect(pinnedExport(state, { profileId: 'p-other' })).toEqual([])
    // With several profiles, each one's Favorites say whose.
    other.favorites = ['cal']
    expect(pinnedExport(state).map((n) => n.title)).toEqual([
      'Favorites (Default)',
      'Favorites (Other)',
      'Work',
      'Home',
    ])
  })
})
