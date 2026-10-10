import { describe, expect, it } from 'vitest'
import { type ArchiveFilters, ArchiveListModel, PAGE_SIZE } from '../../src/renderer/src/library/archive-model'
import type { ArchivePage, ArchiveQuery } from '../../src/shared/commands/archive'

/** A fake `archive.query`: `total` rows named by offset; answers wait until released. */
function fakeArchive(total: number) {
  let version = 1
  const calls: ArchiveQuery[] = []
  const pending: (() => void)[] = []
  let hold = false
  const answer = (q: ArchiveQuery): ArchivePage => {
    const offset = q.offset ?? 0
    const limit = q.limit ?? PAGE_SIZE
    const rows = []
    for (let i = offset; i < Math.min(total, offset + limit); i++) {
      rows.push({
        id: `v${version}-${q.text ?? ''}-${i}`,
        url: `https://e${i}.test/`,
        title: `Entry ${i}`,
        spaceId: 's',
        archivedAt: 0,
        reason: 'closed' as const,
      })
    }
    return { profileId: 'p', version, total, days: [[0, total]], offset, rows }
  }
  const query = (q: ArchiveQuery) => {
    calls.push(q)
    const v = version
    return new Promise<ArchivePage>((resolve) => {
      const run = () => {
        const saved = version
        version = v
        const page = answer(q)
        version = saved
        resolve(page)
      }
      if (hold) pending.push(run)
      else queueMicrotask(run)
    })
  }
  return {
    query,
    calls,
    bump: () => version++,
    setTotal: (n: number) => {
      total = n
    },
    hold: (on: boolean) => {
      hold = on
    },
    release: () => {
      for (const run of pending.splice(0)) run()
    },
    pendingCount: () => pending.length,
  }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const filters = (text = ''): ArchiveFilters => ({ text, source: 'all', profileId: 'p' })

describe('Archive list data (AR-03, AR-04)', () => {
  it('[AR-03] new filters fetch the first page; scrolling fetches the pages that come into view', async () => {
    const fake = fakeArchive(1000)
    const model = new ArchiveListModel(fake.query)
    model.setFilters(filters())
    await flush()
    expect(model.data.total).toBe(1000)
    expect(model.data.loading).toBe(false)
    expect(model.row(0)?.title).toBe('Entry 0')
    expect(model.row(PAGE_SIZE)).toBeUndefined()
    model.setRange(450, 470)
    await flush()
    expect(model.row(450)?.title).toBe('Entry 450')
    expect(fake.calls.map((c) => c.offset)).toEqual([0, 400])
    // A page already here (or on its way) is not asked for again.
    model.setRange(455, 460)
    await flush()
    expect(fake.calls).toHaveLength(2)
    // New filters start from the top: one request, for the first page only.
    model.setFilters(filters('entry'))
    await flush()
    expect(fake.calls.slice(2).map((c) => [c.text, c.offset])).toEqual([['entry', 0]])
  })

  it('[AR-04] answers for older filters are dropped; the rows on screen stay until the new answer', async () => {
    const fake = fakeArchive(300)
    const model = new ArchiveListModel(fake.query)
    model.setFilters(filters())
    await flush()
    const before = model.data
    fake.hold(true)
    model.setFilters(filters('a'))
    model.setFilters(filters('ab'))
    expect(model.data).toBe(before)
    // The answer to "a" arrives after "ab" was typed: ignored.
    fake.release()
    await flush()
    expect(model.data.key).toBe(JSON.stringify(['p', 'ab', '', 'all', 'any']))
    expect(model.row(0)?.id).toContain('-ab-')
    // Same filters again (another keystroke that changes nothing): no new request.
    const n = fake.calls.length
    model.setFilters(filters('ab '))
    await flush()
    expect(fake.calls.length).toBe(n)
  })

  it('[AR-03] a change to the Archive refetches the pages in view and swaps them in together', async () => {
    const fake = fakeArchive(500)
    const model = new ArchiveListModel(fake.query)
    model.setFilters(filters())
    model.setRange(0, 250)
    await flush()
    expect(model.data.pages.size).toBe(3)
    fake.bump()
    fake.setTotal(499)
    model.changed(2)
    await flush()
    expect(model.data.version).toBe(2)
    expect(model.data.total).toBe(499)
    expect([...model.data.pages.values()].every((rows) => rows.every((r) => r.id.startsWith('v2-')))).toBe(true)
    // Hearing about a version already shown does nothing.
    const n = fake.calls.length
    model.changed(2)
    await flush()
    expect(fake.calls.length).toBe(n)
  })

  it('[AR-03] a page from a newer version than the rest makes the whole view reload', async () => {
    const fake = fakeArchive(400)
    const model = new ArchiveListModel(fake.query)
    model.setFilters(filters())
    await flush()
    fake.bump()
    model.setRange(300, 320)
    await flush()
    expect(model.data.version).toBe(2)
    expect(model.row(0)?.id.startsWith('v2-')).toBe(true)
    expect(model.row(300)?.id.startsWith('v2-')).toBe(true)
  })
})
