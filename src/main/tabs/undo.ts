/**
 * Undo for sidebar changes (TB-18): moves and reorders, closing and clearing,
 * archiving, renames and icon changes. Each entry knows how to revert itself and may
 * return a redo step (⌘⇧Z).
 */
export interface UndoEntry {
  label: string
  /** Reverts the change; a returned function is the redo step. */
  undo: () => unknown
  at: number
  /** True once the change was already reverted another way (e.g. ⌘⇧T reopened the tab). */
  isStale?: () => boolean
}

export class UndoStack {
  private entries: UndoEntry[] = []
  private redos: { label: string; redo: () => void }[] = []
  private redoing = false

  constructor(private limit = 100) {}

  /** Records a change. `undo` may return the step that re-applies it (redo). */
  push(label: string, undo: () => unknown, at = Date.now(), isStale?: () => boolean): void {
    this.entries.push({ label, undo, at, isStale })
    if (this.entries.length > this.limit) this.entries.shift()
    // A new change ends the redo chain (a redo re-records its own change without clearing it).
    if (!this.redoing) this.redos = []
  }

  /** Reverts the most recent change. Returns its label, or undefined when there is nothing to undo. */
  undo(maxAgeMs = Number.POSITIVE_INFINITY, now = Date.now()): string | undefined {
    while (this.peek()?.isStale?.()) this.entries.pop()
    const top = this.peek()
    // From a page, only a recent change is undone (an old one would surprise; the sidebar can).
    if (!top || now - top.at > maxAgeMs) return undefined
    const entry = this.entries.pop()
    if (!entry) return undefined
    const redo = entry.undo()
    if (typeof redo === 'function') this.redos.push({ label: entry.label, redo: redo as () => void })
    return entry.label
  }

  /** Re-applies the most recently undone change. */
  redo(): string | undefined {
    const step = this.redos.pop()
    if (!step) return undefined
    this.redoing = true
    try {
      step.redo()
    } finally {
      this.redoing = false
    }
    return step.label
  }

  peek(): UndoEntry | undefined {
    return this.entries[this.entries.length - 1]
  }

  get size(): number {
    return this.entries.length
  }

  clear(): void {
    this.entries = []
  }
}
