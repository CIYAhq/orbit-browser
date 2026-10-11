import { invoke } from '../api'
import { SettingGroup, SettingRow, Switch } from '../settings/controls'
import { useOrbit } from '../store'

const LABEL = 'Apply Tweaks on websites I visit'

/**
 * The switch for every Tweak (BO-16), in Settings → Advanced: on by default. Off, no Tweak applies
 * anywhere and none can be made; each keeps its own on or off for when the switch is back on.
 */
export function TweaksSetting() {
  const enabled = useOrbit((s) => s.settings.tweaksEnabled)
  return (
    <SettingGroup title="Tweaks">
      <SettingRow
        id="tweaks-enabled"
        label={LABEL}
        description="Turned off, no website shows its Tweaks and no new one can be made. Each Tweak stays on or off as you left it, for when you turn this back on."
      >
        <Switch
          label={LABEL}
          checked={enabled}
          testId="tweaks-enabled"
          onChange={(next) => void invoke('tweaks.setGlobal', { enabled: next })}
        />
      </SettingRow>
    </SettingGroup>
  )
}
