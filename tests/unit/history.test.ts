import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { frecency, HistoryStore, hostOf, isRecordable, urlKeyOf } from '../../src/main/history/store'

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
