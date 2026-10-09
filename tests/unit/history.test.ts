import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { frecency, HistoryStore, hostOf, isRecordable, sameDocument, urlKeyOf } from '../../src/main/history/store'

const DAY = 86_400_000
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'orbit-history-')), 'p-test.jsonl')

describe('history store', () => {
  it('[CB-05] records visits with titles and finds them by title or URL', async () => {
    const store = new HistoryStore(tmpFile())
    await store.load()
    store.record('https://budget.example/', { title: 'Budget planner' })
    store.record('https://news.example/a')
    store.setTitle('https://news.example/a', 'Morning news')
    expect(store.search('budg').map((e) => e.url)).toEqual(['https://budget.example/'])
    expect(store.search('morning').map((e) => e.title)).toEqual(['Morning news'])
    expect(store.search('news.example/a')).toHaveLength(1)
    expect(store.get('https://budget.example/')?.visitCount).toBe(1)
  })

  it('ignores pages that are not web pages', async () => {
    const store = new HistoryStore(tmpFile())
    await store.load()
    store.record('about:blank')
    store.record('data:text/html,hi')
    store.record('chrome://gpu')
    expect(store.size).toBe(0)
    expect(isRecordable('file:///tmp/a.html')).toBe(true)
  })

  it('persists as JSONL, compacts on load and keeps counts, titles and favicons', async () => {
    const file = tmpFile()
    const a = new HistoryStore(file)
    await a.load()
    for (let i = 0; i < 3; i++) a.record('https://github.com/', { at: 1000 + i, typed: i === 0 })
    a.setTitle('https://github.com/', 'GitHub')
    a.setFavicon('https://github.com/', 'https://github.com/favicon.ico')
    a.record('https://example.com/x', { at: 2000 })
    await a.flush()
    const raw = readFileSync(file, 'utf8').trim().split('\n')
    expect(raw.length).toBeGreaterThan(2) // append-only log

    const b = new HistoryStore(file)
    await b.load()
    const gh = b.get('https://github.com/')
    expect(gh).toMatchObject({ title: 'GitHub', visitCount: 3, typedCount: 1, firstVisit: 1000, lastVisit: 1002 })
    expect(gh?.favicon).toBe('https://github.com/favicon.ico')
    // Compacted: one line per URL.
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('merges visits recorded before the log finished loading', async () => {
    const file = tmpFile()
    writeFileSync(file, `${JSON.stringify({ t: 'v', u: 'https://a.example/', at: 10 })}\nnot json\n`)
    const store = new HistoryStore(file)
    const loading = store.load()
    store.record('https://a.example/', { at: 20 })
    store.record('https://b.example/', { at: 30 })
    await loading
    expect(store.get('https://a.example/')?.visitCount).toBe(2)
    expect(store.get('https://b.example/')?.visitCount).toBe(1)
    await store.flush()
    const again = new HistoryStore(file)
    await again.load()
    expect(again.get('https://a.example/')?.visitCount).toBe(2)
    expect(again.size).toBe(2)
  })

  it('[CB-17] deletes a URL and clears a time range, durably', async () => {
    const file = tmpFile()
    const store = new HistoryStore(file)
    await store.load()
    store.record('https://a.example/', { at: 100 })
    store.record('https://a.example/', { at: 300 })
    store.record('https://b.example/', { at: 200 })
    store.record('https://c.example/', { at: 400 })
    await store.delete('https://c.example/')
    await store.clear(250, 350)
    expect(store.get('https://c.example/')).toBeUndefined()
    expect(store.get('https://a.example/')).toMatchObject({ visitCount: 1, lastVisit: 100 })
    await store.flush()
    const again = new HistoryStore(file)
    await again.load()
    expect(again.get('https://c.example/')).toBeUndefined()
    expect(again.get('https://a.example/')?.visitCount).toBe(1)
    expect(again.hostList().map((h) => h.host)).not.toContain('c.example')
  })

  it('lists visits newest first with paging and a text filter (History view API)', async () => {
    const store = new HistoryStore(tmpFile())
    await store.load()
    store.record('https://a.example/', { at: 1, title: 'Alpha' })
    store.record('https://b.example/', { at: 2, title: 'Beta' })
    store.record('https://a.example/', { at: 3 })
    expect(store.visits().map((v) => v.at)).toEqual([3, 2, 1])
    expect(store.visits({ before: 3, limit: 1 }).map((v) => v.url)).toEqual(['https://b.example/'])
    expect(store.visits({ text: 'alpha' }).map((v) => v.at)).toEqual([3, 1])
  })

  it('aggregates hosts for inline completion', async () => {
    const store = new HistoryStore(tmpFile())
    await store.load()
    store.record('https://www.github.com/orbit', { at: 1 })
    store.record('http://localhost:3300/page/A', { at: 2 })
    const hosts = Object.fromEntries(store.hostList().map((h) => [h.host, h]))
    expect(hosts['github.com']?.origin).toBe('https://www.github.com')
    expect(hosts['localhost:3300']?.origin).toBe('http://localhost:3300')
  })

  it.skipIf(process.getuid?.() === 0)('[CB-05] never overwrites a log it cannot read (review M1)', async () => {
    const file = tmpFile()
    const a = new HistoryStore(file)
    await a.load()
    for (let i = 0; i < 50; i++) a.record(`https://site${i}.example/`, { at: 1000 + i })
    await a.flush()
    const before = readFileSync(file)
    chmodSync(file, 0o000)
    const b = new HistoryStore(file)
    await b.load()
    expect(b.readOnlyLog).toBe(true)
    b.record('https://new.example/', { at: 5000 })
    await b.flush()
    b.flushSync()
    chmodSync(file, 0o644)
    // Byte-identical: nothing was compacted over it or appended to it.
    expect(readFileSync(file).equals(before)).toBe(true)
    // The next good load merges the side file and compacts.
    const c = new HistoryStore(file)
    await c.load()
    expect(c.size).toBe(51)
    expect(c.get('https://new.example/')?.visitCount).toBe(1)
    const entries = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter((l) => JSON.parse(l).t === 'e')
    expect(entries).toHaveLength(51)
    expect(readdirSync(dirname(file)).filter((n) => n.startsWith(`${basename(file)}.side`))).toEqual([])
    // And a further load neither loses nor double counts anything.
    const d = new HistoryStore(file)
    await d.load()
    expect(d.size).toBe(51)
    expect(d.get('https://new.example/')?.visitCount).toBe(1)
  })

  it('[CB-05] coalesces title and favicon changes: 1,000 title changes add at most 2 lines (review M2)', async () => {
    const file = tmpFile()
    const store = new HistoryStore(file)
    await store.load()
    store.record('https://ticker.example/', { at: 1 })
    for (let i = 0; i < 1000; i++) {
      store.setTitle('https://ticker.example/', `(${i}) Ticker`)
      store.setFavicon('https://ticker.example/', `data:image/svg+xml,frame-${i}`)
    }
    expect(store.get('https://ticker.example/')?.title).toBe('(999) Ticker')
    await store.flush()
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines.length).toBeLessThanOrEqual(2)
    expect(lines.join('\n')).not.toContain('data:')
    const again = new HistoryStore(file)
    await again.load()
    expect(again.get('https://ticker.example/')?.title).toBe('(999) Ticker')
  })

  it('[CB-05] compacts in the background once the log passes its threshold (review M2)', async () => {
    const file = tmpFile()
    const store = new HistoryStore(file, { compactBytes: 2000 })
    await store.load()
    for (let i = 0; i < 200; i++) store.record('https://same.example/', { at: i + 1 })
    await store.flush()
    const deadline = Date.now() + 3000
    while (readFileSync(file, 'utf8').trim().split('\n').length > 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
    }
    await store.idle()
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string)).toMatchObject({ t: 'e', vc: 200 })
    // Appends continue after a compaction.
    store.record('https://other.example/', { at: 500 })
    await store.flush()
    const again = new HistoryStore(file)
    await again.load()
    expect(again.get('https://same.example/')?.visitCount).toBe(200)
    expect(again.get('https://other.example/')?.visitCount).toBe(1)
  })

  it('[CB-05] a quit during a compaction keeps the newest visits (side file, review F16)', async () => {
    const file = tmpFile()
    const store = new HistoryStore(file)
    await store.load()
    for (let i = 0; i < 20; i++) store.record(`https://p${i}.example/`, { at: i + 1 })
    await store.flush()
    const compacting = (store as unknown as { compact(): Promise<void> }).compact()
    store.record('https://during.example/', { at: 100 })
    store.flushSync() // quit now
    await compacting
    const again = new HistoryStore(file)
    await again.load()
    expect(again.size).toBe(21)
    expect(again.get('https://during.example/')?.visitCount).toBe(1)
  })

  it('[CB-05] a side file the snapshot already merged is never counted twice (crash after rename)', async () => {
    const file = tmpFile()
    const visit = JSON.stringify({ t: 'v', u: 'https://a.example/', at: 5 })
    writeFileSync(
      file,
      `${JSON.stringify({ t: 'h', merged: ['tok1'] })}\n${JSON.stringify({ t: 'e', u: 'https://a.example/', ti: 'A', vc: 1, tc: 0, fv: 5, v: [5] })}\n`,
    )
    writeFileSync(`${file}.side.tok1`, `${visit}\n`) // already in the snapshot
    writeFileSync(`${file}.side.tok2`, `${JSON.stringify({ t: 'v', u: 'https://b.example/', at: 6 })}\n`) // not yet
    const store = new HistoryStore(file)
    await store.load()
    expect(store.get('https://a.example/')?.visitCount).toBe(1)
    expect(store.get('https://b.example/')?.visitCount).toBe(1)
    expect(existsSync(`${file}.side.tok1`)).toBe(false)
    expect(existsSync(`${file}.side.tok2`)).toBe(false)
  })

  it('[CB-17] clearing a recent range keeps older visits of the same page (review F7)', async () => {
    const store = new HistoryStore(tmpFile())
    await store.load()
    for (let i = 0; i < 100; i++) store.record('https://a.example/', { at: 1000 + i })
    for (let i = 0; i < 25; i++) store.record('https://a.example/', { at: 1_000_000 + i })
    await store.clear(500_000)
    const e = store.get('https://a.example/')
    expect(e?.visitCount).toBeGreaterThanOrEqual(100)
    expect(e?.visits.every((at) => at < 500_000)).toBe(true)
  })

  it('drop() removes the files of a deleted profile', async () => {
    const file = tmpFile()
    const store = new HistoryStore(file)
    await store.load()
    store.record('https://a.example/')
    await store.flush()
    expect(existsSync(file)).toBe(true)
    await store.drop()
    store.record('https://b.example/')
    store.flushSync()
    expect(existsSync(file)).toBe(false)
    expect(existsSync(`${file}.side`)).toBe(false)
  })

  it('[CB-05] treats fragment-only changes as the same document (review F6)', () => {
    expect(sameDocument('https://a.example/doc#one', 'https://a.example/doc#two')).toBe(true)
    expect(sameDocument('https://a.example/doc', 'https://a.example/doc#top')).toBe(true)
    expect(sameDocument('https://a.example/doc', 'https://a.example/other')).toBe(false)
    expect(sameDocument(undefined, 'https://a.example/')).toBe(false)
  })

  it('weights frequency and recency', () => {
    const now = 100 * DAY
    const often = frecency({ visitCount: 20, typedCount: 0, lastVisit: now - DAY / 2 }, now)
    const once = frecency({ visitCount: 1, typedCount: 0, lastVisit: now - DAY / 2 }, now)
    const old = frecency({ visitCount: 20, typedCount: 0, lastVisit: now - 60 * DAY }, now)
    expect(often).toBeGreaterThan(once)
    expect(often).toBeGreaterThan(old)
    expect(urlKeyOf('https://www.GitHub.com/Orbit')).toBe('github.com/orbit')
    expect(hostOf('http://localhost:3000/x')?.host).toBe('localhost:3000')
  })
})
