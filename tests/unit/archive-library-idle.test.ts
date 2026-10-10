import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDLE_CHECKS, IDLE_PREPARE_MS, IDLE_RETRY_MS, LibraryHost } from '../../src/main/archive/library'
import type { MainContext } from '../../src/main/context'
import { Store } from '../../src/main/store'
import { makeTab } from '../../src/main/tabs/model'
import { createInitialState, createWindowState, DEFAULT_PROFILE_ID } from '../../src/shared/defaults'
import type { SpaceId, WindowId } from '../../src/shared/state'

afterEach(() => {
  vi.useRealTimers()
})

/** A main window that has laid out once, and the windows whose Library view was made. */
function world() {
  vi.useFakeTimers()
  const state = createInitialState(0)
  const spaceId = state.spaceOrder[0] as SpaceId
  const win = createWindowState(spaceId)
  state.windows[win.id] = win
  const store = new Store(state)
  let layout: ((payload: unknown, meta: { windowId?: WindowId }) => void) | undefined
  const ctx = {
    store,
    events: {
      on: (name: string, fn: typeof layout) => {
        if (name === 'layout.panes') layout = fn
      },
    },
    hooks: { tabCreated: [] },
    windows: { get: () => ({ isDestroyed: () => false }) },
    perf: { mark() {} },
  } as unknown as MainContext
  const host = new LibraryHost(ctx, { last: () => 'archive', remember() {} })
  const prepared: WindowId[] = []
  // The view itself is Electron's: record when it would be made.
  host.prepare = (id) => {
    if (id) prepared.push(id)
  }
  const laidOut = () => layout?.({ frame: { x: 0, y: 0, width: 800, height: 600 }, radius: 10 }, { windowId: win.id })
  return { store, win: win.id, spaceId, prepared, laidOut }
}

describe('Library view made ahead (DL-09, FL-24)', () => {
  it('[DL-09][FL-24] while the command bar is over the window the view waits; it is made at the first check after (re-review R2)', () => {
    const w = world()
    w.store.update((d) => {
      ;(d.windows[w.win] as (typeof d.windows)[string]).overlay = {
        kind: 'commandbar',
        mode: 'new-tab',
        query: '',
        nonce: 1,
      }
    })
    w.laidOut()
    vi.advanceTimersByTime(IDLE_PREPARE_MS + 2 * IDLE_RETRY_MS)
    expect(w.prepared).toEqual([])
    w.store.update((d) => {
      ;(d.windows[w.win] as (typeof d.windows)[string]).overlay = { kind: 'none' }
    })
    vi.advanceTimersByTime(IDLE_RETRY_MS)
    expect(w.prepared).toEqual([w.win])
    // Once only, however often the window lays out again.
    w.laidOut()
    vi.advanceTimersByTime(IDLE_PREPARE_MS + IDLE_CHECKS * IDLE_RETRY_MS)
    expect(w.prepared).toEqual([w.win])
  })

  it('[DL-09][FL-24] while a page loads the view waits, and after the last check it is made anyway (re-review R2)', () => {
    const w = world()
    const tab = makeTab({ spaceId: w.spaceId, profileId: DEFAULT_PROFILE_ID, url: 'https://slow.test/', title: 'Slow' })
    w.store.update((d) => {
      d.tabs[tab.id] = { ...tab, loading: true }
      d.spaces[w.spaceId]?.today.unshift(tab.id)
    })
    w.laidOut()
    // Every check but the last finds Orbit busy.
    vi.advanceTimersByTime(IDLE_PREPARE_MS + (IDLE_CHECKS - 2) * IDLE_RETRY_MS)
    expect(w.prepared).toEqual([])
    vi.advanceTimersByTime(IDLE_RETRY_MS)
    expect(w.prepared).toEqual([w.win])
  })

  it('[DL-09][FL-24] with nothing loading and nothing over the window, the view is made at the first check', () => {
    const w = world()
    w.laidOut()
    vi.advanceTimersByTime(IDLE_PREPARE_MS - 1)
    expect(w.prepared).toEqual([])
    vi.advanceTimersByTime(1)
    expect(w.prepared).toEqual([w.win])
  })
})
