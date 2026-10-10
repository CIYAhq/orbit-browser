import type { ComponentType } from 'react'
import type { LibraryShow } from '../../../shared/commands/archive'

/** What every section's component gets. */
export interface LibrarySectionProps {
  /** The latest open of the Library (its `nonce` changes with each open; see LibraryShow). */
  show: LibraryShow
}

/**
 * The Library's section registry (AR-02, DL-09). A section is
 * `{ id, label, icon, order, component }`:
 * - `id`: a short slug (letters, digits, `.`, `_`, `-`). The Library remembers the section used last
 *   (`settings.librarySection`), and `library.open { section: id }` opens on it.
 * - `label` and `icon` (an icon component such as one from lucide-react) for the list on the left.
 * - `order`: place in that list, lowest first. The Archive is 10, History 15, Backups 90; leave gaps
 *   (Downloads 20, …).
 * - `component`: the section's content, shown on the right with `LibrarySectionProps`.
 * - `onContextMenu(x, y)` (optional): right-click on the section's entry in the list.
 *
 * Sections register by file name, so adding one edits no Library file: any module under
 * `src/renderer/src` named `*.library-section.tsx` that exports `section: LibrarySection` is
 * collected at build time (`import.meta.glob` below). Ids must be unique; the first one wins.
 */
export interface LibrarySection {
  id: string
  label: string
  icon: ComponentType<{ size?: number; strokeWidth?: number }>
  order: number
  component: ComponentType<LibrarySectionProps>
  onContextMenu?: (x: number, y: number) => void
}

const modules = import.meta.glob<{ section?: LibrarySection }>('../**/*.library-section.tsx', { eager: true })

function collect(): LibrarySection[] {
  const seen = new Set<string>()
  const list: LibrarySection[] = []
  for (const path of Object.keys(modules).sort()) {
    const section = modules[path]?.section
    if (!section || seen.has(section.id)) continue
    seen.add(section.id)
    list.push(section)
  }
  return list.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}

/** Every section, in list order. */
export const LIBRARY_SECTIONS: readonly LibrarySection[] = collect()

/** The section with this id, else the first one (a section that went away falls back). */
export function sectionFor(id: string | undefined): LibrarySection | undefined {
  return LIBRARY_SECTIONS.find((s) => s.id === id) ?? LIBRARY_SECTIONS[0]
}
