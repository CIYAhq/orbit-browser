import { CircleCheck, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import type { DefaultBrowserStatus, SettingsCapabilities } from '../../../../shared/commands/settings'
import { invoke } from '../../api'
import { useOrbit } from '../../store'
import { Button, Checkbox, type Option, Select, SettingGroup, SettingRow } from '../controls'
import { HOUR, withCurrent } from '../format'
import { useMainValue } from '../hooks'
import type { SettingsSection } from '../registry'
import { UpdateCheckRow, UpdateSettingsRows } from '../updates'

/** Mini Windows left alone close after this long (MW-09, ST-03); "Never" is an option. */
const MINI_WINDOW_ARCHIVE: Option<number>[] = [
  { value: HOUR, label: '1 hour' },
  { value: 6 * HOUR, label: '6 hours' },
  { value: 12 * HOUR, label: '12 hours' },
  { value: 24 * HOUR, label: '24 hours' },
  { value: 0, label: 'Never' },
]

/** Export pinned items as bookmarks (import lane, IM-17): a file any browser imports. */
function ExportPinnedRow() {
  const [today, setToday] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  return (
    <SettingRow
      id="export-pinned"
      label="Export pinned items as bookmarks"
      description={
        saved
          ? `Saved to ${saved}`
          : 'A bookmarks file any browser can import: each Space a folder, and the Favorites one more.'
      }
    >
      <Checkbox checked={today} onChange={setToday} label="Include Today tabs" testId="export-today" />
      <Button
        testId="export-pinned"
        onClick={() => void invoke('import.exportPinned', { includeToday: today }).then((path) => setSaved(path))}
      >
        Export…
      </Button>
    </SettingRow>
  )
}

const readDefaultBrowser = () => invoke('settings.defaultBrowser', {})
const readCapabilities = () => invoke('settings.capabilities', {})

function DefaultBrowserRow() {
  const [status, setStatus] = useMainValue<DefaultBrowserStatus>(readDefaultBrowser)
  const [asking, setAsking] = useState(false)
  const description = !status
    ? undefined
    : status.isDefault
      ? 'Links you open in other apps open in Orbit.'
      : (status.note ?? 'Links you open in other apps open in another browser.')
  return (
    <SettingRow id="default-browser" label="Default browser" description={description}>
      {status?.isDefault ? (
        <span className="st-status" data-testid="default-browser-status">
          <CircleCheck size={16} aria-hidden="true" />
          Orbit is your default browser
        </span>
      ) : (
        <Button
          testId="default-browser-set"
          disabled={!status?.canSet || asking}
          title={status?.note}
          onClick={() => {
            setAsking(true)
            void invoke('settings.setDefaultBrowser', {})
              .then(setStatus)
              .finally(() => setAsking(false))
          }}
        >
          Make Orbit the default
        </Button>
      )}
    </SettingRow>
  )
}

function GeneralPage() {
  const miniAfter = useOrbit((s) => s.settings.miniWindowArchiveAfterMs)
  const [capabilities] = useMainValue<SettingsCapabilities>(readCapabilities)
  return (
    <>
      <SettingGroup title="Default browser">
        <DefaultBrowserRow />
      </SettingGroup>
      {/* Updates (ST-03, UP-01, UP-03, UP-10). */}
      <SettingGroup title="Updates">
        <UpdateCheckRow id="updates" feedHere />
        <UpdateSettingsRows />
      </SettingGroup>
      {capabilities?.importer && (
        <SettingGroup title="Import and export">
          <SettingRow
            id="import"
            label="Import bookmarks and data"
            description="Bring bookmarks, history and more from another browser."
          >
            <Button testId="import-open" onClick={() => void invoke('settings.openImport', {})}>
              Import…
            </Button>
          </SettingRow>
          <ExportPinnedRow />
        </SettingGroup>
      )}
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
    </>
  )
}

export default {
  id: 'general',
  label: 'General',
  icon: SlidersHorizontal,
  order: 10,
  component: GeneralPage,
  keywords: ['default browser', 'updates', 'check for updates', 'update feed', 'import', 'export', 'mini window'],
} satisfies SettingsSection
