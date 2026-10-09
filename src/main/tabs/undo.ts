/**
 * Undo for sidebar changes (TB-18): moves and reorders, closing and clearing,
 * archiving, renames and icon changes. Each entry knows how to revert itself.
 */
export interface UndoEntry {
  label: string
  undo: () => void
  at: number
  /** True once the change was already reverted another way (e.g. ⌘⇧T reopened the tab). */
  isStale?: () => boolean
}

export class UndoStack {
  private entries: UndoEntry[] = []

  constructor(private limit = 100) {}

  push(label: string, undo: () => void, at = Date.now(), isStale?: () => boolean): void {
    this.entries.push({ label, undo, at, isStale })
    if (this.entries.length > this.limit) this.entries.shift()
  }

  /** Reverts the most recent change. Returns its label, or undefined when there is nothing to undo. */
  undo(): string | undefined {
    let entry = this.entries.pop()
    while (entry?.isStale?.()) entry = this.entries.pop()
    if (!entry) return undefined
    entry.undo()
    return entry.label
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
