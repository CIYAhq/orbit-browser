import type { TabId } from '../../shared/state'

/**
 * An import's unfinished tabs (D62 (3), D65): the tabs of its bookmarks, in the state where no section shows them, until
 * their folder is shown whole. Nothing may reach them meanwhile (D65 (1)): lists of open tabs (the command bar's) leave
 * them out, and Restore Data stops the import before it replaces the sidebar (D65 (3)). This module holds no import
 * code, so those lists and Restore Data can ask it.
 */
const unplaced = new Set<TabId>()
let version = 0
let stopImports: (() => void) | undefined

/**
 * Whether `id` is a tab an import made out of sight and hasn't shown yet. One the user reached and placed anyway is
 * still one: a list asks the sections too, and shows such a tab where it is (D65 (2)).
 */
export function isUnplacedImportTab(id: TabId): boolean {
  return unplaced.has(id)
}

/** Changes whenever the set does: a cache built with it starts over. */
export function unplacedImportVersion(): number {
  return version
}

/** The import: tabs about to go into the state out of sight. */
export function hideImportTabs(ids: readonly TabId[]): void {
  for (const id of ids) unplaced.add(id)
  version++
}

/** The import: tabs shown at last, taken back, or kept where the user put them. */
export function releaseImportTabs(ids: readonly TabId[]): void {
  for (const id of ids) unplaced.delete(id)
  version++
}

/** Set by the import: stops every running import, which takes back its unfinished tabs and says why (D65 (3)). */
export function provideImportStop(stop: (() => void) | undefined): void {
  stopImports = stop
}

/** Restore Data, its undo and its redo call this before they replace the sidebar (D65 (3)). */
export function stopImportsForRestore(): void {
  stopImports?.()
}
