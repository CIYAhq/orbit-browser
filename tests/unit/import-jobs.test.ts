import { describe, expect, it } from 'vitest'
import type { MainContext } from '../../src/main/context'
import { ImportJobs } from '../../src/main/import/jobs'
import { Store } from '../../src/main/store'
import type { BookmarkNode, ImportJob, ImportPlan, ImportProgressItem } from '../../src/shared/commands/import'
import { createInitialState } from '../../src/shared/defaults'
import type { OrbitState } from '../../src/shared/state'

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

  it('[F6] an import that fails while its bookmarks are being added takes them all back', async () => {
    const { jobs, spaceId, store } = world()
    // The store's third update fails: two parts of 250 are in by then.
    const update = store.update.bind(store)
    let updates = 0
    let inBeforeFailing = 0
    store.update = ((fn: Parameters<Store['update']>[0]) => {
      if (++updates === 3) {
        inBeforeFailing = importedTabs(store.state).length
        throw new Error('The disk is full')
      }
      return update(fn)
    }) as Store['update']
    const id = startFile(jobs, spaceId, bookmarks(2000))
    const status = await ended(jobs, id)
    expect(inBeforeFailing).toBeGreaterThan(0)
    expect(status.phase).toBe('failed')
    expect(importedTabs(store.state)).toEqual([])
    expect(Object.values(store.state.folders).map((f) => f.name)).toEqual([])
  })
})
