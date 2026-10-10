import { Images } from 'lucide-react'
import type { LibrarySection } from '../library/sections'
import { MediaSection } from './MediaSection'

/** Media (DL-11): downloaded images and videos, and screenshots, just before Downloads. */
export const section: LibrarySection = {
  id: 'media',
  label: 'Media',
  icon: Images,
  order: 18,
  component: MediaSection,
}
