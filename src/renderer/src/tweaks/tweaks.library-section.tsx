import { Paintbrush } from 'lucide-react'
import type { LibrarySection } from '../library/sections'
import { TweaksSection } from './TweaksSection'

/** Tweaks (BO-15): every Tweak on this device, after Downloads in the Library's list. View Tweaks opens it. */
export const section: LibrarySection = {
  id: 'tweaks',
  label: 'Tweaks',
  icon: Paintbrush,
  order: 40,
  component: TweaksSection,
}
