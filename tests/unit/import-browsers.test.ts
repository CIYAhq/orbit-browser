import { chmodSync, cpSync, mkdtempSync, rmSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { bplist, FIXTURE_ROOT, sampleTree, writeChromium } from '../../scripts/import-fixtures'
import {
  type FoundSource,
  findSources,
  inspectProfile,
  publicSource,
  SAFARI_BLOCKED,
} from '../../src/main/import/browsers'
import { chromiumProfiles } from '../../src/main/import/chromium'
import { type CopyFile, withScratch } from '../../src/main/import/copy'
import { firefoxProfiles } from '../../src/main/import/firefox'
import { parseBplist } from '../../src/main/import/safari'
import type { BookmarkNode } from '../../src/shared/commands/import'

const fixture = (name: string) => join(FIXTURE_ROOT, name)
const scratchDirs: string[] = []
const scratchDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-import-test-'))
  scratchDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

/** A tree as names: folders as { title: [...] }, bookmarks as titles, skipped ones with their reason. */
function shape(nodes: readonly BookmarkNode[]): unknown[] {
  return nodes.map((n) => (n.children ? { [n.title]: shape(n.children) } : n.skip ? `${n.title} (${n.skip})` : n.title))
}

async function source(browser: FoundSource['browser'], dir = fixture(browser)): Promise<FoundSource> {
  const [found] = await findSources([{ browser, dir }])
  if (!found) throw new Error(`no ${browser} at ${dir}`)
  return found
}

async function contents(s: FoundSource, copy?: CopyFile) {
  return withScratch(async (scratch) => {
    const out = []
    for (const p of s.profiles) out.push(await inspectProfile(s, p, scratch))
    return out
  }, copy)
}

describe('[IM-02] the browsers on this computer', () => {
  it('lists each browser found at the places given, with its profiles by name; places with nothing are left out', async () => {
    const found = await findSources([
      { browser: 'chrome', dir: fixture('chrome') },
      { browser: 'brave', dir: fixture('nothing-here') },
      { browser: 'firefox', dir: fixture('firefox') },
      { browser: 'safari', dir: fixture('safari') },
    ])
    expect(found.map(publicSource)).toEqual([
      {
        id: 'chrome',
        browser: 'chrome',
        name: 'Chrome',
        profiles: [
          { id: 'Default', name: 'Work' },
          { id: 'Profile 1', name: 'Personal' },
        ],
      },
      // profiles.ini also lists a profile whose folder is gone: it isn't offered.
      {
        id: 'firefox',
        browser: 'firefox',
        name: 'Firefox',
        profiles: [{ id: 'abcd1234.default-release', name: 'default-release' }],
      },
      { id: 'safari', browser: 'safari', name: 'Safari', profiles: [{ id: '.', name: 'Safari' }] },
    ])
  })

  it('finds a single profile without Local State, in Default or in the browser’s own folder; a second copy gets “(2)”', async () => {
    const dir = scratchDir()
    const marks = { bar: [{ title: 'One', url: 'https://example.com/1' }], other: [], mobile: [] }
    writeChromium(join(dir, 'opera'), [{ folder: '.', name: 'x', bookmarks: marks }], false)
    writeChromium(join(dir, 'vivaldi'), [{ folder: 'Default', name: 'x', bookmarks: marks }], false)
    const found = await findSources([
      { browser: 'opera', dir: join(dir, 'opera') },
      { browser: 'vivaldi', dir: join(dir, 'vivaldi') },
      { browser: 'firefox', dir: fixture('firefox') },
      { browser: 'firefox', dir: fixture('firefox') },
    ])
    expect(found.map((s) => [s.id, s.name, s.profiles.map((p) => `${p.id}: ${p.name}`)])).toEqual([
      ['opera', 'Opera', ['.: Default']],
      ['vivaldi', 'Vivaldi', ['Default: Default']],
      ['firefox', 'Firefox', ['abcd1234.default-release: default-release']],
      ['firefox-2', 'Firefox (2)', ['abcd1234.default-release: default-release']],
    ])
  })

  it('lists Safari as blocked, with the way round it, when its files can’t be opened (no Full Disk Access)', async () => {
    const dir = join(scratchDir(), 'Safari')
    cpSync(fixture('safari'), dir, { recursive: true })
    chmodSync(join(dir, 'Bookmarks.plist'), 0o000)
    try {
      expect(await findSources([{ browser: 'safari', dir }])).toEqual([
        { id: 'safari', browser: 'safari', name: 'Safari', profiles: [], blocked: SAFARI_BLOCKED },
      ])
    } finally {
      chmodSync(join(dir, 'Bookmarks.plist'), 0o644)
    }
  })

  it('reads profile lists strictly: no paths from Local State; the Firefox install’s default first', () => {
    const localState = JSON.stringify({
      profile: {
        info_cache: { 'Profile 2': {}, '../elsewhere': { name: 'Bad' }, Default: { name: ' Me ' } },
        profiles_order: ['Default', 'Profile 2', 7],
      },
    })
    expect(chromiumProfiles(localState)).toEqual([
      { folder: 'Default', name: 'Me' },
      { folder: 'Profile 2', name: 'Profile 2' },
    ])
    expect(chromiumProfiles('not json')).toEqual([])
    const ini = [
      '[Profile0]',
      'Name=first',
      'IsRelative=1',
      'Path=a.first',
      '',
      '[Profile1]',
      'Name=main',
      'IsRelative=0',
      'Path=/elsewhere/b.main',
      '[InstallABC]',
      'Default=/elsewhere/b.main',
      '[General]',
      'Version=2',
    ].join('\r\n')
    expect(firefoxProfiles(ini)).toEqual([
      { name: 'main', path: '/elsewhere/b.main', relative: false },
      { name: 'first', path: 'a.first', relative: true },
    ])
  })
})

describe('[IM-03][IM-04] what a profile holds', () => {
  it('Chromium: the bookmarks bar and other bookmarks as folders, nesting and order kept; an empty root left out', async () => {
    const [work, personal] = await contents(await source('chrome'))
    expect(work?.bookmarks?.count).toBe(6)
    // IM-07: the pages it can import (not the browser's own pages or hidden ones).
    expect(work?.history).toEqual({ count: 6 })
    expect(personal?.history).toEqual({ count: 1 })
    expect(shape(work?.bookmarks?.tree ?? [])).toEqual([
      {
        'Bookmarks bar': [
          { Work: ['Team calendar', 'Design docs', 'Issue tracker'] },
          { News: ['Morning paper', 'Tech & Science <weekly>'] },
        ],
      },
      {
        'Other bookmarks': [
          { Recipes: [{ Bread: ['Sourdough'] }] },
          'Make it dark (Bookmarklet (a script, not a page))',
          'Browser settings (A page only that browser can open)',
        ],
      },
    ])
    expect(work?.locked).toEqual([])
    expect(shape(personal?.bookmarks?.tree ?? [])).toEqual([
      { 'Bookmarks bar': ['Weather'] },
      { 'Other bookmarks': [{ Travel: ['Trains'] }] },
      { 'Mobile bookmarks': ['Recipes on the go'] },
    ])
  })

  it('Firefox: toolbar, menu and other bookmarks from places.sqlite; saved searches skipped, tags and separators left out', async () => {
    const [profile] = await contents(await source('firefox'))
    expect(profile?.bookmarks?.count).toBe(7)
    expect(profile?.history).toEqual({ count: 6 })
    expect(shape(profile?.bookmarks?.tree ?? [])).toEqual([
      {
        'Bookmarks Toolbar': [
          'Most Visited (Saved search, not a page)',
          { Work: ['Team calendar', 'Design docs', 'Issue tracker'] },
          { News: ['Morning paper', 'Tech & Science <weekly>'] },
        ],
      },
      {
        'Bookmarks Menu': [
          { Recipes: [{ Bread: ['Sourdough'] }] },
          'Make it dark (Bookmarklet (a script, not a page))',
          'Browser settings (A page only that browser can open)',
        ],
      },
      { 'Other Bookmarks': ['Read later'] },
    ])
  })

  it('Safari: the favorites bar, bookmarks menu and reading list from Bookmarks.plist', async () => {
    const [profile] = await contents(await source('safari'))
    expect(shape(profile?.bookmarks?.tree ?? [])).toEqual([
      {
        'Favorites bar': [
          { Work: ['Team calendar', 'Design docs', 'Issue tracker'] },
          { News: ['Morning paper', 'Tech & Science <weekly>'] },
        ],
      },
      { 'Bookmarks Menu': [{ Recipes: ['Sourdough'] }] },
      { 'Reading List': ['A long read'] },
    ])
    expect(profile?.bookmarks?.count).toBe(7)
    expect(profile?.history).toEqual({ count: 6 })
  })

  it('[IM-14] a file the browser holds is marked locked, and the profile’s other files are still read', async () => {
    const chrome = await source('chrome')
    const holding =
      (...names: string[]): CopyFile =>
      async (from, to) => {
        if (names.some((n) => from.endsWith(n))) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        await copyFile(from, to)
      }
    const [work] = await contents(chrome, holding('Bookmarks'))
    expect(work).toEqual({ profileId: 'Default', name: 'Work', locked: ['bookmarks'], history: { count: 6 } })
    const [busyHistory] = await contents(chrome, holding('History'))
    expect(busyHistory?.locked).toEqual(['history'])
    expect(busyHistory?.bookmarks?.count).toBe(6)
    // Firefox keeps both in one file.
    const [firefox] = await contents(await source('firefox'), holding('places.sqlite'))
    expect(firefox).toEqual({
      profileId: 'abcd1234.default-release',
      name: 'default-release',
      locked: ['bookmarks', 'history'],
    })
    // A file that is missing or broken is simply not offered.
    const dir = scratchDir()
    writeChromium(join(dir, 'chrome'), [{ folder: 'Default', name: 'Me', history: [] }])
    const [empty] = await contents(await source('chrome', join(dir, 'chrome')))
    expect(empty).toEqual({ profileId: 'Default', name: 'Me', locked: [] })
  })
})

describe('[IM-02] Safari’s property lists', () => {
  it('reads what the fixture writer writes: long lists, other alphabets, numbers and flags', () => {
    const value = {
      list: Array.from({ length: 300 }, (_, i) => i * 1000),
      title: 'Café ✓ 東京',
      nested: { yes: true, no: false, empty: [] },
      long: 'x'.repeat(70_000),
    }
    expect(parseBplist(bplist(value))).toEqual(value)
    const [bar] = sampleTree()
    expect(parseBplist(bplist(bar))).toEqual(bar)
  })

  it('refuses what isn’t one, or is cut short', () => {
    expect(() => parseBplist(Buffer.from('<?xml version="1.0"?><plist></plist>'))).toThrow()
    const whole = bplist({ a: ['b', 'c'] })
    expect(() => parseBplist(whole.subarray(0, whole.length - 8))).toThrow()
  })
})
