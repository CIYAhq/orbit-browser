import { describe, expect, it, vi } from 'vitest'
import type { MainContext } from '../../src/main/context'
import { linkSplitMenuItem, tabSplitMenuItems } from '../../src/main/split/menu'
import { createSplitInDraft } from '../../src/main/split/model'
import { makeTab } from '../../src/main/tabs/model'
import { createInitialState, createWindowState, DEFAULT_PROFILE_ID } from '../../src/shared/defaults'

function setup() {
  const state = createInitialState(0)
  const spaceId = state.spaceOrder[0] as string
  const win = createWindowState(spaceId)
  state.windows[win.id] = win
  const add = () => {
    const tab = makeTab({ spaceId, profileId: DEFAULT_PROFILE_ID, url: 'https://x.test/' })
    state.tabs[tab.id] = tab
    state.spaces[spaceId]?.today.push(tab.id)
    return tab.id
  }
  const run = vi.fn()
  const ctx = {
    store: { state },
    commands: { run },
    actions: { run: vi.fn() },
    windows: { windowOfTab: () => win.id },
  } as unknown as MainContext
  return { state, win: win.id, spaceId, add, run, ctx }
}

describe('split menu items for other menus', () => {
  it('offers Open in Split View for 2–4 selected tabs and refuses more', () => {
    const { add, ctx, run, win } = setup()
    const ids = [add(), add(), add()]
    const [item] = tabSplitMenuItems(ctx, ids, win)
    expect(item?.label).toBe('Open in Split View')
    expect(item?.enabled).toBe(true)
    item?.click?.({} as never, undefined, {} as never)
    expect(run).toHaveBeenCalledWith('split.create', { tabIds: ids }, { windowId: win })
    const five = [...ids, add(), add()]
    const [refused] = tabSplitMenuItems(ctx, five, win)
    expect(refused?.enabled).toBe(false)
    expect(refused?.label).toContain('up to 4')
  })

  it('offers a single other tab beside the current one, but not the current tab or a pane of the same split', () => {
    const { add, ctx, run, state, win, spaceId } = setup()
    const [a, b, c] = [add(), add(), add()]
    const w = state.windows[win]
    if (w) w.activeTab[spaceId] = a
    const [item] = tabSplitMenuItems(ctx, [b], win)
    item?.click?.({} as never, undefined, {} as never)
    expect(run).toHaveBeenCalledWith('split.addTab', { tabId: b, target: a, side: 'right' }, { windowId: win })
    expect(tabSplitMenuItems(ctx, [a], win)).toEqual([])
    createSplitInDraft(state, [a, c])
    expect(tabSplitMenuItems(ctx, [c], win)).toEqual([])
  })

  it('opens a link in a pane beside the page', () => {
    const { add, ctx, run, win } = setup()
    const a = add()
    const item = linkSplitMenuItem(ctx, a, 'https://y.test/')
    item.click?.({} as never, undefined, {} as never)
    expect(run).toHaveBeenCalledWith(
      'split.openUrl',
      { url: 'https://y.test/', target: a, side: 'right' },
      { windowId: win },
    )
  })
})
