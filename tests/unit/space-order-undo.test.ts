import { describe, expect, it } from 'vitest'
import { createSpaceInDraft, reorderSpaceInDraft } from '../../src/main/spaces/model'
import { registerSpaceOrderUndo } from '../../src/main/spaces/order-undo'
import { Store } from '../../src/main/store'
import { UndoStack } from '../../src/main/tabs/undo'
import { createInitialState, DEFAULT_PROFILE_ID } from '../../src/shared/defaults'

/** ⌘Z after the Spaces are reordered puts them back (SP-11). */

function setup() {
  const state = createInitialState(0)
  const store = new Store(state)
  const undo = new UndoStack()
  registerSpaceOrderUndo({ store }, undo)
  const add = (name: string) => {
    let id = ''
    store.update((d) => {
      id = createSpaceInDraft(d, { name, profileId: DEFAULT_PROFILE_ID }, 0).id
    })
    return id
  }
  const [a] = store.state.spaceOrder as [string]
  const b = add('B')
  const c = add('C')
  const reorder = (spaceId: string, index: number) => store.update((d) => reorderSpaceInDraft(d, spaceId, index))
  return { store, undo, a, b, c, add, reorder }
}

describe('Space reorder undo (SP-11)', () => {
  it('[SP-11][TB-18] ⌘Z puts the Spaces back in their order, ⌘⇧Z reorders them again', () => {
    const { store, undo, a, b, c, reorder } = setup()
    // Adding Spaces is not a reorder.
    expect(undo.size).toBe(0)
    reorder(c, 0)
    expect(store.state.spaceOrder).toEqual([c, a, b])
    expect(undo.undo()).toBe('Reorder Spaces')
    expect(store.state.spaceOrder).toEqual([a, b, c])
    expect(undo.redo()).toBe('Reorder Spaces')
    expect(store.state.spaceOrder).toEqual([c, a, b])
    // Undone again after the redo.
    expect(undo.undo()).toBe('Reorder Spaces')
    expect(store.state.spaceOrder).toEqual([a, b, c])
    expect(undo.size).toBe(0)
  })

  it('[SP-11] each reorder is undone on its own, the latest first; a Space added since stays, at the end', () => {
    const { store, undo, a, b, c, add, reorder } = setup()
    reorder(a, 2)
    reorder(c, 0)
    expect(store.state.spaceOrder).toEqual([c, b, a])
    const d = add('D')
    expect(undo.undo()).toBe('Reorder Spaces')
    expect(store.state.spaceOrder).toEqual([b, c, a, d])
    expect(undo.undo()).toBe('Reorder Spaces')
    expect(store.state.spaceOrder).toEqual([a, b, c, d])
    // A deleted Space is left out.
    reorder(d, 0)
    store.update((x) => {
      x.spaceOrder = x.spaceOrder.filter((id) => id !== b)
    })
    expect(undo.undo()).toBe('Reorder Spaces')
    expect(store.state.spaceOrder).toEqual([a, c, d])
  })
})
