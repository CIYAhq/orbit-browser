import { Wrench } from 'lucide-react'
import { SLEEP_AFTER_CHOICES } from '../../../../shared/commands/settings'
import { invoke } from '../../api'
import { useOrbit } from '../../store'
import { Button, Select, SettingGroup, SettingRow, Switch } from '../controls'
import { durationLabel, withCurrent } from '../format'
import { useMainValue } from '../hooks'
import type { SettingsSection } from '../registry'

const SLEEP_OPTIONS = SLEEP_AFTER_CHOICES.map((ms) => ({ value: ms, label: durationLabel(ms) }))

/** Advanced (ST-10): tab sleeping, picture in picture and graphics acceleration (ST-12). */
function AdvancedPage() {
  const sleepAfter = useOrbit((s) => s.settings.sleepAfterMs)
  const autoPip = useOrbit((s) => s.settings.autoPip)
  return (
    <>
      <SettingGroup title="Tabs and media">
        <SettingRow
          id="sleep-after"
          label="Put inactive tabs to sleep after"
          description="A sleeping tab frees its memory and loads again when you go back to it. Tabs playing sound never sleep."
        >
          <Select
            label="Put inactive tabs to sleep after"
            value={sleepAfter}
            options={withCurrent(SLEEP_OPTIONS, sleepAfter)}
            testId="sleep-after"
            onChange={(next) => void invoke('settings.update', { sleepAfterMs: next })}
          />
        </SettingRow>
        <SettingRow
          id="auto-pip"
          label="Picture in picture for videos"
          description="A playing video pops out into a small floating window when you switch to another tab."
        >
          <Switch
            label="Picture in picture for videos"
            checked={autoPip}
            testId="auto-pip"
            onChange={(next) => void invoke('settings.update', { autoPip: next })}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="System">
        <GraphicsRow />
      </SettingGroup>
    </>
  )
}

/** "Use graphics acceleration when available" (ST-12): applies when Orbit restarts. */
function GraphicsRow() {
  const enabled = useOrbit((s) => s.settings.hardwareAcceleration)
  const [status] = useMainValue(() => invoke('settings.systemStatus', {}))
  const pending = status !== undefined && status.hardwareAcceleration !== enabled
  return (
    <SettingRow
      id="hardware-acceleration"
      label="Use graphics acceleration when available"
      description={
        pending
          ? 'Restart Orbit to apply this.'
          : 'Turn this off if pages flicker, go black or draw wrongly. Applies when Orbit restarts.'
      }
    >
      {pending && status?.canRelaunch && (
        <Button testId="relaunch" onClick={() => void invoke('settings.relaunch', {})}>
          Restart Orbit
        </Button>
      )}
      <Switch
        label="Use graphics acceleration when available"
        checked={enabled}
        testId="hardware-acceleration"
        onChange={(next) => void invoke('settings.update', { hardwareAcceleration: next })}
      />
    </SettingRow>
  )
}

export default {
  id: 'advanced',
  label: 'Advanced',
  icon: Wrench,
  order: 70,
  component: AdvancedPage,
  keywords: ['graphics acceleration', 'hardware acceleration', 'gpu', 'picture in picture', 'sleep', 'memory'],
} satisfies SettingsSection
