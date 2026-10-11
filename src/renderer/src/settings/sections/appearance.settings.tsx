import { Moon, Palette, Sparkles, Sun } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ColorMode } from '../../../../shared/state'
import { invoke } from '../../api'
import { useOrbit } from '../../store'
import { Segmented, SettingGroup, SettingRow, Switch } from '../controls'
import type { SettingsSection } from '../registry'

const MODES: { value: ColorMode; label: string; icon: ReactNode }[] = [
  { value: 'system', label: 'Match system', icon: <Sparkles size={14} /> },
  { value: 'light', label: 'Light', icon: <Sun size={14} /> },
  { value: 'dark', label: 'Dark', icon: <Moon size={14} /> },
]

function AppearancePage() {
  const appearance = useOrbit((s) => s.settings.appearance)
  const reduceMotion = useOrbit((s) => !!s.settings.reduceMotion)
  return (
    <>
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
      {/* FL-28, AP-17: off follows the system's reduce-motion setting; on forces it. */}
      <SettingGroup title="Motion">
        <SettingRow
          id="reduce-motion"
          label="Reduce motion"
          description="Swap slides, springs and zooms for short fades, and turn off decorative animation. When off, Orbit follows the system's setting."
        >
          <Switch
            label="Reduce motion"
            checked={reduceMotion}
            testId="settings-reduce-motion"
            onChange={(v) => void invoke('settings.update', { reduceMotion: v })}
          />
        </SettingRow>
      </SettingGroup>
    </>
  )
}

export default {
  id: 'appearance',
  label: 'Appearance',
  icon: Palette,
  order: 30,
  component: AppearancePage,
  keywords: ['theme', 'dark mode', 'light mode', 'colour', 'color', 'system', 'reduce motion', 'animations'],
} satisfies SettingsSection
