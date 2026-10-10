import type { ArchivedTab, ProfileId } from '../../shared/state'
import type { UndoStack } from '../tabs/undo'
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

/** The sidebar's undo stack (TB-18), which the tabs code owns. */
export type SidebarUndo = Pick<UndoStack, 'push' | 'peek' | 'undo'>

let sidebarUndoRef: SidebarUndo | undefined

/** Set by the tabs code: Restore Data records itself as a step on the sidebar's undo stack (AR-11). */
export function provideSidebarUndo(stack: SidebarUndo | undefined): void {
  sidebarUndoRef = stack
}

/** The sidebar's undo stack (undefined before the tabs code started). */
export function sidebarUndo(): SidebarUndo | undefined {
  return sidebarUndoRef
}

/** What the command bar searches for archived tabs (AR-04): the whole Archive, beyond `state.archive`. */
export interface ArchiveSource {
  /** False until the Archive log was read: until then only `state.archive` is known. */
  readonly ready: boolean
  /** Bumped on every change. */
  readonly version: number
  /** A profile's entries, newest first, with their lowercased title and URL key. */
  newestFirst(profileId: ProfileId): Iterable<{ e: ArchivedTab; titleLower: string; urlKey: string }>
}

let archiveSourceRef: ArchiveSource | undefined

/** Set by the Archive module once its store exists. */
export function provideArchiveSource(source: ArchiveSource | undefined): void {
  archiveSourceRef = source
}

/** The Archive's store, for the command bar (undefined before the Archive module started). */
export function archiveSource(): ArchiveSource | undefined {
  return archiveSourceRef
}
