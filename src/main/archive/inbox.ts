import type { ArchiveHistory } from './store'

/**
 * Hand-off of a closed tab's back/forward history from the tabs code to the Archive (AR-01).
 * The tabs code writes Archive entries into OrbitState without history (it stays out of state)
 * and passes each entry's history here right after; the Archive service collects it. Entries
 * nobody collects are dropped, oldest first.
 */
const MAX_WAITING = 200
const waiting = new Map<string, ArchiveHistory>()
let listener: ((archiveId: string) => void) | undefined

/** Called by the tabs code after it archived a tab (no-op without an id or history). */
export function noteArchiveHistory(archiveId: string | undefined, history: ArchiveHistory | undefined): void {
  if (!archiveId || !history || !Array.isArray(history.entries) || history.entries.length === 0) return
  waiting.set(archiveId, history)
  if (waiting.size > MAX_WAITING) {
    const oldest = waiting.keys().next().value
    if (oldest !== undefined) waiting.delete(oldest)
  }
  listener?.(archiveId)
}

/** The history handed over for an entry, once (the Archive service). */
export function takeArchiveHistory(archiveId: string): ArchiveHistory | undefined {
  const h = waiting.get(archiveId)
  if (h) waiting.delete(archiveId)
  return h
}

/** The Archive service hears about histories that arrive after their entry. */
export function onArchiveHistory(fn: ((archiveId: string) => void) | undefined): void {
  listener = fn
}

let restoredListener: ((undo?: () => void) => void) | undefined

/**
 * The tabs code hears when Restore Data replaced the whole sidebar (AR-11): its undo steps were
 * about a sidebar that is gone, and `undo` (when given) takes the restore back.
 */
export function onSidebarRestored(fn: ((undo?: () => void) => void) | undefined): void {
  restoredListener = fn
}

/** Called by the Archive code right after it restored the sidebar from a backup. */
export function sidebarRestored(undo?: () => void): void {
  restoredListener?.(undo)
}
