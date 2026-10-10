import { Moon, Palette, Sparkles, Sun } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ColorMode } from '../../../../shared/state'
import { invoke } from '../../api'
import { useOrbit } from '../../store'
import { Segmented, SettingGroup, SettingRow } from '../controls'
import type { SettingsSection } from '../registry'

const MODES: { value: ColorMode; label: string; icon: ReactNode }[] = [
  { value: 'system', label: 'Match system', icon: <Sparkles size={14} /> },
  { value: 'light', label: 'Light', icon: <Sun size={14} /> },
  { value: 'dark', label: 'Dark', icon: <Moon size={14} /> },
]

function AppearancePage() {
  const appearance = useOrbit((s) => s.settings.appearance)
  return (
    <SettingGroup title="Theme">
      <SettingRow
        id="appearance"
        label="Appearance"
        description="Light, dark, or the system's setting, for every window and Space. Each Space's colours have a light and a dark version. If pages stay dark in Light mode, a dark-mode extension may be forcing them."
      >
        <Segmented
          label="Appearance"
          value={appearance}
          options={MODES}
          testId="settings-appearance"
          onChange={(v) => void invoke('settings.update', { appearance: v })}
        />
      </SettingRow>
    </SettingGroup>
  )
}

export default {
  id: 'appearance',
  label: 'Appearance',
  icon: Palette,
  order: 30,
  component: AppearancePage,
  keywords: ['theme', 'dark mode', 'light mode', 'colour', 'color', 'system'],
} satisfies SettingsSection
