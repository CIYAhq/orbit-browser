import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, webContents: {}, powerMonitor: {} }))

const { LOW_MEMORY_SLEEP_MS, makeTab, sleepCandidates, sleepPeriod } = await import('../../src/main/tabs/model')
const { cpuHeavy, HOG_PASSES, isLowMemory, saverAfter } = await import('../../src/main/tabs/resources')
const { createInitialState, createWindowState, DEFAULT_PROFILE_ID } = await import('../../src/shared/defaults')

/** Background limits beyond the sleep timer (TB-16). */

const MIN = 60_000
const GB = 1024 * 1024

describe('[TB-16] sleep period under pressure', () => {
  it('the battery saver sleeps tabs after a quarter of the timer, five minutes at least; low memory after five minutes, Never too', () => {
    expect(sleepPeriod(30 * MIN)).toBe(30 * MIN)
    expect(sleepPeriod(30 * MIN, { saver: true })).toBe(7.5 * MIN)
    expect(sleepPeriod(15 * MIN, { saver: true })).toBe(5 * MIN)
    expect(sleepPeriod(2 * MIN, { saver: true })).toBe(2 * MIN)
    expect(sleepPeriod(0, { saver: true })).toBe(0)
    expect(sleepPeriod(30 * MIN, { lowMemory: true })).toBe(LOW_MEMORY_SLEEP_MS)
    expect(sleepPeriod(2 * MIN, { lowMemory: true })).toBe(2 * MIN)
    expect(sleepPeriod(0, { lowMemory: true })).toBe(LOW_MEMORY_SLEEP_MS)
  })

  it('on low memory a tab idle five minutes sleeps, a shown or playing one still never', () => {
    const state = createInitialState(0)
    const spaceId = state.spaceOrder[0] as string
    const win = createWindowState(spaceId)
    state.windows[win.id] = win
    const add = (audible = false) => {
      const tab = makeTab({ spaceId, profileId: DEFAULT_PROFILE_ID, url: 'https://x.test/' }, 0)
      tab.audible = audible
      state.tabs[tab.id] = tab
      state.spaces[spaceId]?.today.push(tab.id)
      return tab.id
    }
    const idle = add()
    const loud = add(true)
    const shown = add()
    win.activeTab[spaceId] = shown
    const awake = [idle, loud, shown]
    expect(sleepCandidates(state, 6 * MIN, awake)).toEqual([])
    expect(sleepCandidates(state, 6 * MIN, awake, { lowMemory: true })).toEqual([idle])
    expect(sleepCandidates(state, 4 * MIN, awake, { lowMemory: true })).toEqual([])
  })
})

describe('[TB-16] low memory and the battery saver', () => {
  it('memory is low under 10 % available, or under 1 GB on a large machine', () => {
    expect(isLowMemory({ total: 8 * GB, available: 0.7 * GB })).toBe(true)
    expect(isLowMemory({ total: 8 * GB, available: 0.9 * GB })).toBe(false)
    expect(isLowMemory({ total: 64 * GB, available: 1.5 * GB })).toBe(false)
    expect(isLowMemory({ total: 64 * GB, available: 0.9 * GB })).toBe(true)
  })

  it('the saver comes on below 20 % on battery power and lifts above 20 % or on charge', () => {
    expect(saverAfter(false, { level: 0.19, charging: false })).toBe(true)
    expect(saverAfter(false, { level: 0.2, charging: false })).toBe(false)
    expect(saverAfter(true, { level: 0.2, charging: false })).toBe(true)
    expect(saverAfter(true, { level: 0.21, charging: false })).toBe(false)
    expect(saverAfter(true, { level: 0.1, charging: true })).toBe(false)
  })
})

describe('[TB-16] CPU-heavy tabs in the background', () => {
  const sample = (tabId: string, pid: number, share: number, freezable = true) => ({ tabId, pid, share, freezable })

  it('freezes a tab whose process kept half a core busy for three passes running; a quiet pass starts over', () => {
    const busy = new Map<string, number>()
    const pass = (share: number) =>
      cpuHeavy([sample('a', 10, share), sample('b', 11, 0.02)], busy, HOG_PASSES, new Set())
    expect(pass(0.8)).toEqual([])
    expect(pass(0.8)).toEqual([])
    expect(pass(0.1)).toEqual([])
    expect(pass(0.8)).toEqual([])
    expect(pass(0.8)).toEqual([])
    expect(pass(0.8)).toEqual(['a'])
    // With the battery saver, one pass.
    expect(cpuHeavy([sample('c', 12, 0.9)], new Map(), 1, new Set())).toEqual(['c'])
  })

  it('never a tab on screen or playing, nor any tab of a process it shares with one, or with a page that is not a tab', () => {
    const busy = new Map<string, number>()
    const hot = [
      sample('shown', 10, 0.9, false),
      sample('other', 20, 0.9),
      sample('with', 20, 0.9, false),
      sample('peek', 30, 0.9),
    ]
    for (let i = 0; i < HOG_PASSES; i++) expect(cpuHeavy(hot, busy, HOG_PASSES, new Set([30]))).toEqual([])
    // The two background tabs of one process go together.
    const pair = [sample('x', 40, 0.9), sample('y', 40, 0.9)]
    const counts = new Map<string, number>()
    cpuHeavy(pair, counts, 2, new Set())
    expect(cpuHeavy(pair, counts, 2, new Set())).toEqual(['x', 'y'])
  })
})
