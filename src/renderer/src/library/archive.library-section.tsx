import { Archive } from 'lucide-react'
import { invoke } from '../api'
import { ArchiveSection } from './ArchiveSection'
import type { LibrarySection } from './sections'

/** The Archive (AR-02): the Library's first section. Right-click offers "Clear Archive…" (AR-07). */
export const section: LibrarySection = {
  id: 'archive',
  label: 'Archive',
  icon: Archive,
  order: 10,
  component: ArchiveSection,
  onContextMenu: (x, y) => void invoke('archive.contextMenu', { ids: [], x, y }),
}
