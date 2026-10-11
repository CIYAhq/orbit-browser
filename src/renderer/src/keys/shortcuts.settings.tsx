import { Keyboard } from 'lucide-react'
import type { SettingsSection } from '../settings/registry'
import { ShortcutsPage } from './ShortcutsPage'

/** Settings → Shortcuts (ST-08): the keys lane's section of the Settings window. */
export default {
  id: 'shortcuts',
  label: 'Shortcuts',
  icon: Keyboard,
  order: 40,
  component: ShortcutsPage,
  keywords: ['keyboard shortcuts', 'keyboard', 'remap', 'key bindings', 'hotkeys'],
} satisfies SettingsSection
