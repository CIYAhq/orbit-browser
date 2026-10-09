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
