import type { SpaceId } from '../../shared/state'
import type { MainContext } from '../context'
import type { UndoStack } from '../tabs/undo'

/** The same Spaces, each once, in any order. */
function samePlaces(a: readonly SpaceId[], b: readonly SpaceId[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return set.size === a.length && b.every((id) => set.has(id))
}

/**
 * ⌘Z after the Spaces are reordered puts them back, as it does a tab moved in the sidebar (SP-11,
 * TB-18); ⌘⇧Z reorders them again. Any change of the order alone is a reorder (a target dragged in
 * the switcher); a Space added or deleted is not. The Space on screen stays on screen.
 */
export function registerSpaceOrderUndo(ctx: Pick<MainContext, 'store'>, undo: Pick<UndoStack, 'push'>): void {
  const { store } = ctx
  let applying = false

  /** Puts the Spaces in `order`; one added since keeps its place after them, one deleted is left out. */
  const apply = (order: readonly SpaceId[]) => {
    applying = true
    try {
      store.update((d) => {
        const now = new Set(d.spaceOrder)
        const kept = order.filter((id) => now.has(id))
        d.spaceOrder = [...kept, ...d.spaceOrder.filter((id) => !kept.includes(id))]
      })
    } finally {
      applying = false
    }
  }

  const record = (before: readonly SpaceId[], after: readonly SpaceId[]) => {
    undo.push('Reorder Spaces', () => {
      apply(before)
      return () => {
        apply(after)
        record(before, after)
      }
    })
  }

  store.subscribe((next, prev) => {
    if (applying || next.spaceOrder === prev.spaceOrder) return
    const moved = next.spaceOrder.some((id, i) => id !== prev.spaceOrder[i])
    if (moved && samePlaces(next.spaceOrder, prev.spaceOrder)) record([...prev.spaceOrder], [...next.spaceOrder])
  })
}
