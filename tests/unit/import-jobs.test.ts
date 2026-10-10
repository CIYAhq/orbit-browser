import { describe, expect, it } from 'vitest'
import { provideSidebarUndo } from '../../src/main/archive/inbox'
import type { MainContext } from '../../src/main/context'
import { IMPORT_UNDO_LABEL, ImportJobs } from '../../src/main/import/jobs'
import { Store } from '../../src/main/store'
import { makeTab } from '../../src/main/tabs/model'
import { UndoStack } from '../../src/main/tabs/undo'
import type { BookmarkNode, ImportJob, ImportPlan, ImportProgressItem } from '../../src/shared/commands/import'
import { createInitialState, createProfile, createSpace } from '../../src/shared/defaults'
import type { ContainerRef, OrbitState } from '../../src/shared/state'
import { insertItem, removeItem } from '../../src/shared/tree'

/** Imports as ImportJobs runs them, against a real store and no windows. */
function world() {
  const store = new Store(createInitialState(0))
  const ctx = {
    store,
    windows: { broadcast: () => {} },
    commands: { run: async () => undefined },
    tabs: { destroy: () => {} },
  } as unknown as MainContext
  const jobs = new ImportJobs(ctx)
  const spaceId = store.state.spaceOrder[0] as string
  return { store, jobs, spaceId }
}

const bookmarks = (n: number): BookmarkNode[] => [
  {
    id: 'f',
    title: 'Many',
    children: Array.from({ length: n }, (_, i) => ({
      id: `b${i}`,
      title: `Page ${i + 1}`,
      url: `https://example.com/p${i + 1}`,
    })),
  },
]

/** A file import of `nodes` into the first Space. */
function startFile(jobs: ImportJobs, spaceId: string, nodes: BookmarkNode[]): string {
  const plan: ImportPlan = { kind: 'file', name: 'many.html', bookmarks: nodes, target: { kind: 'space', spaceId } }
  const item: ImportProgressItem = { type: 'bookmarks', state: 'waiting', done: 0 }
  return jobs.start(
    plan,
    'many.html',
    'Imported bookmarks',
    [
      {
        item,
        read: async (job) => {
          job.bookmarks.set('', [{ title: '', nodes }])
        },
        add: (job) => jobs.addBookmarks(job, item),
      },
    ],
    {},
  )
}

async function ended(jobs: ImportJobs, id: string): Promise<ImportJob> {
  for (let i = 0; i < 2000; i++) {
    const status = jobs.status(id)
    if (status?.stats && status.phase !== 'adding') return status
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('The import never ended')
}

const importedTabs = (s: OrbitState) =>
  Object.values(s.tabs).filter((t) => t.pinnedUrl?.startsWith('https://example.com/'))

describe('[IM-14] imports, run', () => {
  it('[F8] an import that has ended keeps only its status: its plan and the bookmarks read are let go', async () => {
    const { jobs, spaceId, store } = world()
    const id = startFile(jobs, spaceId, bookmarks(10))
    expect(jobs.get(id)?.plan.kind).toBe('file')
    const status = await ended(jobs, id)
    expect(status.phase).toBe('done')
    expect(importedTabs(store.state)).toHaveLength(10)
    // Running imports are the only ones kept whole; Done still finds the folder it made.
    expect(jobs.get(id)).toBeUndefined()
    expect(jobs.status(id)).toBe(status)
    expect(jobs.status()).toBe(status)
    expect(status.folders).toHaveLength(1)
  })

  it('[F6][D62] an import that fails part-way leaves nothing of its own and every tab of the user’s, moved in or not', async () => {
    const { jobs, spaceId, store } = world()
    const update = store.update.bind(store)
    // Two pinned tabs of the user's.
    const mine: string[] = []
    update((d) => {
      for (const url of ['https://example.org/mine-1', 'https://example.org/mine-2']) {
        const profileId = d.spaces[spaceId]?.profileId as string
        const tab = makeTab({ spaceId, profileId, url, pinnedUrl: url, pinnedResolvedUrl: url }, 0)
        d.tabs[tab.id] = tab
        insertItem(d, { kind: 'pinned', spaceId }, mine.length, tab.id)
        mine.push(tab.id)
      }
    })
    const moveTo = (d: OrbitState, id: string, to: ContainerRef) => {
      removeItem(d, id)
      insertItem(d, to, 0, id)
    }
    // 2,000 bookmarks in two folders. Once 500 are made, the store's next update fails ("The disk is full"). Just
    // before, the user moves what the sidebar shows of the import: a tab of theirs into its folder, another into
    // its first sub-folder, and its last sub-folder (the one being filled) out to the pinned section.
    const nodes = bookmarks(2000)
    const many = nodes[0]?.children ?? []
    const twoFolders: BookmarkNode[] = [
      { id: 'a', title: 'A', children: many.slice(0, 300) },
      { id: 'b', title: 'B', children: many.slice(300) },
    ]
    let id = ''
    let failed = false
    let shown: string | undefined
    store.update = ((fn: Parameters<Store['update']>[0]) => {
      const made = id ? (jobs.status(id)?.items[0]?.done ?? 0) : 0
      if (!failed && made >= 500) {
        failed = true
        const s = store.state
        const root = s.spaces[spaceId]?.pinned.find((x) => s.folders[x]?.name === 'Imported bookmarks')
        if (root) {
          const subs = (s.folders[root]?.children ?? []).filter((x) => s.folders[x])
          shown = `${subs.length} sub-folders, the last holding ${s.folders[subs.at(-1) as string]?.children.length}`
          update((d) => {
            moveTo(d, mine[0] as string, { kind: 'folder', folderId: root })
            moveTo(d, mine[1] as string, { kind: 'folder', folderId: subs[0] as string })
            moveTo(d, subs.at(-1) as string, { kind: 'pinned', spaceId })
          })
        }
        throw new Error('The disk is full')
      }
      return update(fn)
    }) as Store['update']
    id = startFile(jobs, spaceId, twoFolders)
    const status = await ended(jobs, id)
    expect(failed).toBe(true)
    expect(status.phase).toBe('failed')
    // Every tab of the user's is there, pinned in its Space.
    const s = store.state
    expect(mine.map((t) => s.tabs[t]?.pinnedUrl)).toEqual(['https://example.org/mine-1', 'https://example.org/mine-2'])
    const pinned = (ids: readonly string[]): string[] =>
      ids.flatMap((x) => [x, ...pinned(s.folders[x]?.children ?? [])])
    expect(pinned(s.spaces[spaceId]?.pinned ?? [])).toEqual(expect.arrayContaining(mine))
    // Nothing of the import: no tab, and no folder anywhere, part-filled or not.
    expect(importedTabs(s)).toEqual([])
    expect(Object.values(s.folders).map((f) => `${f.name} (${f.children.length})`)).toEqual([])
    // The sidebar showed none of it before it failed: it was made out of sight (D62 (3)).
    expect(shown).toBeUndefined()
  })

  it('[TB-18][D62] an import into two Spaces goes back in one undo step, and redo puts all of it back', async () => {
    const store = new Store(createInitialState(0))
    // 'matching': a profile and a Space for each source profile (IM-06), made as the commands would.
    const run = async (name: string, args: { name: string; profileId?: string }) => {
      let id = ''
      store.update((d) => {
        if (name === 'profiles.create') {
          const profile = createProfile(args.name)
          d.profiles[profile.id] = profile
          id = profile.id
        } else if (name === 'spaces.create') {
          const space = createSpace(args.name, args.profileId as string)
          d.spaces[space.id] = space
          d.spaceOrder.push(space.id)
          id = space.id
        }
      })
      return id
    }
    const ctx = {
      store,
      windows: { broadcast: () => {} },
      commands: { run },
      tabs: { destroy: () => {} },
    } as unknown as MainContext
    const stack = new UndoStack()
    provideSidebarUndo(stack)
    try {
      const jobs = new ImportJobs(ctx)
      const item: ImportProgressItem = { type: 'bookmarks', state: 'waiting', done: 0 }
      const plan: ImportPlan = { kind: 'browser', sourceId: 'x', profiles: [], target: { kind: 'matching' } }
      const id = jobs.start(
        plan,
        'A browser',
        'Imported from A browser',
        [
          {
            item,
            read: async (job) => {
              job.bookmarks.set('work', [{ title: '', nodes: bookmarks(3) }])
              job.bookmarks.set('home', [{ title: '', nodes: bookmarks(2) }])
            },
            add: (job) => jobs.addBookmarks(job, item),
          },
        ],
        {},
        new Map([
          ['work', 'Work'],
          ['home', 'Home'],
        ]),
      )
      const status = await ended(jobs, id)
      expect(status.phase).toBe('done')
      const inSpaces = () =>
        status.folders.map((f) => store.state.spaces[f.spaceId]?.pinned.includes(f.folderId) ?? false)
      expect(status.folders).toHaveLength(2)
      expect(inSpaces()).toEqual([true, true])
      expect(importedTabs(store.state)).toHaveLength(5)
      expect(stack.undo()).toBe(IMPORT_UNDO_LABEL)
      expect(importedTabs(store.state)).toEqual([])
      expect(Object.keys(store.state.folders)).toEqual([])
      expect(stack.undo()).toBeUndefined()
      expect(stack.redo()).toBe(IMPORT_UNDO_LABEL)
      expect(inSpaces()).toEqual([true, true])
      expect(importedTabs(store.state)).toHaveLength(5)
    } finally {
      provideSidebarUndo(undefined)
    }
  })
})
