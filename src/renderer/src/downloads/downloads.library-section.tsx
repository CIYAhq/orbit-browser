import { ArrowDownToLine } from 'lucide-react'
import type { LibrarySection } from '../library/sections'
import { DownloadsSection } from './DownloadsSection'

/** Downloads (DL-10): everything downloaded in the profile, after Media in the Library's list. */
export const section: LibrarySection = {
  id: 'downloads',
  label: 'Downloads',
  icon: ArrowDownToLine,
  order: 20,
  component: DownloadsSection,
}
