import { SlidersHorizontal } from 'lucide-react'
import { invoke } from '../../api'
import { useOrbit } from '../../store'
import { type Option, Select, SettingGroup, SettingRow } from '../controls'
import { HOUR, withCurrent } from '../format'
import type { SettingsSection } from '../registry'

/** Mini Windows left alone close after this long (MW-09, ST-03); "Never" is an option. */
const MINI_WINDOW_ARCHIVE: Option<number>[] = [
  { value: HOUR, label: '1 hour' },
  { value: 6 * HOUR, label: '6 hours' },
  { value: 12 * HOUR, label: '12 hours' },
  { value: 24 * HOUR, label: '24 hours' },
  { value: 0, label: 'Never' },
]

function GeneralPage() {
  const miniAfter = useOrbit((s) => s.settings.miniWindowArchiveAfterMs)
  return (
    <SettingGroup title="Mini Window">
      <SettingRow
        id="mini-window-archive"
        label="Archive Mini Windows after"
        description="A Mini Window left alone this long closes; its page goes to the Archive."
      >
        <Select
          label="Archive Mini Windows after"
          value={miniAfter}
          options={withCurrent(MINI_WINDOW_ARCHIVE, miniAfter)}
          testId="mini-window-archive"
          onChange={(v) => void invoke('settings.update', { miniWindowArchiveAfterMs: v })}
        />
      </SettingRow>
    </SettingGroup>
  )
}

export default {
  id: 'general',
  label: 'General',
  icon: SlidersHorizontal,
  order: 10,
  component: GeneralPage,
  keywords: ['default browser', 'updates', 'import', 'mini window'],
} satisfies SettingsSection
