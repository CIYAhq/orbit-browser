import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { backupOf, isRuntimeOnlyPatch, loadState, normalizeState, Persistence } from '../../src/main/persist'
import { Store } from '../../src/main/store'
import { makeTab } from '../../src/main/tabs/model'
import { createInitialState, createWindowState, DEFAULT_PROFILE_ID } from '../../src/shared/defaults'
import type { OrbitState } from '../../src/shared/state'

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'orbit-')), 'state.json')
const readJson = (file: string): OrbitState => JSON.parse(readFileSync(file, 'utf8'))
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function withTab(): { store: Store; tabId: string } {
  const state = createInitialState(0)
  const spaceId = state.spaceOrder[0] as string
  const tab = makeTab({ spaceId, profileId: DEFAULT_PROFILE_ID, url: 'https://a.test/' }, 0)
  state.tabs[tab.id] = tab
  state.spaces[spaceId]?.today.push(tab.id)
  const win = createWindowState(spaceId)
  state.windows[win.id] = win
  return { store: new Store(state), tabId: tab.id }
}

describe('persistence', () => {
  it('starts fresh when no file exists', () => {
    const { state, firstRun } = loadState(tempFile())
    expect(firstRun).toBe(true)
    expect(state.spaceOrder).toHaveLength(1)
  })

  it('keeps a corrupt file aside and starts fresh', () => {
    const file = tempFile()
    writeFileSync(file, '{ not json')
    const { firstRun } = loadState(file)
    expect(firstRun).toBe(true)
    expect(readdirSync(join(file, '..')).some((f) => f.startsWith('state.json.corrupt-'))).toBe(true)
  })

  it('resets runtime-only fields on load', () => {
    const base = createInitialState(0)
    const spaceId = base.spaceOrder[0] as string
    const tab = makeTab({ spaceId, profileId: DEFAULT_PROFILE_ID, url: 'https://a.test/' })
    tab.loading = true
    tab.asleep = false
    tab.audible = true
    base.tabs[tab.id] = tab
    base.spaces[spaceId]?.today.push(tab.id)
    const state = normalizeState(JSON.parse(JSON.stringify(base)))
    expect(state.tabs[tab.id]).toMatchObject({ loading: false, asleep: true, audible: false })
  })

  it('writes state to disk after changes', async () => {
    const file = tempFile()
    const store = new Store(createInitialState(0))
    const p = new Persistence(store, file, 10)
    store.update((d) => {
      d.settings.searchEngine = 'kagi'
    })
    p.flush()
    expect(readJson(file).settings.searchEngine).toBe('kagi')
    p.dispose()
  })

  // Review F3: writes were synchronous, unconditional, without fsync or a backup.
  it('ignores changes to runtime-only fields', async () => {
    const file = tempFile()
    const { store, tabId } = withTab()
    const p = new Persistence(store, file, 5)
    store.update((d) => {
      const t = d.tabs[tabId]
      if (!t) return
      t.loading = true
      t.asleep = false
      t.progress = 0.4
    })
    store.update((d) => {
      for (const win of Object.values(d.windows)) {
        win.focused = true
        win.overlay = { kind: 'commandbar', mode: 'new-tab', query: '', nonce: 1 }
      }
    })
    await wait(30)
    expect(existsSync(file)).toBe(false)
    store.update((d) => {
      const t = d.tabs[tabId]
      if (t) t.title = 'Renamed'
    })
    await wait(30)
    await p.save()
    expect(readJson(file).tabs[tabId]?.title).toBe('Renamed')
    p.dispose()
  })

  it('classifies patch paths as runtime-only or saved', () => {
    const rt = (...path: (string | number)[]) => isRuntimeOnlyPatch({ op: 'replace', path, value: 1 })
    expect(rt('tabs', 't-1', 'loading')).toBe(true)
    expect(rt('tabs', 't-1', 'error', 'code')).toBe(true)
    expect(rt('windows', 'w-1', 'overlay', 'kind')).toBe(true)
    expect(rt('windows', 'w-1', 'sidebar', 'peeking')).toBe(true)
    expect(rt('downloads', 'd-1', 'receivedBytes')).toBe(true)
    expect(rt('tabs', 't-1', 'title')).toBe(false)
    expect(rt('tabs', 't-1')).toBe(false)
    expect(rt('windows', 'w-1', 'sidebar', 'width')).toBe(false)
    expect(rt('windows', 'w-1', 'bounds')).toBe(false)
    expect(rt('archive', 0)).toBe(false)
  })

  it('writes in the background and keeps the previous file as .bak', async () => {
    const file = tempFile()
    const store = new Store(createInitialState(0))
    const p = new Persistence(store, file, 5)
    store.update((d) => {
      d.settings.searchEngine = 'kagi'
    })
    await p.save()
    store.update((d) => {
      d.settings.searchEngine = 'bing'
    })
    await p.save()
    expect(readJson(file).settings.searchEngine).toBe('bing')
    expect(readJson(backupOf(file)).settings.searchEngine).toBe('kagi')
    expect(readdirSync(join(file, '..')).filter((f) => f.endsWith('.tmp'))).toEqual([])
    p.dispose()
  })

  it('never lets an older background write land after a synchronous flush', async () => {
    const file = tempFile()
    const store = new Store(createInitialState(0))
    const p = new Persistence(store, file, 5)
    store.update((d) => {
      d.settings.searchEngine = 'kagi'
    })
    const background = p.save()
    store.update((d) => {
      d.settings.searchEngine = 'brave'
    })
    p.flush()
    await background
    expect(readJson(file).settings.searchEngine).toBe('brave')
    p.dispose()
  })

  it('falls back to the backup when the state file is corrupt or missing', () => {
    const file = tempFile()
    const good = createInitialState(0)
    good.settings.searchEngine = 'ecosia'
    writeFileSync(backupOf(file), JSON.stringify(good))
    writeFileSync(file, '{"windows": {"w-1": ')
    const fromCorrupt = loadState(file)
    expect(fromCorrupt.firstRun).toBe(false)
    expect(fromCorrupt.state.settings.searchEngine).toBe('ecosia')
    expect(existsSync(file)).toBe(false)
    const fromMissing = loadState(file)
    expect(fromMissing.state.settings.searchEngine).toBe('ecosia')
  })
})

// Review F12: normalizeState only filled top-level defaults.
describe('normalizeState repairs loaded state', () => {
  const T = (id: string, spaceId: string, extra: Record<string, unknown> = {}) => ({
    id,
    spaceId,
    profileId: DEFAULT_PROFILE_ID,
    url: `https://${id}.test/`,
    title: id,
    createdAt: 1,
    lastActiveAt: 1,
    ...extra,
  })

  it('fills missing window fields so state listeners never see undefined', () => {
    const base = createInitialState(0)
    const spaceId = base.spaceOrder[0] as string
    const raw = JSON.parse(JSON.stringify(base))
    raw.windows = {
      'w-1': { id: 'w-1', spaceId, kind: 'main' },
      'w-2': { spaceId: 's-gone', sidebar: { width: 9999 } },
    }
    const state = normalizeState(raw)
    expect(state.windows['w-1']).toMatchObject({
      activeTab: {},
      sidebar: { visible: true, width: 248, peeking: false },
      overlay: { kind: 'none' },
      focused: false,
    })
    expect(state.windows['w-2']?.spaceId).toBe(spaceId)
    expect(state.windows['w-2']?.sidebar.width).toBe(420)
  })

  it('drops dangling references and duplicates, keeping the first place', () => {
    const base = createInitialState(0)
    const spaceId = base.spaceOrder[0] as string
    const raw = JSON.parse(JSON.stringify(base))
    raw.tabs = { 't-a': T('t-a', spaceId), 't-b': T('t-b', spaceId) }
    raw.folders = { 'f-1': { id: 'f-1', name: 'F', children: ['t-b', 't-missing', 't-a'] } }
    raw.spaces[spaceId].pinned = ['f-1', 't-gone', 't-a']
    raw.spaces[spaceId].today = ['t-a', 'v-missing', 42]
    const state = normalizeState(raw)
    expect(state.folders['f-1']?.children).toEqual(['t-b', 't-a'])
    expect(state.spaces[spaceId]?.pinned).toEqual(['f-1'])
    expect(state.spaces[spaceId]?.today).toEqual([])
    expect(Object.keys(state.tabs).sort()).toEqual(['t-a', 't-b'])
  })

  it('removes orphan tabs, folders and splits and survives folder cycles', () => {
    const base = createInitialState(0)
    const spaceId = base.spaceOrder[0] as string
    const raw = JSON.parse(JSON.stringify(base))
    raw.tabs = { 't-a': T('t-a', spaceId), 't-orphan': T('t-orphan', spaceId), 't-c': T('t-c', spaceId) }
    raw.folders = {
      'f-1': { id: 'f-1', name: 'A', children: ['f-2'] },
      'f-2': { id: 'f-2', name: 'B', children: ['f-1', 't-a'] },
      'f-lost': { id: 'f-lost', name: 'Lost', children: [] },
    }
    raw.splits = {
      'v-lost': {
        id: 'v-lost',
        layout: {
          type: 'row',
          children: [
            { type: 'leaf', tabId: 't-c' },
            { type: 'leaf', tabId: 't-orphan' },
          ],
          sizes: [0.5, 0.5],
        },
      },
    }
    raw.spaces[spaceId].pinned = ['f-1']
    const state = normalizeState(raw)
    expect(state.folders['f-2']?.children).toEqual(['t-a'])
    expect(Object.keys(state.folders).sort()).toEqual(['f-1', 'f-2'])
    expect(Object.keys(state.tabs)).toEqual(['t-a'])
    expect(state.splits).toEqual({})
  })

  it('dissolves a split left with one tab and fixes tab homes', () => {
    const base = createInitialState(0)
    const spaceId = base.spaceOrder[0] as string
    const raw = JSON.parse(JSON.stringify(base))
    raw.tabs = { 't-a': T('t-a', 's-elsewhere', { profileId: 'p-gone' }), 't-fav': T('t-fav', 's-gone') }
    raw.splits = {
      'v-1': {
        id: 'v-1',
        layout: {
          type: 'row',
          children: [
            { type: 'leaf', tabId: 't-a' },
            { type: 'leaf', tabId: 't-x' },
          ],
          sizes: [0.5],
        },
      },
    }
    raw.spaces[spaceId].today = ['v-1']
    raw.profiles[DEFAULT_PROFILE_ID].favorites = ['t-fav']
    const state = normalizeState(raw)
    expect(state.splits).toEqual({})
    expect(state.spaces[spaceId]?.today).toEqual(['t-a'])
    expect(state.tabs['t-a']).toMatchObject({ spaceId, profileId: DEFAULT_PROFILE_ID })
    expect(state.tabs['t-fav']?.spaceId).toBe(spaceId)
  })

  it('points windows only at tabs their Space shows', () => {
    const base = createInitialState(0)
    const spaceId = base.spaceOrder[0] as string
    const raw = JSON.parse(JSON.stringify(base))
    raw.tabs = { 't-a': T('t-a', spaceId), 't-fav': T('t-fav', spaceId) }
    raw.spaces[spaceId].today = ['t-a']
    raw.profiles[DEFAULT_PROFILE_ID].favorites = ['t-fav']
    raw.windows = {
      'w-1': { id: 'w-1', kind: 'main', spaceId, activeTab: { [spaceId]: 't-gone', 's-gone': 't-a' } },
      'w-2': { id: 'w-2', kind: 'main', spaceId, activeTab: { [spaceId]: 't-fav' } },
      'w-3': { id: 'w-3', kind: 'main', spaceId, activeTab: { [spaceId]: 't-a' } },
    }
    const state = normalizeState(raw)
    expect(state.windows['w-1']?.activeTab).toEqual({ [spaceId]: null })
    expect(state.windows['w-2']?.activeTab).toEqual({ [spaceId]: 't-fav' })
    expect(state.windows['w-3']?.activeTab).toEqual({ [spaceId]: 't-a' })
  })

  it('tolerates malformed collections and values', () => {
    const state = normalizeState({
      tabs: null,
      spaces: [],
      profiles: { 'p-x': 'nope' },
      windows: { 'w-1': 7 },
      settings: { appearance: 'sepia' },
      archive: [null, { id: 'a-1' }],
    } as unknown as Partial<OrbitState>)
    expect(state.spaceOrder).toHaveLength(1)
    expect(Object.keys(state.profiles)).toEqual([DEFAULT_PROFILE_ID])
    expect(state.windows).toEqual({})
    expect(state.settings.appearance).toBe('system')
    expect(state.archive).toHaveLength(1)
  })

  it('keeps a file from a newer Orbit aside instead of loading it', () => {
    const file = tempFile()
    const newer = { ...createInitialState(0), schema: 99 }
    newer.settings.searchEngine = 'kagi'
    writeFileSync(file, JSON.stringify(newer))
    const { state } = loadState(file)
    expect(state.settings.searchEngine).toBe('google')
    expect(existsSync(file)).toBe(false)
    expect(readdirSync(join(file, '..')).some((f) => f.startsWith('state.json.schema99-'))).toBe(true)
  })
})
