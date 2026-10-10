import { DatabaseBackup } from 'lucide-react'
import { BackupsSection } from './BackupsSection'
import type { LibrarySection } from './sections'

/** Sidebar backups (AR-11): Help → Restore Data… opens the Library here. Last in the list. */
export const section: LibrarySection = {
  id: 'backups',
  label: 'Backups',
  icon: DatabaseBackup,
  order: 90,
  component: BackupsSection,
}
