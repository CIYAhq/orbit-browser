import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadState, normalizeState, Persistence } from '../../src/main/persist'
import { Store } from '../../src/main/store'
import { makeTab } from '../../src/main/tabs/model'
import { createInitialState, DEFAULT_PROFILE_ID } from '../../src/shared/defaults'

describe('persistence', () => {
  it('starts fresh when no file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-'))
    const { state, firstRun } = loadState(join(dir, 'missing.json'))
    expect(firstRun).toBe(true)
    expect(state.spaceOrder).toHaveLength(1)
  })

  it('keeps a corrupt file aside and starts fresh', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-'))
    const file = join(dir, 'state.json')
    writeFileSync(file, '{ not json')
    const { firstRun } = loadState(file)
    expect(firstRun).toBe(true)
  })

  it('resets runtime-only fields on load', () => {
    const base = createInitialState(0)
    const spaceId = base.spaceOrder[0] as string
    const tab = makeTab({ spaceId, profileId: DEFAULT_PROFILE_ID, url: 'https://a.test/' })
    tab.loading = true
    tab.asleep = false
    tab.audible = true
    base.tabs[tab.id] = tab
    const state = normalizeState(JSON.parse(JSON.stringify(base)))
    expect(state.tabs[tab.id]).toMatchObject({ loading: false, asleep: true, audible: false })
  })

  it('writes state to disk after changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-'))
    const file = join(dir, 'state.json')
    const store = new Store(createInitialState(0))
    const p = new Persistence(store, file, 10)
    store.update((d) => {
      d.settings.searchEngine = 'kagi'
    })
    p.flush()
    expect(JSON.parse(readFileSync(file, 'utf8')).settings.searchEngine).toBe('kagi')
    p.dispose()
  })
})
