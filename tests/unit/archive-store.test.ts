import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ArchiveStore, dayStart, MAX_HISTORY_ENTRIES, trimHistory } from '../../src/main/archive/store'
import type { ArchivedTab } from '../../src/shared/state'

const DAY = 24 * 3600_000
const NOW = new Date(2026, 9, 9, 15, 0, 0).getTime()

let seq = 0
const entry = (fields: Partial<ArchivedTab> = {}): ArchivedTab => {
  seq++
  return {
    id: `a-${seq}`,
    url: `https://site${seq}.test/page`,
    title: `Page ${seq}`,
    spaceId: 's-1',
    profileId: 'p-default',
    archivedAt: NOW - seq * 1000,
    reason: 'closed',
    section: 'today',
    ...fields,
  }
}

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'orbit-archive-')), 'archive.jsonl')

describe('ArchiveStore lists (AR-03)', () => {
  it('[AR-03] lists newest first, grouped by local day, per profile', () => {
    const s = new ArchiveStore(null)
    const today1 = entry({ title: 'Today one', archivedAt: NOW - 3600_000 })
    const today2 = entry({ title: 'Today two', archivedAt: NOW - 60_000 })
    const yesterday = entry({ title: 'Yesterday', archivedAt: NOW - DAY })
    const other = entry({ title: 'Work page', profileId: 'p-work', archivedAt: NOW - 30_000 })
    s.add([yesterday, today1, today2, other])
    const page = s.query({ profileId: 'p-default' })
    expect(page.rows.map((r) => r.title)).toEqual(['Today two', 'Today one', 'Yesterday'])
    expect(page.days).toEqual([
      [dayStart(NOW), 2],
      [dayStart(NOW - DAY), 1],
    ])
    expect(page.total).toBe(3)
    expect(s.query({ profileId: 'p-work' }).rows.map((r) => r.title)).toEqual(['Work page'])
  })

  it('[AR-03] filters by Space and by source (sidebar tabs or Mini Window pages)', () => {
    const s = new ArchiveStore(null)
    s.add([
      entry({ title: 'A in one', spaceId: 's-1' }),
      entry({ title: 'B in two', spaceId: 's-2' }),
      entry({ title: 'Mini page', from: 'mini', spaceId: 's-2' }),
      entry({ title: 'Peek page', from: 'peek' }),
    ])
    const titles = (q: Parameters<ArchiveStore['query']>[0]) => s.query(q).rows.map((r) => r.title)
    expect(titles({ profileId: 'p-default', spaceId: 's-2' })).toEqual(['B in two', 'Mini page'])
    expect(titles({ profileId: 'p-default', source: 'mini' })).toEqual(['Mini page'])
    expect(titles({ profileId: 'p-default', source: 'sidebar' })).toEqual(['A in one', 'B in two'])
    expect(titles({ profileId: 'p-default', source: 'all' })).toHaveLength(4)
  })

  it('[AR-03] pages through a long list with stable totals and day counts', () => {
    const s = new ArchiveStore(null)
    const list: ArchivedTab[] = []
    for (let i = 0; i < 1000; i++) list.push(entry({ archivedAt: NOW - i * 3600_000 }))
    s.add(list)
    const first = s.query({ profileId: 'p-default', limit: 100 })
    const second = s.query({ profileId: 'p-default', offset: 100, limit: 100 })
    expect(first.total).toBe(1000)
    expect(second.offset).toBe(100)
    expect(second.rows[0]?.archivedAt).toBeLessThan(first.rows[99]?.archivedAt ?? 0)
    expect(first.days.reduce((n, [, c]) => n + c, 0)).toBe(1000)
    expect(first.version).toBe(second.version)
  })
})

describe('ArchiveStore search (AR-04)', () => {
  it('[AR-04] matches title or URL, case-insensitive, partial words, every word', () => {
    const s = new ArchiveStore(null)
    s.add([
      entry({ title: 'Quarterly Budget Review', url: 'https://docs.example.test/q3' }),
      entry({ title: 'Recipes', url: 'https://www.cooking.test/budget-meals' }),
      entry({ title: 'Holiday plans', url: 'https://travel.test/' }),
    ])
    const titles = (text: string) => s.query({ profileId: 'p-default', text }).rows.map((r) => r.title)
    expect(titles('BUDG')).toEqual(['Quarterly Budget Review', 'Recipes'])
    expect(titles('budget docs')).toEqual(['Quarterly Budget Review'])
    expect(titles('cooking.test')).toEqual(['Recipes'])
    expect(titles('  ')).toHaveLength(3)
    expect(titles('nothing-like-this')).toEqual([])
  })

  it('[AR-04] searching 10,000 entries stays well inside a frame', () => {
    const s = new ArchiveStore(null)
    const list: ArchivedTab[] = []
    const words = ['alpha', 'budget', 'cinema', 'delta', 'garden']
    for (let i = 0; i < 10_000; i++) {
      const w = words[i % words.length]
      list.push(
        entry({ title: `Seeded ${w} ${i}`, url: `https://${w}${i % 97}.test/p/${i}`, archivedAt: NOW - i * 60_000 }),
      )
    }
    s.add(list)
    s.query({ profileId: 'p-default', text: 'warm' })
    const times: number[] = []
    for (const text of ['b', 'bu', 'bud', 'budg', 'budge', 'budget', 'budget 99']) {
      const t0 = performance.now()
      const page = s.query({ profileId: 'p-default', text, limit: 60 })
      times.push(performance.now() - t0)
      expect(page.rows.length).toBeGreaterThan(0)
    }
    times.sort((a, b) => a - b)
    // Median well under the 50 ms keystroke budget (FL-24), with room for slow CI machines.
    expect(times[Math.floor(times.length / 2)]).toBeLessThan(25)
  })

  it('[AR-04] typing on, deleting and changing filters give the same answers as a fresh search', () => {
    const words = ['alpha', 'budget', 'cinema', 'delta', 'garden']
    const list: ArchivedTab[] = []
    for (let i = 0; i < 400; i++) {
      const w = words[i % words.length]
      list.push(
        entry({
          title: `Seeded ${w} ${i}`,
          url: `https://${w}${i % 7}.test/p/${i}`,
          archivedAt: NOW - i * 3600_000,
          reason: i % 3 ? 'closed' : 'auto',
          spaceId: i % 2 ? 's-1' : 's-2',
          ...(i % 10 === 9 ? { from: 'mini' as const } : {}),
        }),
      )
    }
    const typed = new ArchiveStore(null)
    typed.add(list)
    const answer = (store: ArchiveStore, q: Parameters<ArchiveStore['query']>[0]) => {
      const page = store.query({ ...q, limit: 500 })
      return { total: page.total, days: page.days, ids: page.rows.map((r) => r.id) }
    }
    const steps: Parameters<ArchiveStore['query']>[0][] = [
      { profileId: 'p-default', text: 'b' },
      { profileId: 'p-default', text: 'bu' },
      { profileId: 'p-default', text: 'budget' },
      { profileId: 'p-default', text: 'budget 1' },
      { profileId: 'p-default', text: 'budget 1 budget3' },
      { profileId: 'p-default', text: 'budget 1' },
      { profileId: 'p-default', text: 'budget 1', spaceId: 's-1' },
      { profileId: 'p-default', text: 'budget 11', spaceId: 's-1' },
      { profileId: 'p-default', text: 'budget 11' },
      { profileId: 'p-default', text: 'budget 11', closedBy: 'auto' },
      { profileId: 'p-default', text: 'Budget 11 .test', closedBy: 'auto' },
      { profileId: 'p-default', text: 'a', source: 'mini' },
      { profileId: 'p-default', text: 'al', source: 'mini' },
      { profileId: 'p-work', text: 'al' },
    ]
    for (const q of steps) {
      const fresh = new ArchiveStore(null)
      fresh.add(list)
      expect(answer(typed, q)).toEqual(answer(fresh, q))
    }
    // A change to the Archive is seen by the next keystroke.
    typed.query({ profileId: 'p-default', text: 'cinema' })
    const added = entry({ title: 'Seeded cinema new', archivedAt: NOW })
    typed.add([added])
    expect(typed.query({ profileId: 'p-default', text: 'cinema new' }).rows.map((r) => r.id)).toEqual([added.id])
  })
})

describe('ArchiveStore persistence (AR-01)', () => {
  it('[AR-01] keeps entries and their back/forward history across a restart (without page state)', async () => {
    const file = tmpFile()
    const s = new ArchiveStore(file)
    await s.load()
    const a = entry({ title: 'With history', tabId: 't-1' })
    const b = entry({ title: 'Plain' })
    s.add(
      [a, b],
      new Map([
        [
          a.id,
          {
            entries: [
              { url: 'https://one.test/', title: 'One', pageState: 'opaque' },
              { url: 'https://two.test/', title: 'Two' },
            ],
            index: 1,
          },
        ],
      ]),
    )
    s.flushSync()
    const t = new ArchiveStore(file)
    await t.load()
    expect(t.size).toBe(2)
    expect(t.get(a.id)?.history).toEqual({
      entries: [
        { url: 'https://one.test/', title: 'One' },
        { url: 'https://two.test/', title: 'Two' },
      ],
      index: 1,
    })
    expect(t.get(a.id)?.tabId).toBe('t-1')
    expect(t.idsOfTab('t-1')).toEqual([a.id])
    expect(t.query({ profileId: 'p-default' }).rows.find((r) => r.id === a.id)?.hasHistory).toBe(true)
  })

  it('[AR-01] replays deletions, late histories and clears; changes made before loading apply after it', async () => {
    const file = tmpFile()
    const s = new ArchiveStore(file)
    await s.load()
    const [a, b, c, w] = [entry(), entry(), entry(), entry({ profileId: 'p-work' })]
    s.add([a, b, c, w])
    s.setHistory(b.id, { entries: [{ url: 'https://late.test/', title: 'Late' }], index: 0 })
    s.delete([a.id])
    s.clear('p-work')
    s.close()
    const t = new ArchiveStore(file)
    // Before the log is read: queued, applied after it.
    const d = entry({ title: 'Added while loading' })
    t.add([d])
    t.delete([c.id])
    await t.load()
    expect(
      t
        .all()
        .map((e) => e.id)
        .sort(),
    ).toEqual([b.id, d.id].sort())
    expect(t.get(b.id)?.history?.entries[0]?.url).toBe('https://late.test/')
    t.flushSync()
    const u = new ArchiveStore(file)
    await u.load()
    expect(u.size).toBe(2)
  })

  it('[AR-01] compaction rewrites a mostly dead log and keeps what was written meanwhile', async () => {
    const file = tmpFile()
    const s = new ArchiveStore(file, { writeDelayMs: 1 })
    await s.load()
    const list: ArchivedTab[] = []
    for (let i = 0; i < 1500; i++) list.push(entry())
    s.add(list)
    s.delete(list.slice(0, 1400).map((e) => e.id))
    s.flushSync()
    const before = readFileSync(file, 'utf8').split('\n').filter(Boolean).length
    const compacting = s.compact()
    const late = entry({ title: 'Written during compaction' })
    s.add([late])
    await compacting
    s.flushSync()
    const after = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    expect(after.length).toBeLessThan(before)
    const t = new ArchiveStore(file)
    await t.load()
    expect(t.size).toBe(101)
    expect(t.has(late.id)).toBe(true)
  })

  it('[AR-07] clearing a profile takes its pages off the disk, not only out of the list; also during a compaction (review M5)', async () => {
    const file = tmpFile()
    const s = new ArchiveStore(file, { writeDelayMs: 1 })
    await s.load()
    s.add(Array.from({ length: 1000 }, () => entry()))
    const workEntries = (from: number) =>
      Array.from({ length: 50 }, (_, i) =>
        entry({ profileId: 'p-work', url: `https://work.test/${from + i}`, title: `Work ${from + i}` }),
      )
    const work = workEntries(0)
    const back = { url: 'https://work-history.test/', title: 'Back' }
    s.add(
      work,
      new Map([
        [work[0]?.id as string, { entries: [back, { url: 'https://work.test/0', title: 'Work 0' }], index: 1 }],
      ]),
    )
    s.flushSync()
    expect(readFileSync(file, 'utf8')).toContain('https://work-history.test/')
    expect(s.clear('p-work')).toHaveLength(50)
    const clean = () => {
      const text = readFileSync(file, 'utf8')
      expect(text).not.toContain('work.test')
      expect(text).not.toContain('work-history.test')
    }
    await vi.waitFor(clean)
    // A clear while the log is being rewritten (the rewrite started with those entries in it).
    s.add(workEntries(100))
    s.flushSync()
    const compacting = s.compact()
    s.clear('p-work')
    await compacting
    await vi.waitFor(clean)
    s.close()
    const t = new ArchiveStore(file)
    await t.load()
    expect(t.size).toBe(1000)
    clean()
  })

  it('[AR-01] after a crash mid-append, the next record starts on a line of its own (review F11)', async () => {
    const file = tmpFile()
    const kept = entry({ title: 'Kept' })
    // The last append was cut short: a partial line, no newline at the end.
    writeFileSync(file, `${JSON.stringify({ t: 'a', e: kept })}\n{"t":"a","e":{"id":"a-cut","url":"https://cut.te`)
    const s = new ArchiveStore(file)
    await s.load()
    expect(s.all().map((e) => e.title)).toEqual(['Kept'])
    s.add([entry({ title: 'Next' })])
    s.close()
    const t = new ArchiveStore(file)
    await t.load()
    expect(
      t
        .all()
        .map((e) => e.title)
        .sort(),
    ).toEqual(['Kept', 'Next'])
  })

  it('[AR-01] ignores torn or foreign lines in the log', async () => {
    const file = tmpFile()
    const good = entry({ title: 'Good' })
    writeFileSync(
      file,
      [
        JSON.stringify({ t: 'a', e: good }),
        '{"t":"a","e":{"id":',
        JSON.stringify({ t: 'a', e: { id: 'x', url: '', profileId: 'p', spaceId: 's' } }),
        'not json',
        '',
      ].join('\n'),
    )
    const s = new ArchiveStore(file)
    await s.load()
    expect(s.all().map((e) => e.title)).toEqual(['Good'])
  })

  it('[AR-01] keeps at most 50 history entries around the current one', () => {
    const entries = Array.from({ length: 120 }, (_, i) => ({ url: `https://h.test/${i}`, title: `${i}` }))
    const h = trimHistory({ entries, index: 100 })
    expect(h?.entries).toHaveLength(MAX_HISTORY_ENTRIES)
    expect(h?.entries[h.index]?.url).toBe('https://h.test/100')
    const start = trimHistory({ entries, index: 3 })
    expect(start?.entries[start.index]?.url).toBe('https://h.test/3')
    expect(trimHistory({ entries: [], index: 0 })).toBeUndefined()
  })
})
