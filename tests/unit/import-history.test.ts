import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { FIXTURE_ROOT, type FixturePage, manyPages, sampleHistory, writeChromium } from '../../scripts/import-fixtures'
import { HistoryStore, type ImportedPage } from '../../src/main/history/store'
import { type FoundSource, findSources } from '../../src/main/import/browsers'
import { withScratch } from '../../src/main/import/copy'
import { countHistory, historySql, historyTask, NewestPages, readProfileHistory } from '../../src/main/import/history'
import type { Job } from '../../src/main/import/jobs'
import type { ImportJob, ImportSkip } from '../../src/shared/commands/import'

const DAY = 86_400_000
const dirs: string[] = []
const scratchDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-import-history-'))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

async function source(browser: FoundSource['browser'], dir = join(FIXTURE_ROOT, browser)): Promise<FoundSource> {
  const [found] = await findSources([{ browser, dir }])
  if (!found) throw new Error(`no ${browser} at ${dir}`)
  return found
}

/** Every page of a profile's history, as the import reads it, in chunks of `size`. */
async function pagesOf(s: FoundSource, profile = 0): Promise<ImportedPage[]> {
  const p = s.profiles[profile]
  if (!p) throw new Error('no profile')
  const out: ImportedPage[] = []
  await withScratch((scratch) => readProfileHistory(s, p, scratch, (pages) => out.push(...pages)))
  return out
}

/** The fixture's web pages as a browser that keeps `typed` typed visits would give them back. */
function expected(typed: (p: FixturePage) => number, history = sampleHistory()): ImportedPage[] {
  return history
    .filter((p) => !p.hidden && p.url.startsWith('http'))
    .map((p) => ({
      url: p.url,
      title: p.title,
      visitCount: p.visits,
      typedCount: typed(p),
      // The fixtures keep each page's last three visits, a day apart.
      visits: Array.from({ length: Math.min(p.visits, 3) }, (_, i) => p.last - i * DAY),
    }))
}

describe('[IM-07] reading another browser’s history', () => {
  it('Chromium: pages with titles, visit and typed counts and newest visits; its own pages and hidden ones left out', async () => {
    const chrome = await source('chrome')
    expect(await pagesOf(chrome)).toEqual(expected((p) => p.typed ?? 0))
    expect(await pagesOf(chrome, 1)).toEqual([
      expect.objectContaining({
        url: 'https://weather.example.org/',
        title: 'Weather',
        visitCount: 12,
        typedCount: 12,
      }),
    ])
  })

  it('Firefox: places that were visited (not bookmarks only); typed visits counted', async () => {
    // Firefox flags a page typed and marks typed visits; it keeps no typed count.
    const typedVisits = (p: FixturePage) => Math.min(p.visits, 3, p.typed ?? 0)
    expect(await pagesOf(await source('firefox'))).toEqual(
      expected((p) => (p.typed ? Math.max(1, typedVisits(p)) : 0), sampleHistory('about:preferences')),
    )
  })

  it('Safari: History.db, with each page’s title from its newest visit', async () => {
    expect(await pagesOf(await source('safari'))).toEqual(expected(() => 0, sampleHistory('favorites://')))
  })

  it('reads a large history a chunk at a time', async () => {
    const dir = scratchDir()
    writeChromium(join(dir, 'chrome'), [{ folder: 'Default', name: 'Big', history: manyPages(4500) }])
    const s = await source('chrome', join(dir, 'chrome'))
    const sizes: number[] = []
    await withScratch((scratch) =>
      readProfileHistory(s, s.profiles[0] as FoundSource['profiles'][number], scratch, (pages) =>
        sizes.push(pages.length),
      ),
    )
    expect(sizes).toEqual([1000, 1000, 1000, 1000, 500])
    const db = new DatabaseSync(join(dir, 'chrome', 'Default', 'History'))
    try {
      expect(await countHistory(db, historySql('chrome'))).toBe(4500)
    } finally {
      db.close()
    }
  })
})

const page = (n: number, last: number, extra: Partial<ImportedPage> = {}): ImportedPage => ({
  url: `https://site${n}.example/`,
  title: `Site ${n}`,
  visitCount: 1,
  typedCount: 0,
  visits: [last],
  ...extra,
})

describe('[IM-07] a history larger than Orbit keeps', () => {
  it('keeps the pages visited most recently, trimming as it reads, and counts the older ones', () => {
    const kept = new NewestPages(3)
    kept.add([page(1, 10), page(2, 50), page(3, 30)])
    kept.add([page(4, 40), page(5, 20), page(6, 60)])
    expect(kept.take().map((p) => p.visits[0])).toEqual([50, 40, 60])
    expect(kept.older).toBe(3)
    // Ties at the edge: only as many as fit.
    const ties = new NewestPages(2)
    ties.add([page(1, 5), page(2, 5), page(3, 5), page(4, 1)])
    expect(ties.take().map((p) => p.url)).toEqual(['https://site1.example/', 'https://site2.example/'])
    expect(ties.older).toBe(2)
  })

  it('finds exactly the newest of many, in any order', () => {
    const times = Array.from({ length: 20_000 }, (_, i) => (i * 7919) % 15_013)
    const kept = new NewestPages(1000)
    for (let i = 0; i < times.length; i += 2000) {
      kept.add(times.slice(i, i + 2000).map((t, j) => page(i + j, t)))
    }
    const top = [...times].sort((a, b) => b - a).slice(0, 1000)
    expect(
      kept
        .take()
        .map((p) => p.visits[0])
        .sort((a, b) => (b as number) - (a as number)),
    ).toEqual(top)
    expect(kept.older).toBe(19_000)
  })
})

describe('[IM-07][IM-15] imported pages in a profile’s history', () => {
  const tmpFile = () => join(scratchDir(), 'p-test.jsonl')
  const news = (extra: Partial<ImportedPage> = {}) =>
    page(1, 3 * DAY, {
      url: 'https://news.example.org/',
      title: 'Example News',
      visitCount: 120,
      typedCount: 80,
      visits: [3 * DAY, 2 * DAY, DAY],
      ...extra,
    })

  it('adds pages with their counts and visits: History and the command bar find them at once', async () => {
    const store = new HistoryStore(tmpFile(), { now: () => 4 * DAY })
    await store.load()
    expect(store.importPages([news(), page(2, 2.5 * DAY)])).toBe(2)
    expect(store.get('https://news.example.org/')).toMatchObject({
      title: 'Example News',
      visitCount: 120,
      typedCount: 80,
      firstVisit: DAY,
      lastVisit: 3 * DAY,
      visits: [DAY, 2 * DAY, 3 * DAY],
    })
    expect(store.search('news').map((e) => e.url)).toEqual(['https://news.example.org/'])
    expect(store.visits({ limit: 2 }).map((v) => [v.title, v.at])).toEqual([
      ['Example News', 3 * DAY],
      ['Site 2', 2.5 * DAY],
    ])
    expect(store.hostList().find((h) => h.host === 'news.example.org')).toMatchObject({
      visitCount: 120,
      typedCount: 80,
    })
  })

  it('importing the same history again changes nothing; a page’s newer visits are added, once', async () => {
    const store = new HistoryStore(tmpFile())
    await store.load()
    store.importPages([news()])
    const version = store.version
    expect(store.importPages([news()])).toBe(0)
    expect(store.version).toBe(version)
    expect(store.get('https://news.example.org/')).toMatchObject({ visitCount: 120, typedCount: 80 })
    // The other browser was used since: only its new visit comes over.
    expect(store.importPages([news({ visitCount: 121, visits: [4 * DAY, 3 * DAY, 2 * DAY, DAY] })])).toBe(1)
    expect(store.importPages([news({ visitCount: 121, visits: [4 * DAY, 3 * DAY, 2 * DAY, DAY] })])).toBe(0)
    expect(store.get('https://news.example.org/')).toMatchObject({
      visitCount: 121,
      typedCount: 80,
      lastVisit: 4 * DAY,
    })
  })

  it('adds to what was visited in Orbit, and leaves other browsers’ pages alone', async () => {
    const store = new HistoryStore(tmpFile())
    await store.load()
    store.record('https://news.example.org/', { at: 5 * DAY, title: 'News (Orbit)', typed: true })
    store.importPages([news(), page(2, DAY)])
    expect(store.get('https://news.example.org/')).toMatchObject({
      title: 'News (Orbit)',
      visitCount: 121,
      typedCount: 81,
      visits: [DAY, 2 * DAY, 3 * DAY, 5 * DAY],
    })
    // Pages that aren't web pages are never kept.
    expect(store.importPages([page(3, DAY, { url: 'chrome://settings/' })])).toBe(0)
    expect(store.size).toBe(2)
  })

  it('writes the import once, as a snapshot a later start reads back', async () => {
    const file = tmpFile()
    const a = new HistoryStore(file)
    await a.load()
    a.importPages([news(), page(2, DAY)])
    await a.finishImport()
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines.map((l) => JSON.parse(l).t)).toEqual(['e', 'e'])
    const b = new HistoryStore(file)
    await b.load()
    expect(b.get('https://news.example.org/')).toMatchObject({ visitCount: 120, typedCount: 80, lastVisit: 3 * DAY })
    expect(b.size).toBe(2)
  })

  it('is refused before the history is loaded', () => {
    expect(() => new HistoryStore(tmpFile()).importPages([news()])).toThrow()
  })

  it.skipIf(process.getuid?.() === 0)(
    'a history file that can’t be read gets the import in its side file',
    async () => {
      const file = tmpFile()
      const a = new HistoryStore(file)
      await a.load()
      a.record('https://kept.example/', { at: DAY })
      await a.flush()
      chmodSync(file, 0o000)
      const b = new HistoryStore(file)
      await b.load()
      expect(b.readOnlyLog).toBe(true)
      b.importPages([news()])
      await b.finishImport()
      await b.flush()
      chmodSync(file, 0o644)
      expect(existsSync(`${file}.side`)).toBe(true)
      const c = new HistoryStore(file)
      await c.load()
      expect(c.size).toBe(2)
      expect(c.get('https://news.example.org/')).toMatchObject({ visitCount: 120, typedCount: 80 })
    },
  )
})

describe('[IM-07][IM-14] the import’s history line', () => {
  /** Runs the task as the import does: read everything, then add it to each source profile's destination. */
  async function runTask(s: FoundSource, destinations: Record<string, string>, persistent: string[]) {
    const dir = scratchDir()
    const stores = new Map<string, HistoryStore>()
    const store = (profileId: string) => {
      const known = stores.get(profileId)
      if (known) return known
      const made = new HistoryStore(join(dir, `${profileId}.jsonl`))
      stores.set(profileId, made)
      return made
    }
    const skipped: ImportSkip[] = []
    const job = {
      cancelled: false,
      status: { skipped } as unknown as ImportJob,
      destinations: new Map(Object.entries(destinations).map(([k, profileId]) => [k, { spaceId: 's', profileId }])),
    } as unknown as Job
    const jobs = {
      changed: () => {},
      addSkips: (_: Job, more: ImportSkip[]) => skipped.push(...more.filter((x) => x.count)),
    }
    const task = historyTask(jobs, { store } as never, s, s.profiles, (id) => persistent.includes(id))
    await task.read?.(job)
    const total = task.item.total
    if (task.item.state !== 'skipped' && task.item.state !== 'failed') await task.add(job)
    return { item: task.item, total, skipped, job, stores, dir }
  }

  it('reads every chosen profile, then adds each to its destination; a private window’s profile gets none', async () => {
    const chrome = await source('chrome')
    const { item, total, skipped, stores, dir } = await runTask(
      chrome,
      { Default: 'p-work', 'Profile 1': 'private-1' },
      ['p-work'],
    )
    expect(total).toBe(7)
    expect(item.done).toBe(6)
    expect(stores.get('p-work')?.size).toBe(6)
    expect(stores.get('private-1')).toBeUndefined()
    expect(skipped).toEqual([{ what: 'page', count: 1, reason: 'A private window keeps no history' }])
    // Written once, read back on a later start.
    const again = new HistoryStore(join(dir, 'p-work.jsonl'))
    await again.load()
    expect(again.size).toBe(6)
  })

  it.skipIf(process.getuid?.() === 0)(
    'a history the browser holds: nothing from it, and the import asks to quit the browser',
    async () => {
      const dir = scratchDir()
      cpSync(join(FIXTURE_ROOT, 'chrome'), join(dir, 'chrome'), { recursive: true })
      const held = join(dir, 'chrome', 'Default', 'History')
      chmodSync(held, 0o000)
      try {
        const chrome = await source('chrome', join(dir, 'chrome'))
        const { item, job } = await runTask(
          { ...chrome, profiles: chrome.profiles.slice(0, 1) },
          { Default: 'p-work' },
          ['p-work'],
        )
        expect(item).toMatchObject({ state: 'skipped', note: 'Chrome is using it', total: 0 })
        expect(job.status.locked).toEqual({ browser: 'Chrome', types: ['history'] })
      } finally {
        chmodSync(held, 0o644)
      }
    },
  )
})
