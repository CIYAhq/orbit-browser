import { History } from 'lucide-react'
import { HistorySection } from './HistorySection'
import type { LibrarySection } from './sections'

/** History (AR-10): every page visit of the profile, after the Archive in the Library's list. */
export const section: LibrarySection = {
  id: 'history',
  label: 'History',
  icon: History,
  order: 15,
  component: HistorySection,
}
